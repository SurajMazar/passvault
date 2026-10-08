import { describe, expect, it } from 'vitest';
import {
  CLIENT_API_VERSION,
  InvalidServerUrlError,
  activeProfile,
  checkServer,
  connectProfile,
  initialProfiles,
  normalizeServerUrl,
  parseProfiles,
  removeProfile,
  renameProfile,
  serverLabel,
  serverOrigin,
  setLocalDev,
  switchProfile,
  type ServerProfiles,
} from '../src/servers';

const scope = (u: string) => `s:${u}`;
const ctx = { scope, now: 1000 };

describe('normalizeServerUrl', () => {
  it('canonicalises https addresses and keeps a path prefix', () => {
    expect(normalizeServerUrl('vault.example.com')).toBe('https://vault.example.com');
    expect(normalizeServerUrl(' https://Vault.Example.com:8443/ ')).toBe('https://vault.example.com:8443');
    expect(normalizeServerUrl('https://example.com/passvault/')).toBe('https://example.com/passvault');
    expect(normalizeServerUrl('https://example.com//team//vault')).toBe('https://example.com/team/vault');
    expect(normalizeServerUrl('https://example.com/Team-Vault')).toBe('https://example.com/Team-Vault');
  });

  it('reduces a pasted API URL to the server base, prefix included', () => {
    expect(normalizeServerUrl('https://vault.example.com/api/v1')).toBe('https://vault.example.com');
    expect(normalizeServerUrl('https://example.com/passvault/api/v1/')).toBe('https://example.com/passvault');
    expect(normalizeServerUrl('https://example.com/passvault/api')).toBe('https://example.com/passvault');
  });

  it('rejects credentials, queries, fragments and other schemes', () => {
    for (const bad of ['https://user:pw@vault.example.com', 'https://vault.example.com/?x=1', 'https://vault.example.com/#a', 'https://vault.example.com?', 'ftp://vault.example.com', 'javascript:alert(1)', '', '   ']) {
      expect(() => normalizeServerUrl(bad), bad).toThrow(InvalidServerUrlError);
    }
  });

  it('allows http only for loopback and only with the local-development setting', () => {
    expect(() => normalizeServerUrl('http://localhost:3000')).toThrow(/Local development/);
    expect(normalizeServerUrl('http://localhost:3000', { allowLocalHttp: true })).toBe('http://localhost:3000');
    expect(normalizeServerUrl('http://127.0.0.1:3000/pv', { allowLocalHttp: true })).toBe('http://127.0.0.1:3000/pv');
    expect(normalizeServerUrl('http://[::1]:3000', { allowLocalHttp: true })).toBe('http://[::1]:3000');
    expect(() => normalizeServerUrl('http://vault.example.com', { allowLocalHttp: true })).toThrow(/https/);
    expect(() => normalizeServerUrl('http://192.168.1.10', { allowLocalHttp: true })).toThrow(/https/);
  });

  it('origin and label helpers', () => {
    expect(serverOrigin('https://example.com/passvault')).toBe('https://example.com');
    expect(serverLabel('https://example.com/passvault')).toBe('example.com/passvault');
    expect(serverLabel('https://example.com')).toBe('example.com');
  });
});

describe('checkServer', () => {
  const meta = { service: 'passvault', version: '1.2.3', api: { current: 1, min: 1 }, capabilities: ['vault.e2ee.v1', 'sync.v1', 'auth.mfa.totp'], registration: 'open' };
  const respond =
    (routes: Record<string, { status: number; body: unknown }>, log: Array<{ url: string; init?: RequestInit }> = []): typeof fetch =>
    async (input, init) => {
      log.push({ url: String(input), init });
      const r = routes[new URL(String(input)).pathname] ?? { status: 404, body: { error: { code: 'not_found' } } };
      return new Response(JSON.stringify(r.body), { status: r.status });
    };

  it('accepts a compatible server under a path prefix, sending no credentials', async () => {
    const log: Array<{ url: string; init?: RequestInit }> = [];
    const f = respond({ '/pv/api/v1/meta': { status: 200, body: meta }, '/pv/api/v1/health': { status: 200, body: { status: 'ok' } } }, log);
    const r = await checkServer('https://example.com/pv', { fetchImpl: f });
    expect(r).toEqual({ ok: true, url: 'https://example.com/pv', version: '1.2.3', apiVersion: 1, capabilities: meta.capabilities, registration: 'open', degraded: false });
    expect(log).toHaveLength(2);
    for (const l of log) {
      expect(l.init).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
      expect(JSON.stringify(l.init?.headers)).not.toMatch(/authorization|cookie/i);
    }
  });

  it('reports a degraded server (health 503) as reachable but degraded', async () => {
    const f = respond({ '/api/v1/meta': { status: 200, body: meta }, '/api/v1/health': { status: 503, body: { status: 'degraded', db: 'error' } } });
    expect(await checkServer('https://vault.example.com', { fetchImpl: f })).toMatchObject({ ok: true, degraded: true });
  });

  it('explains every failure without exposing anything', async () => {
    const cases: Array<[typeof fetch, string]> = [
      [respond({}), 'not_passvault'],
      [respond({ '/api/v1/health': { status: 200, body: { status: 'ok', db: 'ok', version: '0.0.9' } } }), 'incompatible'],
      [respond({ '/api/v1/meta': { status: 200, body: { hello: 'world' } } }), 'not_passvault'],
      [respond({ '/api/v1/meta': { status: 502, body: null } }), 'unavailable'],
      [respond({ '/api/v1/meta': { status: 200, body: { ...meta, api: { current: CLIENT_API_VERSION + 1, min: CLIENT_API_VERSION + 1 } } } }), 'incompatible'],
      [respond({ '/api/v1/meta': { status: 200, body: { ...meta, api: { current: 0, min: 0 } } } }), 'incompatible'],
      [respond({ '/api/v1/meta': { status: 200, body: { ...meta, capabilities: ['vault.e2ee.v1'] } } }), 'missing_capabilities'],
      [async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } })), 'tls'],
      [async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'unreachable'],
      [async () => Promise.reject(new TypeError('Load failed')), 'unreachable'],
      [async () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'timeout'],
    ];
    for (const [f, code] of cases) {
      const r = await checkServer('https://vault.example.com', { fetchImpl: f });
      expect(r, code).toMatchObject({ ok: false, code });
      if (!r.ok) expect(r.message.length).toBeGreaterThan(10);
    }
    expect(await checkServer('http://vault.example.com')).toMatchObject({ ok: false, code: 'invalid_url', url: null });
  });

  it('never follows a redirect (redirect: error)', async () => {
    let init: RequestInit | undefined;
    await checkServer('https://vault.example.com', {
      fetchImpl: async (_i, x) => {
        init = x;
        throw new TypeError('redirect');
      },
    });
    expect(init?.redirect).toBe('error');
  });
});

describe('server profiles', () => {
  const base = (): ServerProfiles => initialProfiles('https://work.example.com', ctx);

  it('changing the address creates a new connection and keeps the old one', () => {
    const { state, profile } = connectProfile(base(), 'https://home.example.com/pv', { scope, now: 2000 });
    expect(state.activeId).toBe(profile.id);
    expect(profile).toMatchObject({ url: 'https://home.example.com/pv', name: 'home.example.com/pv', id: 's:https://home.example.com/pv' });
    expect(state.profiles.map((p) => p.url)).toEqual(['https://work.example.com', 'https://home.example.com/pv']);
    const back = switchProfile(state, 's:https://work.example.com', 3000);
    expect(activeProfile(back).url).toBe('https://work.example.com');
    expect(activeProfile(back).lastUsedAt).toBe(3000);
  });

  it('reconnecting to a saved address reuses its profile (and its isolated storage)', () => {
    const a = connectProfile(base(), 'https://home.example.com', ctx).state;
    const b = connectProfile(a, 'HTTPS://HOME.example.com/', ctx).state;
    expect(b.profiles).toHaveLength(2);
  });

  it('rename, remove and local development rules', () => {
    let s = connectProfile(base(), 'https://home.example.com', ctx).state;
    s = renameProfile(s, 's:https://home.example.com', '  Personal  ');
    expect(activeProfile(s).name).toBe('Personal');
    expect(() => renameProfile(s, 's:https://home.example.com', '   ')).toThrow();
    expect(() => removeProfile(s, s.activeId)).toThrow(/Switch to another/);
    s = removeProfile(s, 's:https://work.example.com');
    expect(s.profiles).toHaveLength(1);
    expect(() => connectProfile(s, 'http://localhost:3000', ctx)).toThrow(/Local development/);
    s = setLocalDev(s, true);
    s = connectProfile(s, 'http://localhost:3000', ctx).state;
    expect(activeProfile(s).name).toBe('Local development');
    expect(() => setLocalDev(s, false)).toThrow(/https/);
  });

  it('parses stored profiles defensively', () => {
    const stored = {
      activeId: 'gone',
      localDev: false,
      profiles: [
        { id: 'forged-id', name: 'Work', url: 'https://work.example.com', lastUsedAt: 5, lastCheck: { ok: true, at: 1, version: 'x', extra: 'dropped' } },
        { name: 'Dup', url: 'https://WORK.example.com/' },
        { name: 'Insecure', url: 'http://evil.example.com' },
        { name: 'Local but disabled', url: 'http://localhost:3000' },
        { name: 'Personal', url: 'https://home.example.com', lastUsedAt: 9 },
        null,
        'junk',
      ],
    };
    const p = parseProfiles(stored, ctx)!;
    expect(p.profiles.map((x) => [x.id, x.name])).toEqual([
      ['s:https://work.example.com', 'Work'],
      ['s:https://home.example.com', 'Personal'],
    ]);
    expect(p.activeId).toBe('s:https://home.example.com');
    expect(p.profiles[0]!.lastCheck).toEqual({ ok: true, at: 1, version: 'x' });
    expect(parseProfiles({ profiles: [] }, ctx)).toBeNull();
    expect(parseProfiles('nope', ctx)).toBeNull();
  });
});
