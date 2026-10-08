# Security findings

Findings confirmed by the security harness ([HARNESS.md](HARNESS.md)) during
the October 2026 review. Every finding was reproduced with synthetic data on
the disposable stack or in isolated tests; regression checks are listed so
they cannot silently return. Severity reflects impact under the stated
preconditions, not scanner scores.

| ID | Title | Severity | Status |
|---|---|---|---|
| [PV-SEC-001](#pv-sec-001) | Account lockout revealed which emails have accounts | Medium | **Fixed, verified** |
| [PV-SEC-002](#pv-sec-002) | Desktop webview could reach a shell through the native API allowlist (`os.open`) | High | **Fixed, verified** |
| [PV-SEC-003](#pv-sec-003) | GitHub Actions referenced by mutable tags | Medium | **Fixed, verified** |
| [PV-SEC-004](#pv-sec-004) | No client-side detection of record rollback by the server | Medium | **Open — design; accepted risk AR-1 until 2027-01-31** |
| [PV-SEC-005](#pv-sec-005) | High-severity advisories in production dependencies; CI audit was report-only | High | **Fixed, verified** |
| [PV-SEC-006](#pv-sec-006) | Vault owners see members' IP prefixes and device ids in the audit log | Low (privacy) | Open — needs a product decision |

---

## PV-SEC-001

**Account lockout revealed which emails have accounts** — Medium — *Fixed, verified*

- **Component:** API, `apps/api/src/auth/auth.service.ts` (`login`, `checkCredentials`).
- **Preconditions / attacker:** unauthenticated; can send login attempts for chosen emails and wait out the per-email rate-limit window (15 min).
- **Reproduction (synthetic):** for a registered email and an unregistered one, send 9 wrong logins, wait 16 minutes, send 3 more. Before the fix the registered account answered `429 rate_limited "Too many failed attempts"` (lockout) while the unregistered email kept answering `401 invalid_credentials`.
- **Expected vs observed:** identical answers for both (as already done for prelogin, register/start, recovery/start) vs a distinguishable `429`.
- **Impact:** account enumeration (targeting for phishing/credential stuffing).
- **Fix:** `UnknownAccountLockout` (`apps/api/src/auth/unknown-account-lockout.service.ts`) applies the same failure counting and progressive lockout to emails without an account (in memory, keyed by SHA-256(email), bounded, kept 30 days).
- **Regression coverage:** `apps/api/test/security.e2e.test.ts` → harness check `auth.time-dependent` (fake clock, production limits; compares full transcripts). The test failed before the fix and passes after it.
- **Residual:** state is per API replica (same caveat as the per-email limiter); accounts created with non-default KDF parameters remain distinguishable through prelogin (see RESIDUAL_RISKS).

## PV-SEC-002

**Desktop webview could reach a shell through the native API allowlist (`os.open`)** — High — *Fixed, verified*

- **Component:** desktop app, `apps/desktop/neutralino.config.json` (`nativeAllowList`), `src/main.tsx`, `src/platform/desktop-platform.ts`.
- **Preconditions / attacker:** script execution inside the desktop webview (an XSS bug, or a tampered UI asset). Client-side encryption does not help once script runs there, but such script should not gain native code execution.
- **Issue:** the allowlist exposed `os.open`, which Neutralinojs implements on macOS as `open "<url>"` through `/bin/sh`. The UI only passed confirmed, percent-encoded http(s) URLs, but any script in the webview could call the API directly with a crafted string → arbitrary shell commands as the user. The allowlist also contained unused APIs (`app.broadcast`, `window.hide`, `window.isVisible`, `os.showMessageBox`, `computer.getOSInfo`).
- **Expected vs observed:** a minimal allowlist with no shell-backed primitive vs `os.open` + 5 unused APIs.
- **Impact:** webview compromise → native command execution (full user-level compromise, including the unlocked vault and SSH agent).
- **Fix:** new helper operation `link.open` (`native/desktop-helper/internal/links`): validates http/https with a host, no credentials/whitespace/control characters, and launches `/usr/bin/open <url>` with an argv list (no shell). The UI uses it for every external link; `os.open`, `window.hide`, `window.isVisible`, `os.showMessageBox` and `computer.getOSInfo` were removed from the allowlist and the `NeutralinoLike` type.
- **Note on the fix itself:** the first version of the fix also removed `app.broadcast` as "unused by the UI". It is used by the **helper** to deliver every response and event to the UI, so that build would not have worked at all; the UI unit tests use a fake transport and did not notice. It was caught by re-reading DESKTOP_HELPER.md, restored, and two guards were added: a unit test that requires `app.broadcast`/`extensions.dispatch`, and the runtime check `desktop.runtime.helper-roundtrip`, which loads the packaged app's UI and fails unless the helper answers it.
- **Regression coverage:** `desktop.config.native-allowlist`, `desktop.no-direct-native-exec`, `desktop.runtime.helper-roundtrip` (harness); `apps/desktop/test/platform.test.ts` ("external links (PV-SEC-002)"); `internal/links/links_test.go` (scheme/argv rules); `native.no-shell`.
- **Verification:** desktop unit tests 64/64, Go tests pass, harness desktop suite re-run against the rebuilt app (see REPORT.md).

## PV-SEC-003

**GitHub Actions referenced by mutable tags** — Medium — *Fixed, verified*

- **Component:** `.github/workflows/*.yml`.
- **Preconditions / attacker:** control of an upstream action's tag (compromised maintainer or repository).
- **Issue:** `actions/checkout@v4`, `pnpm/action-setup@v4`, … resolve to whatever the tag points to at run time; the release workflow holds signing and store credentials.
- **Impact:** a moved tag could run attacker code with release secrets.
- **Fix:** every action pinned to a full commit SHA (version kept as a comment).
- **Regression coverage:** `sc.ci.actions-pinned`; `sc.ci.least-privilege` (read-only default token, no `pull_request_target`, no secrets reachable from PR jobs).

## PV-SEC-004

**No client-side detection of record rollback by the server** — Medium — *Open (design); accepted risk AR-1*

- **Component:** record format (`packages/crypto/src/records.ts`), sync.
- **Preconditions / attacker:** malicious or compromised server (A2).
- **Issue:** a record's payload AAD binds the record id but not its revision. The server can return an older `(encryptedKey, encryptedPayload)` pair (for example from history) as the current version; the client decrypts it without error. The same applies to withholding updates, deletions or revocations.
- **Reproduction:** `crypto.rollback-detection` decrypts revision 1 presented in place of revision 2 without any error.
- **Impact:** integrity/freshness only (e.g. a rotated-out password resurfaces, a deleted item reappears); no confidentiality loss.
- **Recommended fix (needs specialist review):** bind a client-authenticated revision counter into the payload AAD and keep per-device high-water marks, or sign a per-vault append-only change log (hash chain) that clients verify. Both change the protocol and need migration.
- **Status:** check `crypto.rollback-detection` stays **failing** by design; covered by accepted risk AR-1 (owner @SurajMazar, expires 2027-01-31) in `tests/security/accepted-risks.json`.

## PV-SEC-005

**High-severity advisories in production dependencies; CI audit was report-only** — High — *Fixed, verified*

- **Component:** `apps/api` (`nodemailer` 7.0.13; `prisma` → `@prisma/config` → `deepmerge-ts` 7.1.5), CI (`pnpm audit --prod || true`).
- **Advisories (pnpm audit):** nodemailer — SMTP command/CRLF/header injection and a `raw` option file-read/SSRF bypass (4 high, 4 moderate, 1 low); deepmerge-ts — stack exhaustion on recursive objects (high); sharp/libvips via the dev-only video tooling (high).
- **Reachability (assessed, not assumed):** PassVault builds every message itself (fixed headers, server-generated text, recipient validated as an email address) and never uses `raw`, so the nodemailer issues were hard to reach; deepmerge-ts runs only on Prisma's configuration at migration time. Fixed regardless, because mail and migrations run in production.
- **Fix:** nodemailer 10.0.10 (`@types/nodemailer` 8.0.2), `pnpm.overrides` deepmerge-ts 8.0.2, test-only tooling moved to `devDependencies` (never shipped). CI now fails on high/critical (`ci.yml`, `security.yml`).
- **Regression coverage:** `sc.npm-audit`, `sc.ci.security-gate`; API e2e 41/41 and the harness auth/leakage suites send real mail through Mailpit with the new version.
- **Residual:** the dev-only video tooling still pulls a vulnerable `sharp` (not part of any shipped artifact; tracked in RESIDUAL_RISKS).

## PV-SEC-006

**Vault owners see members' IP prefixes and device ids in the audit log** — Low (privacy) — *Open*

- **Component:** `apps/api/src/audit/audit.service.ts` (`list`).
- **Issue:** owners of a shared vault receive every vault-scoped audit event, including the actor's `ipPrefix` and `deviceId`, for actions by other members (also events from before they became owner).
- **Impact:** limited disclosure of members' network location and devices to co-owners. Authorization itself is correct (`authz.audit-isolation`).
- **Recommendation:** decide whether owners need this; if not, drop `ipPrefix`/`deviceId` from events whose actor is someone else.
