// Package logx is a deliberately narrow logger. It can record only:
//   - constant messages (type Msg: a string variable cannot be passed without
//     an explicit conversion, which makes accidental logging of data visible
//     in review),
//   - op names and request ids, sanitised to a short safe charset,
//   - error codes from the fixed IPC error-code set.
//
// It has no API that accepts params, payloads, prompts, answers or keys.
package logx

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// Msg is a constant log message. Only untyped string constants convert
// implicitly; dynamic strings need an explicit Msg(...) conversion.
type Msg string

// Logger writes single-line records.
type Logger struct {
	mu sync.Mutex
	w  io.Writer
}

// New returns a logger writing to w (nil → discard).
func New(w io.Writer) *Logger {
	if w == nil {
		w = io.Discard
	}
	return &Logger{w: w}
}

// Discard is a logger that writes nothing.
func Discard() *Logger { return New(nil) }

func sanitize(s string, max int) string {
	if len(s) > max {
		s = s[:max]
	}
	b := []byte(s)
	for i, c := range b {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-' || c == ':') {
			b[i] = '?'
		}
	}
	return string(b)
}

func (l *Logger) write(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintf(l.w, "%s pv-helper %s\n", time.Now().UTC().Format(time.RFC3339), line)
}

// Info logs a constant message.
func (l *Logger) Info(m Msg) { l.write("msg=" + sanitizeMsg(string(m))) }

// Code logs a constant message with an error code.
func (l *Logger) Code(m Msg, code string) {
	l.write("msg=" + sanitizeMsg(string(m)) + " code=" + sanitize(code, 32))
}

// Op logs the outcome of one IPC request: op name, request id, result code.
func (l *Logger) Op(op, id, code string, d time.Duration) {
	l.write(fmt.Sprintf("op=%s id=%s code=%s dur=%dms", sanitize(op, 40), sanitize(id, 64), sanitize(code, 32), d.Milliseconds()))
}

// Event logs that an event of the given type was emitted (never its data).
func (l *Logger) Event(typ string) { l.write("event=" + sanitize(typ, 40)) }

func sanitizeMsg(s string) string {
	if len(s) > 200 {
		s = s[:200]
	}
	b := []byte(s)
	for i, c := range b {
		if c < 0x20 || c > 0x7e {
			b[i] = '?'
		}
	}
	return "\"" + string(b) + "\""
}

// OpenFile opens (creating 0600) the helper log in dir, rotating at 5 MiB.
// The directory is created 0700. Symlinks are refused (O_NOFOLLOW).
func OpenFile(dir string) (*os.File, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	p := filepath.Join(dir, "helper.log")
	if fi, err := os.Lstat(p); err == nil && fi.Mode().IsRegular() && fi.Size() > 5<<20 {
		_ = os.Rename(p, p+".1")
	}
	fd, err := syscall.Open(p, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_APPEND|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), p)
	_ = f.Chmod(0o600)
	return f, nil
}

// MultiWriter fans out to several writers.
func MultiWriter(ws ...io.Writer) io.Writer { return io.MultiWriter(ws...) }
