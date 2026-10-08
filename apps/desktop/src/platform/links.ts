/**
 * External links. Only http(s) URLs are ever opened, and only after the user
 * confirmed the exact URL. Anything else (file:, javascript:, custom schemes
 * such as x-apple.systempreferences:, ssh:, …) is refused.
 *
 * The helper opens the link (`link.open`: validated again in Go, launched as
 * `/usr/bin/open <url>` with an argv list, no shell). Neutralino's `os.open`
 * is NOT on the native allowlist: it runs `open "<url>"` through /bin/sh, so
 * any script in the webview could have turned it into a shell command
 * (finding PV-SEC-002). Characters outside a conservative URL-safe set are
 * still percent-encoded (defence in depth).
 */

const SHELL_SAFE_URL_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!&'()*+,;=%]/;

/** Percent-encodes every character outside a conservative, shell-inert URL character set. */
export function shellSafeUrl(u: URL): string {
  let out = '';
  for (const ch of u.toString()) {
    if (SHELL_SAFE_URL_CHAR.test(ch)) out += ch;
    else for (const b of new TextEncoder().encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function parseSafeExternalUrl(raw: string): URL | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 4096) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname) return null;
  return u;
}

export interface ExternalLinkDeps {
  confirm(opts: { title: string; body: string; url: string; confirmLabel: string }): Promise<boolean>;
  open(url: string): Promise<unknown>;
}

/** Returns true if the URL was opened. Throws for URLs that may never be opened. */
export async function openExternalConfirmed(raw: string, deps: ExternalLinkDeps, source = 'PassVault'): Promise<boolean> {
  const u = parseSafeExternalUrl(raw);
  if (!u) throw new Error('Only http:// and https:// links can be opened');
  const ok = await deps.confirm({
    title: 'Open link in your browser?',
    body: `${source} wants to open this address in your default browser. Check that it is where you expect to go.`,
    url: u.toString(),
    confirmLabel: 'Open link',
  });
  if (!ok) return false;
  await deps.open(shellSafeUrl(u));
  return true;
}
