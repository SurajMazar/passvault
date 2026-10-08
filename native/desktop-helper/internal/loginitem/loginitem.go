// Package loginitem turns "open PassVault at login" on and off with a
// per-user LaunchAgent (~/Library/LaunchAgents/io.passvault.desktop.login.plist).
//
// The plist is fixed apart from the app bundle path, which is derived from
// this helper's own location (…/PassVault.app/Contents/MacOS/pv-helper) and
// validated; launchd runs `/usr/bin/open -g -a <bundle> --args --background`
// at login, so the app starts in the menu bar without taking focus. Nothing
// else is ever written or executed, and no administrator rights are needed.
package loginitem

import (
	"bytes"
	"encoding/xml"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/passvault/desktop-helper/internal/ipc"
)

// Label of the LaunchAgent.
const Label = "io.passvault.desktop.login"

// BackgroundArg tells the app it was opened at login (start in the menu bar).
const BackgroundArg = "--background"

// Manager writes and removes the LaunchAgent.
type Manager struct {
	// Dir overrides ~/Library/LaunchAgents (tests).
	Dir string
	// Executable overrides os.Executable (tests).
	Executable func() (string, error)
}

// Status of the login item.
type Status struct {
	Enabled bool `json:"enabled"`
	// Stale: the item points at another copy of PassVault (the app was moved).
	Stale bool   `json:"stale"`
	App   string `json:"app,omitempty"`
}

func (m *Manager) dir() (string, error) {
	if m.Dir != "" {
		return m.Dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents"), nil
}

func (m *Manager) path() (string, error) {
	d, err := m.dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, Label+".plist"), nil
}

// Bundle returns the PassVault.app that contains this helper.
func (m *Manager) Bundle() (string, error) {
	exe := m.Executable
	if exe == nil {
		exe = os.Executable
	}
	p, err := exe()
	if err != nil {
		return "", err
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	// …/X.app/Contents/MacOS/pv-helper  or  …/X.app/Contents/Helpers/PassVault Helper.app/Contents/MacOS/pv-helper
	for dir := filepath.Dir(p); dir != "/" && dir != "."; dir = filepath.Dir(dir) {
		if strings.HasSuffix(dir, ".app") && !strings.HasSuffix(dir, "Helper.app") {
			if fi, err := os.Stat(filepath.Join(dir, "Contents", "Info.plist")); err == nil && !fi.IsDir() {
				return dir, nil
			}
		}
	}
	return "", errors.New("not running from an app bundle")
}

func plist(bundle string) ([]byte, error) {
	var esc bytes.Buffer
	if err := xml.EscapeText(&esc, []byte(bundle)); err != nil {
		return nil, err
	}
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>` + Label + `</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/open</string>
		<string>-g</string>
		<string>-a</string>
		<string>` + esc.String() + `</string>
		<string>--args</string>
		<string>` + BackgroundArg + `</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`), nil
}

// Status reports whether the login item exists and points at this app.
func (m *Manager) Status() (*Status, error) {
	p, err := m.path()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return &Status{}, nil
	}
	if err != nil {
		return nil, ipc.Errf(ipc.CodeIOError, "cannot read the login item")
	}
	st := &Status{Enabled: true}
	if bundle, err := m.Bundle(); err == nil {
		st.App = bundle
		want, _ := plist(bundle)
		st.Stale = !bytes.Equal(b, want)
	}
	return st, nil
}

// Set turns the login item on (writing it for this app) or off (removing it).
func (m *Manager) Set(enabled bool) (*Status, error) {
	p, err := m.path()
	if err != nil {
		return nil, err
	}
	if !enabled {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, ipc.Errf(ipc.CodeIOError, "cannot remove the login item")
		}
		return m.Status()
	}
	bundle, err := m.Bundle()
	if err != nil {
		return nil, ipc.Errf(ipc.CodeBadRequest, "open PassVault from the Applications folder to use this")
	}
	body, err := plist(bundle)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return nil, ipc.Errf(ipc.CodeIOError, "cannot create ~/Library/LaunchAgents")
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".pv-login-*")
	if err != nil {
		return nil, ipc.Errf(ipc.CodeIOError, "cannot write the login item")
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		return nil, ipc.Errf(ipc.CodeIOError, "cannot write the login item")
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return nil, ipc.Errf(ipc.CodeIOError, "cannot write the login item")
	}
	if err := tmp.Close(); err != nil {
		return nil, ipc.Errf(ipc.CodeIOError, "cannot write the login item")
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		return nil, ipc.Errf(ipc.CodeIOError, "cannot write the login item")
	}
	return m.Status()
}
