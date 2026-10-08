# Synchronization and offline behaviour

Implementation: `packages/sync` (engine, stores) and `packages/vault-core`
(overlay of local edits, conflict resolution UI hooks). Tests:
`packages/sync/test/engine.test.ts`, API e2e tests in `apps/api/test`.

## Model

- Every server change to a record, vault, or membership draws a value from a
  single Postgres sequence. Mutating transactions take a transaction-scoped
  advisory lock first, so sequence order equals commit order and a client
  cursor can never skip a late-committing change.
- `GET /sync?cursor=n` returns records with `seq > n` (including tombstones) in
  vaults the caller can currently access, the full current membership list,
  and `resyncVaults` (vaults whose membership changed after `n`, e.g. newly
  accepted or key rotated) which the client reloads in full.
- Clients cache only server envelopes. Local edits are **outbox entries**
  (already encrypted) layered over cached records when building the decrypted
  view.

## Writes

| Property | Mechanism |
|---|---|
| Idempotent | each mutation has a client UUID; the server stores the first response per `(user, mutationId)` and returns it on retries (covers lost responses) |
| No silent overwrite | updates/deletes carry `baseRevision`; mismatch → `409 revision_conflict` with the current server record |
| Ordered offline edits | an edit to a record with a pending entry chains on it (`afterMutationId`) and is re-based on the revision returned when the earlier entry succeeds |
| Deletions | permanent delete = tombstone (`deletedAt`, ciphertext removed, revision+1); tombstones sync like any change and are never resurrected; updates to a tombstone fail with `410 gone` and surface as failed changes |

## States shown in the UI

`syncing`, `idle` (with last sync time), `offline` (queued changes count),
`error`, per-item *pending* (cloud-upload icon), *failed* (retry/discard), and
*conflict* (resolve dialog: keep mine / keep theirs / keep both, with a
field-level and `.env` variable-level comparison).

## Offline

- Unlocking works offline from the cached account bundle (wrapped User Key +
  KDF params) and cached ciphertext.
- Edits are queued; sharing, invitations, membership changes, key rotation,
  password change, and MFA changes require connectivity.
- An offline client cannot learn about revoked access, expired memberships, or
  deletions until it reconnects; it keeps showing what it had cached. On the
  next sync, vaults that disappear from the membership list are purged from the
  cache and their pending edits fail.
- Stale caches: the cursor is persisted; a client that was offline for a long
  time simply receives all changes since its cursor. Tombstones are retained
  indefinitely so this is always safe.
- Expired sessions: API calls return 401 → the client keeps its encrypted cache,
  locks, and asks the user to sign in again (MFA may be required). Unlocking
  offline is still possible for reading.
- Password changed on another device: the cached wrapped key still opens with
  the old password offline; once online the client fetches the new bundle and
  the old password stops working (see CRYPTO.md).

## Known limitations

- The server can withhold updates or serve an older revision of a record
  (rollback) without detection.
- Concurrent rotation and editing of a shared vault: rotation requires all
  records at their current revision; an editor's concurrent write makes the
  rotation fail and it must be retried.
