// Command pv-helper is PassVault's Neutralinojs extension providing native
// capabilities (Keychain/Touch ID, SSH, SSH agent, owner-only files, system
// lock/sleep events, external terminal launch). See docs/DESKTOP_IPC.md and
// docs/DESKTOP_HELPER.md.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/passvault/desktop-helper/internal/app"
	"github.com/passvault/desktop-helper/internal/logx"
	"github.com/passvault/desktop-helper/internal/neutralino"
	"github.com/passvault/desktop-helper/internal/sshconn"
	"github.com/passvault/desktop-helper/internal/sysevents"
)

var version = "dev"

// The main goroutine stays on the main OS thread, which sysevents dedicates
// to the AppKit/CF run loop; the helper itself runs on other goroutines.
func init() { runtime.LockOSThread() }

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Println(version)
		return
	}
	sysevents.RunMain(func() int { return run(os.Stdin, defaultOptions()) })
}

type options struct {
	logDir     string
	logStderr  bool
	parentPoll time.Duration
	app        app.Config
}

func defaultOptions() options {
	o := options{logStderr: true, parentPoll: 2 * time.Second}
	if home, err := os.UserHomeDir(); err == nil {
		o.logDir = filepath.Join(home, "Library", "Logs", "PassVault")
	}
	o.app = app.Config{Version: version, SSH: sshconn.DefaultConfig()}
	return o
}

func run(stdin io.Reader, o options) int {
	var ws []io.Writer
	if o.logStderr {
		ws = append(ws, os.Stderr)
	}
	if o.logDir != "" {
		if f, err := logx.OpenFile(o.logDir); err == nil {
			defer f.Close()
			ws = append(ws, f)
		}
	}
	log := logx.New(io.MultiWriter(ws...))
	log.Info("starting")

	auth, err := neutralino.ReadAuth(stdin)
	if err != nil {
		log.Code("invalid bootstrap payload on stdin", "bad_request")
		return 2
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tr, err := neutralino.Dial(ctx, auth)
	if err != nil {
		log.Code("cannot connect to neutralino", "connect_failed")
		return 3
	}
	o.app.Log = log
	a := app.New(tr, o.app)

	// Exit on SIGTERM/SIGINT/SIGHUP.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer signal.Stop(sigs)
	go func() {
		select {
		case <-sigs:
			log.Info("signal received")
			cancel()
		case <-ctx.Done():
		}
	}()

	// Orphan guard. Neutralino closes the extension's stdin right after
	// writing the bootstrap JSON, so stdin EOF is NOT a liveness signal; the
	// WebSocket and the parent pid are.
	if o.parentPoll > 0 {
		ppid := os.Getppid()
		go func() {
			t := time.NewTicker(o.parentPoll)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					if p := os.Getppid(); p != ppid || p == 1 {
						log.Info("parent process changed; exiting")
						cancel()
						return
					}
				}
			}
		}()
	}

	err = tr.Run(ctx, func(event string, data json.RawMessage) {
		switch event {
		case "pv.request":
			a.D.Handle(data)
		case "windowClose":
			log.Info("windowClose received")
			cancel()
		}
	}, func(reply neutralino.Inbound) {
		var r struct {
			Data struct {
				Error *struct {
					Code string `json:"code"`
				} `json:"error"`
			} `json:"data"`
		}
		if json.Unmarshal(mustJSON(reply), &r) == nil && r.Data.Error != nil {
			log.Code("native call failed", r.Data.Error.Code)
		}
	})
	if ctx.Err() == nil {
		log.Info("neutralino socket closed")
	}
	cancel()
	a.Shutdown()
	_ = tr.Close()
	log.Info("stopped")
	return 0
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
