// Package validate mirrors the connection-parameter validators of
// packages/validation/src/items.ts (isValidHost, USERNAME_RE, isValidPort) and
// adds the identifier formats used by the IPC contract.
//
// Go's regexp package has no look-around, so HOST_LABEL
// (/^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/) is implemented as an explicit check.
// Unlike the zod schemas, values are NOT trimmed: surrounding whitespace is
// rejected, which is strictly tighter than the UI.
package validate

import (
	"regexp"
	"strings"
)

var (
	ipv4RE = regexp.MustCompile(`^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$`)
	ipv6RE = regexp.MustCompile(`^(([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(([0-9A-Fa-f]{1,4}:){0,7}[0-9A-Fa-f]{0,4})?::(([0-9A-Fa-f]{1,4}:){0,7}[0-9A-Fa-f]{0,4})?)$`)
	// UsernameRE is USERNAME_RE from packages/validation.
	usernameRE = regexp.MustCompile(`^[A-Za-z0-9_.][A-Za-z0-9_.@+-]{0,99}$`)
	accountRE  = regexp.MustCompile(`^pv\.[a-z0-9._-]{1,64}$`)
	idRE       = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
)

func isHostLabel(l string) bool {
	if len(l) < 1 || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
		return false
	}
	for i := 0; i < len(l); i++ {
		c := l[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

// Host reports whether h is a hostname, IPv4 or IPv6 literal (no brackets).
// It never accepts a value beginning with '-'.
func Host(h string) bool {
	if h == "" || len(h) > 253 || strings.HasPrefix(h, "-") {
		return false
	}
	if ipv4RE.MatchString(h) {
		return true
	}
	if strings.Contains(h, ":") {
		return ipv6RE.MatchString(h)
	}
	trimmed := strings.TrimSuffix(h, ".")
	for _, l := range strings.Split(trimmed, ".") {
		if !isHostLabel(l) {
			return false
		}
	}
	return true
}

// Username mirrors isValidSshUsername.
func Username(u string) bool { return usernameRE.MatchString(u) }

// Port mirrors isValidPort.
func Port(p int) bool { return p >= 1 && p <= 65535 }

// KeychainAccount validates keychain account names (`^pv\.[a-z0-9._-]{1,64}$`).
func KeychainAccount(a string) bool { return accountRE.MatchString(a) }

// ID validates caller-chosen identifiers (connId, keyId, request ids).
func ID(s string) bool { return idRE.MatchString(s) }

// IsIPv6 reports whether h is an IPv6 literal (needs brackets in host:port forms).
func IsIPv6(h string) bool { return strings.Contains(h, ":") }
