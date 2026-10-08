package tlscheck

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func pool(c *x509.Certificate) *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(c)
	return p
}

func TestTrustedCertificate(t *testing.T) {
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	defer srv.Close()
	in := &Inspector{Roots: pool(srv.Certificate())}
	r, err := in.Inspect(context.Background(), srv.URL+"/passvault")
	if err != nil {
		t.Fatal(err)
	}
	if !r.OK || r.NotAfter == "" {
		t.Fatalf("want ok with certificate details, got %+v", r)
	}
}

func TestUntrustedAuthority(t *testing.T) {
	srv := httptest.NewTLSServer(http.NotFoundHandler())
	defer srv.Close()
	// httptest servers share one built-in certificate: trust an unrelated, freshly made CA instead.
	_, other := selfSigned(t, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	r, err := (&Inspector{Roots: pool(other)}).Inspect(context.Background(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if r.OK || r.Reason != "untrusted" || !strings.Contains(r.Message, "Keychain") {
		t.Fatalf("want untrusted with a trust-store hint, got %+v", r)
	}
}

func TestHostnameMismatch(t *testing.T) {
	srv := httptest.NewTLSServer(http.NotFoundHandler()) // certificate for example.com / 127.0.0.1 / ::1
	defer srv.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "https://"))
	r, err := (&Inspector{Roots: pool(srv.Certificate())}).Inspect(context.Background(), "https://localhost:"+port)
	if err != nil {
		t.Fatal(err)
	}
	if r.OK || r.Reason != "hostname" || !strings.Contains(r.Message, "localhost") {
		t.Fatalf("want hostname mismatch, got %+v", r)
	}
}

func selfSigned(t *testing.T, notBefore, notAfter time.Time) (tls.Certificate, *x509.Certificate) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: "127.0.0.1"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, cert
}

func TestExpiredCertificate(t *testing.T) {
	pair, cert := selfSigned(t, time.Now().Add(-48*time.Hour), time.Now().Add(-24*time.Hour))
	srv := httptest.NewUnstartedServer(http.NotFoundHandler())
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{pair}}
	srv.StartTLS()
	defer srv.Close()
	r, err := (&Inspector{Roots: pool(cert)}).Inspect(context.Background(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if r.OK || r.Reason != "expired" || r.NotAfter == "" {
		t.Fatalf("want expired, got %+v", r)
	}
}

func TestUnreachable(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	r, err := (&Inspector{Timeout: 2 * time.Second}).Inspect(context.Background(), "https://"+addr)
	if err != nil {
		t.Fatal(err)
	}
	if r.OK || r.Reason != "unreachable" {
		t.Fatalf("want unreachable, got %+v", r)
	}
}

func TestOnlyHTTPSAddresses(t *testing.T) {
	for _, bad := range []string{"", "http://vault.example.com", "https://user:pw@vault.example.com", "file:///etc/passwd", "vault.example.com", "https://", strings.Repeat("a", 3000)} {
		if _, err := (&Inspector{}).Inspect(context.Background(), bad); err == nil {
			t.Errorf("%q: want error", bad)
		}
	}
}
