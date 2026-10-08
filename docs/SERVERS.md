# Server connection (desktop app and browser extension)

PassVault is not tied to one hosted service. The desktop app and the browser
extension connect to any compatible PassVault server the user chooses, and the
address can be changed at any time — not only on first launch. The web
dashboard always talks to the server it was deployed with.

Where:

- **Settings → Server connection** (desktop app: Settings; extension popup:
  Settings tab), and
- **Server · … → Change** on the sign-in and lock screens (the same panel).

The panel shows the connected server (name, URL, account, state: Ready,
Locked, Signed out, Syncing, Offline, Connection error), an editable
**Server URL** field prefilled with the current address, the actions **Test
connection**, **Save changes** and **Cancel**, the list of **saved servers**
(switch, rename, remove), and the **Local development servers** setting.

## Addresses

Shared rules: `normalizeServerUrl` in `@passvault/vault-core/servers`.

| Input | Result |
|---|---|
| `vault.example.com` | `https://vault.example.com` |
| `https://Vault.Example.com:8443/` | `https://vault.example.com:8443` |
| `https://example.com/passvault/` | `https://example.com/passvault` (path prefix kept) |
| `https://example.com/passvault/api/v1` | `https://example.com/passvault` (pasted API URL reduced to the base) |
| `http://localhost:3000` | accepted only with **Local development servers** on |
| `http://vault.example.com`, `http://192.168.1.10` | refused — plain http only for loopback |
| credentials, `?query`, `#fragment`, other schemes | refused |

The API is always `<base>/api/v1/…`, so a server deployed under a path prefix
works as long as the reverse proxy forwards `<prefix>/api/` to the API.

**HTTPS by default.** Plain `http://` is only possible for `localhost`,
`127.0.0.1` and `[::1]`, and only after the user turns on **Local development
servers** (on by default only in development builds and builds without a
production server). Certificate verification is never disabled: a private
server works when its certificate authority is installed in the system trust
store (macOS: Keychain Access → System → trust the CA; Chrome uses the same
store). There is no "ignore TLS errors" option.

## Compatibility check

`checkServer` (vault-core) runs on **Test connection** and before **Save
changes** applies anything. It sends **no credentials**: `credentials: omit`,
no `Authorization`, no cookies, no referrer, and redirects are refused
(`redirect: error`), so nothing about the user reaches the address being tested.

1. `GET <base>/api/v1/meta` — reachability, TLS (verified by the platform),
   and the server description:

   ```json
   { "service": "passvault", "version": "0.1.0", "api": { "current": 1, "min": 1 },
     "capabilities": ["vault.e2ee.v1", "sync.v1", "auth.mfa.totp", "…"], "registration": "open" }
   ```

2. The client's API version (`CLIENT_API_VERSION`) must be within
   `api.min … api.current`, and the server must offer the capabilities the
   client needs (`vault.e2ee.v1`, `sync.v1`, `auth.mfa.totp`).
3. `GET <base>/api/v1/health` — a server whose database is down answers 503
   `{"status":"degraded"}`; it is reported as reachable but degraded.

Failures are explained, never silently ignored:

| Code | Meaning shown to the user |
|---|---|
| `invalid_url` | the address breaks the rules above |
| `unreachable` / `timeout` | no answer — host name, port, network; desktop: also "certificate valid but the server does not allow this app (CORS)" |
| `tls` | certificate expired, not valid for this host name, or not trusted by this computer (with the trust-store hint) |
| `not_passvault` | something answered but it is not a PassVault API (check the path prefix) |
| `incompatible` | server too old for this app, or app too old for this server |
| `missing_capabilities` | the server lacks a feature this app needs |
| `unavailable` | the server answered 5xx |

The desktop app adds a TLS diagnosis: when the webview cannot connect to an
`https://` server, the native helper repeats only the TLS handshake
(`net.inspectTls`, no HTTP request, system trust store) to tell a certificate
problem apart from a CORS refusal. The extension cannot see TLS details;
Chrome's own error is summarised.

If the check fails, **nothing changes**: the current connection, its sign-in
and its data stay as they were, and the error says so.

## Changing the server

**Save changes** with a different address:

1. normalizes and validates the address;
2. runs the compatibility check (extension: after Chrome grants host access
   to that origin — `chrome.permissions.request` from the click);
3. if the vault is unlocked, asks: *Switch to …? Your vault will be locked…*
   (**Lock and switch** / **Cancel**);
4. locks the vault and ends the session for good (`VaultSession.dispose`):
   keys wiped, app-managed SSH sessions closed and agent keys cleared (desktop
   lock hooks), a half-finished sign-in dropped, **in-flight API requests
   cancelled** (`ApiClient.abortAll`; queued offline changes stay queued for
   that server), pending save prompts dropped (extension);
5. starts a new session bound to the new server's own storage → sign in there
   (or unlock, if this device already has a session for that server).

Nothing is uploaded, copied or migrated between servers, and no token or key
of one server is ever sent to another: every server has its own namespace and
the API client is bound to one base URL.

## Saved servers (profiles)

Every server the user connects to is kept as a saved server — **the previous
server is never discarded**, so switching back is one click (it works offline
too, for the encrypted copy on this device).

| Field | |
|---|---|
| name | editable; defaults to the host (+ path), "Local development" for `http://localhost:3000` |
| URL | the normalized base URL |
| account | the email last used on that server (read from that server's own storage) |
| connection status | result of the last check (Reachable / Unreachable) |
| authentication state, encrypted cache, device id, trusted-device tokens, sync state | separate per server (below) |

A profile's id **is** its storage scope, derived from its URL. Changing the
address therefore always creates a new connection that must pass the check
and be authenticated; it can never re-point existing credentials at a
different server. Up to 20 servers can be saved. **Remove** forgets a saved
server (never the connected one) together with its local data on this device;
nothing on the server changes.

### Isolation

| | Desktop app | Extension |
|---|---|---|
| saved servers | Neutralino storage `pvg_servers` | `chrome.storage.local` `pv.servers` |
| scope | `cyrb53(base URL)`, 10 hex chars | readable: `https_vault_example_com_443`, path prefix → `…_443_passvault_<hash>` |
| session token | Keychain `pv.session.<scope>` | `pv.<scope>.sessionToken` |
| prefs (device id, last email, trusted-device tokens) | `pvp_<scope>_*` | `pv.<scope>.pref.*` |
| encrypted cache | `pvc_<scope>_*` | IndexedDB `passvault-ext-<scope>-<account>` |

Older installs are migrated once: the pre-profiles selection (`pvg_server` /
`pv.server`) becomes the first saved server, with its existing namespace.

## Server side

- `GET /api/v1/meta` is public, static (no database access) and `no-store`.
- `REGISTRATION_OPEN=false` closes sign-up (`register/start` and `register`
  answer 403 `registration_closed`; `/meta` reports `"registration": "closed"`).
  Existing accounts are unaffected. Deploy workflow: repository variable
  `REGISTRATION_OPEN`.
- The desktop app's origin is `http://localhost:47391`; a self-hosted server
  must list it in `CORS_ORIGINS` (the deploy workflow adds it). The extension
  calls the API from its service worker with host access and needs no CORS entry.

## Tests

- `packages/vault-core/test/servers.test.ts` — address rules, compatibility
  check (every failure code, no credentials, no redirects), profiles.
- `apps/api/test/meta.e2e.test.ts` — `/meta`, a real client check against
  the real API, closed registration.
- `apps/browser-extension/test/servers.test.ts`, `apps/desktop/test/servers.test.ts`
  — managers: change only after a successful check, previous server kept,
  host access required (extension), TLS/CORS diagnosis (desktop), removal
  wipes only that server's data, CSP.
- `native/desktop-helper/internal/tlscheck` — trusted, untrusted, expired,
  host-name mismatch, unreachable, non-https input.
- `tests/e2e-video/src/server-switch-check.ts` — the real extension popup in
  Chromium (17 checks), and the security harness check
  `desktop.runtime.server-connection` against the packaged desktop app.
