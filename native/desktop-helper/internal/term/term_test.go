package term

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/passvault/desktop-helper/internal/ipc"
	"github.com/passvault/desktop-helper/internal/sshconn"
	"github.com/passvault/desktop-helper/internal/testutil/sshtest"
)

func hk(t *testing.T) sshconn.HostKey {
	pk := sshtest.NewHostKey(t).PublicKey()
	return sshconn.HostKey{KeyType: pk.Type(), PublicKey: base64.StdEncoding.EncodeToString(pk.Marshal())}
}

type capture struct{ argv [][]string }

func (c *capture) launch(a []string) error { c.argv = append(c.argv, a); return nil }

func opener(t *testing.T, c *capture, sock string) *Opener {
	base, err := os.MkdirTemp("", "pvt")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(base) })
	return &Opener{
		Launch:       c.launch,
		AgentSocket:  func() (string, bool) { return sock, sock != "" },
		TempBase:     base,
		CleanupAfter: time.Hour,
	}
}

// Every line of the script must be fixed text plus single-quoted args.
var scriptLineRE = regexp.MustCompile(`^(#!/bin/sh|# .*|: > '[^']*'|('[^']*' ?)+|rc=\$\?|/bin/rm -rf -- '[^']*'|exit \$rc)$`)

func TestScriptOnlyQuotedArgsNoSecrets(t *testing.T) {
	const secretPw = "dummy-password-should-never-appear"
	const secretKey = "-----BEGIN OPENSSH PRIVATE KEY-----dummy"
	c := &capture{}
	sock := "/Users/someone/Library/Application Support/PassVault/agent/agent.sock"
	o := opener(t, c, sock)
	jump := sshconn.HopPublic{Host: "bastion.example.com", Port: 2222, Username: "jumper"}
	p, err := o.Open(&Params{
		App:                 "terminal",
		Target:              sshconn.HopPublic{Host: "db.internal", Port: 22, Username: "deploy"},
		Jump:                &jump,
		TrustedHostKeys:     []sshconn.HostKey{hk(t)},
		JumpTrustedHostKeys: []sshconn.HostKey{hk(t)},
		UseAgent:            true,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(p.Script), "\n") {
		if !scriptLineRE.MatchString(line) {
			t.Errorf("unexpected script line: %q", line)
		}
	}
	for _, want := range []string{"'-o' 'StrictHostKeyChecking=yes'", "'-o' 'ForwardAgent=no'", "'-J' 'jumper@bastion.example.com:2222'", "'-l' 'deploy' '--' 'db.internal'", "'-p' '22'", "'-F'"} {
		if !strings.Contains(p.Script, want) {
			t.Errorf("script missing %s", want)
		}
	}
	if len(c.argv) != 1 || strings.Join(c.argv[0][:3], " ") != "/usr/bin/open -a Terminal" || !strings.HasSuffix(c.argv[0][3], ".command") {
		t.Fatalf("argv %v", c.argv)
	}
	all := p.Script + p.Config + p.KnownHosts + strings.Join(c.argv[0], " ")
	for _, s := range []string{secretPw, secretKey, "PRIVATE KEY", "password"} {
		if strings.Contains(all, s) {
			t.Fatalf("generated files contain %q", s)
		}
	}
	// File modes.
	for name, mode := range map[string]os.FileMode{"pv-ssh.command": 0o700, "known_hosts": 0o600, "ssh_config": 0o600} {
		fi, err := os.Stat(filepath.Join(p.Dir, name))
		if err != nil || fi.Mode().Perm() != mode {
			t.Errorf("%s mode %v err %v", name, fi.Mode(), err)
		}
	}
	if fi, _ := os.Stat(p.Dir); fi.Mode().Perm() != 0o700 {
		t.Error("dir not 0700")
	}
	if !strings.Contains(p.KnownHosts, "db.internal ssh-ed25519 ") || !strings.Contains(p.KnownHosts, "[bastion.example.com]:2222 ssh-ed25519 ") {
		t.Fatalf("known_hosts:\n%s", p.KnownHosts)
	}

	// Let OpenSSH itself evaluate the options (-G prints the resolved
	// configuration and exits without connecting or reading ~/.ssh/config).
	if _, err := os.Stat("/usr/bin/ssh"); err == nil {
		args := []string{"-G"}
		re := regexp.MustCompile(`'((?:[^']|'\\'')*)'`)
		m := re.FindAllStringSubmatch(strings.Split(p.Script, "\n")[3], -1)
		for _, a := range m[1:] { // skip /usr/bin/ssh
			args = append(args, a[1])
		}
		out, err := exec.Command("/usr/bin/ssh", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("ssh -G: %v\n%s", err, out)
		}
		g := string(out)
		for _, want := range []string{"stricthostkeychecking true", "forwardagent no", "proxyjump jumper@bastion.example.com:2222", "user deploy", "hostname db.internal", "globalknownhostsfile /dev/null", "userknownhostsfile " + filepath.Join(p.Dir, "known_hosts"), "identityagent " + sock} {
			if !strings.Contains(g, want+"\n") {
				t.Errorf("ssh -G missing %q", want)
			}
		}
	}
}

func TestRefusesWithoutTrustedKeys(t *testing.T) {
	c := &capture{}
	o := opener(t, c, "")
	_, err := o.Open(&Params{App: "terminal", Target: sshconn.HopPublic{Host: "h", Port: 22, Username: "u"}})
	if ipc.AsError(err).Code != ipc.CodeHostKeyUnknown {
		t.Fatalf("err %v", err)
	}
	jump := sshconn.HopPublic{Host: "j", Port: 22, Username: "u"}
	_, err = o.Open(&Params{App: "iterm", Target: sshconn.HopPublic{Host: "h", Port: 22, Username: "u"}, Jump: &jump, TrustedHostKeys: []sshconn.HostKey{hk(t)}})
	if ipc.AsError(err).Code != ipc.CodeHostKeyUnknown {
		t.Fatalf("jump without keys: %v", err)
	}
	if len(c.argv) != 0 {
		t.Fatal("launched anyway")
	}
}

func TestRejectsInjection(t *testing.T) {
	c := &capture{}
	o := opener(t, c, "")
	for _, h := range []sshconn.HopPublic{
		{Host: "-oProxyCommand=x", Port: 22, Username: "u"},
		{Host: "a;b", Port: 22, Username: "u"},
		{Host: "$(id)", Port: 22, Username: "u"},
		{Host: "h", Port: 22, Username: "-oProxyCommand=x"},
		{Host: "h", Port: 22, Username: "u'x"},
		{Host: "h", Port: 70000, Username: "u"},
	} {
		_, err := o.Open(&Params{App: "terminal", Target: h, TrustedHostKeys: []sshconn.HostKey{hk(t)}})
		if ipc.AsError(err).Code != ipc.CodeBadRequest {
			t.Errorf("%+v: %v", h, err)
		}
	}
	if _, err := o.Open(&Params{App: "xterm; rm", Target: sshconn.HopPublic{Host: "h", Port: 22, Username: "u"}, TrustedHostKeys: []sshconn.HostKey{hk(t)}}); err == nil {
		t.Error("bad app accepted")
	}
	if _, err := o.Open(&Params{App: "terminal", Target: sshconn.HopPublic{Host: "h", Port: 22, Username: "u"}, TrustedHostKeys: []sshconn.HostKey{hk(t)}, UseAgent: true}); ipc.AsError(err).Code != ipc.CodeUnavailable {
		t.Error("useAgent without running agent accepted")
	}
	if len(c.argv) != 0 {
		t.Fatal("launched anyway")
	}
}

func TestCleanupWhenNeverStarted(t *testing.T) {
	c := &capture{}
	o := opener(t, c, "")
	o.CleanupAfter = 50 * time.Millisecond
	p, err := o.Open(&Params{App: "terminal", Target: sshconn.HopPublic{Host: "::1", Port: 2200, Username: "u"}, TrustedHostKeys: []sshconn.HostKey{hk(t)}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(p.KnownHosts, "[::1]:2200 ") {
		t.Fatalf("ipv6 known_hosts: %s", p.KnownHosts)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(p.Dir); os.IsNotExist(err) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("temp dir not cleaned up")
}
