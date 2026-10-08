import { IndexedDbStore, type CacheStore } from '@passvault/sync';
import type { Platform } from '@passvault/vault-core';
import type { ChromeLike } from './chrome-api';
import { createTouchIdAdapter } from './touch-id';

/** Keys used before per-server storage (and by tests that pass no scope). */
export const LEGACY_TOKEN_KEY = 'pv.sessionToken';
export const LEGACY_PREF_PREFIX = 'pv.pref.';
export const TOKEN_KEY = LEGACY_TOKEN_KEY;
export const PREF_PREFIX = LEGACY_PREF_PREFIX;

/** Per-server storage keys (scope from servers.ts → serverScope). */
export const tokenKey = (scope?: string) => (scope ? `pv.${scope}.sessionToken` : LEGACY_TOKEN_KEY);
export const prefPrefix = (scope?: string) => (scope ? `pv.${scope}.pref.` : LEGACY_PREF_PREFIX);

/**
 * Extension Platform for the background service worker.
 *  - Session token: chrome.storage.local (a revocable bearer token; it cannot
 *    decrypt anything — see docs/EXTENSION.md).
 *  - Prefs: chrome.storage.local (device id, last email, trusted-device token).
 *  - Cache: one IndexedDB database per server and account (ciphertext only).
 *  - `scope` namespaces all of the above per server (see servers.ts).
 *  - Clipboard/files are not available in a service worker; the popup copies
 *    directly and the background schedules clearing via an offscreen document.
 */
export function createExtensionPlatform(
  c: ChromeLike,
  opts: { apiBaseUrl: string; webAppUrl: string; scope?: string; createCacheStore?: (scope: string) => CacheStore; deviceName?: string },
): Platform {
  const local = c.storage.local;
  const getStr = async (k: string) => {
    const v = (await local.get(k))[k];
    return typeof v === 'string' ? v : null;
  };
  const stores = new Map<string, CacheStore>();
  const TOKEN = tokenKey(opts.scope);
  const PREFS = prefPrefix(opts.scope);
  return {
    clientType: 'extension',
    deviceName: opts.deviceName ?? deviceName(),
    apiBaseUrl: opts.apiBaseUrl,
    webAppUrl: opts.webAppUrl,
    tokens: {
      get: () => getStr(TOKEN),
      set: (t) => local.set({ [TOKEN]: t }),
      clear: () => local.remove(TOKEN),
    },
    prefs: {
      get: (k) => getStr(PREFS + k),
      set: (k, v) => local.set({ [PREFS + k]: v }),
      remove: (k) => local.remove(PREFS + k),
    },
    createCacheStore: (scope) => {
      const account = scope.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const name = opts.scope ? `passvault-ext-${opts.scope}-${account}` : `passvault-ext-${account}`;
      let s = stores.get(name);
      if (!s) {
        s = opts.createCacheStore ? opts.createCacheStore(scope) : new IndexedDbStore(name);
        stores.set(name, s);
      }
      return s;
    },
    clipboard: {
      copyText: async () => {
        throw new Error('The background cannot access the clipboard; copy from the popup.');
      },
      copySecret: async () => {
        throw new Error('The background cannot access the clipboard; copy from the popup.');
      },
    },
    files: {
      pickTextFile: async () => null,
      saveTextFile: async () => ({ saved: false }),
    },
    openExternal: async (url) => {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web links can be opened');
      await c.tabs.create({ url: u.toString() });
    },
    biometrics: createTouchIdAdapter(c, opts.scope),
  };
}

function deviceName() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : 'Browser';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser} extension${os ? ` on ${os}` : ''}`;
}
