# Status

Snapshot as of 2026-10-08. Legend: **Verified** = exercised by automated tests
and/or a real end-to-end run; **Implemented (unverified)** = code exists and is
unit-tested where possible, but the real-world path could not be run here;
**Deferred** = intentionally not built yet.

## Test results

| Suite | Result |
|---|---|
| `packages/crypto` (round trips, tampering, wrong context, KDF limits, password change, key rotation, recovery key, grants, fingerprints, generators) | 21 / 21 |
| `packages/validation` | 7 / 7 |
| `packages/env-parser` (6 000 random + 4 000 env-shaped + 1 000 UTF-16 round trips, 2 500 random edits) | 65 / 65 |
| `packages/sync` (offline queue, idempotent replay, conflicts, tombstones, access loss, mid-run enqueue) | 9 / 9 |
| `packages/vault-core` (offline unlock, lock wipes keys/plaintext, inactivity lock, URL matching incl. private suffixes, site keys, local search excludes secrets, insights) | 15 / 15 |
| `apps/api` e2e on real PostgreSQL (registration with code, MFA + replay, recovery codes, cross-user authz, roles, expiry, revision conflicts, idempotency, tombstones, sync paging, rotation, sessions, reauth, recovery, log redaction) | 35 / 35 |
| `apps/browser-extension` (message/sender validation, origin matching, injected fill in jsdom, lock/resume, no secrets in logs, manifest permissions, opt-in save prompt with optional notes: sender/origin checks, locked flow, update vs save, notes saved/appended/limited, redirects, never list, TTL/wipe-on-lock, untrusted events ignored, closed shadow root; server switching: URL validation, per-server storage namespaces, legacy migration, popup-only `server.set`) | 61 / 61 |
| `apps/desktop` (IPC client, hop building, host-key trust, paste guard, link handler, lock hook, clipboard, storage keys, Keychain token, server selection & isolation) | 62 / 62 |
| `native/desktop-helper` Go, `-race` (host-key accept/mismatch, jump hosts, password/key/keyboard-interactive auth, PTY resize, disconnect cleanup, agent lock/approval/forwarding, IPC validation, no secrets in logs/argv, 0600 exports) | all packages pass (52 tests) |
| `tests/acceptance` — 12 multi-user/multi-device scenarios against the Podman stack **and** through the production TLS edge | 12 / 12 (both) |
| Walkthrough video (`tests/e2e-video`) — Playwright drives the real UI against the real API | recorded, 120 s |

## Implemented and verified

- Registration with email verified **before** account creation; mandatory TOTP enrollment; one-time recovery codes; trusted devices; sessions/devices management; reauth; logout everywhere; vault recovery with recovery key; destructive account reset.
- Client-side encryption of all sensitive fields; versioned envelopes; per-record keys; encrypted version history; tombstones.
- All item types (login, SSH server, SSH key, database, API credential, `.env` file, secure note), custom fields, projects/environments, favorites, archive, trash, bulk actions, duplicate.
- Local search (never secret values), filters, sorting, weak/reused/expiring/HTTP insights, password and passphrase generators.
- `.env` lossless parsing, structured and raw editing, per-variable notes, compare environments (masked), history diff, restore, export with plaintext confirmation.
- Sharing of items and projects with fingerprint pinning, roles, resharing control, expiry, invitations, revocation with key rotation + re-encryption, rotation guidance.
- Sync with offline queue, idempotent mutations, conflict detection and resolution UI, access-loss purge.
- Web dashboard (light/dark, keyboard shortcuts, command palette, responsive), offline unlock from IndexedDB.
- Browser extension (MV3): login/MFA/unlock, site matching, user-initiated top-frame fill with origin re-check, save/update from page, **opt-in automatic "Save / Update password?" prompt after sign-in** (optional all-sites permission, closed shadow-root UI, trusted events only, 3-minute in-memory capture), copy with clipboard clearing, generator, service-worker resume via `storage.session`, alarm-based lock. **Server picker: local development, the built-in production server, or any https address** (Chrome grants host access per server; each server has its own sign-in and encrypted cache). Verified in a real Chromium (headless) with an offline account; the save prompt (incl. notes) verified with trusted Playwright input; server switching verified in the real toolbar popup against the local API (9/9).
- Desktop app: Neutralino shell + Go helper; Keychain session storage; embedded SSH terminal with host-key trust/mismatch handling, keyboard-interactive prompts, resize, disconnect; SSH agent with per-use approval; lock on screen lock/sleep; server switch (production ↔ local) with per-server isolation; universal/arm64/x64 bundles launch and connect to the helper. Verified against a local test SSH server.
- Production deployment stack (Podman + Caddy TLS + Postgres), pre-flight `deploy.sh`, encrypted `backup.sh`; rehearsed locally in `NODE_ENV=production` with a restore drill.
- CI (`ci.yml`) and release pipeline (`release.yml`, actionlint-clean).

## Implemented, not verified here

| Item | Why | How to verify |
|---|---|---|
| Developer ID signing, notarization, stapling, signed DMG | no Apple Developer credentials | run `release.yml` with the Apple secrets, or `scripts/sign-and-notarize.sh` locally |
| Touch ID unlock | needs signed build + provisioning profile for the keychain-access group | signed build with `HELPER_LAYOUT=bundle`; enable in Settings → Preferences |
| Chrome Web Store publishing | no store credentials | set `CWS_*` secrets; tag a release |
| Real public domain + Let's Encrypt, real SMTP provider | DNS record and provider account not yet created | `deploy/deploy.sh --check` then `deploy/deploy.sh` on the server |
| External Terminal.app / iTerm launch | would open windows on the developer's desktop | Server item → Open in Terminal.app (parameters are unit-tested) |
| Native menu/tray clicks, real save/open panels in the desktop window | could not drive the native window from automation | manual check on a Mac |
| Release workflow end to end | requires pushing a tag to GitHub | `git tag v0.1.0 && git push origin v0.1.0` after setting `PV_PRODUCTION_URL` |

## Deferred (by design or scope)

- Cross-origin iframe autofill/capture.
- Desktop ↔ extension pairing over native messaging.
- aPAKE (OPAQUE) login instead of the derived `authKey`.
- Detection of server-side record rollback (signed revision chains).
- Re-encrypting the personal vault (personal VK rotation) after device compromise — User Key rotation is implemented.
- Lazy-loading the password-strength dictionaries (web bundle ~3 MB).
- SBOM generation, SHA-pinned GitHub Actions, signed container images.

## Known limitations

- Encryption does not protect an unlocked compromised device, a malicious client update (in particular, the operator serves the web app's JavaScript), keyloggers, or secrets already copied.
- Revocation cannot erase copies; previously obtained keys can decrypt previously downloaded ciphertext; the underlying passwords/tokens/SSH authorizations must be rotated at the source.
- Offline clients cannot learn about revocation, expiry, or deletion until they reconnect.
- Locking the vault does not terminate SSH sessions launched in external terminals or sessions that already authenticated through the agent.
- The SSH agent cannot reliably identify the destination host; it shows a verified host key only when OpenSSH sends a verifiable `session-bind`.
- JavaScript and Go cannot guarantee erasure of memory; deleting exported files does not guarantee secure erasure on SSDs.
- Audit logs record server-observable actions only — not local reveals, copies, autofills, or offline use.
- Minimum macOS for the desktop app is 14 (Neutralino 6.10 binaries).

See [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for what must happen before real production secrets are stored.
