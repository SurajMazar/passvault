import { describe, expect, it } from 'vitest';
import {
  InvalidServerUrlError,
  LOCAL_URL,
  PRODUCTION_URL,
  describeServer,
  isAllowedServer,
  loadSelectedServer,
  normalizeServerUrl,
  probeServer,
  saveSelectedServer,
  serverScope,
  webAppUrlFor,
} from '../src/platform/servers';
import { sessionTokenAccount } from '../src/platform/desktop-platform';

// vitest.config.ts sets VITE_PRODUCTION_URL=https://vault.example.com for these tests.
const PROD = PRODUCTION_URL!;
import { cachePrefix, neutralinoPrefs, prefKey, STORAGE_KEY_RE } from '../src/platform/storage';

function memKv() {
  const m = new Map<string, string>();
  return { m, get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), remove: async (k: string) => void m.delete(k) };
}

describe('server URL validation', () => {
  it('accepts https origins and loopback http, normalising to the origin', () => {
    expect(normalizeServerUrl('https://vault.example.com')).toBe('https://vault.example.com');
    expect(normalizeServerUrl('vault.example.com')).toBe('https://vault.example.com');
    expect(normalizeServerUrl('https://Vault.Example.com:8443/')).toBe('https://vault.example.com:8443');
    expect(normalizeServerUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeServerUrl('http://127.0.0.1:3100')).toBe('http://127.0.0.1:3100');
  });

  it('rejects plain http to remote hosts, credentials, paths, and other schemes', () => {
    for (const bad of ['http://vault.example.com', 'https://user:pw@vault.example.com', 'https://vault.example.com/api', 'https://vault.example.com/?x=1', 'ftp://vault.example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url at all']) {
      expect(() => normalizeServerUrl(bad), bad).toThrow(InvalidServerUrlError);
    }
  });

  it('offers only the production server and local development', () => {
    expect(PROD).toBe('https://vault.example.com');
    expect(describeServer(PROD).id).toBe('production');
    expect(describeServer(LOCAL_URL).id).toBe('local');
    expect(() => describeServer('https://other.example.org')).toThrow(InvalidServerUrlError);
    expect(isAllowedServer('https://other.example.org')).toBe(false);
    expect(isAllowedServer(PROD)).toBe(true);
    expect(isAllowedServer(LOCAL_URL)).toBe(true);
    expect(webAppUrlFor(LOCAL_URL)).toBe('http://localhost:5173');
    expect(webAppUrlFor(PROD)).toBe(PROD);
  });
});

describe('per-server isolation', () => {
  const prod = serverScope(PROD);
  const local = serverScope(LOCAL_URL);

  it('gives each server its own Keychain account, prefs, and cache namespace', () => {
    expect(prod).not.toBe(local);
    expect(serverScope('https://vault.example.com/')).toBe(prod);
    const a = sessionTokenAccount(prod);
    const b = sessionTokenAccount(local);
    expect(a).not.toBe(b);
    for (const acct of [a, b]) expect(acct).toMatch(/^pv\.[a-z0-9._-]{1,64}$/); // helper keychain account pattern
    expect(cachePrefix(`${prod}:alice@example.com`)).not.toBe(cachePrefix(`${local}:alice@example.com`));
    for (const k of [cachePrefix(`${prod}:alice@example.com`), prefKey(`${prod}_deviceId`)]) expect(k).toMatch(STORAGE_KEY_RE);
  });

  it('keeps prefs separate between servers on the same storage', async () => {
    const kv = memKv();
    const pProd = neutralinoPrefs(kv, prod);
    const pLocal = neutralinoPrefs(kv, local);
    await pProd.set('lastEmail', 'alice@example.com');
    expect(await pLocal.get('lastEmail')).toBeNull();
    expect(await pProd.get('lastEmail')).toBe('alice@example.com');
  });

  it('persists the selected server and ignores invalid stored values', async () => {
    const kv = memKv();
    expect(await loadSelectedServer(kv, PROD)).toBe(PROD);
    await saveSelectedServer(kv, 'http://localhost:3000/');
    expect(await loadSelectedServer(kv, PROD)).toBe(LOCAL_URL);
    kv.m.set('pvg_server', 'http://evil.example.com');
    expect(await loadSelectedServer(kv, PROD)).toBe(PROD);
    await expect(saveSelectedServer(kv, 'http://evil.example.com')).rejects.toThrow(InvalidServerUrlError);
  });
});

describe('server probe', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  it('recognises a PassVault health endpoint and sends no credentials', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const r = await probeServer(LOCAL_URL, (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return json(200, { status: 'ok', db: 'ok', version: '0.1.0' });
    }) as typeof fetch);
    expect(r).toEqual({ ok: true, version: '0.1.0' });
    expect(seen!.url).toBe('http://localhost:3000/api/v1/health');
    expect(seen!.init?.credentials).toBe('omit');
  });
  it('reports unreachable or non-PassVault servers', async () => {
    expect((await probeServer(LOCAL_URL, (async () => json(404, {})) as typeof fetch)).ok).toBe(false);
    expect((await probeServer(LOCAL_URL, (async () => json(200, { hello: 'world' })) as typeof fetch)).ok).toBe(false);
    expect((await probeServer(LOCAL_URL, (async () => Promise.reject(new TypeError('offline'))) as typeof fetch)).ok).toBe(false);
  });
});
