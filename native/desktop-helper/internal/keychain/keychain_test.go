package keychain

import (
	"bytes"
	"os"
	"runtime"
	"testing"

	"github.com/passvault/desktop-helper/internal/ipc"
)

const testAccount = "pv.test.helper-selftest"

func skipIfDisabled(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("keychain only on macOS")
	}
	if os.Getenv("PV_SKIP_KEYCHAIN_TESTS") == "1" {
		t.Skip("PV_SKIP_KEYCHAIN_TESTS=1")
	}
}

func TestNonBiometricRoundTrip(t *testing.T) {
	skipIfDisabled(t)
	secret := []byte("dummy-keychain-secret-\x00\x01")
	_ = Delete(testAccount)
	if err := Set(testAccount, secret, false); err != nil {
		if e := ipc.AsError(err); e.Code == ipc.CodeUnavailable {
			t.Skipf("keychain unavailable here: %s", e.Message)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = Delete(testAccount) })
	got, err := Get(testAccount, "test")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, secret) {
		t.Fatal("secret mismatch")
	}
	// Overwrite.
	if err := Set(testAccount, []byte("v2"), false); err != nil {
		t.Fatal(err)
	}
	if got, _ := Get(testAccount, "test"); string(got) != "v2" {
		t.Fatal("overwrite failed")
	}
	if err := Delete(testAccount); err != nil {
		t.Fatal(err)
	}
	if _, err := Get(testAccount, "test"); ipc.AsError(err).Code != ipc.CodeNotFound {
		t.Fatalf("after delete: %v", err)
	}
	if err := Delete(testAccount); ipc.AsError(err).Code != ipc.CodeNotFound {
		t.Fatalf("double delete: %v", err)
	}
}

func TestBiometricHonestOnUnsignedBuild(t *testing.T) {
	if runtime.GOOS != "darwin" {
		st := Status()
		if st.Available || st.Reason == "" {
			t.Fatal("stub must report unavailable with a reason")
		}
		return
	}
	st := Status()
	t.Logf("biometric status: %+v (probe OSStatus %d)", st, EntitlementProbe())
	if st.Reason == "" && !st.Available {
		t.Fatal("unavailable without a reason")
	}
	// The test binary is unsigned/ad-hoc: the data-protection keychain must
	// be refused, and biometric storage must fail with that reason rather
	// than silently falling back to a non-biometric item.
	if EntitlementProbe() == errSecMissingEntitlement {
		if st.Available {
			t.Fatal("reported available without entitlement")
		}
		err := Set("pv.test.bio-probe", []byte("dummy"), true)
		e := ipc.AsError(err)
		if err == nil || e.Code != ipc.CodeUnavailable || e.Message != ReasonNeedsEntitlement {
			_ = Delete("pv.test.bio-probe")
			t.Fatalf("biometric set on unsigned build: %v", err)
		}
		// Nothing was stored in the legacy keychain as a fallback.
		if _, err := Get("pv.test.bio-probe", "x"); ipc.AsError(err).Code != ipc.CodeNotFound {
			_ = Delete("pv.test.bio-probe")
			t.Fatalf("fallback item exists: %v", err)
		}
	}
}
