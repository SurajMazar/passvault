# Encryption and key management

Status: **implemented** in `packages/crypto` (tests: `packages/crypto/test/crypto.test.ts`).
This design has **not** been reviewed by an independent cryptographer. See
[SECURITY_REVIEW.md](SECURITY_REVIEW.md) before storing real production secrets.

## Principles

- All vault content is encrypted and decrypted **on clients** (web, extension,
  desktop). The server stores opaque envelopes and enforces authorization on
  identifiers and memberships.
- Only established primitives from **libsodium** (`libsodium-wrappers-sumo`
  0.8.x, a WebAssembly build of libsodium) are used. Nothing in this repository
  implements a primitive.
- Every ciphertext carries a format version and algorithm id so formats can be
  migrated.
- Every symmetric ciphertext is bound to its usage context via AEAD associated
  data, so the server cannot swap ciphertexts between records, vaults, or roles.

## Primitives

| Purpose | Construction | libsodium API |
|---|---|---|
| Password hashing / KDF | Argon2id v1.3 | `crypto_pwhash` (ALG_ARGON2ID13) |
| Subkey derivation | BLAKE2b keyed KDF | `crypto_kdf_derive_from_key` |
| Symmetric AEAD | XChaCha20-Poly1305-IETF, 192-bit random nonce | `crypto_aead_xchacha20poly1305_ietf_*` |
| Public-key wrap (sharing) | X25519 sealed box (ephemeral X25519 + XSalsa20-Poly1305) | `crypto_box_seal` |
| Signatures (key grants, identity binding) | Ed25519 | `crypto_sign_detached` |
| Hashing (fingerprints, transcripts) | BLAKE2b-256 | `crypto_generichash` |
| Padding | ISO/IEC 7816-4, 128-byte blocks | `sodium_pad` |
| Randomness | OS CSPRNG via libsodium | `randombytes_buf`, `randombytes_uniform` |

Nonces: XChaCha20's 192-bit nonce is generated randomly for every encryption;
the collision probability is negligible for any realistic number of messages
under one key, so no nonce counters or state are needed.

## Envelope format

```
byte 0     format version (0x01)
byte 1     algorithm (0x01 = XChaCha20-Poly1305, 0x02 = X25519 sealed box)
byte 2..   0x01: nonce(24) || ciphertext || tag(16)
           0x02: ephemeral_pk(32) || box(ciphertext || tag(16))
```

Encoded as base64url without padding. For algorithm 0x01 the associated data
is `header(2 bytes) || utf8(context)`. Contexts in use:

| Context | Protects |
|---|---|
| `pv:user-key:v1` | User Key under the password wrap key |
| `pv:user-key:recovery:v1` | User Key under the recovery wrap key |
| `pv:private-key:x25519:v1` / `pv:private-key:ed25519:v1` | account private keys under the User Key |
| `pv:vault-key:v1:<vaultId>:<keyVersion>` | personal vault key under the User Key |
| `pv:record-key:v1:<vaultId>:<recordId>` | per-record key under the vault key |
| `pv:record:v1:<recordId>` | record payload under the record key |
| `pv:settings:v1` | per-user settings under the User Key |
| `pv:device-unlock:v1:<deviceId>` | User Key under a device-bound key (biometric unlock) |

Decryption failures of any kind raise `DecryptionError`; unknown versions raise
`UnsupportedFormatError`. Clients never fall back to unauthenticated data.

## Key hierarchy

```
master password ──Argon2id(salt, ops=3, mem=64 MiB)──► masterKey (32B, transient)
   masterKey ──kdf("PVauthky")──► authKey ── sent to server at login/registration
   masterKey ──kdf("PVwrapky")──► wrapKey ── AEAD ──► User Key (UK, random 32B)

recovery key (random 32B + 2B checksum, base32, shown once)
   ──kdf("PVrcwrap")──► recoveryWrapKey ── AEAD ──► UK
   ──kdf("PVrcauth")──► recoveryAuthKey ── proof of possession sent during vault recovery

UK ── AEAD ──► X25519 private key      (receives shared vault keys)
UK ── AEAD ──► Ed25519 private key     (signs vault-key grants and binds the X25519 key)
UK ── AEAD ──► personal Vault Key (VK)
VK (personal or shared) ── AEAD ──► record key (one per item/project)
record key ── AEAD ──► record payload (padded JSON)
```

### Authentication protocol (account login)

PassVault uses **client-side Argon2id with a derived authentication key**
(the same family of design as Bitwarden's master-password hash):

1. `POST /auth/prelogin {email}` returns the user's KDF parameters and salt.
   For unknown emails the server returns deterministic fake parameters derived
   from `HMAC(server secret, email)` so the response does not reveal whether an
   account exists.
2. The client runs Argon2id locally and derives `authKey` and `wrapKey` as
   independent subkeys. Only `authKey` is sent.
3. The server stores `Argon2id(authKey)` (libsodium `crypto_pwhash_str`) and
   compares in constant time.

Consequences:

- The plaintext master password and `wrapKey`/User Key never leave the client.
- `authKey` is a password-equivalent **for login only**. A server compromise
  that captures `authKey` in transit allows logging in (still gated by MFA)
  but not decrypting the vault: `wrapKey` cannot be computed from `authKey`.
- An attacker holding the database can mount an offline guessing attack, but
  each guess costs one client Argon2id plus one server Argon2id.
- A future upgrade path to an aPAKE (OPAQUE) is noted in
  [SECURITY_REVIEW.md](SECURITY_REVIEW.md); the KDF version field supports it.

### Authentication vs. vault unlocking

| Step | Proves | Server involved? |
|---|---|---|
| Login (authKey) + MFA (TOTP / recovery code) | account access → session token | yes |
| Unlock (wrapKey decrypts UK) | knowledge of master password → keys in memory | no |

A login session can exist while the vault is locked (e.g. after inactivity
lock). Unlocking requires the master password (or a device-bound biometric key
on desktop) and happens entirely on the client. MFA protects account access;
it does **not** add cryptographic protection to the vault, which is protected
independently by the master password.

## Registration

The client generates salt, UK, recovery key, X25519 and Ed25519 key pairs, and
the personal VK, and uploads only public keys, wrapped keys, `authKey`, and
`recoveryAuthKey`. The recovery key is displayed **once** and must be stored by
the user (printed or in another password manager).

## Master-password change

`rewrapForNewPassword`: a new salt and Argon2id derivation produce a new
`wrapKey`; the **same** UK is re-wrapped. Items are not re-encrypted.

- The server replaces `authKeyHash`, KDF params, and `encryptedUserKey`, and by
  default revokes all other sessions (user can opt out).
- **Other devices** that cached the old `encryptedUserKey` can still unlock
  their *offline* cache with the old password until they sync. When they sync
  they receive the new wrapped key; their session is revoked if the user chose
  "sign out other devices", forcing a new login with the new password.
- The recovery key is unaffected (it wraps the same UK).

Optional **User Key rotation** (`rotateUserKey`) generates a new UK, re-wraps
the private keys, the personal VK, and the settings blob, and issues a new
recovery key. Use it after a suspected device compromise. Ciphertext cached by a
compromised device under the old personal VK remains readable by whoever holds
that VK; rotating the personal VK and re-encrypting items is a separate,
heavier operation (deferred, see STATUS.md).

## Recovery

| Lost | What still works | Flow |
|---|---|---|
| MFA device | master password + one-time recovery code | log in, use recovery code, re-enroll MFA |
| Master password | recovery key + email + MFA (or MFA recovery code) | `recovery/verify` → client unwraps UK with recovery key → sets a new password; server checks `recoveryAuthKey` so an attacker with email+MFA alone cannot replace the keys |
| Master password **and** recovery key | email + MFA | **account reset**: vault data is permanently deleted and new keys are created. The server cannot decrypt anything, so no one can recover the data. |
| Everything incl. MFA codes | nothing | operator-assisted MFA reset after out-of-band identity verification (see OPERATIONS.md). Vault data stays encrypted and still requires the master password or recovery key. |

Resetting **account access** never resets **vault encryption**: an operator
or an attacker with mailbox access cannot read or silently replace the vault.

## Vault keys, grants and sharing

Each vault has a random 32-byte VK and an integer `keyVersion`.

- Personal vault grant: `AEAD(UK, VK, "pv:vault-key:v1:<vaultId>:<keyVersion>")`.
- Shared vault grant: `crypto_box_seal(recipient X25519, JSON{v, vaultId, userId, keyVersion, key})`
  plus an Ed25519 signature by the granting user over
  `"pv:vault-grant:v1\n" vaultId \n recipientUserId \n keyVersion \n BLAKE2b(envelope)`.

The recipient verifies the signature using the grantor's signing key and
checks that the sealed plaintext names the expected vault, recipient, and key
version (prevents the server replaying grants across vaults).

**Recipient verification.** Public keys come from the server, which could
substitute them. Clients show a fingerprint (`BLAKE2b("pv:fingerprint:v1" ||
signPub || encPub)`, 32 hex chars) and pin it in the user's encrypted settings
on first use (TOFU). Users can mark a contact as *verified* after comparing the
fingerprint out-of-band; a changed key for a pinned contact blocks sharing until
the user re-verifies.

Each account's X25519 key is signed by its Ed25519 key
(`publicKeySignature`), so an attacker cannot pair a victim's signing key with
an attacker encryption key.

### Revocation and key rotation

Removing a member marks the vault `rotationRequired`. The owner's client then
generates VK′ (`keyVersion + 1`), re-wraps every record key under VK′, re-grants
VK′ to remaining members, and by default **re-encrypts each record with a new
record key** so that a removed member who retained old record keys cannot read
future edits. The server applies this atomically (`POST /vaults/:id/rotate`).

What revocation cannot do:

- erase copies the removed member already exported, copied, or cached;
- prevent the removed member from decrypting **old** ciphertext they already
  downloaded with keys they already hold;
- change the underlying secret — passwords, tokens, and SSH authorizations
  should be rotated at the service itself. The UI says this on revocation.

## Local caches

Clients persist only server envelopes (already encrypted) plus non-secret
sync metadata (cursor, timestamps, pending-mutation ids). Offline unlock uses
the cached `encryptedUserKey` and KDF params. Pending offline edits are stored
already encrypted.

## Memory limitations

On lock, clients drop references to decrypted state and call
`sodium.memzero` on key buffers they own. JavaScript cannot guarantee erasure:
strings are immutable and may be copied by the engine, garbage collection is
non-deterministic, and the DOM/React may retain values. The native helper
(Go) has the same limitation for garbage-collected memory. PassVault therefore
does **not** claim protection against an attacker who can read process memory
of an unlocked (or recently unlocked) client.

## Non-goals (explicit)

Encryption does not protect against: a compromised device while the vault is
unlocked; a malicious or compromised client update (web app served by the
operator, extension update, desktop update); keyloggers; screen capture; or a
user who copies secrets elsewhere. For the web client in particular, the server
operator serves the code that performs decryption.
