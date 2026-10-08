package neutralino

import (
	"encoding/json"
	"sync"
)

// Message is one outbound message captured by TestTransport, re-encoded as
// generic JSON so tests see exactly what the UI would receive.
type Message struct {
	Event string
	Data  map[string]any
	Raw   []byte
}

// TestTransport is an in-memory ipc.Sender for tests.
type TestTransport struct {
	mu   sync.Mutex
	subs []chan Message
	all  []Message
}

// NewTestTransport returns an empty test transport.
func NewTestTransport() *TestTransport { return &TestTransport{} }

// Send implements ipc.Sender.
func (t *TestTransport) Send(event string, data any) error {
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	msg := Message{Event: event, Data: m, Raw: b}
	t.mu.Lock()
	t.all = append(t.all, msg)
	subs := append([]chan Message{}, t.subs...)
	t.mu.Unlock()
	for _, c := range subs {
		select {
		case c <- msg:
		default:
		}
	}
	return nil
}

// Subscribe returns a channel receiving subsequent messages.
func (t *TestTransport) Subscribe() chan Message {
	c := make(chan Message, 4096)
	t.mu.Lock()
	t.subs = append(t.subs, c)
	t.mu.Unlock()
	return c
}

// All returns every message sent so far.
func (t *TestTransport) All() []Message {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]Message{}, t.all...)
}
