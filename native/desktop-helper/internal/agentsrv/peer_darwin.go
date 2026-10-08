//go:build darwin

package agentsrv

/*
#include <libproc.h>
#include <sys/proc_info.h>
*/
import "C"

import (
	"net"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/unix"
)

// peerInfo identifies the connecting process via LOCAL_PEERPID and
// proc_pidpath. Best effort: this is what the OS reports for the pid at
// connect time; pids can be reused and names are not authenticated.
func peerInfo(c *net.UnixConn) ClientInfo {
	var info ClientInfo
	raw, err := c.SyscallConn()
	if err != nil {
		return info
	}
	_ = raw.Control(func(fd uintptr) {
		pid, err := unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
		if err == nil && pid > 0 {
			info.PID = pid
		}
	})
	if info.PID == 0 {
		return info
	}
	buf := make([]byte, C.PROC_PIDPATHINFO_MAXSIZE)
	n := C.proc_pidpath(C.int(info.PID), unsafe.Pointer(&buf[0]), C.uint32_t(len(buf)))
	if n > 0 {
		info.ProcessPath = string(buf[:n])
		info.ProcessName = filepath.Base(info.ProcessPath)
		return info
	}
	if kp, err := unix.SysctlKinfoProc("kern.proc.pid", info.PID); err == nil {
		name := kp.Proc.P_comm[:]
		end := 0
		for end < len(name) && name[end] != 0 {
			end++
		}
		b := make([]byte, end)
		for i := 0; i < end; i++ {
			b[i] = byte(name[i])
		}
		info.ProcessName = string(b)
	}
	return info
}
