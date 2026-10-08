import type { KeyValueBackend } from '@passvault/sync';
import type { ServerProfileView } from '@passvault/ui';
import {
  InvalidServerUrlError,
  LOCAL_API_URL,
  LOCAL_WEB_URL,
  activeProfile,
  checkServer,
  connectProfile,
  initialProfiles,
  isLoopbackServer,
  normalizeServerUrl,
  parseProfiles,
  recordCheck,
  removeProfile,
  renameProfile,
  setLocalDev,
  switchProfile,
  type ServerCheck,
  type ServerProfiles,
} from '@passvault/vault-core';
import { neutralinoPrefs, stableHash } from './storage';

export { InvalidServerUrlError, normalizeServerUrl } from '@passvault/vault-core';

/**
 * Server connection for the desktop app. The user can connect to any
 * compatible PassVault server — https://, optionally under a path prefix, or
 * http://localhost with the explicit local-development setting — change the
 * address at any time in Settings → Server connection, and switch between
 * saved servers. The build-time production server is only the first
 * suggestion; nothing is hard-coded.
 *
 * Every server gets its own namespace for the Keychain session token,
 * preferences (device id, last email, trusted-device tokens) and the
 * encrypted cache: switching never mixes accounts or data, never sends one
 * server's token to another and never copies or uploads vault items.
 */

export const LOCAL_URL = LOCAL_API_URL;

/**
 * The production server comes only from build-time configuration
 * (VITE_PRODUCTION_URL, or VITE_API_URL of a production build), so forks and
 * other deployments set their own. Without it, local development is offered.
 */
function configuredProductionUrl(): string | null {
  const raw = import.meta.env.VITE_PRODUCTION_URL || (import.meta.env.MODE === 'production' ? import.meta.env.VITE_API_URL : '');
  if (!raw) return null;
  try {
    const base = normalizeServerUrl(raw);
    return isLoopbackServer(base) ? null : base;
  } catch {
    return null;
  }
}

export const PRODUCTION_URL: string | null = configuredProductionUrl();

/** Global (not per-server) key of the saved servers. */
export const PROFILES_KEY = 'pvg_servers';
/** Pre-profiles key holding just the selected server origin; migrated into PROFILES_KEY. */
const LEGACY_SELECTED_KEY = 'pvg_server';

/** Short stable namespace for per-server storage keys and Keychain accounts (path prefix included). */
export function serverScope(url: string): string {
  return stableHash(normalizeServerUrl(url, { allowLocalHttp: true })).slice(0, 10);
}

const ctx = () => ({ scope: serverScope, now: Date.now() });

/** Web dashboard URL used for links ("Open dashboard", recovery) for a given server. */
export function webAppUrlFor(url: string): string {
  const base = normalizeServerUrl(url, { allowLocalHttp: true });
  return isLoopbackServer(base) ? LOCAL_WEB_URL : base;
}

/** Saved servers; the first run seeds the previously selected / build-time server. */
export async function loadProfiles(kv: KeyValueBackend, fallback: string, localDevDefault: boolean): Promise<ServerProfiles> {
  try {
    const parsed = parseProfiles(JSON.parse((await kv.get(PROFILES_KEY)) ?? 'null'), ctx());
    if (parsed) return parsed;
  } catch {
    /* corrupt: seed again */
  }
  const legacy = await kv.get(LEGACY_SELECTED_KEY).catch(() => null);
  const first = legacy ?? PRODUCTION_URL ?? fallback;
  const localDev = localDevDefault || isLoopbackServer(first);
  let s: ServerProfiles;
  try {
    s = initialProfiles(first, ctx(), localDev);
  } catch {
    s = initialProfiles(PRODUCTION_URL ?? LOCAL_URL, ctx(), !PRODUCTION_URL || localDev);
  }
  for (const extra of [PRODUCTION_URL, s.localDev ? LOCAL_URL : null]) {
    if (extra && !s.profiles.some((p) => p.url === extra)) s = { ...connectProfile(s, extra, ctx()).state, activeId: s.activeId };
  }
  await kv.set(PROFILES_KEY, JSON.stringify(s));
  await kv.remove(LEGACY_SELECTED_KEY).catch(() => undefined);
  return s;
}

/** Account (last email) per saved server, read from that server's own prefs. */
export async function profileViews(kv: KeyValueBackend, s: ServerProfiles): Promise<ServerProfileView[]> {
  return Promise.all(
    s.profiles.map(async (p) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      active: p.id === s.activeId,
      lastCheck: p.lastCheck,
      account: await neutralinoPrefs(kv, p.id)
        .get('lastEmail')
        .catch(() => null),
    })),
  );
}

export interface DesktopServerDeps {
  kv: KeyValueBackend;
  /** names of all stored keys (Neutralino storage.getKeys) */
  listKeys: () => Promise<string[]>;
  /** removes the server's Keychain session token */
  deleteToken: (scope: string) => Promise<void>;
  /** TLS diagnosis from the native helper (system trust store), when available */
  inspectTls?: (url: string) => Promise<{ ok: boolean; reason?: string; message: string } | null>;
  /** webview origin, for the CORS hint */
  appOrigin: string;
  /** lock + dispose the current session, then start one for `url` */
  activate: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/**
 * Owns the saved servers. Every change of the connected server goes through
 * `activate`, which locks the vault, cancels pending requests and starts a
 * fresh session.
 */
export class DesktopServers {
  private views: ServerProfileView[] = [];
  private listeners = new Set<() => void>();
  private busy = false;

  constructor(
    private state: ServerProfiles,
    private readonly d: DesktopServerDeps,
  ) {}

  static async load(d: DesktopServerDeps, fallback: string, localDevDefault: boolean): Promise<DesktopServers> {
    const m = new DesktopServers(await loadProfiles(d.kv, fallback, localDevDefault), d);
    await m.refresh();
    return m;
  }

  get activeUrl(): string {
    return activeProfile(this.state).url;
  }
  get localDev(): boolean {
    return this.state.localDev;
  }
  get profiles(): ServerProfileView[] {
    return this.views;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  normalize(url: string): string {
    return normalizeServerUrl(url, { allowLocalHttp: this.state.localDev });
  }

  async refresh(): Promise<void> {
    this.views = await profileViews(this.d.kv, this.state);
    for (const l of this.listeners) l();
  }

  private async persist(next: ServerProfiles) {
    this.state = next;
    await this.d.kv.set(PROFILES_KEY, JSON.stringify(next));
    await this.refresh();
  }

  private async exclusive<T>(f: () => Promise<T>): Promise<T> {
    if (this.busy) throw new InvalidServerUrlError('A server change is already in progress');
    this.busy = true;
    try {
      return await f();
    } finally {
      this.busy = false;
    }
  }

  /**
   * Compatibility check (no credentials). When the webview cannot connect,
   * the helper inspects TLS with the macOS trust store to tell a certificate
   * problem apart from a server that does not allow this app (CORS).
   */
  async check(url: string): Promise<ServerCheck> {
    let base: string;
    try {
      base = this.normalize(url);
    } catch (e) {
      return { ok: false, url: null, code: 'invalid_url', message: (e as Error).message };
    }
    let r = await checkServer(base, { allowLocalHttp: this.state.localDev, ...(this.d.fetchImpl ? { fetchImpl: this.d.fetchImpl } : {}) });
    if (!r.ok && r.code === 'unreachable' && base.startsWith('https:') && this.d.inspectTls) {
      const tls = await this.d.inspectTls(base).catch(() => null);
      if (tls && !tls.ok && tls.reason !== 'unreachable') r = { ok: false, url: base, code: 'tls', message: tls.message };
      else if (tls?.ok) {
        r = {
          ok: false,
          url: base,
          code: 'unreachable',
          message: `The server's certificate is valid, but the server does not allow this app to connect. Its administrator must add ${this.d.appOrigin} to CORS_ORIGINS.`,
        };
      }
    }
    const saved = this.state.profiles.find((p) => p.url === base);
    if (saved) await this.persist(recordCheck(this.state, saved.id, r));
    return r;
  }

  /** Connects to a new address, only after a successful check. The previous server stays saved. */
  connect(url: string): Promise<string> {
    return this.exclusive(async () => {
      const base = this.normalize(url);
      if (base === this.activeUrl) return base;
      const r = await this.check(base);
      if (!r.ok) throw new InvalidServerUrlError(r.message);
      const { state, profile } = connectProfile(this.state, base, ctx());
      await this.persist(recordCheck(state, profile.id, r));
      await this.d.activate(base);
      return base;
    });
  }

  /** Switches to a saved server (works offline: its encrypted cache can still be unlocked). */
  switchTo(id: string): Promise<string> {
    return this.exclusive(async () => {
      if (id === this.state.activeId) return this.activeUrl;
      const next = switchProfile(this.state, id);
      await this.persist(next);
      await this.d.activate(activeProfile(next).url);
      return this.activeUrl;
    });
  }

  async rename(id: string, name: string): Promise<void> {
    await this.persist(renameProfile(this.state, id, name));
  }

  /** Forgets a saved server: its Keychain token, prefs and encrypted cache on this Mac. */
  async remove(id: string): Promise<void> {
    await this.persist(removeProfile(this.state, id));
    await this.d.deleteToken(id).catch(() => undefined);
    const keys = await this.d.listKeys().catch(() => [] as string[]);
    for (const k of keys) {
      if (k.startsWith(`pvp_${id}_`) || k.startsWith(`pvc_${id}_`)) await this.d.kv.remove(k).catch(() => undefined);
    }
  }

  async setLocalDev(on: boolean): Promise<void> {
    let next = setLocalDev(this.state, on);
    if (on && !next.profiles.some((p) => p.url === LOCAL_URL)) next = { ...connectProfile(next, LOCAL_URL, ctx()).state, activeId: next.activeId };
    await this.persist(next);
  }
}
