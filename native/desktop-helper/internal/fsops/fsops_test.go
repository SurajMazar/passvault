package fsops

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/passvault/desktop-helper/internal/ipc"
)

func dir(t *testing.T) string {
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func code(err error) string {
	if err == nil {
		return ""
	}
	return ipc.AsError(err).Code
}

func TestWriteExportMode0600(t *testing.T) {
	old := syscall.Umask(0)
	defer syscall.Umask(old)
	p := filepath.Join(dir(t), "export.json")
	if err := WriteExport(p, []byte("dummy"), false); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(p)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %o", fi.Mode().Perm())
	}
	// Overwrite of a 0644 file ends 0600.
	os.Chmod(p, 0o644)
	if err := WriteExport(p, []byte("v2"), true); err != nil {
		t.Fatal(err)
	}
	fi, _ = os.Stat(p)
	b, _ := os.ReadFile(p)
	if fi.Mode().Perm() != 0o600 || string(b) != "v2" {
		t.Fatalf("mode %o content %q", fi.Mode().Perm(), b)
	}
}

func TestWriteExportRefusals(t *testing.T) {
	d := dir(t)
	existing := filepath.Join(d, "exists")
	os.WriteFile(existing, []byte("keep"), 0o600)
	if c := code(WriteExport(existing, []byte("x"), false)); c != ipc.CodeDenied {
		t.Errorf("overwrite without flag: %q", c)
	}
	if b, _ := os.ReadFile(existing); string(b) != "keep" {
		t.Error("file modified")
	}
	victim := filepath.Join(d, "victim")
	os.WriteFile(victim, []byte("victim"), 0o644)
	link := filepath.Join(d, "link")
	os.Symlink(victim, link)
	for _, ow := range []bool{false, true} {
		if c := code(WriteExport(link, []byte("x"), ow)); c != ipc.CodeDenied {
			t.Errorf("symlink (overwrite=%v): %q", ow, c)
		}
	}
	if b, _ := os.ReadFile(victim); string(b) != "victim" {
		t.Error("symlink target modified")
	}
	hard := filepath.Join(d, "hard")
	os.Link(victim, hard)
	if c := code(WriteExport(hard, []byte("x"), true)); c != ipc.CodeDenied {
		t.Errorf("hard link: %q", c)
	}
	if c := code(WriteExport(d, []byte("x"), true)); c != ipc.CodeDenied {
		t.Errorf("directory target: %q", c)
	}
	if c := code(WriteExport("relative/path", nil, false)); c != ipc.CodeBadRequest {
		t.Errorf("relative: %q", c)
	}
	if c := code(WriteExport(d+"/a/../b", nil, false)); c != ipc.CodeBadRequest {
		t.Errorf("unclean: %q", c)
	}
	if c := code(WriteExport(filepath.Join(d, "missing", "f"), nil, false)); c != ipc.CodeNotFound {
		t.Errorf("missing parent: %q", c)
	}
	if c := code(WriteExport(filepath.Join(d, "big"), make([]byte, MaxFileBytes+1), false)); c != ipc.CodeBadRequest {
		t.Errorf("too big: %q", c)
	}
}

func TestReadImport(t *testing.T) {
	d := dir(t)
	p := filepath.Join(d, "in.txt")
	os.WriteFile(p, []byte("hello"), 0o600)
	b, err := ReadImport(p, 100)
	if err != nil || string(b) != "hello" {
		t.Fatal(b, err)
	}
	if c := code(func() error { _, err := ReadImport(p, 3); return err }()); c != ipc.CodeBadRequest {
		t.Errorf("over maxBytes: %q", c)
	}
	link := filepath.Join(d, "l")
	os.Symlink(p, link)
	if _, err := ReadImport(link, 100); code(err) != ipc.CodeDenied {
		t.Errorf("symlink: %v", err)
	}
	if _, err := ReadImport(d, 100); code(err) != ipc.CodeDenied {
		t.Errorf("dir: %v", err)
	}
	fifo := filepath.Join(d, "fifo")
	if syscall.Mkfifo(fifo, 0o600) == nil {
		if _, err := ReadImport(fifo, 100); code(err) != ipc.CodeDenied {
			t.Errorf("fifo: %v", err)
		}
	}
	if _, err := ReadImport(filepath.Join(d, "nope"), 100); code(err) != ipc.CodeNotFound {
		t.Errorf("missing: %v", err)
	}
}
