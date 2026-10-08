package sshconn

import (
	"bytes"
	"context"
	"crypto"
	"encoding/base64"
	"errors"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/passvault/desktop-helper/internal/ipc"
	"github.com/passvault/desktop-helper/internal/sshkeys"
)

// failure records why a handshake failed when the cause is ours (host key
// policy, cancelled prompt) rather than the library's.
type failure struct {
	mu      sync.Mutex
	code    string
	message string
}

func (f *failure) set(code, msg string) {
	f.mu.Lock()
	if f.code == "" {
		f.code, f.message = code, msg
	}
	f.mu.Unlock()
}

func (f *failure) get() (string, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.code, f.message
}

var errHostKeyRejected = errors.New("host key rejected")

// hooks connect the dialer to either an interactive connection (events +
// waiting for decisions) or a non-interactive ssh.test.
type hooks struct {
	state func(state, msg string)
	// unknownHostKey blocks until the user decides; nil error = trust.
	unknownHostKey func(ctx context.Context, ev HostKeyEvent) error
	mismatch       func(ev HostKeyEvent)
	prompt         func(ctx context.Context, hop, name, instruction string, qs []Question) ([]string, error)
}

// prepared holds parsed credentials for one hop.
type prepared struct {
	name    string // "jump" | "target"
	hop     *Hop
	trusted []ssh.PublicKey
	signer  ssh.Signer
	rawKey  crypto.PrivateKey
}

func (p *prepared) wipe() {
	if p.rawKey != nil {
		sshkeys.Zero(p.rawKey)
		p.rawKey = nil
	}
	p.signer = nil
	p.hop.Auth.Password = ""
	p.hop.Auth.Passphrase = ""
	p.hop.Auth.PrivateKey = ""
}

// prepare validates and parses a hop synchronously so credential errors are
// reported as bad_request before any network activity.
func prepare(name string, h *Hop, agentSigners func() []ssh.Signer) (*prepared, error) {
	if err := h.Validate(name); err != nil {
		return nil, ipc.Errf(ipc.CodeBadRequest, "%s", err.Error())
	}
	trusted, _ := ParseTrusted(h.TrustedHostKeys)
	p := &prepared{name: name, hop: h, trusted: trusted}
	switch h.Auth.Method {
	case "key":
		s, raw, err := sshkeys.ParseSigner(h.Auth.PrivateKey, h.Auth.Passphrase)
		if err != nil {
			return nil, ipc.Errf(ipc.CodeBadRequest, "%s private key: %s", name, err.Error())
		}
		p.signer, p.rawKey = s, raw
	case "agent":
		if agentSigners == nil || len(agentSigners()) == 0 {
			return nil, ipc.Errf(ipc.CodeUnavailable, "%s: no keys are loaded in the PassVault agent", name)
		}
	}
	return p, nil
}

func fingerprints(keys []ssh.PublicKey) []string {
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, ssh.FingerprintSHA256(k))
	}
	return out
}

// hostKeyAlgorithms prefers the algorithms of keys we already trust so the
// server presents a key we can compare (as OpenSSH does).
func hostKeyAlgorithms(trusted []ssh.PublicKey) []string {
	if len(trusted) == 0 {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	add := func(a string) {
		if !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}
	for _, t := range trusted {
		switch t.Type() {
		case ssh.KeyAlgoRSA:
			add(ssh.KeyAlgoRSASHA512)
			add(ssh.KeyAlgoRSASHA256)
		default:
			add(t.Type())
		}
	}
	for _, a := range ssh.SupportedAlgorithms().HostKeys {
		add(a)
	}
	return out
}

type dialer struct {
	connID       string
	hooks        hooks
	dialTimeout  time.Duration
	agentSigners func() []ssh.Signer
}

func (d *dialer) clientConfig(ctx context.Context, p *prepared, fail *failure) *ssh.ClientConfig {
	hp := HostPort(p.hop.Host, p.hop.Port)
	cb := func(_ string, _ net.Addr, key ssh.PublicKey) error {
		for _, t := range p.trusted {
			if bytes.Equal(t.Marshal(), key.Marshal()) {
				d.hooks.state("authenticating", "")
				return nil
			}
		}
		ev := HostKeyEvent{
			ConnID:      d.connID,
			Hop:         p.name,
			HostPort:    hp,
			KeyType:     key.Type(),
			PublicKey:   base64.StdEncoding.EncodeToString(key.Marshal()),
			Fingerprint: ssh.FingerprintSHA256(key),
			Trusted:     fingerprints(p.trusted),
		}
		if len(p.trusted) > 0 {
			ev.Status = "mismatch"
			fail.set(ipc.CodeHostKeyMismatch, p.name+" host key does not match the trusted key; connection aborted")
			d.hooks.mismatch(ev)
			return errHostKeyRejected
		}
		ev.Status = "unknown"
		d.hooks.state("verifying_host", "")
		if err := d.hooks.unknownHostKey(ctx, ev); err != nil {
			fail.set(ipc.CodeHostKeyUnknown, p.name+" host key was not trusted: "+err.Error())
			return errHostKeyRejected
		}
		d.hooks.state("authenticating", "")
		return nil
	}

	var methods []ssh.AuthMethod
	switch p.hop.Auth.Method {
	case "password":
		methods = []ssh.AuthMethod{ssh.Password(p.hop.Auth.Password)}
	case "key":
		methods = []ssh.AuthMethod{ssh.PublicKeys(p.signer)}
	case "agent":
		methods = []ssh.AuthMethod{ssh.PublicKeysCallback(func() ([]ssh.Signer, error) {
			if d.agentSigners == nil {
				return nil, nil
			}
			return d.agentSigners(), nil
		})}
	case "keyboard_interactive":
		methods = []ssh.AuthMethod{ssh.KeyboardInteractive(func(name, instruction string, qs []string, echos []bool) ([]string, error) {
			if len(qs) == 0 {
				// Informational round with nothing to answer.
				return []string{}, nil
			}
			questions := make([]Question, len(qs))
			for i := range qs {
				questions[i] = Question{Text: qs[i], Echo: i < len(echos) && echos[i]}
			}
			ans, err := d.hooks.prompt(ctx, p.name, name, instruction, questions)
			if err != nil {
				fail.set(ipc.CodeAuthFailed, err.Error())
				return nil, err
			}
			return ans, nil
		})}
	}
	return &ssh.ClientConfig{
		User:              p.hop.Username,
		Auth:              methods,
		HostKeyCallback:   cb,
		HostKeyAlgorithms: hostKeyAlgorithms(p.trusted),
		Timeout:           d.dialTimeout,
		ClientVersion:     "SSH-2.0-PassVault",
	}
}

// handshake performs SSH over conn, aborting if ctx ends.
func (d *dialer) handshake(ctx context.Context, conn net.Conn, p *prepared) (*ssh.Client, error) {
	fail := &failure{}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	addr := HostPort(p.hop.Host, p.hop.Port)
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, d.clientConfig(ctx, p, fail))
	if err != nil {
		conn.Close()
		if code, msg := fail.get(); code != "" {
			return nil, ipc.Errf(code, "%s", msg)
		}
		if ctx.Err() != nil {
			return nil, ipc.Errf(ipc.CodeConnectFailed, "%s: cancelled", p.name)
		}
		if strings.Contains(err.Error(), "unable to authenticate") {
			return nil, ipc.Errf(ipc.CodeAuthFailed, "%s: authentication failed", p.name)
		}
		return nil, ipc.Errf(ipc.CodeConnectFailed, "%s: SSH handshake failed: %s", p.name, trimErr(err))
	}
	return ssh.NewClient(c, chans, reqs), nil
}

func trimErr(err error) string {
	s := strings.TrimPrefix(err.Error(), "ssh: handshake failed: ")
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

// dial connects through the optional jump host to the target. Both hops'
// host keys are verified.
func (d *dialer) dial(ctx context.Context, target, jump *prepared) (client, jumpClient *ssh.Client, err error) {
	d.hooks.state("connecting", "")
	nd := net.Dialer{Timeout: d.dialTimeout, KeepAlive: 30 * time.Second}
	if jump != nil {
		raw, err := nd.DialContext(ctx, "tcp", HostPort(jump.hop.Host, jump.hop.Port))
		if err != nil {
			return nil, nil, ipc.Errf(ipc.CodeConnectFailed, "jump: %s", netErr(err))
		}
		jc, err := d.handshake(ctx, raw, jump)
		if err != nil {
			return nil, nil, err
		}
		dctx, cancel := context.WithTimeout(ctx, d.dialTimeout)
		tconn, err := jc.DialContext(dctx, "tcp", HostPort(target.hop.Host, target.hop.Port))
		cancel()
		if err != nil {
			jc.Close()
			return nil, nil, ipc.Errf(ipc.CodeConnectFailed, "target via jump: %s", trimErr(err))
		}
		d.hooks.state("connecting", "")
		c, err := d.handshake(ctx, tconn, target)
		if err != nil {
			jc.Close()
			return nil, nil, err
		}
		return c, jc, nil
	}
	raw, err := nd.DialContext(ctx, "tcp", HostPort(target.hop.Host, target.hop.Port))
	if err != nil {
		return nil, nil, ipc.Errf(ipc.CodeConnectFailed, "%s", netErr(err))
	}
	c, err := d.handshake(ctx, raw, target)
	if err != nil {
		return nil, nil, err
	}
	return c, nil, nil
}

func netErr(err error) string {
	var oe *net.OpError
	if errors.As(err, &oe) && oe.Err != nil {
		return oe.Op + ": " + oe.Err.Error()
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timed out"
	}
	return "connection failed"
}
