import type { KeyValueBackend } from '@passvault/sync';
import type { PrefsStorage } from '@passvault/vault-core';
import { nlErrorCode, type NeutralinoLike } from '../neutralino';

/**
 * Neutralino storage keys must match ^[a-zA-Z-_0-9]{1,50}$ (one file per key
 * under ~/Library/Application Support/<applicationId>/.storage). We only use
 * [A-Za-z0-9_] to stay well inside that pattern.
 */
export const STORAGE_KEY_RE = /^[A-Za-z0-9_]{1,50}$/;

export function sanitizeKeyPart(raw: string, max: number): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '_').slice(0, max);
}

/** Small, stable, non-cryptographic 53-bit string hash (cyrb53). */
export function stableHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * Per-account prefix for the encrypted cache. KeyValueStore appends
 * `_account`, `_records`, … (≤ 8 chars), so the prefix is kept ≤ 40 chars.
 */
export function cachePrefix(accountScope: string): string {
  const slug = sanitizeKeyPart(accountScope.toLowerCase(), 20);
  return `pvc_${slug}_${stableHash(accountScope.toLowerCase())}`;
}

export function prefKey(name: string): string {
  const k = `pvp_${sanitizeKeyPart(name, 32)}`;
  return name.length > 32 || /[^A-Za-z0-9_]/.test(name) ? `pvp_${sanitizeKeyPart(name, 24)}_${stableHash(name).slice(0, 8)}` : k;
}

function assertKey(key: string) {
  if (!STORAGE_KEY_RE.test(key)) throw new Error(`invalid storage key`);
}

/** KeyValueBackend over Neutralino storage. Values are stored as given (the cache only ever holds ciphertext). */
export function neutralinoKV(nl: NeutralinoLike): KeyValueBackend {
  return {
    async get(key) {
      assertKey(key);
      try {
        return await nl.storage.getData(key);
      } catch (e) {
        if (nlErrorCode(e) === 'NE_ST_NOSTKEX') return null;
        throw e;
      }
    },
    async set(key, value) {
      assertKey(key);
      await nl.storage.setData(key, value);
    },
    async remove(key) {
      assertKey(key);
      try {
        await nl.storage.removeData(key);
      } catch (e) {
        if (nlErrorCode(e) === 'NE_ST_NOSTKEX' || nlErrorCode(e) === 'NE_ST_STKEYRE') return;
        throw e;
      }
    },
  };
}

export function neutralinoPrefs(kv: KeyValueBackend, serverScope?: string): PrefsStorage {
  const key = (k: string) => prefKey(serverScope ? `${serverScope}_${k}` : k);
  return {
    get: (k) => kv.get(key(k)).catch(() => null),
    set: (k, v) => kv.set(key(k), v),
    remove: (k) => kv.remove(key(k)),
  };
}
