// Package keychain stores small secrets in the macOS Keychain under service
// io.passvault.desktop.
//
// Non-biometric items live in the default (file-based) keychain. Biometric
// items live in the data-protection keychain with access control
// kSecAccessControlBiometryCurrentSet + kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
// so the secret can only be released by the Secure Enclave-backed keychain
// after a successful Touch ID match — never by a UI-only LAContext gate.
// That requires a signed build with a keychain-access-groups entitlement;
// unsigned/ad-hoc builds get errSecMissingEntitlement (-34018), which is
// reported honestly as unavailable.
package keychain

import (
	"fmt"

	"github.com/passvault/desktop-helper/internal/ipc"
)

// Service is the fixed keychain service name.
const Service = "io.passvault.desktop"

// ReasonNeedsEntitlement is reported when the data-protection keychain is
// not usable by this build.
const ReasonNeedsEntitlement = "requires a signed build with keychain entitlement"

// OSStatus values we map.
const (
	errSecSuccess               = 0
	errSecUserCanceled          = -128
	errSecAuthFailed            = -25293
	errSecItemNotFound          = -25300
	errSecDuplicateItem         = -25299
	errSecInteractionNotAllowed = -25308
	errSecNotAvailable          = -25291
	errSecMissingEntitlement    = -34018
)

func statusErr(st int) error {
	switch st {
	case errSecSuccess:
		return nil
	case errSecItemNotFound:
		return ipc.Errf(ipc.CodeNotFound, "keychain item not found")
	case errSecUserCanceled, errSecAuthFailed:
		return ipc.Errf(ipc.CodeDenied, "authentication was cancelled or failed")
	case errSecMissingEntitlement:
		return ipc.Errf(ipc.CodeUnavailable, "%s", ReasonNeedsEntitlement)
	case errSecInteractionNotAllowed:
		return ipc.Errf(ipc.CodeUnavailable, "keychain interaction is not allowed (locked keychain or no GUI session)")
	case errSecNotAvailable:
		return ipc.Errf(ipc.CodeUnavailable, "no keychain is available")
	default:
		return ipc.Errf(ipc.CodeIOError, "keychain error (OSStatus %s)", fmt.Sprint(st))
	}
}

// BiometricStatus is the result of Status.
type BiometricStatus struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
}

func laReason(code int) string {
	switch code {
	case -5:
		return "no device passcode is set"
	case -6:
		return "Touch ID is not available on this Mac"
	case -7:
		return "no fingerprints are enrolled"
	case -8:
		return "Touch ID is locked out; unlock with your password first"
	default:
		return fmt.Sprintf("biometrics unavailable (LAError %d)", code)
	}
}
