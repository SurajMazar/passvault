import { ApiClient } from '@passvault/api-client';
import type { RecordDto, VaultMembershipDto } from '@passvault/types';

/**
 * Minimal in-memory implementation of the record/sync endpoints with the same
 * revision, idempotency, tombstone and sequence semantics as the real API.
 * Used to test the sync engine deterministically.
 */
export class FakeServer {
  seq = 0n;
  records = new Map<string, RecordDto>();
  mutations = new Map<string, { status: number; body: unknown }>();
  vaults: VaultMembershipDto[] = [];
  online = true;
  /** apply the next request but drop the response (simulates a lost reply) */
  dropNextResponse = false;

  vault(id: string): VaultMembershipDto {
    const v: VaultMembershipDto = {
      vaultId: id,
      type: 'personal',
      kind: null,
      role: 'owner',
      status: 'accepted',
      keyVersion: 1,
      encryptedVaultKey: 'x',
      keySignature: null,
      grantedBy: null,
      allowResharing: false,
      expiresAt: null,
      rotationRequired: false,
      memberCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.vaults.push(v);
    return v;
  }

  private next() {
    this.seq += 1n;
    return this.seq.toString();
  }

  private json(status: number, body: unknown) {
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  private conflict(current: RecordDto) {
    return { status: 409, body: { error: { code: 'revision_conflict', message: 'conflict', details: { current } } } };
  }

  /** Server-side edit by "another device". */
  remoteEdit(id: string, payload: string) {
    const r = this.records.get(id)!;
    this.records.set(id, { ...r, revision: r.revision + 1, encryptedPayload: payload, seq: this.next(), updatedAt: new Date().toISOString() });
  }

  remoteDelete(id: string) {
    const r = this.records.get(id)!;
    this.records.set(id, { ...r, revision: r.revision + 1, encryptedPayload: null, encryptedKey: null, deletedAt: new Date().toISOString(), seq: this.next() });
  }

  handle(method: string, url: URL, body: any): { status: number; body: unknown } {
    const path = url.pathname.replace('/api/v1', '');
    if (body?.mutationId && this.mutations.has(body.mutationId)) return this.mutations.get(body.mutationId)!;
    let res: { status: number; body: unknown };
    const now = new Date().toISOString();
    if (method === 'GET' && path === '/sync') {
      const cursor = BigInt(url.searchParams.get('cursor') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? 500);
      const allowed = new Set(this.vaults.map((v) => v.vaultId));
      const rows = [...this.records.values()].filter((r) => BigInt(r.seq) > cursor && allowed.has(r.vaultId)).sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq)));
      const page = rows.slice(0, limit);
      return {
        status: 200,
        body: {
          cursor: page.length ? page[page.length - 1]!.seq : cursor.toString(),
          hasMore: rows.length > limit,
          vaults: this.vaults,
          records: page,
          resyncVaults: [],
          settingsRevision: 0,
          pendingInvitations: 0,
          serverTime: now,
        },
      };
    }
    if (method === 'POST' && path === '/records') {
      if (this.records.has(body.id)) res = { status: 409, body: { error: { code: 'already_exists', message: 'exists' } } };
      else {
        const r: RecordDto = {
          id: body.id,
          vaultId: body.vaultId,
          kind: body.kind,
          revision: 1,
          formatVersion: body.formatVersion,
          encryptedKey: body.encryptedKey,
          encryptedPayload: body.encryptedPayload,
          size: 1,
          createdAt: now,
          updatedAt: now,
          createdBy: 'u',
          updatedBy: 'u',
          deletedAt: null,
          seq: this.next(),
        };
        this.records.set(r.id, r);
        res = { status: 201, body: r };
      }
    } else if ((method === 'PUT' || method === 'DELETE') && path.startsWith('/records/')) {
      const id = path.split('/')[2]!;
      const cur = this.records.get(id);
      if (!cur) res = { status: 404, body: { error: { code: 'not_found', message: 'nf' } } };
      else if (cur.deletedAt) res = { status: 410, body: { error: { code: 'gone', message: 'deleted' } } };
      else if (cur.revision !== body.baseRevision) res = this.conflict(cur);
      else if (method === 'PUT') {
        const r = { ...cur, revision: cur.revision + 1, encryptedKey: body.encryptedKey, encryptedPayload: body.encryptedPayload, vaultId: body.vaultId ?? cur.vaultId, seq: this.next(), updatedAt: now };
        this.records.set(id, r);
        res = { status: 200, body: r };
      } else {
        const r = { ...cur, revision: cur.revision + 1, encryptedKey: null, encryptedPayload: null, deletedAt: now, seq: this.next(), updatedAt: now };
        this.records.set(id, r);
        res = { status: 200, body: r };
      }
    } else {
      res = { status: 404, body: { error: { code: 'not_found', message: path } } };
    }
    if (body?.mutationId) this.mutations.set(body.mutationId, res);
    return res;
  }

  client(): ApiClient {
    return new ApiClient({
      baseUrl: 'http://fake',
      getToken: () => 't',
      fetchImpl: (async (input: string, init: RequestInit) => {
        if (!this.online) throw new TypeError('fetch failed');
        const url = new URL(input);
        const res = this.handle(init.method ?? 'GET', url, init.body ? JSON.parse(String(init.body)) : undefined);
        if (this.dropNextResponse) {
          this.dropNextResponse = false;
          throw new TypeError('connection reset');
        }
        return this.json(res.status, res.body);
      }) as typeof fetch,
    });
  }
}
