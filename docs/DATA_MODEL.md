# Data model

The Prisma schema is `apps/api/prisma/schema.prisma`; migrations live in
`apps/api/prisma/migrations`. All `encrypted*` columns hold client-produced
envelopes (see [CRYPTO.md](CRYPTO.md)); the server never decrypts them.

| Model | Purpose | Key columns |
|---|---|---|
| `User` | account identity, KDF params, wrapped keys, public keys | `authKeyHash` (Argon2id of authKey), `kdf*`, `encryptedUserKey`, `encryptedUserKeyByRecovery`, `recoveryAuthKeyHash`, public/encrypted private keys, `encryptedSettings`, `securityStamp` |
| `EmailToken` | email verification & recovery links | SHA-256 of token, purpose, expiry, single use |
| `MfaEnrollment` | TOTP enrollment | AES-GCM encrypted secret, status, `lastUsedStep` |
| `RecoveryCode` | one-time MFA recovery codes | HMAC hash, `usedAt` |
| `Device` | client installations per user | client device id, type, trusted-device token hash + stamp + expiry |
| `Session` | bearer sessions | token hash, state (`pending_mfa`, `pending_enrollment`, `active`), expiry, idle expiry, `reauthUntil`, revocation |
| `Vault` | key container (personal or shared) | type, kind (`item`/`project`), owner, `keyVersion`, `allowResharing`, `rotationRequired`, `seq` |
| `VaultMember` | membership + wrapped vault key | role, status, `encryptedVaultKey`, `keySignature`, grantor, `expiresAt`, `seq` |
| `Record` | encrypted item or project | vault, kind, `revision`, `encryptedKey`, `encryptedPayload`, size, tombstone `deletedAt`, `seq` |
| `RecordVersion` | encrypted history | previous `encryptedKey`/`encryptedPayload` per revision |
| `Mutation` | idempotency log | `(userId, mutationId)` → stored response |
| `AuditEvent` | security audit trail | type, actor, subject, vault, record, device, IP prefix, redacted metadata |

## Item model (client-side, inside `encryptedPayload`)

Defined in `packages/types/src/items.ts`, validated by
`packages/validation/src/items.ts`. Shared fields: title, description, notes,
folder/category, tags, project id, environment, favorite, archived, trash
timestamp, typed custom fields (`text`, `secret`, `url`, `email`, `number`,
`date`, `boolean`, `multiline`). Typed `fields` per item type:

- `login` — username, password, URLs with explicit match rules.
- `ssh_connection` — host, port (22), username, auth method, optional password,
  SSH-key item reference, jump-host item reference, trusted host keys.
- `ssh_key` — public key, private key, passphrase, fingerprint, algorithm, comment.
- `database` — engine, host, port, database, username, password, TLS mode, CA,
  connection string (secret).
- `api_credential` — service, endpoint, kind, token/API key/client
  credentials/basic auth, expiry date.
- `env_file` — filename, raw content (authoritative), per-variable notes.
- `secure_note` — plain-text content.

Projects are records of kind `project` with name, description, tags, favorite,
and environments (Development/Staging/Production/custom).

Trash, archive, and favorites are encrypted payload state. Only permanent
deletion is a server operation (tombstone).

## Server-visible metadata

The service **can** observe:

- account email, display name, email-verification state, creation time;
- KDF parameters and salt; public encryption/signing keys;
- devices (client type, user-supplied device name such as "Chrome on macOS"),
  sessions (timestamps, truncated IP prefix, user agent);
- vault ids, whether a vault is personal or shared, and whether a shared vault
  holds a single item or a project; owner; key version;
- memberships: who is in which vault, role, invitation status, expiry, who
  granted access;
- record ids, which vault each belongs to, whether it is an item or a project,
  revision numbers, padded ciphertext sizes (128-byte blocks), created/updated
  timestamps, creating/updating user, deletion tombstones;
- number of versions per record; request timing and frequency;
- audit events listed in [API.md](API.md#audit).

The service **cannot** observe: item types, titles, usernames, passwords, URLs,
hosts, ports, database names, tokens, keys, notes, tags, folders, project
names, environment names, `.env` contents or variable names, search queries,
reveal/copy/autofill/export actions, terminal sessions, SSH-agent use, or
which item is opened.

## Operations that stay client-local

Search, filtering, sorting, password-strength and reuse analysis, password
generation, `.env` parsing/diffing, URL matching, conflict comparison,
decryption of history, plaintext export, SSH connections (desktop helper ↔
server directly), and SSH-agent signing.

## Retention

- Record versions: last `RECORD_HISTORY_LIMIT` (default 50) per record.
- Tombstones: kept indefinitely (small rows without ciphertext) so stale
  clients never resurrect deleted items.
- Mutation idempotency rows: purged after 7 days.
- Expired sessions and email tokens: purged by a scheduled job.

## Evolving encrypted payloads

Item, project and settings payloads are validated with **loose** schemas
(`packages/validation/src/items.ts`): every known field is checked, and fields a
newer client added are accepted and kept. Editors and `updateItem` start from the
decrypted payload, so an older client saves those fields back unchanged instead of
dropping them. To extend a payload, add the field as optional; older clients keep
reading the item. (Before 0.1.16 the schemas were strict, so those versions show
such items as "created by a newer client".) A new item `type` or a new enum value is
still unknown to older clients — prefer additive fields. API requests stay strict.

The short **identifier** shown next to an item's title is the payload's
`description` (first line, `IDENTIFIER_MAX` = 60 characters in editors), so it needed
no schema change.

## Payment cards (`payment_card`, 0.1.18)

Fields: `cardholder`, `number` (digits only, up to 19), `expMonth` (`01`–`12`),
`expYear` (four digits), `cvv` (up to 4 digits), `pin`. `number`, `cvv` and `pin` are
secret fields. Lists and search see only the brand, the last four digits and the
expiry (`vault-core/src/cards.ts`); expired and soon-expiring cards (60 days) appear
in the health overview. Versions before 0.1.18 do not know the type and list cards
as "created by a newer client".

## Passkeys on logins (`fields.passkeys`, 0.1.20)

An optional array on login items: `{ credentialId, rpId, rpName, userHandle,
userName, userDisplayName, alg: -7, privateKey, createdAt }` (base64url values;
`privateKey` is PKCS#8 and secret). Written by the browser extension when a site
creates a passkey; up to 20 per login. Older clients (0.1.16+) keep the field
untouched thanks to the loose payload schemas.
