import { describe, expect, it } from 'vitest';
import { VaultSession } from '@passvault/vault-core';
import { BackgroundController } from '../src/background/controller';
import { createExtensionPlatform, tokenKey } from '../src/background/platform';
import {
  SELECTED_SERVER_KEY,
  defaultServer,
  loadSelectedServer,
  migrateLegacyStorage,
  productionUrlFrom,
  serverPresets,
  serverScope,
  webUrlFor,
} from '../src/background/servers';
import { fakeChrome, senders, unwrap } from './helpers';

const PROD = 'https://vault.example.com';

describe('server configuration', () => {
  it('takes the production server from the build, never a loopback or non-https address', () => {
    expect(productionUrlFrom('https://vault.example.com/api')).toBe(PROD);
    expect(productionUrlFrom('http://localhost:3000')).toBeNull();
    expect(productionUrlFrom('http://vault.example.com')).toBeNull();
    expect(productionUrlFrom('not a url')).toBeNull();
    expect(productionUrlFrom(undefined)).toBeNull();
    expect(serverPresets(PROD).map((p) => p.url)).toEqual([PROD, 'http://localhost:3000']);
    expect(serverPresets(null).map((p) => p.id)).toEqual(['local']);
    expect(defaultServer(PROD)).toBe(PROD);
    expect(defaultServer(null)).toBe('http://localhost:3000');
  });

  it('maps servers to their dashboards', () => {
    expect(webUrlFor('http://localhost:3000', PROD, 'https://app.example.com')).toBe('http://localhost:5173');
    expect(webUrlFor(PROD, PROD, 'https://app.example.com')).toBe('https://app.example.com');
    expect(webUrlFor('https://self.example.org', PROD, 'https://app.example.com')).toBe('https://self.example.org');
  });

  it('gives every server its own storage namespace', () => {
    expect(serverScope(PROD)).toBe('https_vault_example_com_443');
    expect(serverScope('http://localhost:3000')).toBe('http_localhost_3000');
    expect(serverScope('https://vault.example.com:8443')).not.toBe(serverScope(PROD));
    expect(tokenKey(serverScope(PROD))).not.toBe(tokenKey(serverScope('http://localhost:3000')));
  });

  it('keeps a stored selection, and ignores a corrupt one', async () => {
    const { local } = fakeChrome();
    expect(await loadSelectedServer(local, PROD)).toBe(PROD);
    await local.set({ [SELECTED_SERVER_KEY]: 'https://self.example.org' });
    expect(await loadSelectedServer(local, PROD)).toBe('https://self.example.org');
    await local.set({ [SELECTED_SERVER_KEY]: 'http://evil.example.org' });
    expect(await loadSelectedServer(local, PROD)).toBe(PROD);
  });

  it('moves pre-existing global sign-in data under the build-time server once', async () => {
    const { local } = fakeChrome();
    await local.set({ 'pv.sessionToken': 'tok', 'pv.pref.deviceId': 'dev-1', 'pv.pref.lastEmail': 'ann@example.com', 'pv.autoSave.enabled': true });
    await migrateLegacyStorage(local, PROD);
    const scope = serverScope(PROD);
    expect(local.data.get(`pv.${scope}.sessionToken`)).toBe('tok');
    expect(local.data.get(`pv.${scope}.pref.deviceId`)).toBe('dev-1');
    expect(local.data.has('pv.sessionToken')).toBe(false);
    expect(local.data.has('pv.pref.lastEmail')).toBe(false);
    expect(local.data.get('pv.autoSave.enabled')).toBe(true); // device-wide setting untouched
    expect(local.data.get(SELECTED_SERVER_KEY)).toBe(PROD);
    // a second run (or a later fresh token) is left alone
    await local.set({ 'pv.sessionToken': 'later' });
    await migrateLegacyStorage(local, PROD);
    expect(local.data.get('pv.sessionToken')).toBe('later');
  });

  it('isolates sign-in data per server through the platform', async () => {
    const fc = fakeChrome();
    const a = createExtensionPlatform(fc.chrome, { apiBaseUrl: PROD, webAppUrl: PROD, scope: serverScope(PROD) });
    const b = createExtensionPlatform(fc.chrome, { apiBaseUrl: 'http://localhost:3000', webAppUrl: 'http://localhost:5173', scope: serverScope('http://localhost:3000') });
    await a.tokens.set('token-a');
    await a.prefs.set('lastEmail', 'ann@example.com');
    expect(await b.tokens.get()).toBeNull();
    expect(await b.prefs.get('lastEmail')).toBeNull();
    expect(await a.tokens.get()).toBe('token-a');
  });
});

describe('server.set request', () => {
  async function controllerWith(switchTo: (url: string, force: boolean) => Promise<string>) {
    const fc = fakeChrome();
    const session = new VaultSession(createExtensionPlatform(fc.chrome, { apiBaseUrl: PROD, webAppUrl: PROD, scope: serverScope(PROD) }));
    const controller = new BackgroundController({ chrome: fc.chrome, session, webUrl: PROD, server: { url: PROD, presets: serverPresets(PROD), switchTo } });
    await controller.ready;
    return controller;
  }

  it('is popup-only, validated, and reports the current server in the popup state', async () => {
    const calls: Array<[string, boolean]> = [];
    const c = await controllerWith(async (url, force) => {
      calls.push([url, force]);
      return url;
    });
    expect(unwrap<{ server?: { url: string } }>(await c.handleMessage({ type: 'state.get' }, senders.popup)).server?.url).toBe(PROD);
    expect(unwrap<{ url: string }>(await c.handleMessage({ type: 'server.set', url: 'http://localhost:3000' }, senders.popup)).url).toBe('http://localhost:3000');
    expect(calls).toEqual([['http://localhost:3000', false]]);
    // content scripts and other extensions cannot switch the server
    expect(await c.handleMessage({ type: 'server.set', url: 'https://evil.example' }, senders.contentScript)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await c.handleMessage({ type: 'server.set', url: 'https://evil.example' }, senders.foreignExtension)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await c.handleMessage({ type: 'server.set', url: 'x'.repeat(3000) }, senders.popup)).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(calls).toHaveLength(1);
  });

  it('surfaces invalid addresses from the switcher as invalid_message', async () => {
    const { normalizeServerUrl } = await import('@passvault/vault-core/servers');
    const c = await controllerWith(async (url) => normalizeServerUrl(url));
    const r = await c.handleMessage({ type: 'server.set', url: 'http://vault.example.com' }, senders.popup);
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_message', message: expect.stringContaining('https') } });
  });
});
