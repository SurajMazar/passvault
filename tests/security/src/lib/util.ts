import { spawnSync } from 'node:child_process';
import { ROOT } from './paths';

/** `git grep -n` over tracked files; [] when nothing matches (exit 1). Throws on real errors. */
export function gitGrep(pattern: string, paths: string[], opts: { extended?: boolean; ignoreCase?: boolean } = {}): string[] {
  const args = ['grep', '-n', '-I'];
  if (opts.extended) args.push('-E');
  if (opts.ignoreCase) args.push('-i');
  args.push('-e', pattern, '--', ...paths);
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 1) return [];
  if (r.status !== 0) throw new Error(`git grep failed: ${r.stderr}`);
  return r.stdout.trim().split('\n').filter(Boolean);
}

export interface CmdResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {}): CmdResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 15 * 60_000,
    maxBuffer: 256 * 1024 * 1024,
    input: opts.input,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
}

export function which(cmd: string): string | null {
  const r = spawnSync('/usr/bin/which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Encoded forms of a secret to search for in captured data: plain, JSON-escaped,
 * URL-encoded, hex, and base64/base64url at all three byte alignments (so a
 * secret embedded inside a larger base64 blob is still found).
 */
export function encodings(secret: string): string[] {
  const b = Buffer.from(secret, 'utf8');
  const out = new Set<string>([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), b.toString('hex')]);
  for (let pad = 0; pad < 3; pad++) {
    const shifted = Buffer.concat([Buffer.alloc(pad), b]);
    for (const enc of [shifted.toString('base64'), shifted.toString('base64url')]) {
      // drop characters influenced by the padding prefix and the unknown suffix
      const start = Math.ceil((pad * 4) / 3) + (pad ? 1 : 0);
      const core = enc.replace(/=+$/, '').slice(start, -2);
      if (core.length >= 12) out.add(core);
    }
  }
  return [...out].filter((s) => s.length >= 8);
}

/** Which encodings of which canaries appear in `haystack` (names only, never values). */
export function findCanaries(haystack: string, canaries: Record<string, string>): string[] {
  const hits: string[] = [];
  for (const [name, value] of Object.entries(canaries)) {
    for (const enc of encodings(value)) {
      if (haystack.includes(enc)) {
        hits.push(`${name}${enc === value ? '' : ' (encoded)'}`);
        break;
      }
    }
  }
  return hits;
}
