import { afterEach, describe, expect, it } from 'vitest';
import { checkSender } from '../src/background/sender';
import type { ItemSummary, PopupState } from '../src/shared/protocol';
import { MASTER, fakeChrome, login, offlineDevice, senders, startWorker, stopAllWorkers, unwrap } from './helpers';

afterEach(stopAllWorkers);

describe('sender validation', () => {
  const { chrome } = fakeChrome();
  it('accepts only the popup page for privileged requests', () => {
    expect(checkSender(chrome, senders.popup, true)).toEqual({ ok: true });
    expect(checkSender(chrome, { ...senders.popup, url: `${senders.popup.url}?x=1` }, true)).toEqual({ ok: true });
    expect(checkSender(chrome, senders.offscreenPage, true)).toMatchObject({ ok: false, reason: 'not_popup' });
    expect(checkSender(chrome, senders.lookalikePath, true)).toMatchObject({ ok: false, reason: 'not_popup' });
    expect(checkSender(chrome, { ...senders.popup, frameId: 3 }, true)).toMatchObject({ ok: false });
  });
  it('rejects other extensions, tabs and pages without an extension URL', () => {
    expect(checkSender(chrome, senders.foreignExtension, false)).toMatchObject({ ok: false, reason: 'foreign_extension' });
    expect(checkSender(chrome, senders.contentScript, false)).toMatchObject({ ok: false, reason: 'tab_context' });
    expect(checkSender(chrome, senders.popupInTab, true)).toMatchObject({ ok: false, reason: 'tab_context' });
    expect(checkSender(chrome, senders.noUrl, false)).toMatchObject({ ok: false, reason: 'not_extension_page' });
    expect(checkSender(chrome, undefined, false)).toMatchObject({ ok: false });
    expect(checkSender(chrome, { id: senders.popup.id, url: 'https://example.com/popup.html' }, false)).toMatchObject({ ok: false, reason: 'not_extension_page' });
    expect(checkSender(chrome, { ...senders.popup, origin: 'https://evil.test' }, true)).toMatchObject({ ok: false });
    // Opaque-origin pages (data:, sandboxed) must never pass as an extension page.
    expect(checkSender(chrome, { id: senders.popup.id, url: 'data:text/html,popup.html' }, true)).toMatchObject({ ok: false, reason: 'not_extension_page' });
    expect(checkSender(chrome, { id: senders.popup.id, url: `chrome-extension://${senders.popup.id}x/popup.html` }, true)).toMatchObject({ ok: false });
    // Unprivileged requests are fine from any of our own pages.
    expect(checkSender(chrome, senders.offscreenPage, false)).toEqual({ ok: true });
  });
});

describe('message protocol', () => {
  it('rejects malformed messages', async () => {
    const dev = await offlineDevice();
    const { send } = await startWorker(dev);
    const bad: unknown[] = [
      null,
      undefined,
      'state.get',
      42,
      [],
      {},
      { type: 'nope' },
      { type: 'auth.login' },
      { type: 'auth.login', email: 'a@b.c', password: '' },
      { type: 'auth.login', email: 'a@b.c', password: 'x', extra: true },
      { type: 'auth.mfaVerify', code: 'abc', trustDevice: false },
      { type: 'auth.mfaVerify', code: '123456', recoveryCode: 'abcd-efgh', trustDevice: false },
      { type: 'vault.matches', tabId: -1 },
      { type: 'vault.matches', tabId: '1' },
      { type: 'item.secret', id: 'x', field: 'privateKey' },
      { type: 'autofill.fill', tabId: 1, itemId: 'x' },
      { type: 'item.updatePassword', confirmed: false, id: 'x', password: 'y' },
      { type: 'item.saveLogin', confirmed: true, draft: { title: 't' } },
      { type: 'generator.generate', kind: 'password', length: 4 },
    ];
    for (const m of bad) {
      const r = await send(m);
      expect(r.ok, JSON.stringify(m)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_message');
    }
  });

  it('rejects senders that are not this extension, tabs/content scripts, and non-popup pages for privileged ops', async () => {
    const dev = await offlineDevice();
    const { send } = await startWorker(dev);
    for (const sender of [senders.foreignExtension, senders.contentScript, senders.popupInTab, senders.noUrl]) {
      const r = await send({ type: 'ping' }, sender);
      expect(r).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    for (const sender of [senders.offscreenPage, senders.lookalikePath, senders.contentScript]) {
      for (const m of [{ type: 'state.get' }, { type: 'auth.unlock', password: MASTER }, { type: 'vault.list' }, { type: 'autofill.fill', tabId: 1, itemId: 'x', confirmInsecure: true }]) {
        expect(await send(m, sender)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      }
    }
    // A forbidden unlock attempt must not have unlocked anything.
    expect(unwrap<PopupState>(await send({ type: 'state.get' })).phase).toBe('locked');
    // ping is the only request other extension pages may make.
    expect(await send({ type: 'ping' }, senders.offscreenPage)).toMatchObject({ ok: true, data: { version: '0.1.0' } });
  });

  it('lists summaries without secrets; detail is popup-only', async () => {
    const dev = await offlineDevice();
    const { send, session } = await startWorker(dev);
    unwrap(await send({ type: 'auth.unlock', password: MASTER }));
    const id = await session.saveItem(login('Bank', 'alice', 'S3cret-Pass-Value', 'https://bank.example.com'));
    const list = unwrap<{ items: ItemSummary[] }>(await send({ type: 'vault.list' }));
    expect(list.items.map((i) => i.title)).toEqual(['Bank']);
    expect(JSON.stringify(list)).not.toContain('S3cret-Pass-Value');
    expect(await send({ type: 'item.get', id }, senders.offscreenPage)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    const detail = unwrap<{ fields: Array<{ key: string; value: string; secret: boolean }> }>(await send({ type: 'item.get', id }));
    expect(detail.fields.find((f) => f.key === 'password')).toMatchObject({ value: 'S3cret-Pass-Value', secret: true });
    expect(await send({ type: 'item.get', id: 'missing' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('wrong master password is reported without unlocking', async () => {
    const dev = await offlineDevice();
    const { send } = await startWorker(dev);
    expect(await send({ type: 'auth.unlock', password: 'not the password' })).toMatchObject({ ok: false, error: { code: 'wrong_password' } });
    expect(dev.fc.session.data.size).toBe(0);
  });

  it('saves a login only with explicit confirmation and updates passwords of existing logins', async () => {
    const dev = await offlineDevice();
    const { send, session } = await startWorker(dev);
    unwrap(await send({ type: 'auth.unlock', password: MASTER }));
    const draft = { title: 'Example', username: 'bob', password: 'pw-1-Initial', url: 'https://example.com/login', match: 'host', notes: '', folder: 'Work', tags: ['a', 'a', ' b '], projectId: null };
    expect(await send({ type: 'item.saveLogin', draft })).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(await send({ type: 'item.saveLogin', confirmed: true, draft: { ...draft, url: 'javascript:alert(1)' } })).toMatchObject({ ok: false });
    const { id } = unwrap<{ id: string }>(await send({ type: 'item.saveLogin', confirmed: true, draft }));
    const saved = session.getSnapshot().items.find((i) => i.id === id)!;
    expect(saved.payload.type).toBe('login');
    if (saved.payload.type === 'login') {
      expect(saved.payload.fields.urls).toEqual([{ url: 'https://example.com', match: 'host' }]);
      expect(saved.payload.tags).toEqual(['a', 'b']);
    }
    unwrap(await send({ type: 'item.updatePassword', confirmed: true, id, password: 'pw-2-Rotated' }));
    const after = session.getSnapshot().items.find((i) => i.id === id)!;
    expect(after.payload.type === 'login' && after.payload.fields.password).toBe('pw-2-Rotated');
  });

  it('capture reports existing logins for the same origin and username', async () => {
    const dev = await offlineDevice();
    const { send, session } = await startWorker(dev);
    unwrap(await send({ type: 'auth.unlock', password: MASTER }));
    await session.saveItem(login('Example', 'bob', 'old-password', 'https://example.com'));
    dev.fc.setTab(5, 'https://example.com/signin');
    dev.fc.setScriptResult(() => [
      { frameId: 0, result: { code: 'ok', origin: 'https://example.com', url: 'https://example.com/signin', title: 'Sign in', username: 'Bob', password: 'new-password', foundPasswordField: true } },
    ]);
    const cap = unwrap<{ existing: Array<{ passwordDiffers: boolean }>; suggestedTitle: string; password: string }>(await send({ type: 'autofill.capture', tabId: 5 }));
    expect(cap.suggestedTitle).toBe('example.com');
    expect(cap.existing).toHaveLength(1);
    expect(cap.existing[0]!.passwordDiffers).toBe(true);
    expect(dev.fc.injections.at(-1)!.target).toEqual({ tabId: 5, frameIds: [0] });
    // A capture result from a different origin (page navigated) is refused.
    dev.fc.setScriptResult(() => [
      { frameId: 0, result: { code: 'ok', origin: 'https://evil.test', url: 'https://evil.test/', title: '', username: 'x', password: 'y', foundPasswordField: true } },
    ]);
    expect(await send({ type: 'autofill.capture', tabId: 5 })).toMatchObject({ ok: false, error: { code: 'refused' } });
    dev.fc.setTab(6, 'chrome://settings');
    expect(await send({ type: 'autofill.capture', tabId: 6 })).toMatchObject({ ok: false, error: { code: 'refused' } });
  });

  it('generates passwords and passphrases in the background', async () => {
    const dev = await offlineDevice();
    const { send } = await startWorker(dev);
    const p = unwrap<{ value: string; entropyBits: number }>(await send({ type: 'generator.generate', kind: 'password', length: 24 }));
    expect(p.value).toHaveLength(24);
    const pp = unwrap<{ value: string }>(await send({ type: 'generator.generate', kind: 'passphrase', words: 5, separator: '.' }));
    expect(pp.value.split('.')).toHaveLength(5);
  });
});
