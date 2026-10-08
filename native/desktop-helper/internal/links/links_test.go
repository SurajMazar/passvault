package links

import (
	"strings"
	"testing"
)

func TestOnlyWebLinksAreOpened(t *testing.T) {
	var got [][]string
	o := &Opener{Launch: func(argv []string) error { got = append(got, argv); return nil }}

	ok := []string{
		"https://example.com",
		"http://localhost:3000/path?q=1#frag",
		// shell metacharacters are inert: there is no shell
		"https://example.com/?x=$(touch%20/tmp/pv)&y=`id`&z=\"q\"",
	}
	for _, u := range ok {
		if err := o.Open(u); err != nil {
			t.Fatalf("%q refused: %v", u, err)
		}
	}
	bad := []string{
		"", "javascript:alert(1)", "file:///etc/passwd", "ssh://host", "x-apple.systempreferences:com.apple.preference.security",
		"data:text/html,<script>", "/relative/path", "-a Calculator", "https://", "https://user:pass@example.com/",
		"https://example.com/ two", "https://example.com/\nX", "https://example.com/\x00", "mailto:a@b.c",
		"https:example.com", strings.Repeat("a", MaxURLBytes+1),
	}
	for _, u := range bad {
		if err := o.Open(u); err == nil {
			t.Fatalf("%q was opened", u)
		}
	}
	if len(got) != len(ok) {
		t.Fatalf("launched %d times, want %d", len(got), len(ok))
	}
	for _, argv := range got {
		if len(argv) != 2 || argv[0] != "/usr/bin/open" || strings.HasPrefix(argv[1], "-") {
			t.Fatalf("unexpected argv %q", argv)
		}
	}
}
