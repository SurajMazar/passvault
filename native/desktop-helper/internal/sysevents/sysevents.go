// Package sysevents forwards macOS screen lock/unlock and sleep/wake
// notifications. On darwin the process main thread is dedicated to the
// CFRunLoop that receives them (see RunMain); elsewhere it is a no-op.
package sysevents

import "sync"

// Event types (system.event data.type).
const (
	ScreenLocked   = "screen_locked"
	ScreenUnlocked = "screen_unlocked"
	WillSleep      = "will_sleep"
	DidWake        = "did_wake"
	// HotKey is the global shortcut being pressed (forwarded as hotkey.pressed, not system.event).
	HotKey = "hotkey"
)

// Carbon modifier masks for SetHotKey.
const (
	ModCmd     = 1 << 8
	ModShift   = 1 << 9
	ModOption  = 1 << 11
	ModControl = 1 << 12
)

// HotKeyError is returned when the shortcut cannot be registered
// (status -9878: already taken by another application).
type HotKeyError struct{ Status int }

func (e *HotKeyError) Error() string {
	if e.Status == -9878 {
		return "that shortcut is already used by another application"
	}
	return "the shortcut could not be registered"
}

var (
	mu        sync.Mutex
	handler   func(string)
	readyOnce sync.Once
	ready     = make(chan struct{})
)

// SetHandler sets the callback for system events (called on the main
// thread; it must not block).
func SetHandler(fn func(string)) {
	mu.Lock()
	handler = fn
	mu.Unlock()
}

// Ready is closed once observers are registered.
func Ready() <-chan struct{} { return ready }

func dispatch(code int) {
	var typ string
	switch code {
	case 0:
		readyOnce.Do(func() { close(ready) })
		return
	case 1:
		typ = ScreenLocked
	case 2:
		typ = ScreenUnlocked
	case 3:
		typ = WillSleep
	case 4:
		typ = DidWake
	case 5:
		typ = HotKey
	default:
		return
	}
	mu.Lock()
	h := handler
	mu.Unlock()
	if h != nil {
		h(typ)
	}
}
