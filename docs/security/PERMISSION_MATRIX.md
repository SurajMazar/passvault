# Permission matrix

Authorization is enforced by the API on every request, independently of
encryption (the server cannot read records, but it decides who may fetch,
change or delete their ciphertext). Central rule: `AccessService.require()`
(`apps/api/src/vaults/access.service.ts`).

- **Not a member, removed (revoked), declined, or the vault was deleted → 404**:
  the server does not reveal that the vault or record exists.
- **Member without sufficient rights → 403**: `forbidden` (role too low),
  `membership_expired` (expiry passed), or "accept the invitation first" (pending).

## Roles

| Role | Meaning |
|---|---|
| owner | full control: content, members, roles, expiry, key rotation, resharing setting, deletion |
| editor | read and write content; may invite (never as owner) **only** if the owner enabled resharing |
| viewer | read only |
| pending | invited, not yet accepted — no access until accepted |
| revoked | removed by an owner (or left) — treated as a stranger |
| expired | time-limited access that has ended — refused even before the expiry job runs |
| unrelated | any other authenticated user |

## Shared vault operations — observed

Status codes observed by the security harness (`security/authorization`) on
the disposable stack; ✓ marks the cases that are meant to be allowed.

| Operation | owner | editor | viewer | pending | revoked | expired | unrelated |
|---|---|---|---|---|---|---|---|
| List records `GET /vaults/:id/records` | 200 ✓ | 200 ✓ | 200 ✓ | 403 | 404 | 403 | 404 |
| Read record `GET /records/:id` | 200 ✓ | 200 ✓ | 200 ✓ | 403 | 404 | 403 | 404 |
| Version history `GET /records/:id/versions` | 200 ✓ | 200 ✓ | 200 ✓ | 403 | 404 | 403 | 404 |
| List members `GET /vaults/:id/members` | 200 ✓ | 200 ✓ | 200 ✓ | 403 | 404 | 403 | 404 |
| Create record `POST /records` | 201 ✓ | 201 ✓ | 403 | 403 | 404 | 403 | 404 |
| Update record `PUT /records/:id` | 200 ✓ | 200 ✓ | 403 | 403 | 404 | 403 | 404 |
| Delete record `DELETE /records/:id` | 200 ✓ | 200 ✓ | 403 | 403 | 404 | 403 | 404 |
| Invite `POST /vaults/:id/members` (resharing off) | 201 ✓ | 403 | 403 | 403 | 404 | 403 | 404 |
| Change a member's role `PATCH /vaults/:id/members/:user` | 200 ✓ | 403 | 403 | 403 | 404 | 403 | 404 |
| Remove another member `DELETE /vaults/:id/members/:user` | 409¹ | 403 | 403 | 403 | 404 | 403 | 404 |
| Rotate vault key `POST /vaults/:id/rotate` | 409² | 403 | 403 | 403 | 404 | 403 | 404 |
| Change resharing `PATCH /vaults/:id` | 200 ✓ | 403 | 403 | 403 | 404 | 403 | 404 |
| Delete vault `DELETE /vaults/:id` | 204 ✓ | 403 | 403 | 403 | 404 | 403 | 404 |

¹ The probe removes the vault's only owner, which is refused as a conflict (a
vault must keep an owner); removing other members as owner is covered by
`share.revoke-stops-access`. ² The probe sends a deliberately incomplete
rotation; the owner passes authorization and gets `409` (grants must cover
every member), everyone else is refused first.

## Other rules verified

| Rule | Check |
|---|---|
| Another user's personal vault: invisible for read/write/members; personal vaults cannot be shared | `authz.personal-vault.isolated` |
| Body identifiers cannot move records into vaults the caller cannot write; viewers cannot move records out | `authz.id-substitution.body` |
| Unknown/server-controlled fields rejected (strict schemas): `createdById`, `revision`, `ownerId`, `status`, `__proto__`, extra settings fields | `authz.mass-assignment` |
| Invitations: only the invitee can accept; not after decline, removal or expiry | `authz.invitations` |
| Editors cannot grant owner or promote themselves; with resharing on they may invite editors/viewers | `authz.editor-escalation` |
| Sessions and devices of other users cannot be listed, revoked, untrusted or forgotten | `authz.sessions-devices` |
| Sync returns only live memberships; pending/revoked/expired/unrelated users get nothing of the vault | `authz.sync-isolation` |
| Cursor manipulation cannot page into other vaults; malformed cursors rejected | `authz.pagination` |
| User lookup returns public identity fields only | `authz.lookup.public-fields-only` |
| Audit events of other users' vaults are not visible | `authz.audit-isolation` |
| Writes racing a revocation are applied before it or refused; none land after it | `authz.revocation-race` |
| Members removed between sync pages receive nothing further | `sync.membership-change-mid-sync` |
| A removed member's stale writes are refused; their client drops the vault on next sync | `share.offline-client-after-revocation` |

The machine-generated matrix of each run is in
`tests/security/results/<run>/artifacts/permission-matrix.md`.
