import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  accept,
  createRecord,
  createSharedVault,
  invite,
  inviteBody,
  newActor,
  recordBody,
  rotateVault,
  updateBody,
  type Actor,
  type SharedVault,
} from '../lib/actors';
import { brief, type ApiResponse } from '../lib/http';
import { ARTIFACTS } from '../lib/paths';
import { assert } from '../lib/results';
import type { Suite } from '../lib/suite';
import { sleep } from '../lib/util';

type Role = 'owner' | 'editor' | 'viewer' | 'pending' | 'revoked' | 'expired' | 'unrelated';
const ROLES: Role[] = ['owner', 'editor', 'viewer', 'pending', 'revoked', 'expired', 'unrelated'];
/** allow = 2xx (or, for "authorized but rejected" probes, anything except 401/403/404); deny codes listed per role. */
type Expect = 'allow' | 'allow-or-4xx-not-authz' | number[];
const DENY_MEMBER = [403];
const DENY_HIDDEN = [404];

interface Op {
  id: string;
  title: string;
  expect: Record<Role, Expect>;
  run: (actor: Actor, role: Role) => Promise<ApiResponse>;
}

const suite: Suite = {
  id: 'authorization',
  title: 'Authorization and tenant isolation (permission matrix)',
  needsApi: true,
  async run(ctx) {
    const { t, log } = ctx;
    const env = ctx.env!;
    const api = env.api;
    log('creating actors: owner, editor, viewer, pending, revoked, expired, unrelated, spare…');
    const A: Record<Role, Actor> = {} as Record<Role, Actor>;
    for (const r of ROLES) A[r] = await newActor(env, `authz-${r}`);
    const spare = await newActor(env, 'authz-spare');
    const spare2 = await newActor(env, 'authz-spare2');

    // Shared vault S with every relationship.
    const S: SharedVault = await createSharedVault(env, A.owner, false);
    await invite(env, S, A.owner, A.editor, 'editor');
    await invite(env, S, A.owner, A.viewer, 'viewer');
    await invite(env, S, A.owner, A.pending, 'viewer');
    await invite(env, S, A.owner, A.revoked, 'editor');
    await invite(env, S, A.owner, A.expired, 'viewer', new Date(Date.now() + 20_000).toISOString());
    for (const r of ['editor', 'viewer', 'revoked', 'expired'] as Role[]) await accept(env, S, A[r]);
    const records: Array<{ id: string; itemKey: Uint8Array; revision: number }> = [];
    const r0 = await createRecord(env, A.owner, S.vaultId, S.vaultKey, { title: 'shared record' });
    records.push(r0);
    const rm = await api.del(`/vaults/${S.vaultId}/members/${A.revoked.userId}`, undefined, { token: A.owner.token });
    assert(rm.status === 204, `revoke setup ${brief(rm)}`);
    // Removing a member requires a key rotation before new invitations.
    const rot = await rotateVault(env, A.owner, S, [A.owner, A.editor, A.viewer, A.pending, A.expired], records);
    assert(rot.status === 200, `rotation setup ${brief(rot)}`);
    const wait = 21_000 - (Date.now() % 1000);
    log(`waiting ${Math.round(wait / 1000)} s for the expiring membership to lapse…`);
    await sleep(wait);

    const fresh = async () => createRecord(env, A.owner, S.vaultId, S.vaultKey, { title: 'target' });
    const writeExpect = (o: Expect = 'allow'): Record<Role, Expect> => ({ owner: o, editor: o, viewer: DENY_MEMBER, pending: DENY_MEMBER, revoked: DENY_HIDDEN, expired: DENY_MEMBER, unrelated: DENY_HIDDEN });
    const readExpect: Record<Role, Expect> = { owner: 'allow', editor: 'allow', viewer: 'allow', pending: DENY_MEMBER, revoked: DENY_HIDDEN, expired: DENY_MEMBER, unrelated: DENY_HIDDEN };
    const ownerOnly = (o: Expect = 'allow'): Record<Role, Expect> => ({ owner: o, editor: DENY_MEMBER, viewer: DENY_MEMBER, pending: DENY_MEMBER, revoked: DENY_HIDDEN, expired: DENY_MEMBER, unrelated: DENY_HIDDEN });

    const ops: Op[] = [
      { id: 'list-records', title: 'GET /vaults/S/records', expect: readExpect, run: (a) => api.get(`/vaults/${S.vaultId}/records`, { token: a.token }) },
      { id: 'get-record', title: 'GET /records/:id', expect: readExpect, run: (a) => api.get(`/records/${r0.id}`, { token: a.token }) },
      { id: 'record-versions', title: 'GET /records/:id/versions', expect: readExpect, run: (a) => api.get(`/records/${r0.id}/versions`, { token: a.token }) },
      { id: 'list-members', title: 'GET /vaults/S/members', expect: readExpect, run: (a) => api.get(`/vaults/${S.vaultId}/members`, { token: a.token }) },
      {
        id: 'create-record',
        title: 'POST /records into S',
        expect: writeExpect(),
        run: (a) => api.post('/records', recordBody(S.vaultId, S.vaultKey, { title: 'new' }).body, { token: a.token }),
      },
      {
        id: 'update-record',
        title: 'PUT /records/:id',
        expect: writeExpect(),
        run: async (a) => {
          const r = await fresh();
          return api.put(`/records/${r.id}`, updateBody(S.vaultId, S.vaultKey, r.id, r.revision), { token: a.token });
        },
      },
      {
        id: 'delete-record',
        title: 'DELETE /records/:id',
        expect: writeExpect(),
        run: async (a) => {
          const r = await fresh();
          return api.del(`/records/${r.id}`, { baseRevision: r.revision, mutationId: randomUUID() }, { token: a.token });
        },
      },
      {
        id: 'invite',
        title: 'POST /vaults/S/members (invite)',
        expect: ownerOnly(),
        run: async (a, role) => {
          const target = role === 'owner' ? spare : spare2;
          const r = await api.post(`/vaults/${S.vaultId}/members`, inviteBody(S, a, target, 'viewer'), { token: a.token });
          if (r.status === 201) await api.del(`/vaults/${S.vaultId}/members/${target.userId}`, undefined, { token: A.owner.token });
          return r;
        },
      },
      {
        id: 'change-role',
        title: 'PATCH /vaults/S/members/:viewer (role change)',
        expect: ownerOnly(),
        run: async (a) => {
          const r = await api.patch(`/vaults/${S.vaultId}/members/${A.viewer.userId}`, { role: 'editor' }, { token: a.token });
          if (r.status === 200) await api.patch(`/vaults/${S.vaultId}/members/${A.viewer.userId}`, { role: 'viewer' }, { token: A.owner.token });
          return r;
        },
      },
      {
        id: 'remove-owner',
        title: 'DELETE /vaults/S/members/:owner (remove another member)',
        // the owner removing itself is refused (last owner) — a conflict, not an authorization failure
        expect: ownerOnly('allow-or-4xx-not-authz'),
        run: (a) => api.del(`/vaults/${S.vaultId}/members/${A.owner.userId}`, undefined, { token: a.token }),
      },
      {
        id: 'rotate',
        title: 'POST /vaults/S/rotate',
        // probe body is well-formed but incomplete: the owner gets 409 (authorized, rejected), others must be refused first
        expect: ownerOnly('allow-or-4xx-not-authz'),
        run: (a) =>
          api.post(
            `/vaults/${S.vaultId}/rotate`,
            { newKeyVersion: S.keyVersion + 1, grants: [{ userId: a.userId, encryptedVaultKey: inviteBody(S, a, a, 'viewer').encryptedVaultKey, keySignature: null }], records: [] },
            { token: a.token },
          ),
      },
      {
        id: 'update-vault',
        title: 'PATCH /vaults/S (resharing setting)',
        expect: ownerOnly(),
        run: async (a) => {
          const r = await api.patch(`/vaults/${S.vaultId}`, { allowResharing: true }, { token: a.token });
          if (r.status === 200) await api.patch(`/vaults/${S.vaultId}`, { allowResharing: false }, { token: A.owner.token });
          return r;
        },
      },
      {
        id: 'delete-vault',
        title: 'DELETE /vaults/S',
        // the owner case runs on a throwaway vault so S survives
        expect: ownerOnly(),
        run: async (a, role) => {
          if (role === 'owner') {
            const tmp = await createSharedVault(env, A.owner);
            return api.del(`/vaults/${tmp.vaultId}`, undefined, { token: a.token });
          }
          return api.del(`/vaults/${S.vaultId}`, undefined, { token: a.token });
        },
      },
    ];

    // ------------------------------------------------------------------ matrix
    const matrix: Record<string, Record<Role, string>> = {};
    for (const op of ops) {
      matrix[op.id] = {} as Record<Role, string>;
      for (const role of ROLES) {
        const exp = op.expect[role];
        await t.check(
          `authz.${op.id}.${role}`,
          `${op.title} as ${role}: ${exp === 'allow' ? 'allowed' : exp === 'allow-or-4xx-not-authz' ? 'passes authorization' : `refused (${(exp as number[]).join('/')})`}`,
          async () => {
            const r = await op.run(A[role], role);
            matrix[op.id]![role] = String(r.status);
            const ok =
              exp === 'allow'
                ? r.status >= 200 && r.status < 300
                : exp === 'allow-or-4xx-not-authz'
                  ? ![401, 403, 404].includes(r.status) && r.status < 500
                  : (exp as number[]).includes(r.status);
            return { ok, evidence: `${op.title} as ${role} → ${brief(r)}` };
          },
          { severity: exp === 'allow' ? 'medium' : 'critical' },
        );
      }
    }
    mkdirSync(ARTIFACTS, { recursive: true });
    const lines = ['| Operation | ' + ROLES.join(' | ') + ' |', '|---|' + ROLES.map(() => '---').join('|') + '|'];
    for (const op of ops) lines.push(`| ${op.title} | ${ROLES.map((r) => `${matrix[op.id]?.[r] ?? '–'}${op.expect[r] === 'allow' ? ' ✓' : ''}`).join(' | ')} |`);
    writeFileSync(join(ARTIFACTS, 'permission-matrix.md'), `# Observed permission matrix (HTTP status per role; ✓ = expected to be allowed)\n\n${lines.join('\n')}\n`);

    // ------------------------------------------------------------------ isolation beyond the matrix
    await t.check('authz.personal-vault.isolated', "Another user's personal vault is invisible (read, write, invite)", async () => {
      const u = A.unrelated;
      const pv = A.owner.personalVaultId;
      const list = await api.get(`/vaults/${pv}/records`, { token: u.token });
      const create = await api.post('/records', recordBody(pv, A.owner.personalVaultKey, { x: 1 }).body, { token: u.token });
      const members = await api.get(`/vaults/${pv}/members`, { token: u.token });
      const shareOwn = await api.post(`/vaults/${A.owner.personalVaultId}/members`, inviteBody({ vaultId: pv, vaultKey: A.owner.personalVaultKey, keyVersion: 1 }, A.owner, u, 'viewer'), { token: A.owner.token });
      return {
        ok: list.status === 404 && create.status === 404 && members.status === 404 && shareOwn.status === 403,
        evidence: `unrelated: list ${brief(list)}, create ${brief(create)}, members ${brief(members)}; owner sharing own personal vault → ${brief(shareOwn)}`,
      };
    }, { severity: 'critical' });

    await t.check('authz.id-substitution.body', 'Identifiers in request bodies cannot redirect writes into vaults the caller cannot write', async () => {
      const intoForeign = await api.post('/records', recordBody(A.unrelated.personalVaultId, A.unrelated.personalVaultKey, { x: 1 }).body, { token: A.editor.token });
      const r = await fresh();
      const moveToForeign = await api.put(`/records/${r.id}`, { ...updateBody(A.unrelated.personalVaultId, A.unrelated.personalVaultKey, r.id, r.revision), vaultId: A.unrelated.personalVaultId }, { token: A.editor.token });
      const r2 = await fresh();
      const viewerMove = await api.put(`/records/${r2.id}`, { ...updateBody(A.viewer.personalVaultId, A.viewer.personalVaultKey, r2.id, r2.revision), vaultId: A.viewer.personalVaultId }, { token: A.viewer.token });
      const own = await createRecord(env, A.unrelated, A.unrelated.personalVaultId, A.unrelated.personalVaultKey, { x: 1 });
      const pushIntoS = await api.put(`/records/${own.id}`, { ...updateBody(S.vaultId, S.vaultKey, own.id, own.revision), vaultId: S.vaultId }, { token: A.unrelated.token });
      return {
        ok: intoForeign.status === 404 && moveToForeign.status === 404 && viewerMove.status === 403 && pushIntoS.status === 404,
        evidence: `editor creates in foreign vault → ${brief(intoForeign)}; editor moves S record to foreign vault → ${brief(moveToForeign)}; viewer moves S record out → ${brief(viewerMove)}; outsider moves own record into S → ${brief(pushIntoS)}`,
      };
    }, { severity: 'critical' });

    await t.check('authz.mass-assignment', 'Unknown or server-controlled fields are rejected (strict schemas)', async () => {
      const rb = recordBody(S.vaultId, S.vaultKey, { x: 1 }).body;
      const probes: Array<[string, Promise<ApiResponse>]> = [
        ['record createdById/revision', api.post('/records', { ...rb, createdById: A.unrelated.userId, revision: 99 }, { token: A.editor.token })],
        ['vault ownerId', api.patch(`/vaults/${S.vaultId}`, { ownerId: A.editor.userId }, { token: A.owner.token })],
        ['invite status=accepted', api.post(`/vaults/${S.vaultId}/members`, { ...inviteBody(S, A.owner, spare2, 'viewer'), status: 'accepted' }, { token: A.owner.token })],
        ['member role=owner by editor', api.patch(`/vaults/${S.vaultId}/members/${A.editor.userId}`, { role: 'owner' }, { token: A.editor.token })],
        ['__proto__ in body', api.call('POST', '/records', { rawBody: `{"__proto__":{"admin":true},${JSON.stringify(rb).slice(1)}`, token: A.editor.token })],
        ['settings extra field', api.put('/account/settings', { baseRevision: 0, encryptedSettings: rb.encryptedPayload, userId: A.owner.userId }, { token: A.editor.token })],
      ];
      const out: string[] = [];
      let ok = true;
      for (const [name, p] of probes) {
        const r = await p;
        out.push(`${name} → ${brief(r)}`);
        ok &&= r.status === 400 || r.status === 403;
      }
      return { ok, evidence: out.join('; ') };
    }, { severity: 'high' });

    await t.check('authz.invitations', 'Invitations can only be accepted by the invited account, and not after decline, revocation or expiry', async () => {
      const v2 = await createSharedVault(env, A.owner);
      await invite(env, v2, A.owner, A.pending, 'viewer');
      const byOther = await api.post(`/invitations/${v2.vaultId}/accept`, {}, { token: A.unrelated.token });
      const decline = await api.post(`/invitations/${v2.vaultId}/decline`, {}, { token: A.pending.token });
      const afterDecline = await api.post(`/invitations/${v2.vaultId}/accept`, {}, { token: A.pending.token });
      const revokedAccept = await api.post(`/invitations/${S.vaultId}/accept`, {}, { token: A.revoked.token });
      const expiredAccept = await api.post(`/invitations/${S.vaultId}/accept`, {}, { token: A.expired.token });
      return {
        ok: byOther.status === 404 && decline.status === 204 && afterDecline.status === 404 && revokedAccept.status === 404 && expiredAccept.status >= 403 && expiredAccept.status <= 404,
        evidence: `other account accepts → ${brief(byOther)}; decline → ${brief(decline)}; accept after decline → ${brief(afterDecline)}; revoked member re-accepts → ${brief(revokedAccept)}; expired member accepts → ${brief(expiredAccept)}`,
      };
    }, { severity: 'high' });

    await t.check('authz.editor-escalation', 'Editors cannot grant owner, change roles, or invite when resharing is disabled', async () => {
      const ownerGrant = await api.post(`/vaults/${S.vaultId}/members`, inviteBody(S, A.editor, spare2, 'owner'), { token: A.editor.token });
      const selfPromote = await api.patch(`/vaults/${S.vaultId}/members/${A.editor.userId}`, { role: 'owner' }, { token: A.editor.token });
      const v3 = await createSharedVault(env, A.owner, true);
      await invite(env, v3, A.owner, A.editor, 'editor');
      await accept(env, v3, A.editor);
      const reshareOwner = await api.post(`/vaults/${v3.vaultId}/members`, inviteBody(v3, A.editor, spare2, 'owner'), { token: A.editor.token });
      const reshareEditor = await api.post(`/vaults/${v3.vaultId}/members`, inviteBody(v3, A.editor, spare2, 'editor'), { token: A.editor.token });
      return {
        ok: ownerGrant.status === 403 && selfPromote.status === 403 && reshareOwner.status === 403 && reshareEditor.status === 201,
        evidence: `grant owner (resharing off) → ${brief(ownerGrant)}; self-promote → ${brief(selfPromote)}; with resharing on: grant owner → ${brief(reshareOwner)}, grant editor → ${brief(reshareEditor)} (allowed by design)`,
      };
    }, { severity: 'critical' });

    await t.check('authz.sessions-devices', "Users cannot list, revoke or forget other users' sessions and devices", async () => {
      const sessions = await api.get('/sessions', { token: A.owner.token });
      const ownerSession = (sessions.body as Array<{ id: string; current: boolean }>).find((s) => s.current)!;
      const revoke = await api.del(`/sessions/${ownerSession.id}`, undefined, { token: A.unrelated.token });
      const forget = await api.del(`/devices/${A.owner.deviceId}`, undefined, { token: A.unrelated.token });
      const untrust = await api.del(`/devices/${A.owner.deviceId}/trust`, undefined, { token: A.unrelated.token });
      const stillOk = await api.get('/account', { token: A.owner.token });
      const theirList = await api.get('/sessions', { token: A.unrelated.token });
      const leaks = JSON.stringify(theirList.body).includes(ownerSession.id);
      return {
        ok: revoke.status === 404 && forget.status === 404 && untrust.status === 404 && stillOk.status === 200 && !leaks,
        evidence: `revoke other's session → ${brief(revoke)}; forget other's device → ${brief(forget)}; untrust → ${brief(untrust)}; owner still signed in → ${brief(stillOk)}; other's session listed to outsider: ${leaks}`,
      };
    }, { severity: 'critical' });

    await t.check('authz.sync-isolation', 'Sync returns only vaults and records of live memberships (no revoked, expired, pending or foreign data)', async () => {
      const out: string[] = [];
      let ok = true;
      for (const role of ['pending', 'revoked', 'expired', 'unrelated'] as Role[]) {
        const s = await api.get('/sync', { token: A[role].token, query: { cursor: '0' } });
        const vaults = (s.body.vaults as Array<{ vaultId: string }>).map((v) => v.vaultId);
        const recs = (s.body.records as Array<{ vaultId: string }>).filter((r) => r.vaultId === S.vaultId).length;
        out.push(`${role}: vault listed=${vaults.includes(S.vaultId)}, S records=${recs}`);
        ok &&= !vaults.includes(S.vaultId) && recs === 0;
      }
      const ed = await api.get('/sync', { token: A.editor.token, query: { cursor: '0' } });
      const edRecs = (ed.body.records as Array<{ vaultId: string }>).filter((r) => r.vaultId === S.vaultId).length;
      out.push(`editor (control): S records=${edRecs}`);
      return { ok: ok && edRecs > 0, evidence: out.join('; ') };
    }, { severity: 'critical' });

    await t.check('authz.pagination', 'Cursor manipulation cannot page into other vaults', async () => {
      const r = await api.get(`/vaults/${S.vaultId}/records`, { token: A.unrelated.token, query: { cursor: '0', limit: 500 } });
      const neg = await api.get('/sync', { token: A.unrelated.token, query: { cursor: '-1' } });
      const huge = await api.get('/sync', { token: A.unrelated.token, query: { cursor: '9'.repeat(40) } });
      const sqli = await api.get('/sync', { token: A.unrelated.token, query: { cursor: "0 OR 1=1" } });
      return { ok: r.status === 404 && neg.status === 400 && huge.status === 400 && sqli.status === 400, evidence: `foreign vault page → ${brief(r)}; cursor -1 → ${brief(neg)}; 40-digit cursor → ${brief(huge)}; "0 OR 1=1" → ${brief(sqli)}` };
    }, { severity: 'high' });

    await t.check('authz.lookup.public-fields-only', 'User lookup returns only public identity fields', async () => {
      const r = await api.get('/users/lookup', { token: A.unrelated.token, query: { email: A.owner.email } });
      const keys = Object.keys(r.body ?? {}).sort();
      const allowed = ['email', 'name', 'publicEncryptionKey', 'publicKeySignature', 'publicSigningKey', 'userId'];
      return { ok: r.status === 200 && keys.every((k) => allowed.includes(k)), evidence: `fields: ${keys.join(', ')}` };
    }, { severity: 'high' });

    await t.check('authz.audit-isolation', "Audit events of other users' vaults are not visible", async () => {
      const r = await api.get('/audit-events', { token: A.unrelated.token, query: { limit: 500 } });
      const foreign = (r.body.data as Array<{ vaultId: string | null; actorUserId: string | null }>).filter((e) => e.vaultId === S.vaultId || (e.actorUserId && e.actorUserId !== A.unrelated.userId));
      return { ok: r.status === 200 && foreign.length === 0, evidence: `${r.body.data.length} events for the outsider; ${foreign.length} about other users or vault S` };
    }, { severity: 'high' });

    await t.check('authz.revocation-race', 'Writes racing a revocation are either applied before it or refused; none land afterwards', async () => {
      const victim = await newActor(env, 'authz-race');
      const v = await createSharedVault(env, A.owner);
      await invite(env, v, A.owner, victim, 'editor');
      await accept(env, v, victim);
      const rec = await createRecord(env, A.owner, v.vaultId, v.vaultKey, { title: 'race' });
      // 12 updates from the victim (each with its own mutation id and the base revision it saw), racing the removal.
      const updates = Array.from({ length: 12 }, () => api.put(`/records/${rec.id}`, updateBody(v.vaultId, v.vaultKey, rec.id, rec.revision), { token: victim.token }));
      const removal = api.del(`/vaults/${v.vaultId}/members/${victim.userId}`, undefined, { token: A.owner.token });
      const [rm, ...rs] = await Promise.all([removal, ...updates]);
      const okUpdates = rs.filter((r) => r.status === 200).length;
      const after = await api.put(`/records/${rec.id}`, updateBody(v.vaultId, v.vaultKey, rec.id, rec.revision + okUpdates), { token: victim.token });
      const final = await api.get(`/records/${rec.id}`, { token: A.owner.token });
      const codes = [...new Set(rs.map((r) => r.status))].sort().join('/');
      return {
        ok: rm.status === 204 && after.status === 404 && final.body.revision === rec.revision + okUpdates && okUpdates <= 1,
        evidence: `removal → ${brief(rm)}; concurrent updates: ${okUpdates} applied (codes ${codes}; same base revision so at most one can win); update after removal → ${brief(after)}; final revision ${final.body.revision}`,
      };
    }, { severity: 'high' });
  },
};

export default suite;
