# Deployment guide

This guide takes PassVault from a fresh server to production, then covers
email, the browser extension, the macOS app, upgrades, backups, monitoring,
scaling, and rollback. Day-2 operations (configuration reference, log
redaction, rate limits, operator MFA reset) are in [OPERATIONS.md](OPERATIONS.md).

> Read [SECURITY_REVIEW.md](SECURITY_REVIEW.md) first. PassVault has not been
> independently audited; complete that review before storing real production
> secrets.

**What was verified for this guide (2026-10-08):** the exact stack in
`deploy/compose.prod.yaml` was built and run with Podman in `NODE_ENV=production`
behind Caddy with TLS (local CA, `PV_DOMAIN=localhost`). Health checks, security
headers, HTTP→HTTPS redirect, SPA routing, and all 12 end-to-end acceptance
scenarios (`tests/acceptance`, two users, two devices) passed through the TLS
edge, and a `pg_dump`/`pg_restore` drill reproduced identical row counts. A real
public domain with Let's Encrypt, a real SMTP provider, Chrome Web Store
publication, and Developer ID signing/notarization were **not** exercised (they
need accounts/credentials not available in the build environment).

---

## 0. Runbook: deploying to your domain

Replace `vault.example.com` with your domain throughout. The domain is never
hard-coded in the repository: production builds read it from
`apps/{web,browser-extension,desktop}/.env.production` (gitignored; copy the
committed `.env.production.example` files) or, in CI, from the repository
variable `PV_PRODUCTION_URL`. Create `deploy/.env.production` from
`deploy/.env.production.example` (gitignored, mode 600) with fresh secrets;
`PV_ACME_EMAIL`, `SMTP_HOST` and the SMTP credentials must be filled in.

1. **Server:** a Linux VM (Ubuntu 24.04 / Debian 12 / Fedora) with a public IPv4,
   2 vCPU / 2–4 GB RAM. Install Podman (`sudo apt install podman podman-compose`
   or `sudo dnf install podman podman-compose`) and git. Allow inbound TCP 80 and
   443 (and SSH from your IP only). Rootless Podman cannot bind ports below 1024
   by default: either run the stack as root, or set
   `sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80` (persist it in
   `/etc/sysctl.d/`).
2. **DNS (e.g. Cloudflare):** add
   `A  passvault  <server IPv4>` (and `AAAA` if the server has IPv6). Start with
   **Proxy status: DNS only** (grey cloud) so Caddy can obtain its Let's Encrypt
   certificate directly. If you later enable the orange-cloud proxy, set
   SSL/TLS mode to **Full (strict)** and keep "Always Use HTTPS" on.
3. **Email:** pick a transactional provider (e.g. Postmark, Resend, Amazon SES,
   Brevo, Mailgun), verify the sending domain, and add the SPF/DKIM/DMARC DNS
   records it gives you in Cloudflare (the zone currently has none). Put
   `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` (and `MAIL_FROM` if you use a
   different address) into `deploy/.env.production`, and set `PV_ACME_EMAIL`.
4. **Copy and deploy** (from the repository root on the server):

```bash
scp deploy/.env.production <user>@<server>:passvault/deploy/.env.production
```

```bash
./deploy/deploy.sh --check
```

```bash
./deploy/deploy.sh
```

   `deploy.sh` checks the env file (required values, secret lengths, mode 600,
   CORS), DNS pointing at the server and free ports, then builds, starts, waits
   for `https://vault.example.com/api/v1/health`, and verifies the
   security headers and HTTP→HTTPS redirect.
5. **First account:** open the site, create your account (email code → details →
   save the recovery key → authenticator).
6. **Backups:** create an age key **on another machine** (`age-keygen -o key.txt`),
   then schedule `AGE_RECIPIENT=<public key> ./deploy/backup.sh` daily (cron/systemd
   timer) and sync `/var/backups/passvault` off-host. Store the four server
   secrets from `deploy/.env.production` in your password manager.
7. **Extension:** upload `apps/browser-extension/dist` (zip via
   `pnpm --filter @passvault/browser-extension zip`) to the Chrome Web Store; once
   it has an id, append `,chrome-extension://<id>` to `CORS_ORIGINS` and re-run
   `./deploy/deploy.sh`.
8. **Desktop:** build/sign/notarize per [DESKTOP.md](DESKTOP.md); production
   builds already target the domain.

---

## 1. Architecture in production

```
                 ┌──────────────────────── single host (or VM) ───────────────────────┐
 Internet ──443──► caddy  (TLS via ACME, HSTS/CSP headers, static web app)            │
   (HTTP 80 → 308)   │ /api/*                                                         │
                     ▼                                                                │
                   api  (NestJS, read-only FS, no capabilities, non-root)  ──SMTP──► mail provider
                     │ internal network only                                          │
                     ▼                                                                │
                   postgres 16  (volume pgdata, not published)                        │
                 └───────────────────────────────────────────────────────────────────┘
 Clients: web dashboard (same origin) · browser extension (host permission for the API
 origin) · macOS desktop app (fixed origin http://localhost:47391, allowed via CORS)
```

Everything the server stores is either ciphertext or authorization metadata
(see [DATA_MODEL.md](DATA_MODEL.md#server-visible-metadata)). Secrets that **are**
sensitive on the server side: `MFA_ENCRYPTION_KEY`, `RECOVERY_CODE_PEPPER`,
`PRELOGIN_SECRET`, database and SMTP credentials, and the TLS private key.

### Hosting options

| Option | When | Notes |
|---|---|---|
| **A. Single host, Podman compose** (this guide) | personal / small team | `deploy/compose.prod.yaml`; simplest; verified |
| B. Podman Quadlet / systemd | same, but managed by systemd | generate units from the compose file or write `.container` units; same images and env |
| C. Managed Postgres + container platform (ECS, Cloud Run, Fly, Kubernetes) | HA / larger teams | run the API image with the same env; put the web build on any static host or the Caddy image; see §11 Scaling |

## 2. Prerequisites

- A Linux host (2 vCPU, 2–4 GB RAM is plenty for small teams) with Podman 4+
  (`podman compose` or `podman-compose`); Docker Compose also works.
- A DNS name (e.g. `vault.example.com`) with A/AAAA records pointing at the
  host; ports **80** and **443** reachable from the Internet (ACME HTTP-01/TLS-ALPN).
- An SMTP provider account for transactional mail, with SPF, DKIM, and DMARC
  set up for the sending domain.
- A secrets store for the server secrets (password manager, cloud KMS/Secrets
  Manager). Keep them **separate from database backups**.
- An off-host, encrypted backup destination (object storage with versioning).

## 3. Get the code and build the images

```bash
git clone <your fork> passvault
```

```bash
cd passvault && git checkout <release tag>
```

Images are built from the repository root (the build needs the workspace
packages). `compose.prod.yaml` builds them automatically with `--build`; to
build and push them from CI instead:

```bash
podman build -f apps/api/Containerfile -t registry.example.com/passvault-api:1.0.0 .
```

```bash
podman build -f deploy/web.Containerfile --build-arg VITE_API_URL=https://vault.example.com -t registry.example.com/passvault-web:1.0.0 .
```

Then set `PV_API_IMAGE` / `PV_WEB_IMAGE` in the env file and deploy without
`--build`. The web image bakes in `VITE_API_URL` (public, not a secret), so build
one web image per domain.

## 4. Configure secrets

```bash
cp deploy/.env.production.example deploy/.env.production && chmod 600 deploy/.env.production
```

Generate every secret independently (never reuse, never commit —
`deploy/.env.production` is gitignored):

```bash
openssl rand -hex 24      # POSTGRES_PASSWORD
```

```bash
openssl rand -base64 32   # run three times: MFA_ENCRYPTION_KEY, RECOVERY_CODE_PEPPER, PRELOGIN_SECRET
```

| Variable | Purpose | If lost / changed |
|---|---|---|
| `POSTGRES_PASSWORD` | database auth | rotate with `ALTER ROLE` + redeploy |
| `MFA_ENCRYPTION_KEY` | AES-256-GCM key for TOTP secrets at rest | users must re-enroll their authenticator (operator MFA reset) |
| `RECOVERY_CODE_PEPPER` | HMAC for MFA recovery codes and registration codes | all MFA recovery codes stop working |
| `PRELOGIN_SECRET` | deterministic decoy KDF params for unknown emails | harmless to rotate, but keep stable to avoid enumeration side channels |
| `PV_DOMAIN`, `PV_ACME_EMAIL` | public hostname, ACME contact | — |
| `CORS_ORIGINS` | exact browser origins allowed to call the API | clients get CORS errors |
| `SMTP_*`, `MAIL_FROM` | transactional email | registration/recovery mails fail |

The API validates configuration at startup and **refuses to boot** in
production with missing or short secrets, a non-HTTPS `WEB_APP_URL`, or a
non-SMTP mail transport.

`CORS_ORIGINS` must list, comma-separated and exact:

1. `https://<PV_DOMAIN>` — the web dashboard;
2. `http://localhost:47391` — the macOS desktop app (Neutralino serves its UI
   from this fixed loopback origin);
3. `chrome-extension://<id>` — the published extension's id (§8). The extension
   also works without it because its host permission bypasses CORS; listing it is
   still recommended.

## 5. First deployment

```bash
podman compose -f deploy/compose.prod.yaml --env-file deploy/.env.production up -d --build
```

On start the API container runs `prisma migrate deploy` (`MIGRATE_ON_START=true`)
and then serves; Caddy waits for the API health check, then obtains a
certificate. Verify:

```bash
curl -s https://vault.example.com/api/v1/health
```

expected `{"status":"ok","db":"ok","version":"…"}`.

```bash
curl -sI https://vault.example.com/ | grep -iE 'strict-transport|content-security|x-frame'
```

```bash
curl -sI http://vault.example.com/ | head -1
```

expected `308` redirect to HTTPS.

Then open `https://vault.example.com`, create the first account (email code →
details → recovery key → authenticator), and add a test item.

### Rehearse locally first (recommended)

The same stack runs on a laptop with Caddy's local CA and a Mailpit SMTP sink:

```bash
cp deploy/.env.production.example deploy/.env.rehearsal
```

Set `PV_DOMAIN=localhost`, `PV_PUBLIC_PORT_SUFFIX=:8443`, `PV_HTTP_PORT=8080`,
`PV_HTTPS_PORT=8443`, `CORS_ORIGINS=https://localhost:8443,http://localhost:47391`,
`SMTP_HOST=mailpit`, `SMTP_PORT=1025`, `SMTP_REQUIRE_TLS=false`, plus fresh secrets, then:

```bash
podman compose -f deploy/compose.prod.yaml --env-file deploy/.env.rehearsal --profile rehearsal up -d --build
```

Mail appears at `http://127.0.0.1:8026`. Run the end-to-end suite through the TLS edge:

```bash
podman cp passvault-prod-caddy-1:/data/caddy/pki/authorities/local/root.crt /tmp/caddy-root.crt
```

```bash
NODE_EXTRA_CA_CERTS=/tmp/caddy-root.crt API_URL=https://localhost:8443 MAILPIT_URL=http://localhost:8026 pnpm --filter @passvault/acceptance acceptance
```

## 6. TLS and the reverse proxy

`deploy/Caddyfile`:

- automatic certificates and renewal (ACME), HTTP→HTTPS redirect;
- `Strict-Transport-Security` (2 years), `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP;
- strict **CSP** for the dashboard: `script-src 'self' 'wasm-unsafe-eval'` (libsodium WebAssembly; no `unsafe-eval`), `connect-src 'self'`, `frame-ancestors 'none'`;
- immutable caching for hashed assets, `no-cache` for `index.html`;
- `/api/*` proxied to the API; the API runs with `TRUST_PROXY=1` so rate limits and
  audit IP prefixes use the real client address.

Using another proxy (nginx, a cloud load balancer)? Reproduce the same headers,
forward `X-Forwarded-For`/`X-Forwarded-Proto`, set `TRUST_PROXY` to the number of
proxy hops, and keep request-body logging **off**. After going live, consider
submitting the domain to the HSTS preload list.

## 7. Email

- Use a reputable SMTP provider; set `SMTP_REQUIRE_TLS=true` (STARTTLS) or
  `SMTP_SECURE=true` (implicit TLS, port 465).
- Configure SPF, DKIM, and DMARC for the `MAIL_FROM` domain.
- Emails contain only a 6-digit registration code or a recovery link whose token
  is in the URL fragment (`/recover#token=…`) so it never reaches server logs. No
  vault data is ever emailed.
- Registration for an existing address sends an "account already exists" notice
  with an identical API response (no account enumeration).

## 8. Browser extension

Build with production URLs (public values, not secrets):

```bash
VITE_API_URL=https://vault.example.com VITE_WEB_URL=https://vault.example.com pnpm --filter @passvault/browser-extension build
```

```bash
pnpm --filter @passvault/browser-extension zip
```

- The manifest's only host permission is the API origin; check `dist/manifest.json`.
- Publish the zip in the Chrome Web Store developer dashboard (or distribute
  privately via enterprise policy). Store-signed updates are the only update
  channel; the extension never loads remote code.
- After the first upload, note the extension id and add
  `chrome-extension://<id>` to `CORS_ORIGINS`; redeploy the API.
- Details: [EXTENSION.md](EXTENSION.md).

## 9. macOS desktop app

Build, sign, notarize, and ship a DMG as described in [DESKTOP.md](DESKTOP.md):

- requires an Apple Developer ID Application certificate, your Team ID, and a
  notarytool keychain profile; Touch ID unlock additionally requires a
  provisioning profile authorizing the keychain-access group;
- set `VITE_API_URL=https://vault.example.com` when building the desktop frontend;
- distribute the notarized, stapled DMG over HTTPS (e.g. your release page) and
  publish its SHA-256; there is no auto-updater that downloads code.

The desktop window's origin is `http://localhost:47391`; keep it in `CORS_ORIGINS`.

## 10. Upgrades

1. Read the release notes for migration or configuration changes.
2. **Back up first** (§12) and confirm the backup is readable.
3. Pull the new tag, rebuild (or pull the new image tags), and redeploy:

```bash
podman compose -f deploy/compose.prod.yaml --env-file deploy/.env.production up -d --build
```

The API applies pending migrations on start. Migrations follow an
expand-then-contract policy (additive changes first, backfill, then constraints
in a later release — see [OPERATIONS.md](OPERATIONS.md#3-migrations)), so the
previous API version keeps working against the migrated schema during the
switch. For zero-downtime deploys on a platform with multiple replicas, run
migrations as a separate one-off job (`MIGRATE_ON_START=false` on the service,
`prisma migrate deploy` in a job) before rolling the replicas.

4. Verify health and sign in. Clients pick up web changes on reload; the
   extension and desktop app update through their own signed channels.

## 11. Scaling and high availability

- The API is stateless apart from Postgres; you can run several replicas behind
  the proxy. Set `JOBS_ENABLED=true` on **exactly one** replica (scheduled
  cleanup/expiry jobs) and `false` on the others.
- Sync ordering uses a transaction-scoped advisory lock around the global
  change sequence: writes are serialized in the database. This is deliberate
  (correct cursors) and comfortable for personal/small-team load; it is the
  first bottleneck at large scale.
- Rate limiting is per API instance (in memory). Behind multiple replicas the
  effective limit multiplies; add proxy-level limits (or a shared store) if needed.
- Postgres: use a managed instance with automated backups/PITR, TLS
  (`?sslmode=verify-full` in `DATABASE_URL`), and a least-privilege role
  (the application role needs DML on its schema; run migrations with a role
  that has DDL).

## 12. Backups and disaster recovery

Back up the database daily (more often for busy teams), encrypt the dump, and
copy it off-host. With the compose stack:

```bash
podman compose -f deploy/compose.prod.yaml --env-file deploy/.env.production exec -T postgres pg_dump -U passvault -d passvault -Fc > passvault-$(date +%F).dump
```

```bash
age -r <recipient-public-key> -o passvault-$(date +%F).dump.age passvault-$(date +%F).dump && rm passvault-$(date +%F).dump
```

Restore into an **empty** database with the API stopped:

```bash
podman compose -f deploy/compose.prod.yaml --env-file deploy/.env.production stop api caddy
```

```bash
podman compose -f deploy/compose.prod.yaml --env-file deploy/.env.production exec -T postgres pg_restore -U passvault -d passvault --clean --if-exists --no-owner < passvault-YYYY-MM-DD.dump
```

```bash
podman compose -f deploy/compose.prod.yaml --env-file deploy/.env.production start api caddy
```

What backups contain and what they need:

- Backups hold ciphertext plus authorization metadata, encrypted TOTP secrets,
  and hashed credentials. They do **not** let anyone read vault contents.
- Restoring requires the **same** `MFA_ENCRYPTION_KEY` and `RECOVERY_CODE_PEPPER`;
  store them separately from the dumps, in your secrets store.
- After a restore, clients that synced changes newer than the backup still hold
  them in their encrypted outbox only if they were never acknowledged; anything
  the server had acknowledged after the backup point is lost. Communicate the
  restore point to users.

**Restore drill** (do it quarterly): restore the latest dump into a scratch
database and compare row counts of `User`, `Record`, `VaultMember`,
`RecordVersion` with production; then sign in to a scratch API pointing at it.
The 2026-10-08 rehearsal drill matched exactly (2 users, 8 records,
4 memberships, 12 versions).

## 13. Monitoring and logs

- **Health:** `GET /api/v1/health` (no secrets) — wire it to your uptime monitor;
  the container health checks use it too.
- **Logs:** the API writes structured JSON to stdout (`podman logs`), with
  request bodies, tokens, authKeys, codes, and ciphertext redacted and IPs
  truncated to /24 (/48 for IPv6). Ship them to your log platform; keep
  retention short (e.g. 30 days).
- **Alerts worth setting:** spikes in `401`/`429` on `/auth/*`, `auth.login_failed`
  and `auth.mfa_failed` audit events, repeated `recovery.*` events for one
  account, certificate expiry, disk usage of the Postgres volume, backup job failures.
- No analytics, session replay, or crash-report SDKs exist in any client; do not add them.

## 14. Rollback

1. Stop the new version.
2. If the release's migrations were additive (the policy), redeploy the previous
   image tag; it runs against the newer schema.
3. If a migration was destructive or data was damaged, restore the pre-upgrade
   backup (§12) and redeploy the previous tag.

## 15. Go-live checklist

- [ ] Independent security review items in SECURITY_REVIEW.md addressed or accepted.
- [ ] All secrets generated fresh, stored in a secrets manager, `deploy/.env.production` mode 600.
- [ ] `https://<domain>/api/v1/health` OK; HSTS, CSP, X-Frame-Options present; HTTP redirects to HTTPS.
- [ ] Registration email delivered (code arrives, SPF/DKIM pass); recovery email link opens `/recover`.
- [ ] Mandatory MFA enrollment works; recovery codes shown once.
- [ ] `CORS_ORIGINS` contains the web origin, `http://localhost:47391`, and the extension id.
- [ ] Extension published/approved; desktop DMG signed, notarized, stapled, checksum published.
- [ ] Daily encrypted off-host backups running; restore drill completed.
- [ ] Uptime monitor and log shipping in place; alerts configured.
- [ ] Postgres not exposed publicly; host firewall allows only 80/443 (and SSH from admin IPs).
- [ ] Documented operator procedure for MFA resets (OPERATIONS.md §9) and who may perform it.

## 16. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| API container exits at start with a config error | a required secret is missing/short, `WEB_APP_URL` is not https, or `MAIL_TRANSPORT` isn't smtp — read `podman logs passvault-prod-api-1` |
| Caddy restarts with `parsing caddyfile tokens for 'email'` | `PV_ACME_EMAIL` empty — set it |
| Browser shows CORS errors from the desktop app | `http://localhost:47391` missing from `CORS_ORIGINS` |
| Users never receive codes | SMTP credentials/port/TLS; check provider logs; verify SPF/DKIM |
| `429 rate_limited` during normal use | many users behind one NAT; raise `RATE_LIMIT_*` or ensure `TRUST_PROXY` is set so real client IPs are used |
| Sync shows "changes pending" that never clear | API unreachable from that client, or a failed change (Settings → Sync shows the error and Retry/Discard) |
| Prisma proposes `DROP SEQUENCE pv_change_seq` in a new migration | expected (shared sequence); delete those lines from the generated SQL |
