// Package sshconn runs app-managed SSH sessions: host-key verification with
// explicit user decisions, password / key / agent / keyboard-interactive
// auth, optional jump host, a remote PTY + shell, and keepalives.
//
// No local shell or local PTY is ever created: the terminal in the UI is fed
// by the remote PTY requested with pty-req over SSH.
package sshconn

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/passvault/desktop-helper/internal/ipc"
)

// Emitter sends an event to the UI session that owns a connection.
type Emitter func(typ string, data any)

// Config tunes timeouts (tests shorten them).
type Config struct {
	HostKeyTimeout    time.Duration
	PromptTimeout     time.Duration
	DialTimeout       time.Duration
	KeepaliveInterval time.Duration
	KeepaliveMaxFail  int
	// AgentSigners returns the helper's in-memory agent keys (only while the
	// vault is unlocked).
	AgentSigners func() []ssh.Signer
}

// DefaultConfig returns production timeouts.
func DefaultConfig() Config {
	return Config{
		HostKeyTimeout:    2 * time.Minute,
		PromptTimeout:     5 * time.Minute,
		DialTimeout:       20 * time.Second,
		KeepaliveInterval: 30 * time.Second,
		KeepaliveMaxFail:  3,
	}
}

// Manager owns all app-managed connections.
type Manager struct {
	cfg   Config
	mu    sync.Mutex
	conns map[string]*Conn
}

// NewManager creates a manager.
func NewManager(cfg Config) *Manager {
	return &Manager{cfg: cfg, conns: map[string]*Conn{}}
}

type promptWait struct {
	n  int
	ch chan promptAnswer
}

type promptAnswer struct {
	answers []string
	cancel  bool
}

type ctrl struct {
	data       []byte
	cols, rows int
}

// Conn is one app-managed SSH connection.
type Conn struct {
	m     *Manager
	id    string
	owner any
	emit  Emitter

	ctx    context.Context
	cancel context.CancelFunc

	mu          sync.Mutex
	hostKeyWait map[string]chan bool
	prompts     map[string]*promptWait
	client      *ssh.Client
	jumpClient  *ssh.Client
	session     *ssh.Session
	ctrlCh      chan ctrl
	connected   bool

	wg   sync.WaitGroup
	done chan struct{}
}

func randomID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// ConnectParams are the ssh.connect params.
type ConnectParams struct {
	ConnID string `json:"connId"`
	Label  string `json:"label"`
	Target Hop    `json:"target"`
	Jump   *Hop   `json:"jump,omitempty"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
}

// Connect validates params synchronously and starts the connection in the
// background. Progress is reported through emit.
func (m *Manager) Connect(owner any, emit Emitter, p *ConnectParams) error {
	if p.Cols < 1 || p.Rows < 1 || p.Cols > MaxDimension || p.Rows > MaxDimension {
		return ipc.Errf(ipc.CodeBadRequest, "cols/rows out of range")
	}
	if len(p.Label) > MaxLabel {
		return ipc.Errf(ipc.CodeBadRequest, "label too long")
	}
	target, err := prepare("target", &p.Target, m.cfg.AgentSigners)
	if err != nil {
		return err
	}
	var jump *prepared
	if p.Jump != nil {
		jump, err = prepare("jump", p.Jump, m.cfg.AgentSigners)
		if err != nil {
			target.wipe()
			return err
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Conn{
		m: m, id: p.ConnID, owner: owner, emit: emit, ctx: ctx, cancel: cancel,
		hostKeyWait: map[string]chan bool{}, prompts: map[string]*promptWait{},
		ctrlCh: make(chan ctrl, 1024), done: make(chan struct{}),
	}
	m.mu.Lock()
	if _, exists := m.conns[p.ConnID]; exists {
		m.mu.Unlock()
		cancel()
		return ipc.Errf(ipc.CodeBadRequest, "connId already in use")
	}
	if len(m.conns) >= MaxConnections {
		m.mu.Unlock()
		cancel()
		return ipc.Errf(ipc.CodeUnavailable, "too many open connections")
	}
	m.conns[p.ConnID] = c
	m.mu.Unlock()

	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.run(target, jump, p.Cols, p.Rows)
	}()
	go func() {
		c.wg.Wait()
		m.mu.Lock()
		if m.conns[c.id] == c {
			delete(m.conns, c.id)
		}
		m.mu.Unlock()
		close(c.done)
	}()
	return nil
}

func (c *Conn) state(s, msg string) {
	c.emit("ssh.state", StateEvent{ConnID: c.id, State: s, Message: msg})
}

func (c *Conn) hooks() hooks {
	return hooks{
		state:          c.state,
		mismatch:       func(ev HostKeyEvent) { c.emit("ssh.hostKey", ev) },
		unknownHostKey: c.waitHostKey,
		prompt:         c.waitPrompt,
	}
}

func (c *Conn) waitHostKey(ctx context.Context, ev HostKeyEvent) error {
	ch := make(chan bool, 1)
	c.mu.Lock()
	c.hostKeyWait[ev.Hop] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.hostKeyWait, ev.Hop)
		c.mu.Unlock()
	}()
	c.emit("ssh.hostKey", ev)
	t := time.NewTimer(c.m.cfg.HostKeyTimeout)
	defer t.Stop()
	select {
	case trust := <-ch:
		if trust {
			return nil
		}
		return errors.New("rejected by user")
	case <-t.C:
		return errors.New("no decision before timeout")
	case <-ctx.Done():
		return errors.New("cancelled")
	}
}

func (c *Conn) waitPrompt(ctx context.Context, hop, name, instruction string, qs []Question) ([]string, error) {
	id := randomID()
	pw := &promptWait{n: len(qs), ch: make(chan promptAnswer, 1)}
	c.mu.Lock()
	c.prompts[id] = pw
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.prompts, id)
		c.mu.Unlock()
	}()
	c.emit("ssh.prompt", PromptEvent{ConnID: c.id, PromptID: id, Hop: hop, Name: name, Instruction: instruction, Questions: qs})
	t := time.NewTimer(c.m.cfg.PromptTimeout)
	defer t.Stop()
	select {
	case a := <-pw.ch:
		if a.cancel {
			return nil, errors.New("authentication cancelled by user")
		}
		return a.answers, nil
	case <-t.C:
		return nil, errors.New("authentication prompt timed out")
	case <-ctx.Done():
		return nil, errors.New("cancelled")
	}
}

func (c *Conn) fail(err error) {
	e := ipc.AsError(err)
	c.emit("ssh.state", StateEvent{ConnID: c.id, State: "error", Message: e.Message, Code: e.Code})
}

func (c *Conn) run(target, jump *prepared, cols, rows int) {
	defer c.state("closed", "")
	defer c.closeClients()
	d := &dialer{connID: c.id, hooks: c.hooks(), dialTimeout: c.m.cfg.DialTimeout, agentSigners: c.m.cfg.AgentSigners}
	client, jc, err := d.dial(c.ctx, target, jump)
	target.wipe()
	if jump != nil {
		jump.wipe()
	}
	if err != nil {
		if c.ctx.Err() == nil { // not a user disconnect / lock
			c.fail(err)
		}
		return
	}
	c.mu.Lock()
	c.client, c.jumpClient = client, jc
	c.mu.Unlock()
	if c.ctx.Err() != nil {
		return
	}
	// Close the transport as soon as the connection is cancelled.
	stop := context.AfterFunc(c.ctx, c.closeClients)
	defer stop()

	sess, err := client.NewSession()
	if err != nil {
		c.fail(ipc.Errf(ipc.CodeConnectFailed, "could not open session channel"))
		return
	}
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		c.fail(ipc.Errf(ipc.CodeConnectFailed, "server refused the PTY request"))
		return
	}
	stdin, err1 := sess.StdinPipe()
	stdout, err2 := sess.StdoutPipe()
	stderr, err3 := sess.StderrPipe()
	if err1 != nil || err2 != nil || err3 != nil {
		c.fail(ipc.Errf(ipc.CodeInternal, "session pipes"))
		return
	}
	if err := sess.Shell(); err != nil {
		c.fail(ipc.Errf(ipc.CodeConnectFailed, "server refused the shell request"))
		return
	}
	c.mu.Lock()
	c.session = sess
	c.connected = true
	c.mu.Unlock()
	c.state("connected", "")

	var readers sync.WaitGroup
	readers.Add(2)
	go func() { defer readers.Done(); c.pump(stdout) }()
	go func() { defer readers.Done(); c.pump(stderr) }()
	c.wg.Add(2)
	go func() { defer c.wg.Done(); c.writer(stdin, sess) }()
	go func() { defer c.wg.Done(); c.keepalive(client) }()

	werr := sess.Wait()
	readers.Wait()
	if c.ctx.Err() == nil {
		ev := ExitEvent{ConnID: c.id}
		var ee *ssh.ExitError
		if errors.As(werr, &ee) {
			st := ee.ExitStatus()
			ev.ExitStatus = &st
			ev.Signal = ee.Signal()
		} else if werr == nil {
			zero := 0
			ev.ExitStatus = &zero
		}
		c.emit("ssh.exit", ev)
	}
	c.cancel()
}

func (c *Conn) pump(r io.Reader) {
	buf := make([]byte, 32<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			c.emit("ssh.data", DataEvent{ConnID: c.id, DataB64: base64.StdEncoding.EncodeToString(buf[:n])})
		}
		if err != nil {
			return
		}
	}
}

func (c *Conn) writer(stdin io.WriteCloser, sess *ssh.Session) {
	for {
		select {
		case <-c.ctx.Done():
			return
		case op := <-c.ctrlCh:
			if op.data != nil {
				if _, err := stdin.Write(op.data); err != nil {
					return
				}
				clear(op.data)
			} else {
				_ = sess.WindowChange(op.rows, op.cols)
			}
		}
	}
}

func (c *Conn) keepalive(client *ssh.Client) {
	if c.m.cfg.KeepaliveInterval <= 0 {
		return
	}
	t := time.NewTicker(c.m.cfg.KeepaliveInterval)
	defer t.Stop()
	fails := 0
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-t.C:
			res := make(chan error, 1)
			go func() {
				_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
				res <- err
			}()
			select {
			case err := <-res:
				if err != nil {
					fails = c.m.cfg.KeepaliveMaxFail
				} else {
					fails = 0
				}
			case <-time.After(c.m.cfg.KeepaliveInterval):
				fails++
			case <-c.ctx.Done():
				return
			}
			if fails >= c.m.cfg.KeepaliveMaxFail {
				c.fail(ipc.Errf(ipc.CodeIOError, "connection lost (keepalive timeout)"))
				c.cancel()
				return
			}
		}
	}
}

func (c *Conn) closeClients() {
	c.mu.Lock()
	sess, cl, jc := c.session, c.client, c.jumpClient
	c.mu.Unlock()
	if sess != nil {
		_ = sess.Close()
	}
	if cl != nil {
		_ = cl.Close()
	}
	if jc != nil {
		_ = jc.Close()
	}
}

// close cancels the connection; it does not wait.
func (c *Conn) close() {
	c.cancel()
	c.closeClients()
}

func (m *Manager) get(owner any, connID string) (*Conn, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.conns[connID]
	if !ok || c.owner != owner {
		return nil, ipc.Errf(ipc.CodeNotFound, "no such connection")
	}
	return c, nil
}

// HostKeyDecision answers a pending unknown-host-key prompt.
func (m *Manager) HostKeyDecision(owner any, connID, hop string, trust bool) error {
	if hop != "jump" && hop != "target" {
		return ipc.Errf(ipc.CodeBadRequest, "hop must be jump or target")
	}
	c, err := m.get(owner, connID)
	if err != nil {
		return err
	}
	c.mu.Lock()
	ch := c.hostKeyWait[hop]
	delete(c.hostKeyWait, hop)
	c.mu.Unlock()
	if ch == nil {
		return ipc.Errf(ipc.CodeNotFound, "no pending host key decision for this hop")
	}
	ch <- trust
	return nil
}

// PromptResponse answers a keyboard-interactive prompt.
func (m *Manager) PromptResponse(owner any, connID, promptID string, answers []string, cancel bool) error {
	c, err := m.get(owner, connID)
	if err != nil {
		return err
	}
	c.mu.Lock()
	pw := c.prompts[promptID]
	if pw != nil && !cancel && len(answers) != pw.n {
		c.mu.Unlock()
		return ipc.Errf(ipc.CodeBadRequest, "expected %d answers", pw.n)
	}
	delete(c.prompts, promptID)
	c.mu.Unlock()
	if pw == nil {
		return ipc.Errf(ipc.CodeNotFound, "no such prompt")
	}
	pw.ch <- promptAnswer{answers: answers, cancel: cancel}
	return nil
}

// Write queues data for the remote shell's stdin. Never blocks.
func (m *Manager) Write(owner any, connID string, data []byte) error {
	if len(data) > MaxWriteBytes {
		return ipc.Errf(ipc.CodeBadRequest, "write too large")
	}
	c, err := m.get(owner, connID)
	if err != nil {
		return err
	}
	c.mu.Lock()
	ok := c.connected
	c.mu.Unlock()
	if !ok {
		return ipc.Errf(ipc.CodeUnavailable, "connection is not established")
	}
	select {
	case c.ctrlCh <- ctrl{data: data}:
		return nil
	default:
		return ipc.Errf(ipc.CodeIOError, "write queue full")
	}
}

// Resize queues a window-change, ordered with writes.
func (m *Manager) Resize(owner any, connID string, cols, rows int) error {
	if cols < 1 || rows < 1 || cols > MaxDimension || rows > MaxDimension {
		return ipc.Errf(ipc.CodeBadRequest, "cols/rows out of range")
	}
	c, err := m.get(owner, connID)
	if err != nil {
		return err
	}
	select {
	case c.ctrlCh <- ctrl{cols: cols, rows: rows}:
		return nil
	default:
		return ipc.Errf(ipc.CodeIOError, "queue full")
	}
}

// Disconnect closes a connection and waits (bounded) for its goroutines.
func (m *Manager) Disconnect(owner any, connID string) error {
	c, err := m.get(owner, connID)
	if err != nil {
		return err
	}
	c.close()
	waitDone([]*Conn{c}, 5*time.Second)
	return nil
}

// Done returns a channel closed when every goroutine of connID has exited.
func (m *Manager) Done(connID string) <-chan struct{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.conns[connID]; ok {
		return c.done
	}
	ch := make(chan struct{})
	close(ch)
	return ch
}

func waitDone(cs []*Conn, timeout time.Duration) {
	deadline := time.After(timeout)
	for _, c := range cs {
		select {
		case <-c.done:
		case <-deadline:
			return
		}
	}
}

// CloseOwner closes every connection of owner (nil = all) and waits.
func (m *Manager) CloseOwner(owner any) int {
	m.mu.Lock()
	var cs []*Conn
	for _, c := range m.conns {
		if owner == nil || c.owner == owner {
			cs = append(cs, c)
		}
	}
	m.mu.Unlock()
	for _, c := range cs {
		c.close()
	}
	waitDone(cs, 5*time.Second)
	return len(cs)
}

// CloseAll closes every connection.
func (m *Manager) CloseAll() int { return m.CloseOwner(nil) }

// Count returns the number of live connections.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.conns)
}

// TestParams are the ssh.test params.
type TestParams struct {
	Target Hop  `json:"target"`
	Jump   *Hop `json:"jump,omitempty"`
}

// Test connects and authenticates without opening a shell. It never prompts:
// an unknown host key is reported in the result (status "unknown") so the UI
// can ask the user and retry with the key trusted; keyboard-interactive
// servers are reported as reachable but not answered.
func (m *Manager) Test(ctx context.Context, p *TestParams) (*TestResult, error) {
	target, err := prepare("target", &p.Target, m.cfg.AgentSigners)
	if err != nil {
		return nil, err
	}
	defer target.wipe()
	var jump *prepared
	if p.Jump != nil {
		if jump, err = prepare("jump", p.Jump, m.cfg.AgentSigners); err != nil {
			return nil, err
		}
		defer jump.wipe()
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	res := &TestResult{}
	var mu sync.Mutex
	stage := "connect"
	h := hooks{
		state: func(s, _ string) {
			mu.Lock()
			defer mu.Unlock()
			switch s {
			case "verifying_host":
				stage = "host_key"
			case "authenticating":
				stage = "auth"
			case "connecting":
				stage = "connect"
			}
		},
		mismatch: func(ev HostKeyEvent) {
			mu.Lock()
			defer mu.Unlock()
			e := ev
			res.HostKey = &e
			stage = "host_key"
		},
		unknownHostKey: func(_ context.Context, ev HostKeyEvent) error {
			mu.Lock()
			defer mu.Unlock()
			e := ev
			res.HostKey = &e
			stage = "host_key"
			return errors.New("host key is not trusted yet; verify the fingerprint and trust it first")
		},
		prompt: func(context.Context, string, string, string, []Question) ([]string, error) {
			return nil, errors.New("server requested keyboard-interactive prompts; they are not answered during a test")
		},
	}
	d := &dialer{hooks: h, dialTimeout: m.cfg.DialTimeout, agentSigners: m.cfg.AgentSigners}
	client, jc, err := d.dial(ctx, target, jump)
	mu.Lock()
	defer mu.Unlock()
	if err != nil {
		e := ipc.AsError(err)
		res.OK, res.Stage, res.Message = false, stage, e.Message
		return res, nil
	}
	client.Close()
	if jc != nil {
		jc.Close()
	}
	res.OK, res.Stage, res.Message = true, "done", "connected and authenticated"
	return res, nil
}
