package validate

import "testing"

func TestHost(t *testing.T) {
	good := []string{"example.com", "a", "host-1.example.com.", "10.0.0.1", "::1", "fe80::1", "2001:db8::8a2e:370:7334", "localhost", "1.2.3.999"}
	bad := []string{"", "-oProxyCommand=x", "a;b", "$(id)", "a b", "-host", "host-.com", "a..b", ".", "ex_ample.com", "1.2.3.4:22", "[::1]", "a\nb", " example.com", "`id`", "a|b", "a&b", "host'name"}
	for _, h := range good {
		if !Host(h) {
			t.Errorf("Host(%q) = false, want true", h)
		}
	}
	for _, h := range bad {
		if Host(h) {
			t.Errorf("Host(%q) = true, want false", h)
		}
	}
	long := ""
	for i := 0; i < 64; i++ {
		long += "a"
	}
	if Host(long) {
		t.Error("64-char label accepted")
	}
}

func TestUsername(t *testing.T) {
	for _, u := range []string{"root", "deploy_user", "user@corp", "a.b", "_svc", "x+y"} {
		if !Username(u) {
			t.Errorf("Username(%q) = false", u)
		}
	}
	for _, u := range []string{"", "-oProxyCommand=x", "a;b", "$(id)", "a b", "@user", "+u", "ab\\c", "a'b", "a\n"} {
		if Username(u) {
			t.Errorf("Username(%q) = true", u)
		}
	}
}

func TestPortAccountID(t *testing.T) {
	if Port(0) || Port(65536) || !Port(22) || !Port(65535) || !Port(1) {
		t.Error("port bounds")
	}
	if !KeychainAccount("pv.vault-key.abc") || KeychainAccount("pv.") || KeychainAccount("other") || KeychainAccount("pv.A") {
		t.Error("account")
	}
	if !ID("conn-1") || ID("") || ID("a b") || ID("x;y") {
		t.Error("id")
	}
}
