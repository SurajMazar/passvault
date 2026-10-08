// Package sshkeys implements ssh.keygen / ssh.inspectKey and private-key
// parsing shared by the SSH client and the agent.
package sshkeys

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"math/big"
	"strings"

	"golang.org/x/crypto/ssh"
)

// Limits mirror packages/validation (ssh_key item).
const (
	MaxPrivateKey = 32768
	MaxPublicKey  = 16384
	MaxPassphrase = 1024
	MaxComment    = 500
)

// ErrPassphraseRequired is returned when an encrypted key is parsed without a passphrase.
var ErrPassphraseRequired = errors.New("private key is passphrase-protected; a passphrase is required")

// ErrBadPassphrase is returned when decryption fails.
var ErrBadPassphrase = errors.New("incorrect passphrase")

// Algorithms accepted by Generate.
var Algorithms = []string{"ed25519", "ecdsa-p256", "rsa-3072", "rsa-4096"}

// Generated is the output of Generate.
type Generated struct {
	PublicKey   string `json:"publicKey"`
	PrivateKey  string `json:"privateKey"`
	Fingerprint string `json:"fingerprint"`
	Algorithm   string `json:"algorithm"`
}

// Generate creates a key pair and marshals it in OpenSSH formats.
func Generate(algorithm, comment, passphrase string) (*Generated, error) {
	var priv crypto.PrivateKey
	switch algorithm {
	case "ed25519":
		_, k, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
		priv = k
	case "ecdsa-p256":
		k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, err
		}
		priv = k
	case "rsa-3072", "rsa-4096":
		bits := 3072
		if algorithm == "rsa-4096" {
			bits = 4096
		}
		k, err := rsa.GenerateKey(rand.Reader, bits)
		if err != nil {
			return nil, err
		}
		priv = k
	default:
		return nil, errors.New("unsupported algorithm")
	}
	defer Zero(priv)
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, err
	}
	var block *pem.Block
	if passphrase != "" {
		block, err = ssh.MarshalPrivateKeyWithPassphrase(priv, comment, []byte(passphrase))
	} else {
		block, err = ssh.MarshalPrivateKey(priv, comment)
	}
	if err != nil {
		return nil, err
	}
	pub := signer.PublicKey()
	return &Generated{
		PublicKey:   AuthorizedKey(pub, comment),
		PrivateKey:  string(pem.EncodeToMemory(block)),
		Fingerprint: ssh.FingerprintSHA256(pub),
		Algorithm:   algorithm,
	}, nil
}

// AuthorizedKey formats pub in authorized_keys form with an optional comment.
func AuthorizedKey(pub ssh.PublicKey, comment string) string {
	s := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub)))
	comment = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' {
			return ' '
		}
		return r
	}, comment)
	if c := strings.TrimSpace(comment); c != "" {
		s += " " + c
	}
	return s
}

// AlgorithmName maps an SSH key type to the contract's algorithm labels.
func AlgorithmName(pub ssh.PublicKey) string {
	switch pub.Type() {
	case ssh.KeyAlgoED25519:
		return "ed25519"
	case ssh.KeyAlgoECDSA256:
		return "ecdsa-p256"
	case ssh.KeyAlgoECDSA384:
		return "ecdsa-p384"
	case ssh.KeyAlgoECDSA521:
		return "ecdsa-p521"
	case ssh.KeyAlgoRSA:
		if ck, ok := pub.(ssh.CryptoPublicKey); ok {
			if rk, ok := ck.CryptoPublicKey().(*rsa.PublicKey); ok {
				return "rsa-" + big.NewInt(int64(rk.N.BitLen())).String()
			}
		}
		return "rsa"
	default:
		return pub.Type()
	}
}

// ParseRaw parses a private key, decrypting it with passphrase if needed.
func ParseRaw(privateKey, passphrase string) (crypto.PrivateKey, error) {
	if len(privateKey) > MaxPrivateKey {
		return nil, errors.New("private key too large")
	}
	k, err := ssh.ParseRawPrivateKey([]byte(privateKey))
	var pme *ssh.PassphraseMissingError
	if errors.As(err, &pme) {
		if passphrase == "" {
			return nil, ErrPassphraseRequired
		}
		k, err = ssh.ParseRawPrivateKeyWithPassphrase([]byte(privateKey), []byte(passphrase))
		if err != nil {
			if errors.Is(err, x509.IncorrectPasswordError) {
				return nil, ErrBadPassphrase
			}
			return nil, errors.New("could not decrypt private key")
		}
		return normalize(k), nil
	}
	if err != nil {
		return nil, errors.New("unrecognised private key format")
	}
	return normalize(k), nil
}

// normalize turns *ed25519.PrivateKey into ed25519.PrivateKey.
func normalize(k crypto.PrivateKey) crypto.PrivateKey {
	if p, ok := k.(*ed25519.PrivateKey); ok {
		return *p
	}
	return k
}

// ParseSigner parses a private key into an ssh.Signer.
func ParseSigner(privateKey, passphrase string) (ssh.Signer, crypto.PrivateKey, error) {
	k, err := ParseRaw(privateKey, passphrase)
	if err != nil {
		return nil, nil, err
	}
	s, err := ssh.NewSignerFromKey(k)
	if err != nil {
		Zero(k)
		return nil, nil, errors.New("unsupported private key type")
	}
	return s, k, nil
}

// Inspection is the result of Inspect.
type Inspection struct {
	PublicKey   string `json:"publicKey"`
	Fingerprint string `json:"fingerprint"`
	Algorithm   string `json:"algorithm"`
	Encrypted   bool   `json:"encrypted"`
	Comment     string `json:"comment"`
}

// Inspect validates an imported private and/or public key.
func Inspect(privateKey, publicKey, passphrase string) (*Inspection, error) {
	if privateKey == "" && publicKey == "" {
		return nil, errors.New("privateKey or publicKey is required")
	}
	var pubFromPublic ssh.PublicKey
	var pubComment string
	if publicKey != "" {
		if len(publicKey) > MaxPublicKey {
			return nil, errors.New("public key too large")
		}
		pk, comment, _, rest, err := ssh.ParseAuthorizedKey([]byte(publicKey))
		if err != nil || len(bytes.TrimSpace(rest)) != 0 {
			return nil, errors.New("invalid public key (expected one authorized_keys line)")
		}
		pubFromPublic, pubComment = pk, comment
	}
	if privateKey == "" {
		return &Inspection{
			PublicKey:   AuthorizedKey(pubFromPublic, pubComment),
			Fingerprint: ssh.FingerprintSHA256(pubFromPublic),
			Algorithm:   AlgorithmName(pubFromPublic),
			Comment:     pubComment,
		}, nil
	}
	if len(privateKey) > MaxPrivateKey {
		return nil, errors.New("private key too large")
	}
	var pub ssh.PublicKey
	encrypted := false
	comment := ""
	_, err := ssh.ParseRawPrivateKey([]byte(privateKey))
	var pme *ssh.PassphraseMissingError
	switch {
	case errors.As(err, &pme):
		encrypted = true
		if passphrase != "" {
			k, err := ParseRaw(privateKey, passphrase)
			if err != nil {
				return nil, err
			}
			s, err := ssh.NewSignerFromKey(k)
			Zero(k)
			if err != nil {
				return nil, errors.New("unsupported private key type")
			}
			pub = s.PublicKey()
		} else if pme.PublicKey != nil {
			pub = pme.PublicKey
		} else {
			return nil, ErrPassphraseRequired
		}
	case err != nil:
		return nil, errors.New("unrecognised private key format")
	default:
		k, err := ParseRaw(privateKey, "")
		if err != nil {
			return nil, err
		}
		s, err := ssh.NewSignerFromKey(k)
		Zero(k)
		if err != nil {
			return nil, errors.New("unsupported private key type")
		}
		pub = s.PublicKey()
		comment = openSSHComment(privateKey)
	}
	if pubFromPublic != nil && !bytes.Equal(pubFromPublic.Marshal(), pub.Marshal()) {
		return nil, errors.New("public key does not match private key")
	}
	if comment == "" {
		comment = pubComment
	}
	return &Inspection{
		PublicKey:   AuthorizedKey(pub, comment),
		Fingerprint: ssh.FingerprintSHA256(pub),
		Algorithm:   AlgorithmName(pub),
		Encrypted:   encrypted,
		Comment:     comment,
	}, nil
}

// openSSHComment extracts the comment of an unencrypted openssh-key-v1 key
// (x/crypto parses but discards it). Returns "" when unknown.
func openSSHComment(privateKey string) string {
	block, _ := pem.Decode([]byte(privateKey))
	if block == nil || block.Type != "OPENSSH PRIVATE KEY" {
		return ""
	}
	const magic = "openssh-key-v1\x00"
	b := block.Bytes
	if !bytes.HasPrefix(b, []byte(magic)) {
		return ""
	}
	b = b[len(magic):]
	readStr := func() ([]byte, bool) {
		if len(b) < 4 {
			return nil, false
		}
		n := binary.BigEndian.Uint32(b)
		if uint64(n) > uint64(len(b)-4) {
			return nil, false
		}
		s := b[4 : 4+n]
		b = b[4+n:]
		return s, true
	}
	cipher, ok := readStr()
	if !ok || string(cipher) != "none" {
		return ""
	}
	if _, ok = readStr(); !ok { // kdfname
		return ""
	}
	if _, ok = readStr(); !ok { // kdfoptions
		return ""
	}
	if len(b) < 4 || binary.BigEndian.Uint32(b) != 1 {
		return ""
	}
	b = b[4:]
	if _, ok = readStr(); !ok { // public key
		return ""
	}
	priv, ok := readStr()
	if !ok {
		return ""
	}
	b = priv
	if len(b) < 8 {
		return ""
	}
	b = b[8:] // check ints
	kt, ok := readStr()
	if !ok {
		return ""
	}
	fields := map[string]int{
		ssh.KeyAlgoED25519:  2,
		ssh.KeyAlgoRSA:      6,
		ssh.KeyAlgoECDSA256: 3,
		ssh.KeyAlgoECDSA384: 3,
		ssh.KeyAlgoECDSA521: 3,
	}[string(kt)]
	if fields == 0 {
		return ""
	}
	for i := 0; i < fields; i++ {
		if _, ok = readStr(); !ok {
			return ""
		}
	}
	c, ok := readStr()
	if !ok || len(c) > MaxComment {
		return ""
	}
	return string(c)
}

// Zero overwrites private key material we control. Best effort: Go's GC may
// have copied the underlying memory, and big.Int internals may be shared.
func Zero(k crypto.PrivateKey) {
	switch v := k.(type) {
	case ed25519.PrivateKey:
		clear(v)
	case *ed25519.PrivateKey:
		clear(*v)
	case *ecdsa.PrivateKey:
		if v.D != nil {
			clear(v.D.Bits())
		}
	case *rsa.PrivateKey:
		if v.D != nil {
			clear(v.D.Bits())
		}
		for _, p := range v.Primes {
			if p != nil {
				clear(p.Bits())
			}
		}
		if v.Precomputed.Dp != nil {
			clear(v.Precomputed.Dp.Bits())
		}
		if v.Precomputed.Dq != nil {
			clear(v.Precomputed.Dq.Bits())
		}
		if v.Precomputed.Qinv != nil {
			clear(v.Precomputed.Qinv.Bits())
		}
	}
}
