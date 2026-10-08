package loginitem

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeBundle(t *testing.T, name string) (dir, exe string) {
	t.Helper()
	root := t.TempDir()
	dir = filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Join(dir, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Contents", "Info.plist"), []byte("<plist/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	exe = filepath.Join(dir, "Contents", "MacOS", "pv-helper")
	if err := os.WriteFile(exe, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir, exe
}

func TestEnableDisable(t *testing.T) {
	bundle, exe := fakeBundle(t, "PassVault.app")
	bundle, _ = filepath.EvalSymlinks(bundle) // the helper's own path is resolved (/var -> /private/var)
	agents := t.TempDir()
	m := &Manager{Dir: agents, Executable: func() (string, error) { return exe, nil }}

	st, err := m.Status()
	if err != nil || st.Enabled {
		t.Fatalf("initially off: %+v %v", st, err)
	}
	st, err = m.Set(true)
	if err != nil || !st.Enabled || st.Stale {
		t.Fatalf("enable: %+v %v", st, err)
	}
	p := filepath.Join(agents, Label+".plist")
	b, _ := os.ReadFile(p)
	body := string(b)
	for _, want := range []string{"<string>/usr/bin/open</string>", "<string>-g</string>", "<string>" + bundle + "</string>", "<string>--background</string>", "<key>RunAtLoad</key><true/>"} {
		if !strings.Contains(body, want) {
			t.Errorf("plist lacks %s", want)
		}
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o644 {
		t.Errorf("mode %v", fi.Mode().Perm())
	}
	st, err = m.Set(false)
	if err != nil || st.Enabled {
		t.Fatalf("disable: %+v %v", st, err)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("plist not removed")
	}
	if _, err := m.Set(false); err != nil {
		t.Fatal("disabling twice must succeed")
	}
}

func TestStaleWhenAppMoved(t *testing.T) {
	_, exe := fakeBundle(t, "PassVault.app")
	agents := t.TempDir()
	m := &Manager{Dir: agents, Executable: func() (string, error) { return exe, nil }}
	if _, err := m.Set(true); err != nil {
		t.Fatal(err)
	}
	_, moved := fakeBundle(t, "PassVault.app")
	m.Executable = func() (string, error) { return moved, nil }
	st, err := m.Status()
	if err != nil || !st.Enabled || !st.Stale {
		t.Fatalf("want stale: %+v %v", st, err)
	}
}

func TestBundlePathIsEscapedAndRequired(t *testing.T) {
	_, exe := fakeBundle(t, "Pass<Vault>&.app")
	m := &Manager{Dir: t.TempDir(), Executable: func() (string, error) { return exe, nil }}
	if _, err := m.Set(true); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(m.Dir, Label+".plist"))
	if strings.Contains(string(b), "Pass<Vault>&") || !strings.Contains(string(b), "Pass&lt;Vault&gt;&amp;.app") {
		t.Fatalf("bundle path not XML-escaped:\n%s", b)
	}
	loose := filepath.Join(t.TempDir(), "pv-helper")
	_ = os.WriteFile(loose, nil, 0o755)
	m2 := &Manager{Dir: t.TempDir(), Executable: func() (string, error) { return loose, nil }}
	if _, err := m2.Set(true); err == nil {
		t.Fatal("a helper outside an app bundle must not create a login item")
	}
}
