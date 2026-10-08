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
  serverOrigin,
  setLocalDev,
  switchProfile,
  type ServerCheck,
  type ServerProfiles,
} from '@passvault/vault-core/servers';
import type { ChromeLike, StorageAreaLike } from './chrome-api';
import { LEGACY_PREF_PREFIX, LEGACY_TOKEN_KEY, prefPrefix, tokenKey } from './platform';

/**
 * Server connection for the extension. The user can point it at any
 * compatible PassVault server — https://, optionally under a path prefix, or
 * http://localhost with the explicit local-development setting — change the
 * address at any time, and switch between saved servers. The build-time
 * production server is only the first suggestion.
 *
 * Every server gets its own storage namespace (session token, device id,
 * last email, trusted-device tokens, encrypted cache): switching servers never
 * mixes accounts or data, never sends one server's token to another, and
 * never copies or uploads vault items. Host access for a server is granted
 * through Chrome's permission prompt (optional_host_permissions).
 */

/** chrome.storage.local key of the saved servers (global, not per server). */
export const PROFILES_KEY = 'pv.servers';
/** Pre-profiles key holding just the selected server; migrated into PROFILES_KEY. */
export const SELECTED_SERVER_KEY = 'pv.server';

/** A build-time production URL, or null when it is missing, invalid, or loopback. */
export function productionUrlFrom(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const base = normalizeServerUrl(raw);
    return isLoopbackServer(base) ? null : base;
  } catch {
    return null;
  }
}

/** Server used on first start: the built-in production server, else local development. */
export function defaultServer(productionUrl: string | null): string {
  return productionUrl ?? LOCAL_API_URL;
}

/** Dashboard URL for links ("Create an account", "Open dashboard") on a given server. */
export function webUrlFor(server: string, productionUrl: string | null, productionWebUrl: string | null): string {
  if (isLoopbackServer(server)) return LOCAL_WEB_URL;
  if (productionUrl && server === productionUrl && productionWebUrl) return productionWebUrl;
  // A self-hosted server serves the dashboard and the API from the same base URL (see DEPLOYMENT.md).
  return server;
}

const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
};

/**
 * Readable, collision-free storage namespace for a server base URL. Servers
 * at the root keep the namespace they had before path prefixes existed.
 */
export function serverScope(url: string): string {
  const u = new URL(normalizeServerUrl(url, { allowLocalHttp: true }));
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const base = `${u.protocol.replace(':', '')}_${u.hostname.replace(/[^a-z0-9]/gi, '_')}_${port}`.toLowerCase();
  if (u.pathname === '/' || !u.pathname) return base;
  return `${base}_${u.pathname.slice(1).replace(/[^a-z0-9]/gi, '_').slice(0, 40).toLowerCase()}_${fnv(u.pathname)}`;
}

const ctx = () => ({ scope: serverScope, now: Date.now() });

/**
 * Before per-server storage existed, the session token and prefs lived under
 * global keys and always belonged to the build-time server. Move them into
 * that server's namespace once.
 */
export async function migrateLegacyStorage(local: StorageAreaLike, legacyServer: string): Promise<void> {
  const all = await local.get(null);
  if (typeof all[SELECTED_SERVER_KEY] === 'string' || all[PROFILES_KEY]) return;
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
  await local.set({ [SELECTED_SERVER_KEY]: normalizeServerUrl(legacyServer, { allowLocalHttp: true }) });
}

/** Saved servers; first run seeds the build-time server (and local development when enabled). */
export async function loadProfiles(local: StorageAreaLike, opts: { productionUrl: string | null; localDevDefault: boolean }): Promise<ServerProfiles> {
  const all = await local.get([PROFILES_KEY, SELECTED_SERVER_KEY]);
  const parsed = parseProfiles(all[PROFILES_KEY], ctx());
  if (parsed) return parsed;
  // Seed: the previously selected server (pre-profiles), else the default.
  const legacy = typeof all[SELECTED_SERVER_KEY] === 'string' ? (all[SELECTED_SERVER_KEY] as string) : null;
  const first = legacy ?? defaultServer(opts.productionUrl);
  const localDev = opts.localDevDefault || isLoopbackServer(first);
  let s: ServerProfiles;
  try {
    s = initialProfiles(first, ctx(), localDev);
  } catch {
    s = initialProfiles(defaultServer(opts.productionUrl), ctx(), true);
  }
  if (opts.productionUrl && !s.profiles.some((p) => p.url === opts.productionUrl)) {
    const active = s.activeId;
    s = { ...connectProfile(s, opts.productionUrl, ctx()).state, activeId: active };
  }
  if (localDev && !s.profiles.some((p) => p.url === LOCAL_API_URL)) {
    const active = s.activeId;
    s = { ...connectProfile(s, LOCAL_API_URL, ctx()).state, activeId: active };
  }
  await local.set({ [PROFILES_KEY]: s });
  await local.remove(SELECTED_SERVER_KEY);
  return s;
}

/** Account (last email) per saved server, read from that server's own namespace. */
export async function profileViews(local: StorageAreaLike, s: ServerProfiles): Promise<ServerProfileView[]> {
  const keys = s.profiles.map((p) => `${prefPrefix(p.id)}lastEmail`);
  const got = keys.length ? await local.get(keys) : {};
  return s.profiles.map((p, i) => {
    const account = got[keys[i]!];
    return { id: p.id, name: p.name, url: p.url, active: p.id === s.activeId, lastCheck: p.lastCheck, account: typeof account === 'string' ? account : null };
  });
}

/**
 * Deletes everything this device stores for a server: its session token,
 * prefs (device id, last email, trusted-device tokens) and encrypted caches.
 */
export async function forgetServerData(c: ChromeLike, scope: string, idb: Pick<IDBFactory, 'databases' | 'deleteDatabase'> | null = globalThis.indexedDB ?? null): Promise<void> {
  const all = await c.storage.local.get(null);
  const mine = Object.keys(all).filter((k) => k.startsWith(`pv.${scope}.`));
  if (mine.length) await c.storage.local.remove(mine);
  if (!idb?.databases) return;
  const prefix = `passvault-ext-${scope}-`;
  for (const db of await idb.databases()) {
    if (db.name?.startsWith(prefix)) idb.deleteDatabase(db.name);
  }
}

export interface ServerSwitchHooks {
  /** Tear down the current server's runtime (lock, cancel requests) and boot `url`. */
  activate(url: string): Promise<void>;
  /** Push fresh popup state (profiles changed without a switch). */
  changed(): void;
}

/**
 * Owns the saved servers. Every change that touches the connected server goes
 * through `activate`, which locks the vault and rebuilds the session.
 */
export class ServerManager {
  private views: ServerProfileView[] = [];
  private busy: Promise<unknown> | null = null;

  constructor(
    private readonly c: ChromeLike,
    private state: ServerProfiles,
    private readonly hooks: ServerSwitchHooks,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  get activeUrl(): string {
    return activeProfile(this.state).url;
  }

  info() {
    return { url: this.activeUrl, localDev: this.state.localDev, profiles: this.views };
  }

  async refresh(): Promise<void> {
    this.views = await profileViews(this.c.storage.local, this.state);
  }

  private async persist(next: ServerProfiles) {
    this.state = next;
    await this.c.storage.local.set({ [PROFILES_KEY]: next });
    await this.refresh();
  }

  private async exclusive<T>(f: () => Promise<T>): Promise<T> {
    if (this.busy) throw new InvalidServerUrlError('A server change is already in progress');
    const p = f();
    this.busy = p;
    try {
      return await p;
    } finally {
      this.busy = null;
    }
  }

  private async hasAccess(base: string): Promise<boolean> {
    return (await this.c.permissions?.contains({ origins: [`${serverOrigin(base)}/*`] })) ?? false;
  }

  /** Compatibility check of an address. Sends no credentials; needs Chrome host access to it. */
  async check(url: string): Promise<ServerCheck> {
    let base: string;
    try {
      base = normalizeServerUrl(url, { allowLocalHttp: this.state.localDev });
    } catch (e) {
      return { ok: false, url: null, code: 'invalid_url', message: (e as Error).message };
    }
    if (!(await this.hasAccess(base))) {
      return { ok: false, url: base, code: 'unreachable', message: `PassVault is not allowed to connect to ${new URL(base).host}. Allow access when Chrome asks.` };
    }
    const r = await checkServer(base, { allowLocalHttp: this.state.localDev, fetchImpl: this.fetchImpl });
    const saved = this.state.profiles.find((p) => p.url === base);
    if (saved) await this.persist(recordCheck(this.state, saved.id, r));
    return r;
  }

  /**
   * Connects to a new address. Applied only when the server passes the
   * compatibility check; otherwise nothing changes and the error is returned.
   * The previous server stays saved.
   */
  connect(url: string): Promise<string> {
    return this.exclusive(async () => {
      const base = normalizeServerUrl(url, { allowLocalHttp: this.state.localDev });
      if (base === this.activeUrl) return base;
      const r = await this.check(base);
      if (!r.ok) throw new InvalidServerUrlError(r.message);
      const { state, profile } = connectProfile(this.state, base, ctx());
      await this.persist(recordCheck(state, profile.id, r));
      await this.hooks.activate(base);
      return base;
    });
  }

  /** Switches to a saved server (works offline: its encrypted cache can still be unlocked). */
  switchTo(id: string): Promise<string> {
    return this.exclusive(async () => {
      if (id === this.state.activeId) return this.activeUrl;
      const next = switchProfile(this.state, id);
      const url = activeProfile(next).url;
      if (!(await this.hasAccess(url))) throw new InvalidServerUrlError(`PassVault is not allowed to connect to ${new URL(url).host}. Allow access when Chrome asks.`);
      await this.persist(next);
      await this.hooks.activate(url);
      return url;
    });
  }

  async rename(id: string, name: string): Promise<void> {
    await this.persist(renameProfile(this.state, id, name));
    this.hooks.changed();
  }

  async remove(id: string): Promise<void> {
    await this.persist(removeProfile(this.state, id));
    await forgetServerData(this.c, id);
    this.hooks.changed();
  }

  async setLocalDev(on: boolean): Promise<boolean> {
    let next = setLocalDev(this.state, on);
    if (on && !next.profiles.some((p) => p.url === LOCAL_API_URL)) next = { ...connectProfile(next, LOCAL_API_URL, ctx()).state, activeId: next.activeId };
    await this.persist(next);
    this.hooks.changed();
    return on;
  }
}
