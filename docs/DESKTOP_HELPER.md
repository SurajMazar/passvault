# PassVault desktop helper (`pv-helper`)

`native/desktop-helper` is a Go program that runs as a **Neutralinojs extension**
(extension id `io.passvault.helper`). It gives the macOS desktop app the native
features Neutralinojs does not have: Keychain and Touch ID, SSH sessions, an SSH
agent, owner-only file export and import, lock/sleep notifications, and launching
an external terminal. The wire contract is in [`DESKTOP_IPC.md`](./DESKTOP_IPC.md).
Changes to that contract are listed under [Contract deviations](#contract-deviations).

## Why Go

- **Memory safety.** The helper handles passwords, private keys and untrusted
  network input. A memory-safe language with a strong standard library removes a
  whole class of bugs.
- **Maintained SSH stack.** `golang.org/x/crypto/ssh` is a widely used, actively
  maintained SSH implementation. It covers the client, server (used for tests),
  key formats including OpenSSH `openssh-key-v1` with bcrypt KDF, and the
  `ssh/agent` protocol. We do not hand-roll SSH crypto.
- **cgo only where macOS requires it.** Objective-C via cgo is used only for
  Security.framework (Keychain), LocalAuthentication (Touch ID availability),
  AppKit/Foundation notifications (lock/sleep) and `libproc` (agent peer process
  path). These files are darwin-only behind build tags. Other platforms get stubs
  that return `unavailable`, so `go vet` and `go test` work anywhere.
- **Simple builds.** One static-ish binary, cross-compiled per architecture and
  merged with `lipo`.

## Dependencies

| Module | Version | License | Use |
|---|---|---|---|
| `golang.org/x/crypto` | v0.55.0 | BSD-3-Clause | `ssh`, `ssh/agent` |
| `golang.org/x/sys` | v0.47.0 | BSD-3-Clause | `LOCAL_PEERPID` getsockopt, `kern.proc` sysctl |
| `github.com/coder/websocket` | v1.8.14 | ISC | Neutralino WebSocket connection |

The Go toolchain is 1.25 (`GOTOOLCHAIN=local`). x/crypto v0.55.0 is the newest
release that supports Go 1.25; v0.56 and later require Go 1.26. Everything else
comes from the standard library and Apple system frameworks.

## Neutralino extension protocol (verified)

Verified on 2026-10-08 against the docs and the Neutralinojs server source:

- <https://neutralino.js.org/docs/how-to/extensions-overview/>
- <https://neutralino.js.org/docs/api/extensions/>
- <https://neutralino.js.org/docs/configuration/neutralino.config.json/>
- <https://neutralino.js.org/docs/api/events/>
- Source files: `extensions_loader.cpp`, `server/neuserver.cpp`,
  `api/events/events.cpp`, `api/extensions/extensions.cpp`,
  `api/window/window.cpp`, `server/router.cpp` (neutralinojs/neutralinojs `main`).

| Expected | Verified |
|---|---|
| JSON on stdin with `nlPort`, `nlToken`, `nlConnectToken`, `nlExtensionId` | **Confirmed.** All four values are **strings**: `nlPort` is `to_string(port)`. **Correction:** Neutralino closes the extension's stdin right after writing it (`stdInEnd`), so stdin EOF is normal and cannot be used to detect an orphaned helper. |
| Connect to `ws://127.0.0.1:<nlPort>?extensionId=<id>&connectToken=<tok>` | **Confirmed.** The docs show `localhost`. The server accepts a Host of `localhost` or `127.0.0.1` (it does not check the port) and binds to 127.0.0.1. It validates the connect token and that the extension id is a loaded extension, and parses both parameters with `[\w.\-_]+`. |
| The extension receives `{event, data}` | **Confirmed.** `extensions.dispatch` → `events::dispatchToExtension` → `{"event","data"}`. If the extension is not connected yet, the client library queues `dispatch` calls. The extension also receives framework events sent through `events::dispatch` (for example `windowClose`, `windowFocus`, `extClientConnect`) and `{id, method, data}` replies to its own native calls. The helper ignores everything except `pv.request` and `windowClose`. |
| Send `{id, method:"app.broadcast", accessToken:nlToken, data:{event,data}}` | **Confirmed.** `id` is a UUIDv4. `router::executeNativeMethod` checks the access token, then API access and method permissions. **If `apps/desktop` sets `nativeAllowList`, it must include `app.broadcast`** (for the helper) and `extensions.dispatch` (for the UI). |
| Exit on `windowClose` or socket close | **Confirmed.** Neutralino does **not** kill extensions when it exits; extensions must exit when the socket closes. `windowClose` reaches extensions (via `events::dispatch`, which also broadcasts to extensions) **only when `exitProcessOnClose` is false**. Otherwise the app exits and the socket closes. |

The client library is `@neutralinojs/lib` 6.x and the CLI is `neu` v11.
Suggested config for `apps/desktop/neutralino.config.json`. Quote the path,
because Neutralino starts the command through a shell and the app path may
contain spaces:

```json
"enableExtensions": true,
"extensions": [
  { "id": "io.passvault.helper",
    "commandDarwin": "\"${NL_PATH}/extensions/pv-helper/pv-helper\"" }
]
```

## Architecture

```
cmd/pv-helper        main: bootstrap, signals, parent-pid guard, lifecycle
internal/neutralino  stdin bootstrap, WebSocket transport, in-memory TestTransport
internal/ipc         envelope, single-session binding, op registry (strict decoding, size limits)
internal/app         op handlers wiring all components (testable without Neutralino)
internal/sshconn     app-managed SSH: host keys, auth, jump host, PTY shell, keepalive
internal/sshkeys     keygen / inspect / parsing / best-effort zeroing
internal/agentsrv    SSH agent (ExtendedAgent) on a private unix socket
internal/keychain    Keychain + LocalAuthentication (darwin cgo / stub)
internal/sysevents   lock/sleep notifications (darwin cgo / stub)
internal/term        external Terminal/iTerm launch
internal/fsops       owner-only export, bounded import
internal/validate    host/port/username/id validators (mirror packages/validation)
internal/logx        narrow logger (ops, ids, codes only)
internal/testutil/sshtest  in-process SSH server used by tests
```

**IPC handling.**

- Each `pv.request` is decoded with `DisallowUnknownFields`. This applies to the
  envelope and to the op parameters, including nested objects.
- Requests are limited to 8 MiB. Above that the helper returns `bad_request`;
  the socket read limit is 32 MiB, so oversize requests get an error reply
  instead of killing the connection. Fields have their own limits
  (`packages/validation` sizes).
- The `sessionId` is compared in constant time.
- Ops that must stay in order run inline on the read loop: `ssh.write`,
  `ssh.resize`, `ssh.hostKeyDecision`, `ssh.promptResponse` and
  `agent.signDecision`. They never block, because writes and resizes go through
  a per-connection queue. All other ops run on their own goroutine.

**Validation.**

- `isValidHost`, `USERNAME_RE` and the 1–65535 port range are mirrored exactly.
  Go has no look-around, so the label rule is coded explicitly.
- Values are **not trimmed**: surrounding whitespace is rejected.
- A leading `-` is never accepted.
- `connId`, `keyId` and request ids must match `^[A-Za-z0-9_.:-]{1,128}$`.

## Threat model of the IPC

**What Neutralino's tokens protect.**

- The WebSocket listens only on 127.0.0.1.
- An extension connection needs the per-launch `connectToken`, and the
  extension id must belong to a loaded extension.
- Native calls need `nlToken`. With `tokenSecurity: one-time`, the UI gets the
  token once, so a second browser client cannot reuse it.
- Other local users, and same-user processes that don't have these tokens,
  cannot inject `pv.request` or read `pv.response` / `pv.event`.

**Inside the helper.**

- Any op except `hello` needs the current random 128-bit `sessionId`.
- Resources (connections, prompts, sign requests) belong to the session that
  created them. Decisions from another session are rejected.
- A new `hello` tears down the previous session.
- There is no generic command execution. The only child process is
  `/usr/bin/open`, started with an argv slice.

**Residual risk.**

- Any code running as the same user that can debug or attach to the Neutralino
  process, the WebView or `pv-helper` can read the tokens and secrets in memory.
  This also applies to anyone who can replace the app bundle files or inject
  into the WebView (XSS in the UI).
- A signed, hardened-runtime build without the `get-task-allow` entitlement
  stops ordinary same-user `task_for_pid` attachment. A root user or an
  admin-approved debugger can still attach.
- Malware running as the user can also connect to the agent socket. It still
  has to get each signature approved in the UI.

**Secrets handling.**

- Secrets travel only inside IPC messages. They never appear in argv, in the
  environment, or in files. The external-terminal files contain no secrets.
- Secrets are never logged:
  - `logx` can record only constant messages (type `logx.Msg`), sanitized op
    names and request ids, and error codes.
  - `TestLogsContainNoSecrets` runs password and keyboard-interactive/OTP
    sessions, terminal input, keygen/inspect with passphrases, `agent.addKey`,
    file export/import and malformed requests that carry secrets, then checks
    that none of the secrets (or their base64 forms) appear in the log.

**Memory limits.**

- Go strings are immutable, and the GC may copy or move memory, so erasing
  memory is best effort only.
- Helper-owned `[]byte` buffers are cleared after use: base64-decoded
  secrets, SSH write buffers, keychain C buffers (zeroed before `free`).
- Private keys held by the agent, or parsed for a connection, are zeroed with
  `sshkeys.Zero` when they are removed or locked, or after the handshake. This
  covers ed25519 seeds and the `big.Int` words of RSA/ECDSA keys.
- Copies inside `x/crypto` internals and JSON decoding cannot be guaranteed
  erased.

## Capabilities, behavior and limits

### Keychain and biometrics

- **Service.** All items use the service `io.passvault.desktop`. Accounts must
  match `^pv\.[a-z0-9._-]{1,64}$`.
- **Non-biometric items** go into the default (file-based) keychain. Their ACL
  trusts the binary that created them.
  - An ad-hoc-signed helper gets a new code hash on every rebuild, so macOS may
    ask "pv-helper wants to access…".
  - A Developer ID–signed helper keeps a stable designated requirement and does
    not trigger that prompt.
- **Biometric items** go into the data-protection keychain
  (`kSecUseDataProtectionKeychain`) with this access control:
  `SecAccessControlCreateWithFlags(kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, kSecAccessControlBiometryCurrentSet)`.
  - On read, the system shows the Touch ID prompt (`LAContext.localizedReason`
    set to `reason`). The key is released only by the keychain after a
    successful match.
  - There is **no** UI-only LAContext gate.
  - If the user cancels or authentication fails, the op returns `denied`.
  - Enrolling a new fingerprint invalidates the item (`BiometryCurrentSet`).
- **`biometric.status`** has two parts:
  1. `LAContext canEvaluatePolicy(DeviceOwnerAuthenticationWithBiometrics)`.
     If this fails, the reason comes from `LAError`.
  2. An entitlement probe. It **adds and deletes an empty marker item** in the
     data-protection keychain. A read-only probe is not enough: on this unsigned
     build, reads return `errSecItemNotFound`, and only `SecItemAdd` returns
     `errSecMissingEntitlement (-34018)`.
- **On this unsigned build** the result is
  `{available:false, reason:"requires a signed build with keychain entitlement"}`.
  - `keychain.set` with `biometric:true` returns `unavailable` with that reason.
  - It checks this *before* deleting any existing item.
  - It never falls back to a non-biometric item.

### SSH sessions (`ssh.connect`)

- **Auth methods.**
  - `password`.
  - `key`: OpenSSH, PKCS#1/#8 and encrypted keys. A missing or wrong passphrase
    returns `bad_request` synchronously.
  - `agent`: uses the helper's in-memory agent keys. This needs no per-signature
    approval, because the user started this connection in the app. While the
    agent is locked it returns `unavailable`.
  - `keyboard_interactive`: every prompt goes to the UI as `ssh.prompt`, with
    each question's echo flag. The stored password is never sent automatically.
    Answer count must match the question count. Cancel and timeout (5 min) fail
    with `auth_failed`. Rounds with zero questions are answered empty without a
    prompt.
- **Host keys** are checked for every hop, in `HostKeyCallback`:
  - Key matches a trusted key (type plus wire bytes): continue.
  - No trusted keys: emit `ssh.hostKey` with status `unknown`
    (`SHA256:` fingerprint) and block until `ssh.hostKeyDecision`. After a
    2-minute timeout the key is rejected.
  - Trusted keys exist but none match: emit status `mismatch`, then an error
    with code `host_key_mismatch`. This can never be overridden, because there
    is no pending decision to answer.
  - `HostKeyAlgorithms` lists the trusted key types first, so the server
    presents a key we can compare.
  - `InsecureIgnoreHostKey` is never used.
- **Jump host.**
  1. Dial the jump host, verify its key, authenticate.
  2. Open the target through `client.DialContext` and call `ssh.NewClientConn`,
     verifying the target's key separately.
- **Terminal.** The helper requests `pty-req` (`xterm-256color`, rows/cols)
  and then `shell`.
  - Remote output arrives as `ssh.data` (base64, up to 32 KiB per chunk).
  - `ssh.write` sends to stdin.
  - `ssh.resize` sends `window-change`.
  - **No local shell or local PTY is ever spawned.** The embedded terminal
    shows the remote PTY.
  - Saved commands are never executed automatically.
  - Agent forwarding and X11 are never requested.
- **Keepalives.** `keepalive@openssh.com` every 30 s. After 3 failures the
  connection reports an `io_error` and closes.
- **Lifecycle.**
  - Every connection ends with `ssh.state: closed`.
  - Failures first emit `ssh.state: error` with `{code, message}`.
  - `ssh.exit` reports `exitStatus` or `signal`.
  - `ssh.disconnect`, `vault.locked`, a new `hello` or exit closes the client
    and waits until all goroutines of that connection have exited. Tests check
    this with done channels and goroutine counts.

### SSH agent

- **Socket.** `~/Library/Application Support/PassVault/agent/agent.sock`. The
  `PV_AGENT_SOCKET_DIR` environment variable overrides it (tests only).
  - The directory is created 0700 and tightened if it is wider.
  - The helper refuses to start if the directory is a symlink, is not a
    directory, or is owned by someone else.
  - A stale socket is removed only if it is our own socket and nobody is
    listening on it. A live agent or a non-socket file at that path is refused.
  - The socket is chmod'ed to 0600.
  - On stop, the socket is removed only if its inode is still ours.
- **Lock state.**
  - The agent starts **locked**.
  - `agent.addKey` unlocks it, since keys only come from an unlocked vault.
  - `vault.locked` or a new `hello` locks it: all keys are removed and zeroed,
    timed grants are revoked, pending requests are denied, and new signatures
    are refused.
- **Socket clients.**
  - `List` returns keys only while unlocked.
  - `Add`, `Remove`, `RemoveAll`, `Lock`, `Unlock` and `Signers` are refused.
- **Approval.** `Sign` and `SignWithFlags` (rsa-sha2-256/512 supported) need an
  unlocked agent and an approval:
  - The helper emits `agent.signRequest` and waits for `agent.signDecision`.
  - `deny`.
  - `once`.
  - `timed` (1–60 minutes, per key; lost on lock and when the key is re-added).
  - No answer within 2 minutes, or no UI session, means deny.
- **Client identity.** Comes from `LOCAL_PEERPID` plus `proc_pidpath`, with the
  `kern.proc` name as a fallback. This is what the OS reports at connect time.
  It is not authenticated, and pids can be reused.
- **Destination (`session-bind@openssh.com`).**
  - The helper parses the bind and verifies the host key's signature over the
    session id. Up to 16 binds are kept per connection.
  - If the bind verified and the signature request's session id matches the
    last bind, the request carries `{verified:true, hostKeyFingerprint}`, with
    a note that this identifies only the server's host key.
  - Otherwise it carries
    `{verified:false, note:"The SSH agent protocol does not reliably identify the destination"}`.
  - Any `is_forwarding` bind means the request is **denied without a prompt**,
    because agent forwarding is disabled.
  - On a bound connection, a request for a different session is denied (the
    same policy as OpenSSH `ssh-agent`).
- **Locking does not end existing sessions.** Sessions that already
  authenticated (external `ssh` processes, or other tools using the socket)
  stay connected. Locking only stops new signatures.

### Key generation and inspection

- **`ssh.keygen`:**
  - Algorithms: `ed25519` (`crypto/ed25519`), `ecdsa-p256`, `rsa-3072`,
    `rsa-4096`.
  - Private key in OpenSSH format (`ssh.MarshalPrivateKey[WithPassphrase]`).
  - Public key in authorized_keys format with the comment.
  - SHA256 fingerprint.
- **`ssh.inspectKey`:**
  - Validates imported keys.
  - Reports `encrypted` from `*ssh.PassphraseMissingError`, and uses the
    embedded public key when no passphrase is given.
  - Checks that a supplied public key matches the private key.
  - Extracts the comment from unencrypted `openssh-key-v1` keys.

### External terminal (`term.openExternal`)

- **Files.** The helper creates a 0700 temp directory containing:
  - `known_hosts`, built from the trusted keys only. If no keys are trusted for
    any hop, the op is refused with `host_key_unknown`.
  - `ssh_config` (0600).
  - `pv-ssh.command` (0700).
- **Options.** `Host *` with:
  - `UserKnownHostsFile=<file>`
  - `GlobalKnownHostsFile=/dev/null`
  - `StrictHostKeyChecking=yes`
  - `UpdateHostKeys=no`
  - `ForwardAgent=no`
  - `ForwardX11=no`
  - `PermitLocalCommand=no`
  - `IdentityAgent=<our socket>` when `useAgent`
- **Why `-F`.** The options are passed with `-F` **and** as `-o`. OpenSSH passes
  `-F` on to the ProxyJump ssh process but **not** `-o` options. Without `-F`
  the jump hop would fall back to the user's `~/.ssh/known_hosts` and to
  interactive host-key acceptance.
- **Side effects of `-F`.**
  - It replaces `~/.ssh/config` for these sessions.
  - The helper never reads or writes `~/.ssh`.
  - `IdentitiesOnly=yes` is not set: with no IdentityFile it would hide the
    agent keys.
- **Script contents.**
  - Fixed text plus single-quoted, pre-validated arguments:
    `/usr/bin/ssh -F … -o … -p PORT [-J user@jump:port] -l USER -- HOST`.
  - It never contains a password or a key.
  - It marks itself as started, runs ssh, then deletes the temp directory.
  - If the script never runs, the helper removes the directory after 2 minutes.
- **Launch.** `/usr/bin/open -a Terminal|iTerm <script>`, run through
  `exec.Command` with a minimal environment and no shell.
- **Externally launched sessions are not closed by vault lock.** They are
  separate processes. Locking only stops agent signing.

### Files

- **`fs.writeExport`:**
  - The path must be absolute and normalized, and the parent directory must
    exist.
  - Opened with `O_WRONLY|O_CREAT|O_NOFOLLOW|O_NONBLOCK`, plus `O_EXCL` unless
    `overwrite` is set.
  - After opening, the helper checks with `fstat` that the target is a regular
    file, has exactly one hard link, and is owned by the user.
  - Then `fchmod 0600`, truncate, write, `fsync`.
  - Symlinks, non-regular files and multiply-linked files are refused.
- **`fs.readImport`:**
  - `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`.
  - Regular files only.
  - At most `min(maxBytes, 5 MiB)`.

### System events

- `com.apple.screenIsLocked` and `com.apple.screenIsUnlocked` come from
  `NSDistributedNotificationCenter`.
- `NSWorkspaceWillSleepNotification` and `NSWorkspaceDidWakeNotification` come
  from the NSWorkspace notification center.
- They are forwarded as `system.event`.
- Observers are registered on the process **main thread**, which is reserved
  for a `CFRunLoopRun()` loop. `main` locks its goroutine to the main thread in
  `init`, and the helper itself runs on other goroutines. NSWorkspace
  notifications are delivered on the main thread, so this is the reliable
  choice.
- The helper does not lock the vault by itself. The UI decides and calls
  `vault.locked`.

### Logging and lifecycle

- **Logs** go to stderr and to `~/Library/Logs/PassVault/helper.log`: the file
  is 0600, the directory 0700, the file is opened with `O_NOFOLLOW`, and it is
  rotated at 5 MiB.
- **Exit triggers:**
  - the WebSocket closes;
  - `windowClose`;
  - SIGTERM, SIGINT or SIGHUP;
  - the parent pid changes or becomes 1 (checked every 2 s).
- **On exit:**
  - the session ends, so SSH sessions close and agent keys are removed;
  - the agent stops and its socket is removed;
  - the socket is closed.

## Build and test

```sh
cd native/desktop-helper
make test        # go test -race -count=1 ./...
make vet         # go vet ./...
make build       # bin/pv-helper (host arch)
make universal   # bin/pv-helper-{arm64,amd64} → lipo → bin/pv-helper-universal (+ lipo -info, file, minos)
make sign IDENTITY="Developer ID Application: … (TEAMID)" TEAM_ID=TEAMID
```

- Build flags: `-trimpath -ldflags "-s -w -X main.version=$(VERSION)"`,
  `CGO_ENABLED=1`, `CC="clang -arch …"` per architecture.
- Minimum macOS: `CGO_CFLAGS/LDFLAGS=-mmacosx-version-min=12.0` and
  `MACOSX_DEPLOYMENT_TARGET=12.0`.
- `PV_SKIP_KEYCHAIN_TESTS=1` skips the tests that write to the real login
  keychain (`pv.test.helper-selftest`, which they delete afterwards).

### Signing

- `entitlements.plist` is a template. It contains `keychain-access-groups` =
  `$(TEAM_ID).io.passvault.desktop`, plus the application identifier and team
  id that the group is checked against.
- Sign with
  `codesign --force --timestamp --options runtime --entitlements … --sign "Developer ID Application: …"`.
- The hardened runtime needs no exception entitlements.
- On macOS, `keychain-access-groups` and `application-identifier` are
  restricted entitlements and must be authorized by an embedded provisioning
  profile. A bare command-line binary cannot carry one. To make biometric
  unlock work, package the helper as a bundle with an Info.plist and an
  `embedded.provisionprofile`, for example
  `PassVault.app/Contents/Helpers/PassVault Helper.app/Contents/MacOS/pv-helper`.
  Then notarize the outer app.
- Until then, the helper correctly reports biometrics as unavailable.

## Test results (2026-10-08, macOS 26 arm64, Go 1.25.0)

`go vet ./...` is clean. `GOOS=linux CGO_ENABLED=0` also passes vet and builds,
which exercises the stubs. `go test -race -count=1 ./...` gives **52 tests
passing, 0 failing, 0 skipped**, in these packages: `cmd/pv-helper`,
`agentsrv`, `app`, `fsops`, `keychain`, `sshconn`, `sshkeys`, `sysevents`,
`term`, `validate`.

Coverage includes:

- host keys:
  - unknown → event → trust → connected;
  - reject or timeout → `host_key_unknown`;
  - mismatch → `host_key_mismatch`, with the server seeing zero auth attempts
    and no password;
- jump host: both hops prompted and verified; a jump-hop mismatch aborts with no
  forwarding and no target traffic;
- authentication:
  - password, and wrong password → `auth_failed`;
  - passphrase-protected ECDSA key;
  - keyboard-interactive with password plus an OTP round, wrong answer count
    rejected, cancel → `auth_failed`, stored password never sent;
  - agent-key auth;
- PTY and shell:
  - pty-req dimensions and window-change recorded by the server;
  - echo round trip;
  - remote exit status;
  - disconnect and CloseAll with done channels and goroutine-leak checks;
  - `vault.locked` closes sessions;
- agent:
  - 0700 dir and 0600 socket;
  - stale-socket handling and refusal on a symlinked dir;
  - List empty while locked;
  - deny / once / timed (> 60 rejected), timeout → deny;
  - foreign-session decision rejected;
  - lock revokes keys, grants and pending requests;
  - mutating requests from socket clients refused;
  - session-bind verified / unverifiable / forwarded (denied without a prompt);
  - real `ssh` client auth through the socket;
  - peer pid equals the test process;
- IPC:
  - unknown op;
  - unknown envelope, param and nested fields;
  - bad version;
  - missing, foreign and stale session;
  - second hello tears down connections;
  - `-oProxyCommand=x`, `a;b`, `$(id)` and bad usernames rejected by
    connect, test and term;
  - requests over 8 MiB rejected;
- external terminal:
  - script lines match a quoted-args-only grammar;
  - no secrets in script, config, known_hosts or argv;
  - refused without trusted keys;
  - `ssh -G` confirms the effective options, including ProxyJump;
- files: 0600 mode even under umask 0 and on overwrite; symlink, hard link,
  directory and FIFO refused; overwrite needs the flag;
- keychain: real set/get/overwrite/delete; the biometric probe reports
  `-34018` / "requires a signed build with keychain entitlement" and stores no
  fallback item;
- system events: a test-only distributed notification is delivered through the
  main-thread run loop (the real `com.apple.screenIsLocked` is never posted);
- logs contain no secrets;
- end-to-end against a fake Neutralino server: bootstrap, `127.0.0.1` Host,
  `app.broadcast` with `accessToken`, exit on `windowClose` (agent socket
  removed) and on socket close.

### Universal build output

```
$ lipo -info bin/pv-helper-universal
Architectures in the fat file: bin/pv-helper-universal are: x86_64 arm64
$ file bin/pv-helper-universal
bin/pv-helper-universal: Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64]
bin/pv-helper-universal (for architecture x86_64):	Mach-O 64-bit executable x86_64
bin/pv-helper-universal (for architecture arm64):	Mach-O 64-bit executable arm64
arm64 minos: 12.0
x86_64 minos: 12.0
```

Both architecture slices run `--version` (x86_64 under Rosetta). With Xcode 26,
the linker prints harmless warnings: `ignoring duplicate libraries: '-lobjc'`,
and `malformed LC_DYSYMTAB` for race-enabled test binaries.

## Contract deviations

These are minimal additions and clarifications to `DESKTOP_IPC.md` that the UI
should follow:

1. **`ssh.state` adds `code?`.** When `state: 'error'`, the event carries an
   error code (`host_key_mismatch`, `host_key_unknown`, `auth_failed`,
   `connect_failed`, `io_error`). Every connection ends with `closed`, so an
   error is followed by `closed`. A user disconnect or lock emits only
   `closed`.
2. **`term.openExternal` adds `jumpTrustedHostKeys?: HostKey[]`.** It is
   required when `jump` is set, because one `trustedHostKeys` list cannot say
   which hop a key belongs to. `trustedHostKeys` is for the target. If either
   hop has no keys, the op is refused with `host_key_unknown`. `useAgent:true`
   needs a running agent, otherwise `unavailable`.
3. **`agent.signRequest.client` adds `processPath?`.** This is the full
   executable path; `processName` is its basename.
4. **`ssh.test` never prompts.**
   - Unknown or mismatched host key: `{ok:false, stage:'host_key', hostKey:{…, status}}`.
     The UI asks the user and retries with the key in `trustedHostKeys`.
   - Keyboard-interactive servers: `{ok:false, stage:'auth'}` with an
     explanatory message.
   - Stages are `connect` | `host_key` | `auth` | `done`.
5. **`ping.now`** is Unix epoch milliseconds.
6. **Agent `locked` semantics.**
   - The agent starts locked.
   - `agent.addKey` unlocks it.
   - `vault.locked` and `hello` lock it and remove its keys.
   - `agent.status.socketPath` reports the default path even while the agent
     is stopped.
7. **`ssh.connect` returns `bad_request` synchronously** for an invalid or
   undecryptable `key` credential, and `unavailable` for `agent` auth when no
   agent keys are loaded.
8. **Lifecycle correction.** Stdin EOF is not an exit signal, because
   Neutralino closes stdin after bootstrap. The parent-pid watch is used
   instead.
