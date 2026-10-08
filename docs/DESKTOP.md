# PassVault for macOS (`apps/desktop`)

The desktop app is a **Neutralinojs** shell that hosts the shared React UI
(`@passvault/app`) and a Go helper (`native/desktop-helper`, binary `pv-helper`)
that runs as a Neutralino **extension**. The helper does everything that needs
native access: Keychain, Touch ID, SSH sessions, the SSH agent, owner-only file
export/import, lock/sleep notifications and launching Terminal.app or iTerm.
The wire protocol is in [DESKTOP_IPC.md](./DESKTOP_IPC.md). The helper's own design
and the deviations from that contract are in [DESKTOP_HELPER.md](./DESKTOP_HELPER.md).

- Neutralinojs server **6.10.0** (`neutralino.config.json` → `cli.binaryVersion`)
- client library `@neutralinojs/lib` **6.10.0** (npm, bundled by Vite)
- Vite 7.3.7, React 19.3.0, Tailwind 4.3.3
- xterm.js `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-web-links` 0.12.0

## Architecture

```
PassVault.app/Contents
├── MacOS/PassVault          launcher (C): execv → passvault-shell --path=<…>/Contents/Resources
├── MacOS/passvault-shell    Neutralinojs binary (WKWebView window + local HTTP/WebSocket server on 127.0.0.1:47391)
├── MacOS/pv-helper          Go helper, started by Neutralino as extension io.passvault.helper
│   (or Helpers/PassVault Helper.app/Contents/MacOS/pv-helper with HELPER_LAYOUT=bundle)
├── Resources/resources.neu  bundled UI (resources/app) + neutralino.config.json + icons
└── Resources/PassVault.icns
```

```
┌──────────── WKWebView (http://127.0.0.1:47391, CSP) ─────────────┐
│ @passvault/app UI  +  desktop adapter (src/platform, src/desktop) │
└──────────────┬────────────────────────────────────────────────────┘
               │ WebSocket, NL_TOKEN (one-time)          native calls limited by nativeAllowList
┌──────────────▼──────────────┐   extensions.dispatch('io.passvault.helper','pv.request', Request)
│ Neutralino server (C++)     │◄──────────────────────────────────────────────────────────┐
│ 127.0.0.1:47391             │   app.broadcast('pv.response' | 'pv.event')                │
└──────────────┬──────────────┘                                                           │
               │ WebSocket, per-launch connect token                                      │
┌──────────────▼──────────────────────────────────────────────────────────────────────────┴┐
│ pv-helper (Go): Keychain/Touch ID · SSH (x/crypto/ssh) · agent socket · fs export/import │
│ · NSWorkspace/NSDistributedNotificationCenter lock+sleep events · /usr/bin/open Terminal │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

Source layout (`apps/desktop/src`):

| Path | Purpose |
|---|---|
| `main.tsx` | boot: Neutralino init, helper client, platform, controller, extensions, render |
| `neutralino.ts` | typed subset of the Neutralino API (`NeutralinoLike`) + the helper transport |
| `ipc/helper-client.ts` | request/response correlation, per-op timeouts, session binding, error mapping |
| `desktop/helper-connection.ts` | `extClientConnect/Disconnect`, `hello`, re-`hello` on `invalid_session`, 30 s `ping` |
| `desktop/controller.ts` | terminal tabs, host-key / prompt / sign-request queues, agent, lock hook |
| `platform/*` | `Platform` adapter: Keychain tokens, Neutralino storage, clipboard, files, biometrics, links |
| `ssh/hops.ts`, `ssh/host-keys.ts` | building helper `Hop`s from vault items; trusted-key persistence |
| `terminal/*` | xterm.js host, paste guard |
| `shell/native-shell.ts` | macOS main menu, menu-bar (tray) menu, window close / quit |
| `ui/*` | Terminal view, dialogs, settings sections, status banner |
| `extensions.tsx` | `AppExtensions` passed to `PassVaultApp` |

### Boot sequence

1. `__neutralino_globals.js` (same origin) sets `NL_PORT`, `NL_TOKEN`, … The token is
   served **once** (`tokenSecurity: "one-time"`).
2. `Neutralino.init()` opens the WebSocket. `HelperConnection.start()` checks
   `extensions.getStats`, then sends `hello` (or waits ≤ 10 s for `extClientConnect`).
3. `PassVaultApp` creates the `VaultSession`. `session.init()` reads the session token
   from the Keychain through the helper (bounded wait of 8 s for the helper).
4. In window mode, the main menu, menu-bar menu and window events are installed.

## Trust boundaries

| Boundary | Protection |
|---|---|
| Web content → native | Only the bundled UI is loaded (`documentRoot: /resources/app/`, `url: /`). CSP forbids remote scripts, frames, plugins. `nativeAllowList` limits what even injected script could call. No `os.execCommand`, `os.spawnProcess`, `filesystem.*`, `net.*`, `window.create`. |
| Other local processes → Neutralino | Server binds 127.0.0.1. Native calls need `NL_TOKEN`; one-time token security and `exportAuthInfo: false`. The helper connects with a per-launch connect token (an imposter on the port is rejected: verified when a second instance held the port, the helper got `connect_failed`). |
| UI → helper | Fixed op set, strict decoding (unknown fields rejected), validation, 128-bit session id bound to every request; events of a stale session are dropped by the UI. |
| Remote SSH server → UI | Terminal output is untrusted: xterm only, no clipboard (OSC 52) addon, links go through a confirm dialog and only http(s) reach the helper's `link.open` (no shell). Server prompt text is rendered as plain text. |
| Helper → OS | Secrets only in IPC messages, never in argv/env/files; see DESKTOP_HELPER.md. |

Residual risks: same-user malware that can attach to or inject into the processes,
replace bundle files (on an unsigned/ad-hoc build) or bind 127.0.0.1:47391 before
PassVault starts can read or spoof data. A signed, hardened-runtime build without
`get-task-allow` blocks ordinary debugger attachment.

## Native API allow list

`neutralino.config.json` → `nativeAllowList` (everything else is refused by Neutralino):

| Method | Why |
|---|---|
| `app.exit` | quit after window close / ⌘Q / menu-bar Quit |
| `app.broadcast` | used by the **helper** to deliver `pv.response` / `pv.event` |
| `window.show`, `window.focus`, `window.unminimize` | bring the window forward (menu-bar "Open", agent sign requests, host-key mismatch) |
| `window.setMainMenu` | macOS main menu: Edit menu (⌘C/⌘V/⌘X/⌘A/⌘Z in WKWebView), Lock, Quit |
| `os.showOpenDialog` | choose a file to import (contents are read by the helper's `fs.readImport`) |
| `os.showSaveDialog` | choose an export destination (written by the helper's `fs.writeExport`, 0600) |
| `os.setTray` | menu-bar menu: Open PassVault, Lock vault, Quit |
| `extensions.dispatch` | UI → helper requests |
| `extensions.getStats` | detect whether the helper is loaded/connected (also used by the client library) |
| `storage.getData`, `storage.setData`, `storage.removeData` | non-secret prefs + ciphertext-only offline cache |
| `clipboard.readText`, `clipboard.writeText` | copy, and auto-clear only if the clipboard is unchanged |

Not allowed: `os.open`, `os.execCommand`, `os.spawnProcess`, `os.getEnv(s)`, `os.setEnv`, all
`filesystem.*`, `net.*`, `resources.*`, `server.*`, `custom.*`, `debug.log`,
`window.snapshot`, `clipboard.*Image/HTML`, `storage.getKeys/clear`, `updater`.

**Links are opened by the helper, not by Neutralino.** `os.open` on macOS runs
`open "<url>"` through `/bin/sh`; with `os.open` on the allowlist, any script
that ever ran in the webview could have used it to run shell commands
(security finding PV-SEC-002, see [security/FINDINGS.md](security/FINDINGS.md)).
External links now go: `platform/links.ts` (http/https only, user confirmation,
percent-encoding) → helper op `link.open` (validated again in Go:
http/https with a host, no credentials, no whitespace/control characters) →
`/usr/bin/open <url>` with an argv list, no shell. `os.open` and the unused
`window.hide`, `window.isVisible`, `os.showMessageBox` and `computer.getOSInfo`
were removed from the allowlist; a unit test and the security harness keep it
that way (and also require `app.broadcast`, which the helper needs).

## Content Security Policy

Injected as `<meta http-equiv>` by `vite.config.ts` (`cspPolicy()`), API origin from `VITE_API_URL`
(production builds: `https://vault.example.com`, see [API and web URLs](#api-and-web-urls)):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self';
connect-src 'self' ws://localhost:47391 ws://127.0.0.1:47391 https: http://localhost:* http://127.0.0.1:*;
object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'
```

- `'wasm-unsafe-eval'`: libsodium (WebAssembly), not JS `eval`.
- `'unsafe-inline'` styles: React/xterm inline style attributes.
- The Neutralino client connects to `ws://localhost:47391` (the page origin's host).
- `__neutralino_globals.js` is same-origin. Vite emits no inline scripts (`assetsInlineLimit: 0`).
- Server headers add `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- `window.newWindowPolicy: "custom"`: `target=_blank` requests raise `newWindowRequest` and go through the same confirm-then-`link.open` path.
- Dropped files never navigate the webview. The page context menu (which offers Reload, and a reload loses the one-time token) is disabled except in text fields, selections and the terminal.

## What is stored where

| Data | Location | Protection |
|---|---|---|
| API session token | Keychain, service `io.passvault.desktop`, account `pv.session` (non-biometric) via helper `keychain.*` | Keychain ACL (trusts the helper binary). If the helper is unavailable, the token is kept in memory only. It is never written to Neutralino storage or localStorage. |
| Touch ID device key | Keychain data-protection item `pv.bio.<userId>`, `kSecAccessControlBiometryCurrentSet` | Released only after Touch ID. **Needs a signed build with `keychain-access-groups`.** Unsigned/ad-hoc builds report "requires a signed build with keychain entitlement" (shown in Settings). |
| Offline cache (account bundle, record envelopes, wrapped keys, outbox) | Neutralino storage `~/Library/Application Support/io.passvault.desktop/.storage/pvc_<email-slug>_<hash>_*.neustorage` | **Ciphertext only** (`KeyValueStore` from `@passvault/sync`). Files are 0644 inside `~/Library` (0700). Verified: no plaintext password/key/host found in the files. |
| Preferences (device id, last email) | same directory, `pvp_*.neustorage` | not secret |
| Theme | WebKit localStorage for `http://localhost:47391` | not secret |
| SSH agent keys | helper memory only, while unlocked | removed on lock / `hello` / exit |
| Neutralino log | `~/Library/Application Support/io.passvault.desktop/neutralinojs.log` | errors only, no request data |
| Helper log | `~/Library/Logs/PassVault/helper.log` (0600) | op names, ids, codes only |
| Window position | `~/Library/Application Support/io.passvault.desktop/.tmp/` | not secret |

## Lock behaviour

The vault locks on:

- manual lock (⇧⌘L, menu "Lock Vault", menu-bar "Lock vault", account menu);
- inactivity (`lockTimeoutMinutes`, shared app);
- **screen lock** and **system sleep**: helper `system.event` `screen_locked` / `will_sleep` → `session.lock()`;
- window close or quit, before the app exits.

When it locks, synchronously in `session.onLock`:

1. the helper gets `vault.locked`: it closes every SSH session opened in PassVault,
   removes all agent keys (the agent locks), and cancels pending prompts and sign requests;
2. every terminal tab is marked **"Disconnected because the vault locked"** and
   its xterm instance is disposed (scrollback is wiped);
3. pending host-key, prompt and sign-request dialogs are dropped, and session-only host-key trust is cleared;
4. the clipboard is cleared if it still contains the last copied secret.

**Sessions opened in Terminal.app / iTerm are separate `ssh` processes and are not
terminated by locking.** Locking only stops further agent signatures. The UI says so
in the Desktop app settings and after opening an external session.

## SSH and terminal

- **Connect** (primary action on a Server item) opens a tab in the **Terminal** view
  (sidebar entry, badge = live sessions). ⌘T opens a server picker and ⌘W closes the
  active tab while the Terminal view has focus. Closing a tab disconnects it.
- Hop building (`ssh/hops.ts`):
  - `password` sends the stored password;
  - `key` resolves `sshKeyItemId` to the SSH key item's private key and passphrase;
  - `agent` uses keys loaded in the PassVault agent;
  - `keyboard_interactive` never sends anything automatically.
  - `jumpHostItemId` resolves to that Server item, with its own credentials and trusted keys. Only one jump level is supported.
  - `trustedHostKeys` are the item's `fields.hostKeys` filtered by `host:port`, formatted like Go's `net.JoinHostPort`.
  - Secrets exist only in the single `ssh.connect` / `ssh.test` message.
- **Host keys:**
  - *Unknown key.* A dialog shows host:port, key type and the `SHA256:` fingerprint, with verification instructions. **Trust and connect** sends `ssh.hostKeyDecision {trust:true}` and saves `{keyType, publicKey, fingerprint, hostPort, trustedAt}` into the item (the jump host's key goes into the jump host item). Viewers of shared items can trust for the session only, and the dialog says so.
  - *Changed key (mismatch).* A blocking danger dialog shows the expected and presented fingerprints and explains possible MITM. Nothing is persisted and nothing can be overridden. **Open server settings** leads to the item, where the "Trusted host keys" card now has a **Remove** button with a confirmation. Keys are never replaced automatically.
- **Keyboard-interactive.** A dialog shows the server's name, instruction and questions (password fields when `echo` is false). For hidden questions, a **Fill stored password** button appears only if the item has a password. Cancel sends `{cancel:true}`.
- **Test connection** (`ssh.test`) never prompts. On `stage:'host_key'` the same trust dialog appears and the test is retried with the key trusted.
- **Open in Terminal.app / Open in iTerm** (`term.openExternal`):
  - only non-secret parameters are sent: host, port and user per hop, `trustedHostKeys`, `jumpTrustedHostKeys`, and `useAgent`;
  - key-auth hops first offer to start the PassVault agent and add the key;
  - a hop without a trusted key is refused with a hint to verify inside PassVault first;
  - the helper uses a generated `ssh_config` (`-F`), which replaces `~/.ssh/config` for that session.
- **Terminal safety:**
  - no clipboard/OSC 52 addon, and `allowProposedApi: false`;
  - plain URLs (WebLinksAddon) and OSC 8 hyperlinks (`linkHandler`) go to a confirm dialog, then the helper's `link.open`, and only for http(s);
  - a capture-phase paste listener requires confirmation for pastes with line breaks (showing the line count and first lines) or control characters (stripped before `term.paste`);
  - ⌘T/⌘W are never sent to the PTY;
  - saved commands are never run;
  - terminal content is never logged or stored;
  - output that arrives before the tab's xterm exists is buffered in memory (≤ 2 MiB).
- **Tabs** show the item title, `user@host:port`, the environment badge and the state (connecting / verifying host key / authenticating / connected / closed / error + code), with explanations for `host_key_mismatch`, `auth_failed`, `connect_failed`, `io_error`, and so on.
  - **Production** tabs have a prod-coloured top border, a tinted tab, a **PRODUCTION** badge and a tinted header.
  - Resizes are debounced (120 ms) to `ssh.resize`.

## SSH agent

Settings → **SSH agent**:

- start and stop the agent;
- copy `export SSH_AUTH_SOCK='…/Application Support/PassVault/agent/agent.sock'` (quoted, because the path contains a space);
- list loaded keys, and add or remove each SSH key item that has a private key.

SSH key items also have **Add to SSH agent** / **Remove from SSH agent** actions.
Every signature raises a dialog (window brought to front, requests queued). The dialog shows:

- the key name and fingerprint;
- the requesting process name, path and pid, labelled "reported by macOS; not authenticated";
- the destination: the verified host-key fingerprint only when OpenSSH sent a verifiable `session-bind`, otherwise the helper's note;
- the forwarded flag.

Buttons: **Deny / Allow once / Allow 5 min / Allow 15 min**. Stale requests (the
helper denies after 2 minutes) disappear.

Limitations:

- the agent needs an unlocked vault;
- agent forwarding is refused;
- the destination cannot be reliably identified;
- locking or removing a key does not end sessions that already authenticated.

## Helper lifecycle

- **Unavailable or crashed** (`extClientDisconnect`, ping timeout, failed `hello`):
  - the shell shows a danger banner with **Retry**, and Settings → Desktop app shows versions and capabilities;
  - pending requests fail immediately;
  - live terminal tabs are marked disconnected.
- **Relaunching:** Neutralino starts extensions only at launch, and process spawning is not allow-listed, so a dead helper cannot be relaunched from the UI. The banner tells the user to quit and reopen PassVault. If the helper reconnects (`extClientConnect`), the UI says `hello` again; resources of the old session are gone.
- **Window close / ⌘Q / menu-bar Quit:**
  1. lock (wipes keys, sends `vault.locked`);
  2. clear the clipboard secret if it is unchanged;
  3. `app.exit`.

  Nothing secret is sent. With `exitProcessOnClose: false`, the helper also receives `windowClose` and exits. The helper also exits when its socket closes or its parent dies: verified after `SIGTERM`/`SIGKILL` of the shell.

## Build

Prerequisites:

- macOS 14+ (the Neutralinojs 6.10 binaries have `minos 14.0`);
- Node 24 LTS (`.nvmrc`) and pnpm 10;
- Go 1.27 and the Xcode Command Line Tools (`clang`, `lipo`, `codesign`, `sips`, `iconutil`, `hdiutil`);
- the `neu` CLI v11 (`npm i -g @neutralinojs/neu`).

```sh
pnpm install
pnpm --filter @passvault/desktop typecheck
pnpm --filter @passvault/desktop test          # vitest (54 tests)
pnpm --filter @passvault/desktop build         # frontend only → apps/desktop/resources/app
pnpm --filter @passvault/desktop package       # scripts/build.sh → dist/*.app
```

`scripts/build.sh` does the following:

1. `scripts/fetch-neutralino.sh` downloads `neutralinojs-v6.10.0.zip` from the official GitHub release and **verifies its SHA-256** (the digest GitHub publishes). This replaces `neu update`: neu v11.0.1's downloader extracts the zip before the file is flushed and fails with "end of central directory record signature not found".
2. `tsc` and `vite build --mode production` (URLs from the environment or the gitignored `.env.production`; see “Servers” below).
3. `neu build` in a staging directory. Before it runs, the script checks that the inspector is off and `exportAuthInfo` is false, and sets the helper path.
4. `make -C native/desktop-helper universal`.
5. Builds the universal C launcher, and the `.icns` with `sips` and `iconutil` from `assets/icon-1024.png`. The icons come from `scripts/gen-icons.mjs`, which uses no external tools.
6. Assembles, ad-hoc signs (`codesign --force --sign -`, inner code first) and verifies `dist/PassVault.app` (universal), `dist/arm64/PassVault.app` and `dist/x64/PassVault.app`.

Options:

- `ARCHS="universal arm64 x64"`;
- `HELPER_LAYOUT=bundle` puts the helper at `Contents/Helpers/PassVault Helper.app/…`, which is required for an embedded provisioning profile (Touch ID).

Run: `open apps/desktop/dist/PassVault.app`. Logs:

- `~/Library/Application Support/io.passvault.desktop/neutralinojs.log`
- `~/Library/Logs/PassVault/helper.log`

The server needs port 47391 to be free.

### Server connection (editable at any time)

The app connects to any compatible PassVault server the user chooses, changeable
at any time from **Settings → Server connection** or the sign-in/lock screen
(**Server · … → Change**). Full behaviour, rules and isolation:
[SERVERS.md](SERVERS.md).

- **Default server:** build-time `VITE_PRODUCTION_URL`, or `VITE_API_URL` of a
  production build — read from the gitignored `apps/desktop/.env.production`
  (copy `.env.production.example`) or, in CI, the repository variable
  `PV_PRODUCTION_URL`. It is only the first saved server; never hard-coded in
  the repository, never a restriction.
- **Changing the server** runs the compatibility check first (nothing changes
  if it fails), asks for confirmation when a vault is unlocked, then ends the
  session (`dispose`: keys wiped, SSH sessions closed, agent keys cleared,
  in-flight requests cancelled) and remounts the UI against the new server.
  The previous server stays saved; its data stays encrypted on the Mac.
- **TLS diagnosis:** when the webview cannot connect to an `https://` server,
  the helper's `net.inspectTls` repeats only the TLS handshake with the macOS
  trust store and names the problem (expired, wrong host name, untrusted CA)
  or, if the certificate is fine, the missing CORS entry.
- **Isolation:** each server has its own Keychain session-token account
  (`pv.session.<scope>`), preferences (`pvp_<scope>_*`) and encrypted cache
  (`pvc_<scope>_*`); saved servers in `pvg_servers`. **Remove** deletes a
  saved server's token, prefs and cache (`storage.getKeys` lists key names for
  this; it is on the native allowlist for that reason only).
- **CSP:** `connect-src 'self' ws://localhost:<port> ws://127.0.0.1:<port>
  https: http://localhost:* http://127.0.0.1:*` — any https server the user
  chooses, plain http only on this computer, never `http:` in general or `*`.
  `scripts/build.sh` fails if the built CSP is broader or lacks `https:`.
- To build for another deployment set `VITE_API_URL` / `VITE_WEB_URL`
  (and optionally `VITE_PRODUCTION_URL`) in the environment:

  ```sh
  VITE_API_URL=https://vault.example.com VITE_WEB_URL=https://vault.example.com pnpm --filter @passvault/desktop package
  ```

- The desktop UI's origin is `http://127.0.0.1:47391`, so the CORS allow list
  of every server it connects to must include it (the deploy workflow adds it).

### Menu-bar buddy

PassVault lives in the menu bar (keyhole icon: status, Show Buddy, Open
PassVault, Lock Vault, Settings, Quit). Closing the window keeps it running
there (Settings → Menu bar & buddy).

- **Buddy** (⌃⌥P by default, configurable; Carbon hot key in the helper — no
  Accessibility permission): a small assistant panel above every app, on every
  desktop and over full-screen apps. It shares the app's vault session (no
  second unlock). "Ask me…" understands short commands locally
  (`src/ui/assistant.ts`: copy github password, username for aws, new password
  24, passphrase, ssh prod, save login for netflix, lock, settings); replies
  never contain secret values. Quick Find / Save credential (title, username,
  site, category, tags, notes, masked password, update an existing login) /
  Generate.
- **Bubble**: minimized buddy — the animated avatar alone (click to open, drag
  anywhere; position remembered). Built-in avatars or the user's picture
  (re-encoded locally to a 128×128 PNG). Its face follows the vault state.
- **Open at login** (per-user LaunchAgent written by the helper), **quiet
  mode**, keep-in-menu-bar, bubble on close.
- **Native window behaviour** — `scripts/pvwindow.m` (libpvwindow.dylib, linked
  into the Neutralino shell with an LC_LOAD_DYLIB by `scripts/add-load-command.py`;
  no DYLD_* variables): when the UI makes the window always-on-top, the app's
  web view moves into a borderless, transparent, non-activating panel at
  status-bar level (all desktops, full-screen auxiliary); it moves back for the
  full window. It also quits via `-[NSApplication terminate:]` (page message
  `pvNative {cmd:'quit'}`, own page only) because Neutralino's `app.exit`
  aborts on current macOS while tearing down the menu-bar item.

### Development

```sh
pnpm --filter @passvault/desktop dev
```

`scripts/dev.sh` does the following:

- builds the host-arch helper;
- writes `neutralino.dev.config.json` (gitignored) with `applicationId io.passvault.desktop.dev` (separate storage), `enableInspector: true` and the helper at `native/desktop-helper/bin/pv-helper`;
- runs `vite build --watch --mode development`;
- starts `bin/neutralino-mac_<arch> --res-mode=directory --path=apps/desktop --config-file=/neutralino.dev.config.json`.

Right-click → Inspect opens Web Inspector. A rebuilt bundle needs a fresh app start, because the one-time token does not survive a reload.

Two-terminal alternative: run `pnpm --filter @passvault/desktop dev:ui` in one terminal, then the binary line from `scripts/dev.sh` in the other.

### Verification harness and dev SSH server (development only)

- `scripts/verify-harness.sh cloud` runs the built `resources/app` and the bundled helper in Neutralino's window-less **cloud** mode, under a separate app id with `exportAuthInfo: true`. A browser then opens `http://localhost:47391/`. With a `--mode development` build, `?preview` creates an offline preview account (master password `preview-password-123`, see `src/dev-preview.ts`, which is tree-shaken from production builds) and exposes `window.__pvDev` for scripted checks. Cloud mode binds `*:47391`, so use it only on a trusted machine.
- `scripts/nl-client.mjs <method>` calls an allow-listed native method from Node, using the harness's exported auth info.
- `scripts/dev-ssh-server` is an in-process `x/crypto/ssh` server on 127.0.0.1 that never touches `~/.ssh` or sshd. It runs a fake shell that executes nothing:

  ```sh
  cd apps/desktop/scripts/dev-ssh-server
  GOTOOLCHAIN=local go run . -port 2222 [-authorized pubkeys.txt] [-rotate]
  ```

  - users: `dev` / password `dev-password`; `kbd` (keyboard-interactive: `dev-password`, then OTP `123456`); `key` (public keys from `-authorized`);
  - shell commands: `help`, `whoami`, `size` (PTY size), `link` (plain URL, OSC 8 link, `file:` URL), `exit`;
  - `-rotate` changes the host key, which triggers the mismatch dialog.

  Create a Server item for `127.0.0.1:2222` and Connect.

## Packaging matrix

| Bundle | Binaries |
|---|---|
| `dist/PassVault.app` | universal (x86_64 + arm64): launcher, `passvault-shell` (Neutralino's `neutralino-mac_universal`), `pv-helper` (lipo) |
| `dist/arm64/PassVault.app` | arm64 only |
| `dist/x64/PassVault.app` | x86_64 only |

Info.plist settings:

- `CFBundleIdentifier io.passvault.desktop`;
- `LSMinimumSystemVersion 14.0` (12.0 was requested, but the Neutralino 6.10 binaries require 14.0);
- `NSHighResolutionCapable`, `LSUIElement false`, and `NSAllowsLocalNetworking` for http://localhost.

## Signing, notarization, DMG

`scripts/sign-and-notarize.sh`. Run `DRY_RUN=1 …` to print the commands. The script expects:

- a **Developer ID Application** certificate and key in the login keychain: `security find-identity -v -p codesigning`;
- your **Team ID** (`TEAM_ID`);
- a **notarytool keychain profile**:
  `xcrun notarytool store-credentials passvault-notary --apple-id … --team-id TEAMID --password <app-specific password>`;
- for **Touch ID** only: a Developer ID **provisioning profile** for `TEAMID.io.passvault.desktop` that authorizes `keychain-access-groups`, plus an app built with `HELPER_LAYOUT=bundle`. `keychain-access-groups` and `application-identifier` are restricted entitlements and need an embedded profile, which a bare command-line binary cannot carry.

```sh
HELPER_LAYOUT=bundle ARCHS=universal bash apps/desktop/scripts/build.sh
IDENTITY="Developer ID Application: Example Inc (ABCDE12345)" TEAM_ID=ABCDE12345 \
NOTARY_PROFILE=passvault-notary PROVISIONING_PROFILE=~/PassVault_DeveloperID.provisionprofile \
bash apps/desktop/scripts/sign-and-notarize.sh apps/desktop/dist/PassVault.app
```

The script signs, notarizes and packages in this order:

1. **Sign the helper:** `codesign --force --timestamp --options runtime`. With a profile, it embeds the profile and signs with `native/desktop-helper/entitlements.plist`, with `TEAM_ID` substituted.
2. **Sign `passvault-shell` and the app:** hardened runtime with `scripts/entitlements.app.plist`, which is empty (no JIT exceptions, library validation stays on, no `get-task-allow`).
3. **Verify:** `codesign --verify --deep --strict`.
4. **Notarize the app:** `ditto -c -k --keepParent` → `xcrun notarytool submit --wait` → `xcrun stapler staple` → `spctl --assess`.
5. **Build and notarize the DMG:**
   1. `hdiutil create -fs HFS+ -format UDZO` (with an `/Applications` symlink);
   2. sign;
   3. `notarytool submit --wait`;
   4. `stapler staple`;
   5. `spctl --assess --type open`;
   6. `shasum -a 256`.

## Installation

Open the DMG and drag PassVault to Applications. Unsigned or ad-hoc local builds
are blocked by Gatekeeper when downloaded. Locally built apps (no quarantine
attribute) start with `open dist/PassVault.app`. On ad-hoc builds, macOS may ask
"pv-helper wants to access the keychain" after a rebuild, because the code hash changes.

## Update policy

There is **no auto-updater that downloads code.** Neutralino's `updater` API is not
allow-listed: it would overwrite `resources.neu` with unsigned content. Updates
ship as new signed and notarized DMG releases, verified by Gatekeeper, with
SHA-256 sums published alongside.

A Sparkle-style signed appcast with EdDSA signatures could be added later. It is
deferred: it needs a native updater component and a key-management process.

## Verification performed (2026-10-08, macOS 26 arm64)

- `pnpm --filter @passvault/desktop typecheck` passes, and `test` passes 54 vitest tests:
  - IPC client: correlation, timeouts, session binding, stale events, error mapping, `invalid_session`, transport failure;
  - Hop building, external params without secrets, trust persistence (mismatch never persisted, viewer gets session trust);
  - paste guard (capture-phase interception), link handler (non-http rejected, shell-safe encoding);
  - lock hook (`vault.locked`, tabs disconnected, terminals disposed), screen-lock/sleep → lock, helper restart, sign-request queue, resize debounce;
  - clipboard auto-clear, storage keys, Keychain token storage, export overwrite rules.
- `pnpm --filter @passvault/web build` passes after the shared-package change.
- **Package:** `scripts/build.sh` produced all three bundles.
  - `lipo`/`file`: universal has `x86_64 arm64` for all three executables; the arm64 and x64 bundles are single-arch.
  - `codesign --verify --deep --strict` passes (ad-hoc).
  - The `HELPER_LAYOUT=bundle` variant was also built, launched and connected.
- **Launch:** `open dist/PassVault.app`, `open dist/arm64/PassVault.app`, and once `open dist/x64/PassVault.app` (under Rosetta; not repeated, because Rosetta can prompt the user, so later checks of the Intel slice use only `lipo -info`/`file`) each started the shell with `--path=…/Contents/Resources`, bound 127.0.0.1:47391 and started the helper. The UI in the WKWebView sent `hello` (ok), `agent.status` and `keychain.get pv.session` (`not_found`, i.e. signed out), as shown in `helper.log`. This proves the bundled UI loaded under the CSP, the one-time token worked and the extension was reached.
- **Screenshots:**
  - `screencapture` fails here ("could not create image from display": no Screen Recording permission).
  - Neutralino's `window.snapshot` crashes on macOS 26 (`+[SCWindow windowWithWindowID:]` unrecognized selector).
  - So the UI was inspected with the verification harness (cloud mode, the same bundle, the same helper) in a browser. Checked visually: the sign-in screen, Terminal view with a production tab, host-key trust dialog, mismatch dialog, keyboard-interactive prompt, paste confirmation, agent sign-approval dialog, SSH agent settings, Desktop app settings and the helper-down banner.
- **Through the helper:**
  - `keychain.set/get/delete` of a dummy item round-tripped, then returned `not_found` after deletion;
  - `keychain.set` with `biometric:true` returned `unavailable: requires a signed build with keychain entitlement`.
- **Against `dev-ssh-server`:**
  - unknown host key: dialog (fingerprint matched the server log) → trust → key saved in the item → connected;
  - typed commands; the `size` output reflected the fitted PTY;
  - plain and OSC 8 links opened the confirm dialog (cancelled; nothing was opened);
  - a multi-line paste was intercepted with a 3-line preview;
  - keyboard-interactive: password via **Fill stored password**, then an echoed OTP round → connected;
  - `ssh.keygen` + `ssh.inspectKey` fingerprints matched; added to the agent;
  - `/usr/bin/ssh` with `SSH_AUTH_SOCK` raised the sign dialog. The destination showed a **verified** host key equal to the server's; Allow once → logged in;
  - `ssh.test` with a host-key round → trusted → "connected and authenticated";
  - host key rotated: mismatch dialog, error `host_key_mismatch`, item unchanged. Open server settings → **Remove** → reconnect asked to trust the new key;
  - `session.lock()`: `vault.locked` sent, the agent went from 1 key to 0 (locked), and the tab showed "Disconnected because the vault locked" with its scrollback wiped;
  - killing `pv-helper`: the banner and status became `unavailable`.
- **Offline cache:** the files in Neutralino storage contained no plaintext (grep for the password, the private key header and the host found nothing).
- **Production URL build:** the `package` build compiled `https://vault.example.com` into the bundle and its CSP, and the rebuilt universal app launched and said `hello`. An override (`VITE_API_URL=https://api.example.com`) and a development build (`http://localhost:3000`) produced the matching `connect-src`. Requests to the production API were not exercised.
- **API (http://localhost:3000):** healthy. Real sign-in was **not** tested: registration needs an emailed code (console mail transport output of another agent's process) and TOTP. The offline preview account was used instead.

## Not verified / known limitations

- **Signing:** Developer ID signing, hardened runtime acceptance, notarization, stapling, a signed DMG, and Touch ID on a signed build. No certificate or notary credentials were available. The script was only dry-run; an unsigned `hdiutil` DMG was created successfully.
- **Real window interactions** were not driven: the native window could not be screenshotted or clicked. That covers tray/main-menu clicks, window close → exit, ⌘T/⌘W inside WKWebView, the macOS save/open panels (pfd/osascript), and screen-lock/sleep events. Screen lock and sleep are covered by unit tests and the helper's own tests.
- **Terminal.app / iTerm launch** was not executed (it would open windows on the user's desktop). Parameter building is unit-tested; the script contents are covered by the helper's tests.
- A page reload loses the one-time Neutralino token (`NE_CL_IVCTOKN`), so the context menu is restricted. Quit and reopen to recover.
- If port 47391 is taken, the app cannot start its server. A process bound to `*:47391` does not stop PassVault from binding 127.0.0.1:47391; that process was rejected by the helper's connect token.
- Only one jump host level. The SSH agent cannot identify destinations without `session-bind`.
- After `SIGTERM` of the app during testing, macOS (loginwindow's persistent-apps support) relaunched it once. A normal quit does not trigger this.
