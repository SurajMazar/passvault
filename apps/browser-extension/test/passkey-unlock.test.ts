import { afterEach, describe, expect, it } from 'vitest';
import { VaultSession } from '@passvault/vault-core';
import type { ChromeLike, SenderLike } from '../src/background/chrome-api';
import { BackgroundController } from '../src/background/controller';
import { createExtensionPlatform } from '../src/background/platform';
import { UnlockWindow, UnlockCancelled, passkeyRecordKey, type Ceremony } from '../src/background/passkey-unlock';
import { EXT_ID, MASTER, offlineDevice, senders, stopAllWorkers, unwrap } from './helpers';

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** What the user does in the passkey window. */
type Behaviour = 'approve' | 'cancel' | 'use-password' | 'other-passkey' | 'ignore';

/**
 * chrome.windows fake + a passkey "device": each credential has a secret, and its PRF
 * for a salt is HMAC-SHA256(secret, salt) — deterministic like a real authenticator.
 */
function fakeWindows(c: ChromeLike) {
  const secrets = new Map<string, Uint8Array<ArrayBuffer>>();
  const opened: Array<{ id: number; url: string; closed: boolean }> = [];
  const focused: number[] = [];
  let behaviour: Behaviour = 'approve';
  let broker: UnlockWindow | null = null;
  const removedListeners: Array<(id: number) => void> = [];
  const prf = async (cred: string, salt: string) => {
    const key = await crypto.subtle.importKey('raw', secrets.get(cred)!, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, Buffer.from(salt, 'base64url'))));
  };
  /** Plays unlock.html for window `w`. */
  const playPage = async (w: { id: number; url: string }) => {
    const reqId = w.url.split('#')[1]!;
    const sender: SenderLike = { id: EXT_ID, url: w.url, origin: `chrome-extension://${EXT_ID}`, tab: { id: 1000 + w.id } };
    const params = broker!.handle({ type: 'passkeyUnlock.get', id: reqId }, sender) as Ceremony | null;
    if (!params || behaviour === 'ignore') return;
    if (behaviour === 'cancel') return void broker!.handle({ type: 'passkeyUnlock.fail', id: reqId, message: 'cancelled' }, sender);
    if (behaviour === 'use-password') return void broker!.handle({ type: 'passkeyUnlock.fail', id: reqId, message: 'cancelled', usePassword: true }, sender);
    let cred: string;
    if (params.kind === 'enroll') {
      cred = b64u(crypto.getRandomValues(new Uint8Array(16)));
      secrets.set(cred, crypto.getRandomValues(new Uint8Array(32)));
    } else if (behaviour === 'other-passkey') {
      cred = params.credentialId;
      secrets.set(cred, crypto.getRandomValues(new Uint8Array(32))); // same id, different secret: wrong PRF
    } else cred = params.credentialId;
    broker!.handle({ type: 'passkeyUnlock.done', id: reqId, credentialId: cred, prf: await prf(cred, params.salt) }, sender);
  };
  c.windows = {
    create: async (props) => {
      const w = { id: opened.length + 1, url: props.url, closed: false };
      opened.push(w);
      setTimeout(() => void playPage(w), 0);
      return { id: w.id, tabs: [{ id: 1000 + w.id }] };
    },
    update: async (id) => void focused.push(id),
    remove: async (id) => {
      const w = opened.find((x) => x.id === id);
      if (w && !w.closed) {
        w.closed = true;
        for (const l of removedListeners) l(id);
      }
    },
    onRemoved: { addListener: (fn) => void removedListeners.push(fn) },
    getLastFocused: async () => ({ id: 99 }), // the user's normal browser window
  };
  return {
    opened,
    focused,
    setBehaviour: (b: Behaviour) => void (behaviour = b),
    bind: (b: UnlockWindow) => void (broker = b),
    /** the user closes the window with its close button */
    close: (id: number) => c.windows!.remove!(id),
  };
}

async function worker(dev?: Awaited<ReturnType<typeof offlineDevice>>) {
  dev ??= await offlineDevice();
  const chrome = dev.fc.chrome;
  const opens: string[] = [];
  chrome.action = { openPopup: async (o) => void opens.push(`popup in window ${o?.windowId}`) };
  const win = fakeWindows(chrome);
  const unlockWindow = new UnlockWindow(chrome);
  win.bind(unlockWindow);
  const platform = createExtensionPlatform(chrome, { apiBaseUrl: 'http://127.0.0.1:9', webAppUrl: 'http://localhost:5173', createCacheStore: () => dev.store, deviceName: 't', unlockWindow });
  const session = new VaultSession(platform);
  const controller = new BackgroundController({
    chrome,
    session,
    webUrl: 'http://localhost:5173',
    passkeyUnlock: { status: () => platform.biometrics!.status(), window: unlockWindow },
  });
  await controller.ready;
  const popup = (m: unknown) => controller.handleMessage(m, senders.popup);
  return { dev, chrome, win, unlockWindow, session, controller, popup, opens };
}
const state = async (popup: (m: unknown) => ReturnType<BackgroundController['handleMessage']>) => unwrap<Record<string, unknown>>(await popup({ type: 'state.get' }));
const tick = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => stopAllWorkers());

describe('passkey unlock (extension)', () => {
  it('turns on in the passkey window, then unlocks the vault with the same passkey', async () => {
    const w = await worker();
    await w.popup({ type: 'auth.unlock', password: MASTER });
    const on = unwrap<{ enabled: boolean }>(await w.popup({ type: 'passkeyUnlock.set', enabled: true }));
    expect(on.enabled).toBe(true);
    expect(w.win.opened[0]!.url).toMatch(new RegExp(`^chrome-extension://${EXT_ID}/unlock\\.html#[0-9a-f-]{36}$`));
    // Only { credential id, salt, iv, sealed key } are stored: no PRF secret, no key.
    const rec = (await w.dev.fc.local.get(null)) as Record<string, unknown>;
    const stored = Object.entries(rec).find(([k]) => k.includes('passkeyUnlock.'))![1] as Record<string, string>;
    expect(Object.keys(stored).sort()).toEqual(['cred', 'iv', 'salt', 'sealed', 'v']);

    await w.popup({ type: 'auth.lock' });
    await tick();
    expect(await state(w.popup)).toMatchObject({ phase: 'locked', biometricAvailable: true, passkeyAutoStart: true });
    const after = unwrap<{ phase: string }>(await w.popup({ type: 'auth.unlockBiometric' }));
    expect(after.phase).toBe('unlocked');
    expect(w.win.opened).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 900));
    expect(w.win.opened[1]!.closed).toBe(true); // the passkey window closes after its success…
    expect(w.opens).toContain('popup in window 99'); // …and the toolbar popup comes back, unlocked, in the browser window
    w.session.lock();
  });

  it('never opens the passkey window while the vault is unlocked', async () => {
    const w = await worker();
    await w.popup({ type: 'auth.unlock', password: MASTER });
    await w.popup({ type: 'passkeyUnlock.set', enabled: true });
    const before = w.win.opened.length;
    expect(unwrap<{ phase: string }>(await w.popup({ type: 'auth.unlockBiometric' })).phase).toBe('unlocked');
    expect(w.win.opened.length).toBe(before);
    expect(await state(w.popup)).not.toHaveProperty('passkeyAutoStart');
  });

  it('closes a waiting passkey window when the master password unlocks first', async () => {
    const w = await worker();
    await w.popup({ type: 'auth.unlock', password: MASTER });
    await w.popup({ type: 'passkeyUnlock.set', enabled: true });
    await w.popup({ type: 'auth.lock' });
    await tick();
    w.win.setBehaviour('ignore'); // the user does not touch the sensor…
    const pending = w.popup({ type: 'auth.unlockBiometric' });
    await tick();
    const win = w.win.opened.at(-1)!;
    expect(win.closed).toBe(false);
    await w.popup({ type: 'auth.unlock', password: MASTER }); // …and types the password instead
    await tick();
    expect(win.closed).toBe(true);
    expect(unwrap<{ phase: string }>(await pending).phase).toBe('unlocked');
  });

  it('after "Use master password" or closing the window, it does not reopen by itself until the next lock', async () => {
    const w = await worker();
    await w.popup({ type: 'auth.unlock', password: MASTER });
    await w.popup({ type: 'passkeyUnlock.set', enabled: true });
    await w.popup({ type: 'auth.lock' });
    await tick();
    w.win.setBehaviour('use-password');
    expect(unwrap<{ phase: string }>(await w.popup({ type: 'auth.unlockBiometric' })).phase).toBe('locked');
    expect(await state(w.popup)).toMatchObject({ biometricAvailable: true, passkeyAutoStart: false });
    // the window's close button
    w.win.setBehaviour('ignore');
    const pending = w.popup({ type: 'auth.unlockBiometric' });
    await tick();
    await w.win.close(w.win.opened.at(-1)!.id);
    expect(unwrap<{ phase: string }>(await pending).phase).toBe('locked');
    // a new lock starts over
    await w.popup({ type: 'auth.unlock', password: MASTER });
    await w.popup({ type: 'auth.lock' });
    await tick();
    expect(await state(w.popup)).toMatchObject({ passkeyAutoStart: true });
  });

  it('refuses a passkey whose secret does not open the seal', async () => {
    const w = await worker();
    await w.popup({ type: 'auth.unlock', password: MASTER });
    await w.popup({ type: 'passkeyUnlock.set', enabled: true });
    await w.popup({ type: 'auth.lock' });
    await tick();
    w.win.setBehaviour('other-passkey');
    const r = (await w.popup({ type: 'auth.unlockBiometric' })) as { ok: boolean; error?: { message: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/no longer matches/);
    expect((await state(w.popup)).phase).toBe('locked');
  });

  it('turning it off forgets the sealed key in this browser', async () => {
    const w = await worker();
    await w.popup({ type: 'auth.unlock', password: MASTER });
    await w.popup({ type: 'passkeyUnlock.set', enabled: true });
    expect(unwrap<{ enabled: boolean }>(await w.popup({ type: 'passkeyUnlock.set', enabled: false })).enabled).toBe(false);
    const all = JSON.stringify(await w.dev.fc.local.get(null));
    expect(all).not.toContain('passkeyUnlock.');
    await w.popup({ type: 'auth.lock' });
    await tick();
    expect(await state(w.popup)).toMatchObject({ biometricAvailable: false });
  });

  it('replaces an old Touch ID setting (no passkey record) and says so once', async () => {
    const dev = await offlineDevice();
    // Touch ID through PassVault for Mac was on: the session holds a device-wrapped key, the passkey store nothing.
    await dev.store.setMeta('biometricWrappedUserKey', 'AAAA');
    const w = await worker(dev);
    expect(await state(w.popup)).toMatchObject({ phase: 'locked', biometricAvailable: false, touchIdReplaced: true });
    expect(w.win.opened).toHaveLength(0);
    await w.popup({ type: 'auth.unlock', password: MASTER });
    expect(unwrap<{ touchIdReplaced?: boolean }>(await w.popup({ type: 'passkeyUnlock.status' }))).toMatchObject({ enabled: false, touchIdReplaced: true });
    await w.popup({ type: 'passkeyUnlock.set', enabled: true });
    expect(await state(w.popup)).not.toHaveProperty('touchIdReplaced');
  });
});

describe('unlock window broker', () => {
  const page = (id: string, tab = 1001): SenderLike => ({ id: EXT_ID, url: `chrome-extension://${EXT_ID}/unlock.html#${id}`, origin: `chrome-extension://${EXT_ID}`, tab: { id: tab } });
  it('answers only the window it opened, for the current request', async () => {
    const dev = await offlineDevice();
    const chrome = dev.fc.chrome;
    const win = fakeWindows(chrome);
    win.setBehaviour('ignore');
    const broker = new UnlockWindow(chrome);
    win.bind(broker);
    const run = broker.run({ kind: 'unlock', salt: 'c2FsdA', credentialId: 'Y3JlZA' });
    await tick();
    const id = win.opened[0]!.url.split('#')[1]!;
    const get = { type: 'passkeyUnlock.get', id };
    expect(broker.handle(get, senders.contentScript)).toBeNull();
    expect(broker.handle(get, senders.popup)).toBeNull(); // not the unlock page
    expect(broker.handle(get, page(id, 4242))).toBeNull(); // another tab with the same page
    expect(broker.handle({ type: 'passkeyUnlock.get', id: 'other' }, page(id))).toBeNull();
    expect(broker.handle(get, { ...page(id), id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' })).toBeNull();
    expect(broker.handle(get, page(id))).toMatchObject({ kind: 'unlock', credentialId: 'Y3JlZA' });
    // a second request of the same kind focuses the open window instead of opening another
    const again = broker.run({ kind: 'unlock', salt: 'c2FsdA', credentialId: 'Y3JlZA' });
    await tick();
    expect(win.opened).toHaveLength(1);
    expect(win.focused).toEqual([1]);
    broker.cancel('test', 'enroll'); // other kind: nothing happens
    expect(broker.busy).toBe(true);
    broker.cancel('test', 'unlock');
    await expect(run).rejects.toBeInstanceOf(UnlockCancelled);
    await expect(again).rejects.toBeInstanceOf(UnlockCancelled);
    expect(win.opened[0]!.closed).toBe(true);
  });

  it('keeps records per server', () => {
    expect(passkeyRecordKey('https_a', 'u1')).toBe('pv.https_a.passkeyUnlock.u1');
    expect(passkeyRecordKey(undefined, 'u1')).toBe('pv.passkeyUnlock.u1');
  });
});

describe('message routing', () => {
  it('sends only the passkey window’s own messages to it, not the popup’s requests', async () => {
    const { isUnlockPageMessage } = await import('../src/background/passkey-unlock');
    for (const type of ['passkeyUnlock.get', 'passkeyUnlock.done', 'passkeyUnlock.fail']) expect(isUnlockPageMessage({ type })).toBe(true);
    for (const type of ['passkeyUnlock.status', 'passkeyUnlock.set', 'auth.unlockBiometric']) expect(isUnlockPageMessage({ type })).toBe(false);
  });
});
