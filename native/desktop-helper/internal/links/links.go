// Package links opens web links in the user's default browser.
//
// This replaces Neutralino's os.open in the webview's native allowlist:
// on macOS os.open runs `open "<url>"` through /bin/sh, so any script that
// ever ran in the webview could turn it into a shell command (finding
// PV-SEC-002). Here the URL is validated (http/https with a host, no
// credentials, no whitespace or control characters) and handed to
// /usr/bin/open as a single argv element — no shell, no option parsing.
package links

import (
	"net/url"
	"os"
	"os/exec"
	"strings"
	"unicode"

	"github.com/passvault/desktop-helper/internal/ipc"
)

// MaxURLBytes bounds the accepted URL length.
const MaxURLBytes = 4096

// Launcher runs argv without a shell.
type Launcher func(argv []string) error

// DefaultLauncher executes /usr/bin/open with a minimal environment.
func DefaultLauncher(argv []string) error {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=" + os.Getenv("HOME"), "USER=" + os.Getenv("USER")}
	return cmd.Run()
}

// Validate returns the canonical form of raw if it may be opened.
func Validate(raw string) (string, error) {
	if raw == "" || len(raw) > MaxURLBytes {
		return "", ipc.Errf(ipc.CodeBadRequest, "url must be 1..%d bytes", MaxURLBytes)
	}
	for _, r := range raw {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return "", ipc.Errf(ipc.CodeBadRequest, "url contains whitespace or control characters")
		}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", ipc.Errf(ipc.CodeBadRequest, "invalid url")
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", ipc.Errf(ipc.CodeBadRequest, "only http and https links can be opened")
	}
	if u.Host == "" || u.Opaque != "" {
		return "", ipc.Errf(ipc.CodeBadRequest, "url needs a host")
	}
	if u.User != nil {
		return "", ipc.Errf(ipc.CodeBadRequest, "urls with credentials are not opened")
	}
	s := u.String()
	if !strings.HasPrefix(s, u.Scheme+"://") {
		return "", ipc.Errf(ipc.CodeBadRequest, "invalid url")
	}
	return s, nil
}

// Opener opens validated links.
type Opener struct {
	Launch Launcher
}

// Open validates raw and launches the default browser with it.
func (o *Opener) Open(raw string) error {
	s, err := Validate(raw)
	if err != nil {
		return err
	}
	launch := o.Launch
	if launch == nil {
		launch = DefaultLauncher
	}
	if err := launch([]string{"/usr/bin/open", s}); err != nil {
		return ipc.Errf(ipc.CodeInternal, "could not open the link")
	}
	return nil
}
