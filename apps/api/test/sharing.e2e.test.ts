import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptRecord, generateVaultKey, grantVaultKey, openVaultGrant } from '@passvault/crypto';
import type * as T from '@passvault/types';
import { P, advance, auth, boot, createSharedVault, inviteBody, newRecord, onboard, share, type Ctx } from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await boot();
});
afterAll(async () => {
  await ctx.close();
});

async function syncAll(token: string, cursor = '0'): Promise<T.SyncResponse> {
  return (await ctx.http.get(`${P}/sync?cursor=${cursor}&limit=1000`).set(auth(token)).expect(200)).body;
}

describe('cross-user authorization', () => {
  it('B cannot touch A personal vault records or members, nor see them in /sync', async () => {
    const a = await onboard(ctx, 'a');
    const b = await onboard(ctx, 'b');
    const rec = newRecord(a.personalVaultId, a.personalVaultKey);
    const created = await ctx.http.post(`${P}/records`).set(auth(a.token)).send(rec.body).expect(201);

    await ctx.http.get(`${P}/records/${rec.id}`).set(auth(b.token)).expect(404);
    await ctx.http.get(`${P}/records/${rec.id}/versions`).set(auth(b.token)).expect(404);
    const enc = encryptRecord({ recordId: rec.id, vaultId: a.personalVaultId, vaultKey: generateVaultKey(), payload: { x: 1 } });
    await ctx.http.put(`${P}/records/${rec.id}`).set(auth(b.token))
      .send({ baseRevision: 1, formatVersion: 1, encryptedKey: enc.encryptedKey, encryptedPayload: enc.encryptedPayload, mutationId: randomUUID() }).expect(404);
    await ctx.http.delete(`${P}/records/${rec.id}`).set(auth(b.token)).send({ baseRevision: 1, mutationId: randomUUID() }).expect(404);
    // B cannot create a record inside A's vault, nor move one there
    await ctx.http.post(`${P}/records`).set(auth(b.token)).send(newRecord(a.personalVaultId, generateVaultKey()).body).expect(404);
    await ctx.http.get(`${P}/vaults/${a.personalVaultId}/members`).set(auth(b.token)).expect(404);
    await ctx.http.get(`${P}/vaults/${a.personalVaultId}/records`).set(auth(b.token)).expect(404);
    await ctx.http.post(`${P}/vaults/${a.personalVaultId}/members`).set(auth(b.token))
      .send(inviteBody({ vaultId: a.personalVaultId, vaultKey: generateVaultKey() }, b, b, 'viewer')).expect(404);
    // the owner cannot share a personal vault either
    await ctx.http.post(`${P}/vaults/${a.personalVaultId}/members`).set(auth(a.token))
      .send(inviteBody({ vaultId: a.personalVaultId, vaultKey: a.personalVaultKey }, a, b, 'viewer')).expect(403);

    const s = await syncAll(b.token);
    expect(s.vaults.map((v) => v.vaultId)).toEqual([b.personalVaultId]);
    expect(s.records.find((r) => r.id === rec.id)).toBeUndefined();
    expect(created.body.vaultId).toBe(a.personalVaultId);
  });

  it('roles: viewer read-only; editor writes but cannot manage without resharing or grant owner', async () => {
    const a = await onboard(ctx, 'owner');
    const b = await onboard(ctx, 'member');
    const c = await onboard(ctx, 'third');
    const v = await createSharedVault(ctx, a);
    const rec = newRecord(v.vaultId, v.vaultKey);
    await ctx.http.post(`${P}/records`).set(auth(a.token)).send(rec.body).expect(201);

    // invited but not accepted -> no access yet
    await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(a.token)).send(inviteBody(v, a, b, 'viewer')).expect(201);
    await ctx.http.get(`${P}/records/${rec.id}`).set(auth(b.token)).expect(403);
    const inv = await ctx.http.get(`${P}/invitations`).set(auth(b.token)).expect(200);
    expect(inv.body).toEqual([expect.objectContaining({ vaultId: v.vaultId, role: 'viewer', itemCount: 1, invitedBy: expect.objectContaining({ userId: a.userId, publicSigningKey: a.material.keys.publicSigningKey }) })]);
    // duplicate invite rejected
    await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(a.token)).send(inviteBody(v, a, b, 'viewer')).expect(409);
    const accepted = await ctx.http.post(`${P}/invitations/${v.vaultId}/accept`).set(auth(b.token)).send({}).expect(200);
    expect(accepted.body).toMatchObject({ vaultId: v.vaultId, role: 'viewer', status: 'accepted', grantedBy: { userId: a.userId, publicSigningKey: a.material.keys.publicSigningKey } });
    // B can open the grant with A's signing key from grantedBy
    const key = openVaultGrant({
      encryptedVaultKey: accepted.body.encryptedVaultKey,
      keySignature: accepted.body.keySignature,
      vaultId: v.vaultId,
      keyVersion: 1,
      myUserId: b.userId,
      me: b.material.unlocked,
      grantorPublicSigningKey: accepted.body.grantedBy.publicSigningKey,
    });
    expect(Buffer.from(key).equals(Buffer.from(v.vaultKey))).toBe(true);

    await ctx.http.get(`${P}/records/${rec.id}`).set(auth(b.token)).expect(200);
    // viewer cannot write
    await ctx.http.post(`${P}/records`).set(auth(b.token)).send(newRecord(v.vaultId, v.vaultKey).body).expect(403);
    const upd = encryptRecord({ recordId: rec.id, vaultId: v.vaultId, vaultKey: v.vaultKey, payload: { y: 2 } });
    await ctx.http.put(`${P}/records/${rec.id}`).set(auth(b.token))
      .send({ baseRevision: 1, formatVersion: 1, encryptedKey: upd.encryptedKey, encryptedPayload: upd.encryptedPayload, mutationId: randomUUID() }).expect(403);
    await ctx.http.delete(`${P}/records/${rec.id}`).set(auth(b.token)).send({ baseRevision: 1, mutationId: randomUUID() }).expect(403);
    await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(b.token)).send(inviteBody(v, b, c, 'viewer')).expect(403);

    // promote to editor: can write, still cannot invite (resharing off)
    await ctx.http.patch(`${P}/vaults/${v.vaultId}/members/${b.userId}`).set(auth(b.token)).send({ role: 'owner' }).expect(403);
    const promoted = await ctx.http.patch(`${P}/vaults/${v.vaultId}/members/${b.userId}`).set(auth(a.token)).send({ role: 'editor' }).expect(200);
    expect(promoted.body.role).toBe('editor');
    await ctx.http.post(`${P}/records`).set(auth(b.token)).send(newRecord(v.vaultId, v.vaultKey).body).expect(201);
    await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(b.token)).send(inviteBody(v, b, c, 'viewer')).expect(403);
    await ctx.http.patch(`${P}/vaults/${v.vaultId}`).set(auth(b.token)).send({ allowResharing: true }).expect(403);
    const patched = await ctx.http.patch(`${P}/vaults/${v.vaultId}`).set(auth(a.token)).send({ allowResharing: true }).expect(200);
    expect(patched.body.allowResharing).toBe(true);
    // editor with resharing: may invite viewer/editor, never owner
    await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(b.token)).send(inviteBody(v, b, c, 'owner')).expect(403);
    const invited = await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(b.token)).send(inviteBody(v, b, c, 'editor')).expect(201);
    expect(invited.body).toMatchObject({ userId: c.userId, status: 'invited', invitedBy: b.userId });
    // editors cannot manage members
    await ctx.http.delete(`${P}/vaults/${v.vaultId}/members/${c.userId}`).set(auth(b.token)).expect(403);

    // members listing includes history and public keys
    const members = await ctx.http.get(`${P}/vaults/${v.vaultId}/members`).set(auth(b.token)).expect(200);
    expect(members.body.map((m: T.VaultMemberDto) => [m.userId, m.role, m.status]).sort()).toEqual(
      [[a.userId, 'owner', 'accepted'], [b.userId, 'editor', 'accepted'], [c.userId, 'editor', 'invited']].sort(),
    );

    // last owner protections
    await ctx.http.patch(`${P}/vaults/${v.vaultId}/members/${a.userId}`).set(auth(a.token)).send({ role: 'editor' }).expect(409);
    await ctx.http.delete(`${P}/vaults/${v.vaultId}/members/${a.userId}`).set(auth(a.token)).expect(409);
    await ctx.http.delete(`${P}/vaults/${a.personalVaultId}/members/${a.userId}`).set(auth(a.token)).expect(409);
  });

  it('expired membership is denied and the job marks it expired + rotationRequired', async () => {
    const a = await onboard(ctx, 'exp-owner');
    const b = await onboard(ctx, 'exp-member');
    const v = await createSharedVault(ctx, a);
    const rec = newRecord(v.vaultId, v.vaultKey);
    await ctx.http.post(`${P}/records`).set(auth(a.token)).send(rec.body).expect(201);
    await share(ctx, v, a, b, 'viewer', new Date(Date.now() + 60 * 60_000).toISOString());
    await ctx.http.get(`${P}/records/${rec.id}`).set(auth(b.token)).expect(200);
    expect((await syncAll(b.token)).vaults.map((x) => x.vaultId)).toContain(v.vaultId);

    advance(2 * 60 * 60_000);
    await ctx.http.get(`${P}/records/${rec.id}`).set(auth(b.token)).expect(403)
      .expect((r) => expect(r.body.error.code).toBe('membership_expired'));
    const s = await syncAll(b.token);
    expect(s.vaults.map((x) => x.vaultId)).not.toContain(v.vaultId);
    expect(s.records.find((r) => r.id === rec.id)).toBeUndefined();

    expect(await ctx.vaults.expireMemberships()).toBeGreaterThanOrEqual(1);
    const row = await ctx.prisma.vaultMember.findUniqueOrThrow({ where: { vaultId_userId: { vaultId: v.vaultId, userId: b.userId } } });
    expect(row.status).toBe('expired');
    const ownerView = await ctx.http.get(`${P}/vaults`).set(auth(a.token)).expect(200);
    expect(ownerView.body.find((x: T.VaultMembershipDto) => x.vaultId === v.vaultId).rotationRequired).toBe(true);
  });

  it('revoked member loses access and the vault disappears from sync', async () => {
    const a = await onboard(ctx, 'rev-owner');
    const b = await onboard(ctx, 'rev-member');
    const v = await createSharedVault(ctx, a);
    const rec = newRecord(v.vaultId, v.vaultKey);
    await ctx.http.post(`${P}/records`).set(auth(a.token)).send(rec.body).expect(201);
    await share(ctx, v, a, b, 'editor');
    const before = await syncAll(b.token);
    expect(before.vaults.map((x) => x.vaultId)).toContain(v.vaultId);
    expect(before.records.map((r) => r.id)).toContain(rec.id);

    await ctx.http.delete(`${P}/vaults/${v.vaultId}/members/${b.userId}`).set(auth(a.token)).expect(204);
    await ctx.http.get(`${P}/records/${rec.id}`).set(auth(b.token)).expect(404);
    const after = await syncAll(b.token, before.cursor);
    expect(after.vaults.map((x) => x.vaultId)).not.toContain(v.vaultId);
    // A edits after revocation: B never receives it
    const upd = encryptRecord({ recordId: rec.id, vaultId: v.vaultId, vaultKey: v.vaultKey, payload: { new: true } });
    await ctx.http.put(`${P}/records/${rec.id}`).set(auth(a.token))
      .send({ baseRevision: 1, formatVersion: 1, encryptedKey: upd.encryptedKey, encryptedPayload: upd.encryptedPayload, mutationId: randomUUID() }).expect(200);
    const later = await syncAll(b.token, after.cursor);
    expect(later.records.find((r) => r.id === rec.id)).toBeUndefined();
    const ownerView = await ctx.http.get(`${P}/vaults`).set(auth(a.token)).expect(200);
    expect(ownerView.body.find((x: T.VaultMembershipDto) => x.vaultId === v.vaultId).rotationRequired).toBe(true);
    // new invites are blocked until the key is rotated
    const c = await onboard(ctx, 'rev-third');
    await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(a.token)).send(inviteBody(v, a, c, 'viewer')).expect(409)
      .expect((r) => expect(r.body.error.code).toBe('key_rotation_required'));
  });

  it('user lookup returns verified users only', async () => {
    const a = await onboard(ctx, 'lookup');
    const b = await onboard(ctx, 'lookup-target');
    const r = await ctx.http.get(`${P}/users/lookup`).query({ email: b.email.toUpperCase() }).set(auth(a.token)).expect(200);
    expect(r.body).toEqual({
      userId: b.userId,
      email: b.email,
      name: b.name,
      publicEncryptionKey: b.material.keys.publicEncryptionKey,
      publicSigningKey: b.material.keys.publicSigningKey,
      publicKeySignature: b.material.keys.publicKeySignature,
    });
    await ctx.http.get(`${P}/users/lookup`).query({ email: 'missing@example.test' }).set(auth(a.token)).expect(404);
    await ctx.http.get(`${P}/users/lookup`).query({ email: b.email }).expect(401);
  });
});

describe('vault key rotation', () => {
  it('rejects incomplete grants/records and stale revisions; succeeds atomically and bumps keyVersion', async () => {
    const a = await onboard(ctx, 'rot-owner');
    const b = await onboard(ctx, 'rot-editor');
    const c = await onboard(ctx, 'rot-invitee');
    const d = await onboard(ctx, 'rot-removed');
    const v = await createSharedVault(ctx, a);
    await share(ctx, v, a, b, 'editor');
    await share(ctx, v, a, d, 'viewer');
    await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(a.token)).send(inviteBody(v, a, c, 'viewer')).expect(201);
    const r1 = newRecord(v.vaultId, v.vaultKey, { n: 1 });
    const r2 = newRecord(v.vaultId, v.vaultKey, { n: 2 });
    const r3 = newRecord(v.vaultId, v.vaultKey, { n: 3 });
    for (const r of [r1, r2, r3]) await ctx.http.post(`${P}/records`).set(auth(a.token)).send(r.body).expect(201);
    await ctx.http.delete(`${P}/records/${r3.id}`).set(auth(a.token)).send({ baseRevision: 1, mutationId: randomUUID() }).expect(200);
    await ctx.http.delete(`${P}/vaults/${v.vaultId}/members/${d.userId}`).set(auth(a.token)).expect(204);
    const bSync = await syncAll(b.token);

    const newKey = generateVaultKey();
    const grant = (u: typeof a) => {
      const g = grantVaultKey({ vaultKey: newKey, vaultId: v.vaultId, keyVersion: 2, recipientUserId: u.userId, recipientPublicEncryptionKey: u.material.keys.publicEncryptionKey, grantor: a.material.unlocked });
      return { userId: u.userId, ...g };
    };
    const rewrap = (r: typeof r1, baseRevision = 1) => {
      const e = encryptRecord({ recordId: r.id, vaultId: v.vaultId, vaultKey: newKey, payload: { rotated: true } });
      return { id: r.id, baseRevision, encryptedKey: e.encryptedKey, encryptedPayload: e.encryptedPayload };
    };
    const full = { newKeyVersion: 2, grants: [grant(a), grant(b), grant(c)], records: [rewrap(r1), rewrap(r2)] };
    const rotate = (body: object, token = a.token) => ctx.http.post(`${P}/vaults/${v.vaultId}/rotate`).set(auth(token)).send(body);

    // only owners
    await rotate(full, b.token).expect(403);
    // wrong version
    await rotate({ ...full, newKeyVersion: 3 }).expect(409);
    // missing invited member C
    const g1 = await rotate({ ...full, grants: [grant(a), grant(b)] }).expect(409);
    expect(g1.body.error.details.missingGrants).toEqual([c.userId]);
    // revoked member D must not get the new key
    const g2 = await rotate({ ...full, grants: [...full.grants, grant(d)] }).expect(409);
    expect(g2.body.error.details.unexpectedGrants).toEqual([d.userId]);
    // missing live record / including the tombstone
    const m1 = await rotate({ ...full, records: [rewrap(r1)] }).expect(409);
    expect(m1.body.error.details.missingRecords).toEqual([r2.id]);
    await rotate({ ...full, records: [...full.records, rewrap(r3, 2)] }).expect(409);
    // stale baseRevision after a concurrent edit by B
    const upd = encryptRecord({ recordId: r2.id, vaultId: v.vaultId, vaultKey: v.vaultKey, payload: { edited: 'by b' } });
    await ctx.http.put(`${P}/records/${r2.id}`).set(auth(b.token))
      .send({ baseRevision: 1, formatVersion: 1, encryptedKey: upd.encryptedKey, encryptedPayload: upd.encryptedPayload, mutationId: randomUUID() }).expect(200);
    const st = await rotate(full).expect(409);
    expect(st.body.error.code).toBe('revision_conflict');
    expect(st.body.error.details.stale).toEqual([{ id: r2.id, baseRevision: 1, currentRevision: 2 }]);
    // nothing was applied by the failed attempts
    expect((await ctx.prisma.vault.findUniqueOrThrow({ where: { id: v.vaultId } })).keyVersion).toBe(1);
    expect((await ctx.prisma.record.findUniqueOrThrow({ where: { id: r1.id } })).revision).toBe(1);

    const ok = await rotate({ ...full, records: [rewrap(r1), rewrap(r2, 2)] }).expect(200);
    expect(ok.body).toMatchObject({ vaultId: v.vaultId, keyVersion: 2, rotationRequired: false });
    const rec1 = await ctx.http.get(`${P}/records/${r1.id}`).set(auth(b.token)).expect(200);
    expect(rec1.body.revision).toBe(2);
    const versions = await ctx.http.get(`${P}/records/${r1.id}/versions`).set(auth(b.token)).expect(200);
    expect(versions.body.map((x: T.RecordVersionDto) => x.revision)).toEqual([1]);
    expect(versions.body[0].encryptedKey).toBe(r1.body.encryptedKey);

    // B: new grant at keyVersion 2, opened with A's key; vault flagged for resync
    const after = await syncAll(b.token, bSync.cursor);
    const mem = after.vaults.find((x) => x.vaultId === v.vaultId)!;
    expect(mem.keyVersion).toBe(2);
    const opened = openVaultGrant({ encryptedVaultKey: mem.encryptedVaultKey, keySignature: mem.keySignature, vaultId: v.vaultId, keyVersion: 2, myUserId: b.userId, me: b.material.unlocked, grantorPublicSigningKey: mem.grantedBy!.publicSigningKey });
    expect(Buffer.from(opened).equals(Buffer.from(newKey))).toBe(true);
    expect(after.resyncVaults).toContain(v.vaultId);
    expect(after.records.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());

    // invites now need the new key version
    const e = await onboard(ctx, 'rot-new');
    await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(a.token)).send(inviteBody(v, a, e, 'viewer', 1)).expect(409);
    await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(a.token)).send(inviteBody({ vaultId: v.vaultId, vaultKey: newKey }, a, e, 'viewer', 2)).expect(201);
  });

  it('deleting a shared vault tombstones its records and revokes members', async () => {
    const a = await onboard(ctx, 'del-owner');
    const b = await onboard(ctx, 'del-member');
    const v = await createSharedVault(ctx, a);
    const r = newRecord(v.vaultId, v.vaultKey);
    await ctx.http.post(`${P}/records`).set(auth(a.token)).send(r.body).expect(201);
    await share(ctx, v, a, b, 'editor');
    await ctx.http.delete(`${P}/vaults/${v.vaultId}`).set(auth(b.token)).expect(403);
    await ctx.http.delete(`${P}/vaults/${a.personalVaultId}`).set(auth(a.token)).expect(403);
    await ctx.http.delete(`${P}/vaults/${v.vaultId}`).set(auth(a.token)).expect(204);
    const s = await syncAll(b.token);
    expect(s.vaults.map((x) => x.vaultId)).not.toContain(v.vaultId);
    const row = await ctx.prisma.record.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.encryptedPayload).toBeNull();
  });
});
