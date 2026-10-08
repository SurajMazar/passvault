import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultSession } from '@passvault/vault-core';
import type { ChromeLike, SenderLike } from '../src/background/chrome-api';
import { BackgroundController } from '../src/background/controller';
import { InlineMenuManager, INLINE_ENABLED_KEY, MAX_SUGGESTIONS, isInlineMessage } from '../src/background/inline-menu';
import { createExtensionPlatform } from '../src/background/platform';
import { AUTOSAVE_ORIGINS, SavePromptManager } from '../src/background/save-prompt';
import { EXT_ID, MASTER, login, offlineDevice, senders, unwrap } from './helpers';

const TAB = 21;
const tabSender = (url: string, tabId = TAB, frameId = 0): SenderLike => ({ id: EXT_ID, url, origin: new URL(url).origin, tab: { id: tabId }, frameId });

async function setup() {
  const dev = await offlineDevice();
  let permission = true;
  const chrome = dev.fc.chrome as ChromeLike;
  chrome.permissions = { contains: async (p) => permission && JSON.stringify(p.origins) === JSON.stringify(AUTOSAVE_ORIGINS) };
  let popupOpened = 0;
  chrome.action = { openPopup: async () => void popupOpened++ };
  const platform = createExtensionPlatform(chrome, { apiBaseUrl: 'http://127.0.0.1:9', webAppUrl: 'http://localhost:5173', createCacheStore: () => dev.store, deviceName: 'test' });
  const session = new VaultSession(platform);
  const own = ['http://localhost:5173', 'http://127.0.0.1:9'];
  const savePrompt = new SavePromptManager(chrome, session, own);
  const controller = new BackgroundController({ chrome, session, webUrl: 'http://localhost:5173', savePrompt });
  await controller.ready;
  const inline = new InlineMenuManager(chrome, session, own, { matches: (t) => controller.matches(t), fill: (t, id, i) => controller.fill(t, id, i) });
  return {
    dev,
    session,
    inline,
    popup: (msg: unknown) => controller.handleMessage(msg, senders.popup),
    setPermission: (v: boolean) => (permission = v),
    popupOpened: () => popupOpened,
    send: (msg: unknown, sender: SenderLike) => inline.handle(msg, sender),
  };
}

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  env = await setup();
});
afterEach(() => env.session.lock());

describe('inline suggestions in login fields', () => {
  it('lists logins for the page’s site with title and username only — never a password', async () => {
    await env.session.unlock(MASTER);
    await env.session.saveItem(login('Shop', 'ann@example.com', 'shop-secret-1', 'https://shop.example.com'));
    await env.session.saveItem(login('Shop (work)', 'ann@work.example', 'shop-secret-2', 'https://shop.example.com'));
    await env.session.saveItem(login('Bank', 'ann', 'bank-secret', 'https://bank.example.com'));
    env.dev.fc.setTab(TAB, 'https://shop.example.com/login');
    const r = await env.send({ type: 'inline.suggest' }, tabSender('https://shop.example.com/login'));
    expect(r).toMatchObject({ show: true, locked: false });
    const items = (r as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((i) => i.title).sort()).toEqual(['Shop', 'Shop (work)']);
    for (const i of items) expect(Object.keys(i).sort()).toEqual(['id', 'insecure', 'title', 'username']);
    expect(JSON.stringify(r)).not.toMatch(/secret/);
  });

  it('shows "unlock" while locked, and nothing when no login matches', async () => {
    env.dev.fc.setTab(TAB, 'https://shop.example.com/login');
    expect(await env.send({ type: 'inline.suggest' }, tabSender('https://shop.example.com/login'))).toEqual({ show: true, locked: true, items: [] });
    expect(await env.send({ type: 'inline.unlock' }, tabSender('https://shop.example.com/login'))).toEqual({ ok: true });
    expect(env.popupOpened()).toBe(1);
    await env.session.unlock(MASTER);
    expect(await env.send({ type: 'inline.suggest' }, tabSender('https://shop.example.com/login'))).toEqual({ show: false });
  });

  it('fills the chosen login into its own site only', async () => {
    await env.session.unlock(MASTER);
    const shop = await env.session.saveItem(login('Shop', 'ann', 'shop-secret', 'https://shop.example.com'));
    const bank = await env.session.saveItem(login('Bank', 'ann', 'bank-secret', 'https://bank.example.com'));
    env.dev.fc.setTab(TAB, 'https://shop.example.com/login');
    expect(await env.send({ type: 'inline.fill', itemId: shop }, tabSender('https://shop.example.com/login'))).toEqual({ ok: true });
    const inj = env.dev.fc.injections.at(-1)!;
    expect(inj.target).toEqual({ tabId: TAB, frameIds: [0] });
    expect(inj.args).toEqual(['https://shop.example.com', 'ann', 'shop-secret']);
    // another site's login, asked for by this page: refused, nothing injected
    const before = env.dev.fc.injections.length;
    const r = await env.send({ type: 'inline.fill', itemId: bank }, tabSender('https://shop.example.com/login'));
    expect(r).toMatchObject({ ok: false });
    expect(env.dev.fc.injections.length).toBe(before);
  });

  it('uses the tab’s real URL: a page that navigated away gets no suggestions or fill', async () => {
    await env.session.unlock(MASTER);
    const shop = await env.session.saveItem(login('Shop', 'ann', 'shop-secret', 'https://shop.example.com'));
    env.dev.fc.setTab(TAB, 'https://evil.example.net/');
    expect(await env.send({ type: 'inline.suggest' }, tabSender('https://shop.example.com/login'))).toEqual({ show: false });
    const before = env.dev.fc.injections.length;
    expect(await env.send({ type: 'inline.fill', itemId: shop }, tabSender('https://shop.example.com/login'))).toMatchObject({ ok: false });
    expect(env.dev.fc.injections.length).toBe(before);
  });

  it('http matches are listed as not secure and need the popup to fill', async () => {
    await env.session.unlock(MASTER);
    const id = await env.session.saveItem(login('Router', 'admin', 'router-secret', 'http://router.example.com'));
    env.dev.fc.setTab(TAB, 'http://router.example.com/');
    const r = await env.send({ type: 'inline.suggest' }, tabSender('http://router.example.com/'));
    expect((r as { items: Array<{ insecure: boolean }> }).items[0]!.insecure).toBe(true);
    expect(await env.send({ type: 'inline.fill', itemId: id }, tabSender('http://router.example.com/'))).toMatchObject({ ok: false, message: expect.stringContaining('popup') });
  });

  it('refuses frames, other extensions, PassVault’s own pages, and when off or without permission', async () => {
    await env.session.unlock(MASTER);
    await env.session.saveItem(login('Shop', 'ann', 'shop-secret', 'https://shop.example.com'));
    env.dev.fc.setTab(TAB, 'https://shop.example.com/login');
    const msg = { type: 'inline.suggest' };
    expect(await env.send(msg, tabSender('https://shop.example.com/login', TAB, 4))).toBeNull();
    expect(await env.send(msg, { ...tabSender('https://shop.example.com/login'), id: 'other' })).toBeNull();
    expect(await env.send(msg, senders.popup)).toBeNull();
    expect(await env.send({ type: 'inline.suggest', extra: 1 }, tabSender('https://shop.example.com/login'))).toBeNull();
    expect(await env.send(msg, tabSender('http://localhost:5173/login'))).toEqual({ show: false });
    await env.dev.fc.chrome.storage.local.set({ [INLINE_ENABLED_KEY]: false });
    expect(await env.send(msg, tabSender('https://shop.example.com/login'))).toEqual({ show: false });
    await env.dev.fc.chrome.storage.local.set({ [INLINE_ENABLED_KEY]: true });
    env.setPermission(false);
    expect(await env.send(msg, tabSender('https://shop.example.com/login'))).toEqual({ show: false });
  });

  it('caps the list and is toggled from the popup only', async () => {
    await env.session.unlock(MASTER);
    for (let i = 0; i < MAX_SUGGESTIONS + 3; i++) await env.session.saveItem(login(`Shop ${i}`, `u${i}`, `p${i}`, 'https://shop.example.com'));
    env.dev.fc.setTab(TAB, 'https://shop.example.com/');
    const r = await env.send({ type: 'inline.suggest' }, tabSender('https://shop.example.com/'));
    expect((r as { items: unknown[] }).items).toHaveLength(MAX_SUGGESTIONS);
    expect(unwrap<{ inline: boolean }>(await env.popup({ type: 'inline.set', enabled: false })).inline).toBe(false);
    expect(isInlineMessage({ type: 'inline.suggest' })).toBe(true);
    expect(isInlineMessage({ type: 'savePrompt.pending' })).toBe(false);
  });
});
