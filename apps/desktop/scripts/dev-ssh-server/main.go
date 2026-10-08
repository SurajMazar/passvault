// dev-ssh-server: a throwaway SSH server for MANUAL verification of the
// PassVault desktop terminal (development only, never shipped).
//
//   cd apps/desktop/scripts/dev-ssh-server && GOTOOLCHAIN=local go run . [-port 2222] [-rotate]
//
// - Listens on 127.0.0.1 only. Never touches ~/.ssh or the system sshd.
// - Users (dummy credentials, printed at start):
//     dev  / password "dev-password"            (password auth)
//     kbd  / keyboard-interactive: password "dev-password", then OTP "123456"
//     key  / public key listed in -authorized (OpenSSH authorized_keys file), if given
// - The "shell" is a tiny built-in fake: it echoes input and understands
//   `help`, `whoami`, `link`, `size`, `exit`. It never executes commands on this Mac.
// - The host key (ed25519) is kept in $TMPDIR/pv-dev-ssh-hostkey so the
//   fingerprint is stable across restarts; -rotate generates a new one
//   (use it to see the host_key_mismatch dialog).
package main

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
)

const password = "dev-password"

func hostKey(rotate bool) ssh.Signer {
	p := filepath.Join(os.TempDir(), "pv-dev-ssh-hostkey")
	if !rotate {
		if b, err := os.ReadFile(p); err == nil {
			if s, err := ssh.ParsePrivateKey(b); err == nil {
				return s
			}
		}
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	blk, err := ssh.MarshalPrivateKey(priv, "pv-dev-ssh")
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(p, pem.EncodeToMemory(blk), 0o600); err != nil {
		log.Fatal(err)
	}
	s, _ := ssh.NewSignerFromKey(priv)
	return s
}

func main() {
	port := flag.Int("port", 2222, "port on 127.0.0.1")
	rotate := flag.Bool("rotate", false, "generate a new host key")
	authorized := flag.String("authorized", "", "authorized_keys file for user 'key'")
	flag.Parse()

	var allowed []ssh.PublicKey
	if *authorized != "" {
		b, err := os.ReadFile(*authorized)
		if err != nil {
			log.Fatal(err)
		}
		for len(b) > 0 {
			pk, _, _, rest, err := ssh.ParseAuthorizedKey(b)
			if err != nil {
				break
			}
			allowed = append(allowed, pk)
			b = rest
		}
	}

	cfg := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if c.User() == "dev" && string(pw) == password {
				return nil, nil
			}
			return nil, fmt.Errorf("denied")
		},
		KeyboardInteractiveCallback: func(c ssh.ConnMetadata, ch ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			if c.User() != "kbd" {
				return nil, fmt.Errorf("denied")
			}
			a, err := ch("pv-dev-ssh", "Dev server: enter the dummy password", []string{"Password: "}, []bool{false})
			if err != nil || len(a) != 1 || a[0] != password {
				return nil, fmt.Errorf("denied")
			}
			a, err = ch("", "Second factor", []string{"One-time code: "}, []bool{true})
			if err != nil || len(a) != 1 || a[0] != "123456" {
				return nil, fmt.Errorf("denied")
			}
			return nil, nil
		},
		PublicKeyCallback: func(c ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
			if c.User() == "key" {
				for _, a := range allowed {
					if string(a.Marshal()) == string(k.Marshal()) {
						return nil, nil
					}
				}
			}
			return nil, fmt.Errorf("denied")
		},
	}
	hk := hostKey(*rotate)
	cfg.AddHostKey(hk)

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("dev SSH server on %s", ln.Addr())
	log.Printf("host key %s %s", hk.PublicKey().Type(), ssh.FingerprintSHA256(hk.PublicKey()))
	log.Printf("users: dev/%q (password), kbd (keyboard-interactive, OTP 123456), key (%d authorized keys)", password, len(allowed))
	for {
		nc, err := ln.Accept()
		if err != nil {
			log.Fatal(err)
		}
		go handle(nc, cfg)
	}
}

func handle(nc net.Conn, cfg *ssh.ServerConfig) {
	sc, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		log.Printf("handshake from %s failed: %v", nc.RemoteAddr(), err)
		return
	}
	log.Printf("login %s from %s", sc.User(), sc.RemoteAddr())
	go ssh.DiscardRequests(reqs)
	for nch := range chans {
		if nch.ChannelType() != "session" {
			_ = nch.Reject(ssh.UnknownChannelType, "only sessions")
			continue
		}
		ch, creqs, err := nch.Accept()
		if err != nil {
			continue
		}
		go session(sc.User(), ch, creqs)
	}
}

type tty struct {
	mu         sync.Mutex
	cols, rows uint32
}

func session(user string, ch ssh.Channel, reqs <-chan *ssh.Request) {
	t := &tty{cols: 80, rows: 24}
	started := false
	for req := range reqs {
		switch req.Type {
		case "pty-req":
			// string TERM, uint32 cols, uint32 rows, ...
			if len(req.Payload) >= 4 {
				n := binary.BigEndian.Uint32(req.Payload)
				if int(4+n+8) <= len(req.Payload) {
					t.mu.Lock()
					t.cols = binary.BigEndian.Uint32(req.Payload[4+n:])
					t.rows = binary.BigEndian.Uint32(req.Payload[8+n:])
					t.mu.Unlock()
				}
			}
			_ = req.Reply(true, nil)
		case "window-change":
			if len(req.Payload) >= 8 {
				t.mu.Lock()
				t.cols = binary.BigEndian.Uint32(req.Payload)
				t.rows = binary.BigEndian.Uint32(req.Payload[4:])
				t.mu.Unlock()
			}
		case "shell":
			_ = req.Reply(true, nil)
			if !started {
				started = true
				go fakeShell(user, ch, t)
			}
		default:
			// exec, subsystem, agent forwarding, x11, env: refused.
			_ = req.Reply(false, nil)
		}
	}
}

func fakeShell(user string, ch ssh.Channel, t *tty) {
	defer ch.Close()
	w := func(s string) { _, _ = io.WriteString(ch, strings.ReplaceAll(s, "\n", "\r\n")) }
	w(fmt.Sprintf("\x1b[1;36mPassVault dev SSH server\x1b[0m — logged in as %s. Type `help`.\n", user))
	prompt := func() { w(fmt.Sprintf("\x1b[32m%s@pv-dev\x1b[0m:~$ ", user)) }
	prompt()
	r := bufio.NewReader(ch)
	var line []byte
	for {
		b, err := r.ReadByte()
		if err != nil {
			return
		}
		switch {
		case b == '\r' || b == '\n':
			w("\n")
			cmd := strings.TrimSpace(string(line))
			line = line[:0]
			switch {
			case cmd == "exit":
				_, _ = ch.SendRequest("exit-status", false, []byte{0, 0, 0, 0})
				return
			case cmd == "help":
				w("help, whoami, size, link, exit — everything else is echoed\n")
			case cmd == "whoami":
				w(user + "\n")
			case cmd == "size":
				t.mu.Lock()
				w(fmt.Sprintf("%dx%d\n", t.cols, t.rows))
				t.mu.Unlock()
			case cmd == "link":
				w("plain link: https://example.com/docs\n")
				w("\x1b]8;;https://example.org/osc8\x1b\\OSC 8 hyperlink\x1b]8;;\x1b\\\n")
				w("non-http link (must not open): file:///etc/passwd\n")
			case cmd != "":
				w("echo: " + cmd + "\n")
			}
			prompt()
		case b == 0x7f || b == 0x08:
			if len(line) > 0 {
				line = line[:len(line)-1]
				w("\b \b")
			}
		case b == 0x03:
			line = line[:0]
			w("^C\n")
			prompt()
		case b == 0x1b:
			// swallow escape sequences (arrows, bracketed paste markers)
		case b >= 0x20:
			line = append(line, b)
			_, _ = ch.Write([]byte{b})
		}
	}
}
