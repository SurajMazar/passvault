# PassVault HTTP API (v1)

Base path: `/api/v1`. JSON request/response bodies. Request and response types
are defined in `packages/types/src/api.ts`; request validation schemas live in
`packages/validation/src/api.ts` and are used **both** by clients and the server.
Binary values are base64url without padding. Every `encrypted*` field is an
opaque client-side envelope (see [CRYPTO.md](CRYPTO.md)); the server never
parses or decrypts it.

## Conventions

- **Auth:** `Authorization: Bearer <session token>`. Tokens are 32 random bytes
  (base64url); the server stores only SHA-256(token). Sessions have an absolute
  lifetime (`SESSION_TTL_HOURS`, default 720) and an idle timeout
  (`SESSION_IDLE_MINUTES`, default 10080 = 7 days) that slides on use.
- **Session states:** `pending_mfa` and `pending_enrollment` tokens (the
  `mfaToken`, valid 10 minutes, max 5 MFA attempts) may call only the MFA
  endpoints. Only `active` sessions reach everything else.
- **Reauthentication:** endpoints marked **(reauth)** require
  `session.reauthUntil > now`, obtained via `POST /auth/reauth` (5-minute window).
- **Errors:** `{ "error": { "code", "message", "details"? }, "requestId" }` with
  codes from `API_ERROR_CODES`. Validation errors use `validation_failed` and
  `details: [{path, message}]`. Unknown request fields are rejected.
- **Idempotency:** record mutations carry `mutationId` (UUID). A retried
  mutation with the same `(userId, mutationId)` returns the original status and
  body without re-applying it.
- **Optimistic concurrency:** record updates/deletes carry `baseRevision`; a
  mismatch returns `409 revision_conflict` with `details.current` (the current
  `RecordDto`). The server never overwrites newer revisions.
- **Pagination:** `?cursor=&limit=` → `{ data, nextCursor }`.
- **Rate limits:** global per-IP limit; stricter limits on `prelogin`,
  `login`, `mfa/*`, `recovery/*`, `register`, `users/lookup` (per IP and per email).
- **Logging:** request logs never contain bodies, tokens, `authKey`, codes, or
  ciphertext (see OPERATIONS.md, "Redaction").
- **IDs:** records and vaults use **client-generated** UUIDs so offline-created
  items keep stable ids; the server rejects reuse.

## Health

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | `{status, db, version}` only; never configuration or secrets |

## Authentication

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| POST | `/auth/prelogin` | none | `PreloginRequest → PreloginResponse`. Unknown emails get deterministic fake KDF params (HMAC of email). |
| POST | `/auth/register` | none | `RegisterRequest → 201 RegisterResponse`. Creates user (unverified), personal vault (owner membership, `keyVersion 1`), sends verification email. Duplicate email → `201` with same shape and *no* second account (an "already registered" notice is emailed instead) to avoid enumeration. |
| POST | `/auth/verify-email` | none | `VerifyEmailRequest → 204`. Token single-use, 24 h. |
| POST | `/auth/resend-verification` | none | `→ 202` always |
| POST | `/auth/login` | none | `LoginRequest → LoginResponse`. Wrong email/authKey → `401 invalid_credentials` (same timing path). Unverified → `403 email_not_verified`. Valid trusted-device token (matching device, unexpired, same `securityStamp`) → `status: ok`. Otherwise `mfa_required` / `mfa_enrollment_required` with a pending token. Progressive lockout after repeated failures. |
| POST | `/auth/mfa/enroll/start` | pending_enrollment token in body **or** active session (reauth) | `→ {secret, otpauthUri}`. Creates/replaces a `pending` TOTP enrollment. |
| POST | `/auth/mfa/enroll/confirm` | same | `{code} → {recoveryCodes[10], session?, account?}`. Activates TOTP, replaces all recovery codes, rotates `securityStamp`. With a pending token, upgrades it to an active session (returned). |
| POST | `/auth/mfa/verify` | pending_mfa token in body | `MfaVerifyRequest → MfaVerifyResponse`. TOTP (±1 step, replay-protected by `lastUsedStep`) or one recovery code (single use). `trustDevice` issues a 30-day trusted-device token. |
| POST | `/auth/reauth` | active | `{authKey, code} → {reauthUntil}` |
| POST | `/auth/logout` | active | revokes current session → 204 |
| POST | `/auth/logout-all` | active **(reauth)** | revokes every session of the user, including current → 204 |
| GET | `/account` | active | `AccountBundle` |
| POST | `/account/password` | active **(reauth)** | `ChangePasswordRequest → 204`. Replaces authKeyHash/KDF/encryptedUserKey (and rotation fields when present), rotates `securityStamp` (clears trusted devices), revokes other sessions if requested. |
| POST | `/account/mfa/recovery-codes` | active **(reauth)** | `→ {recoveryCodes}` regenerates (old batch invalidated) |
| GET | `/account/settings` | active | `SettingsDto` |
| PUT | `/account/settings` | active | `UpdateSettingsRequest → SettingsDto`; `409 revision_conflict` on stale base |
| GET | `/sessions` | active | `SessionListItem[]` |
| DELETE | `/sessions/:id` | active | revoke one of *your* sessions → 204 |
| GET | `/devices` | active | `DeviceListItem[]` |
| DELETE | `/devices/:id/trust` | active | remove trusted status → 204 |
| DELETE | `/devices/:id` | active | revoke all sessions of the device and forget it → 204 |

## Recovery

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/recovery/start` | none | `{email} → 202` always. Emails a single-use 30-minute link token. No secrets in the email. |
| POST | `/recovery/verify` | none | `{token, code \| recoveryCode} → RecoveryVerifyResponse`. Requires MFA (TOTP or MFA recovery code). Returns a 15-minute `recoveryToken` and the recovery-wrapped User Key. |
| POST | `/recovery/complete-vault` | none | `RecoveryCompleteVaultRequest → 204`. Server verifies `recoveryAuthKey` against `recoveryAuthKeyHash` — proves the client holds the vault recovery key. Sets new password material and a new recovery key, rotates `securityStamp`, revokes all sessions. |
| POST | `/recovery/reset-account` | none | `RecoveryResetAccountRequest → 204`. **Destroys vault data**: tombstones all records in the personal vault, revokes the user's memberships in shared vaults (owned shared vaults are deleted), installs new keys. Audit-logged. |

## Users (recipient lookup)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/users/lookup?email=` | active | exact email match of a **verified** user → `UserLookupResponse`; `404` otherwise. Rate-limited. |

## Vaults and sharing

Roles: `owner` (manage members/settings, write), `editor` (write records),
`viewer` (read). An editor may invite others (as `editor` or `viewer`) only if
the vault has `allowResharing = true`. Access requires `status = accepted` and
`expiresAt` null or in the future; expired members get `403 membership_expired`.
Personal vaults cannot be shared or have members added.

| Method | Path | Auth/role | Notes |
|---|---|---|---|
| GET | `/vaults` | active | `VaultMembershipDto[]` for accepted, unexpired memberships |
| POST | `/vaults` | active | `CreateSharedVaultRequest → VaultMembershipDto` (creator = owner) |
| PATCH | `/vaults/:id` | owner | `UpdateVaultRequest` |
| DELETE | `/vaults/:id` | owner | shared vault only; tombstones its records, revokes members |
| GET | `/vaults/:id/members` | member | `VaultMemberDto[]` (includes invited/revoked history) |
| POST | `/vaults/:id/members` | owner, or editor with resharing | `InviteMemberRequest → 201`. Recipient must be verified, not already active. `keyVersion` must equal the vault's current version. Editors cannot grant `owner`. |
| PATCH | `/vaults/:id/members/:userId` | owner | `UpdateMemberRequest` (cannot demote the last owner) |
| DELETE | `/vaults/:id/members/:userId` | owner (or self = leave) | status → `revoked`; sets `rotationRequired = true` |
| POST | `/vaults/:id/rotate` | owner | `RotateVaultKeyRequest`. Atomic: bumps `keyVersion`, replaces grants of all accepted/invited members (must cover exactly them), re-wraps record keys (must cover every live record, each `baseRevision` must match), clears `rotationRequired`. |
| GET | `/vaults/:id/records` | member | paginated full listing (used after access is granted) |
| GET | `/invitations` | active | pending `InvitationDto[]` |
| POST | `/invitations/:vaultId/accept` | invitee | → `VaultMembershipDto` |
| POST | `/invitations/:vaultId/decline` | invitee | → 204 |

## Records (items and projects)

| Method | Path | Auth/role | Notes |
|---|---|---|---|
| POST | `/records` | editor/owner of `vaultId` | `CreateRecordRequest → 201 RecordDto` (revision 1) |
| GET | `/records/:id` | member | `RecordDto` |
| PUT | `/records/:id` | editor/owner (both vaults when moving) | `UpdateRecordRequest → RecordDto`. Stores the previous ciphertext as a `RecordVersion` (keeps the last `RECORD_HISTORY_LIMIT`, default 50). |
| DELETE | `/records/:id` | editor/owner | `DeleteRecordRequest` → permanent delete: tombstone (ciphertext and versions removed), revision+1 |
| GET | `/records/:id/versions` | member | `RecordVersionDto[]` newest first |

Trash/restore and archive are *encrypted payload* state (`trashedAt`,
`archived`), so they are ordinary updates. Only permanent deletion is visible
to the server.

## Sync

`GET /sync?cursor=<seq>&limit=<n>` → `SyncResponse`.

- A single global Postgres sequence (`pv_change_seq`) stamps every change to
  records, vaults, and memberships. Mutating transactions take a transaction-
  scoped advisory lock before drawing from the sequence, so sequence order equals
  commit order and a cursor never skips a late-committing change.
- `records`: records (including tombstones) with `seq > cursor` in vaults where
  the caller currently has accepted, unexpired access, ordered by `seq`.
- `vaults`: the complete current membership list. A client drops cached
  records of any vault that disappears (access revoked/expired).
- `resyncVaults`: vaults whose membership row changed after `cursor` (newly
  accepted, key rotated). The client re-fetches all their records via
  `GET /vaults/:id/records` because older records predate the cursor.
- `cursor = "0"` returns everything accessible.

## Audit

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/audit-events` | active | events where the caller is actor or subject, plus events in vaults the caller owns. Paginated. |

Event types: `user.registered`, `user.email_verified`, `auth.login_succeeded`,
`auth.login_failed`, `auth.mfa_enrolled`, `auth.mfa_failed`,
`auth.recovery_code_used`, `auth.recovery_codes_regenerated`,
`auth.reauthenticated`, `session.revoked`, `session.revoked_all`,
`device.untrusted`, `account.password_changed`, `account.user_key_rotated`,
`recovery.started`, `recovery.vault_recovered`, `recovery.account_reset`,
`vault.created`, `vault.deleted`, `vault.member_invited`, `vault.invite_accepted`,
`vault.invite_declined`, `vault.member_updated`, `vault.member_revoked`,
`vault.key_rotated`, `vault.membership_expired`, `record.deleted`.

Audit logs record server-observable actions only. They cannot show local
reveals, copies, autofills, exports, or offline use.

## What the server observes

See [DATA_MODEL.md](DATA_MODEL.md#server-visible-metadata).
