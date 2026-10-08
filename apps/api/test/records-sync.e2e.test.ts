import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptRecord, encryptRecord } from '@passvault/crypto';
import type * as T from '@passvault/types';
import { P, auth, boot, createSharedVault, inviteBody, newRecord, onboard, type Ctx } from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await boot({ RECORD_HISTORY_LIMIT: '3' });
});
afterAll(async () => {
  await ctx.close();
});

const sync = async (token: string, cursor = '0', limit = 1000): Promise<T.SyncResponse> =>
  (await ctx.http.get(`${P}/sync`).query({ cursor, limit }).set(auth(token)).expect(200)).body;

function updateBody(id: string, vaultId: string, vaultKey: Uint8Array, baseRevision: number, payload: unknown, itemKey?: Uint8Array) {
  const e = encryptRecord({ recordId: id, vaultId, vaultKey, payload, itemKey });
  return { baseRevision, formatVersion: e.formatVersion, encryptedKey: e.encryptedKey, encryptedPayload: e.encryptedPayload, mutationId: randomUUID() };
}

describe('records', () => {
  it('create/get/update: 409 with current on conflict, versions kept (bounded), size reported', async () => {
    const u = await onboard(ctx, 'rec');
    const r = newRecord(u.personalVaultId, u.personalVaultKey, { title: 'GitHub', password: 'p1' });
    const created = await ctx.http.post(`${P}/records`).set(auth(u.token)).send(r.body).expect(201);
    expect(created.body).toMatchObject({ id: r.id, vaultId: u.personalVaultId, kind: 'item', revision: 1, deletedAt: null, createdBy: u.userId, updatedBy: u.userId });
    expect(created.body.size).toBe(Buffer.byteLength(r.body.encryptedKey) + Buffer.byteLength(r.body.encryptedPayload));
    expect(created.body.seq).toMatch(/^\d+$/);
    const got = await ctx.http.get(`${P}/records/${r.id}`).set(auth(u.token)).expect(200);
    expect(got.body).toEqual(created.body);
    const dec = decryptRecord<{ password: string }>({ recordId: r.id, vaultId: u.personalVaultId, vaultKey: u.personalVaultKey, encryptedKey: got.body.encryptedKey, encryptedPayload: got.body.encryptedPayload });
    expect(dec.payload.password).toBe('p1');

    let rev = 1;
    for (let i = 2; i <= 6; i++) {
      const res = await ctx.http.put(`${P}/records/${r.id}`).set(auth(u.token)).send(updateBody(r.id, u.personalVaultId, u.personalVaultKey, rev, { password: `p${i}` }, r.itemKey)).expect(200);
      rev = res.body.revision;
      expect(BigInt(res.body.seq)).toBeGreaterThan(BigInt(created.body.seq));
    }
    expect(rev).toBe(6);
    // conflict: stale base revision -> 409 with the current record
    const conflict = await ctx.http.put(`${P}/records/${r.id}`).set(auth(u.token)).send(updateBody(r.id, u.personalVaultId, u.personalVaultKey, 2, { password: 'stale' })).expect(409);
    expect(conflict.body.error.code).toBe('revision_conflict');
    expect(conflict.body.error.details.current).toMatchObject({ id: r.id, revision: 6 });
    // history: newest first, limited to RECORD_HISTORY_LIMIT=3, decryptable with the same item key
    const versions = await ctx.http.get(`${P}/records/${r.id}/versions`).set(auth(u.token)).expect(200);
    expect(versions.body.map((v: T.RecordVersionDto) => v.revision)).toEqual([5, 4, 3]);
    const old = decryptRecord<{ password: string }>({ recordId: r.id, vaultId: u.personalVaultId, vaultKey: u.personalVaultKey, encryptedKey: versions.body[0].encryptedKey, encryptedPayload: versions.body[0].encryptedPayload });
    expect(old.payload.password).toBe('p5');
  });

  it('idempotent retries return the same response without double-applying', async () => {
    const u = await onboard(ctx, 'idem');
    const r = newRecord(u.personalVaultId, u.personalVaultKey);
    const a = await ctx.http.post(`${P}/records`).set(auth(u.token)).send(r.body).expect(201);
    const b = await ctx.http.post(`${P}/records`).set(auth(u.token)).send(r.body).expect(201);
    expect(b.body).toEqual(a.body);
    const upd = updateBody(r.id, u.personalVaultId, u.personalVaultKey, 1, { v: 2 });
    const u1 = await ctx.http.put(`${P}/records/${r.id}`).set(auth(u.token)).send(upd).expect(200);
    const u2 = await ctx.http.put(`${P}/records/${r.id}`).set(auth(u.token)).send(upd).expect(200);
    expect(u2.body).toEqual(u1.body);
    expect(u1.body.revision).toBe(2);
    const cur = await ctx.http.get(`${P}/records/${r.id}`).set(auth(u.token)).expect(200);
    expect(cur.body.revision).toBe(2);
    expect(await ctx.prisma.recordVersion.count({ where: { recordId: r.id } })).toBe(1);
    // concurrent duplicates also apply once
    const upd3 = updateBody(r.id, u.personalVaultId, u.personalVaultKey, 2, { v: 3 });
    const results = await Promise.all([1, 2, 3].map(() => ctx.http.put(`${P}/records/${r.id}`).set(auth(u.token)).send(upd3)));
    expect(results.map((x) => x.status)).toEqual([200, 200, 200]);
    expect(new Set(results.map((x) => x.body.seq)).size).toBe(1);
    expect((await ctx.http.get(`${P}/records/${r.id}`).set(auth(u.token))).body.revision).toBe(3);
    // a different user re-using the same mutationId is independent
    const other = await onboard(ctx, 'idem2');
    const r2 = newRecord(other.personalVaultId, other.personalVaultKey);
    await ctx.http.post(`${P}/records`).set(auth(other.token)).send({ ...r2.body, mutationId: r.body.mutationId }).expect(201);
  });

  it('permanent delete -> tombstone propagates; ids never resurrect', async () => {
    const u = await onboard(ctx, 'del');
    const r = newRecord(u.personalVaultId, u.personalVaultKey);
    await ctx.http.post(`${P}/records`).set(auth(u.token)).send(r.body).expect(201);
    await ctx.http.put(`${P}/records/${r.id}`).set(auth(u.token)).send(updateBody(r.id, u.personalVaultId, u.personalVaultKey, 1, { x: 1 })).expect(200);
    const s0 = await sync(u.token);
    await ctx.http.delete(`${P}/records/${r.id}`).set(auth(u.token)).send({ baseRevision: 1, mutationId: randomUUID() }).expect(409);
    const delBody = { baseRevision: 2, mutationId: randomUUID() };
    const del = await ctx.http.delete(`${P}/records/${r.id}`).set(auth(u.token)).send(delBody).expect(200);
    expect(del.body).toMatchObject({ id: r.id, revision: 3, encryptedKey: null, encryptedPayload: null, size: 0, deletedAt: expect.any(String) });
    // retry of the delete is idempotent
    expect((await ctx.http.delete(`${P}/records/${r.id}`).set(auth(u.token)).send(delBody).expect(200)).body).toEqual(del.body);
    expect(await ctx.prisma.recordVersion.count({ where: { recordId: r.id } })).toBe(0);

    const s1 = await sync(u.token, s0.cursor);
    expect(s1.records).toEqual([del.body]);
    await ctx.http.get(`${P}/records/${r.id}`).set(auth(u.token)).expect(410);
    const upd = await ctx.http.put(`${P}/records/${r.id}`).set(auth(u.token)).send(updateBody(r.id, u.personalVaultId, u.personalVaultKey, 3, { zombie: true })).expect(410);
    expect(upd.body.error.code).toBe('gone');
    const again = await ctx.http.post(`${P}/records`).set(auth(u.token)).send({ ...r.body, mutationId: randomUUID() }).expect(409);
    expect(again.body.error.code).toBe('already_exists');
    const audit = await ctx.http.get(`${P}/audit-events`).set(auth(u.token)).expect(200);
    expect(audit.body.data.find((e: T.AuditEventDto) => e.type === 'record.deleted')).toMatchObject({ recordId: r.id, actorUserId: u.userId });
  });

  it('moving between vaults requires write access to both', async () => {
    const a = await onboard(ctx, 'mv-a');
    const b = await onboard(ctx, 'mv-b');
    const v = await createSharedVault(ctx, a);
    await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(a.token)).send(inviteBody(v, a, b, 'viewer')).expect(201);
    await ctx.http.post(`${P}/invitations/${v.vaultId}/accept`).set(auth(b.token)).send({}).expect(200);
    // B (viewer of shared) cannot move a personal record into it
    const rb = newRecord(b.personalVaultId, b.personalVaultKey);
    await ctx.http.post(`${P}/records`).set(auth(b.token)).send(rb.body).expect(201);
    await ctx.http.put(`${P}/records/${rb.id}`).set(auth(b.token)).send({ ...updateBody(rb.id, v.vaultId, v.vaultKey, 1, {}), vaultId: v.vaultId }).expect(403);
    // A moves a personal record into the shared vault; B then sees it
    const ra = newRecord(a.personalVaultId, a.personalVaultKey);
    await ctx.http.post(`${P}/records`).set(auth(a.token)).send(ra.body).expect(201);
    const before = await sync(b.token);
    const moved = await ctx.http.put(`${P}/records/${ra.id}`).set(auth(a.token)).send({ ...updateBody(ra.id, v.vaultId, v.vaultKey, 1, { moved: true }), vaultId: v.vaultId }).expect(200);
    expect(moved.body.vaultId).toBe(v.vaultId);
    const after = await sync(b.token, before.cursor);
    expect(after.records.map((r) => r.id)).toContain(ra.id);
    // moving back out flags the shared vault for a full resync for B
    const back = await ctx.http.put(`${P}/records/${ra.id}`).set(auth(a.token)).send({ ...updateBody(ra.id, a.personalVaultId, a.personalVaultKey, 2, {}), vaultId: a.personalVaultId }).expect(200);
    expect(back.body.vaultId).toBe(a.personalVaultId);
    const after2 = await sync(b.token, after.cursor);
    expect(after2.resyncVaults).toContain(v.vaultId);
    const listing = await ctx.http.get(`${P}/vaults/${v.vaultId}/records`).set(auth(b.token)).expect(200);
    expect(listing.body.data.map((r: T.RecordDto) => r.id)).not.toContain(ra.id);
  });
});

describe('sync', () => {
  it('cursor paging in seq order, hasMore, tombstones included, cursor never goes backwards', async () => {
    const u = await onboard(ctx, 'sync');
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = newRecord(u.personalVaultId, u.personalVaultKey, { i });
      await ctx.http.post(`${P}/records`).set(auth(u.token)).send(r.body).expect(201);
      ids.push(r.id);
    }
    await ctx.http.delete(`${P}/records/${ids[0]}`).set(auth(u.token)).send({ baseRevision: 1, mutationId: randomUUID() }).expect(200);

    const seen: T.RecordDto[] = [];
    let cursor = '0';
    let pages = 0;
    let page: T.SyncResponse;
    do {
      page = await sync(u.token, cursor, 3);
      pages++;
      expect(BigInt(page.cursor)).toBeGreaterThanOrEqual(BigInt(cursor));
      seen.push(...page.records);
      cursor = page.cursor;
      expect(page.vaults.map((v) => v.vaultId)).toEqual([u.personalVaultId]);
      expect(page.serverTime).toEqual(expect.any(String));
    } while (page.hasMore);
    expect(pages).toBe(3);
    const seqs = seen.map((r) => BigInt(r.seq));
    expect([...seqs].sort((x, y) => (x < y ? -1 : 1))).toEqual(seqs);
    expect(new Set(seen.map((r) => r.id))).toEqual(new Set(ids));
    expect(seen.find((r) => r.id === ids[0])!.deletedAt).not.toBeNull();

    // nothing new -> empty page, same cursor
    const idle = await sync(u.token, cursor);
    expect(idle.records).toEqual([]);
    expect(idle.cursor).toBe(cursor);
    // a bogus future cursor is never moved backwards
    const future = (BigInt(cursor) + 1000n).toString();
    expect((await sync(u.token, future)).cursor).toBe(future);
    // settings revision is reported
    await ctx.http.put(`${P}/account/settings`).set(auth(u.token)).send({ baseRevision: 0, encryptedSettings: 'AQEx' }).expect(200);
    expect((await sync(u.token, cursor)).settingsRevision).toBe(1);
  });

  it('resyncVaults after accepting an invitation; pendingInvitations count', async () => {
    const a = await onboard(ctx, 'rs-a');
    const b = await onboard(ctx, 'rs-b');
    const v = await createSharedVault(ctx, a);
    const r = newRecord(v.vaultId, v.vaultKey);
    await ctx.http.post(`${P}/records`).set(auth(a.token)).send(r.body).expect(201);
    const b0 = await sync(b.token);
    await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(a.token)).send(inviteBody(v, a, b, 'editor')).expect(201);
    const b1 = await sync(b.token, b0.cursor);
    expect(b1.pendingInvitations).toBe(1);
    expect(b1.vaults.map((x) => x.vaultId)).not.toContain(v.vaultId);
    expect(b1.records).toEqual([]);

    await ctx.http.post(`${P}/invitations/${v.vaultId}/accept`).set(auth(b.token)).send({}).expect(200);
    const b2 = await sync(b.token, b1.cursor);
    expect(b2.pendingInvitations).toBe(0);
    expect(b2.vaults.map((x) => x.vaultId)).toContain(v.vaultId);
    expect(b2.resyncVaults).toEqual([v.vaultId]);
    // the record predates the cursor: client re-lists the vault
    expect(b2.records.map((x) => x.id)).not.toContain(r.id);
    const listing = await ctx.http.get(`${P}/vaults/${v.vaultId}/records`).query({ limit: 10 }).set(auth(b.token)).expect(200);
    expect(listing.body).toEqual({ data: [expect.objectContaining({ id: r.id })], nextCursor: null });
    // resync is reported once
    expect((await sync(b.token, b2.cursor)).resyncVaults).toEqual([]);
    // declined invitations
    const c = await onboard(ctx, 'rs-c');
    await ctx.http.post(`${P}/vaults/${v.vaultId}/members`).set(auth(a.token)).send(inviteBody(v, a, c, 'viewer')).expect(201);
    await ctx.http.post(`${P}/invitations/${v.vaultId}/decline`).set(auth(c.token)).send({}).expect(204);
    expect((await ctx.http.get(`${P}/invitations`).set(auth(c.token))).body).toEqual([]);
    await ctx.http.post(`${P}/invitations/${v.vaultId}/accept`).set(auth(c.token)).send({}).expect(404);
  });

  it('a committed change is never skipped by a concurrent cursor (sequence order == commit order)', async () => {
    const u = await onboard(ctx, 'race');
    let cursor = '0';
    const all = new Set<string>();
    const created: string[] = [];
    const writers = Array.from({ length: 20 }, async () => {
      const r = newRecord(u.personalVaultId, u.personalVaultKey);
      await ctx.http.post(`${P}/records`).set(auth(u.token)).send(r.body).expect(201);
      created.push(r.id);
    });
    const reader = (async () => {
      for (let i = 0; i < 15; i++) {
        const s = await sync(u.token, cursor);
        s.records.forEach((r) => all.add(r.id));
        cursor = s.cursor;
      }
    })();
    await Promise.all([...writers, reader]);
    const final = await sync(u.token, cursor);
    final.records.forEach((r) => all.add(r.id));
    for (const id of created) expect(all.has(id)).toBe(true);
  });
});

describe('background jobs', () => {
  it('purge removes revoked sessions and stale idempotency rows', async () => {
    const u = await onboard(ctx, 'purge');
    await ctx.http.post(`${P}/auth/logout`).set(auth(u.token)).send({}).expect(204);
    const r = newRecord(u.personalVaultId, u.personalVaultKey);
    await ctx.prisma.mutation.create({ data: { userId: u.userId, mutationId: randomUUID(), statusCode: 201, response: {} } });
    const res = await ctx.jobs.purge(new Date(Date.now() + 8 * 24 * 60 * 60_000));
    expect(res.sessions).toBeGreaterThanOrEqual(1);
    expect(res.mutations).toBeGreaterThanOrEqual(1);
    expect(res.pendingRegistrations).toBeGreaterThanOrEqual(1);
    expect(r.id).toBeTruthy();
  });
});
