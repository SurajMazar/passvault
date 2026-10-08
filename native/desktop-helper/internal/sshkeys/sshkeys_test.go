package sshkeys

import (
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestGenerateAndInspectAllAlgorithms(t *testing.T) {
	for _, alg := range Algorithms {
		for _, pass := range []string{"", "dummy-pass"} {
			g, err := Generate(alg, "user@host", pass)
			if err != nil {
				t.Fatalf("%s: %v", alg, err)
			}
			if g.Algorithm != alg || !strings.HasPrefix(g.Fingerprint, "SHA256:") || !strings.HasSuffix(g.PublicKey, " user@host") {
				t.Fatalf("%s: %+v", alg, g)
			}
			if !strings.HasPrefix(g.PrivateKey, "-----BEGIN OPENSSH PRIVATE KEY-----") {
				t.Fatalf("%s: not OpenSSH format", alg)
			}
			pk, _, _, _, err := ssh.ParseAuthorizedKey([]byte(g.PublicKey))
			if err != nil || AlgorithmName(pk) != alg {
				t.Fatalf("%s: public key %v %s", alg, err, AlgorithmName(pk))
			}
			in, err := Inspect(g.PrivateKey, g.PublicKey, "")
			if err != nil {
				t.Fatalf("%s inspect: %v", alg, err)
			}
			if in.Encrypted != (pass != "") || in.Fingerprint != g.Fingerprint || in.Algorithm != alg {
				t.Fatalf("%s inspect: %+v", alg, in)
			}
			if pass == "" && in.Comment != "user@host" {
				t.Fatalf("%s comment %q", alg, in.Comment)
			}
			if pass != "" {
				if _, _, err := ParseSigner(g.PrivateKey, ""); err != ErrPassphraseRequired {
					t.Fatalf("%s: expected passphrase required, got %v", alg, err)
				}
				if _, _, err := ParseSigner(g.PrivateKey, "wrong"); err != ErrBadPassphrase {
					t.Fatalf("%s: expected bad passphrase, got %v", alg, err)
				}
				if _, _, err := ParseSigner(g.PrivateKey, pass); err != nil {
					t.Fatalf("%s decrypt: %v", alg, err)
				}
			}
		}
	}
}

func TestInspectRejects(t *testing.T) {
	a, _ := Generate("ed25519", "", "")
	b, _ := Generate("ed25519", "", "")
	if _, err := Inspect(a.PrivateKey, b.PublicKey, ""); err == nil {
		t.Error("mismatched pair accepted")
	}
	if _, err := Inspect("garbage", "", ""); err == nil {
		t.Error("garbage accepted")
	}
	if _, err := Inspect("", "ssh-ed25519 AAAA", ""); err == nil {
		t.Error("bad public key accepted")
	}
	if _, err := Inspect("", "", ""); err == nil {
		t.Error("empty accepted")
	}
	in, err := Inspect("", a.PublicKey+" trailing-comment", "")
	if err != nil || in.PublicKey == "" {
		t.Errorf("public only: %v", err)
	}
	if _, err := Generate("dsa", "", ""); err == nil {
		t.Error("dsa accepted")
	}
}
