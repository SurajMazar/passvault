// Package tlscheck explains why a server's TLS certificate is not accepted.
//
// The desktop app tests a server address from its webview, where a failed
// connection is only "Load failed". The helper repeats just the TLS handshake
// (no HTTP request, nothing sent) and verifies the certificate the same way
// the system does — on macOS with the platform verifier, which honours
// certificates the user trusted in Keychain Access. Verification is never
// disabled; the result only names the problem.
package tlscheck

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/passvault/desktop-helper/internal/ipc"
)

// Result of a handshake. Message is written for people.
type Result struct {
	OK       bool   `json:"ok"`
	Reason   string `json:"reason,omitempty"` // expired | not_yet_valid | hostname | untrusted | unreachable | handshake
	Message  string `json:"message"`
	Subject  string `json:"subject,omitempty"`
	Issuer   string `json:"issuer,omitempty"`
	NotAfter string `json:"notAfter,omitempty"`
}

// Inspector performs handshakes. Zero value: system trust store, 8 s timeout.
type Inspector struct {
	// Roots overrides the system trust store (tests only).
	Roots   *x509.CertPool
	Timeout time.Duration
	// Now overrides the clock used for verification (tests only).
	Now func() time.Time
}

// Target validates raw (an https:// server address) and returns host and host:port.
func Target(raw string) (host, addr string, err error) {
	if len(raw) == 0 || len(raw) > 2048 {
		return "", "", ipc.Errf(ipc.CodeBadRequest, "url must be 1..2048 bytes")
	}
	u, perr := url.Parse(raw)
	if perr != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Opaque != "" {
		return "", "", ipc.Errf(ipc.CodeBadRequest, "an https:// server address is required")
	}
	port := u.Port()
	if port == "" {
		port = "443"
	}
	return u.Hostname(), net.JoinHostPort(u.Hostname(), port), nil
}

// Inspect connects to the server of rawURL and verifies its certificate chain and host name.
func (in *Inspector) Inspect(ctx context.Context, rawURL string) (*Result, error) {
	host, addr, err := Target(rawURL)
	if err != nil {
		return nil, err
	}
	timeout := in.Timeout
	if timeout == 0 {
		timeout = 8 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	d := &net.Dialer{}
	raw, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return &Result{Reason: "unreachable", Message: "Could not open a connection to " + addr + ". Check the address, the port and your network."}, nil
	}
	defer raw.Close()
	cfg := &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12, RootCAs: in.Roots}
	if in.Now != nil {
		cfg.Time = in.Now
	}
	conn := tls.Client(raw, cfg)
	if err := conn.HandshakeContext(ctx); err != nil {
		return explain(err, host), nil
	}
	defer conn.Close()
	st := conn.ConnectionState()
	r := &Result{OK: true, Message: "The certificate is valid and trusted by this Mac."}
	if len(st.PeerCertificates) > 0 {
		c := st.PeerCertificates[0]
		r.Subject = name(c.Subject.CommonName, c.DNSNames)
		r.Issuer = c.Issuer.CommonName
		r.NotAfter = c.NotAfter.UTC().Format(time.RFC3339)
	}
	return r, nil
}

func name(cn string, dns []string) string {
	if cn != "" {
		return cn
	}
	if len(dns) > 0 {
		return dns[0]
	}
	return ""
}

const trustHint = " For a private server, add its certificate authority to the System keychain in Keychain Access and mark it as trusted; PassVault never skips certificate checks."

func explain(err error, host string) *Result {
	var inv x509.CertificateInvalidError
	var hn x509.HostnameError
	var ua x509.UnknownAuthorityError
	var rec *tls.CertificateVerificationError
	switch {
	case errors.As(err, &inv) && inv.Reason == x509.Expired:
		r := &Result{Reason: "expired", Message: "The server's certificate has expired or is not valid yet. Its administrator must renew it."}
		if inv.Cert != nil {
			r.NotAfter = inv.Cert.NotAfter.UTC().Format(time.RFC3339)
			if time.Now().Before(inv.Cert.NotBefore) {
				r.Reason = "not_yet_valid"
			}
		}
		return r
	case errors.As(err, &hn):
		return &Result{Reason: "hostname", Message: "The server's certificate is not valid for " + host + ". Check the address, or ask the administrator to include this name in the certificate."}
	case errors.As(err, &ua):
		return &Result{Reason: "untrusted", Message: "The server's certificate is not issued by an authority this Mac trusts." + trustHint}
	case errors.As(err, &rec):
		// macOS platform verifier: the reason is only in the text.
		msg := strings.ToLower(rec.Err.Error())
		switch {
		case strings.Contains(msg, "expired"):
			return &Result{Reason: "expired", Message: "The server's certificate has expired. Its administrator must renew it."}
		case strings.Contains(msg, "name") || strings.Contains(msg, "host"):
			return &Result{Reason: "hostname", Message: "The server's certificate is not valid for " + host + "."}
		default:
			return &Result{Reason: "untrusted", Message: "The server's certificate is not trusted by this Mac." + trustHint}
		}
	}
	return &Result{Reason: "handshake", Message: "A secure (TLS) connection to the server could not be established. It may not support modern TLS, or something on the network interferes."}
}
