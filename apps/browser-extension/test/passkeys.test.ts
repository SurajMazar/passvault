import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultSession } from '@passvault/vault-core';
import type { ChromeLike, SenderLike } from '../src/background/chrome-api';
import { createExtensionPlatform } from '../src/background/platform';
import { PasskeyManager, type PasskeyResult } from '../src/background/passkeys';
import { unb64url } from '../src/background/webauthn';
import { EXT_ID, MASTER, offlineDevice } from './helpers';

const tab = (url: string, frameId = 0): SenderLike => ({ id: EXT_ID, url, origin: new URL(url).origin, tab: { id: 7 }, frameId });
const challenge = 'Y2hhbGxlbmdlLWNoYWxsZW5nZQ';
const createReq = (over: Record<string, unknown> = {}) => ({
  type: 'passkey.request',
  requestId: 'r1',
  kind: 'create',
  options: { rp: { id: 'example.com', name: 'Example' }, user: { id: 'dXNlci0x', name: 'alice', displayName: 'Alice' }, challenge, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [], ...over },
});
const getReq = (over: Record<string, unknown> = {}) => ({ type: 'passkey.request', requestId: 'r2', kind: 'get', options: { rpId: 'example.com', challenge, allowCredentials: [], ...over } });

let env: Awaited<ReturnType<typeof setup>>;
async function setup() {
  const dev = await offlineDevice();
  const chrome = dev.fc.chrome as ChromeLike;
  let opened = 0;
  chrome.action = { openPopup: async () => void opened++, setBadgeText: async () => undefined };
  const platform = createExtensionPlatform(chrome, { apiBaseUrl: 'http://127.0.0.1:9', webAppUrl: 'http://localhost:5173', createCacheStore: () => dev.store, deviceName: 'test' });
  const session = new VaultSession(platform);
  await session.init();
  await session.unlock(MASTER);
  const pm = new PasskeyManager(chrome, session, { enabled: async () => true, changed: () => undefined, ownOrigins: ['http://localhost:5173'] });
  return { session, pm, opened: () => opened };
}
beforeEach(async () => {
  env = await setup();
});
afterEach(() => env.session.lock());

/** Start a request, then decide once PassVault shows it. */
async function run(msg: unknown, sender: SenderLike, decide: (id: string) => Promise<unknown>): Promise<PasskeyResult | null> {
  const p = env.pm.handle(msg, sender);
  await new Promise((r) => setTimeout(r, 0));
  const v = env.pm.view();
  if (v) await decide(v.id);
  return p;
}

describe('passkey requests', () => {
  it('saves a passkey into a new login after approval, then signs in with it', async () => {
    const created = await run(createReq(), tab('https://login.example.com/signup'), (id) => env.pm.decide(id, 'approve'));
    expect(env.opened()).toBe(1);
    expect(created).toMatchObject({ credentialId: expect.any(String), attestationObject: expect.any(String) });
    const cdj = JSON.parse(new TextDecoder().decode(unb64url(String(created!.clientDataJSON))));
    expect(cdj.origin).toBe('https://login.example.com'); // from the browser, not the page
    const item = env.session.getSnapshot().items.find((i) => i.payload.type === 'login');
    expect(item?.payload.type === 'login' && item.payload.fields.passkeys?.[0]?.rpId).toBe('example.com');

    const signed = await run(getReq(), tab('https://example.com/login'), (id) => env.pm.decide(id, 'approve', String(created!.credentialId)));
    expect(signed).toMatchObject({ credentialId: created!.credentialId, signature: expect.any(String), userHandle: 'dXNlci0x' });
  });

  it('hands requests back to the browser when PassVault has nothing or is not the right place', async () => {
    expect(await env.pm.handle(getReq(), tab('https://example.com/login'))).toEqual({ fallback: true }); // no passkey saved
    expect(await env.pm.handle(createReq(), tab('http://example.com/'))).toEqual({ fallback: true }); // not https
    expect(await env.pm.handle(createReq(), tab('http://localhost:5173/'))).toEqual({ fallback: true }); // PassVault's own page
    expect(await env.pm.handle(createReq({ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }), tab('https://example.com/'))).toEqual({ fallback: true });
    expect(env.opened()).toBe(0);
  });

  it('refuses a passkey domain that is not this site, and messages from frames', async () => {
    expect(await env.pm.handle(createReq({ rp: { id: 'evil.com', name: 'x' } }), tab('https://example.com/'))).toMatchObject({ error: 'SecurityError' });
    expect(await env.pm.handle(createReq(), tab('https://example.com/', 3))).toBeNull();
  });

  it('cancel and "use another device" resolve without saving', async () => {
    expect(await run(createReq(), tab('https://example.com/'), (id) => env.pm.decide(id, 'fallback'))).toEqual({ fallback: true });
    expect(await run(createReq(), tab('https://example.com/'), (id) => env.pm.decide(id, 'cancel'))).toMatchObject({ error: 'NotAllowedError' });
    expect(env.session.getSnapshot().items.length).toBe(0);
  });
});
