import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newItem } from '@passvault/vault-core';
import type { FillResponse, MatchesResponse } from '../src/shared/protocol';
import { MASTER, login, offlineDevice, startWorker, stopAllWorkers, unwrap, type FakeChrome } from './helpers';

afterEach(stopAllWorkers);

let fc: FakeChrome;
let send: (m: unknown) => ReturnType<Awaited<ReturnType<typeof startWorker>>['send']>;
const ids: Record<string, string> = {};

beforeEach(async () => {
  const dev = await offlineDevice();
  fc = dev.fc;
  const w = await startWorker(dev);
  send = (m) => w.send(m);
  unwrap(await send({ type: 'auth.unlock', password: MASTER }));
  ids.host = await w.session.saveItem(login('Example', 'alice', 'pw-example', 'https://example.com', 'host'));
  ids.base = await w.session.saveItem(login('Example Net', 'carol', 'pw-net', 'https://example.net', 'base_domain'));
  ids.local = await w.session.saveItem(login('Local dev', 'dev', 'pw-local', 'http://localhost:8080', 'host'));
  ids.ssh = await w.session.saveItem(newItem('ssh_key', { title: 'Deploy key', fields: { publicKey: 'ssh-ed25519 AAAA', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----', fingerprint: 'SHA256:x', algorithm: 'ed25519' } }));
  ids.note = await w.session.saveItem(newItem('secure_note', { title: 'Note', fields: { content: 'top secret' } }));
  ids.trashed = await w.session.saveItem({ ...login('Old', 'old', 'pw-old', 'https://example.com'), trashedAt: new Date().toISOString() });
});

async function fill(url: string, itemId: string, confirmInsecure = false) {
  fc.setTab(1, url);
  const before = fc.injections.length;
  const r = unwrap<FillResponse>(await send({ type: 'autofill.fill', tabId: 1, itemId, confirmInsecure }));
  return { r, injected: fc.injections.length > before };
}

describe('autofill policy (background)', () => {
  it('fills a matching login into the top frame only, passing just the origin and credentials', async () => {
    const { r, injected } = await fill('https://example.com/login?next=/', ids.host!);
    expect(r).toEqual({ status: 'filled', filledUsername: true });
    expect(injected).toBe(true);
    const inj = fc.injections.at(-1)!;
    expect(inj.target).toEqual({ tabId: 1, frameIds: [0] });
    expect(inj.args).toEqual(['https://example.com', 'alice', 'pw-example']);
    expect(inj.func.name).toBe('pvFillCredentials');
  });

  it('refuses non-matching origins and lookalike domains without injecting', async () => {
    for (const url of [
      'https://example.com.evil.test/login',
      'https://evil-example.com/',
      'https://examp1e.com/',
      'https://sub.example.com/', // host mode: subdomains do not match
      'https://example.com:8443/',
      'https://example.org/',
    ]) {
      const { r, injected } = await fill(url, ids.host!);
      expect(r, url).toMatchObject({ status: 'refused', reason: 'no_match' });
      expect(injected).toBe(false);
    }
    for (const url of ['https://example.net.evil.test/', 'https://evil-example.net/', 'https://example.net-evil.test/']) {
      const { r, injected } = await fill(url, ids.base!);
      expect(r, url).toMatchObject({ status: 'refused', reason: 'no_match' });
      expect(injected).toBe(false);
    }
  });

  it('refuses javascript:, file:, chrome: and other non-web pages', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings/passwords', 'chrome-extension://abc/popup.html', 'about:blank', 'data:text/html,<form>', 'view-source:https://example.com', 'ftp://example.com/']) {
      const { r, injected } = await fill(url, ids.host!);
      expect(r, url).toMatchObject({ status: 'refused', reason: 'unsupported_page' });
      expect(injected).toBe(false);
    }
  });

  it('requires explicit confirmation for insecure (http) matches', async () => {
    const first = await fill('http://www.example.net/login', ids.base!);
    expect(first.r).toEqual({ status: 'needs_confirmation', reason: 'insecure', origin: 'http://www.example.net' });
    expect(first.injected).toBe(false);
    const confirmed = await fill('http://www.example.net/login', ids.base!, true);
    expect(confirmed.r.status).toBe('filled');
    // http://localhost saved as http is not flagged
    expect((await fill('http://localhost:8080/', ids.local!)).r.status).toBe('filled');
  });

  it('never injects SSH keys, notes or trashed items', async () => {
    for (const id of [ids.ssh!, ids.note!]) {
      const { r, injected } = await fill('https://example.com/', id);
      expect(r).toMatchObject({ status: 'refused', reason: 'not_login' });
      expect(injected).toBe(false);
    }
    expect((await fill('https://example.com/', ids.trashed!)).r).toMatchObject({ status: 'refused', reason: 'trashed' });
    expect(await send({ type: 'item.secret', id: ids.ssh, field: 'password' })).toMatchObject({ ok: false, error: { code: 'refused' } });
  });

  it('re-reads the tab URL at fill time and reports page-side origin mismatch', async () => {
    fc.setTab(1, 'https://example.com/');
    const m = unwrap<MatchesResponse>(await send({ type: 'vault.matches', tabId: 1 }));
    expect(m.matches.map((x) => x.id)).toEqual([ids.host]);
    expect(JSON.stringify(m)).not.toContain('pw-example');
    // The tab navigates before the user clicks Fill.
    const { r, injected } = await fill('https://evil.test/', ids.host!);
    expect(r).toMatchObject({ status: 'refused', reason: 'no_match' });
    expect(injected).toBe(false);
    // The page navigates between the check and the injection: the page-side guard refuses.
    fc.setScriptResult(() => [{ frameId: 0, result: { code: 'origin_mismatch', filledUsername: false } }]);
    expect((await fill('https://example.com/', ids.host!)).r).toMatchObject({ status: 'refused', reason: 'origin_changed' });
    fc.setScriptResult(() => [{ frameId: 0, result: { code: 'no_password_field', filledUsername: false } }]);
    expect((await fill('https://example.com/', ids.host!)).r).toMatchObject({ status: 'refused', reason: 'no_password_field' });
    fc.setScriptResult(() => [{ frameId: 0, result: 'garbage' }]);
    expect((await fill('https://example.com/', ids.host!)).r).toMatchObject({ status: 'refused', reason: 'injection_failed' });
  });

  it('reports pages it cannot see or fill in the matches list', async () => {
    fc.setTab(2, 'chrome://newtab/');
    expect(unwrap<MatchesResponse>(await send({ type: 'vault.matches', tabId: 2 })).tab).toMatchObject({ eligible: false, origin: null });
    expect(unwrap<MatchesResponse>(await send({ type: 'vault.matches', tabId: 99 })).tab.eligible).toBe(false);
    fc.setTab(3, 'http://example.net/');
    const m = unwrap<MatchesResponse>(await send({ type: 'vault.matches', tabId: 3 }));
    expect(m.tab.insecure).toBe(true);
    expect(m.matches[0]).toMatchObject({ id: ids.base, insecure: true });
  });
});
