import { createRegistrationMaterial, generateVaultKey, initCrypto, wrapVaultKeyForSelf } from '@passvault/crypto';
import { MemoryStore } from '@passvault/sync';
import type { AccountBundle, ItemPayload } from '@passvault/types';
import { VaultSession } from '@passvault/vault-core';
import type { ChromeLike, InjectionResultLike, SenderLike, StorageAreaLike, TabLike } from '../src/background/chrome-api';
import { BackgroundController } from '../src/background/controller';
import { createExtensionPlatform, PREF_PREFIX } from '../src/background/platform';

export const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const MASTER = 'correct horse battery';
const FAST = { opsLimit: 2, memLimitBytes: 32 * 1024 * 1024 };

export const senders = {
  popup: { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html`, origin: `chrome-extension://${EXT_ID}` } as SenderLike,
  offscreenPage: { id: EXT_ID, url: `chrome-extension://${EXT_ID}/offscreen.html`, origin: `chrome-extension://${EXT_ID}` } as SenderLike,
  contentScript: { id: EXT_ID, url: 'https://evil.test/login', origin: 'https://evil.test', tab: { id: 7 }, frameId: 0 } as SenderLike,
  popupInTab: { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html`, origin: `chrome-extension://${EXT_ID}`, tab: { id: 9 } } as SenderLike,
  foreignExtension: { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', url: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/popup.html' } as SenderLike,
  lookalikePath: { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html.evil`, origin: `chrome-extension://${EXT_ID}` } as SenderLike,
  noUrl: { id: EXT_ID } as SenderLike,
};

function area(): StorageAreaLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const keys = (k: string | string[]) => (Array.isArray(k) ? k : [k]);
  return {
    data,
    get: async (k) => Object.fromEntries(keys(k).filter((x) => data.has(x)).map((x) => [x, structuredClone(data.get(x))])),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    remove: async (k) => {
      for (const x of keys(k)) data.delete(x);
    },
  };
}

export type Injection = Parameters<ChromeLike['scripting']['executeScript']>[0];

/** Small in-memory fake of the chrome.* APIs the background uses. */
export function fakeChrome() {
  const local = area();
  const session = Object.assign(area(), { accessLevel: '' as string, setAccessLevel: async (o: { accessLevel: string }) => void (session.accessLevel = o.accessLevel) });
  const alarms = new Map<string, { name: string; scheduledTime: number; delayInMinutes?: number }>();
  const tabs = new Map<number, TabLike>();
  const injections: Injection[] = [];
  const sentMessages: unknown[] = [];
  const offscreenCalls: string[] = [];
  let offscreenOpen = false;
  const c = {
    runtime: {
      id: EXT_ID,
      getURL: (p: string) => `chrome-extension://${EXT_ID}/${p.replace(/^\//, '')}`,
      getManifest: () => ({ version: '0.1.0' }),
      sendMessage: async (m: unknown) => {
        sentMessages.push(m);
        return { ok: true };
      },
    },
    storage: { local, session },
    alarms: {
      create: async (name: string, info: { delayInMinutes?: number; when?: number }) => {
        alarms.set(name, { name, scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? 0) * 60_000, delayInMinutes: info.delayInMinutes });
      },
      clear: async (name: string) => alarms.delete(name),
      get: async (name: string) => alarms.get(name),
    },
    tabs: {
      get: async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw new Error('No tab with id');
        return { ...t };
      },
      create: async () => undefined,
    },
    scripting: {
      executeScript: async (inj: Injection): Promise<InjectionResultLike[]> => {
        injections.push(inj);
        return scriptResult(inj);
      },
    },
    offscreen: {
      createDocument: async () => {
        offscreenCalls.push('create');
        offscreenOpen = true;
      },
      closeDocument: async () => {
        offscreenCalls.push('close');
        offscreenOpen = false;
      },
      hasDocument: async () => offscreenOpen,
    },
  } satisfies ChromeLike;
  let scriptResult: (inj: Injection) => InjectionResultLike[] = () => [{ frameId: 0, result: { code: 'filled', filledUsername: true } }];
  return {
    chrome: c as ChromeLike,
    local,
    session,
    alarms,
    tabs,
    injections,
    sentMessages,
    offscreenCalls,
    setTab: (id: number, url: string) => tabs.set(id, { id, url }),
    setScriptResult: (fn: (inj: Injection) => InjectionResultLike[]) => {
      scriptResult = fn;
    },
  };
}

export type FakeChrome = ReturnType<typeof fakeChrome>;

/**
 * A device with an encrypted cached account (no server session). The same
 * chrome fake + store can be reused to simulate a service-worker restart.
 */
export async function offlineDevice() {
  await initCrypto();
  const reg = createRegistrationMaterial(MASTER, FAST);
  const personalVaultId = crypto.randomUUID();
  const vk = generateVaultKey();
  const account: AccountBundle = {
    user: { id: crypto.randomUUID(), email: 'demo@example.com', name: 'Demo', emailVerified: true, mfaEnabled: true, createdAt: new Date().toISOString() },
    kdf: reg.kdf,
    keys: {
      encryptedUserKey: reg.keys.encryptedUserKey,
      publicEncryptionKey: reg.keys.publicEncryptionKey,
      encryptedPrivateEncryptionKey: reg.keys.encryptedPrivateEncryptionKey,
      publicSigningKey: reg.keys.publicSigningKey,
      encryptedPrivateSigningKey: reg.keys.encryptedPrivateSigningKey,
      publicKeySignature: reg.keys.publicKeySignature,
    },
    personalVaultId,
    settings: { encryptedSettings: null, revision: 0 },
  };
  const store = new MemoryStore();
  await store.putAccount({ account, cachedAt: new Date().toISOString() });
  await store.putVaults([
    {
      vaultId: personalVaultId,
      type: 'personal',
      kind: null,
      role: 'owner',
      status: 'accepted',
      keyVersion: 1,
      encryptedVaultKey: wrapVaultKeyForSelf(reg.unlocked.userKey, vk, personalVaultId, 1),
      keySignature: null,
      grantedBy: null,
      allowResharing: false,
      expiresAt: null,
      rotationRequired: false,
      memberCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]);
  const fc = fakeChrome();
  await fc.local.set({ [`${PREF_PREFIX}lastEmail`]: 'demo@example.com' });
  return { store, fc };
}

const live: BackgroundController[] = [];
const liveSessions: VaultSession[] = [];

/** Start a background "service worker" (session + controller) on a device. */
export async function startWorker(dev: { store: MemoryStore; fc: FakeChrome }, log?: (e: string, d?: string) => void) {
  const platform = createExtensionPlatform(dev.fc.chrome, {
    apiBaseUrl: 'http://127.0.0.1:9', // unreachable: proves offline operation
    webAppUrl: 'http://localhost:5173',
    createCacheStore: () => dev.store,
    deviceName: 'test',
  });
  const session = new VaultSession(platform);
  const controller = new BackgroundController({ chrome: dev.fc.chrome, session, webUrl: 'http://localhost:5173', log });
  await controller.ready;
  live.push(controller);
  liveSessions.push(session);
  const send = (msg: unknown, sender: SenderLike = senders.popup) => controller.handleMessage(msg, sender);
  return { session, controller, send };
}

/** Lock every session started in a test (stops timers). */
export function stopAllWorkers() {
  for (const s of liveSessions.splice(0)) s.lock();
  live.splice(0);
}

export function login(title: string, username: string, password: string, url: string, match: 'host' | 'base_domain' | 'starts_with' | 'exact' = 'host'): ItemPayload {
  return {
    v: 1,
    type: 'login',
    title,
    description: '',
    notes: '',
    folder: '',
    tags: [],
    projectId: null,
    environment: null,
    favorite: false,
    archived: false,
    trashedAt: null,
    customFields: [],
    fields: { username, password, urls: [{ url, match }] },
  };
}

export function unwrap<T>(r: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.data as T;
}
