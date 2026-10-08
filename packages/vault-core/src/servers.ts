/**
 * Server addresses, compatibility checks and saved server profiles, shared by
 * the clients that let the user choose a PassVault server (desktop app,
 * browser extension). Nothing here is tied to one hosted service: the user can
 * point a client at any compatible server, including one deployed under a
 * path prefix (https://example.com/passvault).
 *
 * The web dashboard always talks to the server it was deployed with.
 */

/** Local development API (compose.yaml publishes the API on this port). */
export const LOCAL_API_URL = 'http://localhost:3000';
/** Local development web dashboard (Vite dev server / preview). */
export const LOCAL_WEB_URL = 'http://localhost:5173';

/** Version of the PassVault HTTP API this client speaks (`/api/v1`). */
export const CLIENT_API_VERSION = 1;
/** Server capabilities every PassVault client needs. */
export const REQUIRED_CAPABILITIES = ['vault.e2ee.v1', 'sync.v1', 'auth.mfa.totp'] as const;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const PATH_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/;

export class InvalidServerUrlError extends Error {
  override name = 'InvalidServerUrlError';
}

export interface NormalizeOptions {
  /**
   * Accept plain http:// for loopback addresses (local development). Off by
   * default: clients enable it only through an explicit local-development
   * setting. Non-loopback http:// is never accepted.
   */
  allowLocalHttp?: boolean;
}

/**
 * Canonical server base URL: `https://host[:port][/prefix]` (no trailing
 * slash). The path prefix of a deployment under a sub-path is kept; a pasted
 * API URL (…/api or …/api/v1) is reduced to its base. Credentials, queries
 * and fragments are rejected.
 */
export function normalizeServerUrl(input: string, opts: NormalizeOptions = {}): string {
  const raw = input.trim();
  if (!raw) throw new InvalidServerUrlError('Enter the server address, for example https://vault.example.com');
  if (raw.length > 2048) throw new InvalidServerUrlError('That address is too long');
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new InvalidServerUrlError('Enter a server address like https://vault.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new InvalidServerUrlError('Only https:// server addresses are supported');
  if (u.username || u.password) throw new InvalidServerUrlError('Server addresses must not contain a username or password');
  if (!u.hostname) throw new InvalidServerUrlError('The address needs a host name');
  if (u.protocol === 'http:') {
    if (!LOOPBACK.has(u.hostname)) throw new InvalidServerUrlError('Use https:// — plain http:// is only allowed for local development on this computer');
    if (!opts.allowLocalHttp) throw new InvalidServerUrlError('Plain http:// is off. Turn on “Local development servers” to use http://localhost.');
  }
  if (u.search || u.hash || raw.endsWith('?') || raw.endsWith('#')) throw new InvalidServerUrlError('Enter the server address without ?query or #fragment');
  let path = u.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  path = path.replace(/\/api(?:\/v1)?$/i, '');
  if (path && !path.slice(1).split('/').every((s) => PATH_SEGMENT.test(s) && s !== '.' && s !== '..')) {
    throw new InvalidServerUrlError('The path of the server address contains characters that are not allowed');
  }
  return u.origin + path;
}

/** The origin (scheme, host, port) of a server base URL — for permissions and CSP. */
export function serverOrigin(base: string): string {
  return new URL(base).origin;
}

/** Short human label: host plus path prefix. */
export function serverLabel(base: string): string {
  const u = new URL(base);
  return u.host + (u.pathname === '/' ? '' : u.pathname);
}

export function isLoopbackServer(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------------------------
// Compatibility check

/** `GET /api/v1/meta` — public, unauthenticated description of a PassVault server. */
export interface ServerMeta {
  service: 'passvault';
  version: string;
  api: { current: number; min: number };
  capabilities: string[];
  registration: 'open' | 'closed';
}

export type ServerCheckCode =
  | 'invalid_url'
  | 'unreachable'
  | 'timeout'
  | 'tls'
  | 'not_passvault'
  | 'incompatible'
  | 'missing_capabilities'
  | 'unavailable';

export type ServerCheck =
  | {
      ok: true;
      url: string;
      version: string;
      apiVersion: number;
      capabilities: string[];
      registration: 'open' | 'closed';
      /** the server answered but reports a problem (e.g. its database is down) */
      degraded: boolean;
    }
  | { ok: false; url: string | null; code: ServerCheckCode; message: string };

export interface CheckOptions extends NormalizeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  requiredCapabilities?: readonly string[];
}

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|ERR_TLS/i;
const MAX_BODY = 64 * 1024;

class CheckFailure extends Error {
  constructor(
    readonly code: ServerCheckCode,
    message: string,
  ) {
    super(message);
  }
}

function networkFailure(e: unknown, base: string): CheckFailure {
  if (e instanceof CheckFailure) return e;
  if ((e as { name?: string })?.name === 'AbortError') return new CheckFailure('timeout', 'The server did not answer in time. Check the address and your network.');
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? '';
  if (TLS_CODES.test(code) || TLS_CODES.test(cause?.message ?? '')) {
    return new CheckFailure('tls', `The server's TLS certificate is not valid (${code || 'verification failed'}). For a private server, install its certificate authority in the system trust store; PassVault never skips certificate checks.`);
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new CheckFailure('unreachable', `The host name ${new URL(base).hostname} could not be found. Check the address.`);
  if (code === 'ECONNREFUSED') return new CheckFailure('unreachable', 'The server refused the connection. Check the address and port, and that the server is running.');
  const https = base.startsWith('https:');
  return new CheckFailure(
    'unreachable',
    `Could not reach the server. Check the address and your connection${https ? ', and that its TLS certificate is trusted by this computer' : ''}.`,
  );
}

async function getJson(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  // No credentials, cookies, referrer or redirects: nothing about the user or another server leaves this check.
  const r = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal,
  });
  const text = await r.text();
  if (text.length > MAX_BODY) throw new CheckFailure('not_passvault', 'The server sent an unexpected answer. This does not look like a PassVault server.');
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

function parseMeta(body: unknown): ServerMeta | null {
  const m = body as Partial<ServerMeta> | null;
  if (!m || typeof m !== 'object' || m.service !== 'passvault') return null;
  if (typeof m.version !== 'string' || !m.api || typeof m.api.current !== 'number' || typeof m.api.min !== 'number') return null;
  if (!Array.isArray(m.capabilities) || !m.capabilities.every((c) => typeof c === 'string')) return null;
  return { service: 'passvault', version: m.version.slice(0, 64), api: { current: m.api.current, min: m.api.min }, capabilities: m.capabilities.slice(0, 200), registration: m.registration === 'closed' ? 'closed' : 'open' };
}

/**
 * Checks that an address is a reachable, compatible PassVault server:
 * reachability, TLS (verified by the platform; never disabled), the PassVault
 * API version range and the required capabilities. Sends no credentials.
 */
export async function checkServer(input: string, opts: CheckOptions = {}): Promise<ServerCheck> {
  let base: string;
  try {
    base = normalizeServerUrl(input, opts);
  } catch (e) {
    return { ok: false, url: null, code: 'invalid_url', message: e instanceof Error ? e.message : 'Invalid server address' };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const meta = await getJson(fetchImpl, `${base}/api/v1/meta`, ctrl.signal);
    if (meta.status === 404) {
      // Older PassVault servers have only /health.
      const h = await getJson(fetchImpl, `${base}/api/v1/health`, ctrl.signal).catch(() => null);
      const hb = h?.body as { status?: string; version?: string } | null;
      if (hb && (hb.status === 'ok' || hb.status === 'degraded') && typeof hb.version === 'string') {
        throw new CheckFailure('incompatible', `This PassVault server (${hb.version}) is too old for this app. Ask its administrator to update it.`);
      }
      throw new CheckFailure('not_passvault', 'No PassVault server answered at this address. If the server runs under a path, include it (for example https://example.com/passvault).');
    }
    if (meta.status >= 500) throw new CheckFailure('unavailable', `The server is having problems (HTTP ${meta.status}). Try again later.`);
    const m = parseMeta(meta.body);
    if (meta.status !== 200 || !m) throw new CheckFailure('not_passvault', 'This does not look like a PassVault server.');
    if (CLIENT_API_VERSION < m.api.min) throw new CheckFailure('incompatible', `This server needs a newer version of this app (server API ${m.api.min}–${m.api.current}, app API ${CLIENT_API_VERSION}). Update PassVault.`);
    if (CLIENT_API_VERSION > m.api.current) throw new CheckFailure('incompatible', `This server is too old for this app (server API ${m.api.current}, app API ${CLIENT_API_VERSION}). Ask its administrator to update it.`);
    const missing = (opts.requiredCapabilities ?? REQUIRED_CAPABILITIES).filter((c) => !m.capabilities.includes(c));
    if (missing.length) throw new CheckFailure('missing_capabilities', `This server does not support features this app needs: ${missing.join(', ')}.`);
    // Health answers 503 with {status:"degraded"} when the database is down.
    const health = await getJson(fetchImpl, `${base}/api/v1/health`, ctrl.signal).catch(() => null);
    const hs = (health?.body as { status?: string } | null)?.status;
    return { ok: true, url: base, version: m.version, apiVersion: m.api.current, capabilities: m.capabilities, registration: m.registration, degraded: hs !== 'ok' };
  } catch (e) {
    const f = networkFailure(e, base);
    return { ok: false, url: base, code: f.code, message: f.message };
  } finally {
    clearTimeout(timer);
  }
}

/** @deprecated use checkServer — kept for callers that only need a yes/no. */
export async function probeServer(url: string, fetchImpl: typeof fetch = fetch, opts: NormalizeOptions = { allowLocalHttp: true }): Promise<{ ok: true; version: string } | { ok: false; message: string }> {
  const r = await checkServer(url, { ...opts, fetchImpl });
  return r.ok ? { ok: true, version: r.version } : { ok: false, message: r.message };
}

// --------------------------------------------------------------------------------------------
// Saved server profiles

export interface ServerCheckSummary {
  ok: boolean;
  at: number;
  version?: string;
  message?: string;
}

/**
 * A saved server. `id` is the server's storage scope, derived from its URL:
 * every server has its own session token, keys, encrypted cache, device
 * registration and sync state, and a profile can never point a scope at a
 * different server. Changing a profile's address therefore always creates a
 * new connection (new scope) and keeps the old one to switch back to.
 */
export interface ServerProfile {
  id: string;
  name: string;
  url: string;
  addedAt: number;
  lastUsedAt: number;
  lastCheck: ServerCheckSummary | null;
}

export interface ServerProfiles {
  version: 1;
  activeId: string;
  /** explicit local-development setting: allows http:// for loopback addresses */
  localDev: boolean;
  profiles: ServerProfile[];
}

export const MAX_SERVER_PROFILES = 20;
export const MAX_PROFILE_NAME = 40;

export interface ProfileContext {
  scope: (url: string) => string;
  now?: number;
}

function defaultName(url: string): string {
  // Only the standard local API is "Local development"; other addresses are named by host (and path).
  return url === LOCAL_API_URL ? 'Local development' : serverLabel(url).slice(0, MAX_PROFILE_NAME);
}

function cleanName(name: string): string {
  const n = [...name]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, MAX_PROFILE_NAME);
  if (!n) throw new InvalidServerUrlError('Give the server a name');
  return n;
}

/** Fresh profile list with one server. */
export function initialProfiles(url: string, ctx: ProfileContext, localDev = false, name?: string): ServerProfiles {
  const base = normalizeServerUrl(url, { allowLocalHttp: localDev });
  const now = ctx.now ?? Date.now();
  const p: ServerProfile = { id: ctx.scope(base), name: name ? cleanName(name) : defaultName(base), url: base, addedAt: now, lastUsedAt: now, lastCheck: null };
  return { version: 1, activeId: p.id, localDev, profiles: [p] };
}

/**
 * Validates stored profiles: unknown fields dropped, invalid or disallowed
 * addresses removed, ids re-derived from URLs. Returns null when nothing usable is left.
 */
export function parseProfiles(raw: unknown, ctx: ProfileContext): ServerProfiles | null {
  const r = raw as Partial<ServerProfiles> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.profiles)) return null;
  const localDev = r.localDev === true;
  const seen = new Set<string>();
  const profiles: ServerProfile[] = [];
  for (const x of r.profiles.slice(0, MAX_SERVER_PROFILES)) {
    const p = x as Partial<ServerProfile> | null;
    if (!p || typeof p.url !== 'string') continue;
    let url: string;
    try {
      url = normalizeServerUrl(p.url, { allowLocalHttp: localDev });
    } catch {
      continue;
    }
    const id = ctx.scope(url);
    if (seen.has(id)) continue;
    seen.add(id);
    let name: string;
    try {
      name = typeof p.name === 'string' ? cleanName(p.name) : defaultName(url);
    } catch {
      name = defaultName(url);
    }
    const lc = p.lastCheck;
    profiles.push({
      id,
      name,
      url,
      addedAt: typeof p.addedAt === 'number' ? p.addedAt : 0,
      lastUsedAt: typeof p.lastUsedAt === 'number' ? p.lastUsedAt : 0,
      lastCheck: lc && typeof lc === 'object' && typeof lc.ok === 'boolean' && typeof lc.at === 'number' ? { ok: lc.ok, at: lc.at, ...(typeof lc.version === 'string' ? { version: lc.version.slice(0, 64) } : {}), ...(typeof lc.message === 'string' ? { message: lc.message.slice(0, 300) } : {}) } : null,
    });
  }
  if (!profiles.length) return null;
  const activeId = profiles.some((p) => p.id === r.activeId) ? (r.activeId as string) : [...profiles].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]!.id;
  return { version: 1, activeId, localDev, profiles };
}

export function activeProfile(s: ServerProfiles): ServerProfile {
  return s.profiles.find((p) => p.id === s.activeId) ?? s.profiles[0]!;
}

/**
 * Adds a server (or finds the saved one with the same address) and makes it
 * active. The previously active profile is kept so the user can switch back.
 */
export function connectProfile(s: ServerProfiles, url: string, ctx: ProfileContext, name?: string): { state: ServerProfiles; profile: ServerProfile } {
  const base = normalizeServerUrl(url, { allowLocalHttp: s.localDev });
  const id = ctx.scope(base);
  const now = ctx.now ?? Date.now();
  const existing = s.profiles.find((p) => p.id === id);
  if (existing) {
    const profile = { ...existing, url: base, lastUsedAt: now, ...(name ? { name: cleanName(name) } : {}) };
    return { state: { ...s, activeId: id, profiles: s.profiles.map((p) => (p.id === id ? profile : p)) }, profile };
  }
  if (s.profiles.length >= MAX_SERVER_PROFILES) throw new InvalidServerUrlError(`You can save up to ${MAX_SERVER_PROFILES} servers. Remove one first.`);
  const profile: ServerProfile = { id, name: name ? cleanName(name) : defaultName(base), url: base, addedAt: now, lastUsedAt: now, lastCheck: null };
  return { state: { ...s, activeId: id, profiles: [...s.profiles, profile] }, profile };
}

export function switchProfile(s: ServerProfiles, id: string, now = Date.now()): ServerProfiles {
  if (!s.profiles.some((p) => p.id === id)) throw new InvalidServerUrlError('That server is no longer saved');
  const p = s.profiles.find((x) => x.id === id)!;
  if (p.url.startsWith('http:') && !s.localDev) throw new InvalidServerUrlError('Turn on “Local development servers” to use this server');
  return { ...s, activeId: id, profiles: s.profiles.map((x) => (x.id === id ? { ...x, lastUsedAt: now } : x)) };
}

export function renameProfile(s: ServerProfiles, id: string, name: string): ServerProfiles {
  const n = cleanName(name);
  return { ...s, profiles: s.profiles.map((p) => (p.id === id ? { ...p, name: n } : p)) };
}

/** Forgets a saved server (not the active one). Its local data is removed by the caller. */
export function removeProfile(s: ServerProfiles, id: string): ServerProfiles {
  if (id === s.activeId) throw new InvalidServerUrlError('Switch to another server before removing this one');
  return { ...s, profiles: s.profiles.filter((p) => p.id !== id) };
}

export function recordCheck(s: ServerProfiles, id: string, check: ServerCheck, now = Date.now()): ServerProfiles {
  const summary: ServerCheckSummary = check.ok ? { ok: true, at: now, version: check.version } : { ok: false, at: now, message: check.message };
  return { ...s, profiles: s.profiles.map((p) => (p.id === id ? { ...p, lastCheck: summary } : p)) };
}

/** Turning local development off is refused while an http:// server is active. */
export function setLocalDev(s: ServerProfiles, on: boolean): ServerProfiles {
  if (!on && activeProfile(s).url.startsWith('http:')) throw new InvalidServerUrlError('Switch to an https:// server before turning off local development servers');
  return { ...s, localDev: on };
}

// --------------------------------------------------------------------------------------------
// Wording

const CHECK_TITLES: Record<ServerCheckCode, string> = {
  invalid_url: 'Invalid server address',
  unreachable: 'Can’t reach the server',
  timeout: 'The server did not answer',
  tls: 'Certificate problem',
  not_passvault: 'Not a PassVault server',
  incompatible: 'Incompatible server version',
  missing_capabilities: 'Server is missing features',
  unavailable: 'Server unavailable',
};

/** A check result worded for people (shared by the desktop app and the extension). */
export function describeCheck(c: ServerCheck): { ok: boolean; title: string; detail?: string; degraded?: boolean; registration?: 'open' | 'closed' } {
  if (!c.ok) return { ok: false, title: CHECK_TITLES[c.code], detail: c.message };
  return {
    ok: true,
    title: c.degraded ? 'PassVault server found, but it reports a problem' : 'Compatible PassVault server',
    detail: c.degraded ? `Version ${c.version}. The server answered but its database is unavailable; signing in may fail until it recovers.` : `Version ${c.version} · API v${c.apiVersion}. TLS and compatibility checks passed.`,
    degraded: c.degraded,
    registration: c.registration,
  };
}
