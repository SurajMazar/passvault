import { MemoryStore } from '@passvault/sync';
import { VaultSession, type Platform } from '@passvault/vault-core';
import { freshTotp, type Actor, type Env } from './actors';
import { registerSecret } from './results';

/**
 * A real client (vault-core VaultSession: client-side crypto, sync engine,
 * outbox) for an actor, with in-memory storage that the leakage suite can
 * inspect afterwards.
 */
export interface Client {
  session: VaultSession;
  stores: Map<string, MemoryStore>;
  prefs: Map<string, string>;
  token: () => string | null;
}

/**
 * Client fetch that waits out the API's rate limiter (429 + Retry-After), like
 * the raw harness client does: suites share one stack, so setup logins can hit
 * the per-IP auth budget left over from earlier suites. Rate limiting itself is
 * asserted by dedicated checks that use `noRetry`.
 */
const patientFetch: typeof fetch = async (input, init) => {
  // The waits can outlast the API client's 30 s request timeout; its abort signal is dropped
  // so a retry is not sent with an already-aborted signal.
  const { signal: _ignored, ...rest } = init ?? {};
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(input, rest);
    if (r.status !== 429 || attempt >= 8) return r;
    const wait = Math.min(65, Number(r.headers.get('retry-after')) || 10);
    await new Promise((res) => setTimeout(res, wait * 1000));
  }
};

export function clientFor(env: Env, deviceName = 'harness-client'): Client {
  const prefs = new Map<string, string>();
  let token: string | null = null;
  const stores = new Map<string, MemoryStore>();
  const platform: Platform = {
    clientType: 'cli',
    deviceName,
    apiBaseUrl: env.api.base,
    webAppUrl: 'http://127.0.0.1:4317',
    tokens: { get: async () => token, set: async (t) => void (token = t), clear: async () => void (token = null) },
    prefs: { get: async (k) => prefs.get(k) ?? null, set: async (k, v) => void prefs.set(k, v), remove: async (k) => void prefs.delete(k) },
    createCacheStore: (s) => (stores.get(s) ?? stores.set(s, new MemoryStore()).get(s))!,
    clipboard: { copySecret: async () => undefined, copyText: async () => undefined },
    files: { pickTextFile: async () => null, saveTextFile: async () => ({ saved: false }) },
    openExternal: async () => undefined,
    fetchImpl: patientFetch,
  };
  return { session: new VaultSession(platform), stores, prefs, token: () => token };
}

export async function signIn(env: Env, a: Actor, deviceName?: string): Promise<Client> {
  const c = clientFor(env, deviceName);
  await c.session.init();
  await c.session.login(a.email, a.password);
  await c.session.verifyMfa({ code: await freshTotp(a.totpSecret) });
  registerSecret(c.token());
  await c.session.syncNow();
  return c;
}

/** Serialized view of everything a client persisted (cache stores + prefs + token). */
export async function dumpClientStorage(c: Client): Promise<string> {
  const parts: string[] = [JSON.stringify([...c.prefs.entries()])];
  for (const [scope, store] of c.stores) {
    parts.push(scope, JSON.stringify(store, (_k, v) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v)));
  }
  return parts.join('\n');
}
