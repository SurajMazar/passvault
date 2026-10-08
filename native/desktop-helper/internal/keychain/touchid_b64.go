package keychain

import "encoding/base64"

func appendBase64(dst, src []byte) []byte {
	n := base64.StdEncoding.EncodedLen(len(src))
	out := append(dst, make([]byte, n)...)
	base64.StdEncoding.Encode(out[len(dst):], src)
	return out
}

func decodeBase64(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }
