import { join } from 'node:path';
import { ROOT } from './paths';
import type { SuiteApi } from './results';
import { run, which } from './util';

export interface GoTestResult {
  pkg: string;
  test: string;
  action: 'pass' | 'fail' | 'skip';
  elapsed: number;
  output: string;
}

export const HELPER_DIR = join(ROOT, 'native/desktop-helper');

/** `go test -json` → one entry per top-level test. Returns null if Go is missing. */
export function goTest(pkgs: string[], runRe?: string): { results: GoTestResult[]; status: number | null; stderr: string } | null {
  if (!which('go')) return null;
  const args = ['test', '-json', '-count=1', ...(runRe ? ['-run', runRe] : []), ...pkgs];
  const r = run('go', args, { cwd: HELPER_DIR, env: { GOTOOLCHAIN: 'local', GOFLAGS: '-mod=mod' }, timeoutMs: 20 * 60_000 });
  const out = new Map<string, GoTestResult>();
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev: { Action: string; Package: string; Test?: string; Elapsed?: number; Output?: string };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev.Test || ev.Test.includes('/')) continue;
    const key = `${ev.Package}.${ev.Test}`;
    const cur = out.get(key) ?? { pkg: ev.Package.replace(/^.*\/internal\//, ''), test: ev.Test, action: 'skip' as const, elapsed: 0, output: '' };
    if (ev.Action === 'output' && ev.Output) cur.output += ev.Output;
    if (ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip') {
      cur.action = ev.Action;
      cur.elapsed = ev.Elapsed ?? 0;
    }
    out.set(key, cur);
  }
  return { results: [...out.values()], status: r.status, stderr: r.stderr };
}

/** Record one check per Go test (skips are `unverified`, never pass). */
export function recordGoTests(t: SuiteApi, prefix: string, results: GoTestResult[], describe: (name: string) => string) {
  for (const r of results) {
    const id = `${prefix}.${r.pkg}.${r.test}`;
    if (r.action === 'skip') {
      t.unverified(id, describe(r.test), `skipped: ${r.output.split('\n').filter((l) => /SKIP|skip/i.test(l)).join(' ').slice(0, 300) || 'no reason given'}`);
      continue;
    }
    void t.check(id, describe(r.test), () => ({ ok: r.action === 'pass', evidence: `${r.pkg}: ${r.test} ${r.action} in ${r.elapsed.toFixed(2)}s${r.action === 'fail' ? `\n${r.output.slice(-1500)}` : ''}` }), { severity: 'high' });
  }
}
