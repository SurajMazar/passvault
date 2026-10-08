# Security harness report

> **Composition of this report.** Run A (2026-10-08T11:39:06.428Z, all 13 suites, fresh disposable stack, commit `047d395af164` + working-tree changes) and run B (2026-10-08T11:45:47.687Z, suites auth, web, desktop re-run after three harness fixes: a transient-connection retry, a list locator scoped to the items list, and the corrected allowlist expectation that keeps `app.broadcast`). Results for auth, web, desktop come from run B, all others from run A.
>
> `web.no-secrets-in-urls` failed in run B only because of the harness's own deliberate probe (the auth suite sends a session token in a query string to prove the API refuses it). Probes are now tagged and excluded; this is pending confirmation in the next run.

- Commit: `047d395af164` (working tree had uncommitted changes)
- Platform: darwin-arm64, Node v22.13.1
- Target: http://127.0.0.1:3000 (disposable stack, deleted after the run)
- Started 2026-10-08T11:39:06.428Z, finished 2026-10-08T11:55:20.808Z
- Result: **1 blocking failure(s)**

A check passes only when its assertion ran and held. `unverified` = could not run here (platform/tool); `blocked` = deliberately not run; neither counts as passing.

| Suite | pass | FAIL | unverified | blocked | n/a |
|---|---:|---:|---:|---:|---:|
| security/crypto | 18 | 1 | 0 | 0 | 0 |
| security/env-files | 7 | 0 | 0 | 0 | 1 |
| security/auth | 23 | 0 | 0 | 0 | 3 |
| security/authorization | 102 | 0 | 0 | 0 | 0 |
| security/sharing | 11 | 0 | 0 | 0 | 0 |
| security/sync | 11 | 0 | 1 | 0 | 0 |
| security/web | 12 | 1 | 0 | 0 | 0 |
| security/leakage | 7 | 0 | 0 | 0 | 0 |
| security/extension | 13 | 0 | 0 | 0 | 1 |
| security/desktop | 9 | 0 | 0 | 0 | 1 |
| security/native | 25 | 0 | 2 | 0 | 0 |
| security/ssh | 33 | 0 | 0 | 0 | 2 |
| security/supply-chain | 13 | 0 | 2 | 0 | 0 |
| **total** | 284 | 2 | 5 | 0 | 8 |

## Failures

### crypto.rollback-detection (medium) — PV-SEC-004

A server replaying an OLDER ciphertext of the same record is detected by the client

Accepted risk **AR-1** (owner maintainer (@SurajMazar), expires 2027-01-31): PV-SEC-004: clients cannot detect a server replaying an older revision of a record. Fixing it needs a protocol change (authenticated revision numbers bound into the payload AAD plus per-device high-water marks, or a signed per-vault change log) that requires specialist cryptographic review. Impact limited to a malicious/compromised server; data stays confidential.

```
old revision decrypted without error (password field = "old value"); revisions are server metadata, not authenticated by the client
```

### web.no-secrets-in-urls (medium)

No credentials or tokens travel in URL query strings (API traffic so far; emailed links use #fragments)

```
169 requests inspected; 1 with credential-like query parameters
```

## security/crypto

| Status | Check | Evidence |
|---|---|---|
| FAIL | `crypto.rollback-detection` A server replaying an OLDER ciphertext of the same record is detected by the client (PV-SEC-004) | old revision decrypted without error (password field = "old value"); revisions are server metadata, not authenticated by the client |
| pass | `crypto.xchacha.cross-impl` Envelope AEAD equals XChaCha20-Poly1305-IETF from an independent implementation (@noble/ciphers), both directions | lengths 0,1,63,64,1000,65537: both directions round-trip with header\|\|context as AAD |
| pass | `crypto.argon2id.cross-impl` Master-key derivation equals Argon2id (v1.3, p=1) from an independent implementation (hash-wasm) | ops=2/mem=32MiB and ops=3/mem=64MiB (default) match hash-wasm argon2id byte for byte |
| pass | `crypto.subkeys.cross-impl` authKey/wrapKey derivation equals BLAKE2b keyed KDF (crypto_kdf) computed independently with @noble/hashes | contexts PVauthky, PVwrapky, PVrcauth, PVrcwrap match |
| pass | `crypto.ed25519-x25519-blake2b.cross-impl` Signatures, key agreement and fingerprints interoperate with @noble/curves and @noble/hashes | Ed25519 both directions, X25519 shared secret, BLAKE2b-256 equal |
| pass | `crypto.tamper.aead` Any modified byte of an envelope (header, nonce, ciphertext, tag) is rejected | 116 single-bit modifications rejected; truncated/empty/garbage/wrong-key rejected |
| pass | `crypto.format.no-fallback` Unknown envelope versions/algorithms are refused (no silent fallback to another format) | version 2 → UnsupportedFormatError; AEAD envelope tagged as sealed → UnsupportedFormatError; algorithm 9 → UnsupportedFormatError; sealed box tagged as AEAD → UnsupportedFormatError |
| pass | `crypto.binding.records` Record ciphertexts are bound to their record and vault (no swapping payloads or keys between records/vaults) | payload swap → DecryptionError; key-wrap swap → DecryptionError; same record claimed in another vault → DecryptionError |
| pass | `crypto.binding.account-keys` Account key wraps are bound to their purpose (user key, private keys, settings, personal vault key version, device unlock) | wrong key version, other vault, private-key purpose swap, settings→user-key, other device id: all rejected |
| pass | `crypto.grants.verification` Shared-vault key grants: wrong recipient, vault, key version, missing or forged signature are rejected | rejections: GrantVerificationError, GrantVerificationError, GrantVerificationError, GrantVerificationError, GrantVerificationError, GrantVerificationError, DecryptionError |
| pass | `crypto.public-key-binding` A substituted encryption public key is detected by the identity signature | publicKeySignature binds the X25519 key to the Ed25519 identity |
| pass | `crypto.nonces.unique` AEAD nonces are 192-bit random and do not repeat (200,000 encryptions under one key) | 200000 distinct 24-byte nonces (random nonces; no counter state to desynchronise) |
| pass | `crypto.randomness.source` Security code uses the libsodium CSPRNG (no Math.random in crypto, vault, server or client key paths) | no Math.random in source |
| pass | `crypto.generator.uniform` Password generator draws every character from the CSPRNG over the full alphabet | 25600 chars, 89 distinct symbols, chi²=102.1 (df=88) |
| pass | `crypto.kdf.bounds` KDF parameters outside the documented bounds are refused (client side) | defaults ops=3 mem=64MiB; refused: opsLimit 1, opsLimit 11, memLimit 16 MiB, memLimit 2 GiB, 15-byte salt, argon2i, version 2 |
| pass | `crypto.key-separation` Login credential, wrap key and recovery subkeys are independent | authKey ≠ wrapKey; authKey cannot decrypt encryptedUserKey; recovery and password credentials differ |
| pass | `crypto.padding` Payload sizes are hidden to 128-byte blocks | string lengths 0–99 → 170 byte envelopes |
| pass | `crypto.password-change` Changing the master password re-wraps the same user key; the old password no longer unlocks the new bundle | new password unlocks; old password → WrongPasswordError; fresh salt |
| pass | `crypto.recovery-key` Recovery key unlocks; mistyped or foreign recovery keys are rejected | typo → InvalidRecoveryKeyError (checksum); other account's key → InvalidRecoveryKeyError |

## security/env-files

| Status | Check | Evidence |
|---|---|---|
| n/a | `env.export.path` Desktop export path/symlink handling | covered by security/native (Go fsops tests: traversal, symlinks, permissions) |
| pass | `env.no-exec.static` The env parser has no code-execution or process primitives | no child_process/eval/Function/dynamic import/process.env in packages/env-parser/src |
| pass | `env.no-exec.dynamic` Importing, editing, diffing and exporting shell-substitution content never executes it | values kept literally; $(…)/${…} flagged hasInterpolation, backticks parsed as a quote style with a warning; no marker file created |
| pass | `env.roundtrip.fuzz` Raw → structured → raw is byte-for-byte lossless, including invalid and unsupported lines (5,000 random files) | 5000 generated files (seed 20261008) incl. CRLF, multiline, duplicates, invalid lines, unterminated quotes |
| pass | `env.edit.fuzz` Structured edits change only the target entry; unsafe edits are refused, never applied partially (3,000 edits) | 2697 edits applied exactly, 5 refused (seed 4242) |
| pass | `env.issues.no-values` Parser issue messages never contain value text | 5 issues reported; canary absent in messages |
| pass | `env.resource-limits` Large and pathological inputs parse in bounded time (no catastrophic backtracking) | 5 MB value 144 ms; 100k escaped quotes 3 ms; 50k lines 83 ms; unterminated quote + 20k lines 8 ms |
| pass | `env.unit-tests` env-parser unit tests (parse, edit, query, round-trip) | 65/65 passed in packages/env-parser |

## security/auth

| Status | Check | Evidence |
|---|---|---|
| n/a | `auth.email-change` Email-change flow | no email-change endpoint exists (API surface reviewed: 47 routes) |
| n/a | `auth.refresh-token` Refresh-token replay | no refresh tokens: opaque server-side sessions, looked up on every request |
| n/a | `auth.oauth-redirects` Open redirects / OAuth callbacks | the API issues no redirects and has no OAuth/SSO callbacks; emailed links are covered by auth.mail-links.host-header |
| pass | `auth.register.no-enumeration` register/start answers identically for existing and new emails | existing → 202 (empty); new → 202 (empty) |
| pass | `auth.register.code-attempt-limit` Five wrong email codes burn the code; the correct code is then refused | wrong codes: 400 invalid_code, 400 invalid_code, 400 invalid_code, 400 invalid_code, 400 invalid_code; correct code afterwards → 400 invalid_code |
| pass | `auth.register.token-single-use-and-bound` Registration tokens are single-use and bound to the verified email | token for A used with email B → 400 invalid_code; first use → 201; reuse → 400 invalid_code |
| pass | `auth.register.kdf-bounds` The server refuses registrations and password changes with KDF parameters below the minimum | opsLimit 1 → 400 validation_failed; memLimit 1 MiB → 400 validation_failed |
| pass | `auth.prelogin.no-enumeration` prelogin returns a well-formed, stable KDF record for unknown emails | unknown → algorithm,memLimitBytes,opsLimit,salt,version (salt stable: true); known → algorithm,memLimitBytes,opsLimit,salt,version. Note: an unknown email always gets the default parameters (ops 3, mem 67108864); accounts created with non-default parameters are distinguishable (documented). |
| pass | `auth.login.no-enumeration` Wrong credentials for a known account and any credentials for an unknown email get the same answer | known+wrong → 401 invalid_credentials "Invalid email or credentials"; unknown → 401 invalid_credentials "Invalid email or credentials" |
| pass | `auth.mfa.required` Password alone yields no session: the pending MFA token cannot call the API | login → status=mfa_required, session=absent; mfaToken as bearer: /account 401 unauthenticated, /sync 401 unauthenticated |
| pass | `auth.mfa.totp-replay` A TOTP code is accepted once; replaying it (same 30 s window) is refused | first use → 200; replay → 403 mfa_invalid; previous window's code → 403 mfa_invalid |
| pass | `auth.mfa.attempt-limit` Five wrong MFA codes revoke the pending sign-in (a correct code is then refused) | wrong codes: 401 mfa_invalid, 401 mfa_invalid, 401 mfa_invalid, 401 mfa_invalid, 401 mfa_invalid; correct code afterwards → 401 unauthenticated |
| pass | `auth.mfa.recovery-code-single-use` A recovery code signs in once; the same code is refused afterwards | first use → 200 (remaining 9); reuse → 401 mfa_invalid |
| pass | `auth.mfa.recovery-code-race` Concurrent redemption of one recovery code across 4 pending sign-ins succeeds exactly once | results: 401 mfa_invalid, 401 mfa_invalid, 200, 401 mfa_invalid |
| pass | `auth.session.tokens` Malformed, tampered, pending and revoked tokens are all refused | no header → 401 unauthenticated; empty bearer → 401 unauthenticated; short token → 401 unauthenticated; 200-char token → 401 unauthenticated; non-base64url chars → 401 unauthenticated; flipped last char → 401 unauthenticated; Basic scheme → 401 unauthenticated; token in query only → 401 unauthentica… |
| pass | `auth.session.rotation` Completing MFA issues a new token and retires the pending one (no fixation, no reuse) | active token differs from pending token: true; pending token reused → 401 unauthenticated |
| pass | `auth.stepup.required` Sensitive actions require a recent re-authentication (password + TOTP) | change password → 403 reauth_required; regenerate recovery codes → 403 reauth_required; sign out everywhere → 403 reauth_required; re-enroll MFA → 403 reauth_required |
| pass | `auth.reauth.recovery-code-not-accepted` Re-authentication cannot be satisfied with a recovery code or a wrong password | recovery code → 400 validation_failed; another account's authKey → 403 invalid_credentials |
| pass | `auth.password-change` Password change (after re-auth) retires the old credential and can sign out other sessions | change → 204; other session → 401 unauthenticated; old credential → 401 invalid_credentials; new credential → 200 (mfa_required) |
| pass | `auth.no-cookies` The API never sets cookies (bearer tokens only, so cookie CSRF does not apply) | 99 responses inspected; 0 with Set-Cookie |
| pass | `auth.cors` CORS: other origins get no access; allowed origins get an exact origin without credentials | evil → ACAO=null; null → ACAO=null; allowed → ACAO=http://127.0.0.1:4317, credentials=null |
| pass | `auth.mail-links.host-header` Emailed links use the configured web URL, not request headers (no host-header injection) | link origin: http://127.0.0.1:4317; mail mentions evil.example: false |
| pass | `auth.recovery.needs-recovery-key` Email + MFA alone cannot take over a vault: completing recovery needs the vault recovery key; links are single-use | verify → 200 (fields: recoveryToken, expiresAt, encryptedUserKeyByRecovery, keys); link reuse → 401 unauthenticated; complete-vault with a wrong recovery key → 401 invalid_credentials |
| pass | `auth.recovery.reset-destroys-data` Account reset via email + MFA destroys vault data instead of exposing it, and revokes all sessions | reset → 204; old session → 401 unauthenticated; old record afterwards → 404 not_found (tombstoned, ciphertext dropped) |
| pass | `auth.time-dependent` Time-dependent server rules: lockout without enumeration, code/link/reauth/session/membership expiry (in-process API, fake clock) (PV-SEC-001) | 6/6 passed in apps/api |
| pass | `auth.rate-limit.per-ip` Per-IP throttling on authentication endpoints (429 with Retry-After) | 30 parallel prelogin calls: 20 answered, 10 throttled (Retry-After 60s) |

## security/authorization

| Status | Check | Evidence |
|---|---|---|
| pass | `authz.list-records.owner` GET /vaults/S/records as owner: allowed | GET /vaults/S/records as owner → 200 |
| pass | `authz.list-records.editor` GET /vaults/S/records as editor: allowed | GET /vaults/S/records as editor → 200 |
| pass | `authz.list-records.viewer` GET /vaults/S/records as viewer: allowed | GET /vaults/S/records as viewer → 200 |
| pass | `authz.list-records.pending` GET /vaults/S/records as pending: refused (403) | GET /vaults/S/records as pending → 403 forbidden |
| pass | `authz.list-records.revoked` GET /vaults/S/records as revoked: refused (404) | GET /vaults/S/records as revoked → 404 not_found |
| pass | `authz.list-records.expired` GET /vaults/S/records as expired: refused (403) | GET /vaults/S/records as expired → 403 membership_expired |
| pass | `authz.list-records.unrelated` GET /vaults/S/records as unrelated: refused (404) | GET /vaults/S/records as unrelated → 404 not_found |
| pass | `authz.get-record.owner` GET /records/:id as owner: allowed | GET /records/:id as owner → 200 |
| pass | `authz.get-record.editor` GET /records/:id as editor: allowed | GET /records/:id as editor → 200 |
| pass | `authz.get-record.viewer` GET /records/:id as viewer: allowed | GET /records/:id as viewer → 200 |
| pass | `authz.get-record.pending` GET /records/:id as pending: refused (403) | GET /records/:id as pending → 403 forbidden |
| pass | `authz.get-record.revoked` GET /records/:id as revoked: refused (404) | GET /records/:id as revoked → 404 not_found |
| pass | `authz.get-record.expired` GET /records/:id as expired: refused (403) | GET /records/:id as expired → 403 membership_expired |
| pass | `authz.get-record.unrelated` GET /records/:id as unrelated: refused (404) | GET /records/:id as unrelated → 404 not_found |
| pass | `authz.record-versions.owner` GET /records/:id/versions as owner: allowed | GET /records/:id/versions as owner → 200 |
| pass | `authz.record-versions.editor` GET /records/:id/versions as editor: allowed | GET /records/:id/versions as editor → 200 |
| pass | `authz.record-versions.viewer` GET /records/:id/versions as viewer: allowed | GET /records/:id/versions as viewer → 200 |
| pass | `authz.record-versions.pending` GET /records/:id/versions as pending: refused (403) | GET /records/:id/versions as pending → 403 forbidden |
| pass | `authz.record-versions.revoked` GET /records/:id/versions as revoked: refused (404) | GET /records/:id/versions as revoked → 404 not_found |
| pass | `authz.record-versions.expired` GET /records/:id/versions as expired: refused (403) | GET /records/:id/versions as expired → 403 membership_expired |
| pass | `authz.record-versions.unrelated` GET /records/:id/versions as unrelated: refused (404) | GET /records/:id/versions as unrelated → 404 not_found |
| pass | `authz.list-members.owner` GET /vaults/S/members as owner: allowed | GET /vaults/S/members as owner → 200 |
| pass | `authz.list-members.editor` GET /vaults/S/members as editor: allowed | GET /vaults/S/members as editor → 200 |
| pass | `authz.list-members.viewer` GET /vaults/S/members as viewer: allowed | GET /vaults/S/members as viewer → 200 |
| pass | `authz.list-members.pending` GET /vaults/S/members as pending: refused (403) | GET /vaults/S/members as pending → 403 forbidden |
| pass | `authz.list-members.revoked` GET /vaults/S/members as revoked: refused (404) | GET /vaults/S/members as revoked → 404 not_found |
| pass | `authz.list-members.expired` GET /vaults/S/members as expired: refused (403) | GET /vaults/S/members as expired → 403 membership_expired |
| pass | `authz.list-members.unrelated` GET /vaults/S/members as unrelated: refused (404) | GET /vaults/S/members as unrelated → 404 not_found |
| pass | `authz.create-record.owner` POST /records into S as owner: allowed | POST /records into S as owner → 201 |
| pass | `authz.create-record.editor` POST /records into S as editor: allowed | POST /records into S as editor → 201 |
| pass | `authz.create-record.viewer` POST /records into S as viewer: refused (403) | POST /records into S as viewer → 403 forbidden |
| pass | `authz.create-record.pending` POST /records into S as pending: refused (403) | POST /records into S as pending → 403 forbidden |
| pass | `authz.create-record.revoked` POST /records into S as revoked: refused (404) | POST /records into S as revoked → 404 not_found |
| pass | `authz.create-record.expired` POST /records into S as expired: refused (403) | POST /records into S as expired → 403 membership_expired |
| pass | `authz.create-record.unrelated` POST /records into S as unrelated: refused (404) | POST /records into S as unrelated → 404 not_found |
| pass | `authz.update-record.owner` PUT /records/:id as owner: allowed | PUT /records/:id as owner → 200 |
| pass | `authz.update-record.editor` PUT /records/:id as editor: allowed | PUT /records/:id as editor → 200 |
| pass | `authz.update-record.viewer` PUT /records/:id as viewer: refused (403) | PUT /records/:id as viewer → 403 forbidden |
| pass | `authz.update-record.pending` PUT /records/:id as pending: refused (403) | PUT /records/:id as pending → 403 forbidden |
| pass | `authz.update-record.revoked` PUT /records/:id as revoked: refused (404) | PUT /records/:id as revoked → 404 not_found |
| pass | `authz.update-record.expired` PUT /records/:id as expired: refused (403) | PUT /records/:id as expired → 403 membership_expired |
| pass | `authz.update-record.unrelated` PUT /records/:id as unrelated: refused (404) | PUT /records/:id as unrelated → 404 not_found |
| pass | `authz.delete-record.owner` DELETE /records/:id as owner: allowed | DELETE /records/:id as owner → 200 |
| pass | `authz.delete-record.editor` DELETE /records/:id as editor: allowed | DELETE /records/:id as editor → 200 |
| pass | `authz.delete-record.viewer` DELETE /records/:id as viewer: refused (403) | DELETE /records/:id as viewer → 403 forbidden |
| pass | `authz.delete-record.pending` DELETE /records/:id as pending: refused (403) | DELETE /records/:id as pending → 403 forbidden |
| pass | `authz.delete-record.revoked` DELETE /records/:id as revoked: refused (404) | DELETE /records/:id as revoked → 404 not_found |
| pass | `authz.delete-record.expired` DELETE /records/:id as expired: refused (403) | DELETE /records/:id as expired → 403 membership_expired |
| pass | `authz.delete-record.unrelated` DELETE /records/:id as unrelated: refused (404) | DELETE /records/:id as unrelated → 404 not_found |
| pass | `authz.invite.owner` POST /vaults/S/members (invite) as owner: allowed | POST /vaults/S/members (invite) as owner → 201 |
| pass | `authz.invite.editor` POST /vaults/S/members (invite) as editor: refused (403) | POST /vaults/S/members (invite) as editor → 403 forbidden |
| pass | `authz.invite.viewer` POST /vaults/S/members (invite) as viewer: refused (403) | POST /vaults/S/members (invite) as viewer → 403 forbidden |
| pass | `authz.invite.pending` POST /vaults/S/members (invite) as pending: refused (403) | POST /vaults/S/members (invite) as pending → 403 forbidden |
| pass | `authz.invite.revoked` POST /vaults/S/members (invite) as revoked: refused (404) | POST /vaults/S/members (invite) as revoked → 404 not_found |
| pass | `authz.invite.expired` POST /vaults/S/members (invite) as expired: refused (403) | POST /vaults/S/members (invite) as expired → 403 membership_expired |
| pass | `authz.invite.unrelated` POST /vaults/S/members (invite) as unrelated: refused (404) | POST /vaults/S/members (invite) as unrelated → 404 not_found |
| pass | `authz.change-role.owner` PATCH /vaults/S/members/:viewer (role change) as owner: allowed | PATCH /vaults/S/members/:viewer (role change) as owner → 200 |
| pass | `authz.change-role.editor` PATCH /vaults/S/members/:viewer (role change) as editor: refused (403) | PATCH /vaults/S/members/:viewer (role change) as editor → 403 forbidden |
| pass | `authz.change-role.viewer` PATCH /vaults/S/members/:viewer (role change) as viewer: refused (403) | PATCH /vaults/S/members/:viewer (role change) as viewer → 403 forbidden |
| pass | `authz.change-role.pending` PATCH /vaults/S/members/:viewer (role change) as pending: refused (403) | PATCH /vaults/S/members/:viewer (role change) as pending → 403 forbidden |
| pass | `authz.change-role.revoked` PATCH /vaults/S/members/:viewer (role change) as revoked: refused (404) | PATCH /vaults/S/members/:viewer (role change) as revoked → 404 not_found |
| pass | `authz.change-role.expired` PATCH /vaults/S/members/:viewer (role change) as expired: refused (403) | PATCH /vaults/S/members/:viewer (role change) as expired → 403 membership_expired |
| pass | `authz.change-role.unrelated` PATCH /vaults/S/members/:viewer (role change) as unrelated: refused (404) | PATCH /vaults/S/members/:viewer (role change) as unrelated → 404 not_found |
| pass | `authz.remove-owner.owner` DELETE /vaults/S/members/:owner (remove another member) as owner: passes authorization | DELETE /vaults/S/members/:owner (remove another member) as owner → 409 conflict |
| pass | `authz.remove-owner.editor` DELETE /vaults/S/members/:owner (remove another member) as editor: refused (403) | DELETE /vaults/S/members/:owner (remove another member) as editor → 403 forbidden |
| pass | `authz.remove-owner.viewer` DELETE /vaults/S/members/:owner (remove another member) as viewer: refused (403) | DELETE /vaults/S/members/:owner (remove another member) as viewer → 403 forbidden |
| pass | `authz.remove-owner.pending` DELETE /vaults/S/members/:owner (remove another member) as pending: refused (403) | DELETE /vaults/S/members/:owner (remove another member) as pending → 403 forbidden |
| pass | `authz.remove-owner.revoked` DELETE /vaults/S/members/:owner (remove another member) as revoked: refused (404) | DELETE /vaults/S/members/:owner (remove another member) as revoked → 404 not_found |
| pass | `authz.remove-owner.expired` DELETE /vaults/S/members/:owner (remove another member) as expired: refused (403) | DELETE /vaults/S/members/:owner (remove another member) as expired → 403 membership_expired |
| pass | `authz.remove-owner.unrelated` DELETE /vaults/S/members/:owner (remove another member) as unrelated: refused (404) | DELETE /vaults/S/members/:owner (remove another member) as unrelated → 404 not_found |
| pass | `authz.rotate.owner` POST /vaults/S/rotate as owner: passes authorization | POST /vaults/S/rotate as owner → 409 conflict |
| pass | `authz.rotate.editor` POST /vaults/S/rotate as editor: refused (403) | POST /vaults/S/rotate as editor → 403 forbidden |
| pass | `authz.rotate.viewer` POST /vaults/S/rotate as viewer: refused (403) | POST /vaults/S/rotate as viewer → 403 forbidden |
| pass | `authz.rotate.pending` POST /vaults/S/rotate as pending: refused (403) | POST /vaults/S/rotate as pending → 403 forbidden |
| pass | `authz.rotate.revoked` POST /vaults/S/rotate as revoked: refused (404) | POST /vaults/S/rotate as revoked → 404 not_found |
| pass | `authz.rotate.expired` POST /vaults/S/rotate as expired: refused (403) | POST /vaults/S/rotate as expired → 403 membership_expired |
| pass | `authz.rotate.unrelated` POST /vaults/S/rotate as unrelated: refused (404) | POST /vaults/S/rotate as unrelated → 404 not_found |
| pass | `authz.update-vault.owner` PATCH /vaults/S (resharing setting) as owner: allowed | PATCH /vaults/S (resharing setting) as owner → 200 |
| pass | `authz.update-vault.editor` PATCH /vaults/S (resharing setting) as editor: refused (403) | PATCH /vaults/S (resharing setting) as editor → 403 forbidden |
| pass | `authz.update-vault.viewer` PATCH /vaults/S (resharing setting) as viewer: refused (403) | PATCH /vaults/S (resharing setting) as viewer → 403 forbidden |
| pass | `authz.update-vault.pending` PATCH /vaults/S (resharing setting) as pending: refused (403) | PATCH /vaults/S (resharing setting) as pending → 403 forbidden |
| pass | `authz.update-vault.revoked` PATCH /vaults/S (resharing setting) as revoked: refused (404) | PATCH /vaults/S (resharing setting) as revoked → 404 not_found |
| pass | `authz.update-vault.expired` PATCH /vaults/S (resharing setting) as expired: refused (403) | PATCH /vaults/S (resharing setting) as expired → 403 membership_expired |
| pass | `authz.update-vault.unrelated` PATCH /vaults/S (resharing setting) as unrelated: refused (404) | PATCH /vaults/S (resharing setting) as unrelated → 404 not_found |
| pass | `authz.delete-vault.owner` DELETE /vaults/S as owner: allowed | DELETE /vaults/S as owner → 204 |
| pass | `authz.delete-vault.editor` DELETE /vaults/S as editor: refused (403) | DELETE /vaults/S as editor → 403 forbidden |
| pass | `authz.delete-vault.viewer` DELETE /vaults/S as viewer: refused (403) | DELETE /vaults/S as viewer → 403 forbidden |
| pass | `authz.delete-vault.pending` DELETE /vaults/S as pending: refused (403) | DELETE /vaults/S as pending → 403 forbidden |
| pass | `authz.delete-vault.revoked` DELETE /vaults/S as revoked: refused (404) | DELETE /vaults/S as revoked → 404 not_found |
| pass | `authz.delete-vault.expired` DELETE /vaults/S as expired: refused (403) | DELETE /vaults/S as expired → 403 membership_expired |
| pass | `authz.delete-vault.unrelated` DELETE /vaults/S as unrelated: refused (404) | DELETE /vaults/S as unrelated → 404 not_found |
| pass | `authz.personal-vault.isolated` Another user's personal vault is invisible (read, write, invite) | unrelated: list 404 not_found, create 404 not_found, members 404 not_found; owner sharing own personal vault → 403 forbidden |
| pass | `authz.id-substitution.body` Identifiers in request bodies cannot redirect writes into vaults the caller cannot write | editor creates in foreign vault → 404 not_found; editor moves S record to foreign vault → 404 not_found; viewer moves S record out → 403 forbidden; outsider moves own record into S → 404 not_found |
| pass | `authz.mass-assignment` Unknown or server-controlled fields are rejected (strict schemas) | record createdById/revision → 400 validation_failed; vault ownerId → 400 validation_failed; invite status=accepted → 400 validation_failed; member role=owner by editor → 403 forbidden; __proto__ in body → 400 validation_failed; settings extra field → 400 validation_failed |
| pass | `authz.invitations` Invitations can only be accepted by the invited account, and not after decline, revocation or expiry | other account accepts → 404 not_found; decline → 204; accept after decline → 404 not_found; revoked member re-accepts → 404 not_found; expired member accepts → 404 not_found |
| pass | `authz.editor-escalation` Editors cannot grant owner, change roles, or invite when resharing is disabled | grant owner (resharing off) → 403 forbidden; self-promote → 403 forbidden; with resharing on: grant owner → 403 forbidden, grant editor → 201 (allowed by design) |
| pass | `authz.sessions-devices` Users cannot list, revoke or forget other users' sessions and devices | revoke other's session → 404 not_found; forget other's device → 404 not_found; untrust → 404 not_found; owner still signed in → 200; other's session listed to outsider: false |
| pass | `authz.sync-isolation` Sync returns only vaults and records of live memberships (no revoked, expired, pending or foreign data) | pending: vault listed=false, S records=0; revoked: vault listed=false, S records=0; expired: vault listed=false, S records=0; unrelated: vault listed=false, S records=0; editor (control): S records=19 |
| pass | `authz.pagination` Cursor manipulation cannot page into other vaults | foreign vault page → 404 not_found; cursor -1 → 400 validation_failed; 40-digit cursor → 400 validation_failed; "0 OR 1=1" → 400 validation_failed |
| pass | `authz.lookup.public-fields-only` User lookup returns only public identity fields | fields: email, name, publicEncryptionKey, publicKeySignature, publicSigningKey, userId |
| pass | `authz.audit-isolation` Audit events of other users' vaults are not visible | 3 events for the outsider; 0 about other users or vault S |
| pass | `authz.revocation-race` Writes racing a revocation are either applied before it or refused; none land afterwards | removal → 204; concurrent updates: 1 applied (codes 200/404/409; same base revision so at most one can win); update after removal → 404 not_found; final revision 2 |

## security/sharing

| Status | Check | Evidence |
|---|---|---|
| pass | `share.invite-accept-decrypt` Recipient cannot read before accepting; after accepting, the signed grant opens and the record decrypts | before accept → 403 forbidden; after accept: grant verified against the inviter's signing key and record decrypted |
| pass | `share.client-sees-shared` The real client (vault-core) of the recipient caches and decrypts the shared item | shared item in Bob's decrypted snapshot: true |
| pass | `share.viewer-cannot-write` A viewer cannot modify, delete or reshare | update → 403 forbidden; delete → 403 forbidden; reshare → 403 forbidden |
| pass | `share.revoke-stops-access` Removing a member stops API access immediately and forces a key rotation before new invitations | remove → 204; Bob reads record → 404 not_found; lists vault → 404 not_found; owner invites someone before rotating → 409 key_rotation_required |
| pass | `share.offline-client-after-revocation` The revoked member's client drops the vault from its cache on next sync; its queued edits are rejected | before sync: visible=true; after sync: visible=false, ciphertext still in cache=false; stale write from revoked device → 404 not_found. Plaintext Bob already saw (copies, screenshots, exports) cannot be recalled — revocation stops future access only. |
| pass | `share.rotation-rules` Rotation must cover exactly the live members and live records, and must not re-grant the revoked member | grant incl. revoked member → 409 conflict; no grants → 400; exact members → 200 (key version now 2) |
| pass | `share.old-key-useless-for-new-data` After rotation, the revoked member's old vault key cannot unwrap keys of new or re-wrapped records | new record with v1 key → DecryptionError; re-wrapped existing record with v1 key → DecryptionError |
| pass | `share.stale-grant-refused` Invitations made with an old key version are refused after rotation | grant for key v1 → 409 conflict; grant for current key v2 → 201 |
| pass | `share.last-owner` The last owner cannot leave or be removed (the vault would become unmanageable) | owner leaves → 409 conflict; owner demotes self → 409 conflict |
| pass | `share.expiry` Time-limited access ends at its expiry (no job needed) and the vault then requires rotation | during → 200; after expiry → 403 membership_expired |
| pass | `share.client-signature-check` The recipient's client refuses a grant whose signature does not verify | server accepted the mis-signed grant (201) — it cannot verify signatures without trusting keys itself; the client refused it: GrantVerificationError |

## security/sync

| Status | Check | Evidence |
|---|---|---|
| unverified | `sync.interrupted-writes` Writes interrupted mid-transaction leave no partial state | needs database fault injection (killing Postgres mid-transaction); atomic multi-row operations are covered by sync.atomic-rotation; single-row writes rely on Postgres transactions (seqTx) |
| pass | `sync.idempotent-replay` A replayed mutation returns the original result and is applied once; reusing its id with a different body changes nothing | first → 201; replay → 201 (same result: true); same mutation id, other payload → stored result returned: true; record revision 1, payload unchanged: true |
| pass | `sync.mutation-ids-per-user` Another user replaying someone's mutation id gets no stored response (idempotency is per user) | B replays A's create (same mutation id) → 404 not_found |
| pass | `sync.stale-base-revision` Writes based on an old revision are refused with the current version for client-side merge | update → 200; stale update → 409 revision_conflict with current revision 2 |
| pass | `sync.concurrent-updates` Ten concurrent updates on the same base revision: exactly one wins, the rest conflict | 1 applied, 9 conflicts, final revision 2 |
| pass | `sync.tombstones` Permanently deleted records stay deleted: no read, update, re-create or resurrection through sync | delete → 200; get → 410 gone; update → 410 gone; re-create same id → 409 already_exists; versions → 410 gone; sync row: deletedAt set, ciphertext dropped |
| pass | `sync.cursor` Sync cursors never move backwards and replays are stable | cursor ahead of the server stays at 1136 (≥ 1136); replay from 0 returned 5 = 5 records |
| pass | `sync.membership-change-mid-sync` A member removed between two sync pages receives no further records of that vault | page 1 before removal; removal → 204; 1 later page(s) contained 0 item(s) of the vault |
| pass | `sync.revoked-replay` Replaying a stored mutation after losing access re-sends only the original response and writes nothing | original → 201; replay after revocation → 201 (stored response of B's own earlier write, no new data); new write → 404 not_found; record revision 1 |
| pass | `sync.atomic-rotation` A rotation with one stale record fails as a whole (no partial key change) | rotation → 409 revision_conflict; untouched record revision 1; vault key version 1 |
| pass | `sync.engine-tests` Client sync engine: outbox ordering, coalescing, out-of-order pages, conflicts (unit tests) | 9/9 passed in packages/sync |
| pass | `sync.vault-core-tests` vault-core: conflicts, history, lock/unlock, settings merge (unit tests) | 15/15 passed in packages/vault-core |

## security/web

| Status | Check | Evidence |
|---|---|---|
| FAIL | `web.no-secrets-in-urls` No credentials or tokens travel in URL query strings (API traffic so far; emailed links use #fragments) | 169 requests inspected; 1 with credential-like query parameters |
| pass | `web.api.headers` API responses carry restrictive security headers | CSP "default-src 'none';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'none';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests"; nosniff=nosniff; x-powered-by=null; refer… |
| pass | `web.errors.no-internals` Error responses do not leak stack traces, SQL or framework internals | 400 validation_failed; 400 validation_failed; 401 unauthenticated; 404 not_found; 400 validation_failed |
| pass | `web.api.body-limits` Oversized and deeply nested bodies are rejected quickly and the API stays healthy | 4 MB body → 413 validation_failed; 100k-deep JSON → 400 validation_failed in 37 ms; health afterwards 200 |
| pass | `web.api.injection` Injection-shaped input is rejected by validation, never reaching the database as code | probe statuses: 400 validation_failed, 400 validation_failed, 401 unauthenticated, 200; unsafe raw SQL in apps/api/src: 0; interpolated $queryRaw: 0 |
| pass | `web.api.prototype-pollution` __proto__/constructor payloads are rejected and do not alter server objects | __proto__ → 400 validation_failed; constructor.prototype → 400 validation_failed; later response clean: true |
| pass | `web.api.path-traversal` Traversal-shaped paths never reach the filesystem | /api/v1/../../../../etc/passwd → 404; /api/v1/%2e%2e/%2e%2e/%2e%2e/etc/passwd → 404; /api/v1/..%2f..%2f..%2fetc%2fpasswd → 404; /api/v1/records/..%5c..%5cwindows → 401 |
| pass | `web.api.no-ssrf-surface` The server makes no outbound requests to user-supplied URLs | no HTTP client calls in apps/api/src (only SMTP via nodemailer to the configured host) |
| pass | `web.edge.headers` Production edge (deploy/Caddyfile) sets CSP without inline/eval scripts, framing protection, HSTS, nosniff | CSP: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'<br>(style-src allows 'unsafe-inline' for React inline styles; script… |
| pass | `web.bundle.no-server-secrets` Public web assets contain no server-only configuration names or values and no source maps | 16 files; server-only names: none; secret values: none; source maps: 0; private keys: false |
| pass | `web.bundle.no-third-party` The web app loads no third-party scripts, analytics, crash reporting or session replay | tracker/telemetry hosts: none; external <script src>: none |
| pass | `web.env-filename.validation` Env-file names with path separators are refused by item validation | refused: [ { "code": "custom", "path": [ "fields", "filename" ], "message": "filename must not contain path separators" } ] |
| pass | `web.xss.stored` Script payloads in titles, notes, tags, folders, usernames, URLs, env files and API credentials never execute | 5 items opened (values revealed); execution flag=null; dialogs=0; javascript: links rendered=0; refused by client validation: none |

## security/leakage

| Status | Check | Evidence |
|---|---|---|
| pass | `leak.flow-exercised` The canary flows actually ran (items created, edited, shared, decrypted by the recipient) | 7 items for the owner; recipient decrypted the shared canary note: true |
| pass | `leak.traffic` No item plaintext, master password or recovery key appears in any API request or response (plain or encoded) | 497 exchanges scanned for 23 secrets × 7 encodings; hits: none |
| pass | `leak.database` A full database dump contains no item plaintext, master passwords, auth keys, TOTP secrets, recovery codes or session tokens | pg_dump 297 KiB scanned; hits: none |
| pass | `leak.server-logs` API logs at debug level contain no secrets, credentials, tokens, codes or item data | 634 log lines (LOG_LEVEL=debug) scanned; hits: none |
| pass | `leak.mail` Emails carry only the intended codes/links, never item data or passwords | 5 KiB of mail scanned; hits: none |
| pass | `leak.client-cache` The client's persistent cache holds only ciphertext (no item plaintext, no master password) | owner + recipient cache stores scanned (20 KiB); hits: none |
| pass | `leak.web-storage` After sign-in, browsing and locking, web localStorage/sessionStorage/IndexedDB/cookies hold no plaintext | storage while unlocked: 11752 bytes (session token present: true, encrypted records present: true) → canary hits: none; after lock: 11752 bytes → none |

## security/extension

| Status | Check | Evidence |
|---|---|---|
| n/a | `ext.native-messaging` Native messaging accepts only approved extensions and paired clients | not implemented: the manifest has no nativeMessaging permission (checked by ext.manifest); desktop pairing is deferred (docs/EXTENSION.md) |
| pass | `ext.unit-tests` Extension unit tests: sender/message validation, origin matching incl. lookalikes, fill/capture, lock/resume, logs, manifest, save prompt, servers | 61/61 passed in apps/browser-extension |
| pass | `ext.manifest` Production manifest: MV3, minimal permissions, one host, optional all-sites only, no web-accessible resources or external messaging | permissions activeTab,alarms,clipboardWrite,offscreen,scripting,storage; hosts ["https://vault.example.com/*"]; optional ["https://*/*","http://*/*"]; content_scripts false; web_accessible_resources false; externally_connectable false; CSP script-src 'self' 'wasm-unsafe-eval'; object-src 'self' |
| pass | `ext.no-remote-code` The packaged extension loads no remote code and contains no source maps | remote dynamic imports: 0; remote <script>: 0; source maps: 0 |
| pass | `ext.fill.correct-origin` Fill on the verified origin sets exactly the visible username and password | {"code":"filled","filledUsername":true} |
| pass | `ext.fill.lookalike-origin` A lookalike host (bank.example.test.evil.test) gets nothing even if asked to fill for the real origin | {"code":"origin_mismatch","filledUsername":false} |
| pass | `ext.fill.honeypots` Hidden, transparent and off-screen fields are never filled | {"code":"filled","filledUsername":true} values: decoy="", display:none="", off-screen="", username filled=true, password filled=true |
| pass | `ext.fill.hidden-only` A page with only a hidden password field gets nothing | {"code":"no_password_field","filledUsername":false} |
| pass | `ext.fill.cross-origin-iframe` Credentials never reach a cross-origin iframe; the function refuses to run inside frames | top page → no_password_field; executed inside the iframe → not_top_frame; iframe password value empty: true |
| pass | `ext.fill.signup-form` On sign-up/change forms the current-password field is chosen, never the new-password field | {"code":"filled","filledUsername":true} |
| pass | `ext.capture.top-frame-only` Capture reads only the top document and refuses inside frames | top capture found password: false; in-frame capture → not_top_frame |
| pass | `ext.page-isolation` A web page cannot message the extension, and no content script runs before the user opts in | page → no chrome.runtime on the page; registered content scripts: 0; prompt element present: false |
| pass | `ext.save-prompt.trusted-input` Save prompt with trusted input in Chromium: saves the login (and an optional note) for the real page origin | ✓ trusted submit → prompt → Save stored the login for https://shop.example.com<br>✓ trusted typing → Add note → Save stored the note with the login |
| pass | `ext.server-switch.real-popup` Server switching in the real toolbar popup: validation, Chrome host permission required, per-server isolation | ✓ popup shows the current server<br>✓ plain http to a public host is refused<br>✓ an ungranted server is not used while the permission prompt is unanswered — selected=http://localhost:3000, granted=false<br>✓ signed in on server A<br>✓ server B starts signed out in its own namespace — selected=http://127.0.0.1:… |

## security/desktop

| Status | Check | Evidence |
|---|---|---|
| n/a | `desktop.runtime.auth-info-file` Exported auth-info file | exportAuthInfo is false in the production config; the verification harness enables it on purpose (present for the harness) and scripts/build.sh refuses to package with it |
| pass | `desktop.unit-tests` Desktop app unit tests: server isolation, CSP builder, links, clipboard, terminal controller, lock handling, IPC client | 64/64 passed in apps/desktop |
| pass | `desktop.config.production` Production Neutralino config: one-time token, no exported auth info, no inspector, local document root, helper as the only extension | tokenSecurity=one-time, exportAuthInfo=false, inspector=false, mode=window, url=/, extensions=io.passvault.helper, globalVariables=false |
| pass | `desktop.config.native-allowlist` Native API allowlist is minimal: no shell-backed os.open, no process/filesystem/env access, nothing unused (PV-SEC-002) | allowlist (16): app.exit, app.broadcast, window.show, window.focus, window.unminimize, window.setMainMenu, os.showOpenDialog, os.showSaveDialog, os.setTray, extensions.dispatch, extensions.getStats, storage.getData, storage.setData, storage.removeData, clipboard.readText, clipboard.writeText<br>dangero… |
| pass | `desktop.no-direct-native-exec` UI code never calls shell-backed or process APIs directly (PV-SEC-002) | none |
| pass | `desktop.csp` Desktop webview CSP: scripts only from the app, connections only to the helper, the configured server and local development | CSP: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:47391 ws://127.0.0.1:47391 https://vault.example.com http://localhost:3000; object-src 'none'; base-uri 'none'; frame-src 'none'; … |
| pass | `desktop.runtime.helper-roundtrip` The packaged app works end to end: the UI loads and the native helper answers it (allowlist not over-restricted) | UI reached its first screen: true; helper/permission errors in console: none |
| pass | `desktop.runtime.process-args` No secrets in the command lines of the app and helper processes | 2 processes:<br>53727 ~/passvault/apps/desktop/bin/neutralino-mac_arm64 --res-mode=directory --path=/Users/surajthapa/passvault/apps/desktop/.build/verify<br>53735 ~/passvault/apps/desktop/dist/PassVault.app/Contents/MacOS/pv-helper<br>suspicious arguments: 0 |
| pass | `desktop.runtime.one-time-token` After the UI has loaded, other local clients requesting the globals get no access token | requests after the UI took the token: no token. Residual: a local process that requests the globals before the webview does would win the token — in window mode the webview loads immediately at start (documented). |
| pass | `desktop.runtime.ws-without-token` Native API websocket refuses clients without the token, and extension connections need the connect token | no token → refused; fake extension connect token → refused; command executed: false |

## security/native

| Status | Check | Evidence |
|---|---|---|
| unverified | `native.keychain.biometric-runtime` Touch ID prompt actually gates the stored key on real hardware | needs a signed build with keychain-access-groups entitlement and a person to touch the sensor; procedure in docs/security/RUNBOOK.md (unsigned builds correctly report biometrics unavailable: TestBiometricHonestOnUnsignedBuild) |
| unverified | `native.govulncheck` govulncheck on the Go helper | govulncheck not installed locally; runs in CI (security.yml) |
| pass | `native.go.fsops.TestWriteExportMode0600` Exports are written with mode 0600 | fsops: TestWriteExportMode0600 pass in 0.02s |
| pass | `native.go.keychain.TestNonBiometricRoundTrip` Keychain round trip (non-biometric item) | keychain: TestNonBiometricRoundTrip pass in 0.10s |
| pass | `native.go.github.com/passvault/desktop-helper/cmd/pv-helper.TestEndToEndWindowClose` Helper exits when the window closes (no orphan process) | github.com/passvault/desktop-helper/cmd/pv-helper: TestEndToEndWindowClose pass in 0.03s |
| pass | `native.go.app.TestHelloCapabilities` IPC handshake advertises only the implemented capabilities | app: TestHelloCapabilities pass in 0.03s |
| pass | `native.go.fsops.TestWriteExportRefusals` Exports refuse traversal, symlinks, special files and non-absolute paths | fsops: TestWriteExportRefusals pass in 0.00s |
| pass | `native.go.fsops.TestReadImport` Imports read regular files only, with size limits | fsops: TestReadImport pass in 0.00s |
| pass | `native.go.links.TestOnlyWebLinksAreOpened` Only Web Links Are Opened | links: TestOnlyWebLinksAreOpened pass in 0.00s |
| pass | `native.go.app.TestUnknownOpAndFields` IPC refuses unknown operations and unknown fields | app: TestUnknownOpAndFields pass in 0.01s |
| pass | `native.go.github.com/passvault/desktop-helper/cmd/pv-helper.TestEndToEndSocketClose` Helper exits when the IPC socket closes (no orphan process) | github.com/passvault/desktop-helper/cmd/pv-helper: TestEndToEndSocketClose pass in 0.00s |
| pass | `native.go.app.TestSessionBinding` IPC requests are bound to the authenticated UI session | app: TestSessionBinding pass in 0.01s |
| pass | `native.go.github.com/passvault/desktop-helper/cmd/pv-helper.TestBadBootstrap` Helper refuses a malformed bootstrap message | github.com/passvault/desktop-helper/cmd/pv-helper: TestBadBootstrap pass in 0.00s |
| pass | `native.go.app.TestSecondHelloTearsDownConnections` A second handshake tears down existing sessions (no session takeover) | app: TestSecondHelloTearsDownConnections pass in 0.12s |
| pass | `native.go.keychain.TestBiometricHonestOnUnsignedBuild` Biometric unlock reports unavailability honestly on unsigned builds (no fake success) | keychain: TestBiometricHonestOnUnsignedBuild pass in 0.01s |
| pass | `native.go.app.TestInvalidHostsAndUsernamesRejected` Invalid hosts and user names are refused before connecting | app: TestInvalidHostsAndUsernamesRejected pass in 0.00s |
| pass | `native.go.app.TestOversizeRejected` Oversized IPC messages are refused | app: TestOversizeRejected pass in 0.01s |
| pass | `native.go.app.TestVaultLockedClosesEverything` Locking the vault closes every app-managed SSH session and stops agent signing | app: TestVaultLockedClosesEverything pass in 0.01s |
| pass | `native.go.app.TestAgentSignFlowOverIPC` Agent Sign Flow Over IPC | app: TestAgentSignFlowOverIPC pass in 0.00s |
| pass | `native.go.app.TestLogsContainNoSecrets` Helper logs contain no secrets | app: TestLogsContainNoSecrets pass in 0.70s |
| pass | `native.go.validate.TestHost` Host names are validated strictly | validate: TestHost pass in 0.00s |
| pass | `native.go.validate.TestUsername` User names are validated strictly | validate: TestUsername pass in 0.00s |
| pass | `native.go.validate.TestPortAccountID` Ports and account ids are validated | validate: TestPortAccountID pass in 0.00s |
| pass | `native.go.sysevents.TestDistributedNotificationForwarded` System lock/sleep notifications reach the UI | sysevents: TestDistributedNotificationForwarded pass in 0.00s |
| pass | `native.go-vet` go vet finds nothing | clean |
| pass | `native.no-shell` The helper starts no shell and runs exactly one external program (/usr/bin/open) with an argv list | process launches:<br>native/desktop-helper/internal/term/term.go:54:	cmd := exec.Command(argv[0], argv[1:]...)<br>shell invocations: 0 |
| pass | `native.keychain.biometric-acl` Biometric unlock material is protected by the Keychain access control (Touch ID enforced by the OS, not by a UI prompt) | biometric items: data-protection keychain + SecAccessControl(BiometryCurrentSet, WhenPasscodeSetThisDeviceOnly); no LAContext evaluatePolicy gate in code (the Keychain itself refuses reads without a fresh Touch ID match; re-enrolled fingers invalidate the item). The item holds a random device key th… |

## security/ssh

| Status | Check | Evidence |
|---|---|---|
| n/a | `ssh.secrets-in-argv` SSH secrets in process arguments | app-managed sessions use golang.org/x/crypto/ssh in-process (no ssh binary); external Terminal sessions: see ssh.go.term.TestScriptOnlyQuotedArgsNoSecrets |
| n/a | `ssh.agent-destination` Agent identifies the destination host | by design the agent cannot reliably know the destination; the approval prompt shows a verified host-key fingerprint only when OpenSSH sends session-bind data, and forwarded requests are refused (documented in DESKTOP.md) |
| pass | `ssh.go.sshconn.TestUnknownHostKeyTrustThenShell` Unknown host key: shown for confirmation, trusted only after explicit approval | sshconn: TestUnknownHostKeyTrustThenShell pass in 0.02s |
| pass | `ssh.go.sshconn.TestUnknownHostKeyReject` Unknown host key rejected by the user → connection closed, nothing sent | sshconn: TestUnknownHostKeyReject pass in 0.00s |
| pass | `ssh.go.sshconn.TestHostKeyDecisionTimeout` No host-key decision → connection aborted after the timeout | sshconn: TestHostKeyDecisionTimeout pass in 0.20s |
| pass | `ssh.go.sshconn.TestHostKeyMismatchAbortsBeforeAuth` Host-key mismatch aborts BEFORE any credential is sent | sshconn: TestHostKeyMismatchAbortsBeforeAuth pass in 0.00s |
| pass | `ssh.go.sshconn.TestJumpHostBothHopsVerified` Jump host: both hops are host-key verified | sshconn: TestJumpHostBothHopsVerified pass in 0.01s |
| pass | `ssh.go.term.TestScriptOnlyQuotedArgsNoSecrets` External terminal: script contains only quoted, validated arguments and no secrets | term: TestScriptOnlyQuotedArgsNoSecrets pass in 0.01s |
| pass | `ssh.go.sshkeys.TestGenerateAndInspectAllAlgorithms` Key generation and inspection for all algorithms | sshkeys: TestGenerateAndInspectAllAlgorithms pass in 3.82s |
| pass | `ssh.go.agentsrv.TestSocketPermissions` Agent socket is 0600 inside a 0700 directory | agentsrv: TestSocketPermissions pass in 0.00s |
| pass | `ssh.go.agentsrv.TestStopRemovesSocketAndStaleSocketReplaced` Stopping removes the socket; a stale socket is replaced safely | agentsrv: TestStopRemovesSocketAndStaleSocketReplaced pass in 0.00s |
| pass | `ssh.go.agentsrv.TestRefusesSymlinkDirAndRegularFile` TestRefusesSymlinkDirAndRegularFile | agentsrv: TestRefusesSymlinkDirAndRegularFile pass in 0.00s |
| pass | `ssh.go.agentsrv.TestListOnlyWhenUnlocked` Agent lists keys only while the vault is unlocked | agentsrv: TestListOnlyWhenUnlocked pass in 0.00s |
| pass | `ssh.go.sshconn.TestJumpHostMismatchAborts` Jump host: a mismatch on either hop aborts | sshconn: TestJumpHostMismatchAborts pass in 0.00s |
| pass | `ssh.go.sshconn.TestWrongPassword` Wrong password fails cleanly | sshconn: TestWrongPassword pass in 0.00s |
| pass | `ssh.go.agentsrv.TestSignApprovalDenyOnceTimed` Per-use approval: deny, allow once, allow for a limited time | agentsrv: TestSignApprovalDenyOnceTimed pass in 0.00s |
| pass | `ssh.go.sshconn.TestPublicKeyWithPassphrase` Key with passphrase: wrong passphrase refused, right one works | sshconn: TestPublicKeyWithPassphrase pass in 0.34s |
| pass | `ssh.go.agentsrv.TestSignTimeoutDenies` Unanswered signature requests are denied | agentsrv: TestSignTimeoutDenies pass in 0.20s |
| pass | `ssh.go.term.TestRefusesWithoutTrustedKeys` External terminal refuses hosts without verified host keys | term: TestRefusesWithoutTrustedKeys pass in 0.00s |
| pass | `ssh.go.term.TestRejectsInjection` External terminal rejects injection-shaped parameters | term: TestRejectsInjection pass in 0.00s |
| pass | `ssh.go.term.TestCleanupWhenNeverStarted` External terminal temp files are removed if the session never starts | term: TestCleanupWhenNeverStarted pass in 0.06s |
| pass | `ssh.go.agentsrv.TestLockDeniesPending` Locking denies pending signature requests | agentsrv: TestLockDeniesPending pass in 0.00s |
| pass | `ssh.go.agentsrv.TestMutationsRefused` Agent refuses add/remove/lock requests from clients (keys cannot be exported or injected) | agentsrv: TestMutationsRefused pass in 0.00s |
| pass | `ssh.go.agentsrv.TestSessionBind` Forwarded-agent requests (session-bind) are refused | agentsrv: TestSessionBind pass in 0.00s |
| pass | `ssh.go.agentsrv.TestRealSSHAuthThroughAgent` Real OpenSSH authentication through the agent works end to end | agentsrv: TestRealSSHAuthThroughAgent pass in 0.00s |
| pass | `ssh.go.sshconn.TestKeyboardInteractiveMultiPrompt` Keyboard-interactive (OTP) prompts are relayed to the user | sshconn: TestKeyboardInteractiveMultiPrompt pass in 0.00s |
| pass | `ssh.go.sshconn.TestKeyboardInteractiveCancel` Cancelling an interactive prompt aborts the connection | sshconn: TestKeyboardInteractiveCancel pass in 0.00s |
| pass | `ssh.go.sshconn.TestRemoteExit` Remote exit closes the session and frees resources | sshconn: TestRemoteExit pass in 0.00s |
| pass | `ssh.go.sshconn.TestCloseAllNoGoroutineLeak` Closing all sessions leaks no goroutines | sshconn: TestCloseAllNoGoroutineLeak pass in 0.03s |
| pass | `ssh.go.sshconn.TestAgentAuthUsesHelperKeys` SSH auth through the PassVault agent uses only helper-held keys | sshconn: TestAgentAuthUsesHelperKeys pass in 0.00s |
| pass | `ssh.go.sshconn.TestSSHTest` Connection test performs host-key verification | sshconn: TestSSHTest pass in 0.00s |
| pass | `ssh.go.sshconn.TestValidationRejectsInjection` TestValidationRejectsInjection | sshconn: TestValidationRejectsInjection pass in 0.00s |
| pass | `ssh.go.sshkeys.TestInspectRejects` Malformed / unsupported key material is rejected | sshkeys: TestInspectRejects pass in 0.00s |
| pass | `ssh.terminal.config` Embedded terminal: no clipboard (OSC 52) addon, no proposed APIs, links only http(s) and only after confirmation | xterm-host.ts: allowProposedApi false; no clipboard addon; OSC 8 linkHandler with allowNonHttpProtocols false; plain-text links → openLink → openExternalConfirmed (http/https only, user confirmation) |
| pass | `ssh.terminal.malicious-output` Hostile terminal output (OSC 52, OSC 8 javascript:/file:, title, DCS, window ops) causes no clipboard write, navigation, script or link activation | 8 hostile sequences written; privileged effects: none; script flag: null; page title unchanged: true; auto-replies sent back to the server: reply:"\u001bP1$r0m\u001b\\" |

## security/supply-chain

| Status | Check | Evidence |
|---|---|---|
| unverified | `sc.gitleaks` gitleaks secret scan | gitleaks not installed locally; runs in CI (security.yml); the built-in scanner above ran instead |
| unverified | `sc.sbom` Standard-format SBOM (CycloneDX/SPDX) | syft not installed locally; generated in CI (security.yml, anchore/sbom-action). The JSON inventory above is not a standard SBOM. |
| pass | `sc.lockfile` The lockfile is consistent with every package.json (frozen install changes nothing) | frozen offline install exit 0; lockfile unchanged by the install: true |
| pass | `sc.npm-audit` No high or critical advisories in production npm dependencies (pnpm audit) | counts {"info":0,"low":0,"moderate":0,"high":0,"critical":0}<br>(severity from the advisory database; reachability not assessed) |
| pass | `sc.secrets.tracked-files` No credentials, private keys or real .env files in tracked files | 380 tracked files; .env files: none; pattern hits: none |
| pass | `sc.secrets.history` No credentials or private keys anywhere in git history | 422 file changes scanned; hits: none |
| pass | `sc.private-domain` The private production domain is not committed (it lives only in gitignored env files / CI variables) | tracked files containing it: 0; commits that added/removed it: 0 |
| pass | `sc.secrets.build-artifacts` Built artifacts (web, extension, desktop UI) contain no secret patterns | 26 files in web-dist, ext-prod, ext-local, desktop-ui; hits: none |
| pass | `sc.inventory` Dependency inventory generated; production npm licenses are permissive | 202 npm production packages, 7 Go modules → dependency-inventory.json; non-permissive/unknown: none |
| pass | `sc.ci.least-privilege` Workflows: read-only default token, no pull_request_target, release secrets only in tag/manual-triggered jobs | ci.yml: top-level permissions contents: read jobs: typescript: runs-on: ubuntu-24.04 services: postgres: image: docker.io/library/postgres:16-alpine env: POSTGRES_USER: passvault POSTGRES_PASSWORD: ci-only-not-a-secret POSTGRES_DB: passvault_test ports: ['5432:5432'] options: >- --health-cmd "pg_isr… |
| pass | `sc.ci.actions-pinned` Third-party GitHub Actions are pinned to full commit SHAs (PV-SEC-003) | 37 action references; not SHA-pinned: 0 |
| pass | `sc.ci.actionlint` actionlint finds no workflow errors | 3 workflows clean |
| pass | `sc.ci.security-gate` CI runs the security gate (audit fails on high/critical, secret scan, govulncheck, harness offline suites) (PV-SEC-005) | security.yml: audit (high), gitleaks, govulncheck, harness offline suites |
| pass | `sc.containers` Containers: API non-root, read-only, no capabilities, no-new-privileges; database not published; ports bound to loopback | api: read_only, cap_drop ALL, no-new-privileges; postgres not published; host ports on 127.0.0.1; Containerfile USER node. Base images pinned by digest: false (tags only — see residual risks) |
| pass | `sc.release.authenticity` Desktop releases: signed + notarized when credentials exist, otherwise explicitly UNSIGNED; checksums published; no auto-updater to hijack | release.yml: notarization step true, UNSIGNED labelling true, SHA256SUMS true; update mechanism in the app: none (users install new versions manually) |
