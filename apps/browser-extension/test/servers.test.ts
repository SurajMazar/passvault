import { describe, expect, it } from 'vitest';
import { VaultSession } from '@passvault/vault-core';
import { BackgroundController, type ServerControl } from '../src/background/controller';
import type { ChromeLike } from '../src/background/chrome-api';
import { createExtensionPlatform, tokenKey } from '../src/background/platform';
import {
  PROFILES_KEY,
  SELECTED_SERVER_KEY,
  ServerManager,
  defaultServer,
  forgetServerData,
  loadProfiles,
  migrateLegacyStorage,
  productionUrlFrom,
  serverScope,
  webUrlFor,
} from '../src/background/servers';
import { fakeChrome, senders, unwrap } from './helpers';

const PROD = 'https://vault.example.com';
const META = { service: 'passvault', version: '9.9.9', api: { current: 1, min: 1 }, capabilities: ['vault.e2ee.v1', 'sync.v1', 'auth.mfa.totp'], registration: 'open' };

/** fetch that serves a PassVault server at the given bases (and nothing else). */
function servers(bases: string[], log: string[] = []): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    log.push(url);
    expect(init?.credentials).toBe('omit');
    const base = bases.find((b) => url.startsWith(`${b}/api/v1/`));
    if (!base) throw new TypeError('fetch failed');
    if (url.endsWith('/meta')) return new Response(JSON.stringify(META), { status: 200 });
    if (url.endsWith('/health')) return new Response(JSON.stringify({ status: 'ok', db: 'ok', version: '9.9.9' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
}

function withPermissions(c: ChromeLike, granted: Set<string>): ChromeLike {
  return { ...c, permissions: { contains: async (p) => (p.origins ?? []).every((o) => granted.has(o)) } };
}

describe('server configuration', () => {
  it('takes the production server from the build, never a loopback or non-https address', () => {
    expect(productionUrlFrom('https://vault.example.com/api')).toBe(PROD);
    expect(productionUrlFrom('https://example.com/passvault/api/v1')).toBe('https://example.com/passvault');
    expect(productionUrlFrom('http://localhost:3000')).toBeNull();
    expect(productionUrlFrom('http://vault.example.com')).toBeNull();
    expect(productionUrlFrom('not a url')).toBeNull();
    expect(productionUrlFrom(undefined)).toBeNull();
    expect(defaultServer(PROD)).toBe(PROD);
    expect(defaultServer(null)).toBe('http://localhost:3000');
  });

  it('maps servers to their dashboards', () => {
    expect(webUrlFor('http://localhost:3000', PROD, 'https://app.example.com')).toBe('http://localhost:5173');
    expect(webUrlFor(PROD, PROD, 'https://app.example.com')).toBe('https://app.example.com');
    expect(webUrlFor('https://self.example.org/pv', PROD, 'https://app.example.com')).toBe('https://self.example.org/pv');
  });

  it('gives every server — path prefix included — its own storage namespace', () => {
    expect(serverScope(PROD)).toBe('https_vault_example_com_443');
    expect(serverScope('http://localhost:3000')).toBe('http_localhost_3000');
    expect(serverScope('https://vault.example.com:8443')).not.toBe(serverScope(PROD));
    const a = serverScope('https://example.com/team-a');
    const b = serverScope('https://example.com/team_a');
    expect(a).toMatch(/^https_example_com_443_team_a_/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(serverScope('https://example.com'));
    expect(tokenKey(serverScope(PROD))).not.toBe(tokenKey(serverScope('http://localhost:3000')));
  });

  it('moves pre-existing global sign-in data under the build-time server once', async () => {
    const { local } = fakeChrome();
    await local.set({ 'pv.sessionToken': 'tok', 'pv.pref.deviceId': 'dev-1', 'pv.pref.lastEmail': 'ann@example.com', 'pv.autoSave.enabled': true });
    await migrateLegacyStorage(local, PROD);
    const scope = serverScope(PROD);
    expect(local.data.get(`pv.${scope}.sessionToken`)).toBe('tok');
    expect(local.data.get(`pv.${scope}.pref.deviceId`)).toBe('dev-1');
    expect(local.data.has('pv.sessionToken')).toBe(false);
    expect(local.data.get('pv.autoSave.enabled')).toBe(true); // device-wide setting untouched
    expect(local.data.get(SELECTED_SERVER_KEY)).toBe(PROD);
    await local.set({ 'pv.sessionToken': 'later' });
    await migrateLegacyStorage(local, PROD);
    expect(local.data.get('pv.sessionToken')).toBe('later');
  });

  it('turns the pre-profiles selection into saved servers', async () => {
    const { local } = fakeChrome();
    await local.set({ [SELECTED_SERVER_KEY]: 'https://self.example.org' });
    const s = await loadProfiles(local, { productionUrl: PROD, localDevDefault: false });
    expect(s.profiles.map((p) => p.url)).toEqual(['https://self.example.org', PROD]);
    expect(s.profiles.find((p) => p.id === s.activeId)!.url).toBe('https://self.example.org');
    expect(s.localDev).toBe(false);
    expect(local.data.has(SELECTED_SERVER_KEY)).toBe(false);
    expect(local.data.get(PROFILES_KEY)).toEqual(s);
    // stored profiles are reloaded as they are
    expect(await loadProfiles(local, { productionUrl: PROD, localDevDefault: false })).toEqual(s);
  });

  it('a corrupt or insecure stored selection falls back to the build-time server', async () => {
    const { local } = fakeChrome();
    await local.set({ [SELECTED_SERVER_KEY]: 'http://evil.example.org' });
    const s = await loadProfiles(local, { productionUrl: PROD, localDevDefault: false });
    expect(s.profiles.find((p) => p.id === s.activeId)!.url).toBe(PROD);
  });

  it('isolates sign-in data per server through the platform', async () => {
    const fc = fakeChrome();
    const a = createExtensionPlatform(fc.chrome, { apiBaseUrl: PROD, webAppUrl: PROD, scope: serverScope(PROD) });
    const b = createExtensionPlatform(fc.chrome, { apiBaseUrl: 'https://example.com/pv', webAppUrl: 'https://example.com/pv', scope: serverScope('https://example.com/pv') });
    await a.tokens.set('token-a');
    await a.prefs.set('lastEmail', 'ann@example.com');
    expect(await b.tokens.get()).toBeNull();
    expect(await b.prefs.get('lastEmail')).toBeNull();
    expect(await a.tokens.get()).toBe('token-a');
  });
});

describe('ServerManager', () => {
  async function setup(granted = new Set([`${PROD}/*`, 'https://home.example.com/*', 'https://example.com/*'])) {
    const fc = fakeChrome();
    const c = withPermissions(fc.chrome, granted);
    const state = await loadProfiles(fc.local, { productionUrl: PROD, localDevDefault: false });
    const activated: string[] = [];
    let changed = 0;
    const log: string[] = [];
    const m = new ServerManager(c, state, { activate: async (u) => void activated.push(u), changed: () => void changed++ }, servers([PROD, 'https://example.com/pv'], log));
    await m.refresh();
    return { fc, c, m, activated, log, changed: () => changed };
  }

  it('changes the address only after a successful check, keeping the previous server', async () => {
    const { m, activated, log } = await setup();
    await expect(m.connect('https://home.example.com')).rejects.toThrow(/reach/);
    expect(activated).toEqual([]);
    expect(m.activeUrl).toBe(PROD);
    expect(m.info().profiles.map((p) => p.url)).toEqual([PROD]); // nothing saved for a failed address
    expect(await m.connect('https://example.com/pv/')).toBe('https://example.com/pv');
    expect(activated).toEqual(['https://example.com/pv']);
    expect(m.info()).toMatchObject({ url: 'https://example.com/pv', localDev: false });
    expect(m.info().profiles.map((p) => [p.url, p.active])).toEqual([
      [PROD, false],
      ['https://example.com/pv', true],
    ]);
    expect(m.info().profiles[1]!.lastCheck).toMatchObject({ ok: true, version: '9.9.9' });
    expect(log.every((u) => !u.includes('token'))).toBe(true);
    // switching back to the saved server
    const prodId = m.info().profiles[0]!.id;
    expect(await m.switchTo(prodId)).toBe(PROD);
    expect(activated).toEqual(['https://example.com/pv', PROD]);
  });

  it('needs Chrome host access before checking or switching', async () => {
    const { m, activated } = await setup(new Set([`${PROD}/*`]));
    expect(await m.check('https://example.com/pv')).toMatchObject({ ok: false, code: 'unreachable', message: expect.stringMatching(/not allowed/) });
    await expect(m.connect('https://example.com/pv')).rejects.toThrow(/not allowed/);
    expect(activated).toEqual([]);
  });

  it('refuses plain http unless local development is on, and http for remote hosts always', async () => {
    const { m } = await setup();
    expect(await m.check('http://localhost:3000')).toMatchObject({ ok: false, code: 'invalid_url' });
    await m.setLocalDev(true);
    expect(m.info().profiles.some((p) => p.url === 'http://localhost:3000')).toBe(true);
    expect(await m.check('http://vault.example.com')).toMatchObject({ ok: false, code: 'invalid_url' });
  });

  it('forgets a saved server together with its local data, never the active one', async () => {
    const { fc, m } = await setup();
    await m.connect('https://example.com/pv');
    const prodScope = serverScope(PROD);
    await fc.local.set({ [`pv.${prodScope}.sessionToken`]: 't', [`pv.${prodScope}.pref.lastEmail`]: 'ann@example.com', 'pv.autoSave.enabled': true });
    await m.refresh();
    expect(m.info().profiles.find((p) => p.url === PROD)!.account).toBe('ann@example.com');
    await expect(m.remove(m.info().profiles.find((p) => p.active)!.id)).rejects.toThrow(/Switch to another/);
    await m.remove(prodScope);
    expect([...fc.local.data.keys()].filter((k) => k.startsWith(`pv.${prodScope}.`))).toEqual([]);
    expect(fc.local.data.get('pv.autoSave.enabled')).toBe(true);
    expect(m.info().profiles.map((p) => p.url)).toEqual(['https://example.com/pv']);
  });

  it('runs one change at a time', async () => {
    const { m } = await setup();
    const first = m.connect('https://example.com/pv');
    await expect(m.connect('https://example.com/pv')).rejects.toThrow(/in progress/);
    await first;
  });
});

describe('forgetServerData', () => {
  it('deletes the server’s IndexedDB caches only', async () => {
    const fc = fakeChrome();
    const deleted: string[] = [];
    const idb = { databases: async () => [{ name: 'passvault-ext-https_a_443-ann' }, { name: 'passvault-ext-https_a_443_x_1-bob' }, { name: 'passvault-ext-https_b_443-ann' }], deleteDatabase: (n: string) => void deleted.push(n) };
    await forgetServerData(fc.chrome, 'https_a_443', idb as unknown as IDBFactory);
    expect(deleted).toEqual(['passvault-ext-https_a_443-ann']);
  });
});

describe('server requests', () => {
  async function controllerWith(control: Partial<ServerControl>) {
    const fc = fakeChrome();
    const session = new VaultSession(createExtensionPlatform(fc.chrome, { apiBaseUrl: PROD, webAppUrl: PROD, scope: serverScope(PROD) }));
    const server: ServerControl = {
      info: () => ({ url: PROD, localDev: false, profiles: [] }),
      check: async () => ({ ok: false, url: null, code: 'invalid_url', message: 'x' }),
      connect: async (u) => u,
      switchTo: async () => PROD,
      rename: async () => undefined,
      remove: async () => undefined,
      setLocalDev: async (on) => on,
      ...control,
    };
    const controller = new BackgroundController({ chrome: fc.chrome, session, webUrl: PROD, server });
    await controller.ready;
    return controller;
  }

  it('are popup-only, validated, and the popup state shows the connected server', async () => {
    const calls: string[] = [];
    const c = await controllerWith({ connect: async (u) => (calls.push(u), u) });
    expect(unwrap<{ server?: { url: string } }>(await c.handleMessage({ type: 'state.get' }, senders.popup)).server?.url).toBe(PROD);
    expect(unwrap<{ url: string }>(await c.handleMessage({ type: 'server.set', url: 'https://example.com/pv' }, senders.popup)).url).toBe('https://example.com/pv');
    expect(calls).toEqual(['https://example.com/pv']);
    for (const msg of [
      { type: 'server.set', url: 'https://evil.example' },
      { type: 'server.check', url: 'https://evil.example' },
      { type: 'server.switch', id: 'x' },
      { type: 'server.remove', id: 'x' },
      { type: 'server.localDev', on: true },
    ]) {
      expect(await c.handleMessage(msg, senders.contentScript)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(await c.handleMessage(msg, senders.foreignExtension)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(await c.handleMessage({ type: 'server.set', url: 'x'.repeat(3000) }, senders.popup)).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(await c.handleMessage({ type: 'server.set', url: PROD, force: true }, senders.popup)).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(calls).toHaveLength(1);
  });

  it('surfaces a refused address as invalid_message with the reason', async () => {
    const { InvalidServerUrlError } = await import('@passvault/vault-core/servers');
    const c = await controllerWith({
      connect: async () => {
        throw new InvalidServerUrlError('Use https:// — plain http:// is only allowed for local development on this computer');
      },
    });
    const r = await c.handleMessage({ type: 'server.set', url: 'http://vault.example.com' }, senders.popup);
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_message', message: expect.stringContaining('https') } });
  });
});
