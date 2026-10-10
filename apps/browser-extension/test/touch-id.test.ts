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

describe('Touch ID host errors tell the user what to do', () => {
  it('distinguishes a Mac app that does not know this extension from a missing setup', async () => {
    const { hostErrorMessage } = await import('../src/background/touch-id');
    expect(hostErrorMessage('Access to the specified native messaging host is forbidden.')).toMatch(/Update PassVault for Mac/);
    expect(hostErrorMessage('Specified native messaging host not found.')).toMatch(/Settings → Browser extension/);
  });
});

describe('Touch ID unlock end to end (fake host)', () => {
  it('is offered on the lock screen and unlocks the vault, however the lock-time check went', async () => {
    const { VaultSession } = await import('@passvault/vault-core');
    const { BackgroundController } = await import('../src/background/controller');
    const { createExtensionPlatform } = await import('../src/background/platform');
    const { MASTER, offlineDevice, senders, unwrap } = await import('./helpers');
    const dev = await offlineDevice();
    const chrome = dev.fc.chrome as ChromeLike;
    // A host that seals by account, like pv-touchid (the fingerprint always matches here).
    const sealed = new Map<string, string>();
    let hostUp = true;
    chrome.permissions = { contains: async () => true };
    chrome.runtime.sendNativeMessage = async (_app: string, msg: object) => {
      if (!hostUp) throw new Error('Specified native messaging host not found.');
      const m = msg as { op: string; account?: string; secretB64?: string };
      if (m.op === 'status') return { ok: true, available: true };
      if (m.op === 'enroll') return sealed.set(m.account!, m.secretB64!), { ok: true };
      if (m.op === 'unlock') return sealed.has(m.account!) ? { ok: true, secretB64: sealed.get(m.account!) } : { ok: false, code: 'not_found' };
      return { ok: true };
    };
    const platform = createExtensionPlatform(chrome, { apiBaseUrl: 'http://127.0.0.1:9', webAppUrl: 'http://localhost:5173', createCacheStore: () => dev.store, deviceName: 't' });
    const session = new VaultSession(platform);
    const controller = new BackgroundController({ chrome, session, webUrl: 'http://localhost:5173', touchIdStatus: () => platform.biometrics!.status() });
    await controller.ready;
    const popup = (m: unknown) => controller.handleMessage(m, senders.popup);
    await popup({ type: 'auth.unlock', password: MASTER });
    expect(unwrap<{ enabled: boolean }>(await popup({ type: 'touchid.set', enabled: true })).enabled).toBe(true);

    hostUp = false; // the background cannot reach the host when the vault locks...
    await popup({ type: 'auth.lock' });
    await new Promise((r) => setTimeout(r, 50));
    expect(unwrap<{ biometricAvailable?: boolean }>(await popup({ type: 'state.get' })).biometricAvailable).toBe(false);

    hostUp = true; // ...but by the time the popup opens it can, and the lock screen asks itself
    expect(unwrap<{ enabled: boolean; available: boolean }>(await popup({ type: 'touchid.status' }))).toMatchObject({ enabled: true, available: true });
    expect(unwrap<{ phase: string }>(await popup({ type: 'auth.unlockBiometric' })).phase).toBe('unlocked');
    session.lock();
  });
});
