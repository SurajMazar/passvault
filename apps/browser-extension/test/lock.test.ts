import { afterEach, describe, expect, it } from 'vitest';
import { AUTOLOCK_ALARM, CLIPBOARD_ALARM, CLIPBOARD_PENDING_KEY, RESUME_KEY } from '../src/background/controller';
import { TOKEN_KEY } from '../src/background/platform';
import { OFFSCREEN_TARGET } from '../src/shared/constants';
import type { ItemSummary, PopupState } from '../src/shared/protocol';
import { MASTER, login, offlineDevice, startWorker, stopAllWorkers, unwrap } from './helpers';

afterEach(stopAllWorkers);

async function unlockedWorker() {
  const dev = await offlineDevice();
  const w = await startWorker(dev);
  unwrap(await w.send({ type: 'auth.unlock', password: MASTER }));
  await w.session.saveItem(login('Example', 'alice', 'pw-example-123', 'https://example.com'));
  return { dev, ...w };
}

describe('lock behaviour', () => {
  it('unlock stores the resume key in chrome.storage.session (trusted contexts) and arms the inactivity alarm', async () => {
    const { dev } = await unlockedWorker();
    expect(dev.fc.session.accessLevel).toBe('TRUSTED_CONTEXTS');
    expect(typeof dev.fc.session.data.get(RESUME_KEY)).toBe('string');
    expect(dev.fc.alarms.get(AUTOLOCK_ALARM)?.delayInMinutes).toBe(15); // default lockTimeoutMinutes
    // Nothing secret goes to chrome.storage.local (only device prefs; no session token offline).
    const local = JSON.stringify([...dev.fc.local.data.entries()]);
    expect(local).not.toContain('pw-example-123');
    expect(local).not.toContain(dev.fc.session.data.get(RESUME_KEY) as string);
    expect(dev.fc.local.data.has(TOKEN_KEY)).toBe(false);
    // Unlocked from the offline cache without a server session: the popup shows "Offline".
    const { send } = await startWorker(dev);
    expect(unwrap<PopupState>(await send({ type: 'state.get' }))).toMatchObject({ phase: 'unlocked', hasSession: false });
  });

  it('locking clears the storage.session key, calls session.lock, and privileged requests then fail with locked', async () => {
    const { dev, send, session } = await unlockedWorker();
    const state = unwrap<PopupState>(await send({ type: 'auth.lock' }));
    expect(state.phase).toBe('locked');
    expect(session.isUnlocked).toBe(false);
    expect(dev.fc.session.data.has(RESUME_KEY)).toBe(false);
    expect(dev.fc.alarms.has(AUTOLOCK_ALARM)).toBe(false);
    for (const m of [{ type: 'vault.list' }, { type: 'vault.matches', tabId: 1 }, { type: 'item.get', id: 'x' }, { type: 'autofill.fill', tabId: 1, itemId: 'x', confirmInsecure: false }, { type: 'autofill.capture', tabId: 1 }]) {
      expect(await send(m)).toMatchObject({ ok: false, error: { code: 'locked' } });
    }
  });

  it('the inactivity alarm locks the vault', async () => {
    const { dev, send, controller } = await unlockedWorker();
    // Activity re-arms the alarm.
    dev.fc.alarms.delete(AUTOLOCK_ALARM);
    unwrap(await send({ type: 'vault.list' }));
    expect(dev.fc.alarms.has(AUTOLOCK_ALARM)).toBe(true);
    await controller.onAlarm({ name: AUTOLOCK_ALARM });
    expect(unwrap<PopupState>(await send({ type: 'state.get' })).phase).toBe('locked');
    expect(dev.fc.session.data.has(RESUME_KEY)).toBe(false);
    expect(await send({ type: 'vault.list' })).toMatchObject({ ok: false, error: { code: 'locked' } });
  });

  it('resumes after a simulated service-worker restart when the key is present', async () => {
    const { dev } = await unlockedWorker();
    // New worker instance: fresh VaultSession, same chrome.storage + IndexedDB.
    const w2 = await startWorker(dev);
    expect(w2.session.isUnlocked).toBe(true);
    const list = unwrap<{ items: ItemSummary[] }>(await w2.send({ type: 'vault.list' }));
    expect(list.items.map((i) => i.title)).toEqual(['Example']);
  });

  it('does not resume when the key is absent (browser restart clears storage.session)', async () => {
    const { dev } = await unlockedWorker();
    dev.fc.session.data.clear();
    const w2 = await startWorker(dev);
    expect(w2.session.isUnlocked).toBe(false);
    expect(unwrap<PopupState>(await w2.send({ type: 'state.get' })).phase).toBe('locked');
    expect(await w2.send({ type: 'vault.list' })).toMatchObject({ ok: false, error: { code: 'locked' } });
  });

  it('discards an invalid resume key and stays locked', async () => {
    const { dev } = await unlockedWorker();
    await dev.fc.session.set({ [RESUME_KEY]: btoa('x'.repeat(32)) });
    const w2 = await startWorker(dev);
    expect(w2.session.isUnlocked).toBe(false);
    expect(dev.fc.session.data.has(RESUME_KEY)).toBe(false);
  });

  it('an alarm delivered to a restarted worker locks it', async () => {
    const { dev } = await unlockedWorker();
    const w2 = await startWorker(dev);
    expect(w2.session.isUnlocked).toBe(true);
    await w2.controller.onAlarm({ name: AUTOLOCK_ALARM });
    expect(w2.session.isUnlocked).toBe(false);
    expect(dev.fc.session.data.has(RESUME_KEY)).toBe(false);
    const w3 = await startWorker(dev);
    expect(w3.session.isUnlocked).toBe(false);
  });

  it('schedules clipboard clearing (>= 30s alarm) and clears immediately on lock', async () => {
    const { dev, send } = await unlockedWorker();
    const r = unwrap<{ scheduled: boolean; seconds: number }>(await send({ type: 'clipboard.scheduleClear' }));
    expect(r).toEqual({ scheduled: true, seconds: 30 });
    const alarm = dev.fc.alarms.get(CLIPBOARD_ALARM)!;
    expect(alarm.scheduledTime - Date.now()).toBeGreaterThan(29_000);
    expect(dev.fc.session.data.get(CLIPBOARD_PENDING_KEY)).toBe(true);
    unwrap(await send({ type: 'auth.lock' }));
    expect(dev.fc.offscreenCalls).toEqual(['create', 'close']);
    expect(dev.fc.sentMessages).toEqual([{ target: OFFSCREEN_TARGET, type: 'clipboard.clear' }]);
    expect(dev.fc.alarms.has(CLIPBOARD_ALARM)).toBe(false);
    expect(dev.fc.session.data.has(CLIPBOARD_PENDING_KEY)).toBe(false);
  });

  it('the clipboard alarm clears via the offscreen document', async () => {
    const { dev, send, controller } = await unlockedWorker();
    unwrap(await send({ type: 'clipboard.scheduleClear' }));
    await controller.onAlarm({ name: CLIPBOARD_ALARM });
    expect(dev.fc.sentMessages).toEqual([{ target: OFFSCREEN_TARGET, type: 'clipboard.clear' }]);
    expect(JSON.stringify(dev.fc.sentMessages)).not.toContain('pw-example');
  });

  it('logout removes the resume key and returns to signed out', async () => {
    const { dev, send } = await unlockedWorker();
    const st = unwrap<PopupState>(await send({ type: 'auth.logout' }));
    expect(st.phase).toBe('signed_out');
    expect(dev.fc.session.data.has(RESUME_KEY)).toBe(false);
  });
});
