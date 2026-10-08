package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/passvault/desktop-helper/internal/app"
	"github.com/passvault/desktop-helper/internal/sshconn"
)

// fakeNeutralino emulates the extension side of the Neutralinojs server.
type fakeNeutralino struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	conn     *websocket.Conn
	got      chan map[string]any
	query    url.Values
	host     string
	accepted chan struct{}
}

func newFake(t *testing.T) *fakeNeutralino {
	f := &fakeNeutralino{t: t, got: make(chan map[string]any, 100), accepted: make(chan struct{})}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.query = r.URL.Query()
		f.host = r.Host
		if f.query.Get("connectToken") != "conn-tok" || f.query.Get("extensionId") != "io.passvault.helper" {
			http.Error(w, "bad token", http.StatusForbidden)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c.SetReadLimit(64 << 20)
		f.mu.Lock()
		f.conn = c
		f.mu.Unlock()
		close(f.accepted)
		for {
			_, b, err := c.Read(context.Background())
			if err != nil {
				return
			}
			var m map[string]any
			json.Unmarshal(b, &m)
			// Neutralino replies to native calls with {id, method, data}.
			reply, _ := json.Marshal(map[string]any{"id": m["id"], "method": m["method"], "data": map[string]any{"success": true}})
			c.Write(context.Background(), websocket.MessageText, reply)
			f.got <- m
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeNeutralino) port() string {
	u, _ := url.Parse(f.srv.URL)
	return u.Port()
}

func (f *fakeNeutralino) dispatch(event string, data any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"event": event, "data": data})
	if err := f.conn.Write(context.Background(), websocket.MessageText, b); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fakeNeutralino) response(id string) map[string]any {
	f.t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case m := <-f.got:
			if m["method"] != "app.broadcast" || m["accessToken"] != "access-tok" {
				f.t.Fatalf("unexpected native call %v", m)
			}
			d := m["data"].(map[string]any)
			if d["event"] == "pv.response" {
				inner := d["data"].(map[string]any)
				if inner["id"] == id {
					return inner
				}
			}
		case <-timeout:
			f.t.Fatalf("no response %s", id)
		}
	}
}

func startHelper(t *testing.T, f *fakeNeutralino) (chan int, string) {
	agentBase, _ := os.MkdirTemp("", "pvm")
	t.Cleanup(func() { os.RemoveAll(agentBase) })
	agentDir := filepath.Join(agentBase, "agent")
	stdin := strings.NewReader(fmt.Sprintf(`{"nlPort":"%s","nlToken":"access-tok","nlConnectToken":"conn-tok","nlExtensionId":"io.passvault.helper"}`, f.port()))
	o := options{logDir: t.TempDir(), parentPoll: 50 * time.Millisecond,
		app: app.Config{Version: "test", AgentDir: agentDir, SSH: sshconn.DefaultConfig()}}
	done := make(chan int, 1)
	go func() { done <- run(stdin, o) }()
	select {
	case <-f.accepted:
	case <-time.After(10 * time.Second):
		t.Fatal("helper did not connect")
	}
	return done, agentDir
}

func TestEndToEndWindowClose(t *testing.T) {
	f := newFake(t)
	done, agentDir := startHelper(t, f)
	if !strings.HasPrefix(f.host, "127.0.0.1:") {
		t.Fatalf("Host header %q (Neutralino only accepts localhost/127.0.0.1)", f.host)
	}
	f.dispatch("pv.request", map[string]any{"v": 1, "id": "h1", "op": "hello", "params": map[string]any{"clientVersion": "t"}})
	r := f.response("h1")
	sid := r["result"].(map[string]any)["sessionId"].(string)
	f.dispatch("pv.request", map[string]any{"v": 1, "id": "a1", "sessionId": sid, "op": "agent.start", "params": map[string]any{}})
	if r := f.response("a1"); r["ok"] != true {
		t.Fatalf("agent.start %v", r)
	}
	sock := filepath.Join(agentDir, "agent.sock")
	if _, err := os.Lstat(sock); err != nil {
		t.Fatal("socket missing")
	}
	// Framework events do not stop the helper: closing the window leaves the
	// app running in the menu bar, so the helper must stay available.
	f.dispatch("windowFocus", nil)
	f.dispatch("windowClose", nil)
	select {
	case code := <-done:
		t.Fatalf("helper exited on windowClose (code %d)", code)
	case <-time.After(500 * time.Millisecond):
	}
	f.dispatch("pv.request", map[string]any{"v": 1, "id": "p1", "sessionId": sid, "op": "ping", "params": map[string]any{}})
	if r := f.response("p1"); r["ok"] != true {
		t.Fatalf("ping after windowClose %v", r)
	}
	// The app exiting closes the socket; that is what stops the helper.
	f.mu.Lock()
	f.conn.Close(websocket.StatusNormalClosure, "app exited")
	f.mu.Unlock()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("exit code %d", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper did not exit when the socket closed")
	}
	if _, err := os.Lstat(sock); !os.IsNotExist(err) {
		t.Fatal("agent socket not removed on exit")
	}
}

func TestEndToEndSocketClose(t *testing.T) {
	f := newFake(t)
	done, _ := startHelper(t, f)
	f.mu.Lock()
	f.conn.Close(websocket.StatusNormalClosure, "app exited")
	f.mu.Unlock()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("helper did not exit when the socket closed")
	}
}

func TestBadBootstrap(t *testing.T) {
	for _, in := range []string{``, `{"nlPort":"0"}`, `{"nlPort":"1","nlToken":"a","nlConnectToken":"b c","nlExtensionId":"x"}`} {
		if code := run(strings.NewReader(in), options{}); code == 0 {
			t.Errorf("accepted %q", in)
		}
	}
}
