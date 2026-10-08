//go:build darwin

package sysevents

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Foundation -framework AppKit -framework Carbon
#include <stdlib.h>
#include "sysevents_darwin.h"
*/
import "C"

import (
	"os"
	"unsafe"
)

//export pvSysEvent
func pvSysEvent(code C.int) { dispatch(int(code)) }

// Available reports whether system events are supported.
func Available() bool { return true }

// RunMain must be called from the main goroutine locked to the main OS
// thread (runtime.LockOSThread in an init function). It runs app on another
// goroutine, exits the process with app's return code, and dedicates the
// main thread to the notification run loop. It never returns.
func RunMain(app func() int) {
	go func() { os.Exit(app()) }()
	C.pv_sysevents_run_main()
	select {}
}

// SetHotKey registers the global shortcut (Carbon virtual key code and
// modifier mask), replacing any previous one. It fails when another
// application already owns the combination.
func SetHotKey(keyCode, modifiers uint32) error {
	<-ready
	if st := C.pv_hotkey_set(C.uint(keyCode), C.uint(modifiers)); st != 0 {
		return &HotKeyError{Status: int(st)}
	}
	return nil
}

// ClearHotKey removes the global shortcut.
func ClearHotKey() {
	<-ready
	C.pv_hotkey_clear()
}

// PostTestHotKey delivers a synthetic shortcut press through the event path (tests only).
func PostTestHotKey() error {
	<-ready
	if st := C.pv_hotkey_post_test(); st != 0 {
		return &HotKeyError{Status: int(st)}
	}
	return nil
}

// AddTestName registers an extra distributed-notification name mapped to an
// event code (tests only; must be called before RunMain).
func AddTestName(name string, code int) {
	c := C.CString(name)
	defer C.free(unsafe.Pointer(c))
	C.pv_sysevents_add_test_name(c, C.int(code))
}

// PostTest posts a distributed notification (tests only, test names only).
func PostTest(name string) {
	c := C.CString(name)
	defer C.free(unsafe.Pointer(c))
	C.pv_sysevents_post_test(c)
}
