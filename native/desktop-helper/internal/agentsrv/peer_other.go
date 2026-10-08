//go:build !darwin

package agentsrv

import "net"

// peerInfo is unavailable off macOS.
func peerInfo(*net.UnixConn) ClientInfo { return ClientInfo{} }
