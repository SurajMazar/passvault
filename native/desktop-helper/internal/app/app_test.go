package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/passvault/desktop-helper/internal/ipc"
	"github.com/passvault/desktop-helper/internal/logx"
	"github.com/passvault/desktop-helper/internal/neutralino"
	"github.com/passvault/desktop-helper/internal/sshconn"
	"github.com/passvault/desktop-helper/internal/sshkeys"
	"github.com/passvault/desktop-helper/internal/term"
	"github.com/passvault/desktop-helper/internal/testutil/sshtest"
)

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type harness struct {
	t        *testing.T
	a        *App
	tr       *neutralino.TestTransport
	ch       chan neutralino.Message
	backlog  []neutralino.Message
	log      *syncBuf
	sid      string
	n        int
	launched [][]string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	tr := neutralino.NewTestTransport()
	h := &harness{t: t, tr: tr, ch: tr.Subscribe(), log: &syncBuf{}}
	agentBase, err := os.MkdirTemp("", "pvapp")
	if err != nil {
		t.Fatal(err)
	}
	termBase, _ := os.MkdirTemp("", "pvterm")
	t.Cleanup(func() { os.RemoveAll(agentBase); os.RemoveAll(termBase) })
	cfg := sshconn.DefaultConfig()
	cfg.HostKeyTimeout = 3 * time.Second
	cfg.PromptTimeout = 3 * time.Second
	h.a = New(tr, Config{
		Version:  "test",
		AgentDir: filepath.Join(agentBase, "agent"),
		SSH:      cfg,
		Opener: &term.Opener{
			Launch:       func(argv []string) error { h.launched = append(h.launched, argv); return nil },
			TempBase:     termBase,
			CleanupAfter: time.Hour,
		},
		Log: logx.New(h.log),
	})
	t.Cleanup(h.a.Shutdown)
	return h
}

func (h *harness) next(what string, pred func(neutralino.Message) bool) neutralino.Message {
	h.t.Helper()
	for i, m := range h.backlog {
		if pred(m) {
			h.backlog = append(h.backlog[:i], h.backlog[i+1:]...)
			return m
		}
	}
	timeout := time.After(30 * time.Second)
	for {
		select {
		case m := <-h.ch:
			if pred(m) {
				return m
			}
			h.backlog = append(h.backlog, m)
		case <-timeout:
			h.t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func (h *harness) raw(b []byte, id string) map[string]any {
	h.t.Helper()
	h.a.D.Handle(b)
	return h.next("response "+id, func(m neutralino.Message) bool {
		return m.Event == ipc.EventResponse && m.Data["id"] == id
	}).Data
}

func (h *harness) call(op string, params any, sid string) map[string]any {
	h.t.Helper()
	h.n++
	id := fmt.Sprintf("r%d", h.n)
	req := map[string]any{"v": 1, "id": id, "op": op, "params": params}
	if sid != "" {
		req["sessionId"] = sid
	}
	b, _ := json.Marshal(req)
	return h.raw(b, id)
}

func (h *harness) ok(op string, params any) map[string]any {
	h.t.Helper()
	r := h.call(op, params, h.sid)
	if r["ok"] != true {
		h.t.Fatalf("%s failed: %v", op, r["error"])
	}
	res, _ := r["result"].(map[string]any)
	return res
}

func errCode(r map[string]any) string {
	e, _ := r["error"].(map[string]any)
	s, _ := e["code"].(string)
	return s
}

func (h *harness) hello() string {
	h.t.Helper()
	r := h.call("hello", map[string]any{"clientVersion": "1.0"}, "")
	res := r["result"].(map[string]any)
	h.sid = res["sessionId"].(string)
	return h.sid
}

func (h *harness) event(typ string, pred func(map[string]any) bool) map[string]any {
	h.t.Helper()
	return h.next("event "+typ, func(m neutralino.Message) bool {
		if m.Event != ipc.EventEvent || m.Data["type"] != typ {
			return false
		}
		d, _ := m.Data["data"].(map[string]any)
		return pred == nil || pred(d)
	}).Data
}

func stateIs(s string) func(map[string]any) bool {
	return func(d map[string]any) bool { return d["state"] == s }
}

func hostKeys(s *sshtest.Server) []map[string]string {
	kt, b := s.HostKeyB64()
	return []map[string]string{{"keyType": kt, "publicKey": b}}
}

func connectParams(id string, s *sshtest.Server, user, pw string) map[string]any {
	return map[string]any{
		"connId": id, "label": "test", "cols": 80, "rows": 24,
		"target": map[string]any{
			"host": s.Host, "port": s.Port, "username": user,
			"auth":            map[string]any{"method": "password", "password": pw},
			"trustedHostKeys": hostKeys(s),
		},
	}
}

func TestHelloCapabilities(t *testing.T) {
	h := newHarness(t)
	r := h.call("hello", map[string]any{"clientVersion": "1"}, "")
	res := r["result"].(map[string]any)
	if len(res["sessionId"].(string)) != 32 {
		t.Fatalf("session id %v", res["sessionId"])
	}
	caps := res["capabilities"].(map[string]any)
	bio := caps["biometrics"].(map[string]any)
	if _, ok := bio["available"].(bool); !ok {
		t.Fatalf("caps %v", caps)
	}
	if bio["available"] == false && bio["reason"] == "" {
		t.Fatal("biometrics unavailable without a reason")
	}
}

func TestUnknownOpAndFields(t *testing.T) {
	h := newHarness(t)
	h.hello()
	if c := errCode(h.call("shell.exec", map[string]any{"cmd": "id"}, h.sid)); c != ipc.CodeUnknownOp {
		t.Errorf("unknown op: %q", c)
	}
	if c := errCode(h.call("ping", map[string]any{"extra": 1}, h.sid)); c != ipc.CodeBadRequest {
		t.Errorf("unknown param field: %q", c)
	}
	p := connectParams("c1", sshtest.Start(t, sshtest.Options{User: "u", Password: "p"}), "u", "p")
	p["target"].(map[string]any)["auth"].(map[string]any)["command"] = "id"
	if c := errCode(h.call("ssh.connect", p, h.sid)); c != ipc.CodeBadRequest {
		t.Errorf("nested unknown field: %q", c)
	}
	if c := errCode(h.raw([]byte(`{"v":1,"id":"e1","op":"ping","params":{},"sessionId":"`+h.sid+`","exec":"x"}`), "e1")); c != ipc.CodeBadRequest {
		t.Errorf("unknown envelope field: %q", c)
	}
	if c := errCode(h.raw([]byte(`{"v":2,"id":"e2","op":"ping","params":{},"sessionId":"`+h.sid+`"}`), "e2")); c != ipc.CodeBadRequest {
		t.Errorf("bad version: %q", c)
	}
	if c := errCode(h.raw([]byte(`{"v":1,"id":"e3","op":"ping","params":[],"sessionId":"`+h.sid+`"}`), "e3")); c != ipc.CodeBadRequest {
		t.Errorf("array params: %q", c)
	}
	if c := errCode(h.raw([]byte(`not json`), "")); c != ipc.CodeBadRequest {
		t.Errorf("garbage: %q", c)
	}
}

func TestSessionBinding(t *testing.T) {
	h := newHarness(t)
	if c := errCode(h.call("ping", map[string]any{}, "")); c != ipc.CodeInvalidSession {
		t.Errorf("before hello: %q", c)
	}
	s1 := h.hello()
	if c := errCode(h.call("ping", map[string]any{}, "")); c != ipc.CodeInvalidSession {
		t.Errorf("missing sessionId: %q", c)
	}
	if c := errCode(h.call("ping", map[string]any{}, strings.Repeat("0", 32))); c != ipc.CodeInvalidSession {
		t.Errorf("foreign sessionId: %q", c)
	}
	if r := h.call("ping", map[string]any{}, s1); r["ok"] != true {
		t.Errorf("valid session: %v", r)
	}
	s2 := h.hello()
	if s1 == s2 {
		t.Fatal("session id reused")
	}
	if c := errCode(h.call("ping", map[string]any{}, s1)); c != ipc.CodeInvalidSession {
		t.Errorf("stale session: %q", c)
	}
}

func TestSecondHelloTearsDownConnections(t *testing.T) {
	h := newHarness(t)
	srv := sshtest.Start(t, sshtest.Options{User: "alice", Password: "dummy-pw"})
	s1 := h.hello()
	h.ok("ssh.connect", connectParams("c1", srv, "alice", "dummy-pw"))
	h.event("ssh.state", stateIs("connected"))
	done := h.a.SSH.Done("c1")
	s2 := h.hello()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("old session's connection not torn down")
	}
	if h.a.SSH.Count() != 0 {
		t.Fatal("connections remain")
	}
	// The old connection cannot be addressed from the new session.
	if c := errCode(h.call("ssh.write", map[string]any{"connId": "c1", "dataB64": "eA=="}, s2)); c != ipc.CodeNotFound {
		t.Errorf("write to old conn: %q", c)
	}
	time.Sleep(100 * time.Millisecond)
	for _, m := range h.tr.All() {
		if m.Event == ipc.EventEvent && m.Data["sessionId"] != s1 && m.Data["sessionId"] != s2 {
			t.Fatalf("event with unknown session: %v", m.Data)
		}
	}
}

func TestInvalidHostsAndUsernamesRejected(t *testing.T) {
	h := newHarness(t)
	h.hello()
	srv := sshtest.Start(t, sshtest.Options{User: "u", Password: "p"})
	for _, bad := range []struct{ host, user string }{
		{"-oProxyCommand=x", "u"}, {"a;b", "u"}, {"$(id)", "u"}, {"h`id`", "u"},
		{"example.com", "-oProxyCommand=x"}, {"example.com", "a;b"}, {"example.com", "$(id)"}, {"example.com", ""},
	} {
		p := connectParams("c1", srv, bad.user, "p")
		tg := p["target"].(map[string]any)
		tg["host"], tg["username"] = bad.host, bad.user
		if c := errCode(h.call("ssh.connect", p, h.sid)); c != ipc.CodeBadRequest {
			t.Errorf("connect %v: %q", bad, c)
		}
		if c := errCode(h.call("ssh.test", map[string]any{"target": tg}, h.sid)); c != ipc.CodeBadRequest {
			t.Errorf("test %v: %q", bad, c)
		}
		tp := map[string]any{"app": "terminal", "target": map[string]any{"host": bad.host, "port": 22, "username": bad.user}, "trustedHostKeys": hostKeys(srv), "useAgent": false}
		if c := errCode(h.call("term.openExternal", tp, h.sid)); c != ipc.CodeBadRequest {
			t.Errorf("term %v: %q", bad, c)
		}
	}
	p := connectParams("bad id;", srv, "u", "p")
	if c := errCode(h.call("ssh.connect", p, h.sid)); c != ipc.CodeBadRequest {
		t.Errorf("bad connId: %q", c)
	}
	if len(h.launched) != 0 {
		t.Fatal("terminal launched")
	}
}

func TestOversizeRejected(t *testing.T) {
	h := newHarness(t)
	h.hello()
	big := bytes.Repeat([]byte("A"), ipc.MaxRequestBytes+1)
	r := h.raw(big, "")
	if errCode(r) != ipc.CodeBadRequest {
		t.Fatalf("oversize: %v", r)
	}
	// Field-level limits too.
	if c := errCode(h.call("ssh.write", map[string]any{"connId": "x", "dataB64": strings.Repeat("A", 200000)}, h.sid)); c != ipc.CodeBadRequest {
		t.Errorf("oversize write: %q", c)
	}
}

func TestVaultLockedClosesEverything(t *testing.T) {
	h := newHarness(t)
	h.hello()
	srv := sshtest.Start(t, sshtest.Options{User: "alice", Password: "pw"})
	h.ok("ssh.connect", connectParams("c1", srv, "alice", "pw"))
	h.event("ssh.state", stateIs("connected"))
	h.ok("agent.start", map[string]any{})
	g, _ := sshkeys.Generate("ed25519", "", "")
	h.ok("agent.addKey", map[string]any{"keyId": "k1", "name": "k", "privateKey": g.PrivateKey})
	res := h.ok("vault.locked", map[string]any{})
	if res["closedConnections"].(float64) != 1 || res["agentKeysRemoved"].(float64) != 1 {
		t.Fatalf("vault.locked %v", res)
	}
	h.event("ssh.state", stateIs("closed"))
	st := h.ok("agent.status", map[string]any{})
	if st["locked"] != true || len(st["keys"].([]any)) != 0 || st["running"] != true {
		t.Fatalf("agent.status %v", st)
	}
	if h.a.SSH.Count() != 0 {
		t.Fatal("connections remain")
	}
}

func TestAgentSignFlowOverIPC(t *testing.T) {
	h := newHarness(t)
	h.hello()
	res := h.ok("agent.start", map[string]any{})
	sock := res["socketPath"].(string)
	g, _ := sshkeys.Generate("ed25519", "", "")
	h.ok("agent.addKey", map[string]any{"keyId": "k1", "name": "Deploy", "privateKey": g.PrivateKey})
	pub, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(g.PublicKey))
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ac := agent.NewClient(c)
	errc := make(chan error, 1)
	go func() { _, err := ac.Sign(pub, []byte("x")); errc <- err }()
	ev := h.event("agent.signRequest", nil)
	d := ev["data"].(map[string]any)
	if d["keyName"] != "Deploy" || d["destination"].(map[string]any)["verified"] != false {
		t.Fatalf("event %v", d)
	}
	h.ok("agent.signDecision", map[string]any{"requestId": d["requestId"], "decision": "once"})
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
}

func TestLogsContainNoSecrets(t *testing.T) {
	h := newHarness(t)
	const (
		password   = "S3cr3t-Passw0rd-dummy"
		passphrase = "dummy-passphrase-xyzzy"
		otp        = "918273"
		kiPw       = "ki-dummy-secret"
		exportBody = "EXPORT-BODY-dummy-secret"
		kcSecret   = "keychain-dummy-secret"
		typed      = "typed-into-terminal-dummy"
	)
	srv := sshtest.Start(t, sshtest.Options{User: "alice", Password: password})
	kiSrv := sshtest.Start(t, sshtest.Options{User: "alice", KI: []sshtest.KIRound{
		{Questions: []string{"Password: "}, Echos: []bool{false}, Expect: []string{kiPw}},
		{Questions: []string{"OTP: "}, Echos: []bool{true}, Expect: []string{otp}},
	}})
	h.hello()

	// Password session + terminal input.
	h.ok("ssh.connect", connectParams("c1", srv, "alice", password))
	h.event("ssh.state", stateIs("connected"))
	h.ok("ssh.write", map[string]any{"connId": "c1", "dataB64": base64.StdEncoding.EncodeToString([]byte(typed + "\n"))})
	h.ok("ssh.test", map[string]any{"target": connectParams("x", srv, "alice", password)["target"]})
	h.call("ssh.test", map[string]any{"target": connectParams("x", srv, "alice", "wrong-"+password)["target"]}, h.sid)

	// Keyboard-interactive with OTP.
	kp := connectParams("c2", kiSrv, "alice", "")
	kp["target"].(map[string]any)["auth"] = map[string]any{"method": "keyboard_interactive"}
	h.ok("ssh.connect", kp)
	for _, ans := range []string{kiPw, otp} {
		ev := h.event("ssh.prompt", nil)
		pid := ev["data"].(map[string]any)["promptId"]
		h.ok("ssh.promptResponse", map[string]any{"connId": "c2", "promptId": pid, "answers": []string{ans}})
	}
	h.event("ssh.state", func(d map[string]any) bool { return d["connId"] == "c2" && d["state"] == "connected" })

	// Keys.
	gen := h.ok("ssh.keygen", map[string]any{"algorithm": "ed25519", "comment": "c", "passphrase": passphrase})
	priv := gen["privateKey"].(string)
	h.ok("ssh.inspectKey", map[string]any{"privateKey": priv, "passphrase": passphrase})
	h.call("ssh.inspectKey", map[string]any{"privateKey": priv, "passphrase": "wrong-" + passphrase}, h.sid)
	h.ok("agent.addKey", map[string]any{"keyId": "k1", "name": "n", "privateKey": priv, "passphrase": passphrase})

	// Files.
	exp := filepath.Join(t.TempDir(), "export.json")
	h.ok("fs.writeExport", map[string]any{"path": exp, "contentB64": base64.StdEncoding.EncodeToString([]byte(exportBody)), "overwrite": false})
	h.ok("fs.readImport", map[string]any{"path": exp, "maxBytes": 1000})

	// Failing requests carrying secrets.
	h.call("keychain.set", map[string]any{"account": "INVALID", "secretB64": base64.StdEncoding.EncodeToString([]byte(kcSecret)), "biometric": false}, h.sid)
	h.call("ping", map[string]any{"password": password}, h.sid)
	h.call("ssh.connect", map[string]any{"connId": "c9", "target": map[string]any{"host": "-o" + password}}, h.sid)
	h.call(password, map[string]any{}, h.sid)
	h.ok("vault.locked", map[string]any{})

	logs := h.log.String()
	if !strings.Contains(logs, "op=ssh.connect") || !strings.Contains(logs, "op=fs.writeExport") {
		t.Fatalf("expected op names in log:\n%s", logs)
	}
	privBody := strings.Split(priv, "\n")[1]
	for _, s := range []string{password, passphrase, otp, kiPw, exportBody, kcSecret, typed, privBody,
		base64.StdEncoding.EncodeToString([]byte(exportBody)), base64.StdEncoding.EncodeToString([]byte(kcSecret)),
		base64.StdEncoding.EncodeToString([]byte(typed + "\n"))} {
		if strings.Contains(logs, s) {
			t.Fatalf("log contains secret %q:\n%s", s, logs)
		}
	}
}
