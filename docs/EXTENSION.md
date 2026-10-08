# PassVault browser extension (Chrome, Manifest V3)

Source: `apps/browser-extension` (`@passvault/browser-extension`). The extension
is a full client: it signs in, decrypts and edits the vault locally with
`VaultSession` from `@passvault/vault-core`, and fills website logins into
pages when the user asks it to. It works on its own. The desktop app is not
required.

## Build and install

```bash
pnpm install
# development build, rebuilt on every change (unminified, with source maps)
pnpm --filter @passvault/browser-extension dev
# production build into apps/browser-extension/dist
pnpm --filter @passvault/browser-extension build
# typecheck / unit tests
pnpm --filter @passvault/browser-extension typecheck
pnpm --filter @passvault/browser-extension test
# package dist/ as passvault-extension-<version>.zip
pnpm --filter @passvault/browser-extension zip
# regenerate the toolbar icons (checked in under public/icons)
pnpm --filter @passvault/browser-extension icons
```

**Load unpacked:** open `chrome://extensions`, turn on *Developer mode*, click
*Load unpacked* and select `apps/browser-extension/dist`. After a rebuild,
click the reload icon on the extension card. With `pnpm dev`, reload after
each rebuild.

**Configuration** happens at build time through Vite env variables. You can
set them in the shell or in `apps/browser-extension/.env.production` or
`.env.development`:

| Variable       | Default                 | Effect |
| -------------- | ----------------------- | ------ |
| `VITE_API_URL` (or `VITE_PRODUCTION_URL`) | unset | The built-in **production server** (an `https://` base URL; loopback values are ignored). It is the first saved server on a fresh install — a suggestion, not a restriction — and the **only** entry in `host_permissions` (`<origin>/*`). Without it the extension starts on local development and `host_permissions` is `http://localhost:3000/*`. |
| `VITE_WEB_URL` | the production server | Dashboard URL for the production server ("Open dashboard", "Create an account", "Finish in the dashboard"). Local development uses `http://localhost:5173`; any other server uses its own origin. |

Example: `VITE_API_URL=https://vault.example.com pnpm --filter @passvault/browser-extension build`.

### Server connection (editable at any time)

The server is set in the popup — **Settings → Server connection**, or
**Server · … → Change** on the sign-in and lock screens — and can be changed
at any time. Full behaviour, rules and isolation: [SERVERS.md](SERVERS.md).

- Editable **Server URL** (prefilled), **Test connection**, **Save changes**,
  **Cancel**; saved servers to switch back to; **Local development servers**
  setting for `http://localhost`.
- Any compatible server: `https://`, optionally under a path prefix. A new
  address is applied only after the compatibility check (`GET /api/v1/meta`,
  no credentials) passes; otherwise nothing changes.
- **Host access is granted per server by Chrome.** Test/Save call
  `chrome.permissions.request({ origins: ['<origin>/*'] })` from the click
  (an `optional_host_permissions` entry); the background refuses to check or
  switch unless `chrome.permissions.contains` confirms access.
- **Changing the server locks the vault** (resume key removed), ends the
  session (`dispose`: in-flight requests cancelled, half-finished sign-in and
  pending captured passwords dropped) and starts a new one for the new server.
- **Each server has its own namespace** (`pv.<scope>.*`, IndexedDB
  `passvault-ext-<scope>-<account>`); saved servers in `pv.servers`.
- Only the popup can change servers (`server.check`, `server.set`,
  `server.switch`, `server.rename`, `server.remove`, `server.localDev` are
  privileged messages; content scripts and other extensions are refused).

The service worker sends API requests with the host permission, so the API
does not need a CORS entry for the extension. If the API ever enforces an
Origin allow-list, add `chrome-extension://<extension-id>` to `CORS_ORIGINS`.
The API config already accepts that form.

**Chrome Web Store:** upload the zip produced by `pnpm zip`. The store signs
and distributes updates. The extension contains **no remote code**. Every
script is bundled in the package, the CSP allows only `'self'` (plus
`'wasm-unsafe-eval'` to compile the bundled libsodium WebAssembly), and the
background bundle has no dynamic `import()`. Store listing notes:

- Single purpose: password and developer-secrets manager.
- Justify each permission using the table below.
- Data use: vault data is end-to-end encrypted and decrypted only on the device. The server receives ciphertext and the account/session metadata described in `docs/API.md`.

Build output (production):

```
dist/manifest.json            1.1 kB   generated (version from package.json, API host from VITE_API_URL)
dist/background.js          936 kB     ES-module service worker (includes libsodium-sumo with inlined WASM)
dist/popup.html + assets/popup-*.js (298 kB) + assets/popup-*.css (50 kB) + bundled fonts (woff2)
dist/offscreen.html + assets/offscreen-*.js (0.5 kB)
dist/assets/items-*.js, constants-*.js   small chunks shared by the popup and background (static imports only)
dist/icons/icon-{16,32,48,128}.png
```

No content-script bundle exists. The functions that run in pages are passed
to `chrome.scripting.executeScript({ func, args })`.

## Permissions

| Permission | Why | Install warning |
| ---------- | --- | --------------- |
| `storage` | `chrome.storage.local` holds the session token and device prefs. `chrome.storage.session` holds the resume key while unlocked. | none |
| `alarms` | Inactivity auto-lock and the clipboard-clear timer. Both survive service-worker suspension. | none |
| `activeTab` | Lets the extension read the URL of the tab where the user opened the popup, and inject into it, only after that user gesture. | none |
| `scripting` | One-shot `executeScript` into the active tab's top frame to fill or read a login form. | none (scoped by `activeTab`) |
| `offscreen` | An offscreen document (reason `CLIPBOARD`) clears the clipboard after the configured timeout. The service worker has no clipboard access, and the popup is usually closed by then. | none |
| `clipboardWrite` | Lets the offscreen document write an empty string to the clipboard without a user gesture. | may show "Modify data you copy and paste" |
| `host_permissions: [<default server origin>/*]` | API calls from the service worker to the built-in server (production, else `http://localhost:3000`). | "Read and change your data on <api host>" |
| `optional_permissions: [nativeMessaging]` | Requested at runtime only, when the user turns on **Unlock with Touch ID** (macOS). Talks only to `io.passvault.touchid`, the host PassVault for Mac registers. Removed again when Touch ID is turned off. | "Communicate with cooperating native applications" |
| `optional_host_permissions: [https://*/*, http://*/*]` | Requested at runtime only: **all sites** if the user enables "Offer to save passwords" (lets the opt-in content script notice login form submissions), or **one origin** when the user tests or connects to another server. Removable at any time. | "Read and change all your data on all websites" (when enabling the save prompt) or "… on <server host>" (when switching server) |

Deliberately **not** requested: `<all_urls>` or any other website host
permission, `tabs`, `webRequest`, `cookies`, `nativeMessaging` at install
(it is optional, see above), content scripts, `externally_connectable`, and
`web_accessible_resources`. A manifest unit test checks this list.

The manifest carries a `key` (public half only) so installs from the release
zip always get the same ID, `hpnpkdckiinjkfjolbfkhbekeknhmdff`, which PassVault
for Mac allow-lists for Touch ID. The Chrome Web Store assigns its own ID and
refuses a `key`, so `pnpm zip` also writes
`passvault-extension-<version>-chrome-web-store.zip` without it; add the store
ID to the desktop build with `VITE_PV_EXTENSION_IDS`.

CSP: `extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`.

## Trust boundaries

```
 ┌───────────────────────────── Extension (trusted) ─────────────────────────────┐
 │                                                                               │
 │  Background service worker (ES module)            Popup (React, popup.html)   │
 │  ─ VaultSession: keys, decrypted items     ◀────▶  ─ UI only; asks for data    │
 │  ─ all privileged operations              runtime ─ copies to clipboard        │
 │  ─ validates every message (zod)          messages   (user gesture)            │
 │  ─ checks sender = this extension's popup  + port  ─ never sees keys           │
 │  ─ URL matching (matchLogin), fill policy                                      │
 │        │                    │                                                 │
 │        │ fetch (bearer)     │ executeScript(func, args) — top frame only,      │
 │        ▼                    │ ONE action, only after the user clicks           │
 │   PassVault API             │                                                  │
 │   (ciphertext only)         │   Offscreen document: clears clipboard only;     │
 │                             │   receives no secrets                            │
 └─────────────────────────────┼──────────────────────────────────────────────────┘
                               ▼
 ┌──────────────── Web page (untrusted) ────────────────┐
 │ Injected function (isolated world, top frame):       │
 │  fill: gets ONE username/password + expected origin, │
 │        checks location.origin first                  │
 │  capture: returns the typed username/password        │
 │ No vault access, no persistent content script,       │
 │ no messaging channel back into the vault.            │
 └──────────────────────────────────────────────────────┘
```

- Only the **background** holds key material and decrypted items. `libsodium-wrappers-sumo` (WASM) initializes inside the MV3 service worker. This was verified in Chrome for Testing: the worker runs Argon2id unlock, generates passwords, and resumes after it is killed. No offscreen or popup crypto fallback is needed.
- The **popup** is a trusted extension page. It receives decrypted fields only when it asks for a specific item (`item.get`, `item.secret`) or for captured page values. List responses are secret-free summaries.
- **Pages and content scripts** get no vault access. No content script is declared. The injected functions are self-contained, and a unit test re-creates them from their source text the way Chrome does. They run in Chrome's isolated world, so page JavaScript cannot tamper with them.

## Message protocol

Defined in `src/shared/protocol.ts`. Every request is a zod-validated object
with a `type`, and unknown fields are rejected (`strict`). Every response is
`{ ok: true, data } | { ok: false, error: { code, message } }`, with error
codes `invalid_message`, `forbidden`, `locked`, `not_found`,
`wrong_password`, `network`, `refused`, `conflict` and `internal`.

Sender checks (`src/background/sender.ts`), applied before anything else:

1. `sender.id === chrome.runtime.id`. Otherwise the result is `forbidden`. No `onMessageExternal` listener exists.
2. `sender.tab` must be absent. Content scripts and injected code carry `sender.tab`, and so does `popup.html` opened in a normal tab.
3. `sender.url` must start with `chrome-extension://<own id>/`, and `sender.origin`, when present, must equal the extension origin. The check compares strings, not `URL.origin`, because opaque origins are all `"null"`.
4. **Privileged** requests (everything except `ping`) also require the path to be exactly `popup.html` with `frameId` 0.

| Request | Purpose | Returns |
| ------- | ------- | ------- |
| `ping` | health check (any own page) | version |
| `state.get` | auth/sync state | `PopupState` (phase, email, sync, online, lock/clipboard timeouts) |
| `auth.login` `{email,password}` | password login (Argon2id → authKey) | state (`mfa_verify` / `mfa_enroll` / `unlocked`) |
| `auth.mfaVerify` `{code \| recoveryCode, trustDevice}` | second factor | state |
| `auth.mfaEnrollStart` / `auth.mfaEnrollConfirm {code}` | TOTP enrollment in the popup | state (secret, otpauth URI, then recovery codes) |
| `auth.ackRecoveryCodes`, `auth.cancel` | finish or abort login | state |
| `auth.unlock {password}` / `auth.lock` / `auth.logout` | lock state | state |
| `vault.sync` | sync now | state |
| `vault.list {query?, limit?}` | search all active items (any type) | summaries (no secrets) |
| `vault.matches {tabId}` | logins matching the active tab | tab info + matches (no secrets) |
| `vault.meta` | folders, tags, projects for the save form | names only |
| `item.get {id}` | detail view | decrypted fields (popup only) |
| `item.secret {id, field: username\|password}` | quick copy, logins only | one value |
| `autofill.fill {tabId, itemId, confirmInsecure}` | fill | `filled` / `needs_confirmation` / `refused` + reason |
| `autofill.capture {tabId}` | save-from-page | captured values + existing matching logins |
| `item.saveLogin {confirmed: true, draft}` | save a new login | id |
| `item.updatePassword {confirmed: true, id, password}` | update an existing login | id |
| `autosave.status` / `autosave.set {enabled}` / `autosave.clearNever` | "Offer to save passwords" setting | `{enabled, permission, neverCount}` |
| *content script →* `savePrompt.submitted {username, password}` / `savePrompt.pending` / `savePrompt.decide {decision}` | opt-in save prompt (top frame of a tab only; validated separately; never reaches popup-privileged handlers) | action/host/title only — never vault data |
| `generator.generate {kind, options}` | password or passphrase (libsodium CSPRNG) | value + entropy |
| `clipboard.scheduleClear` | arm the clipboard-clear alarm | scheduled seconds |

A long-lived port (`pv-popup`, same sender checks) pushes `PopupState`
changes to the open popup. Its 20-second keepalive keeps the worker running
while the popup is open, for example during an MFA step. Keepalives do
**not** count as activity for auto-lock.

## Autofill rules

Fill only happens when the user picks a login in the popup and clicks
**Fill**. Nothing is filled on page load, and nothing is filled without a
click.

Before filling, the background:

1. Re-reads the tab URL with `chrome.tabs.get(tabId)` at fill time. The URL from when the popup opened is not reused.
2. Refuses anything that is not an `http:`/`https:` page (`javascript:`, `file:`, `chrome:`, `chrome-extension:`, `about:`, `data:`, `view-source:` and so on). Result: `unsupported_page`.
3. Refuses items that are not website logins. SSH keys and servers, databases, API credentials, env files and notes are **never** injected into pages; the popup only offers copy for them (`not_login`). Trashed items are refused (`trashed`).
4. Re-checks the item's URLs against the page with `matchLogin`. Matching is conservative: exact host and port by default, base domain via the PSL including private suffixes, and lookalikes such as `example.com.evil.test` or `evil-example.com` never match. If nothing matches, the fill is refused (`no_match`) and the popup suggests copying instead.
5. If the match is `insecure` (http page, or https login on an http page), it returns `needs_confirmation`. The popup shows a warning dialog and only re-sends with `confirmInsecure: true` after the user confirms.
6. Injects into the **top frame only** (`frameIds: [0]`). The only arguments are the expected origin, the username and the password.

The injected function `pvFillCredentials`:

- Does nothing unless `window.top === window` and `location.origin === expectedOrigin`. This is the TOCTOU guard for a navigation between the check and the injection (`origin_mismatch` becomes `origin_changed`).
- Considers only usable inputs: not `type=hidden`, not disabled or readonly, not `hidden`, no `display:none`/`visibility:hidden`/`opacity:0` on the element or an ancestor, a non-trivial size, and not positioned off-screen (honeypots).
- Picks the password field (preferring `autocomplete=current-password` and avoiding `new-password`), then the username field in **the same form**, before the password field (preferring `autocomplete=username`, then user/email/login-like names).
- Sets values with the native `HTMLInputElement` value setter, so framework-controlled inputs notice the change, and dispatches bubbling `input` and `change` events.
- Returns `filled`, `no_password_field` (the page is left untouched), `origin_mismatch` or `not_top_frame`.

## Save and update flow

1. The user clicks **Save login** in the popup (*On this site*).
2. The background re-reads the tab URL, refuses non-web pages, and injects `pvCaptureCredentials` into the top frame. The function reads only the top document, never iframes. It returns the origin, URL and title plus the current username and password values. The background validates the shape and length of the result and checks that the origin still matches the tab.
3. The popup shows a confirmation form:
   - title prefilled from the host (`www.` removed)
   - username
   - password, masked with reveal
   - website (the origin) with match rule `host` by default (`base_domain`, `starts_with` and `exact` are also available)
   - notes, folder (with suggestions), tags, and project (optional)
4. If a login for this page with the same username already exists, the popup names the item. When the password differs, it offers **Update password**, which asks for confirmation and then calls `session.updateItem`; the old password stays in item history. **Save as new** is also available.
5. Nothing is written until the user presses Save or Update. The protocol requires `confirmed: true`, and the background builds the item with `newItem('login', …)` and calls `session.saveItem`.

### Offer to save passwords (opt-in, automatic prompt)

Enabled in the popup under **Settings → Offer to save passwords**. Turning it
on calls `chrome.permissions.request` for the **optional** host permissions
`https://*/*` and `http://*/*` (from the click, so Chrome shows its own
permission dialog). Turning it off unregisters the script and gives the
permission back; revoking the permission in `chrome://extensions` also stops it.

1. While enabled, the background registers a content script
   (`save-prompt.js`, ~5 KB, no imports) with
   `chrome.scripting.registerContentScripts` — top frame only, `document_idle`.
   Nothing is injected while the setting is off.
2. The script listens for trusted (`event.isTrusted`) form submits, Enter in a
   login field, and clicks on submit-like buttons. It reads the filled password
   (the last filled one, for sign-up/change-password forms) and the username
   next to it, and sends them **once** to the background.
3. The background (`src/background/save-prompt.ts`) accepts these messages only
   from this extension's content script in a tab's **top frame**; the page
   origin comes from `sender.url`, never from the message; unknown fields are
   rejected. It never prompts on PassVault's own dashboard/API origins or on
   sites marked "Never". If the vault is unlocked and a matching login with the
   same username exists, it suggests **Update** (or stays quiet if the
   password is unchanged); otherwise **Save**.
4. The captured password is kept in worker memory and `chrome.storage.session`
   (memory-only, trusted contexts) for at most **3 minutes**, and is wiped when
   the vault locks or the tab closes. Replies to the page contain only the
   action, host and (for updates) the item title — never vault data.
5. The prompt renders inside a **closed** shadow root (the page cannot read or
   restyle it), page-derived text is set with `textContent` only, and clicks are
   honoured only when trusted. After a post-login redirect it reappears on the
   same registrable site (public-suffix aware, including private suffixes such
   as `github.io`), never on another site.
6. **Save** creates a login titled with the host, with the origin as its URL
   and `host` matching; **Update** changes the password (old one stays in
   history). **Add note** opens an optional note field (up to 2,000
   characters): it becomes the new login's notes, or is appended to the
   existing notes on update. The note is typed into the page, so the page can
   observe the keystrokes (capture-phase listeners) like anything else typed
   there; for sensitive notes, use the popup's "Save login from this page".
   **Never for this site** adds the site to a local list (Settings
   shows a count and a Reset button). If the vault is locked, Save asks the
   user to unlock from the toolbar icon and press Save again.

Verified with unit tests (sender/origin validation, locked flow, update vs.
save, notes saved and appended, oversized/malformed notes rejected, redirect
handling, never list, TTL and wipe-on-lock, no secrets in replies), jsdom
tests (untrusted events ignored, closed shadow root, no HTML injection, note
field closed for scripted clicks), and a real-Chromium check with trusted
input that saves a login and a login with a typed note
(`pnpm --filter @passvault/e2e-video check:save-prompt`).

## Service-worker suspension and locking

- **Unlocked state across suspension.** After any unlock (password, login, MFA, or enrollment), the background stores a copy of the User Key (`exportUserKeyForResume()`) in `chrome.storage.session`. That storage is in memory only and is cleared when the browser exits. Its access level is set explicitly to `TRUSTED_CONTEXTS`, so content scripts cannot read it. When Chrome restarts the worker, it loads the encrypted cache and calls `resumeWithUserKey`. A missing key means the vault stays locked; an invalid key is deleted and the vault stays locked.
- **Inactivity lock** uses `chrome.alarms` (`pv-autolock`). Every privileged popup request re-arms it with the account's `lockTimeoutMinutes` (from the decrypted settings; 0 disables it). Chrome alarms fire **no sooner than 30 seconds** and may be delayed while the device sleeps, so the effective timeout is at least 30 s and lock can be late by up to about a minute. `VaultSession`'s own in-memory timer also runs while the worker is alive. Either path locks.
- **Locking** works the same way whether it comes from the popup button, the alarm, the in-memory timer or a revoked session. The background removes the storage.session key **first**, clears the alarm, calls `session.lock()` (which wipes key buffers and drops decrypted state), and clears the clipboard if a copied secret is still pending. After that, every privileged data request fails with `locked`.
- **Browser restart** clears `chrome.storage.session`, so the vault is locked and the master password is needed.
- **Logout** revokes the server session, clears the token and the local cache, and removes the resume key.

## Storage

| Data | Where | Protection |
| ---- | ----- | ---------- |
| Vault records, vault memberships, outbox, wrapped account keys | IndexedDB `passvault-ext-<server scope>-<email>` (one DB per server and account, `IndexedDbStore`) | ciphertext only |
| Session token (bearer) | `chrome.storage.local` `pv.<server scope>.sessionToken` | plaintext; revocable; cannot decrypt anything |
| Device id, last email, trusted-device token | `chrome.storage.local` `pv.<server scope>.pref.*` | plaintext, non-secret or revocable |
| Selected server | `chrome.storage.local` `pv.server` | origin only |
| **User Key copy (resume key)** | `chrome.storage.session` `pv.resumeUserKey` | **plaintext key, in memory only, trusted contexts only, present only while unlocked, deleted on lock** |
| Clipboard-clear pending flag | `chrome.storage.session` | no secret |
| Decrypted items and keys | background worker memory | wiped on lock (best effort, see `docs/CRYPTO.md`) |

Session-token trade-off: keeping the token in `chrome.storage.local` lets
the extension sync after a browser restart without a new MFA prompt. Anyone
who can read the Chrome profile can call the API as the user until the
session is revoked or expires. They still cannot decrypt the vault without
the master password. Users can revoke sessions from the dashboard, and
logout revokes it.

## Clipboard

The popup copies with `navigator.clipboard.writeText`, which needs the
popup's user gesture. For secret values it then asks the background to
schedule a clear after `clipboardClearSeconds` (from settings, default 30 s,
minimum 30 s because of alarm granularity; 0 disables it). When the alarm
fires, the background opens the offscreen document, which writes an empty
string to the clipboard through a `copy` event, and then closes it. Locking
also clears a pending secret right away.

Caveats:

- The clear is unconditional. Reading the clipboard to compare would need `clipboardRead`, which is a more alarming permission. If the user copied something else in the meantime, that is cleared too.
- If the browser exits before the alarm fires, nothing clears the clipboard.
- OS clipboard history tools (Windows clipboard history, third-party managers) may keep copies.

## MFA

TOTP enrollment can be completed in the popup: a QR code generated locally
with the `qrcode` package, the setup key, confirming a code, and the
recovery codes. "Finish in the dashboard instead" opens the web app. The
pending login lives only in worker memory. The popup's port keeps the worker
alive, but if the popup closes and the worker is suspended, the user signs in
again. MFA verification supports a TOTP code, a recovery code, and "trust
this browser".

## Touch ID unlock (macOS)

1. PassVault for Mac → Settings → **Touch ID in the browser extension** registers
   `pv-touchid` (inside PassVault.app) as the native-messaging host
   `io.passvault.touchid` for the extension's ID, in every installed Chromium
   browser (`~/Library/Application Support/<browser>/NativeMessagingHosts/`).
2. Extension → Settings → **Unlock with Touch ID** asks for the optional
   `nativeMessaging` permission, then vault-core's `enableBiometrics` wraps the
   user key with a random device key and hands that key to the host
   (`enroll`), which seals it to a Secure Enclave key that needs a current
   Touch ID match. The wrapped user key stays in this browser's storage.
3. When locked, the popup offers Touch ID (once automatically per opening; the
   prompt's cancel button says "Use Master Password"). The host releases the
   device key only after the enclave accepts the fingerprint.

Chrome passes the calling extension's origin to the host, and the host keeps
a separate namespace per origin (and for the desktop app), so one caller can
never read another's key. The prompt text is fixed by the host. The master
password always works; turning Touch ID off deletes the sealed key.

## Known limitations

- **Cross-origin iframes are never filled or read.** Injection targets frame 0 only. Logins embedded in third-party iframes (some SSO widgets and payment pages) need copy and paste. Same-origin iframes are also skipped.
- **Identifier-first (two-step) logins:** the fill function needs a visible password field. On a username-only step it returns `no_password_field` and touches nothing, so use *Copy username* there and fill on the password step.
- **Automatic save prompt is opt-in.** It needs all-sites access, so it is off by default and requested only when enabled. Logins inside cross-origin iframes are not captured, and very unusual JavaScript-only login flows may not be detected (use "Save login from this page").
- **The page URL is visible only after the user opens the popup** (`activeTab`). Without that grant the popup shows "PassVault can only see the page you opened the popup on."
- **Auto-lock granularity** is at least 30 s (`chrome.alarms`).
- **Clipboard clearing** has the caveats listed in the Clipboard section.
- **Native-messaging pairing** with the desktop app is deferred.
- A pending MFA login is lost if the worker is suspended while the popup is closed.

## Tests

`pnpm --filter @passvault/browser-extension test` runs Vitest. The tests use
an in-memory `chrome.*` fake and a real `VaultSession` with real crypto (low
Argon2 parameters), backed by an offline cached account, so no server is
needed.

| File | Covers |
| ---- | ------ |
| `test/messages.test.ts` (9) | sender validation (other extension ids, tab or content-script senders, popup opened in a tab, non-popup pages, look-alike paths, opaque origins); malformed or extra-field messages rejected; list responses secret-free; detail popup-only; save requires `confirmed: true`; update password; capture finds existing logins and refuses origin changes; generator |
| `test/autofill.test.ts` (7) | fill only into frame 0 with origin + one credential; non-matching origins and lookalikes (`example.com.evil.test`, `evil-example.com`, …) refused without injecting; `javascript:`/`file:`/`chrome:`/`about:`/`data:` refused; http matches need confirmation; SSH keys, notes and trashed items never injected; tab URL re-read at fill time; page-side origin mismatch handled |
| `test/inject.test.ts` (7, jsdom) | functions serialized and re-created from source; fill refuses a different `location.origin`; fills only visible, editable fields (hidden, display:none, visibility:hidden, off-screen, readonly and disabled skipped); `input`/`change` events dispatched; native setter used; pages without a password field untouched; capture reads the top document only, never iframes |
| `test/lock.test.ts` (10) | resume key in storage.session (TRUSTED_CONTEXTS) and alarm armed on unlock; lock clears the key, calls `session.lock`, and later privileged requests return `locked`; alarm-triggered lock; resume after simulated worker restart with the key, none without it, invalid key discarded; alarm delivered to a restarted worker locks; clipboard clear scheduled (≥30 s) and run on lock or alarm through the offscreen document; logout |
| `test/logs.test.ts` (1) | exercises handlers with dummy secrets while spying on every `console` method, and asserts no secret appears |
| `test/manifest.test.ts` (2) | generated manifest is MV3 with the exact minimal permissions, the API host only, the CSP, and no broad or forbidden entries |
| `test/servers.test.ts` (8) | production URL taken from the build (never loopback or plain http); presets; dashboard URL per server; per-server storage scopes; stored selection kept, corrupt one ignored; one-time migration of pre-existing global keys; token/prefs isolated per server; `server.set` popup-only, size-limited, invalid addresses → `invalid_message` |
| `test/save-prompt.test.ts` (12) and `test/save-prompt-content.test.ts` (5, jsdom) | opt-in save prompt (see that section), including notes |

Real-browser checks (Chromium, trusted input; need the local stack):
`check:save-prompt` (save + save with a typed note) and `check:server-switch`
(real toolbar popup driven over the DevTools protocol: current server shown,
plain-http public host refused, ungranted server not used while Chrome's
prompt is unanswered, sign in on server A → switch to B (signed out, own
namespace) → back to A (locked account restored, unlocks), master password
absent from `chrome.storage.local`). The prompt's "denied" path cannot be
answered by headless Chrome and is covered by unit tests only.

Latest result: **6 files, 36 tests passed**. Typecheck and build both pass.

Manual verification in Chrome for Testing (headless, `--load-extension=dist`):

- The service worker starts and initializes libsodium (WASM).
- Popup → background requests work, while `popup.html` opened as a tab is refused with `forbidden`.
- With a seeded offline account, the following work end to end:
  - wrong-password rejection, then unlock (Argon2id in the worker)
  - resume key in `chrome.storage.session`, and `pv-autolock` armed for 15 minutes
  - save login, list, and passphrase generation
  - killing the service worker, then listing again: it resumes from `chrome.storage.session`
  - lock: requests return `locked`, `chrome.storage.session` is empty, and `chrome.storage.local` holds only `pv.pref.deviceId` and `pv.pref.lastEmail`
- The popup renders in light and dark mode.
