import { getDomain } from 'tldts';
import type { LoginUrl, UrlMatchMode } from '@passvault/types';

/**
 * Website matching for autofill. Matching is deliberately conservative:
 *  - only http(s) pages are eligible;
 *  - the default mode is `host` (exact host and port), not base domain;
 *  - a login saved for https:// never silently matches an http:// page
 *    (`insecure` is reported so the UI can require explicit confirmation);
 *  - IP addresses and single-label hosts never use base-domain matching.
 */
export interface UrlMatchResult {
  matches: boolean;
  /** page is http while the saved URL is https, or page is plain http */
  insecure: boolean;
  mode: UrlMatchMode;
}

export function normalizeLoginUrl(raw: string): URL | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u;
  } catch {
    return null;
  }
}

function isIpOrSingleLabel(host: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || !host.includes('.');
}

export function matchUrl(saved: LoginUrl, pageUrl: string): UrlMatchResult {
  const no = { matches: false, insecure: false, mode: saved.match };
  if (saved.match === 'never') return no;
  const s = normalizeLoginUrl(saved.url);
  let p: URL;
  try {
    p = new URL(pageUrl);
  } catch {
    return no;
  }
  if (!s || (p.protocol !== 'https:' && p.protocol !== 'http:')) return no;
  const insecure = p.protocol === 'http:' && (s.protocol === 'https:' || !isLocalhost(p.hostname));
  let matches = false;
  switch (saved.match) {
    case 'host':
      matches = s.hostname === p.hostname && effectivePort(s) === effectivePort(p);
      break;
    case 'base_domain': {
      if (isIpOrSingleLabel(s.hostname) || isIpOrSingleLabel(p.hostname)) {
        matches = s.hostname === p.hostname;
      } else {
        const sd = getDomain(s.hostname, { allowPrivateDomains: true });
        const pd = getDomain(p.hostname, { allowPrivateDomains: true });
        matches = !!sd && sd === pd;
      }
      break;
    }
    case 'starts_with':
      matches = stripHash(p.href).startsWith(stripHash(s.href));
      break;
    case 'exact':
      matches = stripHash(p.href) === stripHash(s.href);
      break;
  }
  return { matches, insecure: matches && insecure, mode: saved.match };
}

/** True when any of the login's URLs match the page. Returns the best (secure-first) result. */
export function matchLogin(urls: LoginUrl[], pageUrl: string): UrlMatchResult | null {
  let best: UrlMatchResult | null = null;
  for (const u of urls) {
    const r = matchUrl(u, pageUrl);
    if (r.matches && (!best || (best.insecure && !r.insecure))) best = r;
  }
  return best;
}

function effectivePort(u: URL) {
  return u.port || (u.protocol === 'https:' ? '443' : '80');
}

function stripHash(href: string) {
  const i = href.indexOf('#');
  return i >= 0 ? href.slice(0, i) : href;
}

function isLocalhost(h: string) {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

/** Origin string (scheme://host:port) of a page URL, or null if not http(s). */
export function pageOrigin(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}
