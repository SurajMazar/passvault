//go:build !darwin

package sysevents

import "os"

// Available reports whether system events are supported.
func Available() bool { return false }

// RunMain runs app and exits with its code.
func RunMain(app func() int) {
	readyOnce.Do(func() { close(ready) })
	os.Exit(app())
}

// AddTestName is a no-op off macOS.
func AddTestName(string, int) {}

// PostTest is a no-op off macOS.
func PostTest(string) {}
