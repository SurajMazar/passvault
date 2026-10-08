import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@passvault/ui/styles.css';
import { PassVaultApp, type AuthRoute } from '@passvault/app';
import { IndexedDbStore } from '@passvault/sync';
import { BrowserClipboard, type Platform } from '@passvault/vault-core';

/**
 * Web platform adapter.
 *  - Session token: sessionStorage (cleared when the tab closes). The vault
 *    can still be unlocked offline from the encrypted IndexedDB cache.
 *  - Cache: IndexedDB, ciphertext only, one database per account.
 *  - No native capabilities (no biometrics, SSH, or agent) are bundled.
 */
const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function safeStorage(s: Storage) {
  return {
    get: async (k: string) => {
      try {
        return s.getItem(k);
      } catch {
        return null;
      }
    },
    set: async (k: string, v: string) => {
      try {
        s.setItem(k, v);
      } catch {
        /* storage blocked */
      }
    },
    remove: async (k: string) => {
      try {
        s.removeItem(k);
      } catch {
        /* storage blocked */
      }
    },
  };
}

const session = safeStorage(window.sessionStorage);
const prefs = safeStorage(window.localStorage);

// One IndexedDB database per account on this browser (ciphertext only).
const storeCache = new Map<string, IndexedDbStore>();

const platform: Platform = {
  clientType: 'web',
  deviceName: (() => {
    const ua = navigator.userAgent;
    const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    return `${browser}${os ? ` on ${os}` : ''}`;
  })(),
  apiBaseUrl,
  webAppUrl: window.location.origin,
  tokens: { get: () => session.get('pv-session'), set: (t) => session.set('pv-session', t), clear: () => session.remove('pv-session') },
  prefs: { get: (k) => prefs.get(`pv-${k}`), set: (k, v) => prefs.set(`pv-${k}`, v), remove: (k) => prefs.remove(`pv-${k}`) },
  createCacheStore: (scope) => {
    const name = `passvault-${scope.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    if (!storeCache.has(name)) storeCache.set(name, new IndexedDbStore(name));
    return storeCache.get(name)!;
  },
  clipboard: new BrowserClipboard(),
  files: {
    pickTextFile: ({ maxBytes }) =>
      new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async () => {
          const f = input.files?.[0];
          if (!f) return resolve(null);
          if (f.size > maxBytes) return reject(new Error(`File is larger than ${Math.round(maxBytes / 1024)} KB`));
          resolve({ name: f.name, text: await f.text() });
        };
        input.click();
      }),
    saveTextFile: async ({ suggestedName, text }) => {
      // Prefer the File System Access API: the user picks the location and the browser confirms overwrites.
      const w = window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>; name: string }> };
      if (w.showSaveFilePicker) {
        try {
          const handle = await w.showSaveFilePicker({ suggestedName });
          const writable = await handle.createWritable();
          await writable.write(text);
          await writable.close();
          return { saved: true, location: handle.name, ownerOnly: false };
        } catch (e) {
          if ((e as Error).name === 'AbortError') return { saved: false };
          throw e;
        }
      }
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestedName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { saved: true, location: 'your downloads folder', ownerOnly: false };
    },
  },
  openExternal: async (url) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web links can be opened');
    window.open(u.toString(), '_blank', 'noopener,noreferrer');
  },
};

// Deep links: /recover#token=<token> (recovery email). Registration emails contain only a code. Remove them from the URL immediately.
const params = new URLSearchParams(window.location.search);
let initialRoute: AuthRoute | undefined;
if (params.get('register')) initialRoute = { kind: 'register', email: params.get('register')!, code: params.get('code') ?? undefined };
else if (window.location.pathname.replace(/\/+$/, '') === '/recover') {
  // Recovery links carry the token in the URL fragment so it never reaches server logs.
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (token) initialRoute = { kind: 'recover', token };
}
if (initialRoute) window.history.replaceState(null, '', '/');

async function boot() {
  if (import.meta.env.DEV && params.has('preview')) {
    const { setupPreviewAccount } = await import('./dev-preview');
    await setupPreviewAccount();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <PassVaultApp platform={platform} platformName="web" initialRoute={initialRoute} />
    </StrictMode>,
  );
}
void boot();
