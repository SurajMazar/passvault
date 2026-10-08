package sshconn

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"strconv"

	"golang.org/x/crypto/ssh"

	"github.com/passvault/desktop-helper/internal/sshkeys"
	"github.com/passvault/desktop-helper/internal/validate"
)

// HostKey is a trusted host key: SSH key type + base64 of the wire encoding.
type HostKey struct {
	KeyType   string `json:"keyType"`
	PublicKey string `json:"publicKey"`
}

// Auth selects and carries credentials for one hop.
type Auth struct {
	Method     string `json:"method"`
	Password   string `json:"password,omitempty"`
	PrivateKey string `json:"privateKey,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
}

// Hop is one SSH server (target or jump).
type Hop struct {
	Host            string    `json:"host"`
	Port            int       `json:"port"`
	Username        string    `json:"username"`
	Auth            Auth      `json:"auth"`
	TrustedHostKeys []HostKey `json:"trustedHostKeys"`
}

// HopPublic is a hop without credentials (external terminal).
type HopPublic struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
}

// Limits.
const (
	MaxPassword    = 10000
	MaxTrustedKeys = 20
	MaxHostKeyB64  = 4096
	MaxKeyTypeLen  = 64
	MaxAnswers     = 32
	MaxAnswerLen   = 10000
	MaxWriteBytes  = 64 << 10
	MaxDimension   = 2000
	MaxConnections = 32
	MaxLabel       = 300
)

// ValidatePublic checks host, port and username.
func (h HopPublic) ValidatePublic(name string) error {
	if !validate.Host(h.Host) {
		return fmt.Errorf("%s.host is not a valid hostname or IP address", name)
	}
	if !validate.Port(h.Port) {
		return fmt.Errorf("%s.port must be 1-65535", name)
	}
	if !validate.Username(h.Username) {
		return fmt.Errorf("%s.username is invalid", name)
	}
	return nil
}

// Public strips credentials.
func (h *Hop) Public() HopPublic { return HopPublic{Host: h.Host, Port: h.Port, Username: h.Username} }

// Validate checks every field of a hop (credentials are not parsed here).
func (h *Hop) Validate(name string) error {
	if err := h.Public().ValidatePublic(name); err != nil {
		return err
	}
	switch h.Auth.Method {
	case "password", "key", "agent", "keyboard_interactive":
	default:
		return fmt.Errorf("%s.auth.method is invalid", name)
	}
	if len(h.Auth.Password) > MaxPassword || len(h.Auth.PrivateKey) > sshkeys.MaxPrivateKey || len(h.Auth.Passphrase) > sshkeys.MaxPassphrase {
		return fmt.Errorf("%s.auth field too long", name)
	}
	if h.Auth.Method == "key" && h.Auth.PrivateKey == "" {
		return fmt.Errorf("%s.auth.privateKey is required for key auth", name)
	}
	if _, err := ParseTrusted(h.TrustedHostKeys); err != nil {
		return fmt.Errorf("%s.trustedHostKeys: %v", name, err)
	}
	return nil
}

// ParseTrusted decodes trusted host keys and checks the declared type.
func ParseTrusted(keys []HostKey) ([]ssh.PublicKey, error) {
	if len(keys) > MaxTrustedKeys {
		return nil, errors.New("too many keys")
	}
	out := make([]ssh.PublicKey, 0, len(keys))
	for i, k := range keys {
		if len(k.PublicKey) > MaxHostKeyB64 || len(k.KeyType) > MaxKeyTypeLen {
			return nil, fmt.Errorf("key %d too long", i)
		}
		raw, err := base64.StdEncoding.DecodeString(k.PublicKey)
		if err != nil {
			return nil, fmt.Errorf("key %d is not base64", i)
		}
		pk, err := ssh.ParsePublicKey(raw)
		if err != nil {
			return nil, fmt.Errorf("key %d is not an SSH public key", i)
		}
		if pk.Type() != k.KeyType {
			return nil, fmt.Errorf("key %d type does not match keyType", i)
		}
		out = append(out, pk)
	}
	return out, nil
}

// HostPort formats host:port (brackets for IPv6).
func HostPort(host string, port int) string { return net.JoinHostPort(host, strconv.Itoa(port)) }

// Event payloads.

// StateEvent is ssh.state. Code is set for state "error" (contract addition).
type StateEvent struct {
	ConnID  string `json:"connId"`
	State   string `json:"state"`
	Message string `json:"message,omitempty"`
	Code    string `json:"code,omitempty"`
}

// HostKeyEvent is ssh.hostKey.
type HostKeyEvent struct {
	ConnID      string   `json:"connId,omitempty"`
	Hop         string   `json:"hop"`
	HostPort    string   `json:"hostPort"`
	KeyType     string   `json:"keyType"`
	PublicKey   string   `json:"publicKey"`
	Fingerprint string   `json:"fingerprint"`
	Status      string   `json:"status"`
	Trusted     []string `json:"trusted"`
}

// Question is one keyboard-interactive question.
type Question struct {
	Text string `json:"text"`
	Echo bool   `json:"echo"`
}

// PromptEvent is ssh.prompt.
type PromptEvent struct {
	ConnID      string     `json:"connId"`
	PromptID    string     `json:"promptId"`
	Hop         string     `json:"hop"`
	Name        string     `json:"name"`
	Instruction string     `json:"instruction"`
	Questions   []Question `json:"questions"`
}

// DataEvent is ssh.data.
type DataEvent struct {
	ConnID  string `json:"connId"`
	DataB64 string `json:"dataB64"`
}

// ExitEvent is ssh.exit.
type ExitEvent struct {
	ConnID     string `json:"connId"`
	ExitStatus *int   `json:"exitStatus,omitempty"`
	Signal     string `json:"signal,omitempty"`
}

// TestResult is the result of ssh.test.
type TestResult struct {
	OK      bool          `json:"ok"`
	Stage   string        `json:"stage"`
	Message string        `json:"message"`
	HostKey *HostKeyEvent `json:"hostKey,omitempty"`
}
