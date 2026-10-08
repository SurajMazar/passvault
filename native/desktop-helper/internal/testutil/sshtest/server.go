// Package sshtest is an in-process SSH server (127.0.0.1:0) for tests. It
// records authentication attempts, pty-req / window-change requests, echoes
// shell input, and supports direct-tcpip so it can act as a jump host.
package sshtest

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"
)

// KIRound is one keyboard-interactive challenge and its expected answers.
type KIRound struct {
	Name, Instruction string
	Questions         []string
	Echos             []bool
	Expect            []string
}

// Options configures a server.
type Options struct {
	User           string
	Password       string          // enables password auth if non-empty
	AuthorizedKeys []ssh.PublicKey // enables publickey auth if non-empty
	KI             []KIRound       // enables keyboard-interactive if non-empty
	AllowForward   bool            // allow direct-tcpip (jump host)
}

// PtyReq is a recorded pty-req.
type PtyReq struct {
	Term       string
	Cols, Rows uint32
}

// Server is a running test server.
type Server struct {
	t        testing.TB
	opts     Options
	ln       net.Listener
	HostKey  ssh.Signer
	Addr     string
	Host     string
	Port     int
	mu       sync.Mutex
	authLog  []string // "method:user"
	pwSeen   []string
	ptys     []PtyReq
	resizes  []PtyReq
	forwards []string
	conns    []net.Conn
	wg       sync.WaitGroup
	closed   bool
}

// NewHostKey generates a fresh ed25519 host key.
func NewHostKey(t testing.TB) ssh.Signer {
	_, k, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// Start launches a server with a fresh host key.
func Start(t testing.TB, opts Options) *Server {
	return StartWithKey(t, opts, NewHostKey(t))
}

// StartWithKey launches a server with the given host key.
func StartWithKey(t testing.TB, opts Options, hostKey ssh.Signer) *Server {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{t: t, opts: opts, ln: ln, HostKey: hostKey, Addr: ln.Addr().String()}
	h, p, _ := net.SplitHostPort(s.Addr)
	s.Host = h
	s.Port, _ = strconv.Atoi(p)
	s.wg.Add(1)
	go s.accept()
	t.Cleanup(s.Close)
	return s
}

// HostKeyB64 returns the host key as (type, base64 wire).
func (s *Server) HostKeyB64() (string, string) {
	pk := s.HostKey.PublicKey()
	return pk.Type(), base64.StdEncoding.EncodeToString(pk.Marshal())
}

// Close stops the server and all its connections.
func (s *Server) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	conns := s.conns
	s.mu.Unlock()
	s.ln.Close()
	for _, c := range conns {
		c.Close()
	}
	s.wg.Wait()
}

// AuthAttempts returns recorded auth attempts ("method:user").
func (s *Server) AuthAttempts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.authLog...)
}

// PasswordsSeen returns passwords offered by clients.
func (s *Server) PasswordsSeen() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.pwSeen...)
}

// Ptys returns recorded pty-req requests.
func (s *Server) Ptys() []PtyReq {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]PtyReq{}, s.ptys...)
}

// Resizes returns recorded window-change requests.
func (s *Server) Resizes() []PtyReq {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]PtyReq{}, s.resizes...)
}

// Forwards returns direct-tcpip destinations requested.
func (s *Server) Forwards() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.forwards...)
}

func (s *Server) config() *ssh.ServerConfig {
	cfg := &ssh.ServerConfig{
		AuthLogCallback: func(md ssh.ConnMetadata, method string, err error) {
			if method == "none" {
				return
			}
			s.mu.Lock()
			s.authLog = append(s.authLog, method+":"+md.User())
			s.mu.Unlock()
		},
	}
	if s.opts.Password != "" {
		cfg.PasswordCallback = func(md ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			s.mu.Lock()
			s.pwSeen = append(s.pwSeen, string(pw))
			s.mu.Unlock()
			if md.User() == s.opts.User && string(pw) == s.opts.Password {
				return nil, nil
			}
			return nil, fmt.Errorf("denied")
		}
	}
	if len(s.opts.AuthorizedKeys) > 0 {
		cfg.PublicKeyCallback = func(md ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if md.User() != s.opts.User {
				return nil, fmt.Errorf("denied")
			}
			for _, k := range s.opts.AuthorizedKeys {
				if bytes.Equal(k.Marshal(), key.Marshal()) {
					return nil, nil
				}
			}
			return nil, fmt.Errorf("denied")
		}
	}
	if len(s.opts.KI) > 0 {
		cfg.KeyboardInteractiveCallback = func(md ssh.ConnMetadata, ch ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			for _, r := range s.opts.KI {
				ans, err := ch(md.User(), r.Instruction, r.Questions, r.Echos)
				if err != nil {
					return nil, err
				}
				if len(ans) != len(r.Expect) {
					return nil, fmt.Errorf("denied")
				}
				for i := range ans {
					if ans[i] != r.Expect[i] {
						return nil, fmt.Errorf("denied")
					}
				}
			}
			if md.User() != s.opts.User {
				return nil, fmt.Errorf("denied")
			}
			return nil, nil
		}
	}
	cfg.AddHostKey(s.HostKey)
	return cfg
}

func (s *Server) accept() {
	defer s.wg.Done()
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			c.Close()
			return
		}
		s.conns = append(s.conns, c)
		s.mu.Unlock()
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handle(c)
		}()
	}
}

func (s *Server) handle(nc net.Conn) {
	defer nc.Close()
	sc, chans, reqs, err := ssh.NewServerConn(nc, s.config())
	if err != nil {
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)
	var wg sync.WaitGroup
	defer wg.Wait()
	for nch := range chans {
		switch nch.ChannelType() {
		case "session":
			ch, creqs, err := nch.Accept()
			if err != nil {
				continue
			}
			wg.Add(1)
			go func() { defer wg.Done(); s.session(ch, creqs) }()
		case "direct-tcpip":
			if !s.opts.AllowForward {
				nch.Reject(ssh.Prohibited, "no forwarding")
				continue
			}
			var d struct {
				Host     string
				Port     uint32
				OrigHost string
				OrigPort uint32
			}
			if err := ssh.Unmarshal(nch.ExtraData(), &d); err != nil {
				nch.Reject(ssh.ConnectionFailed, "bad")
				continue
			}
			addr := net.JoinHostPort(d.Host, strconv.Itoa(int(d.Port)))
			s.mu.Lock()
			s.forwards = append(s.forwards, addr)
			s.mu.Unlock()
			tc, err := net.Dial("tcp", addr)
			if err != nil {
				nch.Reject(ssh.ConnectionFailed, "dial")
				continue
			}
			ch, creqs, err := nch.Accept()
			if err != nil {
				tc.Close()
				continue
			}
			go ssh.DiscardRequests(creqs)
			wg.Add(1)
			go func() {
				defer wg.Done()
				done := make(chan struct{}, 2)
				go func() { io.Copy(tc, ch); tc.(*net.TCPConn).CloseWrite(); done <- struct{}{} }()
				go func() { io.Copy(ch, tc); ch.CloseWrite(); done <- struct{}{} }()
				<-done
				<-done
				ch.Close()
				tc.Close()
			}()
		default:
			nch.Reject(ssh.UnknownChannelType, "unsupported")
		}
	}
}

// session handles pty-req, window-change, shell; the shell echoes input and
// exits with status 3 on a line "exit".
func (s *Server) session(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	shellStarted := make(chan struct{})
	reqsDone := make(chan struct{})
	go func() {
		defer close(reqsDone)
		for r := range reqs {
			switch r.Type {
			case "pty-req":
				var p struct {
					Term                 string
					Cols, Rows, PxW, PxH uint32
					Modes                string
				}
				if err := ssh.Unmarshal(r.Payload, &p); err == nil {
					s.mu.Lock()
					s.ptys = append(s.ptys, PtyReq{Term: p.Term, Cols: p.Cols, Rows: p.Rows})
					s.mu.Unlock()
				}
				r.Reply(true, nil)
			case "window-change":
				if len(r.Payload) >= 8 {
					s.mu.Lock()
					s.resizes = append(s.resizes, PtyReq{Cols: binary.BigEndian.Uint32(r.Payload[0:4]), Rows: binary.BigEndian.Uint32(r.Payload[4:8])})
					s.mu.Unlock()
				}
				if r.WantReply {
					r.Reply(true, nil)
				}
			case "shell":
				r.Reply(true, nil)
				close(shellStarted)
			default:
				if r.WantReply {
					r.Reply(false, nil)
				}
			}
		}
	}()
	select {
	case <-shellStarted:
	case <-reqsDone:
		return
	}
	ch.Write([]byte("welcome\r\n"))
	var line []byte
	buf := make([]byte, 4096)
	for {
		n, err := ch.Read(buf)
		if n > 0 {
			ch.Write(buf[:n])
			for _, b := range buf[:n] {
				if b == '\n' || b == '\r' {
					if string(line) == "exit" {
						ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{3}))
						return
					}
					line = line[:0]
				} else {
					line = append(line, b)
				}
			}
		}
		if err != nil {
			return
		}
	}
}
