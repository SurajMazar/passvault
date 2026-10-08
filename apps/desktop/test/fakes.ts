import { HelperClient, type HelperTransport } from '../src/ipc/helper-client';
import type { RequestEnvelope } from '../src/ipc/types';

export const SESSION = '0123456789abcdef0123456789abcdef';

/** In-memory transport: records requests; tests answer them. */
export class FakeTransport implements HelperTransport {
  sent: RequestEnvelope[] = [];
  onResponse: (r: unknown) => void = () => undefined;
  onEvent: (e: unknown) => void = () => undefined;
  fail = false;
  /** auto-reply: op → result (or function) */
  auto = new Map<string, unknown | ((req: RequestEnvelope) => unknown)>();
  async send(req: RequestEnvelope) {
    if (this.fail) throw new Error('NE_EX_EXTNOTC');
    this.sent.push(req);
    if (this.auto.has(req.op)) {
      const a = this.auto.get(req.op);
      const result = typeof a === 'function' ? (a as (r: RequestEnvelope) => unknown)(req) : a;
      queueMicrotask(() => this.onResponse({ v: 1, id: req.id, ok: true, result }));
    }
  }
  subscribe(onResponse: (r: unknown) => void, onEvent: (e: unknown) => void) {
    this.onResponse = onResponse;
    this.onEvent = onEvent;
    return () => undefined;
  }
  reply(req: RequestEnvelope, result: unknown) {
    this.onResponse({ v: 1, id: req.id, ok: true, result });
  }
  error(req: RequestEnvelope, code: string, message = code) {
    this.onResponse({ v: 1, id: req.id, ok: false, error: { code, message } });
  }
  emit(type: string, data: unknown, sessionId = SESSION) {
    this.onEvent({ v: 1, sessionId, type, data });
  }
  ops() {
    return this.sent.map((r) => r.op);
  }
  last(op: string) {
    return [...this.sent].reverse().find((r) => r.op === op);
  }
}

export const HELLO = {
  sessionId: SESSION,
  helperVersion: '0.1.0-test',
  capabilities: { keychain: true, biometrics: { available: false, reason: 'unsigned' }, agent: true, terminal: true, systemEvents: true },
};

export async function readyHelper() {
  const t = new FakeTransport();
  t.auto.set('hello', HELLO);
  const h = new HelperClient(t, { clientVersion: 'test' });
  await h.hello();
  return { t, h };
}
