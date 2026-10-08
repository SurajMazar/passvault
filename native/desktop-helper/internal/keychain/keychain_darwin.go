//go:build darwin

package keychain

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Foundation -framework Security -framework LocalAuthentication
#include <stdlib.h>
#include "keychain_darwin.h"
*/
import "C"

import (
	"unsafe"
)

// Available reports whether the keychain APIs exist on this platform.
func Available() bool { return true }

func cstr(s string) *C.char { return C.CString(s) }

// Set stores secret under account. biometric selects the access-controlled
// data-protection keychain item.
func Set(account string, secret []byte, biometric bool) error {
	// Check before pv_kc_set deletes any existing item, so a failed
	// biometric enrolment never destroys the previous secret.
	if biometric && int(C.pv_kc_probe_dp()) == errSecMissingEntitlement {
		return statusErr(errSecMissingEntitlement)
	}
	a := cstr(account)
	defer C.free(unsafe.Pointer(a))
	var p unsafe.Pointer
	if len(secret) > 0 {
		p = C.CBytes(secret)
		defer func() {
			// Zero the C copy before freeing.
			b := unsafe.Slice((*byte)(p), len(secret))
			clear(b)
			C.free(p)
		}()
	}
	bio := C.int(0)
	if biometric {
		bio = 1
	}
	return statusErr(int(C.pv_kc_set(a, p, C.int(len(secret)), bio)))
}

// Get reads a secret. Biometric items show the system Touch ID prompt with
// reason.
func Get(account, reason string) ([]byte, error) {
	a := cstr(account)
	defer C.free(unsafe.Pointer(a))
	r := cstr(reason)
	defer C.free(unsafe.Pointer(r))
	var out unsafe.Pointer
	var n C.int
	st := int(C.pv_kc_get(a, r, &out, &n))
	if err := statusErr(st); err != nil {
		return nil, err
	}
	b := C.GoBytes(out, n)
	clear(unsafe.Slice((*byte)(out), int(n)))
	C.free(out)
	return b, nil
}

// Delete removes the item from both keychains.
func Delete(account string) error {
	a := cstr(account)
	defer C.free(unsafe.Pointer(a))
	return statusErr(int(C.pv_kc_delete(a)))
}

// Status reports whether biometric keychain items can work in this build.
func Status() BiometricStatus {
	var la C.int
	if C.pv_bio_can_evaluate(&la) == 0 {
		return BiometricStatus{Available: false, Reason: laReason(int(la))}
	}
	if st := int(C.pv_kc_probe_dp()); st == errSecMissingEntitlement {
		return BiometricStatus{Available: false, Reason: ReasonNeedsEntitlement}
	}
	return BiometricStatus{Available: true, Reason: ""}
}

// EntitlementProbe returns the raw OSStatus of the data-protection keychain
// probe (tests/diagnostics).
func EntitlementProbe() int { return int(C.pv_kc_probe_dp()) }
