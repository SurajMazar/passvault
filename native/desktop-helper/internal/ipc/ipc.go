// Package ipc implements the request/response/event envelope of
// docs/DESKTOP_IPC.md, the single-UI-session binding, and an op registry with
// strict typed parameter decoding. It is transport-agnostic: a Sender is
// injected (the Neutralino transport in production, an in-memory one in tests).
package ipc

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/passvault/desktop-helper/internal/logx"
	"github.com/passvault/desktop-helper/internal/validate"
)

// Transport-level event names used with app.broadcast.
const (
	EventResponse = "pv.response"
	EventEvent    = "pv.event"
)

// MaxRequestBytes bounds a single request (fs.writeExport carries ≤5 MiB of
// content, ≈6.7 MiB as base64).
const MaxRequestBytes = 8 << 20

// Error codes (docs/DESKTOP_IPC.md).
const (
	CodeBadRequest      = "bad_request"
	CodeUnknownOp       = "unknown_op"
	CodeInvalidSession  = "invalid_session"
	CodeNotFound        = "not_found"
	CodeUnavailable     = "unavailable"
	CodeDenied          = "denied"
	CodeHostKeyUnknown  = "host_key_unknown"
	CodeHostKeyMismatch = "host_key_mismatch"
	CodeAuthFailed      = "auth_failed"
	CodeConnectFailed   = "connect_failed"
	CodeIOError         = "io_error"
	CodeInternal        = "internal"
)

// Error is an IPC error with a contract error code.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Errf builds an *Error.
func Errf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// AsError converts any error into an *Error; unknown errors become `internal`
// with a generic message so library error text is never leaked by accident.
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return &Error{Code: CodeInternal, Message: "internal error"}
}

// Sender delivers a transport event (pv.response / pv.event) to the UI.
type Sender interface {
	Send(event string, payload any) error
}

// Request is the inbound envelope.
type Request struct {
	V         int             `json:"v"`
	ID        string          `json:"id"`
	SessionID string          `json:"sessionId,omitempty"`
	Op        string          `json:"op"`
	Params    json.RawMessage `json:"params"`
}

// Response is the outbound reply envelope.
type Response struct {
	V      int    `json:"v"`
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  *Error `json:"error,omitempty"`
}

// Event is the outbound asynchronous event envelope.
type Event struct {
	V         int    `json:"v"`
	SessionID string `json:"sessionId"`
	Type      string `json:"type"`
	Data      any    `json:"data"`
}

// Session is one UI session. Resources created under it hold the pointer and
// are torn down when it ends.
type Session struct {
	ID     string
	ctx    context.Context
	cancel context.CancelFunc
}

// Context is cancelled when the session ends.
func (s *Session) Context() context.Context { return s.ctx }

// Opts configures an op.
type Opts struct {
	// NoSession: the op may be called without a valid sessionId (hello only).
	NoSession bool
	// Serial: run inline on the transport read loop so ordering relative to
	// other serial ops is preserved (ssh.write, ssh.resize, ...). Serial
	// handlers must not block.
	Serial bool
}

// Validator is implemented by param structs that need checks beyond types.
type Validator interface{ Validate() error }

type handlerFunc func(ctx context.Context, s *Session, raw json.RawMessage) (any, error)

type op struct {
	h    handlerFunc
	opts Opts
}

// Dispatcher routes requests to registered ops.
type Dispatcher struct {
	sender Sender
	log    *logx.Logger

	mu       sync.Mutex
	ops      map[string]op
	cur      *Session
	onEnd    []func(old *Session)
	wg       sync.WaitGroup
	shutdown bool
}

// NewDispatcher creates a dispatcher sending through s.
func NewDispatcher(s Sender, log *logx.Logger) *Dispatcher {
	if log == nil {
		log = logx.Discard()
	}
	return &Dispatcher{sender: s, log: log, ops: map[string]op{}}
}

// Register adds an op whose params decode strictly into P.
func Register[P any](d *Dispatcher, name string, opts Opts, fn func(ctx context.Context, s *Session, p *P) (any, error)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ops[name] = op{opts: opts, h: func(ctx context.Context, s *Session, raw json.RawMessage) (any, error) {
		p := new(P)
		if err := DecodeStrict(raw, p); err != nil {
			return nil, err
		}
		if v, ok := any(p).(Validator); ok {
			if err := v.Validate(); err != nil {
				return nil, asBadRequest(err)
			}
		}
		return fn(ctx, s, p)
	}}
}

func asBadRequest(err error) error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return &Error{Code: CodeBadRequest, Message: err.Error()}
}

// DecodeStrict decodes a JSON object into v rejecting unknown fields and
// trailing data.
func DecodeStrict(raw json.RawMessage, v any) error {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || bytes.Equal(t, []byte("null")) {
		t = []byte("{}")
	}
	if t[0] != '{' {
		return Errf(CodeBadRequest, "params must be an object")
	}
	dec := json.NewDecoder(bytes.NewReader(t))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return Errf(CodeBadRequest, "invalid params: %s", sanitizeJSONErr(err))
	}
	if dec.More() {
		return Errf(CodeBadRequest, "trailing data after params")
	}
	return nil
}

// sanitizeJSONErr keeps decode errors informative (field names, types) but
// never echoes values.
func sanitizeJSONErr(err error) string {
	var ute *json.UnmarshalTypeError
	if errors.As(err, &ute) {
		return fmt.Sprintf("field %q has wrong type", ute.Field)
	}
	var se *json.SyntaxError
	if errors.As(err, &se) {
		return "malformed JSON"
	}
	msg := err.Error()
	// "json: unknown field \"x\"" — field names are caller-controlled but not secret.
	if len(msg) > 120 {
		msg = msg[:120]
	}
	return msg
}

// OnSessionEnd registers a hook run (synchronously) whenever a session ends:
// on a new hello, or on shutdown.
func (d *Dispatcher) OnSessionEnd(fn func(old *Session)) {
	d.mu.Lock()
	d.onEnd = append(d.onEnd, fn)
	d.mu.Unlock()
}

func newSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// NewSession ends the current session (running teardown hooks) and starts a
// fresh one with a random 128-bit id.
func (d *Dispatcher) NewSession() *Session {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Session{ID: newSessionID(), ctx: ctx, cancel: cancel}
	d.mu.Lock()
	old := d.cur
	d.cur = s
	hooks := append([]func(*Session){}, d.onEnd...)
	d.mu.Unlock()
	if old != nil {
		old.cancel()
		for _, h := range hooks {
			h(old)
		}
	}
	return s
}

// EndSession ends the current session without starting a new one.
func (d *Dispatcher) EndSession() {
	d.mu.Lock()
	old := d.cur
	d.cur = nil
	hooks := append([]func(*Session){}, d.onEnd...)
	d.mu.Unlock()
	if old != nil {
		old.cancel()
		for _, h := range hooks {
			h(old)
		}
	}
}

// Current returns the active session or nil.
func (d *Dispatcher) Current() *Session {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.cur
}

// IsCurrent reports whether s is the active session.
func (d *Dispatcher) IsCurrent(s *Session) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return s != nil && d.cur == s
}

// Emit sends an event bound to s. Events for sessions that have ended are
// dropped. Returns whether the event was sent.
func (d *Dispatcher) Emit(s *Session, typ string, data any) bool {
	if !d.IsCurrent(s) {
		return false
	}
	d.log.Event(typ)
	if err := d.sender.Send(EventEvent, Event{V: 1, SessionID: s.ID, Type: typ, Data: data}); err != nil {
		d.log.Code("event send failed", CodeIOError)
		return false
	}
	return true
}

// EmitCurrent sends an event to whatever session is active, if any.
func (d *Dispatcher) EmitCurrent(typ string, data any) bool {
	s := d.Current()
	if s == nil {
		return false
	}
	return d.Emit(s, typ, data)
}

func (d *Dispatcher) reply(id string, result any, err error) {
	var resp Response
	if err != nil {
		resp = Response{V: 1, ID: id, OK: false, Error: AsError(err)}
	} else {
		if result == nil {
			result = struct{}{}
		}
		resp = Response{V: 1, ID: id, OK: true, Result: result}
	}
	if serr := d.sender.Send(EventResponse, resp); serr != nil {
		d.log.Code("response send failed", CodeIOError)
	}
}

// bestEffortID extracts a request id from an otherwise-invalid request so
// the error can be correlated.
func bestEffortID(raw []byte) string {
	var r struct {
		ID any `json:"id"`
	}
	if json.Unmarshal(raw, &r) == nil {
		if s, ok := r.ID.(string); ok && validate.ID(s) {
			return s
		}
	}
	return ""
}

// Handle processes one raw request (the `data` of a pv.request event).
func (d *Dispatcher) Handle(raw []byte) {
	start := time.Now()
	if len(raw) > MaxRequestBytes {
		id := ""
		d.log.Op("-", id, CodeBadRequest, 0)
		d.reply(id, nil, Errf(CodeBadRequest, "request exceeds %d bytes", MaxRequestBytes))
		return
	}
	var req Request
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil || dec.More() {
		id := bestEffortID(raw)
		d.log.Op("-", id, CodeBadRequest, 0)
		d.reply(id, nil, Errf(CodeBadRequest, "malformed request envelope"))
		return
	}
	if req.V != 1 || !validate.ID(req.ID) || len(req.Op) == 0 || len(req.Op) > 64 {
		id := ""
		if validate.ID(req.ID) {
			id = req.ID
		}
		d.log.Op("-", id, CodeBadRequest, 0)
		d.reply(id, nil, Errf(CodeBadRequest, "invalid envelope (v, id, op)"))
		return
	}

	d.mu.Lock()
	o, ok := d.ops[req.Op]
	cur := d.cur
	down := d.shutdown
	d.mu.Unlock()
	if !ok {
		d.log.Op("unknown", req.ID, CodeUnknownOp, 0)
		d.reply(req.ID, nil, Errf(CodeUnknownOp, "unknown op"))
		return
	}
	if down {
		d.reply(req.ID, nil, Errf(CodeUnavailable, "helper is shutting down"))
		return
	}
	var sess *Session
	if !o.opts.NoSession {
		if cur == nil || len(req.SessionID) != len(cur.ID) ||
			subtle.ConstantTimeCompare([]byte(req.SessionID), []byte(cur.ID)) != 1 {
			d.log.Op(req.Op, req.ID, CodeInvalidSession, 0)
			d.reply(req.ID, nil, Errf(CodeInvalidSession, "missing or stale sessionId"))
			return
		}
		sess = cur
	}
	run := func() {
		ctx := context.Background()
		if sess != nil {
			ctx = sess.ctx
		}
		res, err := o.h(ctx, sess, req.Params)
		code := "ok"
		if err != nil {
			code = AsError(err).Code
		}
		d.log.Op(req.Op, req.ID, code, time.Since(start))
		d.reply(req.ID, res, err)
	}
	if o.opts.Serial {
		run()
		return
	}
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		run()
	}()
}

// Shutdown stops accepting requests, ends the session and waits (bounded)
// for in-flight handlers.
func (d *Dispatcher) Shutdown(timeout time.Duration) {
	d.mu.Lock()
	d.shutdown = true
	d.mu.Unlock()
	d.EndSession()
	done := make(chan struct{})
	go func() { d.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}

// Wait blocks until in-flight async handlers finish (tests).
func (d *Dispatcher) Wait() { d.wg.Wait() }
