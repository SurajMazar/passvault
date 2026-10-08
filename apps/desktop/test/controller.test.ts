import { describe, expect, it, vi } from 'vitest';
import type { ItemPayload } from '@passvault/types';
import type { DecryptedItem } from '@passvault/vault-core';
import { DesktopController, LOCK_REASON, type SessionLike } from '../src/desktop/controller';
import { readyHelper } from './fakes';
import { server } from './items';

function fakeSession(items: DecryptedItem[]) {
  const lockFns = new Set<() => void>();
  const s: SessionLike & { locked: boolean } = {
    locked: false,
    get isUnlocked() {
      return !s.locked;
    },
    getSnapshot: () => ({ items }),
    updateItem: vi.fn(async (id: string, m: (p: ItemPayload) => ItemPayload | void) => {
      const it = items.find((i) => i.id === id)!;
      const c = structuredClone(it.payload);
      it.payload = m(c) ?? c;
    }),
    onLock: (fn) => {
      lockFns.add(fn);
      return () => lockFns.delete(fn);
    },
    lock: vi.fn(() => {
      if (s.locked) return;
      for (const f of lockFns) f();
      s.locked = true;
    }),
  };
  return s;
}

async function setup() {
  const { t, h } = await readyHelper();
  t.auto.set('ssh.connect', (r: { params: { connId: string } }) => ({ connId: r.params.connId }));
  t.auto.set('vault.locked', { closedConnections: 1, agentKeysRemoved: 0 });
  t.auto.set('agent.status', { running: false, socketPath: '/x', locked: true, keys: [] });
  t.auto.set('ssh.hostKeyDecision', {});
  t.auto.set('ssh.promptResponse', {});
  const ui = { goToTerminal: vi.fn(), openItem: vi.fn(), bringToFront: vi.fn() };
  const c = new DesktopController(h, ui);
  const host = { dispose: vi.fn(), disposeAll: vi.fn() };
  c.setTerminalHost(host);
  const srv = server({ host: 'prod.example.com' }, { environment: 'production' });
  const session = fakeSession([srv]);
  c.attachSession(session);
  return { t, h, c, ui, host, session, srv };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('desktop controller', () => {
  it('connect opens a production tab and sends one ssh.connect carrying the credentials', async () => {
    const { t, c, ui, srv } = await setup();
    const connId = await c.connect(srv.id);
    expect(ui.goToTerminal).toHaveBeenCalled();
    const req = t.last('ssh.connect')!;
    expect(req.params).toMatchObject({ connId, target: { host: 'prod.example.com', auth: { method: 'password', password: 'S3cret-pw' } }, cols: 120, rows: 32 });
    expect(c.store.get().tabs[0]).toMatchObject({ connId, production: true, endpoint: 'deploy@prod.example.com:22', phase: 'connecting' });
  });

  it('vault lock sends vault.locked, ends tabs with the lock reason and wipes terminals', async () => {
    const { t, c, host, session, srv } = await setup();
    const connId = (await c.connect(srv.id))!;
    t.emit('ssh.state', { connId, state: 'connected' });
    session.lock();
    await tick();
    expect(t.ops()).toContain('vault.locked');
    expect(c.store.get().tabs[0]).toMatchObject({ ended: true, phase: 'closed', endReason: LOCK_REASON });
    expect(host.disposeAll).toHaveBeenCalled();
    // input after lock is never sent
    c.write(connId, 'ls\r');
    expect(t.ops()).not.toContain('ssh.write');
  });

  it('screen lock and sleep events lock the vault', async () => {
    const { t, session } = await setup();
    t.emit('system.event', { type: 'screen_unlocked' });
    expect(session.lock).not.toHaveBeenCalled();
    t.emit('system.event', { type: 'screen_locked' });
    expect(session.lock).toHaveBeenCalledTimes(1);
    t.emit('system.event', { type: 'will_sleep' });
    expect(session.lock).toHaveBeenCalledTimes(2);
  });

  it('helper restart marks live tabs disconnected', async () => {
    const { t, h, c, srv } = await setup();
    const connId = (await c.connect(srv.id))!;
    t.emit('ssh.state', { connId, state: 'connected' });
    h.markUnavailable('gone');
    expect(c.store.get().tabs[0]).toMatchObject({ ended: true, endReason: expect.stringMatching(/helper/) });
  });

  it('host-key trust answers the helper and persists the key; error → closed keeps the code', async () => {
    const { t, c, session, srv } = await setup();
    const connId = (await c.connect(srv.id))!;
    t.emit('ssh.hostKey', { connId, hop: 'target', hostPort: 'prod.example.com:22', keyType: 'ssh-ed25519', publicKey: 'AAAA', fingerprint: 'SHA256:x', status: 'unknown', trusted: [] });
    const req = c.store.get().hostKeys[0]!;
    expect(req.kind).toBe('connect');
    await c.decideHostKey(req.id, true);
    expect(t.last('ssh.hostKeyDecision')!.params).toEqual({ connId, hop: 'target', trust: true });
    expect(session.updateItem).toHaveBeenCalledTimes(1);
    t.emit('ssh.state', { connId, state: 'error', code: 'auth_failed', message: 'bad' });
    t.emit('ssh.state', { connId, state: 'closed' });
    expect(c.store.get().tabs[0]).toMatchObject({ ended: true, phase: 'error', error: { code: 'auth_failed' } });
  });

  it('a host-key mismatch shows a dialog and never persists anything', async () => {
    const { t, c, session, srv } = await setup();
    const connId = (await c.connect(srv.id))!;
    t.emit('ssh.hostKey', { connId, hop: 'target', hostPort: 'prod.example.com:22', keyType: 'ssh-ed25519', publicKey: 'BBBB', fingerprint: 'SHA256:new', status: 'mismatch', trusted: ['SHA256:old'] });
    const req = c.store.get().hostKeys[0]!;
    expect(req.kind).toBe('mismatch');
    await c.decideHostKey(req.id, true);
    expect(session.updateItem).not.toHaveBeenCalled();
    expect(t.ops()).not.toContain('ssh.hostKeyDecision');
  });

  it('keyboard-interactive answers go back with the prompt id; the stored password is only read on demand', async () => {
    const { t, c, srv } = await setup();
    const connId = (await c.connect(srv.id))!;
    t.emit('ssh.prompt', { connId, promptId: 'p1', hop: 'target', name: '', instruction: '', questions: [{ text: 'Password:', echo: false }] });
    const p = c.store.get().prompts[0]!;
    expect(p.hasStoredPassword).toBe(true);
    expect(JSON.stringify(c.store.get().prompts)).not.toContain('S3cret-pw');
    expect(c.storedPasswordFor(p.id)).toBe('S3cret-pw');
    await c.answerPrompt(p.id, ['typed']);
    expect(t.last('ssh.promptResponse')!.params).toEqual({ connId, promptId: 'p1', answers: ['typed'] });
  });

  it('agent sign requests are queued and brought to front; decisions are forwarded', async () => {
    const { t, c, ui } = await setup();
    t.auto.set('agent.signDecision', {});
    const base = { keyId: 'k', keyName: 'key', fingerprint: 'SHA256:k', client: { pid: 1, processName: 'ssh' }, destination: { verified: false, note: 'n' }, forwarded: false };
    t.emit('agent.signRequest', { requestId: 'r1', ...base });
    t.emit('agent.signRequest', { requestId: 'r2', ...base });
    expect(c.store.get().signRequests.map((r) => r.requestId)).toEqual(['r1', 'r2']);
    expect(ui.bringToFront).toHaveBeenCalledTimes(2);
    await c.decideSign('r1', 'timed', 5);
    expect(t.last('agent.signDecision')!.params).toEqual({ requestId: 'r1', decision: 'timed', minutes: 5 });
    await c.decideSign('r2', 'once');
    expect(t.last('agent.signDecision')!.params).toEqual({ requestId: 'r2', decision: 'once' });
    expect(c.store.get().signRequests).toHaveLength(0);
  });

  it('resize is debounced', async () => {
    vi.useFakeTimers();
    try {
      const { t, c, srv } = await setup();
      const connId = (await c.connect(srv.id))!;
      t.auto.set('ssh.resize', {});
      c.resize(connId, 100, 30);
      c.resize(connId, 110, 31);
      c.resize(connId, 120, 40);
      vi.advanceTimersByTime(200);
      const resizes = t.sent.filter((r) => r.op === 'ssh.resize');
      expect(resizes).toHaveLength(1);
      expect(resizes[0]!.params).toEqual({ connId, cols: 120, rows: 40 });
    } finally {
      vi.useRealTimers();
    }
  });
});
