//go:build !darwin

package keychain

import "github.com/passvault/desktop-helper/internal/ipc"

func unavailable() error { return ipc.Errf(ipc.CodeUnavailable, "keychain is only available on macOS") }

// Available reports whether the keychain APIs exist on this platform.
func Available() bool { return false }

// Set is unavailable off macOS.
func Set(string, []byte, bool) error { return unavailable() }

// Get is unavailable off macOS.
func Get(string, string) ([]byte, error) { return nil, unavailable() }

// Delete is unavailable off macOS.
func Delete(string) error { return unavailable() }

// Status is unavailable off macOS.
func Status() BiometricStatus {
	return BiometricStatus{Available: false, Reason: "biometrics are only available on macOS"}
}

// EntitlementProbe is unavailable off macOS.
func EntitlementProbe() int { return 0 }
