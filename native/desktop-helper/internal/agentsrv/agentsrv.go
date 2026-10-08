// Package agentsrv is PassVault's SSH agent: an agent.ExtendedAgent served
// on a private unix socket. Keys come only from the vault over IPC; socket
// clients can list (while unlocked) and request signatures, each of which
// needs an explicit approval in the UI (or a time-boxed per-key grant).
// Add/Remove/RemoveAll/Lock/Unlock from socket clients are refused.
package agentsrv

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/passvault/desktop-helper/internal/ipc"
	"github.com/passvault/desktop-helper/internal/sshkeys"
)

// Errors returned to socket clients (the agent protocol only carries
// SSH_AGENT_FAILURE; the text is for our own tests).
var (
	ErrRefused = errors.New("operation refused: keys are managed by the PassVault app")
	ErrLocked  = errors.New("agent is locked")
	ErrDenied  = errors.New("signature denied")
	ErrNoKey   = errors.New("key not found")
)

// MaxGrantMinutes bounds timed approvals.
const MaxGrantMinutes = 60

// ClientInfo identifies the socket peer, as reported by the OS.
type ClientInfo struct {
	PID         int    `json:"pid,omitempty"`
	ProcessName string `json:"processName,omitempty"`
	ProcessPath string `json:"processPath,omitempty"`
}

// Destination describes where the signature will be used.
type Destination struct {
	Verified           bool   `json:"verified"`
	HostKeyFingerprint string `json:"hostKeyFingerprint,omitempty"`
	Note               string `json:"note"`
}

// SignRequest is the agent.signRequest event payload.
type SignRequest struct {
	RequestID   string      `json:"requestId"`
	KeyID       string      `json:"keyId"`
	KeyName     string      `json:"keyName"`
	Fingerprint string      `json:"fingerprint"`
	Client      ClientInfo  `json:"client"`
	Destination Destination `json:"destination"`
	Forwarded   bool        `json:"forwarded"`
}

// KeyInfo is returned by Status.
type KeyInfo struct {
	KeyID       string `json:"keyId"`
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
}

type key struct {
	id     string
	name   string
	signer ssh.Signer
	raw    crypto.PrivateKey
	pub    ssh.PublicKey
	fp     string
}

type pending struct {
	owner any
	keyID string
	ch    chan decision
}

type decision struct {
	kind    string
	minutes int
}

// Notifier connects sign requests to the UI. Owner returns the UI session a
// decision must come from (ok=false when there is none: the request is
// denied). Notify shows the request to that session.
type Notifier struct {
	Owner  func() (owner any, ok bool)
	Notify func(owner any, req SignRequest) bool
}

// Server is the agent.
type Server struct {
	mu        sync.Mutex
	keys      []*key
	locked    bool
	grants    map[string]time.Time
	pending   map[string]*pending
	notify    Notifier
	onState   func(running, locked bool)
	timeout   time.Duration
	dir, path string
	ln        *net.UnixListener
	sockIno   uint64
	conns     map[net.Conn]struct{}
	wg        sync.WaitGroup
	now       func() time.Time
}

// New creates a stopped agent. The agent starts locked: keys can only be
// added by the UI after the vault is unlocked.
func New(notify Notifier, onState func(running, locked bool)) *Server {
	if onState == nil {
		onState = func(bool, bool) {}
	}
	return &Server{
		locked: true, grants: map[string]time.Time{}, pending: map[string]*pending{},
		notify: notify, onState: onState, timeout: 2 * time.Minute,
		conns: map[net.Conn]struct{}{}, now: time.Now,
	}
}

// SetDecisionTimeout overrides the approval timeout (tests).
func (s *Server) SetDecisionTimeout(d time.Duration) { s.timeout = d }

// DefaultDir returns ~/Library/Application Support/PassVault/agent, or
// $PV_AGENT_SOCKET_DIR when set (tests only).
func DefaultDir() (string, error) {
	if d := os.Getenv("PV_AGENT_SOCKET_DIR"); d != "" {
		return d, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "Application Support", "PassVault", "agent"), nil
}

// ---- key management (IPC only) ----

// AddKey parses and holds a key in memory. Adding a key implies the vault is
// unlocked (keys only come from an unlocked vault), so it clears `locked`.
func (s *Server) AddKey(keyID, name, privateKey, passphrase string) (string, error) {
	signer, raw, err := sshkeys.ParseSigner(privateKey, passphrase)
	if err != nil {
		return "", ipc.Errf(ipc.CodeBadRequest, "%s", err.Error())
	}
	k := &key{id: keyID, name: name, signer: signer, raw: raw, pub: signer.PublicKey(), fp: ssh.FingerprintSHA256(signer.PublicKey())}
	s.mu.Lock()
	for i, old := range s.keys {
		if old.id == keyID {
			sshkeys.Zero(old.raw)
			s.keys = append(s.keys[:i], s.keys[i+1:]...)
			break
		}
	}
	s.keys = append(s.keys, k)
	delete(s.grants, keyID)
	wasLocked := s.locked
	s.locked = false
	running := s.ln != nil
	s.mu.Unlock()
	if wasLocked {
		s.onState(running, false)
	}
	return k.fp, nil
}

// RemoveKey removes one key.
func (s *Server) RemoveKey(keyID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, k := range s.keys {
		if k.id == keyID {
			sshkeys.Zero(k.raw)
			s.keys = append(s.keys[:i], s.keys[i+1:]...)
			delete(s.grants, keyID)
			return nil
		}
	}
	return ipc.Errf(ipc.CodeNotFound, "no such key")
}

// Lock removes all keys, revokes grants, denies pending requests and
// refuses new signatures until a key is added again. Returns keys removed.
func (s *Server) Lock() int {
	s.mu.Lock()
	n := len(s.keys)
	for _, k := range s.keys {
		sshkeys.Zero(k.raw)
	}
	s.keys = nil
	s.grants = map[string]time.Time{}
	for id, p := range s.pending {
		select {
		case p.ch <- decision{kind: "deny"}:
		default:
		}
		delete(s.pending, id)
	}
	s.locked = true
	running := s.ln != nil
	s.mu.Unlock()
	s.onState(running, true)
	return n
}

// Signers returns the in-memory keys for the app's own SSH connections
// (nil while locked).
func (s *Server) Signers() []ssh.Signer {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.locked {
		return nil
	}
	out := make([]ssh.Signer, 0, len(s.keys))
	for _, k := range s.keys {
		out = append(out, k.signer)
	}
	return out
}

// Status reports agent state.
func (s *Server) Status() (running bool, path string, locked bool, keys []KeyInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys = []KeyInfo{}
	for _, k := range s.keys {
		keys = append(keys, KeyInfo{KeyID: k.id, Name: k.name, Fingerprint: k.fp})
	}
	return s.ln != nil, s.path, s.locked, keys
}

// Decide answers a pending sign request.
func (s *Server) Decide(owner any, requestID, kind string, minutes int) error {
	switch kind {
	case "deny", "once":
	case "timed":
		if minutes < 1 || minutes > MaxGrantMinutes {
			return ipc.Errf(ipc.CodeBadRequest, "minutes must be 1-%d", MaxGrantMinutes)
		}
	default:
		return ipc.Errf(ipc.CodeBadRequest, "invalid decision")
	}
	s.mu.Lock()
	p := s.pending[requestID]
	if p == nil || p.owner != owner {
		s.mu.Unlock()
		return ipc.Errf(ipc.CodeNotFound, "no such sign request")
	}
	delete(s.pending, requestID)
	s.mu.Unlock()
	p.ch <- decision{kind: kind, minutes: minutes}
	return nil
}

// CancelOwner denies all pending requests of an ended UI session.
func (s *Server) CancelOwner(owner any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, p := range s.pending {
		if p.owner == owner {
			p.ch <- decision{kind: "deny"}
			delete(s.pending, id)
		}
	}
}

func newRequestID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// ---- signing path (socket clients) ----

func (s *Server) findKey(pub ssh.PublicKey) (*key, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.locked {
		return nil, ErrLocked
	}
	blob := pub.Marshal()
	for _, k := range s.keys {
		if bytes.Equal(k.pub.Marshal(), blob) {
			return k, nil
		}
	}
	return nil, ErrNoKey
}

// approve decides whether a signature may be produced.
func (s *Server) approve(k *key, client ClientInfo, dest Destination, forwarded bool) error {
	if forwarded {
		// Agent forwarding is disabled: a session bound as forwarded means a
		// remote host is asking through a forwarded agent connection.
		return ErrDenied
	}
	s.mu.Lock()
	if s.locked {
		s.mu.Unlock()
		return ErrLocked
	}
	if until, ok := s.grants[k.id]; ok && s.now().Before(until) {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	if s.notify.Owner == nil || s.notify.Notify == nil {
		return ErrDenied
	}
	owner, ok := s.notify.Owner()
	if !ok {
		return ErrDenied
	}
	req := SignRequest{
		RequestID: newRequestID(), KeyID: k.id, KeyName: k.name, Fingerprint: k.fp,
		Client: client, Destination: dest, Forwarded: forwarded,
	}
	ch := make(chan decision, 1)
	s.mu.Lock()
	s.pending[req.RequestID] = &pending{owner: owner, keyID: k.id, ch: ch}
	s.mu.Unlock()
	if !s.notify.Notify(owner, req) {
		s.mu.Lock()
		delete(s.pending, req.RequestID)
		s.mu.Unlock()
		return ErrDenied
	}
	t := time.NewTimer(s.timeout)
	defer t.Stop()
	var d decision
	select {
	case d = <-ch:
	case <-t.C:
		s.mu.Lock()
		delete(s.pending, req.RequestID)
		s.mu.Unlock()
		return ErrDenied
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.locked {
		return ErrLocked
	}
	switch d.kind {
	case "once":
		return nil
	case "timed":
		s.grants[k.id] = s.now().Add(time.Duration(d.minutes) * time.Minute)
		return nil
	}
	return ErrDenied
}

// sign performs the signature after approval.
func (s *Server) sign(k *key, data []byte, flags agent.SignatureFlags) (*ssh.Signature, error) {
	// Re-check the key is still loaded (not removed/locked meanwhile).
	if _, err := s.findKey(k.pub); err != nil {
		return nil, err
	}
	if k.pub.Type() == ssh.KeyAlgoRSA {
		as, ok := k.signer.(ssh.AlgorithmSigner)
		if !ok {
			return nil, errors.New("rsa signer")
		}
		switch {
		case flags&agent.SignatureFlagRsaSha512 != 0:
			return as.SignWithAlgorithm(rand.Reader, data, ssh.KeyAlgoRSASHA512)
		case flags&agent.SignatureFlagRsaSha256 != 0:
			return as.SignWithAlgorithm(rand.Reader, data, ssh.KeyAlgoRSASHA256)
		}
	}
	return k.signer.Sign(rand.Reader, data)
}

// ---- socket lifecycle ----

// Start creates the socket directory (0700, owned by us, not a symlink),
// removes a stale socket and listens (socket 0600).
func (s *Server) Start(dir string) (string, error) {
	s.mu.Lock()
	if s.ln != nil {
		p := s.path
		s.mu.Unlock()
		return p, nil
	}
	s.mu.Unlock()
	if err := ensurePrivateDir(dir); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "agent.sock")
	if len(path) >= 104 {
		return "", fmt.Errorf("socket path too long")
	}
	if err := removeStale(path); err != nil {
		return "", err
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return "", err
	}
	ln.SetUnlinkOnClose(false)
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		os.Remove(path)
		return "", err
	}
	var ino uint64
	if fi, err := os.Lstat(path); err == nil {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok {
			ino = uint64(st.Ino)
		}
	}
	s.mu.Lock()
	s.ln, s.dir, s.path, s.sockIno = ln, dir, path, ino
	locked := s.locked
	s.mu.Unlock()
	s.wg.Add(1)
	go s.acceptLoop(ln)
	s.onState(true, locked)
	return path, nil
}

func ensurePrivateDir(dir string) error {
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return err
	}
	if err := os.Mkdir(dir, 0o700); err != nil && !os.IsExist(err) {
		return err
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return errors.New("agent directory is a symlink or not a directory; refusing to start")
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || int(st.Uid) != os.Getuid() {
		return errors.New("agent directory is owned by another user; refusing to start")
	}
	if fi.Mode().Perm() != 0o700 {
		if err := os.Chmod(dir, 0o700); err != nil {
			return err
		}
	}
	return nil
}

func removeStale(path string) error {
	fi, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if fi.Mode()&os.ModeSocket == 0 {
		return errors.New("a non-socket file exists at the agent socket path; refusing to remove it")
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); !ok || int(st.Uid) != os.Getuid() {
		return errors.New("agent socket is owned by another user")
	}
	if c, err := net.DialTimeout("unix", path, 500*time.Millisecond); err == nil {
		c.Close()
		return errors.New("another agent is already listening on the socket")
	}
	return os.Remove(path)
}

func (s *Server) acceptLoop(ln *net.UnixListener) {
	defer s.wg.Done()
	for {
		c, err := ln.AcceptUnix()
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.ln != ln {
			s.mu.Unlock()
			c.Close()
			return
		}
		s.conns[c] = struct{}{}
		s.mu.Unlock()
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			ca := &connAgent{s: s, client: peerInfo(c)}
			_ = agent.ServeAgent(ca, c)
			c.Close()
			s.mu.Lock()
			delete(s.conns, c)
			s.mu.Unlock()
		}()
	}
}

// Stop closes the listener and client connections and removes the socket
// (only if it is still the socket we created).
func (s *Server) Stop() {
	s.mu.Lock()
	ln, path, ino := s.ln, s.path, s.sockIno
	s.ln = nil
	conns := s.conns
	s.conns = map[net.Conn]struct{}{}
	for _, p := range s.pending {
		select {
		case p.ch <- decision{kind: "deny"}:
		default:
		}
	}
	s.pending = map[string]*pending{}
	locked := s.locked
	s.mu.Unlock()
	if ln == nil {
		return
	}
	ln.Close()
	for c := range conns {
		c.Close()
	}
	s.wg.Wait()
	if fi, err := os.Lstat(path); err == nil {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok && uint64(st.Ino) == ino && fi.Mode()&os.ModeSocket != 0 {
			os.Remove(path)
		}
	}
	s.onState(false, locked)
}

// DefaultSocketPath returns the socket path for dir.
func DefaultSocketPath(dir string) string { return filepath.Join(dir, "agent.sock") }
