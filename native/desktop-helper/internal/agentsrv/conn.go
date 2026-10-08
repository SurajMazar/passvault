package agentsrv

import (
	"bytes"
	"errors"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

const (
	noteUnverified = "The SSH agent protocol does not reliably identify the destination"
	noteVerified   = "The SSH client bound this request to a server host key (session-bind@openssh.com). This identifies only the server's host key, not the hostname you intended."
	maxBinds       = 16
)

type bind struct {
	hostKey    ssh.PublicKey
	sessionID  []byte
	forwarding bool
}

// connAgent is the per-socket-connection agent (holds peer identity and
// session-bind state, like OpenSSH's ssh-agent).
type connAgent struct {
	s      *Server
	client ClientInfo
	binds  []bind
}

var _ agent.ExtendedAgent = (*connAgent)(nil)

func (c *connAgent) List() ([]*agent.Key, error) {
	c.s.mu.Lock()
	defer c.s.mu.Unlock()
	if c.s.locked {
		return []*agent.Key{}, nil
	}
	out := make([]*agent.Key, 0, len(c.s.keys))
	for _, k := range c.s.keys {
		out = append(out, &agent.Key{Format: k.pub.Type(), Blob: k.pub.Marshal(), Comment: k.name})
	}
	return out, nil
}

func (c *connAgent) Sign(key ssh.PublicKey, data []byte) (*ssh.Signature, error) {
	return c.SignWithFlags(key, data, 0)
}

func (c *connAgent) SignWithFlags(pub ssh.PublicKey, data []byte, flags agent.SignatureFlags) (*ssh.Signature, error) {
	k, err := c.s.findKey(pub)
	if err != nil {
		return nil, err
	}
	dest := Destination{Verified: false, Note: noteUnverified}
	forwarded := false
	for _, b := range c.binds {
		if b.forwarding {
			forwarded = true
		}
	}
	if len(c.binds) > 0 {
		last := c.binds[len(c.binds)-1]
		sid, ok := userauthSessionID(data)
		if !ok || !bytes.Equal(sid, last.sessionID) {
			// Same policy as OpenSSH ssh-agent: a bound connection may only
			// sign for the session it bound.
			return nil, ErrDenied
		}
		dest = Destination{Verified: true, HostKeyFingerprint: ssh.FingerprintSHA256(last.hostKey), Note: noteVerified}
	}
	if err := c.s.approve(k, c.client, dest, forwarded); err != nil {
		return nil, err
	}
	return c.s.sign(k, data, flags)
}

// userauthSessionID extracts the leading session identifier string from an
// SSH_MSG_USERAUTH_REQUEST signature payload.
func userauthSessionID(data []byte) ([]byte, bool) {
	var p struct {
		SessionID []byte
		Rest      []byte `ssh:"rest"`
	}
	if err := ssh.Unmarshal(data, &p); err != nil {
		return nil, false
	}
	return p.SessionID, true
}

func (c *connAgent) Extension(extensionType string, contents []byte) ([]byte, error) {
	if extensionType != "session-bind@openssh.com" {
		return nil, agent.ErrExtensionUnsupported
	}
	var sb struct {
		HostKey    []byte
		SessionID  []byte
		Signature  []byte
		Forwarding bool
	}
	if err := ssh.Unmarshal(contents, &sb); err != nil {
		return nil, errors.New("malformed session-bind")
	}
	hk, err := ssh.ParsePublicKey(sb.HostKey)
	if err != nil {
		return nil, errors.New("bad host key")
	}
	var sig ssh.Signature
	if err := ssh.Unmarshal(sb.Signature, &sig); err != nil {
		return nil, errors.New("bad signature")
	}
	if err := hk.Verify(sb.SessionID, &sig); err != nil {
		return nil, errors.New("session-bind signature does not verify")
	}
	if len(c.binds) >= maxBinds {
		return nil, errors.New("too many session binds")
	}
	for _, b := range c.binds {
		if bytes.Equal(b.sessionID, sb.SessionID) {
			if !bytes.Equal(b.hostKey.Marshal(), hk.Marshal()) {
				return nil, errors.New("session rebound to a different host key")
			}
			return nil, nil
		}
	}
	c.binds = append(c.binds, bind{hostKey: hk, sessionID: sb.SessionID, forwarding: sb.Forwarding})
	return nil, nil
}

func (c *connAgent) Add(agent.AddedKey) error       { return ErrRefused }
func (c *connAgent) Remove(ssh.PublicKey) error     { return ErrRefused }
func (c *connAgent) RemoveAll() error               { return ErrRefused }
func (c *connAgent) Lock([]byte) error              { return ErrRefused }
func (c *connAgent) Unlock([]byte) error            { return ErrRefused }
func (c *connAgent) Signers() ([]ssh.Signer, error) { return nil, ErrRefused }
