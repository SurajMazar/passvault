# PassVault architecture

PassVault is an end-to-end-encrypted password and developer-secrets manager
for individuals and small teams. It stores website logins, SSH servers and
keys, database credentials, API tokens, `.env` files, and secure notes, and is
used from three clients — a web dashboard, a Manifest V3 browser extension,
and a macOS desktop app — backed by a NestJS/PostgreSQL API that only ever sees
ciphertext and authorization metadata.

This document explains how the system is put together and why. Companion
documents go deeper on specific areas:

| Topic | Document |
|---|---|
| Cryptography and key management | [CRYPTO.md](CRYPTO.md) |
| Threats, trust boundaries, mitigations | [THREAT_MODEL.md](THREAT_MODEL.md) |
| HTTP API contracts | [API.md](API.md) |
| Data model and server-visible metadata | [DATA_MODEL.md](DATA_MODEL.md) |
| Sync and offline behaviour | [SYNC.md](SYNC.md) |
| `.env` parsing and editing | [ENV_FILES.md](ENV_FILES.md) |
| Browser extension | [EXTENSION.md](EXTENSION.md) |
| Desktop app; native helper; IPC | [DESKTOP.md](DESKTOP.md), [DESKTOP_HELPER.md](DESKTOP_HELPER.md), [DESKTOP_IPC.md](DESKTOP_IPC.md) |
| Deployment and operations | [DEPLOYMENT.md](DEPLOYMENT.md), [OPERATIONS.md](OPERATIONS.md) |

---

## 1. Design principles

1. **Zero-knowledge server.** Everything sensitive — titles, usernames, URLs,
   hosts, notes, tags, project names, `.env` contents — is encrypted on the
   client before it leaves the device. The server enforces *authorization* on
   identifiers and memberships; it never needs to read content.
2. **Separate account access from vault access.** Logging in (password-derived
   `authKey` + mandatory TOTP) proves who you are; unlocking (decrypting the
   User Key) happens locally and works offline. Resetting account access can
   never silently bypass vault encryption.
3. **One client core, three shells.** `packages/vault-core` (session, crypto
   orchestration, sync, search, insights) and `packages/app` (React UI) are
   shared; each client contributes only a small platform adapter.
4. **Native power behind a narrow door.** SSH, PTY sessions, the SSH agent,
   Keychain and Touch ID live in a small Go helper that exposes a typed,
   validated, allow-listed operation set — never a generic shell.
5. **Never overwrite silently.** Optimistic concurrency, idempotent mutations,
   conflict UI, tombstones, encrypted version history.
6. **Honest limits.** Encryption cannot protect an unlocked compromised device,
   a malicious client update, or secrets a collaborator already copied; the UI
   and docs say so where it matters.

---

## 2. System context

```mermaid
flowchart LR
  user([User])
  collab([Collaborator])
  subgraph clients[Clients — all decryption happens here]
    web[Web dashboard<br/>React + Vite]
    ext[Browser extension<br/>MV3 service worker + popup]
    desk[macOS desktop app<br/>Neutralinojs + Go helper]
  end
  api[(PassVault API<br/>NestJS + PostgreSQL)]
  mail[SMTP provider]
  sites[Websites]
  ssh[SSH servers]
  term[Terminal.app / iTerm]

  user --> web & ext & desk
  collab --> web
  web & ext & desk -- "HTTPS · bearer session · ciphertext only" --> api
  api -- "6-digit codes, recovery links<br/>(no vault data)" --> mail
  ext -- "user-initiated fill<br/>(top frame, origin re-checked)" --> sites
  desk -- "SSH via helper<br/>(host key verified)" --> ssh
  desk -- "validated args + agent socket" --> term
```

---

## 3. Containers and components

```mermaid
flowchart TB
  subgraph Web["apps/web"]
    W1["main.tsx<br/>web Platform:<br/>sessionStorage token,<br/>IndexedDB cache"]
  end
  subgraph Ext["apps/browser-extension"]
    E1[background.js<br/>VaultSession owner,<br/>message validation,<br/>alarms lock]
    E2[popup<br/>React UI]
    E3[offscreen<br/>clipboard clear]
    E2 <-- "typed messages (zod)<br/>sender-checked" --> E1
    E1 --> E3
  end
  subgraph Desk["apps/desktop"]
    D1[Neutralino shell<br/>window · tray · dialogs · storage]
    D2[React UI + desktop Platform<br/>terminal xterm.js · server picker]
    D3["pv-helper (Go)<br/>SSH · remote PTY · agent ·<br/>Keychain · Touch ID · sys events"]
    D2 <-- "Neutralino extension channel<br/>(token-authenticated loopback WS)" --> D3
    D1 --- D2
  end
  subgraph Shared["shared packages"]
    APP[packages/app<br/>dashboard UI]
    UI[packages/ui<br/>design system]
    CORE[packages/vault-core<br/>VaultSession]
    SYNC[packages/sync<br/>outbox + cache]
    CRYPTO[packages/crypto<br/>libsodium]
    ENV[packages/env-parser]
    CLIENT[packages/api-client]
    VAL[packages/validation<br/>zod]
    TYPES[packages/types]
  end
  subgraph API["apps/api"]
    A1[Auth · MFA · Sessions · Recovery]
    A2[Vaults · Members · Rotation]
    A3[Records · Versions · Sync]
    A4[Audit · Jobs · Health]
    DB[(PostgreSQL<br/>Prisma)]
    A1 & A2 & A3 & A4 --> DB
  end
  W1 --> APP
  D2 --> APP
  E2 --> UI
  E1 --> CORE
  APP --> UI & CORE
  CORE --> CRYPTO & SYNC & CLIENT & ENV & VAL
  SYNC --> CLIENT
  CLIENT --> TYPES
  VAL --> TYPES
  API --> VAL
  CLIENT -- HTTPS --> API
```

### Package dependency graph

```mermaid
flowchart LR
  types[types] --> validation[validation]
  types --> api-client[api-client]
  validation --> api-client
  api-client --> sync[sync]
  crypto[crypto]
  env-parser[env-parser]
  crypto & sync & api-client & env-parser & validation & types --> vault-core[vault-core]
  ui[ui]
  vault-core & ui --> app[app]
  app --> web[apps/web]
  app --> desktop[apps/desktop]
  vault-core & ui --> extension[apps/browser-extension]
  types & validation --> apiapp[apps/api]
  vault-core --> acceptance[tests/acceptance]
  vault-core --> video[tests/e2e-video]
```

`types` and `validation` are published to the API as CommonJS builds
(`dist/cjs`) and consumed by every client as TypeScript source (ESM), via
conditional `exports`.

---

## 4. Responsibilities by layer

| Layer | Owns | Never does |
|---|---|---|
| **crypto** | Argon2id KDF, subkeys, AEAD envelopes, sealed-box grants, Ed25519 signatures, recovery keys, generators | network, storage, UI |
| **vault-core** | `VaultSession`: register/login/MFA/unlock/lock, decrypt/encrypt records, sharing & rotation, versions, conflicts, local search & insights, URL matching | persist plaintext; talk to native APIs directly |
| **sync** | encrypted cache stores (IndexedDB, KV, memory), outbox with mutation ids and base revisions, pull by cursor, tombstones, purge on lost access | decrypt anything |
| **app / ui** | dashboard screens, dialogs, command palette, theming, accessibility | crypto decisions (delegates to vault-core) |
| **platform adapters** | token storage, prefs, cache store, clipboard, file dialogs, biometrics, external links, extension points | business rules |
| **pv-helper** | SSH client + jump hosts + host-key checks, remote PTY, SSH agent with per-use approval, Keychain/Touch ID, system lock/sleep events, external terminal launch, 0600 exports | generic command execution; logging secrets; accepting unknown ops/fields |
| **API** | identity, sessions, MFA, recovery, memberships & roles, record storage with revisions/versions/tombstones, sync cursor, audit, rate limits | decrypting or parsing envelopes |

---

## 5. Key hierarchy

```mermaid
flowchart TB
  pw[/Master password/] -- "Argon2id (64 MiB, 3 passes, per-user salt)" --> mk[masterKey]
  mk -- "kdf 'PVauthky'" --> ak["authKey<br/>→ server stores Argon2id(authKey)"]
  mk -- "kdf 'PVwrapky'" --> wk[wrapKey]
  wk -- AEAD --> uk[User Key<br/>random 32 B]
  rk[/Recovery key<br/>shown once/] -- "kdf 'PVrcwrap'" --> rwk[recoveryWrapKey]
  rk -- "kdf 'PVrcauth'" --> rak[recoveryAuthKey<br/>proof of possession]
  rwk -- AEAD --> uk
  uk -- AEAD --> xpriv[X25519 private key]
  uk -- AEAD --> epriv[Ed25519 private key]
  uk -- AEAD --> pvk[Personal vault key]
  xpriv -. "opens sealed grants" .-> svk[Shared vault keys]
  epriv -. "signs grants" .-> svk
  pvk -- AEAD --> ik[Item keys]
  svk -- AEAD --> ik
  ik -- "AEAD (XChaCha20-Poly1305,<br/>context = record id)" --> payload[Item / project payloads]
  dk[Device key in Keychain<br/>Touch ID access control] -- AEAD --> uk
```

Every symmetric envelope is versioned (`version byte · algorithm byte · nonce ·
ciphertext`) and bound to its usage context through AEAD associated data, so a
malicious server cannot swap ciphertexts between records, vaults, or key
versions. Details: [CRYPTO.md](CRYPTO.md).

---

## 6. Core flows

### 6.1 Registration (email verified first)

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant C as Client (VaultSession)
  participant A as API
  participant M as Mail
  U->>C: email
  C->>A: POST /auth/register/start {email}
  A->>M: 6-digit code (HMAC stored, existing email → "account exists" notice)
  A-->>C: 202 (identical for every email)
  U->>C: code
  C->>A: POST /auth/register/verify {email, code}
  A-->>C: registrationToken (single use, 30 min)
  U->>C: name + master password
  Note over C: Argon2id → authKey, wrapKey<br/>generate User Key, X25519/Ed25519,<br/>personal vault key, recovery key
  C->>A: POST /auth/register {token, kdf, authKey, wrapped keys, public keys}
  A-->>C: 201 userId (emailVerifiedAt set)
  C-->>U: show recovery key once (retype last group)
  C->>A: POST /auth/login → mfa_enrollment_required
  C->>A: enroll start / confirm (TOTP)
  A-->>C: session + account bundle + 10 recovery codes
  Note over C: unwrap User Key locally → vault unlocked
```

### 6.2 Login, MFA, and unlock

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant A as API
  C->>A: POST /auth/prelogin {email}
  A-->>C: KDF params (deterministic decoys for unknown emails)
  Note over C: Argon2id(password) → authKey + wrapKey
  C->>A: POST /auth/login {email, authKey, device}
  A-->>C: mfa_required + pending token (or ok with trusted-device token)
  C->>A: POST /auth/mfa/verify {code | recovery code, trustDevice?}
  A-->>C: session token + account bundle (wrapped keys)
  Note over C: wrapKey decrypts User Key → private keys → vault keys → items
  Note over C: Later "unlock" needs no server: cached bundle + password (works offline)
```

### 6.3 Saving an item and syncing

```mermaid
sequenceDiagram
  autonumber
  participant UI as UI
  participant S as VaultSession
  participant O as Outbox (encrypted cache)
  participant A as API
  UI->>S: saveItem(payload)
  S->>S: zod-validate → encrypt with item key<br/>(wrap item key under vault key)
  S->>O: enqueue {mutationId, baseRevision, ciphertext}
  S-->>UI: item shows "pending"
  S->>A: POST/PUT /records (mutationId, baseRevision)
  alt revision matches
    A-->>S: RecordDto (revision+1, seq)
    S->>O: remove entry, store record
  else newer revision on server
    A-->>S: 409 revision_conflict {current}
    S->>O: mark conflict (nothing overwritten)
    UI->>S: resolve: keep mine / theirs / both
  else network error
    S->>O: keep entry, retry later with same mutationId (idempotent)
  end
  S->>A: GET /sync?cursor=n
  A-->>S: changed records + tombstones + memberships + resyncVaults
```

### 6.4 Sharing and revocation

```mermaid
sequenceDiagram
  autonumber
  actor O as Owner (Alice)
  participant A as API
  actor R as Recipient (Bob)
  O->>A: GET /users/lookup?email=bob
  A-->>O: Bob's public keys (+ self-signature)
  Note over O: show fingerprint · pin (TOFU) · optional out-of-band verification<br/>extra confirmation for Production / private keys
  O->>A: POST /vaults (new shared vault, self-grant)
  O->>A: PUT /records/:id {vaultId} (re-wrap item keys only)
  O->>A: POST /vaults/:id/members {sealed vault key, Ed25519 signature, role, expiry}
  R->>A: GET /invitations → accept
  Note over R: verify grantor signature + sealed context<br/>(vault id, recipient, key version)
  R->>A: GET /sync (resyncVaults) → decrypt shared items
  O->>A: DELETE /vaults/:id/members/bob
  Note over O: new vault key v+1, re-encrypt every record with fresh item keys,<br/>re-grant remaining members
  O->>A: POST /vaults/:id/rotate (atomic)
  R->>A: GET /sync → vault gone → cache purged
  Note over O,R: UI: copies cannot be erased — rotate the real passwords/tokens/SSH keys
```

### 6.5 Browser-extension autofill

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant P as Popup
  participant B as Service worker
  participant T as Active tab (top frame)
  U->>P: open popup on a site
  P->>B: listMatches {tabId}
  B->>B: matchLogin(item URLs, tab URL)<br/>host-exact default · PSL incl. private suffixes
  B-->>P: matching logins (no secrets)
  U->>P: Fill
  P->>B: fill {itemId, tabId}
  B->>B: re-read tab URL, re-match, refuse non-http(s),<br/>http → needs confirmation
  B->>T: executeScript(fill, {expectedOrigin, username, password}) frameIds:[0]
  T->>T: abort unless location.origin === expectedOrigin<br/>fill visible fields only, dispatch input/change
  T-->>B: result code
```

### 6.6 Desktop SSH session with host-key verification

```mermaid
sequenceDiagram
  autonumber
  participant UI as Desktop UI
  participant H as pv-helper
  participant S as SSH server
  UI->>H: ssh.connect {target hop, jump?, trustedHostKeys, cols, rows}
  H->>S: TCP + SSH handshake
  alt key unknown
    H-->>UI: event ssh.hostKey {fingerprint, status: unknown}
    UI->>UI: show fingerprint, explain verification
    UI->>H: ssh.hostKeyDecision {trust: true}
    UI->>UI: persist key into the encrypted item
  else key changed
    H-->>UI: ssh.hostKey {status: mismatch} — connection aborted, cannot override
  end
  H->>S: auth (password / key / agent / keyboard-interactive prompts via UI)
  H->>S: pty-req + shell
  S-->>H: output (untrusted)
  H-->>UI: ssh.data → xterm.js (no OSC 52, links confirmed, multiline paste confirmed)
  Note over UI,H: vault lock → vault.locked → helper closes all sessions, clears agent keys
```

### 6.7 SSH agent signing

```mermaid
sequenceDiagram
  autonumber
  participant SSH as /usr/bin/ssh (external terminal)
  participant AG as pv-helper agent socket (0600)
  participant UI as Desktop UI
  SSH->>AG: sign request (key, data, session-bind?)
  AG->>AG: vault unlocked? key loaded? forwarded? → deny
  AG-->>UI: agent.signRequest {key, process (reported by macOS), destination verified only via session-bind}
  UI->>AG: decision: deny / once / allow for N minutes
  AG-->>SSH: signature or failure
```

### 6.8 Desktop server switch

```mermaid
flowchart LR
  A[Server picker<br/>sign-in screen or Settings] --> B{vault unlocked?}
  B -- yes --> C[confirm] --> D[session.lock<br/>wipe keys · close SSH · clear agent]
  B -- no --> E
  D --> E[save selection]
  E --> F[remount app with Platform for new origin]
  F --> G[(per-server namespaces:<br/>Keychain pv.session.&lt;scope&gt;,<br/>prefs, encrypted cache)]
```

Only two servers are offered — the configured production server and
`http://localhost:3000` — and the desktop CSP `connect-src` lists exactly those.

---

## 7. Data model (server side)

```mermaid
erDiagram
  User ||--o{ Session : has
  User ||--o{ Device : has
  Device ||--o{ Session : runs
  User ||--o{ MfaEnrollment : has
  User ||--o{ RecoveryCode : has
  User ||--o{ EmailToken : receives
  User ||--o{ Vault : owns
  User ||--o{ VaultMember : "member of"
  Vault ||--o{ VaultMember : grants
  Vault ||--o{ Record : contains
  Record ||--o{ RecordVersion : history
  User ||--o{ AuditEvent : "actor/subject"
  PendingRegistration }o--|| User : "becomes (on register)"

  User {
    uuid id
    string email
    string authKeyHash "Argon2id(authKey)"
    string kdfSalt
    string encryptedUserKey "envelope"
    string encryptedUserKeyByRecovery "envelope"
    string publicEncryptionKey
    string publicSigningKey
    string securityStamp
  }
  Vault {
    uuid id "client-generated"
    enum type "personal|shared"
    int keyVersion
    bool rotationRequired
    bigint seq
  }
  VaultMember {
    enum role "owner|editor|viewer"
    enum status
    string encryptedVaultKey "sealed box / AEAD"
    string keySignature "Ed25519"
    timestamp expiresAt
    bigint seq
  }
  Record {
    uuid id "client-generated"
    enum kind "item|project"
    int revision
    string encryptedKey
    string encryptedPayload
    timestamp deletedAt "tombstone"
    bigint seq
  }
```

What the server can and cannot observe is listed in
[DATA_MODEL.md](DATA_MODEL.md#server-visible-metadata).

---

## 8. Sync model

```mermaid
stateDiagram-v2
  [*] --> pending: enqueue (encrypted)
  pending --> [*]: 2xx → server record cached
  pending --> pending: network error → retry, same mutationId
  pending --> conflict: 409 revision_conflict
  pending --> failed: 4xx (e.g. 410 gone, 403)
  conflict --> pending: keep mine (rebased on current revision)
  conflict --> [*]: keep theirs
  conflict --> pending: keep both (new item)
  failed --> pending: retry
  failed --> [*]: discard
```

- A single Postgres sequence stamps every change; writes take a transaction-
  scoped advisory lock so sequence order equals commit order and cursors never
  skip late commits.
- Tombstones are permanent, so stale devices never resurrect deleted items.
- Losing access to a vault (revoked/expired) purges its cached records on the
  next sync. Offline devices learn about revocation only when they reconnect.

---

## 9. Trust boundaries

```mermaid
flowchart LR
  subgraph Device["User device (trusted while unlocked)"]
    subgraph Browser
      WEBUI[Web UI]
      SW[Extension SW + popup]
      PAGE[Web pages — untrusted]
    end
    subgraph Mac["macOS app"]
      NUI[Webview UI]
      HLP[pv-helper]
      KC[(Keychain)]
      OTHER[Other local processes — untrusted]
    end
  end
  SRV[(API + DB — untrusted for confidentiality,<br/>trusted for availability & authorization)]
  REMOTE[SSH servers — untrusted until host key verified]
  WEBUI & SW & NUI == "ciphertext only" ==> SRV
  SW -. "fill: selected fields only" .-> PAGE
  NUI <== "token-authenticated IPC,<br/>typed op allow-list" ==> HLP
  HLP --> KC
  OTHER -. "agent socket 0600 +<br/>per-use approval" .-> HLP
  HLP == "SSH" ==> REMOTE
```

Full analysis (adversaries, threats, mitigations, residual risk):
[THREAT_MODEL.md](THREAT_MODEL.md).

---

## 10. Deployment topology

```mermaid
flowchart LR
  inet([Internet]) -- "443 (80 → 308)" --> caddy[Caddy<br/>ACME TLS · HSTS · CSP ·<br/>static web app]
  caddy -- "/api/*" --> api[API container<br/>read-only FS, no caps, non-root]
  api -- "internal network" --> pg[(PostgreSQL 16)]
  api -- SMTP --> mail[Mail provider]
  backup[backup.sh<br/>pg_dump · age] -.-> pg
  backup -.-> offsite[(Off-host storage)]
  desktop[Desktop app] -- HTTPS --> caddy
  extension[Extension] -- HTTPS --> caddy
```

`deploy/compose.prod.yaml` + `deploy/Caddyfile` + `deploy/deploy.sh`; see
[DEPLOYMENT.md](DEPLOYMENT.md). The production URL is supplied at build/deploy
time and is never hard-coded in the repository.

---

## 11. Client capability matrix

| Capability | Web | Extension | Desktop (macOS 14+) |
|---|---|---|---|
| Register (email code first), login + TOTP, recovery codes | ✓ | login/verify, enrollment | ✓ |
| Unlock / lock / inactivity lock | ✓ | ✓ (alarms) | ✓ + screen lock / sleep |
| Biometric unlock | — | — | Touch ID via Keychain access control (signed builds) |
| All item types | ✓ | view + copy, save/update logins | ✓ |
| Local search, insights, generator | ✓ | search, generator | ✓ |
| Autofill | — | user-initiated, top frame | — |
| Save prompt after sign-in | — | opt-in ("Offer to save passwords") | — |
| `.env` structured/raw editing, history, compare | ✓ | — | ✓ |
| Projects, sharing, invitations, revocation + rotation | ✓ | — | ✓ |
| Version history / conflict resolution | ✓ | via dashboard | ✓ |
| Offline unlock of cached vault | ✓ (IndexedDB) | ✓ (IndexedDB) | ✓ (Neutralino storage) |
| SSH keys generate/inspect | import + fingerprint | — | ✓ (Go `x/crypto/ssh`) |
| Embedded SSH terminal, external terminal, SSH agent | — | — | ✓ |
| Server switch (production ↔ local) | — (served by its server) | build-time | ✓ runtime |
| Owner-only (0600) exports | browser download | — | ✓ |

---

## 12. Cross-cutting concerns

| Concern | Approach |
|---|---|
| **Validation** | One set of zod schemas (`packages/validation`) for API requests and decrypted payloads; strict objects reject unknown fields; the helper mirrors host/port/username rules in Go. |
| **Errors** | `{error:{code,message,details},requestId}`; clients map codes (e.g. `revision_conflict`, `invalid_code`, `rate_limited`) to human messages. |
| **Logging** | API: pino with redaction (no bodies, tokens, authKeys, codes, ciphertext; IPs truncated). Helper: op names, ids, error codes only. Clients: no analytics, session replay, or crash-report SDKs. |
| **Rate limiting** | per-IP global and auth limits, per-email limits on registration/recovery, progressive account lockout. |
| **Configuration** | API validates env at startup and refuses weak/missing secrets in production; clients take only public build-time URLs. |
| **Accessibility** | keyboard navigation, focus trapping in dialogs, visible focus rings, ARIA roles for lists/tabs/menus, reduced-motion support, light/dark themes. |
| **Memory hygiene** | lock wipes key buffers (`sodium.memzero`) and drops decrypted state; JS/Go GC limits are documented. |

---

## 13. Testing strategy

```mermaid
flowchart TB
  unit["Unit tests (vitest)<br/>crypto 21 · validation 7 · env-parser 65 (fuzzed round-trip)<br/>sync 9 · vault-core 15 · extension 50 · desktop 62"]
  go["Go tests (-race)<br/>pv-helper: in-process SSH servers,<br/>host keys, PTY, agent, IPC, logs"]
  e2e["API e2e (vitest + real PostgreSQL)<br/>35 tests: auth, MFA, authz, sync, sharing, rotation, recovery, log redaction"]
  acc["Acceptance (tests/acceptance)<br/>12 multi-user / multi-device scenarios<br/>against the real stack (incl. TLS edge)"]
  vid["Walkthrough video (tests/e2e-video)<br/>Playwright drives the real UI → ffmpeg"]
  unit --> e2e --> acc --> vid
  go --> acc
```

---

## 14. CI/CD

```mermaid
flowchart LR
  pr[Push / PR] --> ci[ci.yml]
  ci --> t1[typecheck + unit tests]
  ci --> t2[API e2e vs Postgres service]
  ci --> t3["macOS: helper vet/test + universal build"]
  ci --> t4[secret scan]
  tag[git tag vX.Y.Z] --> rel[release.yml]
  rel --> v[verify versions + tests]
  v --> ext["extension: build with PV_PRODUCTION_URL,<br/>manifest check, zip,<br/>optional Chrome Web Store publish"]
  v --> dsk["desktop (macos-14): universal build,<br/>Developer ID sign + notarize + staple if secrets,<br/>else UNSIGNED DMG"]
  ext & dsk --> gh[GitHub Release<br/>DMG · zip · SHA256SUMS]
```

---

## 15. Technology decisions

See [DEPENDENCIES.md](DEPENDENCIES.md) for versions and licenses. Highlights:

- **libsodium (WebAssembly)** everywhere on clients — one reviewed
  implementation for browser, MV3 service worker, Node, and the desktop webview.
- **Client-side Argon2id + derived `authKey`** (server re-hashes) instead of
  sending the password; an aPAKE (OPAQUE) upgrade path is noted in
  [SECURITY_REVIEW.md](SECURITY_REVIEW.md).
- **Opaque, hashed session tokens** rather than JWTs, so revocation is instant.
- **Global change sequence + advisory lock** for correct sync cursors at
  small-team scale.
- **NestJS 11, Prisma 6, TypeScript 5.9** — stable majors chosen deliberately.
- **Go helper** — `golang.org/x/crypto/ssh` is a mature SSH client and agent
  implementation; cgo only for Security, LocalAuthentication and AppKit.
- **Neutralinojs** for a small desktop shell without bundling a browser engine
  or Node runtime.
- **Podman** for local and production containers; Caddy for automatic TLS.
