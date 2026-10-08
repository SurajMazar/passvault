import { KeyValueStore } from '@passvault/sync';
import type { BiometricUnlockAdapter, FileAdapter, Platform, TokenStorage } from '@passvault/vault-core';
import type { HelperClient } from '../ipc/helper-client';
import { HelperError } from '../ipc/helper-client';
import type { NeutralinoLike } from '../neutralino';
import { b64ToBytes, b64ToUtf8, bytesToB64, utf8ToB64 } from '../util/b64';
import { DesktopClipboard } from './clipboard';
import { openExternalConfirmed, type ExternalLinkDeps } from './links';
import { cachePrefix, neutralinoKV, neutralinoPrefs } from './storage';

/** Keychain account of the API session token (service io.passvault.desktop, non-biometric). */
export const SESSION_TOKEN_ACCOUNT = 'pv.session';

/** Keychain account for the biometric-protected device unlock key. */
export function biometricAccount(userId: string): string {
  const part = userId.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 56);
  return `pv.bio.${part || 'user'}`;
}

function isNotFound(e: unknown) {
  return e instanceof HelperError && e.code === 'not_found';
}

/** Keychain account of the session token for one server (per-server isolation). */
export function sessionTokenAccount(serverScope?: string): string {
  return serverScope ? `${SESSION_TOKEN_ACCOUNT}.${serverScope.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)}` : SESSION_TOKEN_ACCOUNT;
}

export function helperTokenStorage(helper: HelperClient, settleMs = 8000, account = SESSION_TOKEN_ACCOUNT): TokenStorage {
  // If the helper (Keychain) is unavailable the token lives only in memory for
  // this run: the user signs in again next launch. It is never written to
  // Neutralino storage or localStorage.
  let memory: string | null = null;
  return {
    async get() {
      await helper.waitUntilSettled(settleMs);
      if (!helper.isReady) return memory;
      try {
        const r = await helper.request<{ secretB64: string }>('keychain.get', { account, reason: '' });
        memory = b64ToUtf8(r.secretB64);
        return memory;
      } catch (e) {
        if (isNotFound(e)) return null;
        return memory;
      }
    },
    async set(token) {
      memory = token;
      if (!helper.isReady) return;
      try {
        await helper.request('keychain.set', { account, secretB64: utf8ToB64(token), biometric: false });
      } catch {
        /* keep the in-memory copy; never fall back to a file */
      }
    },
    async clear() {
      memory = null;
      if (!helper.isReady) return;
      try {
        await helper.request('keychain.delete', { account });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
  };
}

export function helperBiometrics(helper: HelperClient): BiometricUnlockAdapter {
  return {
    async status() {
      if (!helper.isReady) return { available: false, reason: 'The PassVault desktop helper is not running' };
      try {
        const s = await helper.request<{ available: boolean; reason: string }>('biometric.status', {});
        return { available: !!s.available, reason: s.reason || undefined };
      } catch (e) {
        return { available: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    async storeKey(accountId, key) {
      await helper.request('keychain.set', { account: biometricAccount(accountId), secretB64: bytesToB64(key), biometric: true });
    },
    async retrieveKey(accountId, reason) {
      try {
        const r = await helper.request<{ secretB64: string }>('keychain.get', { account: biometricAccount(accountId), reason: reason.slice(0, 200) });
        return b64ToBytes(r.secretB64);
      } catch (e) {
        if (e instanceof HelperError && e.code === 'denied') throw new Error('Touch ID was cancelled or did not match');
        if (isNotFound(e)) throw new Error('Touch ID unlock is not set up on this Mac. Unlock with your master password.');
        throw e;
      }
    },
    async removeKey(accountId) {
      try {
        await helper.request('keychain.delete', { account: biometricAccount(accountId) });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
  };
}

function basename(p: string) {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

export function isFileExistsError(e: unknown): boolean {
  return e instanceof HelperError && e.code === 'denied' && /file exists/i.test(e.message);
}

export function helperFiles(nl: NeutralinoLike, helper: HelperClient): FileAdapter {
  return {
    async pickTextFile({ title, maxBytes, extensions }) {
      const filters = extensions?.length ? [{ name: 'Supported files', extensions }, { name: 'All files', extensions: ['*'] }] : undefined;
      const paths = await nl.os.showOpenDialog(title, { multiSelections: false, ...(filters ? { filters } : {}) });
      const path = paths?.[0];
      if (!path) return null;
      const r = await helper.request<{ contentB64: string; size: number }>('fs.readImport', { path, maxBytes });
      return { name: basename(path), text: b64ToUtf8(r.contentB64) };
    },
    async saveTextFile({ suggestedName, text }) {
      // The macOS save panel itself asks "… already exists. Do you want to replace it?".
      const path = await nl.os.showSaveDialog('Export', { defaultPath: suggestedName });
      if (!path) return { saved: false };
      const contentB64 = utf8ToB64(text);
      try {
        await helper.request('fs.writeExport', { path, contentB64, overwrite: false });
      } catch (e) {
        // Only replace an existing file after the save panel's replace confirmation.
        if (!isFileExistsError(e)) throw e;
        await helper.request('fs.writeExport', { path, contentB64, overwrite: true });
      }
      return { saved: true, location: path, ownerOnly: true };
    },
  };
}

export interface DesktopPlatformDeps {
  nl: NeutralinoLike;
  helper: HelperClient;
  apiBaseUrl: string;
  webAppUrl: string;
  deviceName: string;
  clipboard: DesktopClipboard;
  confirmLink: ExternalLinkDeps['confirm'];
  /** Namespace for per-server storage (see servers.ts). Omit for the legacy single-server layout. */
  serverScope?: string;
}

export function createDesktopPlatform(d: DesktopPlatformDeps): Platform {
  const kv = neutralinoKV(d.nl);
  const stores = new Map<string, KeyValueStore>();
  return {
    clientType: 'desktop',
    deviceName: d.deviceName,
    apiBaseUrl: d.apiBaseUrl,
    webAppUrl: d.webAppUrl,
    tokens: helperTokenStorage(d.helper, 8000, sessionTokenAccount(d.serverScope)),
    prefs: neutralinoPrefs(kv, d.serverScope),
    createCacheStore(scope) {
      const prefix = cachePrefix(d.serverScope ? `${d.serverScope}:${scope}` : scope);
      if (!stores.has(prefix)) stores.set(prefix, new KeyValueStore(kv, prefix));
      return stores.get(prefix)!;
    },
    clipboard: d.clipboard,
    files: helperFiles(d.nl, d.helper),
    biometrics: helperBiometrics(d.helper),
    async openExternal(url) {
      await openExternalConfirmed(url, { confirm: d.confirmLink, open: (u) => d.nl.os.open(u) });
    },
  };
}
