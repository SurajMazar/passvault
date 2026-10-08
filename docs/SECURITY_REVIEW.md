# Required security review before production use

PassVault has **not** been independently audited. Do not store real production
secrets in it until the items below are complete.

An internal, automated verification harness exists ([security/HARNESS.md](security/HARNESS.md))
and its latest results are in [security/REPORT.md](security/REPORT.md), with
confirmed findings in [security/FINDINGS.md](security/FINDINGS.md) and open
items in [security/RESIDUAL_RISKS.md](security/RESIDUAL_RISKS.md). It is
evidence for the properties it checks, not a substitute for the independent
review below.

## Must do

1. **Independent cryptographic review** of `packages/crypto` and
   [CRYPTO.md](CRYPTO.md): key hierarchy, AEAD contexts, grant signatures,
   recovery-key flow, rotation semantics.
2. **Authentication protocol review.** The current design sends an
   Argon2id-derived `authKey` (password-equivalent for login). Evaluate migrating
   to an aPAKE such as OPAQUE (e.g. `opaque-ke`) so the server never receives a
   password-equivalent value; the KDF/version fields allow a migration.
3. **Penetration test** of the API (authz on every route, rate limits, lockout,
   recovery, invitation and rotation flows) and of the web app (XSS, CSP, token
   handling).
4. **Extension review**: message validation, injected functions, matching rules
   against phishing corpora, MV3 service-worker key handling.
5. **Native helper review**: IPC validation, agent socket permissions,
   `session-bind` verification, external-terminal script generation, cgo
   Keychain code, entitlements and hardened runtime.
6. **Supply chain**: lockfile review, reproducible builds, signing keys in an
   HSM. (Done: CI fails on high/critical `pnpm audit` advisories, runs
   govulncheck, gitleaks and an SBOM job, and pins actions by SHA — see
   `security.yml`.)
7. **Operational hardening**: TLS termination + HSTS, secret management for
   `MFA_ENCRYPTION_KEY`/peppers (KMS), encrypted backups with restore drills,
   log retention, monitoring for brute-force patterns.
8. **Web client trust**: decide whether to serve the dashboard from a separate,
   integrity-protected origin (or recommend desktop/extension for sensitive
   users) because the server operator controls web JavaScript.

## Known gaps to decide on

- Record rollback by a malicious server is not detected (consider signed
  per-record revision chains).
- Server can delete or withhold data (availability is not cryptographically
  protected).
- First-contact key pinning is TOFU unless users verify fingerprints.
- JavaScript/Go memory cannot be reliably wiped.
- The User Key is held in `chrome.storage.session` while the extension is
  unlocked (needed for MV3 service-worker restarts).
- Biometric unlock requires a Developer ID–signed build with the keychain
  entitlement; unsigned builds disable it.
