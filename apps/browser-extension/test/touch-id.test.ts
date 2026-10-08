import { describe, expect, it } from 'vitest';
import { createTouchIdAdapter, touchIdAccount, TOUCH_ID_HOST } from '../src/background/touch-id';
import type { ChromeLike } from '../src/background/chrome-api';

function chromeWith(opts: { native?: (app: string, msg: object) => Promise<unknown>; granted?: boolean }) {
  return {
    runtime: { id: 'x', getURL: (p: string) => p, getManifest: () => ({ version: '0' }), sendMessage: async () => null, ...(opts.native ? { sendNativeMessage: opts.native } : {}) },
    permissions: { contains: async () => opts.granted ?? true },
  } as unknown as ChromeLike;
}

describe('Touch ID adapter', () => {
  it('talks to PassVault’s host directly when the worker has native messaging', async () => {
    const seen: Array<[string, object]> = [];
    const a = createTouchIdAdapter(chromeWith({ native: async (app, msg) => (seen.push([app, msg]), { ok: true, available: true }) }), 'srv');
    expect(await a.status()).toEqual({ available: true, reason: undefined });
    expect(seen).toEqual([[TOUCH_ID_HOST, { op: 'status' }]]);
  });

  it('relays through the popup when the worker started before the permission was granted', async () => {
    const relayed: object[] = [];
    const a = createTouchIdAdapter(chromeWith({}), 'srv', async (msg) => (relayed.push(msg), { ok: true, secretB64: btoa('\x01\x02') }));
    expect(await a.retrieveKey('acct', 'ignored')).toEqual(new Uint8Array([1, 2]));
    expect(relayed).toEqual([{ op: 'unlock', account: touchIdAccount('srv', 'acct'), reason: 'ignored' }]);
  });

  it('reports a cancelled fingerprint and missing permission honestly', async () => {
    const denied = createTouchIdAdapter(chromeWith({ native: async () => ({ ok: false, code: 'denied' }) }), undefined);
    await expect(denied.retrieveKey('a', 'r')).rejects.toThrow('Touch ID was cancelled or did not match');
    const off = createTouchIdAdapter(chromeWith({ native: async () => ({ ok: true }), granted: false }), undefined);
    expect((await off.status()).available).toBe(false);
  });
});
