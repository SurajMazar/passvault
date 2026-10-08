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
)

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
