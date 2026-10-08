package keychain

// Touch ID without entitlements: the bundled pv-touchid tool
// (native/touchid/pv-touchid.swift) seals a secret with a Secure Enclave key
// that requires a current Touch ID match, so unsigned builds get the same
// hardware-enforced guarantee as the data-protection keychain. The helper
// uses it only when that keychain is unavailable (errSecMissingEntitlement).
// It is started with a fixed argv ("--helper"), never through a shell; the
// request (and any secret) travels on stdin.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/passvault/desktop-helper/internal/ipc"
)

// touchIDBinary finds pv-touchid in the app bundle: next to the helper
// (flat layout) or in Contents/MacOS when the helper runs from
// Contents/Helpers/PassVault Helper.app (bundle layout).
var touchIDBinary = func() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	dir := filepath.Dir(exe)
	for _, c := range []string{filepath.Join(dir, "pv-touchid"), filepath.Join(dir, "..", "..", "..", "..", "MacOS", "pv-touchid")} {
		if st, err := os.Stat(c); err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0 {
			return filepath.Clean(c)
		}
	}
	return ""
}

// touchIDRecordPath mirrors recordURL in pv-touchid.swift (namespace "desktop").
func touchIDRecordPath(account string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	sum := sha256.Sum256([]byte("desktop\x00" + account))
	return filepath.Join(home, "Library", "Application Support", "PassVault", "touchid", hex.EncodeToString(sum[:])+".json")
}

func touchIDEnrolled(account string) bool {
	p := touchIDRecordPath(account)
	if p == "" {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

type touchIDReply struct {
	OK         bool     `json:"ok"`
	Code       string   `json:"code"`
	Message    string   `json:"message"`
	Available  bool     `json:"available"`
	Reason     string   `json:"reason"`
	SecretB64  string   `json:"secretB64"`
	Browsers   []string `json:"browsers"`
	Registered bool     `json:"registered"`
}

// touchIDRun sends one request to pv-touchid. timeout covers a Touch ID prompt.
func touchIDRun(req map[string]any, timeout time.Duration) (*touchIDReply, error) {
	bin := touchIDBinary()
	if bin == "" {
		// neither the entitlement nor the Secure Enclave tool: report the original reason
		return nil, ipc.Errf(ipc.CodeUnavailable, "%s", ReasonNeedsEntitlement)
	}
	in, err := json.Marshal(req)
	if err != nil {
		return nil, ipc.Errf(ipc.CodeInternal, "encode request")
	}
	defer clear(in)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "--helper")
	cmd.Stdin = bytes.NewReader(in)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Env = []string{"HOME=" + os.Getenv("HOME")}
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ipc.Errf(ipc.CodeDenied, "Touch ID timed out")
		}
		return nil, ipc.Errf(ipc.CodeIOError, "Touch ID support failed to run")
	}
	var r touchIDReply
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		return nil, ipc.Errf(ipc.CodeIOError, "Touch ID support returned an invalid reply")
	}
	clear(out.Bytes())
	if !r.OK {
		code := ipc.CodeIOError
		switch r.Code {
		case "denied":
			code = ipc.CodeDenied
		case "not_found":
			code = ipc.CodeNotFound
		case "unavailable":
			code = ipc.CodeUnavailable
		case "bad_request":
			code = ipc.CodeBadRequest
		}
		msg := r.Message
		if msg == "" {
			msg = "Touch ID operation failed"
		}
		return nil, ipc.Errf(code, "%s", msg)
	}
	return &r, nil
}

func touchIDStatus() BiometricStatus {
	r, err := touchIDRun(map[string]any{"op": "status"}, 10*time.Second)
	if err != nil {
		return BiometricStatus{Available: false, Reason: ReasonNeedsEntitlement}
	}
	return BiometricStatus{Available: r.Available, Reason: r.Reason}
}

func touchIDWrap(account string, secret []byte) error {
	b64 := make([]byte, 0, len(secret)*4/3+4)
	b64 = appendBase64(b64, secret)
	defer clear(b64)
	_, err := touchIDRun(map[string]any{"op": "wrap", "account": account, "secretB64": string(b64)}, 30*time.Second)
	return err
}

func touchIDUnwrap(account, reason string) ([]byte, error) {
	r, err := touchIDRun(map[string]any{"op": "unwrap", "account": account, "reason": reason}, 2*time.Minute)
	if err != nil {
		return nil, err
	}
	b, derr := decodeBase64(r.SecretB64)
	r.SecretB64 = ""
	if derr != nil {
		return nil, ipc.Errf(ipc.CodeIOError, "Touch ID support returned an invalid secret")
	}
	return b, nil
}

func touchIDDelete(account string) {
	if p := touchIDRecordPath(account); p != "" {
		_ = os.Remove(p)
	}
}

// BrowsersStatus reports whether the browser extension's native-messaging
// host is registered with any installed Chromium browser.
func BrowsersStatus() (bool, error) {
	r, err := touchIDRun(map[string]any{"op": "status"}, 10*time.Second)
	if err != nil {
		return false, err
	}
	return r.Registered, nil
}

// RegisterBrowsers lets the given extension origins use Touch ID through
// pv-touchid (Chrome native messaging). Returns the browsers configured.
func RegisterBrowsers(origins []string) ([]string, error) {
	r, err := touchIDRun(map[string]any{"op": "register", "origins": origins}, 10*time.Second)
	if err != nil {
		return nil, err
	}
	return r.Browsers, nil
}

// UnregisterBrowsers removes the native-messaging host from every browser.
func UnregisterBrowsers() error {
	_, err := touchIDRun(map[string]any{"op": "unregister"}, 10*time.Second)
	return err
}
