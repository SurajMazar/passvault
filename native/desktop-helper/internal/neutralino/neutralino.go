// Package neutralino implements the Neutralinojs extension transport.
//
// Verified against the Neutralinojs docs and server source (see
// docs/DESKTOP_HELPER.md):
//   - Neutralino writes {"nlPort","nlToken","nlConnectToken","nlExtensionId"}
//     (all strings) to the extension's stdin and then closes stdin.
//   - The extension connects to
//     ws://127.0.0.1:<nlPort>?extensionId=<id>&connectToken=<nlConnectToken>.
//     The server only accepts Host "localhost"/"127.0.0.1".
//   - The extension receives {"event","data"} objects (dispatch/broadcast and
//     framework events such as windowClose) plus {"id","method","data"}
//     replies to its own native calls.
//   - It calls native methods with {"id","method","accessToken","data"};
//     app.broadcast with data {"event","data"} reaches the app.
//   - Neutralino does not kill extensions on exit; the extension must exit
//     when the socket closes.
package neutralino

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Auth is the bootstrap payload written to stdin by Neutralino.
type Auth struct {
	Port         string
	Token        string
	ConnectToken string
	ExtensionID  string
}

// connectToken goes into the URL; Neutralino itself parses it with [\w.\-_]+.
var tokenRE = regexp.MustCompile(`^[A-Za-z0-9._\-]{1,512}$`)

// The access token is only echoed back inside JSON; accept printable ASCII.
var accessTokenRE = regexp.MustCompile(`^[\x21-\x7e]{1,1000}$`)
var extIDRE = regexp.MustCompile(`^[A-Za-z0-9.]{1,128}$`)

// flexString accepts a JSON string or number.
type flexString string

func (f *flexString) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*f = flexString(s)
		return nil
	}
	var n json.Number
	if err := json.Unmarshal(b, &n); err != nil {
		return err
	}
	*f = flexString(n.String())
	return nil
}

// ReadAuth reads the first JSON object from r (bounded to 64 KiB).
func ReadAuth(r io.Reader) (Auth, error) {
	var raw struct {
		Port         flexString `json:"nlPort"`
		Token        string     `json:"nlToken"`
		ConnectToken string     `json:"nlConnectToken"`
		ExtensionID  string     `json:"nlExtensionId"`
	}
	dec := json.NewDecoder(bufio.NewReader(io.LimitReader(r, 64<<10)))
	if err := dec.Decode(&raw); err != nil {
		return Auth{}, fmt.Errorf("read neutralino auth: %w", err)
	}
	a := Auth{Port: string(raw.Port), Token: raw.Token, ConnectToken: raw.ConnectToken, ExtensionID: raw.ExtensionID}
	p, err := strconv.Atoi(a.Port)
	if err != nil || p < 1 || p > 65535 {
		return Auth{}, errors.New("invalid nlPort")
	}
	if !accessTokenRE.MatchString(a.Token) || !tokenRE.MatchString(a.ConnectToken) {
		return Auth{}, errors.New("invalid tokens")
	}
	if !extIDRE.MatchString(a.ExtensionID) {
		return Auth{}, errors.New("invalid nlExtensionId")
	}
	return a, nil
}

// URL returns the extension WebSocket URL.
func (a Auth) URL() string {
	q := url.Values{}
	q.Set("extensionId", a.ExtensionID)
	q.Set("connectToken", a.ConnectToken)
	return "ws://127.0.0.1:" + a.Port + "/?" + q.Encode()
}

// Inbound is a message pushed to the extension.
type Inbound struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
	// Present on replies to our own native calls.
	ID     string `json:"id"`
	Method string `json:"method"`
}

// Transport is a connected extension socket.
type Transport struct {
	auth Auth
	c    *websocket.Conn
	wmu  sync.Mutex
}

// ReadLimit is the maximum inbound frame size. It is larger than
// ipc.MaxRequestBytes so oversize requests are answered with bad_request
// instead of killing the socket.
const ReadLimit = 32 << 20

// Dial connects to Neutralino.
func Dial(ctx context.Context, a Auth) (*Transport, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, a.URL(), &websocket.DialOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return nil, fmt.Errorf("connect to neutralino: %w", err)
	}
	c.SetReadLimit(ReadLimit)
	return &Transport{auth: a, c: c}, nil
}

func uuid4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Send broadcasts {event, data} to the app via the app.broadcast native method.
func (t *Transport) Send(event string, data any) error {
	msg := map[string]any{
		"id":          uuid4(),
		"method":      "app.broadcast",
		"accessToken": t.auth.Token,
		"data":        map[string]any{"event": event, "data": data},
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	t.wmu.Lock()
	defer t.wmu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return t.c.Write(ctx, websocket.MessageText, b)
}

// Run reads messages until the socket closes or ctx ends, calling fn for
// each {event,data} message. Replies to our own native calls are passed to
// onReply (may be nil).
func (t *Transport) Run(ctx context.Context, fn func(event string, data json.RawMessage), onReply func(Inbound)) error {
	for {
		_, b, err := t.c.Read(ctx)
		if err != nil {
			return err
		}
		var in Inbound
		if err := json.Unmarshal(b, &in); err != nil {
			continue
		}
		if in.Event != "" {
			fn(in.Event, in.Data)
		} else if onReply != nil {
			onReply(in)
		}
	}
}

// Close closes the socket.
func (t *Transport) Close() error { return t.c.Close(websocket.StatusNormalClosure, "bye") }
