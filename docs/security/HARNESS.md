# Security verification harness

`tests/security` is an automated harness that checks PassVault's security
properties against the **real implementation**: a disposable server stack,
real client cryptography (`@passvault/crypto`, `vault-core`), real browsers
(Playwright/Chromium), the real Go helper and the real desktop app.

A check only **passes** when its assertion actually ran and held. Checks that
cannot run here are recorded as `unverified` (missing platform/tool) or
`blocked` (deliberately not run, e.g. a destructive check against a target that
is not disposable). Neither counts as passing.

## Running

```bash
pnpm --filter @passvault/security-harness security                       # every suite (≈25–35 min)
pnpm --filter @passvault/security-harness security auth authorization    # selected suites
pnpm --filter @passvault/security-harness security:crypto                # one suite (also :auth, :sync, …)
```

Requirements: Node 22 + pnpm, Podman (or Docker with `PV_SEC_CONTAINER=docker`),
Playwright Chromium (`pnpm --filter @passvault/security-harness exec playwright install chromium`),
Go 1.25 for the native/ssh suites, macOS for Keychain/desktop runtime checks,
and the local PostgreSQL used by the API tests (`bash scripts/dev-postgres.sh start`).

| Variable | Effect |
|---|---|
| `PV_SEC_KEEP_STACK=1` | keep the disposable stack after the run (the next run reuses it) |
| `PV_SEC_SKIP_BUILD=1` | do not rebuild the API image from the working tree |
| `PV_SEC_CONTAINER=docker` | use Docker instead of Podman |
| `PV_SEC_API_PORT`, `PV_SEC_MAILPIT_PORT` | force ports (default 3000/8025 if free, else 3911/8911) |
| `PV_SEC_TARGET=<url>` | run API suites against an existing target instead (see allowlist) |

`pnpm --filter @passvault/security-harness stack:up` / `stack:down` manage the
disposable stack on its own.

## Targets and safety rules

- By default the harness starts its **own** stack: compose project
  `pv-security`, fresh random secrets, its own database volume, ports bound to
  127.0.0.1, API at `LOG_LEVEL=debug` (so the leakage suite sees the most
  verbose logs). It is deleted (`down -v`) after the run.
- `PV_SEC_TARGET` accepts loopback URLs, or a staging URL that is listed in
  `tests/security/targets.allow.json` **and** confirmed with
  `PV_SEC_I_AM_AUTHORIZED=<that url>`. Any host found in the local production
  env files (`*.env.production`) or `PV_PRODUCTION_URL` is always refused.
- Destructive checks (account reset, lockouts, rate-limit exhaustion, database
  and log inspection) run only on the disposable stack; elsewhere they are
  recorded as `blocked`.
- All accounts are synthetic (`*@sec.example.test`), all secrets are generated
  canaries, SSH targets are in-process test servers with controlled host keys.

## Suites

| Suite | What it verifies | Needs |
|---|---|---|
| `security/crypto` | AEAD/Argon2id/KDF/Ed25519/X25519/BLAKE2b equal **independent implementations** (@noble/*, hash-wasm); tampering, format strictness (no fallback), context binding (record/vault/key-version/purpose), grant verification (wrong recipient/vault/version, forged or missing signatures), nonce uniqueness, CSPRNG use, KDF bounds, key separation, padding, password change, recovery key, rollback detection | — |
| `security/env-files` | parser never executes content (static + dynamic marker), lossless round trip (5,000 fuzzed files), edits change only the target entry (3,000 fuzzed edits), issue messages never contain values, bounded time on huge/pathological input, unit tests | — |
| `security/auth` | registration (enumeration, code attempts, token single-use/binding, KDF bounds), prelogin/login enumeration, MFA required/replay/attempt limit, recovery codes single-use and race, token handling (malformed/tampered/pending/revoked), session rotation, step-up for sensitive actions, password change, no cookies, CORS, host-header injection in emails, recovery needs the recovery key, reset destroys data, per-IP throttling; **in-process API tests with a fake clock** for lockout enumeration and every expiry window | stack, Postgres |
| `security/authorization` | permission matrix: 7 roles (owner, editor, viewer, pending, revoked, expired, unrelated) × 13 operations; personal-vault isolation, identifier substitution, mass assignment, invitations, editor escalation, sessions/devices, sync isolation, pagination, lookup fields, audit isolation, revocation race | stack |
| `security/sharing` | accept-then-decrypt, viewer write refusal, revocation stops access, **offline client drops revoked vault**, rotation rules, old key useless after rotation, stale grants, last owner, expiry, client refuses mis-signed grants | stack |
| `security/sync` | idempotent replay, per-user mutation ids, stale base revision, concurrent writers, tombstones (no resurrection), cursor monotonicity, membership change mid-sync, replay after revocation, atomic rotation, sync engine and vault-core unit tests | stack |
| `security/web` | API headers, error bodies, body limits, injection, prototype pollution, path traversal, no SSRF surface, edge CSP (Caddyfile), bundle free of server secrets/source maps/third-party scripts, no secrets in URLs, **stored/reflected XSS** in Chromium with payloads in every item field | stack |
| `security/leakage` | canaries for every item type through create/edit/history/share/search/conflict; scanned in API traffic, `pg_dump`, debug logs, mail, client caches and web storage (unlocked and after lock), in plain and encoded forms | stack |
| `security/extension` | unit tests; production manifest; no remote code; real fill/capture functions in Chromium against lookalike, honeypot, hidden-only, cross-origin-iframe and sign-up pages; page cannot message the extension; trusted-input save prompt; real-popup server switching | Chromium |
| `security/desktop` | unit tests; production Neutralino config; minimal native allowlist; no direct shell/process APIs in the UI; webview CSP; runtime: no secrets in process arguments, one-time token, websocket refuses tokenless/fake-extension clients | macOS + built app |
| `security/native` | Go helper tests (IPC validation/binding/limits, filesystem export/import, Keychain, lifecycle), `go vet`, no shell (one argv-only launcher), Keychain biometric ACL, govulncheck | Go |
| `security/ssh` | Go tests with controlled servers (host-key trust/reject/timeout/mismatch-before-auth, jump hosts, passwords, passphrases, keyboard-interactive, cancel, cleanup, agent approval/locking/forwarding/socket permissions, external terminal script safety); hostile terminal output (OSC 52, OSC 8 `javascript:`/`file:`, title, DCS, window ops) in a real browser engine | Go, Chromium |
| `security/supply-chain` | lockfile consistency, `pnpm audit` (high/critical fail), secret patterns in tracked files, full git history and build artifacts, private domain not committed, gitleaks, dependency inventory + licenses, SBOM, CI least privilege, action pinning, security gate present, container hardening, release authenticity | network for audit |

## Output

Every run writes `tests/security/results/<run-id>/` (gitignored) and copies it
to `results/latest/`:

- `results.json` — machine-readable: run metadata (commit, dirty tree, platform,
  target) and one entry per check (`suite`, `id`, `title`, `status`,
  `severity`, `evidence`, `finding`, `acceptedRisk`, `durationMs`).
- `report.md` — human-readable summary, failures first.
- `artifacts/` — `permission-matrix.md`, `dependency-inventory.json`, SBOM (if syft is installed).

Evidence never contains secret values: every password, token, key and canary
the harness creates is registered and replaced by `[REDACTED]`, and the runner
scans its own output before publishing it (anything that still matches is
deleted and the run fails).

The exit code is 1 when any check fails that is not covered by an unexpired
entry in `tests/security/accepted-risks.json` (owner, expiry and rationale are
mandatory; expired entries block again).

## CI

`.github/workflows/security.yml`:

- **dependency-audit** — frozen lockfile, `pnpm audit --prod --audit-level=high` (blocking)
- **secrets** — gitleaks over the full history
- **govulncheck** — native helper
- **sbom** — CycloneDX artifact
- **harness-offline** (macOS, every PR/push) — crypto, env-files, extension, desktop (static parts), native, ssh, supply-chain
- **harness-full** (Ubuntu + Docker; main, weekly, manual) — auth, authorization, sharing, sync, web, leakage

`ci.yml` also fails on high/critical advisories. All actions are pinned to
commit SHAs; the default token is read-only.

## Adding checks

A suite is a module in `tests/security/src/suites/` exporting
`{ id, title, needsApi, run(ctx) }`. Use `t.check(id, title, fn, { severity, finding })`;
return `{ ok, evidence }` (or throw). Use `t.unverified` / `t.blocked` /
`t.notApplicable` with a reason instead of skipping silently. Register any
secret you create with `registerSecret()`.
