import type { KeyValueBackend } from '@passvault/sync';
import { LOCAL_API_URL, LOCAL_WEB_URL, isLoopbackServer, normalizeServerUrl, InvalidServerUrlError } from '@passvault/vault-core';
import { stableHash } from './storage';

export { InvalidServerUrlError, normalizeServerUrl, probeServer } from '@passvault/vault-core';

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

export const LOCAL_URL = LOCAL_API_URL;

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
  return isLoopbackServer(origin) ? LOCAL_WEB_URL : origin;
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
