import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelperClient, HelperError, describeHelperError } from '../src/ipc/helper-client';
import { FakeTransport, HELLO, SESSION, readyHelper } from './fakes';

afterEach(() => vi.useRealTimers());

describe('HelperClient', () => {
  it('rejects session-bound ops before hello and sends hello without a sessionId', async () => {
    const t = new FakeTransport();
    const h = new HelperClient(t, { clientVersion: '1.2.3' });
    await expect(h.request('ping')).rejects.toMatchObject({ code: 'helper_unavailable' });
    expect(t.sent).toHaveLength(0);
    t.auto.set('hello', HELLO);
    await h.hello();
    expect(t.sent[0]).toMatchObject({ v: 1, op: 'hello', params: { clientVersion: '1.2.3' } });
    expect(t.sent[0]!.sessionId).toBeUndefined();
    expect(h.status.state).toBe('ready');
  });

  it('binds requests to the session and correlates out-of-order responses', async () => {
    const { t, h } = await readyHelper();
    const a = h.request<{ n: number }>('agent.status', {});
    const b = h.request<{ n: number }>('ping', {});
    const [ra, rb] = [t.last('agent.status')!, t.last('ping')!];
    expect(ra.sessionId).toBe(SESSION);
    expect(rb.sessionId).toBe(SESSION);
    expect(ra.id).not.toBe(rb.id);
    expect(ra.id).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    t.reply(rb, { n: 2 });
    t.reply(ra, { n: 1 });
    await expect(a).resolves.toEqual({ n: 1 });
    await expect(b).resolves.toEqual({ n: 2 });
  });

  it('maps error responses to HelperError with the contract code', async () => {
    const { t, h } = await readyHelper();
    const p = h.request('ssh.connect', {});
    t.error(t.last('ssh.connect')!, 'auth_failed', 'nope');
    const e = (await p.catch((x: unknown) => x)) as HelperError;
    expect(e).toBeInstanceOf(HelperError);
    expect(e.code).toBe('auth_failed');
    expect(describeHelperError(e)).toMatch(/Authentication failed/);
  });

  it('times out unanswered requests and ignores late responses', async () => {
    vi.useFakeTimers();
    const { t, h } = await readyHelper();
    const p = h.request('ping', {}, { timeoutMs: 1000 });
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
    expect(() => t.reply(t.last('ping')!, {})).not.toThrow();
  });

  it('uses longer timeouts for interactive ops (keychain.get may show Touch ID)', async () => {
    vi.useFakeTimers();
    const { h } = await readyHelper();
    let settled = false;
    h.request('keychain.get', { account: 'pv.x', reason: '' }).catch(() => (settled = true));
    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(61_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('drops events from other (stale) sessions', async () => {
    const { t, h } = await readyHelper();
    const seen: unknown[] = [];
    h.on('ssh.data', (d) => seen.push(d));
    t.emit('ssh.data', { connId: 'c1', dataB64: 'aGk=' }, 'ffffffffffffffffffffffffffffffff');
    t.emit('ssh.data', { connId: 'c1', dataB64: 'aGk=' });
    expect(seen).toEqual([{ connId: 'c1', dataB64: 'aGk=' }]);
  });

  it('invalid_session ends the session and notifies listeners', async () => {
    const { t, h } = await readyHelper();
    const resets: string[] = [];
    h.onSessionReset((r) => resets.push(r));
    const p = h.request('ping');
    t.error(t.last('ping')!, 'invalid_session');
    await expect(p).rejects.toMatchObject({ code: 'invalid_session' });
    expect(resets).toEqual(['invalid_session']);
    expect(h.isReady).toBe(false);
    await expect(h.request('ping')).rejects.toMatchObject({ code: 'helper_unavailable' });
  });

  it('markUnavailable fails pending requests fast', async () => {
    const { h } = await readyHelper();
    const p = h.request('ssh.test', {});
    h.markUnavailable('gone');
    await expect(p).rejects.toMatchObject({ code: 'helper_unavailable' });
    expect(h.status).toMatchObject({ state: 'unavailable', reason: 'gone' });
  });

  it('a transport failure rejects with helper_unavailable', async () => {
    const { t, h } = await readyHelper();
    t.fail = true;
    await expect(h.request('ping')).rejects.toMatchObject({ code: 'helper_unavailable' });
  });

  it('a second hello resets the previous session', async () => {
    const { h } = await readyHelper();
    const resets: string[] = [];
    h.onSessionReset((r) => resets.push(r));
    await h.hello();
    expect(resets).toEqual(['new_session']);
    expect(h.status.generation).toBe(2);
  });

  it('rejects malformed hello responses', async () => {
    const t = new FakeTransport();
    t.auto.set('hello', { sessionId: 'not-hex' });
    const h = new HelperClient(t, { clientVersion: 'x' });
    await expect(h.hello()).rejects.toThrow(/Invalid hello/);
    expect(h.status.state).toBe('unavailable');
  });
});
