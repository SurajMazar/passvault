import { describe, expect, it, vi } from 'vitest';
import type { ItemPayload } from '@passvault/types';
import type { DecryptedItem } from '@passvault/vault-core';
import { persistTrustedHostKey } from '../src/ssh/host-keys';
import { ED_KEY, server, trusted } from './items';

function fakeSession(items: DecryptedItem[]) {
  const updateItem = vi.fn(async (id: string, mutate: (p: ItemPayload) => ItemPayload | void) => {
    const it = items.find((i) => i.id === id)!;
    const copy = structuredClone(it.payload);
    it.payload = mutate(copy) ?? copy;
  });
  return { getSnapshot: () => ({ items }), updateItem };
}

const ev = (hostPort: string, status: 'unknown' | 'mismatch' = 'unknown') => ({ keyType: 'ssh-ed25519', publicKey: ED_KEY, fingerprint: 'SHA256:abc', hostPort, status });

describe('host-key trust persistence', () => {
  it('saves keyType, publicKey, fingerprint, hostPort and trustedAt into fields.hostKeys', async () => {
    const s = server({ host: 'h.example.com', port: 2222 });
    const sess = fakeSession([s]);
    const r = await persistTrustedHostKey(sess, s.id, ev('h.example.com:2222'), new Map(), new Date('2026-10-08T00:00:00Z'));
    expect(r).toEqual({ saved: true });
    expect(sess.updateItem).toHaveBeenCalledTimes(1);
    expect((s.payload as ItemPayload<'ssh_connection'>).fields.hostKeys).toEqual([
      { keyType: 'ssh-ed25519', publicKey: ED_KEY, fingerprint: 'SHA256:abc', hostPort: 'h.example.com:2222', trustedAt: '2026-10-08T00:00:00.000Z' },
    ]);
  });

  it('never persists a mismatch', async () => {
    const s = server({ host: 'h', hostKeys: [trusted('h:22', 'OLD')] });
    const sess = fakeSession([s]);
    await expect(persistTrustedHostKey(sess, s.id, ev('h:22', 'mismatch'), new Map())).rejects.toThrow(/never trusted automatically/);
    expect(sess.updateItem).not.toHaveBeenCalled();
    expect((s.payload as ItemPayload<'ssh_connection'>).fields.hostKeys).toHaveLength(1);
  });

  it('refuses a key presented for a different host:port than the item', async () => {
    const s = server({ host: 'h' });
    const sess = fakeSession([s]);
    await expect(persistTrustedHostKey(sess, s.id, ev('evil:22'), new Map())).rejects.toThrow();
    expect(sess.updateItem).not.toHaveBeenCalled();
  });

  it('viewers get session-only trust and a note; the item is not modified', async () => {
    const s = server({ host: 'h' }, { role: 'viewer' });
    const sess = fakeSession([s]);
    const trust = new Map();
    const r = await persistTrustedHostKey(sess, s.id, ev('h:22'), trust);
    expect(r.saved).toBe(false);
    expect(r.saved === false && r.reason).toMatch(/view-only/);
    expect(sess.updateItem).not.toHaveBeenCalled();
    expect(trust.get(s.id)).toHaveLength(1);
  });

  it('does not duplicate an already trusted key', async () => {
    const s = server({ host: 'h', hostKeys: [trusted('h:22')] });
    const sess = fakeSession([s]);
    await persistTrustedHostKey(sess, s.id, ev('h:22'), new Map());
    expect(sess.updateItem).not.toHaveBeenCalled();
  });

  it('a failed save falls back to session trust', async () => {
    const s = server({ host: 'h' });
    const sess = { getSnapshot: () => ({ items: [s] }), updateItem: vi.fn(async () => Promise.reject(new Error('offline'))) };
    const trust = new Map();
    const r = await persistTrustedHostKey(sess, s.id, ev('h:22'), trust);
    expect(r.saved).toBe(false);
    expect(trust.get(s.id)).toHaveLength(1);
  });
});
