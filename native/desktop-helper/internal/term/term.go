// Package term opens an SSH session in Terminal.app or iTerm2.
//
// It writes a private temp directory (0700) containing:
//   - known_hosts built only from host keys the user verified in PassVault,
//   - ssh_config (passed with -F, so it also applies to the ProxyJump hop:
//     OpenSSH forwards -F to the jump ssh process but not -o options),
//   - a .command script (0700) whose only dynamic content is validated,
//     single-quoted arguments.
//
// No secret ever appears in the script, argv or environment: passwords are
// typed by the user into ssh's own prompt; keys come from the PassVault
// agent (useAgent) or the user's own setup. The only child process is
// /usr/bin/open, executed with an argv slice (no shell).
//
// Sessions launched this way are independent processes: locking the vault
// does not terminate them (the agent does stop signing).
package term

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/passvault/desktop-helper/internal/ipc"
	"github.com/passvault/desktop-helper/internal/sshconn"
	"github.com/passvault/desktop-helper/internal/validate"
)

// Params are the term.openExternal params.
type Params struct {
	App             string             `json:"app"`
	Target          sshconn.HopPublic  `json:"target"`
	Jump            *sshconn.HopPublic `json:"jump,omitempty"`
	TrustedHostKeys []sshconn.HostKey  `json:"trustedHostKeys"`
	// JumpTrustedHostKeys is required when Jump is set (contract addition:
	// a single list cannot say which hop a key belongs to).
	JumpTrustedHostKeys []sshconn.HostKey `json:"jumpTrustedHostKeys,omitempty"`
	UseAgent            bool              `json:"useAgent"`
}

// Launcher runs argv without a shell.
type Launcher func(argv []string) error

// DefaultLauncher executes /usr/bin/open with a minimal environment.
func DefaultLauncher(argv []string) error {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + os.Getenv("HOME"), "USER=" + os.Getenv("USER")}
	return cmd.Run()
}

// Opener builds and launches external sessions.
type Opener struct {
	Launch Launcher
	// AgentSocket returns the PassVault agent socket path if it is running.
	AgentSocket func() (string, bool)
	// TempBase is where per-connection dirs are created ("" = os.TempDir()).
	TempBase string
	// CleanupAfter removes the directory if the script never started.
	CleanupAfter time.Duration
}

// safePathRE: -F is inserted unquoted into the ProxyJump command by OpenSSH,
// so the temp path must be shell-inert.
var safePathRE = regexp.MustCompile(`^/[A-Za-z0-9/._-]+$`)

// ShellQuote single-quotes s for /bin/sh.
func ShellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func knownHostsPattern(h sshconn.HopPublic) string {
	if h.Port == 22 {
		return h.Host
	}
	return "[" + h.Host + "]:" + strconv.Itoa(h.Port)
}

func hostSpec(h sshconn.HopPublic) string {
	host := h.Host
	if validate.IsIPv6(host) {
		host = "[" + host + "]"
	}
	return h.Username + "@" + host + ":" + strconv.Itoa(h.Port)
}

func knownHostsLines(h sshconn.HopPublic, keys []ssh.PublicKey) string {
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(knownHostsPattern(h))
		b.WriteByte(' ')
		b.Write(ssh.MarshalAuthorizedKey(k)) // "type base64\n"
	}
	return b.String()
}

// Prepared is what Open produced (exposed for tests).
type Prepared struct {
	Dir, Script, KnownHosts, Config string
	Argv                            []string
}

// Open validates p, writes the files and launches the terminal.
func (o *Opener) Open(p *Params) (*Prepared, error) {
	appName := map[string]string{"terminal": "Terminal", "iterm": "iTerm"}[p.App]
	if appName == "" {
		return nil, ipc.Errf(ipc.CodeBadRequest, "app must be terminal or iterm")
	}
	if err := p.Target.ValidatePublic("target"); err != nil {
		return nil, ipc.Errf(ipc.CodeBadRequest, "%s", err.Error())
	}
	targetKeys, err := sshconn.ParseTrusted(p.TrustedHostKeys)
	if err != nil {
		return nil, ipc.Errf(ipc.CodeBadRequest, "trustedHostKeys: %s", err.Error())
	}
	if len(targetKeys) == 0 {
		return nil, ipc.Errf(ipc.CodeHostKeyUnknown, "verify the host in PassVault before opening an external terminal")
	}
	var jumpKeys []ssh.PublicKey
	if p.Jump != nil {
		if err := p.Jump.ValidatePublic("jump"); err != nil {
			return nil, ipc.Errf(ipc.CodeBadRequest, "%s", err.Error())
		}
		if jumpKeys, err = sshconn.ParseTrusted(p.JumpTrustedHostKeys); err != nil {
			return nil, ipc.Errf(ipc.CodeBadRequest, "jumpTrustedHostKeys: %s", err.Error())
		}
		if len(jumpKeys) == 0 {
			return nil, ipc.Errf(ipc.CodeHostKeyUnknown, "verify the jump host in PassVault before opening an external terminal")
		}
	} else if len(p.JumpTrustedHostKeys) > 0 {
		return nil, ipc.Errf(ipc.CodeBadRequest, "jumpTrustedHostKeys without jump")
	}
	agentSock := ""
	if p.UseAgent {
		s, ok := "", false
		if o.AgentSocket != nil {
			s, ok = o.AgentSocket()
		}
		if !ok {
			return nil, ipc.Errf(ipc.CodeUnavailable, "the PassVault SSH agent is not running")
		}
		if strings.ContainsAny(s, "\"%\n\r'\\") || !filepath.IsAbs(s) {
			return nil, ipc.Errf(ipc.CodeInternal, "unexpected agent socket path")
		}
		agentSock = s
	}

	base := o.TempBase
	if base == "" {
		base = os.TempDir()
	}
	dir, err := os.MkdirTemp(base, "pv-term-")
	if err != nil {
		return nil, ipc.Errf(ipc.CodeIOError, "could not create temp dir")
	}
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	fail := func(e error) (*Prepared, error) { os.RemoveAll(dir); return nil, e }
	if !safePathRE.MatchString(dir) {
		return fail(ipc.Errf(ipc.CodeInternal, "temp path contains unsupported characters"))
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fail(ipc.Errf(ipc.CodeIOError, "chmod temp dir"))
	}
	khPath := filepath.Join(dir, "known_hosts")
	cfgPath := filepath.Join(dir, "ssh_config")
	scriptPath := filepath.Join(dir, "pv-ssh.command")
	startedPath := filepath.Join(dir, "started")

	kh := knownHostsLines(p.Target, targetKeys)
	if p.Jump != nil {
		kh += knownHostsLines(*p.Jump, jumpKeys)
	}
	var cfg strings.Builder
	cfg.WriteString("# Generated by PassVault for one external session. Contains no secrets.\n")
	cfg.WriteString("Host *\n")
	fmt.Fprintf(&cfg, "  UserKnownHostsFile \"%s\"\n", khPath)
	cfg.WriteString("  GlobalKnownHostsFile /dev/null\n")
	cfg.WriteString("  StrictHostKeyChecking yes\n")
	cfg.WriteString("  UpdateHostKeys no\n")
	cfg.WriteString("  ForwardAgent no\n")
	cfg.WriteString("  ForwardX11 no\n")
	cfg.WriteString("  PermitLocalCommand no\n")
	if agentSock != "" {
		fmt.Fprintf(&cfg, "  IdentityAgent \"%s\"\n", agentSock)
	}

	sshArgv := []string{"/usr/bin/ssh", "-F", cfgPath,
		"-o", "UserKnownHostsFile=" + khPath,
		"-o", "StrictHostKeyChecking=yes",
		"-o", "ForwardAgent=no",
	}
	if agentSock != "" {
		// Double quotes: the socket path contains a space ("Application
		// Support") and -o values are tokenised like config lines.
		sshArgv = append(sshArgv, "-o", "IdentityAgent=\""+agentSock+"\"")
	}
	sshArgv = append(sshArgv, "-p", strconv.Itoa(p.Target.Port))
	if p.Jump != nil {
		sshArgv = append(sshArgv, "-J", hostSpec(*p.Jump))
	}
	sshArgv = append(sshArgv, "-l", p.Target.Username, "--", p.Target.Host)

	quoted := make([]string, len(sshArgv))
	for i, a := range sshArgv {
		quoted[i] = ShellQuote(a)
	}
	script := "#!/bin/sh\n" +
		"# Generated by PassVault. Contains no secrets.\n" +
		": > " + ShellQuote(startedPath) + "\n" +
		strings.Join(quoted, " ") + "\n" +
		"rc=$?\n" +
		"/bin/rm -rf -- " + ShellQuote(dir) + "\n" +
		"exit $rc\n"

	for _, f := range []struct {
		path, content string
		mode          os.FileMode
	}{{khPath, kh, 0o600}, {cfgPath, cfg.String(), 0o600}, {scriptPath, script, 0o700}} {
		if err := writeNew(f.path, f.content, f.mode); err != nil {
			return fail(ipc.Errf(ipc.CodeIOError, "could not write session files"))
		}
	}
	argv := []string{"/usr/bin/open", "-a", appName, scriptPath}
	launch := o.Launch
	if launch == nil {
		launch = DefaultLauncher
	}
	if err := launch(argv); err != nil {
		return fail(ipc.Errf(ipc.CodeUnavailable, "could not open %s", appName))
	}
	after := o.CleanupAfter
	if after == 0 {
		after = 2 * time.Minute
	}
	time.AfterFunc(after, func() {
		// The script deletes the dir when ssh exits; if it never started
		// (user cancelled), remove it here.
		if _, err := os.Lstat(startedPath); errors.Is(err, os.ErrNotExist) {
			os.RemoveAll(dir)
		}
	})
	return &Prepared{Dir: dir, Script: script, KnownHosts: kh, Config: cfg.String(), Argv: argv}, nil
}

func writeNew(path, content string, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if _, err := f.WriteString(content); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
