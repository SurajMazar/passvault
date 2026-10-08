# Residual risks and unverified checks

What remains after the October 2026 review. This is not a list of things that
"probably work": anything here is either a known limitation, an accepted risk
with an owner and expiry, or a property the harness could **not** verify in
this environment. Nothing in this repository should be read as a claim that
PassVault is "fully secure".

## Accepted risks (failing checks, time-limited)

| ID | Check | Risk | Owner | Expires |
|---|---|---|---|---|
| AR-1 | `crypto.rollback-detection` | PV-SEC-004: a malicious server can serve an older revision of a record, or withhold updates/deletions/revocations, without clients noticing. Needs a protocol change (authenticated revisions or a signed per-vault log) and **specialist cryptographic review**. | maintainer (@SurajMazar) | 2027-01-31 |

## Known limitations (by design or out of scope)

| Area | Limitation | Why it stays |
|---|---|---|
| Compromised client (A11) | Malicious code inside an **unlocked** client (XSS, malicious browser extension, tampered build, keylogger) sees what the user sees. Encryption cannot prevent this; CSP, the minimal desktop allowlist (PV-SEC-002) and helper-side validation only limit its reach. | Inherent to client-side encryption |
| Web dashboard served by the operator | The server delivers the web app's JavaScript and could deliver a malicious version (T4). Use the desktop app or extension for higher assurance. | Documented non-goal |
| First-share key substitution | Sharing with someone for the first time trusts the server-provided public key (TOFU) unless the fingerprint is compared out of band; later changes are blocked. | Usability trade-off; fingerprint UI exists |
| Revocation | Revocation stops **future** access. Anything a removed member already decrypted, copied, exported or memorised cannot be recalled; rotate the underlying secrets at their source. | Physics |
| Memory erasure | JavaScript and Go do not guarantee that key material is erased from memory; buffers are wiped best-effort. | Runtime limitation |
| Clipboard | Copied secrets are cleared after a timeout only if the clipboard still holds them; clipboard managers/history can keep copies. | OS limitation |
| Account lockout DoS | Anyone who knows an email can trigger progressive lockout (up to 24 h) for that account. | Trade-off against online guessing; MFA still required |
| Enumeration via prelogin | Accounts created with **non-default** KDF parameters return those parameters from prelogin; unknown emails always get the defaults. | Changing it would need per-email fake parameters that mimic real distributions |
| Per-replica limits | Per-email rate limits and the unknown-account lockout (PV-SEC-001) are in memory per API replica. | Documented in OPERATIONS.md; use one replica or a shared store |
| Webview token race | A same-user process that requests the desktop webview's globals before the webview does could obtain the one-time token. In window mode the webview loads immediately at start. | Same-user malware is largely out of scope (it could also read the user's files) |
| SSH agent destination | The agent cannot reliably know which server a signature is for; it shows a verified host-key fingerprint only when OpenSSH sends session-bind data and refuses forwarded requests. | Protocol limitation |
| Existing SSH sessions | Locking the vault closes app-managed sessions and stops agent signing, but sessions opened in Terminal.app/iTerm continue. | Separate processes |
| Audit privacy | PV-SEC-006: owners see members' IP prefixes/device ids for vault events. | Needs a product decision |
| Dev-only tooling | `tests/e2e-video` (video generation) depends on `kokoro-js` → `sharp`/libvips with known advisories. Never part of a shipped artifact; runs only on maintainers' machines. | Upgrade when kokoro-js/transformers allow sharp ≥ 0.35.5 |
| Container base images | `node:22-alpine` / `postgres:16-alpine` are pinned by tag, not digest. | Pin digests in the deployment repo if reproducible builds are required |
| Interrupted writes | Not fault-injected (`sync.interrupted-writes` unverified); multi-row operations are shown to be atomic (`sync.atomic-rotation`), single-row writes rely on PostgreSQL transactions. | Needs database fault injection |

## Unverified in the reference run

These checks could not run in the environment of the latest harness run (see
`REPORT.md` for the exact list of that run). They are not passing.

| Check | Why | How to verify |
|---|---|---|
| `native.keychain.biometric-runtime` | Needs a Developer-ID-signed build with the `keychain-access-groups` entitlement and a person to touch the sensor. The code path is verified statically (`native.keychain.biometric-acl`) and unsigned builds correctly report biometrics as unavailable. | [RUNBOOK.md](RUNBOOK.md#touch-id) |
| `native.govulncheck` | govulncheck not installed locally. | Runs in CI (`security.yml` → govulncheck) |
| `sc.gitleaks` | gitleaks not installed locally; the built-in pattern scanner over files, history and artifacts ran instead. | Runs in CI (`security.yml` → secrets) |
| `sc.sbom` | syft not installed locally; a JSON dependency inventory is produced instead (not a standard SBOM). | Runs in CI (`security.yml` → sbom) |
| `sync.interrupted-writes` | See above. | Database fault injection (future work) |
| Real-hardware desktop flows | Sleep/screen-lock events, Touch ID and Keychain prompts on a signed build. | [RUNBOOK.md](RUNBOOK.md) |

## Needs independent review

- The cryptographic design as a whole ([CRYPTO.md](../CRYPTO.md)) and the
  rollback/freshness fix for PV-SEC-004. The harness checks the implementation
  against independent libraries and for misuse; it does not prove the protocol
  secure.
- Neutralinojs itself (closed-world assumption that only allowlisted native
  APIs are reachable, and how its macOS dialogs build their commands).
- The production deployment (TLS, Caddy headers live, backups, host hardening):
  the harness checks configuration files, not a deployed server.
