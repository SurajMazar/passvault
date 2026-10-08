import { IndexedDbStore, type CacheStore } from '@passvault/sync';
import type { Platform } from '@passvault/vault-core';
import type { ChromeLike } from './chrome-api';

export const TOKEN_KEY = 'pv.sessionToken';
export const PREF_PREFIX = 'pv.pref.';

/**
 * Extension Platform for the background service worker.
 *  - Session token: chrome.storage.local (a revocable bearer token; it cannot
 *    decrypt anything — see docs/EXTENSION.md).
 *  - Prefs: chrome.storage.local (device id, last email, trusted-device token).
 *  - Cache: one IndexedDB database per account (ciphertext only).
 *  - Clipboard/files are not available in a service worker; the popup copies
 *    directly and the background schedules clearing via an offscreen document.
 */
export function createExtensionPlatform(
  c: ChromeLike,
  opts: { apiBaseUrl: string; webAppUrl: string; createCacheStore?: (scope: string) => CacheStore; deviceName?: string },
): Platform {
  const local = c.storage.local;
  const getStr = async (k: string) => {
    const v = (await local.get(k))[k];
    return typeof v === 'string' ? v : null;
  };
  const stores = new Map<string, CacheStore>();
  return {
    clientType: 'extension',
    deviceName: opts.deviceName ?? deviceName(),
    apiBaseUrl: opts.apiBaseUrl,
    webAppUrl: opts.webAppUrl,
    tokens: {
      get: () => getStr(TOKEN_KEY),
      set: (t) => local.set({ [TOKEN_KEY]: t }),
      clear: () => local.remove(TOKEN_KEY),
    },
    prefs: {
      get: (k) => getStr(PREF_PREFIX + k),
      set: (k, v) => local.set({ [PREF_PREFIX + k]: v }),
      remove: (k) => local.remove(PREF_PREFIX + k),
    },
    createCacheStore: (scope) => {
      const name = `passvault-ext-${scope.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
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
  };
}

function deviceName() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : 'Browser';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser} extension${os ? ` on ${os}` : ''}`;
}
