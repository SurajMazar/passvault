import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbStore, MemoryStore, SyncEngine, KeyValueStore } from '../src/index';
import { FakeServer } from './fake-server';

const VAULT = '00000000-0000-4000-8000-000000000001';
const id = (n: number) => `00000000-0000-4000-8000-0000000001${n.toString().padStart(2, '0')}`;

async function setup(store = new MemoryStore()) {
  const server = new FakeServer();
  server.vault(VAULT);
  const engine = new SyncEngine(server.client(), store);
  return { server, store, engine };
}

function create(engine: SyncEngine, recordId: string, payload: string) {
  return engine.enqueue({ recordId, vaultId: VAULT, kind: 'item', op: 'create', baseRevision: null, formatVersion: 1, encryptedKey: 'k', encryptedPayload: payload });
}

describe('sync engine', () => {
  it('pushes creates and pulls them back', async () => {
    const { engine, store, server } = await setup();
    await create(engine, id(1), 'p1');
    await engine.sync();
    expect(server.records.get(id(1))?.encryptedPayload).toBe('p1');
    expect((await store.allRecords()).map((r) => r.id)).toEqual([id(1)]);
    expect(engine.getStatus()).toMatchObject({ state: 'idle', pending: 0 });
  });

  it('keeps edits queued while offline and replays idempotently', async () => {
    const { engine, server } = await setup();
    server.online = false;
    await create(engine, id(2), 'offline-edit');
    await expect(engine.sync()).rejects.toThrow();
    expect(engine.getStatus()).toMatchObject({ state: 'offline', pending: 1 });
    server.online = true;
    // the server applies the request but the response is lost
    server.dropNextResponse = true;
    await expect(engine.sync()).rejects.toThrow();
    await engine.sync(); // retry with the same mutation id must not fail as already_exists
    expect(engine.getStatus()).toMatchObject({ pending: 0, failed: 0 });
    expect(server.records.size).toBe(1);
  });

  it('detects concurrent edits and never overwrites the newer server revision', async () => {
    const { engine, server, store } = await setup();
    await create(engine, id(3), 'v1');
    await engine.sync();
    server.remoteEdit(id(3), 'remote-v2');
    await engine.enqueue({ recordId: id(3), vaultId: VAULT, kind: 'item', op: 'update', baseRevision: 1, formatVersion: 1, encryptedKey: 'k', encryptedPayload: 'local-v2' });
    await engine.sync();
    expect(server.records.get(id(3))?.encryptedPayload).toBe('remote-v2');
    const box = await store.outbox();
    expect(box).toHaveLength(1);
    expect(box[0]).toMatchObject({ status: 'conflict' });
    expect(box[0]!.conflict?.revision).toBe(2);
    expect(engine.getStatus().conflicts).toBe(1);

    // resolve by keeping mine: re-based on the current revision
    await engine.resolveConflict(box[0]!.mutationId, { keep: 'mine', encryptedKey: 'k', encryptedPayload: 'local-v2' });
    await engine.sync();
    expect(server.records.get(id(3))).toMatchObject({ encryptedPayload: 'local-v2', revision: 3 });
  });

  it('keep theirs discards the local edit', async () => {
    const { engine, server, store } = await setup();
    await create(engine, id(4), 'v1');
    await engine.sync();
    server.remoteEdit(id(4), 'remote');
    await engine.enqueue({ recordId: id(4), vaultId: VAULT, kind: 'item', op: 'update', baseRevision: 1, formatVersion: 1, encryptedKey: 'k', encryptedPayload: 'mine' });
    await engine.sync();
    const [c] = await store.outbox();
    await engine.resolveConflict(c!.mutationId, { keep: 'theirs' });
    await engine.sync();
    expect(server.records.get(id(4))?.encryptedPayload).toBe('remote');
    expect(await store.outbox()).toHaveLength(0);
  });

  it('propagates deletions as tombstones and does not resurrect deleted records', async () => {
    const { engine, server, store } = await setup();
    await create(engine, id(5), 'v1');
    await engine.sync();
    server.remoteDelete(id(5));
    // stale local edit based on revision 1
    await engine.enqueue({ recordId: id(5), vaultId: VAULT, kind: 'item', op: 'update', baseRevision: 1, formatVersion: 1, encryptedKey: 'k', encryptedPayload: 'stale' });
    await engine.sync();
    const rec = (await store.allRecords()).find((r) => r.id === id(5))!;
    expect(rec.deletedAt).not.toBeNull();
    expect(rec.encryptedPayload).toBeNull();
    expect(server.records.get(id(5))?.deletedAt).not.toBeNull();
    const [entry] = await store.outbox();
    expect(entry!.status === 'failed' || entry!.status === 'conflict').toBe(true);
  });

  it('chains dependent offline edits on the same record', async () => {
    const { engine, server } = await setup();
    server.online = false;
    const c = await create(engine, id(6), 'v1');
    await engine.enqueue({ recordId: id(6), vaultId: VAULT, kind: 'item', op: 'update', baseRevision: null, afterMutationId: c.mutationId, formatVersion: 1, encryptedKey: 'k', encryptedPayload: 'v2' });
    server.online = true;
    await engine.sync();
    await engine.sync();
    expect(server.records.get(id(6))).toMatchObject({ revision: 2, encryptedPayload: 'v2' });
  });

  it('pushes an edit made right after a create in the same sync (no window for a needless conflict)', async () => {
    const { engine, server } = await setup();
    const c = await create(engine, id(11), 'v1');
    await engine.enqueue({ recordId: id(11), vaultId: VAULT, kind: 'item', op: 'update', baseRevision: null, afterMutationId: c.mutationId, formatVersion: 1, encryptedKey: 'k', encryptedPayload: 'v2' });
    await engine.sync();
    expect(server.records.get(id(11))).toMatchObject({ revision: 2, encryptedPayload: 'v2' });
    expect(engine.getStatus().pending).toBe(0);
    // Another device now edits revision 2: no conflict on either side.
    server.remoteEdit(id(11), 'remote-v3');
    await engine.sync();
    expect(engine.getStatus()).toMatchObject({ pending: 0, conflicts: 0 });
  });

  it('purges cached records of vaults the user lost access to', async () => {
    const { engine, server, store } = await setup();
    const shared = '00000000-0000-4000-8000-000000000099';
    server.vault(shared);
    await engine.enqueue({ recordId: id(7), vaultId: shared, kind: 'item', op: 'create', baseRevision: null, formatVersion: 1, encryptedKey: 'k', encryptedPayload: 's' });
    await engine.sync();
    expect((await store.allRecords()).some((r) => r.vaultId === shared)).toBe(true);
    server.vaults = server.vaults.filter((v) => v.vaultId !== shared);
    const change = await engine.sync();
    expect(change.removedVaults).toEqual([shared]);
    expect((await store.allRecords()).some((r) => r.vaultId === shared)).toBe(false);
  });

  it('pushes edits enqueued while a sync is already running', async () => {
    const { engine, server } = await setup();
    await create(engine, id(9), 'a');
    const first = engine.sync();
    await create(engine, id(10), 'b'); // enqueued mid-run
    const second = engine.sync();
    await Promise.all([first, second]);
    expect(server.records.has(id(9))).toBe(true);
    expect(server.records.has(id(10))).toBe(true);
    expect(engine.getStatus().pending).toBe(0);
  });

  it('works with IndexedDB and key/value stores', async () => {
    for (const store of [new IndexedDbStore('t1'), new KeyValueStore(memKv())]) {
      const { engine } = await setup(store as never);
      await create(engine, id(8), 'x');
      await engine.sync();
      expect((await store.allRecords()).map((r) => r.id)).toEqual([id(8)]);
      await store.clear();
      expect(await store.allRecords()).toEqual([]);
    }
  });
});

function memKv() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    remove: async (k: string) => void m.delete(k),
  };
}
