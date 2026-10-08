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
