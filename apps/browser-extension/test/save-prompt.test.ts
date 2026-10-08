import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultSession } from '@passvault/vault-core';
import type { ChromeLike, SenderLike } from '../src/background/chrome-api';
import { BackgroundController } from '../src/background/controller';
import { createExtensionPlatform } from '../src/background/platform';
import { AUTOSAVE_ORIGINS, CONTENT_SCRIPT_ID, PENDING_KEY, PENDING_TTL_MS, SavePromptManager, type PromptInfo } from '../src/background/save-prompt';
import { EXT_ID, MASTER, login, offlineDevice, senders, unwrap } from './helpers';

const tabSender = (url: string, tabId = 11, frameId = 0): SenderLike => ({ id: EXT_ID, url, origin: new URL(url).origin, tab: { id: tabId }, frameId });

async function setup(opts: { permission?: boolean } = {}) {
  const dev = await offlineDevice();
  let permission = opts.permission ?? true;
  const registered = new Map<string, { matches: string[]; js: string[]; allFrames?: boolean }>();
  const chrome = dev.fc.chrome as ChromeLike;
  chrome.permissions = { contains: async (p) => permission && JSON.stringify(p.origins) === JSON.stringify(AUTOSAVE_ORIGINS) };
  chrome.scripting.registerContentScripts = async (scripts) => {
    for (const s of scripts) registered.set(s.id, s);
  };
  chrome.scripting.getRegisteredContentScripts = async ({ ids }) => ids.filter((i) => registered.has(i)).map((id) => ({ id }));
  chrome.scripting.unregisterContentScripts = async ({ ids }) => {
    for (const i of ids) registered.delete(i);
  };
  const platform = createExtensionPlatform(chrome, { apiBaseUrl: 'http://127.0.0.1:9', webAppUrl: 'http://localhost:5173', createCacheStore: () => dev.store, deviceName: 'test' });
  const session = new VaultSession(platform);
  let now = Date.now();
  const manager = new SavePromptManager(chrome, session, ['http://localhost:5173', 'http://127.0.0.1:9'], () => now);
  const controller = new BackgroundController({ chrome, session, webUrl: 'http://localhost:5173', savePrompt: manager });
  await controller.ready;
  const popup = (msg: unknown) => controller.handleMessage(msg, senders.popup);
  return {
    dev,
    session,
    manager,
    popup,
    registered,
    setPermission: (v: boolean) => (permission = v),
    advance: (ms: number) => (now += ms),
    content: (msg: unknown, sender: SenderLike) => manager.handle(msg, sender),
  };
}

type Env = Awaited<ReturnType<typeof setup>>;
let env: Env;

beforeEach(async () => {
  env = await setup();
});
afterEach(() => env.session.lock());

describe('offer to save: setting and registration', () => {
  it('is off by default and only registers the content script once enabled with permission', async () => {
    expect(unwrap<{ enabled: boolean }>(await env.popup({ type: 'autosave.status' })).enabled).toBe(false);
    expect(await env.content({ type: 'savePrompt.pending' }, tabSender('https://shop.example.com/'))).toEqual({ show: false });
    const st = unwrap<{ enabled: boolean }>(await env.popup({ type: 'autosave.set', enabled: true }));
    expect(st.enabled).toBe(true);
    expect(env.registered.get(CONTENT_SCRIPT_ID)).toMatchObject({ matches: AUTOSAVE_ORIGINS, js: ['save-prompt.js'], allFrames: false });
    await env.popup({ type: 'autosave.set', enabled: false });
    expect(env.registered.size).toBe(0);
  });

  it('stays off without the optional host permission, and unregisters when it is revoked', async () => {
    env.setPermission(false);
    expect(unwrap<{ enabled: boolean }>(await env.popup({ type: 'autosave.set', enabled: true })).enabled).toBe(false);
    expect(env.registered.size).toBe(0);
    env.setPermission(true);
    await env.popup({ type: 'autosave.set', enabled: true });
    env.setPermission(false);
    await env.manager.syncRegistration();
    expect(env.registered.size).toBe(0);
  });

  it('popup-only controls are refused from content scripts', async () => {
    const r = await env.content({ type: 'autosave.set', enabled: true }, tabSender('https://evil.test/'));
    expect(r).toBeNull();
  });
});

describe('offer to save: capture and decisions', () => {
  beforeEach(async () => {
    await env.popup({ type: 'autosave.set', enabled: true });
  });

  it('rejects messages that are not from a top-frame tab of this extension', async () => {
    const msg = { type: 'savePrompt.submitted', username: 'u', password: 'p' };
    expect(await env.content(msg, senders.popup)).toBeNull();
    expect(await env.content(msg, tabSender('https://shop.example.com/', 11, 3))).toBeNull(); // subframe
    expect(await env.content(msg, { ...tabSender('https://shop.example.com/'), id: 'other-extension' })).toBeNull();
    expect(await env.content(msg, tabSender('file:///etc/passwd'))).toBeNull();
    // the page cannot tell us its origin, or add fields
    expect(await env.content({ ...msg, origin: 'https://bank.example.com' }, tabSender('https://shop.example.com/'))).toBeNull();
  });

  it('while locked: offers to save, refuses to save until unlocked, then saves with the sender origin', async () => {
    const s = tabSender('https://shop.example.com/login');
    const info = (await env.content({ type: 'savePrompt.submitted', username: 'ann@example.com', password: 'Hunter2-secret!' }, s)) as PromptInfo;
    expect(info).toEqual({ show: true, action: 'save', host: 'shop.example.com', itemTitle: undefined, locked: true });
    expect(JSON.stringify(info)).not.toContain('Hunter2');
    // pending capture is memory-only (storage.session), never chrome.storage.local
    expect(env.dev.fc.session.data.has(PENDING_KEY)).toBe(true);
    expect(JSON.stringify([...env.dev.fc.local.data.values()])).not.toContain('Hunter2');
    const refused = await env.content({ type: 'savePrompt.decide', decision: 'save' }, s);
    expect(refused).toMatchObject({ ok: false, code: 'locked' });
    await env.session.unlock(MASTER);
    const ok = await env.content({ type: 'savePrompt.decide', decision: 'save' }, s);
    expect(ok).toEqual({ ok: true, message: 'Saved to PassVault' });
    const item = env.session.getSnapshot().items.find((i) => i.payload.type === 'login')!;
    expect(item.payload.type === 'login' && item.payload.fields).toMatchObject({ username: 'ann@example.com', password: 'Hunter2-secret!', urls: [{ url: 'https://shop.example.com', match: 'host' }] });
    expect(env.dev.fc.session.data.has(PENDING_KEY)).toBe(false);
  });

  it('offers to update an existing login with a different password, and stays quiet when unchanged', async () => {
    await env.session.unlock(MASTER);
    const id = await env.session.saveItem(login('Shop', 'ann', 'old-password', 'https://shop.example.com'));
    const s = tabSender('https://shop.example.com/signin');
    expect(await env.content({ type: 'savePrompt.submitted', username: 'ann', password: 'old-password' }, s)).toEqual({ show: false });
    const info = await env.content({ type: 'savePrompt.submitted', username: 'ann', password: 'new-password-9' }, s);
    expect(info).toMatchObject({ show: true, action: 'update', itemTitle: 'Shop' });
    expect(await env.content({ type: 'savePrompt.decide', decision: 'update' }, s)).toMatchObject({ ok: true });
    const it = env.session.getSnapshot().items.find((i) => i.id === id)!;
    expect(it.payload.type === 'login' && it.payload.fields.password).toBe('new-password-9');
  });

  it('saves an optional note with a new login, and appends it to the notes on update', async () => {
    await env.session.unlock(MASTER);
    const s = tabSender('https://shop.example.com/login');
    await env.content({ type: 'savePrompt.submitted', username: 'ann', password: 'pw-first-1' }, s);
    expect(await env.content({ type: 'savePrompt.decide', decision: 'save', note: '  Work account — billing admin  ' }, s)).toMatchObject({ ok: true });
    const saved = env.session.getSnapshot().items.find((i) => i.payload.type === 'login')!;
    expect(saved.payload.notes).toBe('Work account — billing admin');

    await env.content({ type: 'savePrompt.submitted', username: 'ann', password: 'pw-second-2' }, s);
    expect(await env.content({ type: 'savePrompt.decide', decision: 'update', note: 'Rotated after the incident' }, s)).toMatchObject({ ok: true });
    const updated = env.session.getSnapshot().items.find((i) => i.id === saved.id)!;
    expect(updated.payload.notes).toBe('Work account — billing admin\n\nRotated after the incident');
    expect(updated.payload.type === 'login' && updated.payload.fields.password).toBe('pw-second-2');
  });

  it('rejects oversized or malformed notes from the page', async () => {
    const s = tabSender('https://shop.example.com/login');
    await env.content({ type: 'savePrompt.submitted', username: 'ann', password: 'pw-1' }, s);
    expect(await env.content({ type: 'savePrompt.decide', decision: 'save', note: 'x'.repeat(2001) }, s)).toBeNull();
    expect(await env.content({ type: 'savePrompt.decide', decision: 'save', note: { html: '<b>' } }, s)).toBeNull();
  });

  it('follows a post-login redirect on the same site but never to another site', async () => {
    await env.content({ type: 'savePrompt.submitted', username: 'u', password: 'pw-123456' }, tabSender('https://login.example.co.uk/'));
    expect(await env.content({ type: 'savePrompt.pending' }, tabSender('https://www.example.co.uk/home'))).toMatchObject({ show: true });
    expect(await env.content({ type: 'savePrompt.pending' }, tabSender('https://evil.example.org/'))).toEqual({ show: false });
    expect(await env.content({ type: 'savePrompt.decide', decision: 'save' }, tabSender('https://evil.example.org/'))).toMatchObject({ ok: false, code: 'expired' });
    // another tab has no pending prompt
    expect(await env.content({ type: 'savePrompt.pending' }, tabSender('https://www.example.co.uk/', 99))).toEqual({ show: false });
  });

  it('“Never for this site” suppresses future prompts until reset', async () => {
    const s = tabSender('https://news.example.net/login');
    await env.content({ type: 'savePrompt.submitted', username: 'u', password: 'p1' }, s);
    await env.content({ type: 'savePrompt.decide', decision: 'never' }, s);
    expect(await env.content({ type: 'savePrompt.submitted', username: 'u', password: 'p2' }, tabSender('https://www.example.net/'))).toEqual({ show: false });
    expect(unwrap<{ neverCount: number }>(await env.popup({ type: 'autosave.status' })).neverCount).toBe(1);
    await env.popup({ type: 'autosave.clearNever' });
    expect(await env.content({ type: 'savePrompt.submitted', username: 'u', password: 'p3' }, tabSender('https://www.example.net/'))).toMatchObject({ show: true });
  });

  it('never prompts on PassVault’s own dashboard', async () => {
    expect(await env.content({ type: 'savePrompt.submitted', username: 'u', password: 'p' }, tabSender('http://localhost:5173/'))).toEqual({ show: false });
  });

  it('captured passwords expire and are wiped when the vault locks', async () => {
    const s = tabSender('https://shop.example.com/');
    await env.content({ type: 'savePrompt.submitted', username: 'u', password: 'p' }, s);
    env.advance(PENDING_TTL_MS + 1);
    expect(await env.content({ type: 'savePrompt.pending' }, s)).toEqual({ show: false });

    await env.session.unlock(MASTER);
    await env.content({ type: 'savePrompt.submitted', username: 'u', password: 'p-locked' }, s);
    expect(env.dev.fc.session.data.has(PENDING_KEY)).toBe(true);
    env.session.lock();
    await new Promise((r) => setTimeout(r, 10));
    expect(env.dev.fc.session.data.has(PENDING_KEY)).toBe(false);
    expect(await env.content({ type: 'savePrompt.pending' }, s)).toEqual({ show: false });
  });
});
