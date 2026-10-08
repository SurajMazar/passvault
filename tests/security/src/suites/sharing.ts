import { randomUUID } from 'node:crypto';
import { DecryptionError, decryptRecord, initCrypto, openVaultGrant, unwrapRecordKey } from '@passvault/crypto';
import {
  accept,
  createRecord,
  createSharedVault,
  invite,
  inviteBody,
  newActor,
  rotateVault,
  updateBody,
  type Actor,
} from '../lib/actors';
import { signIn } from '../lib/client';
import { brief, errCode } from '../lib/http';
import { assert } from '../lib/results';
import { newItem } from '@passvault/vault-core';
import type { Suite } from '../lib/suite';
import { sleep } from '../lib/util';

const suite: Suite = {
  id: 'sharing',
  title: 'Encrypted sharing, revocation, rotation and offline clients',
  needsApi: true,
  async run(ctx) {
    const { t, log } = ctx;
    const env = ctx.env!;
    const api = env.api;
    await initCrypto();
    log('creating actors: owner, recipient, newcomer…');
    const owner: Actor = await newActor(env, 'share-owner');
    const bob: Actor = await newActor(env, 'share-bob');
    const carol: Actor = await newActor(env, 'share-carol');

    const S = await createSharedVault(env, owner);
    const records: Array<{ id: string; itemKey: Uint8Array; revision: number }> = [];
    // A real item payload: vault-core ignores records whose decrypted payload fails schema validation.
    const r1 = await createRecord(env, owner, S.vaultId, S.vaultKey, newItem('login', { title: 'db', fields: { username: 'app', password: 'share-canary-before-revoke', urls: [] } } as never));
    records.push(r1);
    /** The vault key Bob legitimately obtained (key version 1); used later to show it is useless after rotation. */
    let bobOldKey: Uint8Array | null = null;

    await t.check('share.invite-accept-decrypt', 'Recipient cannot read before accepting; after accepting, the signed grant opens and the record decrypts', async () => {
      await invite(env, S, owner, bob, 'viewer');
      const before = await api.get(`/records/${r1.id}`, { token: bob.token });
      const inv = await api.get('/invitations', { token: bob.token });
      const mine = (inv.body as Array<{ vaultId: string; invitedBy: { publicSigningKey: string } }>).find((i) => i.vaultId === S.vaultId);
      await accept(env, S, bob);
      const sync = await api.get('/sync', { token: bob.token, query: { cursor: '0' } });
      const m = (sync.body.vaults as Array<{ vaultId: string; encryptedVaultKey: string; keySignature: string; keyVersion: number }>).find((v) => v.vaultId === S.vaultId)!;
      const vk = openVaultGrant({ encryptedVaultKey: m.encryptedVaultKey, keySignature: m.keySignature, vaultId: S.vaultId, keyVersion: m.keyVersion, myUserId: bob.userId, me: bob.material.unlocked, grantorPublicSigningKey: mine!.invitedBy.publicSigningKey });
      const rec = (sync.body.records as Array<{ id: string; vaultId: string; encryptedKey: string; encryptedPayload: string }>).find((r) => r.id === r1.id)!;
      const { payload } = decryptRecord<{ title: string }>({ recordId: rec.id, vaultId: S.vaultId, vaultKey: vk, encryptedKey: rec.encryptedKey, encryptedPayload: rec.encryptedPayload });
      bobOldKey = vk;
      return { ok: before.status === 403 && payload.title === 'db', evidence: `before accept → ${brief(before)}; after accept: grant verified against the inviter's signing key and record decrypted` };
    }, { severity: 'critical' });

    // Bob also runs a real client with the shared record cached.
    const bobClient = await signIn(env, bob, 'bob-laptop');
    await t.check('share.client-sees-shared', 'The real client (vault-core) of the recipient caches and decrypts the shared item', () => {
      const has = bobClient.session.getSnapshot().items.some((i) => i.id === r1.id);
      return { ok: has, evidence: `shared item in Bob's decrypted snapshot: ${has}` };
    }, { severity: 'medium' });

    await t.check('share.viewer-cannot-write', 'A viewer cannot modify, delete or reshare', async () => {
      const upd = await api.put(`/records/${r1.id}`, updateBody(S.vaultId, S.vaultKey, r1.id, r1.revision), { token: bob.token });
      const del = await api.del(`/records/${r1.id}`, { baseRevision: r1.revision, mutationId: randomUUID() }, { token: bob.token });
      const reshare = await api.post(`/vaults/${S.vaultId}/members`, inviteBody(S, bob, carol, 'viewer'), { token: bob.token });
      return { ok: upd.status === 403 && del.status === 403 && reshare.status === 403, evidence: `update → ${brief(upd)}; delete → ${brief(del)}; reshare → ${brief(reshare)}` };
    }, { severity: 'critical' });

    await t.check('share.revoke-stops-access', 'Removing a member stops API access immediately and forces a key rotation before new invitations', async () => {
      const rm = await api.del(`/vaults/${S.vaultId}/members/${bob.userId}`, undefined, { token: owner.token });
      const get = await api.get(`/records/${r1.id}`, { token: bob.token });
      const list = await api.get(`/vaults/${S.vaultId}/records`, { token: bob.token });
      const inviteNew = await api.post(`/vaults/${S.vaultId}/members`, inviteBody(S, owner, carol, 'viewer'), { token: owner.token });
      return {
        ok: rm.status === 204 && get.status === 404 && list.status === 404 && errCode(inviteNew) === 'key_rotation_required',
        evidence: `remove → ${brief(rm)}; Bob reads record → ${brief(get)}; lists vault → ${brief(list)}; owner invites someone before rotating → ${brief(inviteNew)}`,
      };
    }, { severity: 'critical' });

    await t.check('share.offline-client-after-revocation', "The revoked member's client drops the vault from its cache on next sync; its queued edits are rejected", async () => {
      const before = bobClient.session.getSnapshot().items.some((i) => i.id === r1.id);
      await bobClient.session.syncNow();
      const after = bobClient.session.getSnapshot().items.some((i) => i.id === r1.id);
      const cached = await [...bobClient.stores.values()][0]!.allRecords();
      const inCache = cached.some((r) => r.vaultId === S.vaultId);
      // A stale write from the revoked device (replayed mutation with its old view) is refused.
      const stale = await api.put(`/records/${r1.id}`, updateBody(S.vaultId, S.vaultKey, r1.id, r1.revision), { token: bob.token });
      return {
        ok: before && !after && !inCache && stale.status === 404,
        evidence: `before sync: visible=${before}; after sync: visible=${after}, ciphertext still in cache=${inCache}; stale write from revoked device → ${brief(stale)}. Plaintext Bob already saw (copies, screenshots, exports) cannot be recalled — revocation stops future access only.`,
      };
    }, { severity: 'critical' });

    await t.check('share.rotation-rules', 'Rotation must cover exactly the live members and live records, and must not re-grant the revoked member', async () => {
      const withBob = await rotateVault(env, owner, S, [owner, bob], records);
      const missing = await rotateVault(env, owner, S, [], records).catch((e: Error) => ({ status: 400, text: e.message }) as never);
      const ok = await rotateVault(env, owner, S, [owner], records);
      return {
        ok: withBob.status === 409 && (missing as { status: number }).status >= 400 && ok.status === 200,
        evidence: `grant incl. revoked member → ${brief(withBob)}; no grants → ${(missing as { status: number }).status}; exact members → ${brief(ok)} (key version now ${S.keyVersion})`,
      };
    }, { severity: 'critical' });

    await t.check('share.old-key-useless-for-new-data', "After rotation, the revoked member's old vault key cannot unwrap keys of new or re-wrapped records", async () => {
      assert(bobOldKey, "Bob's v1 key was not captured");
      const r2 = await createRecord(env, owner, S.vaultId, S.vaultKey, { title: 'after rotation', password: 'share-canary-after-rotation' });
      records.push(r2);
      const fetched = await api.get(`/records/${r2.id}`, { token: owner.token });
      let refused = '';
      try {
        unwrapRecordKey({ recordId: r2.id, vaultId: S.vaultId, vaultKey: bobOldKey!, encryptedKey: fetched.body.encryptedKey });
      } catch (e) {
        refused = (e as Error).name;
      }
      const r1now = await api.get(`/records/${r1.id}`, { token: owner.token });
      let refused2 = '';
      try {
        unwrapRecordKey({ recordId: r1.id, vaultId: S.vaultId, vaultKey: bobOldKey!, encryptedKey: r1now.body.encryptedKey });
      } catch (e) {
        refused2 = (e as Error).name;
      }
      return { ok: refused === DecryptionError.name && refused2 === DecryptionError.name, evidence: `new record with v1 key → ${refused || 'DECRYPTED'}; re-wrapped existing record with v1 key → ${refused2 || 'DECRYPTED'}` };
    }, { severity: 'high' });

    await t.check('share.stale-grant-refused', 'Invitations made with an old key version are refused after rotation', async () => {
      const stale = { ...S, keyVersion: 1 };
      const r = await api.post(`/vaults/${S.vaultId}/members`, inviteBody(stale, owner, carol, 'viewer'), { token: owner.token });
      const ok = await api.post(`/vaults/${S.vaultId}/members`, inviteBody(S, owner, carol, 'viewer'), { token: owner.token });
      return { ok: r.status === 409 && ok.status === 201, evidence: `grant for key v1 → ${brief(r)}; grant for current key v${S.keyVersion} → ${brief(ok)}` };
    }, { severity: 'high' });

    await t.check('share.last-owner', 'The last owner cannot leave or be removed (the vault would become unmanageable)', async () => {
      const r = await api.del(`/vaults/${S.vaultId}/members/${owner.userId}`, undefined, { token: owner.token });
      const demote = await api.patch(`/vaults/${S.vaultId}/members/${owner.userId}`, { role: 'viewer' }, { token: owner.token });
      return { ok: r.status === 409 && demote.status === 409, evidence: `owner leaves → ${brief(r)}; owner demotes self → ${brief(demote)}` };
    }, { severity: 'medium' });

    await t.check('share.expiry', 'Time-limited access ends at its expiry (no job needed) and the vault then requires rotation', async () => {
      const v = await createSharedVault(env, owner);
      const rec = await createRecord(env, owner, v.vaultId, v.vaultKey, { title: 'temp' });
      await invite(env, v, owner, carol, 'viewer', new Date(Date.now() + 6000).toISOString());
      await accept(env, v, carol);
      const during = await api.get(`/records/${rec.id}`, { token: carol.token });
      await sleep(7000);
      const after = await api.get(`/records/${rec.id}`, { token: carol.token });
      return { ok: during.status === 200 && after.status === 403 && errCode(after) === 'membership_expired', evidence: `during → ${brief(during)}; after expiry → ${brief(after)}` };
    }, { severity: 'high' });

    await t.check('share.client-signature-check', "The recipient's client refuses a grant whose signature does not verify", async () => {
      const v = await createSharedVault(env, owner);
      await createRecord(env, owner, v.vaultId, v.vaultKey, { title: 'tampered' });
      const body = inviteBody(v, owner, carol, 'viewer');
      // Grant signed by Bob but presented as coming from the owner (a malicious server could do this).
      const forged = inviteBody(v, bob, carol, 'viewer');
      const r = await api.post(`/vaults/${v.vaultId}/members`, { ...body, keySignature: forged.keySignature }, { token: owner.token });
      await accept(env, v, carol);
      const sync = await api.get('/sync', { token: carol.token, query: { cursor: '0' } });
      const m = (sync.body.vaults as Array<{ vaultId: string; encryptedVaultKey: string; keySignature: string; keyVersion: number }>).find((x) => x.vaultId === v.vaultId)!;
      let refused = '';
      try {
        openVaultGrant({ encryptedVaultKey: m.encryptedVaultKey, keySignature: m.keySignature, vaultId: v.vaultId, keyVersion: m.keyVersion, myUserId: carol.userId, me: carol.material.unlocked, grantorPublicSigningKey: owner.material.keys.publicSigningKey });
      } catch (e) {
        refused = (e as Error).name;
      }
      return {
        ok: r.status === 201 && refused === 'GrantVerificationError',
        evidence: `server accepted the mis-signed grant (${brief(r)}) — it cannot verify signatures without trusting keys itself; the client refused it: ${refused || 'ACCEPTED'}`,
      };
    }, { severity: 'critical' });
  },
};

export default suite;
