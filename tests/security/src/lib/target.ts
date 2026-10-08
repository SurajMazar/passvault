import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths';

/**
 * Target allowlist. Active tests run only against:
 *   - the disposable stack the harness starts (loopback), or
 *   - a loopback URL given in PV_SEC_TARGET, or
 *   - a staging URL listed in tests/security/targets.allow.json AND given in
 *     PV_SEC_TARGET AND acknowledged with PV_SEC_I_AM_AUTHORIZED=<that url>.
 * Anything that looks like the production server is refused, always.
 * Destructive suites (lockouts, account reset) only run on the disposable stack.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface Target {
  apiUrl: string;
  mailpitUrl: string | null;
  disposable: boolean;
}

function productionOrigins(): string[] {
  const out: string[] = [];
  const files = ['apps/browser-extension/.env.production', 'apps/web/.env.production', 'apps/desktop/.env.production', 'deploy/.env.production'];
  for (const f of files) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*(?:VITE_API_URL|VITE_PRODUCTION_URL|VITE_WEB_URL|PV_DOMAIN|DOMAIN|WEB_APP_URL)\s*=\s*"?([^"\s#]+)/.exec(line);
      if (!m) continue;
      try {
        out.push(new URL(m[1]!.includes('://') ? m[1]! : `https://${m[1]}`).host);
      } catch {
        /* ignore */
      }
    }
  }
  for (const v of [process.env.PV_PRODUCTION_URL, process.env.VITE_PRODUCTION_URL]) {
    if (v) {
      try {
        out.push(new URL(v).host);
      } catch {
        /* ignore */
      }
    }
  }
  return [...new Set(out)];
}

export class TargetRefused extends Error {}

export function checkTarget(url: string): { disposable: false } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new TargetRefused(`invalid target URL ${url}`);
  }
  if (productionOrigins().includes(u.host)) throw new TargetRefused(`refusing ${u.host}: it matches a configured production server`);
  if (LOOPBACK.has(u.hostname)) return { disposable: false };
  const allowFile = join(ROOT, 'tests/security/targets.allow.json');
  const allowed: string[] = existsSync(allowFile) ? (JSON.parse(readFileSync(allowFile, 'utf8')) as { staging: string[] }).staging : [];
  if (!allowed.map((a) => new URL(a).origin).includes(u.origin)) {
    throw new TargetRefused(`refusing ${u.origin}: not loopback and not listed in tests/security/targets.allow.json`);
  }
  if (process.env.PV_SEC_I_AM_AUTHORIZED !== u.origin) {
    throw new TargetRefused(`refusing ${u.origin}: set PV_SEC_I_AM_AUTHORIZED=${u.origin} to confirm written authorization for this staging target`);
  }
  return { disposable: false };
}

export function assertLoopback(url: string) {
  const u = new URL(url);
  if (!LOOPBACK.has(u.hostname)) throw new TargetRefused(`${url} is not a loopback address`);
}
