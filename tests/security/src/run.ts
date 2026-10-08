/**
 * Security verification harness runner.
 *
 *   pnpm --filter @passvault/security-harness security                 # every suite
 *   pnpm --filter @passvault/security-harness security auth sync       # selected suites
 *
 * Environment:
 *   PV_SEC_TARGET=<url>        use an existing API instead of the disposable stack
 *                              (loopback, or allow-listed staging — see lib/target.ts)
 *   PV_SEC_KEEP_STACK=1        leave the disposable stack running afterwards
 *   PV_SEC_SKIP_BUILD=1        do not rebuild the API image
 *
 * Writes results/<run-id>/results.json + report.md and results/latest/.
 * Exit code 1 when any check fails that is not covered by an unexpired
 * accepted-risk entry (accepted-risks.json).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Api } from './lib/http';
import { ARTIFACTS, HARNESS, RESULTS, ROOT } from './lib/paths';
import { Recorder, redact, type CheckResult, type RunMeta } from './lib/results';
import { stackDown, stackUp, type Stack } from './lib/stack';
import { TargetRefused, checkTarget } from './lib/target';
import type { Suite, SuiteContext } from './lib/suite';
import { renderReport } from './lib/report';
import auth from './suites/auth';
import authorization from './suites/authorization';
import crypto from './suites/crypto';
import sharing from './suites/sharing';
import sync from './suites/sync';
import web from './suites/web';
import extension from './suites/extension';
import desktop from './suites/desktop';
import native from './suites/native';
import ssh from './suites/ssh';
import envFiles from './suites/env-files';
import leakage from './suites/leakage';
import supplyChain from './suites/supply-chain';

const ALL: Suite[] = [crypto, envFiles, auth, authorization, sharing, sync, web, leakage, extension, desktop, native, ssh, supplyChain];

interface AcceptedRisk {
  id: string;
  checks: string[];
  owner: string;
  expires: string;
  rationale: string;
}

const log = (m: string) => console.log(`  ${m}`);

async function main() {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((w) => !ALL.some((s) => s.id === w));
  if (unknown.length) throw new Error(`unknown suite(s): ${unknown.join(', ')} (known: ${ALL.map((s) => s.id).join(', ')})`);
  const suites = wanted.length ? ALL.filter((s) => wanted.includes(s.id)) : ALL;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const git = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const meta: RunMeta = {
    startedAt: new Date().toISOString(),
    gitCommit: git(['rev-parse', 'HEAD']),
    gitDirty: git(['status', '--porcelain']).length > 0,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    target: { apiUrl: null, disposable: false },
    suites: suites.map((s) => s.id),
  };
  const recorder = new Recorder((r) => {
    const mark = { pass: '✓', fail: '✗', unverified: '?', blocked: '■', not_applicable: '–' }[r.status];
    console.log(`  ${mark} [${r.suite}] ${r.id} — ${r.title}${r.status === 'pass' ? '' : ` (${r.status})`}`);
  });

  let stack: Stack | null = null;
  let env: SuiteContext['env'] = null;
  const needApi = suites.some((s) => s.needsApi);
  let apiProblem: string | null = null;
  if (needApi) {
    try {
      if (process.env.PV_SEC_TARGET) {
        checkTarget(process.env.PV_SEC_TARGET);
        env = { api: new Api(process.env.PV_SEC_TARGET), mailpit: process.env.PV_SEC_MAILPIT ?? '', stack: null, disposable: false };
        meta.target = { apiUrl: process.env.PV_SEC_TARGET, disposable: false };
      } else {
        stack = await stackUp({ log });
        env = { api: new Api(stack.apiUrl), mailpit: stack.mailpitUrl, stack, disposable: true };
        meta.target = { apiUrl: stack.apiUrl, disposable: true };
      }
    } catch (e) {
      apiProblem = e instanceof TargetRefused ? `target refused: ${e.message}` : `live API unavailable: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`  ! ${apiProblem}`);
    }
  }

  try {
    for (const s of suites) {
      console.log(`\n▶ security/${s.id} — ${s.title}`);
      const t = recorder.forSuite(s.id);
      if (s.needsApi && !env) {
        t.unverified(`${s.id}.suite`, `${s.title} (whole suite)`, apiProblem ?? 'no live API');
        continue;
      }
      try {
        await s.run({ t, env, log });
      } catch (e) {
        await t.check(`${s.id}.suite-crashed`, `suite ${s.id} ran to completion`, () => {
          throw e;
        }, { severity: 'high' });
      }
    }
  } finally {
    if (stack && process.env.PV_SEC_KEEP_STACK !== '1') {
      try {
        stackDown(log);
      } catch (e) {
        console.error(`  ! could not remove the disposable stack: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // Accepted risks: a failing check covered by an unexpired entry is reported but does not fail the run.
  const risksFile = join(HARNESS, 'accepted-risks.json');
  const risks: AcceptedRisk[] = existsSync(risksFile) ? (JSON.parse(readFileSync(risksFile, 'utf8')) as { risks: AcceptedRisk[] }).risks : [];
  const today = new Date().toISOString().slice(0, 10);
  for (const r of recorder.results) {
    if (r.status !== 'fail') continue;
    const risk = risks.find((k) => k.checks.includes(r.id));
    if (risk) r.acceptedRisk = { id: risk.id, owner: risk.owner, expires: risk.expires, rationale: risk.rationale };
  }
  meta.finishedAt = new Date().toISOString();
  const blocking = recorder.results.filter((r) => r.status === 'fail' && (!r.acceptedRisk || r.acceptedRisk.expires < today));

  const out = join(RESULTS, runId);
  mkdirSync(out, { recursive: true });
  const json = JSON.stringify({ meta, results: recorder.results }, null, 2);
  writeFileSync(join(out, 'results.json'), redact(json));
  writeFileSync(join(out, 'report.md'), redact(renderReport(meta, recorder.results, blocking)));
  if (existsSync(ARTIFACTS)) {
    cpSync(ARTIFACTS, join(out, 'artifacts'), { recursive: true });
    rmSync(ARTIFACTS, { recursive: true, force: true });
  }
  // The harness's own output must not become a secret archive: verify redaction worked.
  const leaked = checkOwnArtifacts(out);
  if (leaked.length) console.error(`  ! secrets found in harness output (${leaked.join(', ')}) — results withheld`);
  rmSync(join(RESULTS, 'latest'), { recursive: true, force: true });
  cpSync(out, join(RESULTS, 'latest'), { recursive: true });

  const count = (s: CheckResult['status']) => recorder.results.filter((r) => r.status === s).length;
  console.log(
    `\n${recorder.results.length} checks: ${count('pass')} pass, ${count('fail')} fail (${blocking.length} blocking), ${count('unverified')} unverified, ${count('blocked')} blocked, ${count('not_applicable')} n/a`,
  );
  console.log(`results: ${join(out, 'results.json')}\nreport:  ${join(out, 'report.md')}`);
  process.exit(blocking.length || leaked.length ? 1 : 0);
}

function checkOwnArtifacts(dir: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(dir)) {
    const text = readFileSync(f, 'utf8');
    if (redact(text) !== text) {
      hits.push(f.replace(`${dir}/`, ''));
      rmSync(f);
    }
  }
  return hits;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
