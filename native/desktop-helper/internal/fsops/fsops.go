// Package fsops implements owner-only export writes and bounded import reads.
package fsops

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/passvault/desktop-helper/internal/ipc"
)

// MaxFileBytes bounds both exports and imports.
const MaxFileBytes = 5 << 20

func checkPath(p string) error {
	if p == "" || len(p) > 1024 || strings.ContainsRune(p, 0) {
		return ipc.Errf(ipc.CodeBadRequest, "invalid path")
	}
	if !filepath.IsAbs(p) || filepath.Clean(p) != p {
		return ipc.Errf(ipc.CodeBadRequest, "path must be absolute and normalised")
	}
	return nil
}

// WriteExport writes content to path with mode 0600. Without overwrite the
// file must not exist (O_EXCL). Symlinks (O_NOFOLLOW), non-regular files and
// multiply-linked files are refused.
func WriteExport(path string, content []byte, overwrite bool) error {
	if err := checkPath(path); err != nil {
		return err
	}
	if len(content) > MaxFileBytes {
		return ipc.Errf(ipc.CodeBadRequest, "content exceeds 5 MiB")
	}
	fi, err := os.Stat(filepath.Dir(path))
	if err != nil || !fi.IsDir() {
		return ipc.Errf(ipc.CodeNotFound, "parent directory does not exist")
	}
	if li, err := os.Lstat(path); err == nil {
		if !li.Mode().IsRegular() {
			return ipc.Errf(ipc.CodeDenied, "target exists and is not a regular file")
		}
		if !overwrite {
			return ipc.Errf(ipc.CodeDenied, "file exists; set overwrite to replace it")
		}
	}
	flags := syscall.O_WRONLY | syscall.O_CREAT | syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK
	if !overwrite {
		flags |= syscall.O_EXCL
	}
	fd, err := syscall.Open(path, flags, 0o600)
	if err != nil {
		switch err {
		case syscall.EEXIST:
			return ipc.Errf(ipc.CodeDenied, "file exists; set overwrite to replace it")
		case syscall.ELOOP:
			return ipc.Errf(ipc.CodeDenied, "target is a symlink")
		case syscall.EACCES, syscall.EPERM:
			return ipc.Errf(ipc.CodeDenied, "permission denied")
		}
		return ipc.Errf(ipc.CodeIOError, "could not open file")
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return ipc.Errf(ipc.CodeIOError, "stat failed")
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return ipc.Errf(ipc.CodeDenied, "target is not a regular file")
	}
	if st.Nlink > 1 {
		return ipc.Errf(ipc.CodeDenied, "target has multiple hard links")
	}
	if int(st.Uid) != os.Getuid() {
		return ipc.Errf(ipc.CodeDenied, "target is owned by another user")
	}
	if err := syscall.Fchmod(fd, 0o600); err != nil {
		return ipc.Errf(ipc.CodeIOError, "chmod failed")
	}
	if err := syscall.Ftruncate(fd, 0); err != nil {
		return ipc.Errf(ipc.CodeIOError, "truncate failed")
	}
	if _, err := f.Write(content); err != nil {
		return ipc.Errf(ipc.CodeIOError, "write failed")
	}
	if err := f.Sync(); err != nil {
		return ipc.Errf(ipc.CodeIOError, "sync failed")
	}
	return nil
}

// ReadImport reads a regular file of at most min(maxBytes, 5 MiB).
func ReadImport(path string, maxBytes int) ([]byte, error) {
	if err := checkPath(path); err != nil {
		return nil, err
	}
	if maxBytes <= 0 {
		return nil, ipc.Errf(ipc.CodeBadRequest, "maxBytes must be positive")
	}
	limit := min(maxBytes, MaxFileBytes)
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		switch err {
		case syscall.ENOENT:
			return nil, ipc.Errf(ipc.CodeNotFound, "file not found")
		case syscall.ELOOP:
			return nil, ipc.Errf(ipc.CodeDenied, "path is a symlink")
		case syscall.EACCES, syscall.EPERM:
			return nil, ipc.Errf(ipc.CodeDenied, "permission denied")
		}
		return nil, ipc.Errf(ipc.CodeIOError, "could not open file")
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return nil, ipc.Errf(ipc.CodeIOError, "stat failed")
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return nil, ipc.Errf(ipc.CodeDenied, "not a regular file")
	}
	if st.Size > int64(limit) {
		return nil, ipc.Errf(ipc.CodeBadRequest, "file exceeds %d bytes", limit)
	}
	b, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	if err != nil {
		return nil, ipc.Errf(ipc.CodeIOError, "read failed")
	}
	if len(b) > limit {
		return nil, ipc.Errf(ipc.CodeBadRequest, "file exceeds %d bytes", limit)
	}
	return b, nil
}
