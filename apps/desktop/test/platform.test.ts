import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopClipboard } from '../src/platform/clipboard';
import { biometricAccount, createDesktopPlatform, helperFiles, helperTokenStorage } from '../src/platform/desktop-platform';
import { cachePrefix, neutralinoKV, prefKey, STORAGE_KEY_RE } from '../src/platform/storage';
import type { NeutralinoLike } from '../src/neutralino';
import { readyHelper } from './fakes';

afterEach(() => vi.useRealTimers());

function fakeNl(overrides: Partial<NeutralinoLike> = {}): NeutralinoLike {
  const store = new Map<string, string>();
  let clip = '';
  return {
    events: { on: async () => undefined, off: async () => undefined },
    extensions: { dispatch: async () => undefined, getStats: async () => ({ loaded: [], connected: [] }) },
    app: { exit: async () => undefined },
    window: {
      show: async () => undefined,
      focus: async () => undefined,
      unminimize: async () => undefined,
      setMainMenu: async () => undefined,
      hide: async () => undefined,
      isVisible: async () => true,
      getSize: async () => ({ width: 1240, height: 820 }),
      setSize: async () => undefined,
      getPosition: async () => ({ x: 0, y: 0 }),
      move: async () => undefined,
      setAlwaysOnTop: async () => undefined,
      beginDrag: async () => undefined,
    },
    os: { showOpenDialog: async () => [], showSaveDialog: async () => '', setTray: async () => undefined },
    storage: {
      getData: async (k) => {
        if (!store.has(k)) throw { code: 'NE_ST_NOSTKEX', message: 'no key' };
        return store.get(k)!;
      },
      setData: async (k, v) => void store.set(k, v ?? ''),
      removeData: async (k) => void store.delete(k),
      getKeys: async () => [...store.keys()],
    },
    clipboard: { readText: async () => clip, writeText: async (t) => void (clip = t) },
    ...overrides,
  };
}

describe('clipboard auto-clear', () => {
  it('clears after the timeout only if the clipboard still holds the secret', async () => {
    vi.useFakeTimers();
    let clip = '';
    const backend = { readText: vi.fn(async () => clip), writeText: vi.fn(async (t: string) => void (clip = t)) };
    const c = new DesktopClipboard(backend);
    await c.copySecret('s3cret', 30);
    expect(clip).toBe('s3cret');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clip).toBe('');

    await c.copySecret('s3cret', 30);
    clip = 'user copied something else';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clip).toBe('user copied something else');
  });

  it('a newer copy cancels the older pending clear; copyText never schedules one', async () => {
    vi.useFakeTimers();
    let clip = '';
    const backend = { readText: async () => clip, writeText: async (t: string) => void (clip = t) };
    const c = new DesktopClipboard(backend);
    await c.copySecret('first', 10);
    await vi.advanceTimersByTimeAsync(5_000);
    await c.copyText('plain');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(clip).toBe('plain');
    await c.copySecret('second', 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clip).toBe('second');
    await expect(c.clearIfUnchanged()).resolves.toBe(true);
    expect(clip).toBe('');
  });
});

describe('storage keys', () => {
  it('cache and pref keys match Neutralino’s key pattern', () => {
    for (const scope of ['alice@example.com', 'ÜNICODE+tag@sub.example.co.uk', 'x'.repeat(300)]) {
      const p = cachePrefix(scope);
      for (const suffix of ['account', 'meta', 'records', 'vaults', 'outbox']) expect(`${p}_${suffix}`).toMatch(STORAGE_KEY_RE);
    }
    expect(cachePrefix('A@x.com')).toBe(cachePrefix('a@x.com'));
    expect(cachePrefix('a@x.com')).not.toBe(cachePrefix('b@x.com'));
    for (const k of ['deviceId', 'lastEmail', 'trustedDeviceToken', 'weird key/../x', 'k'.repeat(80)]) expect(prefKey(k)).toMatch(STORAGE_KEY_RE);
  });

  it('missing keys read as null; other errors propagate', async () => {
    const kv = neutralinoKV(fakeNl());
    await expect(kv.get('pvp_x')).resolves.toBeNull();
    await kv.set('pvp_x', 'v');
    await expect(kv.get('pvp_x')).resolves.toBe('v');
    await kv.remove('pvp_x');
    await expect(kv.remove('pvp_x')).resolves.toBeUndefined();
    await expect(kv.get('bad key!')).rejects.toThrow();
  });

  it('cache store round-trips through Neutralino storage', async () => {
    const { h } = await readyHelper();
    const p = createDesktopPlatform({ nl: fakeNl(), helper: h, apiBaseUrl: 'http://x', webAppUrl: 'http://y', deviceName: 'PassVault on macOS', clipboard: new DesktopClipboard({ readText: async () => '', writeText: async () => undefined }), confirmLink: async () => false });
    expect(p.clientType).toBe('desktop');
    const store = p.createCacheStore('alice@example.com');
    await store.setMeta('k', { a: 1 });
    await expect(p.createCacheStore('alice@example.com').getMeta('k')).resolves.toEqual({ a: 1 });
  });
});

describe('session token in the Keychain', () => {
  it('uses keychain.get/set/delete on pv.session; not_found → null', async () => {
    const { t, h } = await readyHelper();
    const tokens = helperTokenStorage(h, 10);
    const g = tokens.get();
    await Promise.resolve();
    t.error(t.last('keychain.get')!, 'not_found');
    await expect(g).resolves.toBeNull();
    const s = tokens.set('tok-123');
    await Promise.resolve();
    expect(t.last('keychain.set')!.params).toEqual({ account: 'pv.session', secretB64: btoa('tok-123'), biometric: false });
    t.reply(t.last('keychain.set')!, {});
    await s;
    const c = tokens.clear();
    await Promise.resolve();
    t.error(t.last('keychain.delete')!, 'not_found');
    await expect(c).resolves.toBeUndefined();
  });

  it('biometric accounts are valid keychain account names', () => {
    expect(biometricAccount('3F2504E0-4F89-11D3-9A0C-0305E82C3301')).toMatch(/^pv\.[a-z0-9._-]{1,64}$/);
    expect(biometricAccount('x'.repeat(200))).toMatch(/^pv\.[a-z0-9._-]{1,64}$/);
  });
});

describe('file export', () => {
  it('writes owner-only and overwrites only after the save panel confirmed replacing', async () => {
    const { t, h } = await readyHelper();
    const files = helperFiles(fakeNl({ os: { showOpenDialog: async () => [], showSaveDialog: async () => '/Users/me/export.json', setTray: async () => undefined } }), h);
    const p = files.saveTextFile({ suggestedName: 'export.json', text: 'secret data' });
    await new Promise((r) => setTimeout(r, 0));
    const first = t.last('fs.writeExport')!;
    expect(first.params).toMatchObject({ path: '/Users/me/export.json', overwrite: false });
    t.error(first, 'denied', 'file exists; set overwrite to replace it');
    await new Promise((r) => setTimeout(r, 0));
    const second = t.last('fs.writeExport')!;
    expect(second).not.toBe(first);
    expect(second.params).toMatchObject({ overwrite: true });
    t.reply(second, { path: '/Users/me/export.json', mode: '0600' });
    await expect(p).resolves.toEqual({ saved: true, location: '/Users/me/export.json', ownerOnly: true });
  });

  it('other write errors are not retried with overwrite', async () => {
    const { t, h } = await readyHelper();
    const files = helperFiles(fakeNl({ os: { showOpenDialog: async () => [], showSaveDialog: async () => '/x/link', setTray: async () => undefined } }), h);
    const p = files.saveTextFile({ suggestedName: 'a', text: 'b' });
    await new Promise((r) => setTimeout(r, 0));
    t.error(t.last('fs.writeExport')!, 'denied', 'target is a symlink');
    await expect(p).rejects.toMatchObject({ code: 'denied' });
    expect(t.ops().filter((o) => o === 'fs.writeExport')).toHaveLength(1);
  });

  it('a cancelled save dialog writes nothing', async () => {
    const { t, h } = await readyHelper();
    const files = helperFiles(fakeNl(), h);
    await expect(files.saveTextFile({ suggestedName: 'a', text: 'b' })).resolves.toEqual({ saved: false });
    expect(t.ops()).not.toContain('fs.writeExport');
  });
});

describe('external links (PV-SEC-002)', () => {
  it('opens confirmed http(s) links through the helper, never through a webview native API', async () => {
    const { t, h } = await readyHelper();
    let confirmed = 0;
    const p = createDesktopPlatform({ nl: fakeNl(), helper: h, apiBaseUrl: 'http://x', webAppUrl: 'http://y', deviceName: 'd', clipboard: new DesktopClipboard({ readText: async () => '', writeText: async () => undefined }), confirmLink: async () => (confirmed++, true) });
    const opened = p.openExternal('https://example.com/a?b=$(id)');
    await new Promise((r) => setTimeout(r, 0));
    const req = t.last('link.open')!;
    expect(req.params).toEqual({ url: 'https://example.com/a?b=%24(id)' });
    t.reply(req, null);
    await opened;
    expect(confirmed).toBe(1);
    await expect(p.openExternal('file:///etc/passwd')).rejects.toThrow(/Only http/);
    expect(t.ops().filter((o) => o === 'link.open')).toHaveLength(1);
  });

  it('the webview native allowlist has no shell-backed or unused APIs', async () => {
    const { readFileSync } = await import('node:fs');
    const cfg = JSON.parse(readFileSync(new URL('../neutralino.config.json', import.meta.url), 'utf8')) as { nativeAllowList: string[] };
    for (const banned of ['os.open', 'os.execCommand', 'os.spawnProcess', 'os.showMessageBox', 'computer.getOSInfo']) {
      expect(cfg.nativeAllowList).not.toContain(banned);
    }
    // The helper (an extension) answers the UI through app.broadcast; removing it breaks every helper call.
    expect(cfg.nativeAllowList).toContain('app.broadcast');
    expect(cfg.nativeAllowList).toContain('extensions.dispatch');
    expect(cfg.nativeAllowList.some((a) => a.startsWith('filesystem.'))).toBe(false);
  });
});
