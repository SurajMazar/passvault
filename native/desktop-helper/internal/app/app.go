// Package app wires the IPC ops of docs/DESKTOP_IPC.md to the helper's
// components. It is transport-agnostic: tests drive it with an in-memory
// Sender.
package app

import (
	"context"
	"encoding/base64"
	"errors"
	"time"

	"github.com/passvault/desktop-helper/internal/agentsrv"
	"github.com/passvault/desktop-helper/internal/fsops"
	"github.com/passvault/desktop-helper/internal/ipc"
	"github.com/passvault/desktop-helper/internal/keychain"
	"github.com/passvault/desktop-helper/internal/logx"
	"github.com/passvault/desktop-helper/internal/sshconn"
	"github.com/passvault/desktop-helper/internal/sshkeys"
	"github.com/passvault/desktop-helper/internal/sysevents"
	"github.com/passvault/desktop-helper/internal/term"
	"github.com/passvault/desktop-helper/internal/validate"
)

// Config configures an App.
type Config struct {
	Version  string
	AgentDir string // "" → agentsrv.DefaultDir()
	SSH      sshconn.Config
	Opener   *term.Opener
	Log      *logx.Logger
}

// App is the helper.
type App struct {
	D     *ipc.Dispatcher
	SSH   *sshconn.Manager
	Agent *agentsrv.Server
	Term  *term.Opener
	cfg   Config
	log   *logx.Logger
}

// New builds the helper and registers every op.
func New(sender ipc.Sender, cfg Config) *App {
	if cfg.Log == nil {
		cfg.Log = logx.Discard()
	}
	if cfg.SSH.DialTimeout == 0 {
		cfg.SSH = sshconn.DefaultConfig()
	}
	a := &App{cfg: cfg, log: cfg.Log}
	a.D = ipc.NewDispatcher(sender, cfg.Log)
	a.Agent = agentsrv.New(agentsrv.Notifier{
		Owner: func() (any, bool) {
			s := a.D.Current()
			return s, s != nil
		},
		Notify: func(owner any, req agentsrv.SignRequest) bool {
			s, _ := owner.(*ipc.Session)
			return a.D.Emit(s, "agent.signRequest", req)
		},
	}, func(running, locked bool) {
		a.D.EmitCurrent("agent.state", map[string]bool{"running": running, "locked": locked})
	})
	cfg.SSH.AgentSigners = a.Agent.Signers
	a.SSH = sshconn.NewManager(cfg.SSH)
	a.Term = cfg.Opener
	if a.Term == nil {
		a.Term = &term.Opener{}
	}
	a.Term.AgentSocket = func() (string, bool) {
		running, p, _, _ := a.Agent.Status()
		return p, running
	}
	a.D.OnSessionEnd(func(old *ipc.Session) {
		a.SSH.CloseOwner(old)
		a.Agent.CancelOwner(old)
		a.Agent.Lock()
	})
	sysevents.SetHandler(func(typ string) {
		go a.D.EmitCurrent("system.event", map[string]string{"type": typ})
	})
	a.register()
	return a
}

// Shutdown tears everything down: ends the session (closing SSH sessions,
// clearing agent keys), stops the agent and removes its socket.
func (a *App) Shutdown() {
	a.D.Shutdown(5 * time.Second)
	a.SSH.CloseAll()
	a.Agent.Lock()
	a.Agent.Stop()
	sysevents.SetHandler(nil)
}

func (a *App) agentDir() (string, error) {
	if a.cfg.AgentDir != "" {
		return a.cfg.AgentDir, nil
	}
	return agentsrv.DefaultDir()
}

// ---- param types ----

type empty struct{}

type helloP struct {
	ClientVersion string `json:"clientVersion"`
}

func (p *helloP) Validate() error {
	if len(p.ClientVersion) > 64 {
		return errors.New("clientVersion too long")
	}
	return nil
}

type kcSetP struct {
	Account   string `json:"account"`
	SecretB64 string `json:"secretB64"`
	Biometric bool   `json:"biometric"`
}

const maxKeychainSecret = 64 << 10

func (p *kcSetP) Validate() error {
	if !validate.KeychainAccount(p.Account) {
		return errors.New("invalid account")
	}
	if len(p.SecretB64) > base64.StdEncoding.EncodedLen(maxKeychainSecret) {
		return errors.New("secret too large")
	}
	return nil
}

type kcGetP struct {
	Account string `json:"account"`
	Reason  string `json:"reason"`
}

func (p *kcGetP) Validate() error {
	if !validate.KeychainAccount(p.Account) {
		return errors.New("invalid account")
	}
	if len(p.Reason) > 200 {
		return errors.New("reason too long")
	}
	return nil
}

type kcDelP struct {
	Account string `json:"account"`
}

func (p *kcDelP) Validate() error {
	if !validate.KeychainAccount(p.Account) {
		return errors.New("invalid account")
	}
	return nil
}

type connectP sshconn.ConnectParams

func (p *connectP) Validate() error {
	if !validate.ID(p.ConnID) {
		return errors.New("invalid connId")
	}
	return nil
}

type hostKeyDecisionP struct {
	ConnID string `json:"connId"`
	Hop    string `json:"hop"`
	Trust  bool   `json:"trust"`
}

type promptResponseP struct {
	ConnID   string   `json:"connId"`
	PromptID string   `json:"promptId"`
	Answers  []string `json:"answers,omitempty"`
	Cancel   bool     `json:"cancel,omitempty"`
}

func (p *promptResponseP) Validate() error {
	if len(p.Answers) > sshconn.MaxAnswers {
		return errors.New("too many answers")
	}
	for _, s := range p.Answers {
		if len(s) > sshconn.MaxAnswerLen {
			return errors.New("answer too long")
		}
	}
	return nil
}

type writeP struct {
	ConnID  string `json:"connId"`
	DataB64 string `json:"dataB64"`
}

type resizeP struct {
	ConnID string `json:"connId"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
}

type connIDP struct {
	ConnID string `json:"connId"`
}

type testP sshconn.TestParams

type keygenP struct {
	Algorithm  string `json:"algorithm"`
	Comment    string `json:"comment"`
	Passphrase string `json:"passphrase,omitempty"`
}

func (p *keygenP) Validate() error {
	ok := false
	for _, a := range sshkeys.Algorithms {
		if a == p.Algorithm {
			ok = true
		}
	}
	if !ok {
		return errors.New("unsupported algorithm")
	}
	if len(p.Comment) > sshkeys.MaxComment || len(p.Passphrase) > sshkeys.MaxPassphrase {
		return errors.New("field too long")
	}
	return nil
}

type inspectP struct {
	PrivateKey string `json:"privateKey,omitempty"`
	PublicKey  string `json:"publicKey,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
}

type addKeyP struct {
	KeyID      string `json:"keyId"`
	Name       string `json:"name"`
	PrivateKey string `json:"privateKey"`
	Passphrase string `json:"passphrase,omitempty"`
}

func (p *addKeyP) Validate() error {
	if !validate.ID(p.KeyID) {
		return errors.New("invalid keyId")
	}
	if len(p.Name) > 200 || len(p.PrivateKey) > sshkeys.MaxPrivateKey || len(p.Passphrase) > sshkeys.MaxPassphrase {
		return errors.New("field too long")
	}
	return nil
}

type keyIDP struct {
	KeyID string `json:"keyId"`
}

type signDecisionP struct {
	RequestID string `json:"requestId"`
	Decision  string `json:"decision"`
	Minutes   int    `json:"minutes,omitempty"`
}

type writeExportP struct {
	Path       string `json:"path"`
	ContentB64 string `json:"contentB64"`
	Overwrite  bool   `json:"overwrite"`
}

type readImportP struct {
	Path     string `json:"path"`
	MaxBytes int    `json:"maxBytes"`
}

func b64(s string, max int) ([]byte, error) {
	if len(s) > base64.StdEncoding.EncodedLen(max) {
		return nil, ipc.Errf(ipc.CodeBadRequest, "data too large")
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, ipc.Errf(ipc.CodeBadRequest, "invalid base64")
	}
	return b, nil
}

// ---- ops ----

func (a *App) register() {
	d := a.D
	ipc.Register(d, "hello", ipc.Opts{NoSession: true}, func(_ context.Context, _ *ipc.Session, p *helloP) (any, error) {
		s := d.NewSession()
		bio := keychain.Status()
		return map[string]any{
			"sessionId":     s.ID,
			"helperVersion": a.cfg.Version,
			"capabilities": map[string]any{
				"keychain":     keychain.Available(),
				"biometrics":   bio,
				"agent":        true,
				"terminal":     true,
				"systemEvents": sysevents.Available(),
			},
		}, nil
	})
	ipc.Register(d, "ping", ipc.Opts{}, func(context.Context, *ipc.Session, *empty) (any, error) {
		return map[string]any{"now": time.Now().UnixMilli()}, nil
	})
	ipc.Register(d, "vault.locked", ipc.Opts{}, func(context.Context, *ipc.Session, *empty) (any, error) {
		n := a.SSH.CloseAll()
		k := a.Agent.Lock()
		return map[string]int{"closedConnections": n, "agentKeysRemoved": k}, nil
	})

	// Keychain.
	ipc.Register(d, "keychain.set", ipc.Opts{}, func(_ context.Context, _ *ipc.Session, p *kcSetP) (any, error) {
		secret, err := b64(p.SecretB64, maxKeychainSecret)
		if err != nil {
			return nil, err
		}
		defer clear(secret)
		return nil, keychain.Set(p.Account, secret, p.Biometric)
	})
	ipc.Register(d, "keychain.get", ipc.Opts{}, func(_ context.Context, _ *ipc.Session, p *kcGetP) (any, error) {
		secret, err := keychain.Get(p.Account, p.Reason)
		if err != nil {
			return nil, err
		}
		defer clear(secret)
		return map[string]string{"secretB64": base64.StdEncoding.EncodeToString(secret)}, nil
	})
	ipc.Register(d, "keychain.delete", ipc.Opts{}, func(_ context.Context, _ *ipc.Session, p *kcDelP) (any, error) {
		return nil, keychain.Delete(p.Account)
	})
	ipc.Register(d, "biometric.status", ipc.Opts{}, func(context.Context, *ipc.Session, *empty) (any, error) {
		return keychain.Status(), nil
	})

	// SSH sessions.
	ipc.Register(d, "ssh.connect", ipc.Opts{}, func(_ context.Context, s *ipc.Session, p *connectP) (any, error) {
		emit := func(typ string, data any) { d.Emit(s, typ, data) }
		cp := sshconn.ConnectParams(*p)
		if err := a.SSH.Connect(s, emit, &cp); err != nil {
			return nil, err
		}
		return map[string]string{"connId": p.ConnID}, nil
	})
	ipc.Register(d, "ssh.hostKeyDecision", ipc.Opts{Serial: true}, func(_ context.Context, s *ipc.Session, p *hostKeyDecisionP) (any, error) {
		return nil, a.SSH.HostKeyDecision(s, p.ConnID, p.Hop, p.Trust)
	})
	ipc.Register(d, "ssh.promptResponse", ipc.Opts{Serial: true}, func(_ context.Context, s *ipc.Session, p *promptResponseP) (any, error) {
		return nil, a.SSH.PromptResponse(s, p.ConnID, p.PromptID, p.Answers, p.Cancel)
	})
	ipc.Register(d, "ssh.write", ipc.Opts{Serial: true}, func(_ context.Context, s *ipc.Session, p *writeP) (any, error) {
		data, err := b64(p.DataB64, sshconn.MaxWriteBytes)
		if err != nil {
			return nil, err
		}
		return nil, a.SSH.Write(s, p.ConnID, data)
	})
	ipc.Register(d, "ssh.resize", ipc.Opts{Serial: true}, func(_ context.Context, s *ipc.Session, p *resizeP) (any, error) {
		return nil, a.SSH.Resize(s, p.ConnID, p.Cols, p.Rows)
	})
	ipc.Register(d, "ssh.disconnect", ipc.Opts{}, func(_ context.Context, s *ipc.Session, p *connIDP) (any, error) {
		return nil, a.SSH.Disconnect(s, p.ConnID)
	})
	ipc.Register(d, "ssh.test", ipc.Opts{}, func(ctx context.Context, _ *ipc.Session, p *testP) (any, error) {
		tp := sshconn.TestParams(*p)
		return a.SSH.Test(ctx, &tp)
	})
	ipc.Register(d, "ssh.keygen", ipc.Opts{}, func(_ context.Context, _ *ipc.Session, p *keygenP) (any, error) {
		g, err := sshkeys.Generate(p.Algorithm, p.Comment, p.Passphrase)
		if err != nil {
			return nil, ipc.Errf(ipc.CodeInternal, "key generation failed")
		}
		return g, nil
	})
	ipc.Register(d, "ssh.inspectKey", ipc.Opts{}, func(_ context.Context, _ *ipc.Session, p *inspectP) (any, error) {
		r, err := sshkeys.Inspect(p.PrivateKey, p.PublicKey, p.Passphrase)
		if err != nil {
			return nil, ipc.Errf(ipc.CodeBadRequest, "%s", err.Error())
		}
		return r, nil
	})

	// Agent.
	ipc.Register(d, "agent.status", ipc.Opts{}, func(context.Context, *ipc.Session, *empty) (any, error) {
		running, path, locked, keys := a.Agent.Status()
		if path == "" {
			if dir, err := a.agentDir(); err == nil {
				path = agentsrv.DefaultSocketPath(dir)
			}
		}
		return map[string]any{"running": running, "socketPath": path, "locked": locked, "keys": keys}, nil
	})
	ipc.Register(d, "agent.start", ipc.Opts{}, func(context.Context, *ipc.Session, *empty) (any, error) {
		dir, err := a.agentDir()
		if err != nil {
			return nil, ipc.Errf(ipc.CodeUnavailable, "no home directory")
		}
		p, err := a.Agent.Start(dir)
		if err != nil {
			return nil, ipc.Errf(ipc.CodeUnavailable, "agent: %s", err.Error())
		}
		return map[string]string{"socketPath": p}, nil
	})
	ipc.Register(d, "agent.stop", ipc.Opts{}, func(context.Context, *ipc.Session, *empty) (any, error) {
		a.Agent.Stop()
		return nil, nil
	})
	ipc.Register(d, "agent.addKey", ipc.Opts{}, func(_ context.Context, _ *ipc.Session, p *addKeyP) (any, error) {
		fp, err := a.Agent.AddKey(p.KeyID, p.Name, p.PrivateKey, p.Passphrase)
		if err != nil {
			return nil, err
		}
		return map[string]string{"fingerprint": fp}, nil
	})
	ipc.Register(d, "agent.removeKey", ipc.Opts{}, func(_ context.Context, _ *ipc.Session, p *keyIDP) (any, error) {
		return nil, a.Agent.RemoveKey(p.KeyID)
	})
	ipc.Register(d, "agent.signDecision", ipc.Opts{Serial: true}, func(_ context.Context, s *ipc.Session, p *signDecisionP) (any, error) {
		return nil, a.Agent.Decide(s, p.RequestID, p.Decision, p.Minutes)
	})

	// External terminal.
	ipc.Register(d, "term.openExternal", ipc.Opts{}, func(_ context.Context, _ *ipc.Session, p *term.Params) (any, error) {
		if _, err := a.Term.Open(p); err != nil {
			return nil, err
		}
		return nil, nil
	})

	// Files.
	ipc.Register(d, "fs.writeExport", ipc.Opts{}, func(_ context.Context, _ *ipc.Session, p *writeExportP) (any, error) {
		content, err := b64(p.ContentB64, fsops.MaxFileBytes)
		if err != nil {
			return nil, err
		}
		defer clear(content)
		if err := fsops.WriteExport(p.Path, content, p.Overwrite); err != nil {
			return nil, err
		}
		return map[string]string{"path": p.Path, "mode": "0600"}, nil
	})
	ipc.Register(d, "fs.readImport", ipc.Opts{}, func(_ context.Context, _ *ipc.Session, p *readImportP) (any, error) {
		b, err := fsops.ReadImport(p.Path, p.MaxBytes)
		if err != nil {
			return nil, err
		}
		defer clear(b)
		return map[string]any{"contentB64": base64.StdEncoding.EncodeToString(b), "size": len(b)}, nil
	})
}

// Ops lists registered op names (docs/tests).
func Ops() []string {
	return []string{"hello", "ping", "vault.locked", "keychain.set", "keychain.get", "keychain.delete",
		"biometric.status", "ssh.connect", "ssh.hostKeyDecision", "ssh.promptResponse", "ssh.write",
		"ssh.resize", "ssh.disconnect", "ssh.test", "ssh.keygen", "ssh.inspectKey", "agent.status",
		"agent.start", "agent.stop", "agent.addKey", "agent.removeKey", "agent.signDecision",
		"term.openExternal", "fs.writeExport", "fs.readImport"}
}
