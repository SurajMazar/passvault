package agentsrv

import (
	"crypto/rand"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"github.com/passvault/desktop-helper/internal/sshkeys"
	"github.com/passvault/desktop-helper/internal/testutil/sshtest"
)

// shortDir returns a temp dir short enough for a unix socket path.
func shortDir(t *testing.T) string {
	d, err := os.MkdirTemp("", "pva")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

type ui struct {
	reqs  chan SignRequest
	noUI  bool
	owner string
}

func newUI() *ui { return &ui{reqs: make(chan SignRequest, 10), owner: "sess"} }

func (u *ui) notifier() Notifier {
	return Notifier{
		Owner:  func() (any, bool) { return u.owner, !u.noUI },
		Notify: func(_ any, r SignRequest) bool { u.reqs <- r; return true },
	}
}

func (u *ui) next(t *testing.T) SignRequest {
	t.Helper()
	select {
	case r := <-u.reqs:
		return r
	case <-time.After(5 * time.Second):
		t.Fatal("no sign request")
	}
	return SignRequest{}
}

func startAgent(t *testing.T, u *ui) (*Server, string) {
	t.Helper()
	s := New(u.notifier(), nil)
	dir := filepath.Join(shortDir(t), "agent")
	p, err := s.Start(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Stop)
	return s, p
}

func dialAgent(t *testing.T, path string) agent.ExtendedAgent {
	t.Helper()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return agent.NewClient(c)
}

func genKey(t *testing.T) (string, ssh.PublicKey) {
	g, err := sshkeys.Generate("ed25519", "dummy", "")
	if err != nil {
		t.Fatal(err)
	}
	pk, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(g.PublicKey))
	return g.PrivateKey, pk
}

func TestSocketPermissions(t *testing.T) {
	_, p := startAgent(t, newUI())
	fi, err := os.Stat(filepath.Dir(p))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %o", fi.Mode().Perm())
	}
	fi, err = os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&os.ModeSocket == 0 || fi.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode %v", fi.Mode())
	}
}

func TestStopRemovesSocketAndStaleSocketReplaced(t *testing.T) {
	u := newUI()
	s := New(u.notifier(), nil)
	dir := filepath.Join(shortDir(t), "agent")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "agent.sock")
	// Stale socket: bound but nobody listening.
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	l.SetUnlinkOnClose(false)
	l.Close()
	if _, err := s.Start(dir); err != nil {
		t.Fatalf("stale socket not replaced: %v", err)
	}
	// A second agent must refuse while the first is listening.
	s2 := New(u.notifier(), nil)
	if _, err := s2.Start(dir); err == nil {
		t.Fatal("second agent started on a live socket")
	}
	s.Stop()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatal("socket not removed on stop")
	}
}

func TestRefusesSymlinkDirAndRegularFile(t *testing.T) {
	base := shortDir(t)
	real := filepath.Join(base, "real")
	os.Mkdir(real, 0o700)
	link := filepath.Join(base, "agent")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := New(Notifier{}, nil).Start(link); err == nil {
		t.Fatal("started in symlinked dir")
	}
	dir := filepath.Join(base, "agent2")
	os.Mkdir(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "agent.sock"), []byte("x"), 0o600)
	if _, err := New(Notifier{}, nil).Start(dir); err == nil {
		t.Fatal("removed a regular file at the socket path")
	}
	if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o700 {
		t.Fatal("dir perms not tightened")
	}
}

func TestListOnlyWhenUnlocked(t *testing.T) {
	s, p := startAgent(t, newUI())
	c := dialAgent(t, p)
	if keys, err := c.List(); err != nil || len(keys) != 0 {
		t.Fatalf("locked list: %v %v", keys, err)
	}
	priv, pub := genKey(t)
	if _, err := s.AddKey("k1", "Deploy key", priv, ""); err != nil {
		t.Fatal(err)
	}
	keys, err := c.List()
	if err != nil || len(keys) != 1 || keys[0].Comment != "Deploy key" || string(keys[0].Blob) != string(pub.Marshal()) {
		t.Fatalf("list: %v %v", keys, err)
	}
	if n := s.Lock(); n != 1 {
		t.Fatalf("removed %d", n)
	}
	if keys, _ := c.List(); len(keys) != 0 {
		t.Fatal("keys listed after lock")
	}
	if _, _, _, ks := s.Status(); len(ks) != 0 {
		t.Fatal("keys remain after lock")
	}
}

func TestSignApprovalDenyOnceTimed(t *testing.T) {
	u := newUI()
	s, p := startAgent(t, u)
	priv, pub := genKey(t)
	s.AddKey("k1", "Deploy key", priv, "")
	c := dialAgent(t, p)
	data := []byte("data-to-sign")

	errc := make(chan error, 1)
	sign := func() { _, err := c.Sign(pub, data); errc <- err }

	go sign()
	r := u.next(t)
	if r.KeyID != "k1" || r.Fingerprint != ssh.FingerprintSHA256(pub) || r.Destination.Verified || r.Forwarded {
		t.Fatalf("request %+v", r)
	}
	if runtime.GOOS == "darwin" && r.Client.PID != os.Getpid() {
		t.Fatalf("peer pid %d want %d", r.Client.PID, os.Getpid())
	}
	if err := s.Decide("other-session", r.RequestID, "once", 0); err == nil {
		t.Fatal("decision from foreign session accepted")
	}
	s.Decide("sess", r.RequestID, "deny", 0)
	if err := <-errc; err == nil {
		t.Fatal("denied signature succeeded")
	}

	go sign()
	r = u.next(t)
	s.Decide("sess", r.RequestID, "once", 0)
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
	// "once" does not persist.
	go sign()
	r = u.next(t)
	if err := s.Decide("sess", r.RequestID, "timed", 61); err == nil {
		t.Fatal("timed > 60 accepted")
	}
	s.Decide("sess", r.RequestID, "timed", 5)
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
	// Timed grant: no prompt.
	sig, err := c.Sign(pub, data)
	if err != nil {
		t.Fatal(err)
	}
	if err := pub.Verify(data, sig); err != nil {
		t.Fatal(err)
	}
	select {
	case <-u.reqs:
		t.Fatal("prompted during timed grant")
	default:
	}
	// Lock revokes grants and keys.
	s.Lock()
	if _, err := c.Sign(pub, data); err == nil {
		t.Fatal("signed after lock")
	}
	// Re-adding a key does not restore the grant.
	s.AddKey("k1", "Deploy key", priv, "")
	go sign()
	r = u.next(t)
	s.Decide("sess", r.RequestID, "deny", 0)
	<-errc
}

func TestSignTimeoutDenies(t *testing.T) {
	u := newUI()
	s, p := startAgent(t, u)
	s.SetDecisionTimeout(200 * time.Millisecond)
	priv, pub := genKey(t)
	s.AddKey("k1", "k", priv, "")
	c := dialAgent(t, p)
	if _, err := c.Sign(pub, []byte("x")); err == nil {
		t.Fatal("timeout did not deny")
	}
	u.noUI = true
	if _, err := c.Sign(pub, []byte("x")); err == nil {
		t.Fatal("signed without a UI session")
	}
}

func TestLockDeniesPending(t *testing.T) {
	u := newUI()
	s, p := startAgent(t, u)
	priv, pub := genKey(t)
	s.AddKey("k1", "k", priv, "")
	c := dialAgent(t, p)
	errc := make(chan error, 1)
	go func() { _, err := c.Sign(pub, []byte("x")); errc <- err }()
	u.next(t)
	s.Lock()
	if err := <-errc; err == nil {
		t.Fatal("pending request survived lock")
	}
}

func TestMutationsRefused(t *testing.T) {
	s, p := startAgent(t, newUI())
	priv, pub := genKey(t)
	s.AddKey("k1", "k", priv, "")
	c := dialAgent(t, p)
	raw, _ := sshkeys.ParseRaw(priv, "")
	if err := c.Add(agent.AddedKey{PrivateKey: raw}); err == nil {
		t.Error("Add accepted")
	}
	if err := c.Remove(pub); err == nil {
		t.Error("Remove accepted")
	}
	if err := c.RemoveAll(); err == nil {
		t.Error("RemoveAll accepted")
	}
	if err := c.Lock([]byte("x")); err == nil {
		t.Error("Lock accepted")
	}
	if err := c.Unlock([]byte("x")); err == nil {
		t.Error("Unlock accepted")
	}
	if keys, _ := c.List(); len(keys) != 1 {
		t.Error("key set changed")
	}
}

func sessionBind(t *testing.T, host ssh.Signer, sid []byte, fwd bool) []byte {
	sig, err := host.Sign(rand.Reader, sid)
	if err != nil {
		t.Fatal(err)
	}
	return ssh.Marshal(struct {
		HostKey    []byte
		SessionID  []byte
		Signature  []byte
		Forwarding bool
	}{host.PublicKey().Marshal(), sid, ssh.Marshal(sig), fwd})
}

func userauthData(sid []byte) []byte {
	return ssh.Marshal(struct {
		SessionID []byte
		Type      byte
		User      string
	}{sid, 50, "alice"})
}

func TestSessionBind(t *testing.T) {
	u := newUI()
	s, p := startAgent(t, u)
	priv, pub := genKey(t)
	s.AddKey("k1", "k", priv, "")
	host := sshtest.NewHostKey(t)
	sid := []byte("0123456789abcdef0123456789abcdef")

	// Verified, non-forwarded bind.
	c := dialAgent(t, p)
	if _, err := c.Extension("session-bind@openssh.com", sessionBind(t, host, sid, false)); err != nil {
		t.Fatal(err)
	}
	errc := make(chan error, 1)
	go func() { _, err := c.Sign(pub, userauthData(sid)); errc <- err }()
	r := u.next(t)
	if !r.Destination.Verified || r.Destination.HostKeyFingerprint != ssh.FingerprintSHA256(host.PublicKey()) || r.Forwarded {
		t.Fatalf("destination %+v", r.Destination)
	}
	s.Decide("sess", r.RequestID, "once", 0)
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
	// Signing for a different session on a bound connection is refused.
	if _, err := c.Sign(pub, userauthData([]byte("other-session-id"))); err == nil {
		t.Fatal("signed for unbound session")
	}

	// Bad bind signature rejected.
	c2 := dialAgent(t, p)
	bad := sessionBind(t, sshtest.NewHostKey(t), sid, false)
	var sb struct {
		HostKey, SessionID, Signature []byte
		Forwarding                    bool
	}
	ssh.Unmarshal(bad, &sb)
	sb.HostKey = host.PublicKey().Marshal()
	if _, err := c2.Extension("session-bind@openssh.com", ssh.Marshal(sb)); err == nil {
		t.Fatal("unverifiable bind accepted")
	}

	// Forwarded bind: denied without prompting.
	c3 := dialAgent(t, p)
	if _, err := c3.Extension("session-bind@openssh.com", sessionBind(t, host, sid, true)); err != nil {
		t.Fatal(err)
	}
	if _, err := c3.Sign(pub, userauthData(sid)); err == nil {
		t.Fatal("forwarded request signed")
	}
	select {
	case <-u.reqs:
		t.Fatal("forwarded request prompted")
	default:
	}
}

func TestRealSSHAuthThroughAgent(t *testing.T) {
	u := newUI()
	s, p := startAgent(t, u)
	priv, pub := genKey(t)
	s.AddKey("k1", "k", priv, "")
	srv := sshtest.Start(t, sshtest.Options{User: "alice", AuthorizedKeys: []ssh.PublicKey{pub}})
	go func() {
		r := u.next(t)
		s.Decide("sess", r.RequestID, "once", 0)
	}()
	ac := dialAgent(t, p)
	cfg := &ssh.ClientConfig{
		User:            "alice",
		Auth:            []ssh.AuthMethod{ssh.PublicKeysCallback(ac.Signers)},
		HostKeyCallback: ssh.FixedHostKey(srv.HostKey.PublicKey()),
		Timeout:         5 * time.Second,
	}
	cl, err := ssh.Dial("tcp", srv.Addr, cfg)
	if err != nil {
		t.Fatal(err)
	}
	cl.Close()
}
