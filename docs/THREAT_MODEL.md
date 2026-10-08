# Threat model

Scope: PassVault server, web dashboard, browser extension, macOS desktop app
and native helper. Method: assets → trust boundaries → adversaries → threats
(STRIDE-style) → mitigations → residual risk. Status of each mitigation is
tracked in [STATUS.md](STATUS.md).

## Assets

| Asset | Where it exists in plaintext |
|---|---|
| Vault contents (passwords, keys, tokens, env files, notes, titles, URLs, hosts, tags, project names) | unlocked client memory only |
| Master password | typed into a client; never stored or transmitted |
| User Key, vault keys, item keys, private X25519/Ed25519 keys | unlocked client memory only |
| Vault recovery key | user's offline storage only |
| `authKey` | client memory during login; transmitted to server over TLS (hashed at rest) |
| Session tokens | client storage (sessionStorage / chrome.storage.local / desktop Keychain-or-store); SHA-256 at rest on server |
| TOTP secrets | server DB, AES-256-GCM encrypted with `MFA_ENCRYPTION_KEY` |
| MFA recovery codes | shown once; HMAC at rest |
| Membership/authorization metadata | server DB (plaintext by design) |
| SSH private keys while in use | desktop helper memory (agent / active connection) |
| Trusted host keys | inside encrypted vault items |

## Trust boundaries

1. User ↔ client UI.
2. Client ↔ API over HTTPS (server is **untrusted for confidentiality**,
   trusted for availability and authorization enforcement).
3. Extension: popup/service worker (trusted) ↔ web pages and content-script
   injections (untrusted).
4. Desktop: Neutralino webview (trusted UI) ↔ native helper (privileged) via
   token-authenticated loopback WebSocket; helper ↔ OS (Keychain, sockets,
   child processes); helper ↔ SSH servers (untrusted until host key verified).
5. SSH agent socket ↔ local processes running as the same user.
6. Remote terminal output ↔ terminal renderer (untrusted data).

## Adversaries

- **A1 Network attacker** — passive/active on the network.
- **A2 Server compromise / malicious operator** — read/modify DB, logs, API
  responses; cannot ship client code to desktop/extension (signed separately)
  but *does* serve the web app.
- **A3 Other users** — authenticated, try to read/modify others' data or
  exceed their role.
- **A4 Malicious website** — tries to steal autofill data or abuse the extension.
- **A5 Malicious SSH server / MITM** — host impersonation, hostile terminal output.
- **A6 Local unprivileged malware** running as the same macOS user.
- **A7 Device thief** — has the disk/locked device.
- **A8 Removed collaborator** — previously had legitimate access.
- **A9 Mailbox attacker** — controls the user's email.

## Threats and mitigations

| # | Threat | Mitigation | Residual risk |
|---|---|---|---|
| T1 | A2 reads vault data | Client-side AEAD of all sensitive fields; server stores envelopes only; titles/URLs/hosts/tags/project names encrypted | Metadata in [DATA_MODEL.md](DATA_MODEL.md#server-visible-metadata) is visible |
| T2 | A2 swaps/replays ciphertexts between records/vaults | AEAD contexts bind record id / vault id / key version; grants bound to vault+recipient+version and signed | **Rollback** to an older revision of the same record is not detected; server can withhold updates or delete data |
| T3 | A2 substitutes a recipient's public key during sharing | Fingerprints, TOFU pinning in encrypted settings, explicit verification UI, changed-key blocking, X25519 key signed by Ed25519 identity | First-share TOFU without out-of-band verification can be MITM'd |
| T4 | A2 serves malicious web app JS | **Not mitigated for the web client.** Use the desktop app or extension (signed, store-distributed) for higher assurance; strict CSP; no third-party scripts | Documented non-goal |
| T5 | A1 intercepts traffic | TLS required in production; HSTS via reverse proxy; only `authKey` (not password) ever sent | Compromised CA |
| T6 | Offline dictionary attack on DB | Client Argon2id (64 MiB) + server Argon2id over authKey; strong-password enforcement (zxcvbn ≥ 3, ≥12 chars) | Weak passwords remain guessable |
| T7 | Online guessing / credential stuffing | Rate limits per IP and per account, progressive lockout, mandatory TOTP | — |
| T8 | A9 takes over account via email | Recovery requires email **and** TOTP (or MFA recovery code); vault recovery additionally requires the recovery key (`recoveryAuthKey` proof); account reset destroys data rather than exposing it | A9 + stolen MFA device can *reset* (destroy) the vault — availability loss, no confidentiality loss |
| T9 | TOTP replay / brute force | ±1 step window, last-used-step replay protection, 5 attempts per pending token, rate limits | — |
| T10 | A3 accesses others' records | Server-side authorization on every record/vault/membership operation independent of ciphertext; viewer/editor/owner checks; expiry enforced server-side; e2e tests for cross-user access | — |
| T11 | A8 keeps access | Membership revocation + automatic vault key rotation + re-encryption with fresh item keys | Copies already made, old ciphertext with retained keys, and the underlying secrets — UI instructs rotation at the source |
| T12 | A4 phishing / lookalike domains | Conservative matching (exact host default, PSL with private suffixes), user-initiated fill only, top frame only, origin re-check inside injected code, http pages require confirmation | Cross-origin iframe logins not supported |
| T13 | A4 abuses extension messaging | No persistent content scripts; zod-validated messages; sender id + popup URL checks; minimal permissions | Compromised browser |
| T14 | Extension SW suspension weakens locking | User Key only in `chrome.storage.session` (memory, trusted contexts) while unlocked; cleared on lock/alarm; browser restart → locked | Browser memory forensics |
| T15 | A5 MITM SSH | Mandatory host-key verification; unknown → explicit trust; changed → hard block; jump hosts verified per hop; never InsecureIgnoreHostKey | User trusting a wrong fingerprint on first connect |
| T16 | A5 hostile terminal output | xterm.js with no clipboard (OSC 52) addon, link clicks require confirmation, no auto-run commands, multiline paste confirmation, no recording | Visual spoofing inside the terminal |
| T17 | Secrets leak via argv/env/history/logs | Helper receives secrets over IPC only; external terminal scripts contain validated non-secret args; logs redact params; tests assert no secrets in logs/argv | — |
| T18 | Command injection via profile fields | Strict host/username/port validation (no leading `-`, no metacharacters), argv arrays (no shell) for child processes, single-quote escaping in generated scripts | — |
| T19 | A6 uses the SSH agent | Socket 0600 in 0700 dir; keys loaded only while unlocked and user-enabled; per-use approval (or short timed approval); agent forwarding refused; destination not claimed unless `session-bind` signature verifies | Same-user malware can request signatures the user approves by mistake; locking does not end existing sessions |
| T20 | A6 talks to the helper | Neutralino per-launch tokens; single bound UI session; typed op allowlist; no generic exec | Same-user malware with debugging rights can inspect process memory |
| T21 | A7 reads disk | Only ciphertext caches; exports explicit + 0600 on macOS; Keychain items `ThisDeviceOnly` | Offline guessing of a weak master password from the cached bundle |
| T22 | Lost unlocked device / walk-away | Inactivity lock (default 15 min), system lock/sleep lock on desktop, clipboard auto-clear, masked secrets with auto re-mask | Memory not guaranteed erased (JS/Go GC) |
| T23 | XSS in dashboard via secure notes / item fields | React escaping only; no `dangerouslySetInnerHTML`; notes rendered as text; CSP without `unsafe-eval` | — |
| T24 | Sync data loss | Optimistic concurrency, idempotent mutations, conflict UI, tombstones, encrypted version history | Server can withhold or delete |
| T25 | Logs/analytics leak | Redacted structured logs; no analytics/session replay/crash reporting SDKs in any client | — |
| T26 | Malicious update | Desktop: signed + notarized artifacts, no auto-download of code; extension: store-signed; web: operator-served (T4) | Supply-chain compromise of dependencies |

## Explicit non-goals

- Protecting secrets on a compromised **unlocked** device, or against a
  keylogger/screen recorder.
- Protecting web-dashboard users from a malicious server operator who modifies
  the served JavaScript.
- Guaranteeing erasure of memory or of deleted/exported files on SSDs.
- Proving whether a recipient revealed, copied, or used a secret.
