/**
 * Server address helpers shared by the clients that can switch between the
 * production server and a local development server (desktop app, browser
 * extension). The web dashboard always talks to the origin it was served for.
 */

/** Local development API (compose.yaml publishes the API on this port). */
export const LOCAL_API_URL = 'http://localhost:3000';
/** Local development web dashboard (Vite dev server / preview). */
export const LOCAL_WEB_URL = 'http://localhost:5173';

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

export function isLoopbackServer(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
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
