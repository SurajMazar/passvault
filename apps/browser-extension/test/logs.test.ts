import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/background/log';
import { MASTER, login, offlineDevice, senders, startWorker, stopAllWorkers } from './helpers';

afterEach(() => {
  stopAllWorkers();
  vi.restoreAllMocks();
});

const SECRETS = ['DUMMY-SECRET-PW-81723', 'wrong-master-DUMMY-55', 'CAPTURED-DUMMY-PW-93', 'UPDATED-DUMMY-PW-44', 'dummy-user@secret.test', MASTER];

describe('no secrets in logs', () => {
  it('handlers never log message payloads or secret values', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const dev = await offlineDevice();
    const { send, session } = await startWorker(dev, createLogger());

    await send({ type: 'auth.unlock', password: 'wrong-master-DUMMY-55' });
    await send({ type: 'auth.unlock', password: MASTER });
    const id = await session.saveItem(login('Example', 'dummy-user@secret.test', 'DUMMY-SECRET-PW-81723', 'https://example.com'));
    await send({ type: 'item.get', id });
    await send({ type: 'item.secret', id, field: 'password' });
    dev.fc.setTab(1, 'https://example.com/login');
    await send({ type: 'autofill.fill', tabId: 1, itemId: id, confirmInsecure: false });
    dev.fc.setTab(2, 'https://evil.test/');
    await send({ type: 'autofill.fill', tabId: 2, itemId: id, confirmInsecure: false });
    dev.fc.setScriptResult(() => [
      { frameId: 0, result: { code: 'ok', origin: 'https://example.com', url: 'https://example.com/login', title: 'x', username: 'dummy-user@secret.test', password: 'CAPTURED-DUMMY-PW-93', foundPasswordField: true } },
    ]);
    await send({ type: 'autofill.capture', tabId: 1 });
    await send({ type: 'item.updatePassword', confirmed: true, id, password: 'UPDATED-DUMMY-PW-44' });
    await send({ type: 'item.saveLogin', confirmed: true, draft: { title: 'T', username: 'dummy-user@secret.test', password: 'DUMMY-SECRET-PW-81723', url: 'https://x.test', match: 'host', notes: '', folder: '', tags: [], projectId: null } });
    // Malformed and forbidden messages carrying secrets.
    await send({ type: 'auth.unlock', password: 'DUMMY-SECRET-PW-81723', extra: 'CAPTURED-DUMMY-PW-93' });
    await send({ type: 'auth.unlock', password: 'DUMMY-SECRET-PW-81723' }, senders.contentScript);
    await send({ type: 'item.updatePassword', confirmed: true, id, password: 'UPDATED-DUMMY-PW-44' }, senders.offscreenPage);
    await send({ type: 'auth.lock' });

    const logged = spies.flatMap((s) => s.mock.calls).map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    expect(logged.length).toBeGreaterThan(0); // the logger is wired up
    for (const line of logged) for (const secret of SECRETS) expect(line).not.toContain(secret);
  });
});
