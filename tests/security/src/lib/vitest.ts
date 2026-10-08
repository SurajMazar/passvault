import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './paths';
import type { CheckOpts, SuiteApi } from './results';
import { run } from './util';

interface VitestJson {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  testResults: Array<{ name: string; assertionResults: Array<{ fullName: string; status: string }> }>;
}

/**
 * Runs a package's vitest suite with the JSON reporter and records ONE check.
 * Passes only if tests actually ran (total > 0) and none failed; skipped
 * tests are listed in the evidence.
 */
export async function vitestCheck(
  t: SuiteApi,
  id: string,
  title: string,
  pkgDir: string,
  opts: CheckOpts & { files?: string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<VitestJson | null> {
  let parsed: VitestJson | null = null;
  await t.check(
    id,
    title,
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'pv-vitest-'));
      const out = join(dir, 'out.json');
      try {
        const r = run('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${out}`, ...(opts.files ?? [])], { cwd: join(ROOT, pkgDir), env: opts.env });
        let j: VitestJson;
        try {
          j = JSON.parse(readFileSync(out, 'utf8')) as VitestJson;
        } catch {
          return { ok: false, evidence: `vitest produced no JSON (exit ${r.status}):\n${(r.stderr || r.stdout).slice(-2500)}` };
        }
        parsed = j;
        const failed = j.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName));
        const skipped = j.numPendingTests + j.numTodoTests;
        const ok = j.numTotalTests > 0 && j.numFailedTests === 0 && r.status === 0;
        return {
          ok,
          evidence: `${j.numPassedTests}/${j.numTotalTests} passed in ${pkgDir}${skipped ? `, ${skipped} skipped/todo` : ''}${failed.length ? `\nfailed:\n${failed.join('\n')}` : ''}${!ok && !failed.length ? `\nexit ${r.status}: ${(r.stderr || '').slice(-1500)}` : ''}`,
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    opts,
  );
  return parsed;
}
