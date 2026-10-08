package sysevents

import (
	"fmt"
	"os"
	"runtime"
	"testing"
	"time"
)

func init() { runtime.LockOSThread() }

var testName string

func TestMain(m *testing.M) {
	// A test-only notification name: the real com.apple.screenIsLocked is
	// never posted by tests (it would notify every app on the system).
	testName = fmt.Sprintf("io.passvault.helper.test.%d.locked", os.Getpid())
	AddTestName(testName, 1)
	RunMain(m.Run)
}

func TestDistributedNotificationForwarded(t *testing.T) {
	if !Available() {
		t.Skip("macOS only")
	}
	select {
	case <-Ready():
	case <-time.After(5 * time.Second):
		t.Fatal("observers not registered")
	}
	got := make(chan string, 4)
	SetHandler(func(typ string) { got <- typ })
	defer SetHandler(nil)
	PostTest(testName)
	select {
	case typ := <-got:
		if typ != ScreenLocked {
			t.Fatalf("got %q", typ)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("notification not delivered")
	}
}

func TestHotKeyRegisteredAndDelivered(t *testing.T) {
	if !Available() {
		t.Skip("macOS only")
	}
	<-Ready()
	// F19 (virtual key 80) with ⌃⌥⌘: unlikely to be owned by anything else.
	if err := SetHotKey(80, ModControl|ModOption|ModCmd); err != nil {
		t.Skipf("no window-server session for global shortcuts: %v", err)
	}
	defer ClearHotKey()
	got := make(chan string, 4)
	SetHandler(func(typ string) { got <- typ })
	defer SetHandler(nil)
	if err := PostTestHotKey(); err != nil {
		t.Fatal(err)
	}
	select {
	case typ := <-got:
		if typ != HotKey {
			t.Fatalf("got %q", typ)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shortcut press not delivered")
	}
	// Replacing and clearing never deadlock the main thread.
	if err := SetHotKey(79, ModControl|ModOption|ModCmd); err != nil {
		t.Fatal(err)
	}
	ClearHotKey()
}
