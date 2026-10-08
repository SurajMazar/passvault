package sshconn

import (
	"context"
	"encoding/base64"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/passvault/desktop-helper/internal/ipc"
	"github.com/passvault/desktop-helper/internal/sshkeys"
	"github.com/passvault/desktop-helper/internal/testutil/sshtest"
)

type event struct {
	typ  string
	data any
}

type rec struct{ ch chan event }

func newRec() *rec { return &rec{ch: make(chan event, 1000)} }

func (r *rec) emit(typ string, data any) { r.ch <- event{typ, data} }

func (r *rec) wait(t *testing.T, what string, pred func(event) bool) event {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case e := <-r.ch:
			if pred(e) {
				return e
			}
		case <-timeout:
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func isState(s string) func(event) bool {
	return func(e event) bool {
		st, ok := e.data.(StateEvent)
		return e.typ == "ssh.state" && ok && st.State == s
	}
}

func (r *rec) waitHostKey(t *testing.T) HostKeyEvent {
	t.Helper()
	return r.wait(t, "ssh.hostKey", func(e event) bool { return e.typ == "ssh.hostKey" }).data.(HostKeyEvent)
}

func (r *rec) waitError(t *testing.T) StateEvent {
	t.Helper()
	return r.wait(t, "error state", isState("error")).data.(StateEvent)
}

func testConfig() Config {
	c := DefaultConfig()
	c.HostKeyTimeout = 3 * time.Second
	c.PromptTimeout = 3 * time.Second
	c.DialTimeout = 5 * time.Second
	c.KeepaliveInterval = 200 * time.Millisecond
	return c
}

func trustedFor(s *sshtest.Server) []HostKey {
	kt, b := s.HostKeyB64()
	return []HostKey{{KeyType: kt, PublicKey: b}}
}

func pwHop(s *sshtest.Server, user, pw string, trusted []HostKey) Hop {
	return Hop{Host: s.Host, Port: s.Port, Username: user, Auth: Auth{Method: "password", Password: pw}, TrustedHostKeys: trusted}
}

const owner = "session-1"

func TestUnknownHostKeyTrustThenShell(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{User: "alice", Password: "dummy-pw-123"})
	m := NewManager(testConfig())
	r := newRec()
	err := m.Connect(owner, r.emit, &ConnectParams{ConnID: "c1", Target: pwHop(srv, "alice", "dummy-pw-123", nil), Cols: 120, Rows: 40})
	if err != nil {
		t.Fatal(err)
	}
	hk := r.waitHostKey(t)
	if hk.Status != "unknown" || hk.Hop != "target" || hk.ConnID != "c1" {
		t.Fatalf("unexpected hostKey event %+v", hk)
	}
	if want := ssh.FingerprintSHA256(srv.HostKey.PublicKey()); hk.Fingerprint != want || !strings.HasPrefix(hk.Fingerprint, "SHA256:") {
		t.Fatalf("fingerprint %q want %q", hk.Fingerprint, want)
	}
	if len(srv.AuthAttempts()) != 0 {
		t.Fatal("auth attempted before host key decision")
	}
	if err := m.HostKeyDecision("other-session", "c1", "target", true); err == nil {
		t.Fatal("foreign owner accepted")
	}
	if err := m.HostKeyDecision(owner, "c1", "target", true); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "connected", isState("connected"))
	p := srv.Ptys()
	if len(p) != 1 || p[0].Cols != 120 || p[0].Rows != 40 || p[0].Term != "xterm-256color" {
		t.Fatalf("pty-req = %+v", p)
	}
	if err := m.Write(owner, "c1", []byte("hello-roundtrip\n")); err != nil {
		t.Fatal(err)
	}
	var got strings.Builder
	r.wait(t, "echo", func(e event) bool {
		if d, ok := e.data.(DataEvent); ok {
			b, _ := base64.StdEncoding.DecodeString(d.DataB64)
			got.Write(b)
		}
		return strings.Contains(got.String(), "hello-roundtrip")
	})
	if err := m.Resize(owner, "c1", 200, 50); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(srv.Resizes()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if rs := srv.Resizes(); len(rs) != 1 || rs[0].Cols != 200 || rs[0].Rows != 50 {
		t.Fatalf("window-change = %+v", rs)
	}
	done := m.Done("c1")
	if err := m.Disconnect(owner, "c1"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("connection goroutines did not exit")
	}
	r.wait(t, "closed", isState("closed"))
	if m.Count() != 0 {
		t.Fatal("connection still registered")
	}
}

func TestUnknownHostKeyReject(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{User: "alice", Password: "dummy-pw-123"})
	m := NewManager(testConfig())
	r := newRec()
	if err := m.Connect(owner, r.emit, &ConnectParams{ConnID: "c1", Target: pwHop(srv, "alice", "dummy-pw-123", nil), Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	r.waitHostKey(t)
	if err := m.HostKeyDecision(owner, "c1", "target", false); err != nil {
		t.Fatal(err)
	}
	e := r.waitError(t)
	if e.Code != ipc.CodeHostKeyUnknown {
		t.Fatalf("code %q", e.Code)
	}
	r.wait(t, "closed", isState("closed"))
	<-m.Done("c1")
	if n := len(srv.AuthAttempts()); n != 0 {
		t.Fatalf("server saw %d auth attempts", n)
	}
}

func TestHostKeyDecisionTimeout(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{User: "alice", Password: "pw"})
	cfg := testConfig()
	cfg.HostKeyTimeout = 200 * time.Millisecond
	m := NewManager(cfg)
	r := newRec()
	_ = m.Connect(owner, r.emit, &ConnectParams{ConnID: "c1", Target: pwHop(srv, "alice", "pw", nil), Cols: 80, Rows: 24})
	if e := r.waitError(t); e.Code != ipc.CodeHostKeyUnknown {
		t.Fatalf("code %q", e.Code)
	}
}

func TestHostKeyMismatchAbortsBeforeAuth(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{User: "alice", Password: "dummy-pw-123"})
	other := sshtest.NewHostKey(t).PublicKey()
	trusted := []HostKey{{KeyType: other.Type(), PublicKey: base64.StdEncoding.EncodeToString(other.Marshal())}}
	m := NewManager(testConfig())
	r := newRec()
	if err := m.Connect(owner, r.emit, &ConnectParams{ConnID: "c1", Target: pwHop(srv, "alice", "dummy-pw-123", trusted), Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	hk := r.waitHostKey(t)
	if hk.Status != "mismatch" || len(hk.Trusted) != 1 || hk.Trusted[0] != ssh.FingerprintSHA256(other) {
		t.Fatalf("event %+v", hk)
	}
	// A mismatch can never be overridden.
	if err := m.HostKeyDecision(owner, "c1", "target", true); err == nil {
		t.Fatal("mismatch decision accepted")
	}
	if e := r.waitError(t); e.Code != ipc.CodeHostKeyMismatch {
		t.Fatalf("code %q", e.Code)
	}
	<-m.Done("c1")
	if len(srv.AuthAttempts()) != 0 || len(srv.PasswordsSeen()) != 0 {
		t.Fatal("authentication was attempted after a host key mismatch")
	}
}

func TestJumpHostBothHopsVerified(t *testing.T) {
	jump := sshtest.Start(t, sshtest.Options{User: "jumper", Password: "jump-pw", AllowForward: true})
	gen, err := sshkeys.Generate("ed25519", "dummy", "")
	if err != nil {
		t.Fatal(err)
	}
	pub, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(gen.PublicKey))
	target := sshtest.Start(t, sshtest.Options{User: "bob", AuthorizedKeys: []ssh.PublicKey{pub}})
	m := NewManager(testConfig())
	r := newRec()
	jh := pwHop(jump, "jumper", "jump-pw", nil)
	th := Hop{Host: target.Host, Port: target.Port, Username: "bob", Auth: Auth{Method: "key", PrivateKey: gen.PrivateKey}}
	if err := m.Connect(owner, r.emit, &ConnectParams{ConnID: "j1", Target: th, Jump: &jh, Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	hk := r.waitHostKey(t)
	if hk.Hop != "jump" || hk.Fingerprint != ssh.FingerprintSHA256(jump.HostKey.PublicKey()) {
		t.Fatalf("first prompt %+v", hk)
	}
	if err := m.HostKeyDecision(owner, "j1", "jump", true); err != nil {
		t.Fatal(err)
	}
	hk = r.waitHostKey(t)
	if hk.Hop != "target" || hk.Fingerprint != ssh.FingerprintSHA256(target.HostKey.PublicKey()) {
		t.Fatalf("second prompt %+v", hk)
	}
	if err := m.HostKeyDecision(owner, "j1", "target", true); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "connected", isState("connected"))
	if f := jump.Forwards(); len(f) != 1 || f[0] != target.Addr {
		t.Fatalf("forwards %v", f)
	}
	m.CloseAll()

	// With both keys trusted there are no prompts.
	r2 := newRec()
	jh = pwHop(jump, "jumper", "jump-pw", trustedFor(jump))
	th.TrustedHostKeys = trustedFor(target)
	th.Auth.PrivateKey = gen.PrivateKey
	if err := m.Connect(owner, r2.emit, &ConnectParams{ConnID: "j2", Target: th, Jump: &jh, Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	e := r2.wait(t, "connected or hostKey", func(e event) bool { return e.typ == "ssh.hostKey" || isState("connected")(e) })
	if e.typ == "ssh.hostKey" {
		t.Fatal("prompted although both keys trusted")
	}
	m.CloseAll()
}

func TestJumpHostMismatchAborts(t *testing.T) {
	jump := sshtest.Start(t, sshtest.Options{User: "jumper", Password: "jump-pw", AllowForward: true})
	target := sshtest.Start(t, sshtest.Options{User: "bob", Password: "target-pw"})
	wrong := sshtest.NewHostKey(t).PublicKey()
	jh := pwHop(jump, "jumper", "jump-pw", []HostKey{{KeyType: wrong.Type(), PublicKey: base64.StdEncoding.EncodeToString(wrong.Marshal())}})
	th := pwHop(target, "bob", "target-pw", trustedFor(target))
	m := NewManager(testConfig())
	r := newRec()
	if err := m.Connect(owner, r.emit, &ConnectParams{ConnID: "j1", Target: th, Jump: &jh, Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	if hk := r.waitHostKey(t); hk.Hop != "jump" || hk.Status != "mismatch" {
		t.Fatalf("event %+v", hk)
	}
	if e := r.waitError(t); e.Code != ipc.CodeHostKeyMismatch {
		t.Fatalf("code %q", e.Code)
	}
	<-m.Done("j1")
	if len(jump.AuthAttempts()) != 0 || len(jump.Forwards()) != 0 || len(target.AuthAttempts()) != 0 {
		t.Fatal("traffic continued after jump mismatch")
	}
}

func TestWrongPassword(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{User: "alice", Password: "right"})
	m := NewManager(testConfig())
	r := newRec()
	_ = m.Connect(owner, r.emit, &ConnectParams{ConnID: "c1", Target: pwHop(srv, "alice", "wrong", trustedFor(srv)), Cols: 80, Rows: 24})
	if e := r.waitError(t); e.Code != ipc.CodeAuthFailed {
		t.Fatalf("code %q (%s)", e.Code, e.Message)
	}
}

func TestPublicKeyWithPassphrase(t *testing.T) {
	gen, err := sshkeys.Generate("ecdsa-p256", "dummy", "dummy-passphrase")
	if err != nil {
		t.Fatal(err)
	}
	pub, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(gen.PublicKey))
	srv := sshtest.Start(t, sshtest.Options{User: "alice", AuthorizedKeys: []ssh.PublicKey{pub}})
	m := NewManager(testConfig())
	hop := Hop{Host: srv.Host, Port: srv.Port, Username: "alice", Auth: Auth{Method: "key", PrivateKey: gen.PrivateKey}, TrustedHostKeys: trustedFor(srv)}
	err = m.Connect(owner, func(string, any) {}, &ConnectParams{ConnID: "c0", Target: hop, Cols: 80, Rows: 24})
	if e := ipc.AsError(err); err == nil || e.Code != ipc.CodeBadRequest {
		t.Fatalf("missing passphrase: %v", err)
	}
	hop.Auth.Passphrase = "dummy-passphrase"
	r := newRec()
	if err := m.Connect(owner, r.emit, &ConnectParams{ConnID: "c1", Target: hop, Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "connected", isState("connected"))
	m.CloseAll()
}

func TestKeyboardInteractiveMultiPrompt(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{User: "alice", KI: []sshtest.KIRound{
		{Instruction: "step 1", Questions: []string{"Password: "}, Echos: []bool{false}, Expect: []string{"ki-secret"}},
		{Instruction: "step 2", Questions: []string{"Verification code: ", "Device name: "}, Echos: []bool{true, true}, Expect: []string{"123456", "laptop"}},
	}})
	m := NewManager(testConfig())
	r := newRec()
	hop := Hop{Host: srv.Host, Port: srv.Port, Username: "alice", Auth: Auth{Method: "keyboard_interactive", Password: "stored-pw-not-used"}, TrustedHostKeys: trustedFor(srv)}
	if err := m.Connect(owner, r.emit, &ConnectParams{ConnID: "k1", Target: hop, Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	p1 := r.wait(t, "prompt 1", func(e event) bool { return e.typ == "ssh.prompt" }).data.(PromptEvent)
	if len(p1.Questions) != 1 || p1.Questions[0].Echo || p1.Instruction != "step 1" {
		t.Fatalf("prompt 1 %+v", p1)
	}
	if err := m.PromptResponse(owner, "k1", p1.PromptID, []string{"a", "b"}, false); err == nil {
		t.Fatal("wrong answer count accepted")
	}
	if err := m.PromptResponse(owner, "k1", p1.PromptID, []string{"ki-secret"}, false); err != nil {
		t.Fatal(err)
	}
	p2 := r.wait(t, "prompt 2", func(e event) bool { return e.typ == "ssh.prompt" }).data.(PromptEvent)
	if len(p2.Questions) != 2 || !p2.Questions[0].Echo || p2.Questions[0].Text != "Verification code: " {
		t.Fatalf("prompt 2 %+v", p2)
	}
	if err := m.PromptResponse(owner, "k1", p2.PromptID, []string{"123456", "laptop"}, false); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "connected", isState("connected"))
	for _, pw := range srv.PasswordsSeen() {
		if pw == "stored-pw-not-used" {
			t.Fatal("stored password was sent automatically")
		}
	}
	m.CloseAll()
}

func TestKeyboardInteractiveCancel(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{User: "alice", KI: []sshtest.KIRound{{Questions: []string{"OTP: "}, Echos: []bool{true}, Expect: []string{"1"}}}})
	m := NewManager(testConfig())
	r := newRec()
	hop := Hop{Host: srv.Host, Port: srv.Port, Username: "alice", Auth: Auth{Method: "keyboard_interactive"}, TrustedHostKeys: trustedFor(srv)}
	_ = m.Connect(owner, r.emit, &ConnectParams{ConnID: "k1", Target: hop, Cols: 80, Rows: 24})
	p := r.wait(t, "prompt", func(e event) bool { return e.typ == "ssh.prompt" }).data.(PromptEvent)
	if err := m.PromptResponse(owner, "k1", p.PromptID, nil, true); err != nil {
		t.Fatal(err)
	}
	if e := r.waitError(t); e.Code != ipc.CodeAuthFailed {
		t.Fatalf("code %q", e.Code)
	}
	r.wait(t, "closed", isState("closed"))
}

func TestRemoteExit(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{User: "alice", Password: "pw"})
	m := NewManager(testConfig())
	r := newRec()
	_ = m.Connect(owner, r.emit, &ConnectParams{ConnID: "c1", Target: pwHop(srv, "alice", "pw", trustedFor(srv)), Cols: 80, Rows: 24})
	r.wait(t, "connected", isState("connected"))
	_ = m.Write(owner, "c1", []byte("exit\n"))
	ex := r.wait(t, "exit", func(e event) bool { return e.typ == "ssh.exit" }).data.(ExitEvent)
	if ex.ExitStatus == nil || *ex.ExitStatus != 3 {
		t.Fatalf("exit %+v", ex)
	}
	r.wait(t, "closed", isState("closed"))
	<-m.Done("c1")
}

func TestCloseAllNoGoroutineLeak(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{User: "alice", Password: "pw"})
	m := NewManager(testConfig())
	before := runtime.NumGoroutine()
	for i := 0; i < 3; i++ {
		r := newRec()
		id := "c" + string(rune('a'+i))
		_ = m.Connect(owner, r.emit, &ConnectParams{ConnID: id, Target: pwHop(srv, "alice", "pw", trustedFor(srv)), Cols: 80, Rows: 24})
		r.wait(t, "connected", isState("connected"))
	}
	if n := m.CloseAll(); n != 3 {
		t.Fatalf("closed %d", n)
	}
	if m.Count() != 0 {
		t.Fatal("connections remain")
	}
	deadline := time.Now().Add(5 * time.Second)
	for runtime.NumGoroutine() > before+2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if g := runtime.NumGoroutine(); g > before+2 {
		buf := make([]byte, 1<<16)
		n := runtime.Stack(buf, true)
		t.Fatalf("goroutines: before %d after %d\n%s", before, g, buf[:n])
	}
}

func TestAgentAuthUsesHelperKeys(t *testing.T) {
	gen, _ := sshkeys.Generate("ed25519", "", "")
	signer, _, err := sshkeys.ParseSigner(gen.PrivateKey, "")
	if err != nil {
		t.Fatal(err)
	}
	srv := sshtest.Start(t, sshtest.Options{User: "alice", AuthorizedKeys: []ssh.PublicKey{signer.PublicKey()}})
	cfg := testConfig()
	var signers []ssh.Signer
	cfg.AgentSigners = func() []ssh.Signer { return signers }
	m := NewManager(cfg)
	hop := Hop{Host: srv.Host, Port: srv.Port, Username: "alice", Auth: Auth{Method: "agent"}, TrustedHostKeys: trustedFor(srv)}
	if err := m.Connect(owner, func(string, any) {}, &ConnectParams{ConnID: "a0", Target: hop, Cols: 80, Rows: 24}); ipc.AsError(err).Code != ipc.CodeUnavailable {
		t.Fatalf("expected unavailable with empty agent, got %v", err)
	}
	signers = []ssh.Signer{signer}
	r := newRec()
	if err := m.Connect(owner, r.emit, &ConnectParams{ConnID: "a1", Target: hop, Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "connected", isState("connected"))
	m.CloseAll()
}

func TestSSHTest(t *testing.T) {
	srv := sshtest.Start(t, sshtest.Options{User: "alice", Password: "pw"})
	m := NewManager(testConfig())
	res, err := m.Test(context.Background(), &TestParams{Target: pwHop(srv, "alice", "pw", nil)})
	if err != nil {
		t.Fatal(err)
	}
	if res.OK || res.Stage != "host_key" || res.HostKey == nil || res.HostKey.Status != "unknown" {
		t.Fatalf("unknown: %+v", res)
	}
	if len(srv.AuthAttempts()) != 0 {
		t.Fatal("auth attempted during test with unknown key")
	}
	res, _ = m.Test(context.Background(), &TestParams{Target: pwHop(srv, "alice", "pw", trustedFor(srv))})
	if !res.OK || res.Stage != "done" {
		t.Fatalf("trusted: %+v", res)
	}
	res, _ = m.Test(context.Background(), &TestParams{Target: pwHop(srv, "alice", "bad", trustedFor(srv))})
	if res.OK || res.Stage != "auth" {
		t.Fatalf("bad pw: %+v", res)
	}
	res, _ = m.Test(context.Background(), &TestParams{Target: Hop{Host: "127.0.0.1", Port: 1, Username: "a", Auth: Auth{Method: "password"}}})
	if res.OK || res.Stage != "connect" {
		t.Fatalf("closed port: %+v", res)
	}
}

func TestValidationRejectsInjection(t *testing.T) {
	m := NewManager(testConfig())
	for _, h := range []Hop{
		{Host: "-oProxyCommand=x", Port: 22, Username: "a", Auth: Auth{Method: "password"}},
		{Host: "a;b", Port: 22, Username: "a", Auth: Auth{Method: "password"}},
		{Host: "$(id)", Port: 22, Username: "a", Auth: Auth{Method: "password"}},
		{Host: "ok.example", Port: 22, Username: "-oProxyCommand=x", Auth: Auth{Method: "password"}},
		{Host: "ok.example", Port: 0, Username: "a", Auth: Auth{Method: "password"}},
		{Host: "ok.example", Port: 22, Username: "a", Auth: Auth{Method: "gssapi"}},
		{Host: "ok.example", Port: 22, Username: "a", Auth: Auth{Method: "password"}, TrustedHostKeys: []HostKey{{KeyType: "ssh-ed25519", PublicKey: "!!"}}},
	} {
		err := m.Connect(owner, func(string, any) {}, &ConnectParams{ConnID: "x", Target: h, Cols: 80, Rows: 24})
		if ipc.AsError(err).Code != ipc.CodeBadRequest {
			t.Errorf("hop %+v: err %v", h, err)
		}
	}
}
