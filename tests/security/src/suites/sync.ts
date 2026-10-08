import { randomUUID } from 'node:crypto';
import { initCrypto } from '@passvault/crypto';
import { accept, createRecord, createSharedVault, invite, newActor, recordBody, rotateVault, updateBody, type Actor } from '../lib/actors';
import { brief, errCode } from '../lib/http';
import type { Suite } from '../lib/suite';
import { vitestCheck } from '../lib/vitest';

/** Deep equality independent of key order (stored responses come back from jsonb with keys reordered). */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const suite: Suite = {
  id: 'sync',
  title: 'Synchronization, idempotency, conflicts, tombstones and history',
  needsApi: true,
  async run(ctx) {
    const { t, log } = ctx;
    const env = ctx.env!;
    const api = env.api;
    await initCrypto();
    log('creating actors…');
    const a: Actor = await newActor(env, 'sync-a');
    const b: Actor = await newActor(env, 'sync-b');

    await t.check('sync.idempotent-replay', 'A replayed mutation returns the original result and is applied once; reusing its id with a different body changes nothing', async () => {
      const rb = recordBody(a.personalVaultId, a.personalVaultKey, { title: 'once' });
      const first = await api.post('/records', rb.body, { token: a.token });
      const replay = await api.post('/records', rb.body, { token: a.token });
      const other = recordBody(a.personalVaultId, a.personalVaultKey, { title: 'different' }, rb.id);
      const sameIdDifferentBody = await api.post('/records', { ...other.body, mutationId: rb.body.mutationId }, { token: a.token });
      const now = await api.get(`/records/${rb.id}`, { token: a.token });
      return {
        ok: first.status === 201 && replay.status === 201 && sameJson(replay.body, first.body) && sameJson(sameIdDifferentBody.body, first.body) && now.body.revision === 1 && now.body.encryptedPayload === rb.body.encryptedPayload,
        evidence: `first → ${brief(first)}; replay → ${brief(replay)} (same result: ${sameJson(replay.body, first.body)}); same mutation id, other payload → stored result returned: ${sameJson(sameIdDifferentBody.body, first.body)}; record revision ${now.body.revision}, payload unchanged: ${now.body.encryptedPayload === rb.body.encryptedPayload}`,
      };
    }, { severity: 'high' });

    await t.check('sync.mutation-ids-per-user', "Another user replaying someone's mutation id gets no stored response (idempotency is per user)", async () => {
      const rb = recordBody(a.personalVaultId, a.personalVaultKey, { title: 'mine' });
      await api.post('/records', rb.body, { token: a.token });
      const replayByB = await api.post('/records', rb.body, { token: b.token });
      return { ok: replayByB.status === 404, evidence: `B replays A's create (same mutation id) → ${brief(replayByB)}` };
    }, { severity: 'high' });

    await t.check('sync.stale-base-revision', 'Writes based on an old revision are refused with the current version for client-side merge', async () => {
      const r = await createRecord(env, a, a.personalVaultId, a.personalVaultKey, { title: 'v1' });
      const u1 = await api.put(`/records/${r.id}`, updateBody(a.personalVaultId, a.personalVaultKey, r.id, 1, { title: 'v2' }), { token: a.token });
      const stale = await api.put(`/records/${r.id}`, updateBody(a.personalVaultId, a.personalVaultKey, r.id, 1, { title: 'v2-from-stale-device' }), { token: a.token });
      return {
        ok: u1.status === 200 && stale.status === 409 && errCode(stale) === 'revision_conflict' && stale.body.error.details?.current?.revision === 2,
        evidence: `update → ${brief(u1)}; stale update → ${brief(stale)} with current revision ${stale.body?.error?.details?.current?.revision}`,
      };
    }, { severity: 'high' });

    await t.check('sync.concurrent-updates', 'Ten concurrent updates on the same base revision: exactly one wins, the rest conflict', async () => {
      const r = await createRecord(env, a, a.personalVaultId, a.personalVaultKey, { title: 'race' });
      const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => api.put(`/records/${r.id}`, updateBody(a.personalVaultId, a.personalVaultKey, r.id, 1, { title: `w${i}` }), { token: a.token })));
      const wins = rs.filter((x) => x.status === 200).length;
      const conflicts = rs.filter((x) => x.status === 409).length;
      const final = await api.get(`/records/${r.id}`, { token: a.token });
      return { ok: wins === 1 && conflicts === 9 && final.body.revision === 2, evidence: `${wins} applied, ${conflicts} conflicts, final revision ${final.body.revision}` };
    }, { severity: 'high' });

    await t.check('sync.tombstones', 'Permanently deleted records stay deleted: no read, update, re-create or resurrection through sync', async () => {
      const r = await createRecord(env, a, a.personalVaultId, a.personalVaultKey, { title: 'to delete' });
      const del = await api.del(`/records/${r.id}`, { baseRevision: 1, mutationId: randomUUID() }, { token: a.token });
      const get = await api.get(`/records/${r.id}`, { token: a.token });
      const put = await api.put(`/records/${r.id}`, updateBody(a.personalVaultId, a.personalVaultKey, r.id, 2), { token: a.token });
      const recreate = await api.post('/records', recordBody(a.personalVaultId, a.personalVaultKey, { title: 'zombie' }, r.id).body, { token: a.token });
      const versions = await api.get(`/records/${r.id}/versions`, { token: a.token });
      const sync = await api.get('/sync', { token: a.token, query: { cursor: '0' } });
      const row = (sync.body.records as Array<{ id: string; deletedAt: string | null; encryptedPayload: string | null; encryptedKey: string | null }>).find((x) => x.id === r.id);
      return {
        ok: del.status === 200 && get.status === 410 && put.status === 410 && recreate.status === 409 && versions.status === 410 && !!row?.deletedAt && row.encryptedPayload === null && row.encryptedKey === null,
        evidence: `delete → ${brief(del)}; get → ${brief(get)}; update → ${brief(put)}; re-create same id → ${brief(recreate)}; versions → ${brief(versions)}; sync row: deletedAt set, ciphertext ${row?.encryptedPayload === null ? 'dropped' : 'PRESENT'}`,
      };
    }, { severity: 'high' });

    await t.check('sync.cursor', 'Sync cursors never move backwards and replays are stable', async () => {
      const s1 = await api.get('/sync', { token: a.token, query: { cursor: '0' } });
      const ahead = (BigInt(s1.body.cursor) + 1000n).toString();
      const s2 = await api.get('/sync', { token: a.token, query: { cursor: ahead } });
      const s3 = await api.get('/sync', { token: a.token, query: { cursor: '0' } });
      return {
        ok: BigInt(s2.body.cursor) >= BigInt(ahead) && s3.body.records.length === s1.body.records.length,
        evidence: `cursor ahead of the server stays at ${s2.body.cursor} (≥ ${ahead}); replay from 0 returned ${s3.body.records.length} = ${s1.body.records.length} records`,
      };
    }, { severity: 'medium' });

    await t.check('sync.membership-change-mid-sync', 'A member removed between two sync pages receives no further records of that vault', async () => {
      const S = await createSharedVault(env, a);
      for (let i = 0; i < 3; i++) await createRecord(env, a, S.vaultId, S.vaultKey, { title: `p${i}` });
      await invite(env, S, a, b, 'viewer');
      await accept(env, S, b);
      const p1 = await api.get('/sync', { token: b.token, query: { cursor: '0', limit: 1 } });
      const rm = await api.del(`/vaults/${S.vaultId}/members/${b.userId}`, undefined, { token: a.token });
      let cursor = p1.body.cursor as string;
      let leaked = 0;
      let pages = 0;
      for (;;) {
        const p = await api.get('/sync', { token: b.token, query: { cursor, limit: 1 } });
        pages++;
        leaked += (p.body.records as Array<{ vaultId: string }>).filter((r) => r.vaultId === S.vaultId).length;
        if ((p.body.vaults as Array<{ vaultId: string }>).some((v) => v.vaultId === S.vaultId)) leaked++;
        if (!p.body.hasMore || pages > 20) break;
        cursor = p.body.cursor;
      }
      return { ok: rm.status === 204 && leaked === 0, evidence: `page 1 before removal; removal → ${brief(rm)}; ${pages} later page(s) contained ${leaked} item(s) of the vault` };
    }, { severity: 'critical' });

    await t.check('sync.revoked-replay', 'Replaying a stored mutation after losing access re-sends only the original response and writes nothing', async () => {
      const S = await createSharedVault(env, a);
      await invite(env, S, a, b, 'editor');
      await accept(env, S, b);
      const rb = recordBody(S.vaultId, S.vaultKey, { title: 'by b' });
      const first = await api.post('/records', rb.body, { token: b.token });
      await api.del(`/vaults/${S.vaultId}/members/${b.userId}`, undefined, { token: a.token });
      const replay = await api.post('/records', rb.body, { token: b.token });
      const fresh = await api.post('/records', recordBody(S.vaultId, S.vaultKey, { title: 'new by b' }).body, { token: b.token });
      const owner = await api.get(`/records/${rb.id}`, { token: a.token });
      return {
        ok: first.status === 201 && sameJson(replay.body, first.body) && fresh.status === 404 && owner.body.revision === 1,
        evidence: `original → ${brief(first)}; replay after revocation → ${brief(replay)} (stored response of B's own earlier write, no new data); new write → ${brief(fresh)}; record revision ${owner.body.revision}`,
      };
    }, { severity: 'medium' });

    await t.check('sync.atomic-rotation', 'A rotation with one stale record fails as a whole (no partial key change)', async () => {
      const S = await createSharedVault(env, a);
      const r1 = await createRecord(env, a, S.vaultId, S.vaultKey, { title: 'one' });
      const r2 = await createRecord(env, a, S.vaultId, S.vaultKey, { title: 'two' });
      await api.put(`/records/${r2.id}`, updateBody(S.vaultId, S.vaultKey, r2.id, 1), { token: a.token }); // r2 now revision 2
      const recs = [r1, { ...r2, revision: 1 }];
      const rot = await rotateVault(env, a, S, [a], recs);
      const after1 = await api.get(`/records/${r1.id}`, { token: a.token });
      const vaults = await api.get('/vaults', { token: a.token });
      const kv = (vaults.body as Array<{ vaultId: string; keyVersion: number }>).find((v) => v.vaultId === S.vaultId)?.keyVersion;
      return { ok: rot.status === 409 && after1.body.revision === 1 && kv === 1, evidence: `rotation → ${brief(rot)}; untouched record revision ${after1.body.revision}; vault key version ${kv}` };
    }, { severity: 'high' });

    await vitestCheck(t, 'sync.engine-tests', 'Client sync engine: outbox ordering, coalescing, out-of-order pages, conflicts (unit tests)', 'packages/sync', { severity: 'high' });
    await vitestCheck(t, 'sync.vault-core-tests', 'vault-core: conflicts, history, lock/unlock, settings merge (unit tests)', 'packages/vault-core', { severity: 'high' });
    t.unverified('sync.interrupted-writes', 'Writes interrupted mid-transaction leave no partial state', 'needs database fault injection (killing Postgres mid-transaction); atomic multi-row operations are covered by sync.atomic-rotation; single-row writes rely on Postgres transactions (seqTx)');
  },
};

export default suite;
