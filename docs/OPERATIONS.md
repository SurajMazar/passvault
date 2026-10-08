# PassVault operations guide (API server)

The API (`apps/api`, NestJS 11 + Prisma 6 + PostgreSQL) stores only
client-side encrypted envelopes plus the metadata listed in
["What the server can observe"](#what-the-server-can-observe). It never
decrypts vault data. Container runtime of choice is **Podman** (rootless);
Docker/Docker Compose also work but are not required.

## 1. Configuration reference

All configuration is via environment variables, validated with zod at startup.
Invalid or missing values abort the boot with a list of variable names and rules
(values are never echoed). Templates: `apps/api/.env.example` (bare process)
and `.env.example` (compose).

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` additionally requires `MAIL_TRANSPORT=smtp` and an `https://` `WEB_APP_URL`. `test` is the only mode allowing weak hash params and the `memory` mail transport. |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | |
| `DATABASE_URL` | — (required) | `postgresql://…` |
| `MFA_ENCRYPTION_KEY` | — (required) | exactly 32 bytes, base64. AES-256-GCM key for TOTP secrets at rest. |
| `RECOVERY_CODE_PEPPER` | — (required) | ≥ 32 bytes. HMAC-SHA256 pepper for MFA recovery codes and (domain-separated) emailed registration codes. |
| `PRELOGIN_SECRET` | — (required) | ≥ 32 bytes. HMAC key for fake prelogin KDF params. |
| `WEB_APP_URL` | — (required) | base for email links (`/recover#token=…`; the token is in the fragment so it never reaches web-server logs) and the sign-in hint in notices. Registration codes are emailed as plain 6-digit codes without a link. |
| `MAIL_TRANSPORT` | — (required) | `smtp` \| `console` (dev only, refused in production) \| `memory` (tests only). |
| `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD` | 587/false/false | SMTP via nodemailer. Use `SMTP_SECURE=true` (465) or `SMTP_REQUIRE_TLS=true` (587) in production. |
| `CORS_ORIGINS` | empty (no CORS) | comma-separated **exact** origins, e.g. `http://localhost:5173,http://localhost:47391,chrome-extension://<id>`. Wildcards/paths are rejected. |
| `TRUST_PROXY` | `false` | Express `trust proxy` (`true`, hop count, or subnets). Set it when behind a reverse proxy, otherwise per-IP rate limits see the proxy IP. |
| `SESSION_TTL_HOURS` | 720 | absolute session lifetime |
| `SESSION_IDLE_MINUTES` | 10080 | sliding idle timeout |
| `RECORD_HISTORY_LIMIT` | 50 | record versions kept per record |
| `LOG_LEVEL` | `info` | pino level |
| `AUTH_HASH_OPSLIMIT` / `AUTH_HASH_MEMLIMIT` | 2 / 67108864 | server Argon2id (`crypto_pwhash_str`) for `authKey`/`recoveryAuthKey`; values below `OPSLIMIT/MEMLIMIT_INTERACTIVE` are refused unless `NODE_ENV=test`. Hashes are upgraded on next login when raised. |
| `RATE_LIMIT_GLOBAL_PER_MINUTE` | 300 | per IP, all routes |
| `RATE_LIMIT_AUTH_PER_MINUTE` | 20 | per IP and route for prelogin/register/login/mfa/reauth/recovery/lookup |
| `RATE_LIMIT_EMAIL_PER_15_MINUTES` | 10 | per email address for login/register (prelogin ×3; fixed: register/start 5 per hour, register/verify 20 per hour, recovery/start 5 per 15 min, lookup 60 per caller) |
| `LOGIN_LOCKOUT_THRESHOLD` / `LOGIN_LOCKOUT_MINUTES` | 10 / 15 | progressive account lockout (doubles every 5 further failures, max 24 h) |
| `JOBS_ENABLED` | `true` | run background jobs in this instance |
| `BODY_LIMIT` | `3mb` | JSON body limit |

Secrets policy: there are no default secrets anywhere. Secrets shorter than 32
bytes, low-entropy/placeholder-looking values, or identical values for the three
secrets are rejected. Generate with `openssl rand -base64 32`.

## 1b. Account registration flow (email verified first)

1. `POST /auth/register/start {email}` → always `202`. For a new address a
   6-digit code (CSPRNG) is emailed; only `HMAC(pepper, email, code)` is stored
   (`PendingRegistration`, 15 minutes, 5 attempts). For an address that already
   has an account no code is created; an "account already exists — sign in or
   recover" notice is emailed instead (identical response, no enumeration).
2. `POST /auth/register/verify {email, code}` → `{registrationToken, expiresAt}`
   (single use, 30 minutes, SHA-256 stored). Wrong code → `400 invalid_code`.
3. `POST /auth/register {registrationToken, …keys}` consumes the token
   atomically and creates the account with `emailVerifiedAt = now`. No account
   row exists before this step.

## 2. Running locally

### 2a. Podman compose (full stack: Postgres 16, Mailpit, API)

One-time Podman setup on macOS (rootless by default):

```sh
brew install podman podman-compose
podman machine init        # creates the Linux VM (once)
podman machine start
podman info                # sanity check
```

Then, from the repository root:

```sh
cp .env.example .env       # fill in POSTGRES_PASSWORD (openssl rand -hex 24) and the 3 API secrets
podman compose up -d --build
curl http://127.0.0.1:3000/api/v1/health      # {"status":"ok","db":"ok","version":"…"}
open http://127.0.0.1:8025                    # Mailpit: verification/recovery mails
podman compose logs -f api
podman compose down                           # keeps the pgdata volume; `down -v` deletes it
```

- `podman compose` delegates to an installed compose provider
  (`podman-compose` or `docker-compose` talking to Podman's socket); both were
  verified. `podman-compose up -d --build` works the same way.
- The API container runs `prisma migrate deploy` on start (`MIGRATE_ON_START=true`),
  then the server as the unprivileged `node` user, read-only root FS, all
  capabilities dropped, `no-new-privileges`.
- Ports are bound to `127.0.0.1` only. Postgres is not published; use
  `podman compose exec postgres psql -U passvault passvault`.
- Rootless notes: containers run inside your user namespace in the Podman VM;
  ports < 1024 cannot be published rootless (keep 3000/8025 or put a proxy in
  front). Named volumes live inside the VM (`podman volume inspect passvault_pgdata`);
  they survive `podman machine stop` but not `podman machine rm`.
- Build the image alone: `podman build -f apps/api/Containerfile -t localhost/passvault-api:dev .`
  (context = repo root; the Containerfile copies explicit paths only, so `.env`
  files, `node_modules` and `.dev/` never enter the image).
- Compose defaults `API_NODE_ENV=development` because the local web app is
  served over http. For a real deployment set `API_NODE_ENV=production`, an
  `https://` `WEB_APP_URL`, real SMTP settings and a TLS-terminating proxy
  (`TRUST_PROXY=1`).

### 2b. Without containers (`scripts/dev-postgres.sh`)

```sh
bash scripts/dev-postgres.sh start               # local cluster on 127.0.0.1:54329, prints DATABASE_URL
cp apps/api/.env.example apps/api/.env           # set DATABASE_URL (bash scripts/dev-postgres.sh url) and secrets
pnpm --filter @passvault/api prisma:deploy       # apply migrations
pnpm --filter @passvault/api dev                 # tsc --watch + node --watch on :3000
```

`MAIL_TRANSPORT=console` prints emails (registration codes, recovery links) to stdout — dev only.

Tests: `pnpm --filter @passvault/api test` runs the e2e suite (vitest + supertest)
against a real Postgres. It uses `TEST_DATABASE_URL` or
`bash scripts/dev-postgres.sh url passvault_test`, drops and recreates the
`public` schema, then runs `prisma migrate deploy`. It refuses any database
whose name does not end in `_test`.

## 3. Migrations

- Apply in every environment with `prisma migrate deploy`
  (`pnpm --filter @passvault/api prisma:deploy`, or automatically in the
  container via `MIGRATE_ON_START=true`). Never run `prisma migrate dev` or
  `migrate reset` against production.
- The initial migration creates the global sync sequence `pv_change_seq`
  before the tables whose `seq` columns default to `nextval('pv_change_seq')`.
  Never reset or lower this sequence (clients hold cursors into it).
- Known Prisma quirk: `prisma migrate dev` / `migrate diff` always proposes
  `DROP SEQUENCE "pv_change_seq"` and default changes for the `seq` columns
  (it does not understand a sequence shared by several tables). Delete those
  statements from any generated migration before committing it.
- Safe-migration guidance: take a backup first; prefer additive, backward
  compatible changes (new nullable columns/tables, new indexes with
  `CREATE INDEX CONCURRENTLY` in a separate migration) so the old and new API
  versions can run side by side during a rollout; do destructive changes
  (drops, renames, NOT NULL tightening) in a later release once no running
  version uses the old shape; test every migration on a restored copy of
  production data first; with several replicas run migrations once (a job or
  one instance with `MIGRATE_ON_START=true`).

## 4. Backup and restore

What a backup contains: ciphertext envelopes, wrapped keys, public keys,
Argon2id hashes, HMAC'd recovery codes, AES-GCM encrypted TOTP secrets and
metadata (emails, names, memberships, timestamps, sizes, audit events, IP
prefixes). It is not plaintext vault data, but it is sensitive: it enables
offline guessing against `authKey` hashes and reveals sharing metadata.
**Encrypt backups at rest** and restrict access.

The env secrets (`MFA_ENCRYPTION_KEY`, `RECOVERY_CODE_PEPPER`,
`PRELOGIN_SECRET`) are **not** in the database. Store them separately (secret
manager) and back them up separately: without `MFA_ENCRYPTION_KEY` restored
TOTP secrets are unusable (every user would need an operator MFA reset);
without the pepper all recovery codes are invalid.

```sh
# backup (custom format, compressed), then encrypt (age shown; gpg works too)
podman compose exec -T postgres pg_dump -U passvault -d passvault -Fc --no-owner \
  > passvault-$(date +%F).dump
age -r <recipient-public-key> -o passvault-$(date +%F).dump.age passvault-$(date +%F).dump
shred -u passvault-$(date +%F).dump            # remove the plaintext dump

# restore into an EMPTY database (stop the API first)
age -d -i key.txt passvault-2026-10-08.dump.age > restore.dump
podman compose stop api
podman compose exec -T postgres pg_restore -U passvault -d passvault --clean --if-exists --no-owner < restore.dump
podman compose start api
```

Restore drill (do it regularly): restore the latest backup into a scratch
database/instance, run `prisma migrate deploy` (should be a no-op or apply only
newer migrations), boot an API against it with the production secrets, check
`/api/v1/health`, sign in with a test account and confirm records decrypt on a
client. Record the time it took. After a restore, clients whose sync cursor is
ahead of the restored sequence will see no new changes until the sequence
passes their cursor; have users sign out/in (clears caches) or bump the
sequence above the pre-incident value with `SELECT setval('pv_change_seq', <value>)`.

## 5. Logging and redaction

Logs are structured JSON (pino via nestjs-pino) on stdout.

- Request logs: request id, method, **path without query string**, status,
  duration, client IP truncated to /24 (IPv4) or /48 (IPv6).
- Never logged: request/response bodies, headers (Authorization, cookies),
  session/mfa/trusted-device/recovery/registration tokens, `authKey`,
  `recoveryAuthKey`, TOTP, recovery or registration codes, TOTP secrets, ciphertext/wrapped keys, full email
  addresses (masked as `a***@example.com`), Prisma error messages (they can
  echo query arguments; only the error type/code is logged).
- A redact list is applied as a second line of defence for keys like `authKey`,
  `token`, `code`, `email`, `encryptedPayload`.
- Every response carries `X-Request-Id`; error bodies include `requestId` to
  correlate support requests with logs.
- The `console` mail transport writes mail (including registration codes and
  recovery links) to stdout outside the logger; it is refused in production.
- An e2e test (`test/logging.e2e.test.ts`) asserts that none of these secrets
  appear in captured logs.

Audit events (`GET /api/v1/audit-events`, table `AuditEvent`) record
server-observable actions with redacted primitive metadata only.

## 6. Rate limits and lockout

- Global per-IP limit (`RATE_LIMIT_GLOBAL_PER_MINUTE`) on all routes.
- Strict per-IP limit (`RATE_LIMIT_AUTH_PER_MINUTE`) per route on prelogin,
  register/start, register/verify, register, login, MFA enroll/verify, reauth,
  recovery/* and users/lookup.
- Per-email windows for prelogin, login, register/start (5 per hour),
  register/verify, register, recovery start, and per-caller for lookup.
- Account lockout: after `LOGIN_LOCKOUT_THRESHOLD` failed `authKey` checks the
  account is locked `LOGIN_LOCKOUT_MINUTES`, doubling for every 5 further
  failures (max 24 h). Successful login resets the counter. `auth.login_failed`
  is audited. Pending MFA tokens die after 5 wrong codes; recovery links after
  5 wrong MFA/recovery-key proofs; pending registrations after 5 wrong codes
  (or 15 minutes).
- Limits are in-memory per instance. With several replicas behind a load
  balancer each enforces its own window; put an edge rate limiter in front for
  global enforcement.
- 429 responses use code `rate_limited` and a `Retry-After` header.

## 7. Background jobs

`@nestjs/schedule`, enabled by `JOBS_ENABLED=true` (run them on exactly one
replica):

| Job | Schedule | Effect |
|---|---|---|
| expire-memberships | every minute | memberships past `expiresAt` → `expired`; vault gets `rotationRequired`; audit `vault.membership_expired`. (Access is denied at request time as soon as `expiresAt` passes, independent of this job.) |
| purge | hourly | deletes expired / revoked (> 1 day) sessions, expired or used (> 1 day) email tokens, dead or used (> 1 day) pending registrations, idempotency `Mutation` rows older than 7 days. |

## 8. Health checks

`GET /api/v1/health` (no auth) → `{"status":"ok"|"degraded","db":"ok"|"error","version":"x.y.z"}`;
HTTP 503 when the database is unreachable. It never returns configuration.
Compose uses it as the container healthcheck; use it for load balancer
readiness/liveness too.

## 9. Operator-assisted MFA reset

For users who lost their authenticator **and** all MFA recovery codes.
Only after out-of-band identity verification (e.g. verified support channel,
prior knowledge checks, signed request) — an attacker who convinces an operator
gets account access, though still not vault contents.

```sh
pnpm --filter @passvault/api cli:reset-mfa -- --email user@example.com --reason "TICKET-123"
# in a container:
podman compose exec api node dist/cli/reset-mfa.js --email user@example.com --reason "TICKET-123" --yes
```

It removes the TOTP enrollment and all recovery codes, revokes all sessions,
rotates the `securityStamp` (drops trusted devices) and writes audit event
`auth.mfa_reset` with the reason. It does **not** touch vault keys or data: the
user still needs the master password (or recovery key) to unlock, and must
enroll a new authenticator at next sign-in. Interactive runs ask the operator
to retype the email; non-interactive runs require `--yes`.

## 10. What the server can observe

The server sees and stores: email address, display name, KDF parameters and
salt, Argon2id hashes of `authKey`/`recoveryAuthKey`, public keys and
signatures, wrapped (encrypted) keys, encrypted settings, encrypted TOTP
secrets, HMAC'd recovery codes; vault ids, types, membership graph (who shares
with whom, roles, expiry, invitation history, grantor); per record: id, vault,
kind (item/project), revision, envelope size, timestamps, creator/updater,
tombstones; sessions/devices (device name, client type, user agent, IP prefix,
timestamps); audit events. It cannot see vault contents, titles, URLs, usernames,
passwords, notes, settings plaintext, the master password, `wrapKey`, the User
Key or vault keys. It also cannot observe local reveals, copies, autofills,
exports, or offline use. See docs/CRYPTO.md and docs/DATA_MODEL.md.
