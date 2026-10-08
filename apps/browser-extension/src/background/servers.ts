import { LOCAL_API_URL, LOCAL_WEB_URL, isLoopbackServer, normalizeServerUrl } from '@passvault/vault-core/servers';
import type { StorageAreaLike } from './chrome-api';
import { LEGACY_PREF_PREFIX, LEGACY_TOKEN_KEY, prefPrefix, tokenKey } from './platform';

/**
 * Server selection for the extension. The user can point it at any PassVault
 * server (https://, or http:// for localhost); the production server built
 * into this release and local development are offered as shortcuts.
 *
 * Every server gets its own storage namespace (session token, device id,
 * last email, trusted-device tokens, encrypted cache), so switching servers
 * never mixes accounts or data. Host access for a server the user enters is
 * granted through Chrome's permission prompt (optional_host_permissions).
 */

/** chrome.storage.local key holding the selected server origin (global, not per server). */
export const SELECTED_SERVER_KEY = 'pv.server';

export interface ServerPreset {
  id: 'production' | 'local';
  label: string;
  url: string;
}

/** A build-time production URL, or null when it is missing, invalid, or loopback. */
export function productionUrlFrom(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    // Build values may carry a path (e.g. …/api); only the origin matters.
    const origin = normalizeServerUrl(new URL(raw).origin);
    return isLoopbackServer(origin) ? null : origin;
  } catch {
    return null;
  }
}

export function serverPresets(productionUrl: string | null): ServerPreset[] {
  return [
    ...(productionUrl ? [{ id: 'production' as const, label: 'Production', url: productionUrl }] : []),
    { id: 'local', label: 'Local development', url: LOCAL_API_URL },
  ];
}

/** Server used on first start: the built-in production server, else local development. */
export function defaultServer(productionUrl: string | null): string {
  return productionUrl ?? LOCAL_API_URL;
}

/** Dashboard URL for links ("Create an account", "Open dashboard") on a given server. */
export function webUrlFor(server: string, productionUrl: string | null, productionWebUrl: string | null): string {
  if (isLoopbackServer(server)) return LOCAL_WEB_URL;
  if (productionUrl && server === productionUrl && productionWebUrl) return productionWebUrl;
  // A self-hosted server serves the dashboard and the API from the same origin (see DEPLOYMENT.md).
  return server;
}

/** Readable, collision-free storage namespace for a server origin. */
export function serverScope(origin: string): string {
  const u = new URL(normalizeServerUrl(origin));
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.protocol.replace(':', '')}_${u.hostname.replace(/[^a-z0-9]/gi, '_')}_${port}`.toLowerCase();
}

export async function loadSelectedServer(local: StorageAreaLike, fallback: string): Promise<string> {
  const v = (await local.get(SELECTED_SERVER_KEY))[SELECTED_SERVER_KEY];
  if (typeof v === 'string') {
    try {
      return normalizeServerUrl(v);
    } catch {
      /* corrupt: fall back */
    }
  }
  return fallback;
}

/**
 * Before per-server storage existed, the session token and prefs lived under
 * global keys and always belonged to the build-time server. Move them into
 * that server's namespace once.
 */
export async function migrateLegacyStorage(local: StorageAreaLike, legacyServer: string): Promise<void> {
  const all = await local.get(null);
  if (typeof all[SELECTED_SERVER_KEY] === 'string') return;
  const scope = serverScope(legacyServer);
  const moved: Record<string, unknown> = {};
  const old: string[] = [];
  for (const [k, v] of Object.entries(all)) {
    if (k === LEGACY_TOKEN_KEY) moved[tokenKey(scope)] = v;
    else if (k.startsWith(LEGACY_PREF_PREFIX)) moved[prefPrefix(scope) + k.slice(LEGACY_PREF_PREFIX.length)] = v;
    else continue;
    old.push(k);
  }
  if (old.length) {
    await local.set(moved);
    await local.remove(old);
  }
  await local.set({ [SELECTED_SERVER_KEY]: normalizeServerUrl(legacyServer) });
}
