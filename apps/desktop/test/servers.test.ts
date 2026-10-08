import { describe, expect, it } from 'vitest';
import { cspPolicy } from '../vite.config';
import { DesktopServers, LOCAL_URL, PRODUCTION_URL, PROFILES_KEY, loadProfiles, serverScope, webAppUrlFor, type DesktopServerDeps } from '../src/platform/servers';
import { sessionTokenAccount } from '../src/platform/desktop-platform';
import { cachePrefix, neutralinoPrefs, prefKey, STORAGE_KEY_RE } from '../src/platform/storage';

// vitest.config.ts sets VITE_PRODUCTION_URL=https://vault.example.com for these tests.
const PROD = PRODUCTION_URL!;
const META = { service: 'passvault', version: '9.9.9', api: { current: 1, min: 1 }, capabilities: ['vault.e2ee.v1', 'sync.v1', 'auth.mfa.totp'], registration: 'closed' };

function memKv() {
  const m = new Map<string, string>();
  return { m, get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), remove: async (k: string) => void m.delete(k) };
}

/** fetch serving PassVault at the given bases; anything else fails like a webview does ("Load failed"). */
function servers(bases: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    expect(init?.credentials).toBe('omit');
    const base = bases.find((b) => url.startsWith(`${b}/api/v1/`));
    if (!base) throw new TypeError('Load failed');
    return new Response(JSON.stringify(url.endsWith('/meta') ? META : { status: 'ok', db: 'ok', version: '9.9.9' }), { status: 200 });
  };
}

async function setup(overrides: Partial<DesktopServerDeps> = {}) {
  const kv = memKv();
  const activated: string[] = [];
  const deletedTokens: string[] = [];
  const m = await DesktopServers.load(
    {
      kv,
      listKeys: async () => [...kv.m.keys()],
      deleteToken: async (scope) => void deletedTokens.push(scope),
      appOrigin: 'http://localhost:5174',
      activate: async (url) => void activated.push(url),
      fetchImpl: servers([PROD, 'https://example.com/pv']),
      ...overrides,
    },
    PROD,
    false,
  );
  return { kv, m, activated, deletedTokens };
}

describe('per-server isolation', () => {
  const prod = serverScope(PROD);
  const prefixed = serverScope('https://example.com/pv');

  it('gives each server — path prefix included — its own Keychain account, prefs, and cache namespace', () => {
    expect(prod).not.toBe(prefixed);
    expect(serverScope('https://vault.example.com/')).toBe(prod);
    expect(serverScope('https://example.com/pv/')).toBe(prefixed);
    expect(serverScope('https://example.com')).not.toBe(prefixed);
    for (const acct of [sessionTokenAccount(prod), sessionTokenAccount(prefixed)]) expect(acct).toMatch(/^pv\.[a-z0-9._-]{1,64}$/); // helper keychain account pattern
    expect(sessionTokenAccount(prod)).not.toBe(sessionTokenAccount(prefixed));
    expect(cachePrefix(`${prod}:alice@example.com`)).not.toBe(cachePrefix(`${prefixed}:alice@example.com`));
    for (const k of [cachePrefix(`${prod}:alice@example.com`), prefKey(`${prod}_deviceId`)]) expect(k).toMatch(STORAGE_KEY_RE);
    // every key of a server starts with its scope, so forgetting a server can find them all
    expect(cachePrefix(`${prod}:alice@example.com`).startsWith(`pvc_${prod}_`)).toBe(true);
    expect(prefKey(`${prod}_trustedDeviceToken_for_a_long_account_name`).startsWith(`pvp_${prod}_`)).toBe(true);
  });

  it('keeps prefs separate between servers on the same storage', async () => {
    const kv = memKv();
    await neutralinoPrefs(kv, prod).set('lastEmail', 'alice@example.com');
    expect(await neutralinoPrefs(kv, prefixed).get('lastEmail')).toBeNull();
    expect(await neutralinoPrefs(kv, prod).get('lastEmail')).toBe('alice@example.com');
  });

  it('maps servers to their dashboards', () => {
    expect(webAppUrlFor('http://localhost:3000')).toBe('http://localhost:5173');
    expect(webAppUrlFor('https://example.com/pv/')).toBe('https://example.com/pv');
  });
});

describe('saved servers', () => {
  it('migrates the pre-profiles selection and ignores insecure stored values', async () => {
    const kv = memKv();
    kv.m.set('pvg_server', 'https://self.example.org');
    const s = await loadProfiles(kv, PROD, false);
    expect(s.profiles.map((p) => p.url)).toEqual(['https://self.example.org', PROD]);
    expect(kv.m.has('pvg_server')).toBe(false);
    const evil = memKv();
    evil.m.set('pvg_server', 'http://evil.example.com');
    const e = await loadProfiles(evil, PROD, false);
    expect(e.profiles.find((p) => p.id === e.activeId)!.url).toBe(PROD);
    expect(e.localDev).toBe(false);
  });

  it('changes the address only after a successful check and keeps the previous server', async () => {
    const { m, activated } = await setup();
    await expect(m.connect('https://unknown.example.com')).rejects.toThrow();
    expect(activated).toEqual([]);
    expect(m.activeUrl).toBe(PROD);
    expect(m.profiles.map((p) => p.url)).toEqual([PROD]);
    await m.connect('https://example.com/pv/api/v1');
    expect(activated).toEqual(['https://example.com/pv']);
    expect(m.profiles.map((p) => [p.url, p.active])).toEqual([
      [PROD, false],
      ['https://example.com/pv', true],
    ]);
    await m.switchTo(serverScope(PROD));
    expect(activated).toEqual(['https://example.com/pv', PROD]);
  });

  it('explains a refused certificate or a server that does not allow this app', async () => {
    const tlsBad = await setup({ inspectTls: async () => ({ ok: false, message: 'The server’s certificate is not trusted by this Mac.' }) });
    expect(await tlsBad.m.check('https://unknown.example.com')).toMatchObject({ ok: false, code: 'tls', message: expect.stringContaining('not trusted') });
    const down = await setup({ inspectTls: async () => ({ ok: false, reason: 'unreachable', message: 'Could not open a connection' }) });
    expect(await down.m.check('https://unknown.example.com')).toMatchObject({ ok: false, code: 'unreachable' });
    const cors = await setup({ inspectTls: async () => ({ ok: true, message: 'valid' }) });
    expect(await cors.m.check('https://unknown.example.com')).toMatchObject({ ok: false, code: 'unreachable', message: expect.stringMatching(/add http:\/\/localhost:5174 to CORS_ORIGINS/) });
  });

  it('allows http only on this computer and only with the local-development setting', async () => {
    const { m } = await setup();
    expect(await m.check('http://localhost:3000')).toMatchObject({ ok: false, code: 'invalid_url' });
    await m.setLocalDev(true);
    expect(m.profiles.some((p) => p.url === LOCAL_URL)).toBe(true);
    expect(await m.check('http://vault.example.com')).toMatchObject({ ok: false, code: 'invalid_url' });
  });

  it('forgetting a server removes its token, prefs and cache only', async () => {
    const { kv, m, deletedTokens } = await setup();
    await m.connect('https://example.com/pv');
    const prod = serverScope(PROD);
    const other = serverScope('https://example.com/pv');
    await neutralinoPrefs(kv, prod).set('lastEmail', 'alice@example.com');
    kv.m.set(`${cachePrefix(`${prod}:alice@example.com`)}_records`, 'ciphertext');
    kv.m.set(`${cachePrefix(`${other}:bob@example.com`)}_records`, 'ciphertext');
    await m.refresh();
    expect(m.profiles.find((p) => p.url === PROD)!.account).toBe('alice@example.com');
    await expect(m.remove(other)).rejects.toThrow(/Switch to another/);
    await m.remove(prod);
    expect(deletedTokens).toEqual([prod]);
    expect([...kv.m.keys()].filter((k) => k.includes(prod))).toEqual([]);
    expect([...kv.m.keys()].some((k) => k.startsWith(`pvc_${other}_`))).toBe(true);
    expect(JSON.parse(kv.m.get(PROFILES_KEY)!).profiles).toHaveLength(1);
  });
});

describe('webview CSP', () => {
  it('allows https servers the user chooses, plain http only on this computer, nothing else', () => {
    const p = cspPolicy(5174);
    const connect = /connect-src ([^;]+)/.exec(p)![1]!.split(' ');
    expect(connect).toEqual(["'self'", 'ws://localhost:5174', 'ws://127.0.0.1:5174', 'https:', 'http://localhost:*', 'http://127.0.0.1:*']);
    expect(p).toMatch(/script-src 'self' 'wasm-unsafe-eval';/);
    expect(p).toMatch(/object-src 'none'/);
    expect(p).toMatch(/frame-src 'none'/);
  });
});
