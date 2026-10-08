import type { KeyValueBackend } from '@passvault/sync';
import { stableHash } from './storage';

/**
 * Server selection for the desktop app: the production server or a local
 * development server. Only these two origins are allowed (also in the CSP).
 *
 * Every server gets its own namespace for the Keychain session token,
 * preferences (device id, last email, trusted-device tokens) and the
 * encrypted cache, so switching servers never mixes accounts or data.
 */
export interface ServerOption {
  id: 'production' | 'local';
  label: string;
  description: string;
  url: string;
}

export const LOCAL_URL = 'http://localhost:3000';

/**
 * The production server comes only from build-time configuration
 * (VITE_PRODUCTION_URL, or VITE_API_URL of a production build) — nothing is
 * hard-coded, so forks and other deployments set their own. Without it, only
 * local development is offered.
 */
function configuredProductionUrl(): string | null {
  const raw = import.meta.env.VITE_PRODUCTION_URL || (import.meta.env.MODE === 'production' ? import.meta.env.VITE_API_URL : '');
  if (!raw) return null;
  try {
    const origin = normalizeServerUrl(raw);
    return origin === LOCAL_URL ? null : origin;
  } catch {
    return null;
  }
}

export const PRODUCTION_URL: string | null = configuredProductionUrl();

export const SERVER_PRESETS: ServerOption[] = [
  ...(PRODUCTION_URL ? [{ id: 'production' as const, label: 'Server', description: new URL(PRODUCTION_URL).host, url: PRODUCTION_URL }] : []),
  { id: 'local', label: 'Local development', description: 'localhost:3000', url: LOCAL_URL },
];

/** Global (not per-server) key holding the selected server origin. */
const SELECTED_KEY = 'pvg_server';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export class InvalidServerUrlError extends Error {
  override name = 'InvalidServerUrlError';
}

/**
 * Accepts `https://host[:port]`, or `http://` only for loopback hosts.
 * Returns the bare origin; paths, queries, fragments and credentials are rejected.
 */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new InvalidServerUrlError('Enter a server address like https://vault.example.com');
  }
  if (u.username || u.password) throw new InvalidServerUrlError('Server addresses must not contain a username or password');
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) {
    throw new InvalidServerUrlError('Use https:// — plain http is only allowed for localhost');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new InvalidServerUrlError('Only https:// (or http://localhost) servers are supported');
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new InvalidServerUrlError('Enter only the server address, without a path');
  return u.origin;
}

/** Short stable namespace for per-server storage keys and Keychain accounts. */
export function serverScope(url: string): string {
  return stableHash(normalizeServerUrl(url)).slice(0, 10);
}

export function isAllowedServer(url: string): boolean {
  try {
    const origin = normalizeServerUrl(url);
    return SERVER_PRESETS.some((p) => p.url === origin);
  } catch {
    return false;
  }
}

export function describeServer(url: string): ServerOption {
  const origin = normalizeServerUrl(url);
  const found = SERVER_PRESETS.find((p) => p.url === origin);
  if (!found) throw new InvalidServerUrlError('Only the PassVault server and local development are supported');
  return found;
}

/** Web dashboard URL used for links ("Open dashboard", recovery) for a given server. */
export function webAppUrlFor(url: string): string {
  const origin = normalizeServerUrl(url);
  return origin === LOCAL_URL || new URL(origin).hostname === '127.0.0.1' ? 'http://localhost:5173' : origin;
}

export async function loadSelectedServer(kv: KeyValueBackend, fallback: string): Promise<string> {
  try {
    const v = await kv.get(SELECTED_KEY);
    if (v && isAllowedServer(v)) return normalizeServerUrl(v);
  } catch {
    /* corrupt or invalid: fall back */
  }
  return isAllowedServer(fallback) ? normalizeServerUrl(fallback) : (PRODUCTION_URL ?? LOCAL_URL);
}

export async function saveSelectedServer(kv: KeyValueBackend, url: string): Promise<string> {
  if (!isAllowedServer(url)) throw new InvalidServerUrlError('Only the PassVault server and local development are supported');
  const origin = normalizeServerUrl(url);
  await kv.set(SELECTED_KEY, origin);
  return origin;
}

/** Checks that the address is a reachable PassVault API (health endpoint, no credentials sent). */
export async function probeServer(url: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; version: string } | { ok: false; message: string }> {
  const origin = normalizeServerUrl(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetchImpl(`${origin}/api/v1/health`, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
    if (!r.ok) return { ok: false, message: `Server answered ${r.status}` };
    const j = (await r.json()) as { status?: string; version?: string };
    if (j.status !== 'ok' && j.status !== 'degraded') return { ok: false, message: 'This does not look like a PassVault server' };
    return { ok: true, version: j.version ?? 'unknown' };
  } catch {
    return { ok: false, message: 'Could not reach the server (check the address, your connection, and that the server allows this app)' };
  } finally {
    clearTimeout(t);
  }
}
