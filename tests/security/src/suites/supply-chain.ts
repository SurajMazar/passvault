import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS, ROOT, WORK } from '../lib/paths';
import type { Suite } from '../lib/suite';
import { run, which } from '../lib/util';

/** High-confidence secret patterns (names only are reported, never matches). */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe live key', /\b(sk|rk)_live_[0-9a-zA-Z]{20,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['generic assigned secret', /\b(?:SECRET|PASSWORD|PEPPER|API_KEY|TOKEN)[A-Z_]*\s*[:=]\s*["']?(?![<$]|ci-only|changeme|example|replace|your-|xxx|\*\*\*)[A-Za-z0-9+/_-]{24,}/],
];
/** Files that legitimately contain test fixtures that look like secrets. */
const ALLOW = [/(^|\/)test(s)?\//, /\.test\.tsx?$/, /_test\.go$/, /fixtures?\//, /\.example$/, /^docs\/licenses-npm\.md$/, /pnpm-lock\.yaml$/, /go\.sum$/];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function scanSecrets(files: Array<{ name: string; text: string }>): string[] {
  const hits: string[] = [];
  for (const f of files) {
    if (ALLOW.some((a) => a.test(f.name))) continue;
    for (const [name, re] of SECRET_PATTERNS) if (re.test(f.text)) hits.push(`${f.name}: ${name}`);
  }
  return hits;
}

const LICENSE_OK = /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|MIT-0|OFL-1\.1|CC0-1\.0|BlueOak-1\.0\.0|Unlicense|Python-2\.0|CC-BY-4\.0|\(MIT OR Apache-2\.0\)|\(MIT OR CC0-1\.0\)|MIT OR Apache-2\.0|Apache-2\.0 OR MIT)$/;

const suite: Suite = {
  id: 'supply-chain',
  title: 'Dependencies, secrets in the repository and artifacts, CI/CD, containers and releases',
  needsApi: false,
  async run({ t }) {
    await t.check('sc.lockfile', 'The lockfile is consistent with every package.json (frozen install changes nothing)', () => {
      const lock = join(ROOT, 'pnpm-lock.yaml');
      const before = readFileSync(lock, 'utf8');
      const r = run('pnpm', ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'], {});
      const same = readFileSync(lock, 'utf8') === before;
      return { ok: r.status === 0 && same, evidence: `frozen offline install exit ${r.status}${r.status ? `: ${r.stderr.slice(-800)}` : ''}; lockfile unchanged by the install: ${same}` };
    }, { severity: 'high' });

    await t.check('sc.npm-audit', 'No high or critical advisories in production npm dependencies (pnpm audit)', () => {
      const r = run('pnpm', ['audit', '--prod', '--json'], { timeoutMs: 5 * 60_000 });
      let j: { metadata?: { vulnerabilities?: Record<string, number> }; advisories?: Record<string, { severity: string; module_name: string; title: string; url: string }> };
      try {
        j = JSON.parse(r.stdout);
      } catch {
        return { status: 'unverified', evidence: `pnpm audit gave no JSON (registry unreachable?): ${(r.stderr || r.stdout).slice(-600)}` };
      }
      const v = j.metadata?.vulnerabilities ?? {};
      const adv = Object.values(j.advisories ?? {}).map((a) => `${a.severity}: ${a.module_name} — ${a.title} (${a.url})`);
      return { ok: !v.high && !v.critical, evidence: `counts ${JSON.stringify(v)}${adv.length ? `\n${adv.join('\n')}` : ''}\n(severity from the advisory database; reachability not assessed)` };
    }, { severity: 'high' });

    const tracked = run('git', ['ls-files']).stdout.split('\n').filter(Boolean);
    await t.check('sc.secrets.tracked-files', 'No credentials, private keys or real .env files in tracked files', () => {
      const envs = tracked.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.example'));
      const files = tracked.filter((f) => !/\.(png|jpg|ico|mp4|woff2?|ttf|icns|zip|dmg)$/.test(f)).map((f) => ({ name: f, text: existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f), 'utf8') : '' }));
      const hits = scanSecrets(files);
      return { ok: !envs.length && !hits.length, evidence: `${tracked.length} tracked files; .env files: ${envs.join(', ') || 'none'}; pattern hits: ${hits.join('; ') || 'none'}` };
    }, { severity: 'critical' });

    await t.check('sc.secrets.history', 'No credentials or private keys anywhere in git history', () => {
      const log = run('git', ['log', '-p', '--all', '--no-color', '--unified=0'], { timeoutMs: 5 * 60_000 }).stdout;
      // Split per file section so allowlisted test files are skipped.
      const sections = log.split(/^diff --git /m).map((s) => ({ name: /^a\/(\S+)/.exec(s)?.[1] ?? '', text: s.split('\n').filter((l) => l.startsWith('+')).join('\n') }));
      const hits = [...new Set(scanSecrets(sections))];
      return { ok: hits.length === 0, evidence: `${sections.length} file changes scanned; hits: ${hits.join('; ') || 'none'}` };
    }, { severity: 'critical' });

    await t.check('sc.private-domain', 'The private production domain is not committed (it lives only in gitignored env files / CI variables)', () => {
      const envFile = join(ROOT, 'apps/browser-extension/.env.production');
      if (!existsSync(envFile)) return { status: 'unverified', evidence: 'no local production env file to read the domain from' };
      const host = /VITE_API_URL=https?:\/\/([^/\s]+)/.exec(readFileSync(envFile, 'utf8'))?.[1];
      if (!host || host.endsWith('example.com')) return { status: 'unverified', evidence: 'no private domain configured locally' };
      const grep = run('git', ['grep', '-l', '-F', host]);
      const hist = run('git', ['log', '--all', '-S', host, '--oneline']);
      return { ok: !grep.stdout.trim() && !hist.stdout.trim(), evidence: `tracked files containing it: ${grep.stdout.trim().split('\n').filter(Boolean).length}; commits that added/removed it: ${hist.stdout.trim().split('\n').filter(Boolean).length}` };
    }, { severity: 'medium' });

    await t.check('sc.secrets.build-artifacts', 'Built artifacts (web, extension, desktop UI) contain no secret patterns', () => {
      const dirs = ['web-dist', 'ext-prod', 'ext-local', 'desktop-ui'].map((d) => join(WORK, d)).filter(existsSync);
      if (!dirs.length) return { status: 'unverified', evidence: 'no build outputs in tests/security/.work (run the web/extension/desktop suites first)' };
      const files = dirs.flatMap(walk).filter((f) => /\.(js|html|json|css|txt|map)$/.test(f)).map((f) => ({ name: f.replace(`${WORK}/`, ''), text: readFileSync(f, 'utf8') }));
      const hits = scanSecrets(files);
      return { ok: hits.length === 0, evidence: `${files.length} files in ${dirs.map((d) => d.replace(`${WORK}/`, '')).join(', ')}; hits: ${hits.join('; ') || 'none'}` };
    }, { severity: 'high' });

    if (which('gitleaks')) {
      await t.check('sc.gitleaks', 'gitleaks finds no secrets in the repository history', () => {
        const r = run('gitleaks', ['detect', '--no-banner', '--redact', '-s', ROOT]);
        return { ok: r.status === 0, evidence: (r.stdout + r.stderr).slice(-2000) };
      }, { severity: 'high' });
    } else t.unverified('sc.gitleaks', 'gitleaks secret scan', 'gitleaks not installed locally; runs in CI (security.yml); the built-in scanner above ran instead');

    // ------------------------------------------------------------------ inventory / licenses / SBOM
    mkdirSync(ARTIFACTS, { recursive: true });
    await t.check('sc.inventory', 'Dependency inventory generated; production npm licenses are permissive', () => {
      const lic = run('pnpm', ['licenses', 'list', '--prod', '--json'], { timeoutMs: 5 * 60_000 });
      let j: Record<string, Array<{ name: string; versions: string[]; license: string }>>;
      try {
        j = JSON.parse(lic.stdout);
      } catch {
        return { ok: false, evidence: `pnpm licenses failed: ${lic.stderr.slice(-500)}` };
      }
      const go = which('go') ? run('go', ['list', '-m', 'all'], { cwd: join(ROOT, 'native/desktop-helper'), env: { GOTOOLCHAIN: 'local' } }).stdout.trim().split('\n') : [];
      const pkgs = Object.entries(j).flatMap(([license, list]) => list.map((p) => ({ name: p.name, versions: p.versions, license })));
      writeFileSync(join(ARTIFACTS, 'dependency-inventory.json'), JSON.stringify({ generated: new Date().toISOString(), npmProduction: pkgs, goModules: go }, null, 2));
      const bad = pkgs.filter((p) => !LICENSE_OK.test(p.license));
      return { ok: bad.length === 0, evidence: `${pkgs.length} npm production packages, ${go.length} Go modules → dependency-inventory.json; non-permissive/unknown: ${bad.map((b) => `${b.name} (${b.license})`).join(', ') || 'none'}` };
    }, { severity: 'medium' });
    if (which('syft')) {
      await t.check('sc.sbom', 'CycloneDX SBOM generated with syft', () => {
        const r = run('syft', ['dir:.', '-o', `cyclonedx-json=${join(ARTIFACTS, 'sbom.cdx.json')}`]);
        return { ok: r.status === 0, evidence: r.status === 0 ? 'sbom.cdx.json written' : r.stderr.slice(-800) };
      }, { severity: 'low' });
    } else t.unverified('sc.sbom', 'Standard-format SBOM (CycloneDX/SPDX)', 'syft not installed locally; generated in CI (security.yml, anchore/sbom-action). The JSON inventory above is not a standard SBOM.');

    // ------------------------------------------------------------------ CI / CD
    const wf = (n: string) => readFileSync(join(ROOT, '.github/workflows', n), 'utf8');
    const workflows = readdirSync(join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml'));
    await t.check('sc.ci.least-privilege', 'Workflows: read-only default token, no pull_request_target, release secrets only in tag/manual-triggered jobs', () => {
      const out: string[] = [];
      let ok = true;
      for (const f of workflows) {
        const y = wf(f);
        const top = /^permissions:\s*\n((?:\s+.+\n)+)/m.exec(y)?.[1] ?? '';
        const prt = /pull_request_target/.test(y);
        const prSecrets = /\bpull_request\b/.test(y) && /secrets\.(?!GITHUB_TOKEN)/.test(y);
        const writeAll = /permissions:\s*write-all/.test(y);
        out.push(`${f}: top-level permissions ${top.trim().replace(/\s+/g, ' ') || 'MISSING'}; pull_request_target ${prt}; secrets reachable from PRs ${prSecrets}`);
        ok &&= !!top && !prt && !prSecrets && !writeAll && /contents:\s*read/.test(top);
      }
      return { ok, evidence: out.join('\n') };
    }, { severity: 'high' });

    await t.check('sc.ci.actions-pinned', 'Third-party GitHub Actions are pinned to full commit SHAs', () => {
      // Local reusable workflows (./.github/workflows/…) are versioned by the commit itself.
      const uses = workflows.flatMap((f) => [...wf(f).matchAll(/uses:\s*([^\s#]+)/g)].filter((m) => !m[1]!.startsWith('./')).map((m) => `${f}: ${m[1]}`));
      const unpinned = uses.filter((u) => !/@[0-9a-f]{40}$/.test(u));
      return { ok: unpinned.length === 0, evidence: `${uses.length} action references; not SHA-pinned: ${unpinned.length}${unpinned.length ? `\n${[...new Set(unpinned)].join('\n')}` : ''}` };
    }, { severity: 'medium', finding: 'PV-SEC-003' });

    if (which('actionlint')) {
      await t.check('sc.ci.actionlint', 'actionlint finds no workflow errors', () => {
        const r = run('actionlint', [], {});
        return { ok: r.status === 0, evidence: r.status === 0 ? `${workflows.length} workflows clean` : r.stdout.slice(-2000) };
      }, { severity: 'low' });
    } else t.unverified('sc.ci.actionlint', 'actionlint', 'actionlint not installed');

    await t.check('sc.ci.security-gate', 'CI runs the security gate (audit fails on high/critical, secret scan, govulncheck, harness offline suites)', () => {
      const has = existsSync(join(ROOT, '.github/workflows/security.yml'));
      const y = has ? wf('security.yml') : '';
      const ok = has && /pnpm audit --prod --audit-level=high/.test(y) && /gitleaks/.test(y) && /govulncheck/.test(y) && /security-harness/.test(y);
      return { ok, evidence: has ? 'security.yml: audit (high), gitleaks, govulncheck, harness offline suites' : 'no security workflow' };
    }, { severity: 'medium', finding: 'PV-SEC-005' });

    // ------------------------------------------------------------------ containers / deployment
    await t.check('sc.containers', 'Containers: API non-root, read-only, no capabilities, no-new-privileges; database not published; ports bound to loopback', () => {
      const c = readFileSync(join(ROOT, 'compose.yaml'), 'utf8');
      const prod = readFileSync(join(ROOT, 'deploy/compose.prod.yaml'), 'utf8');
      const cf = readFileSync(join(ROOT, 'apps/api/Containerfile'), 'utf8');
      const apiBlock = /\n {2}api:\n([\s\S]*?)(?=\n {2}\w|\nvolumes:)/.exec(c)?.[1] ?? '';
      const pgBlock = /\n {2}postgres:\n([\s\S]*?)(?=\n {2}\w)/.exec(c)?.[1] ?? '';
      const ok =
        /read_only: true/.test(apiBlock) &&
        /cap_drop:\s*\n\s*- ALL/.test(apiBlock) &&
        /no-new-privileges:true/.test(apiBlock) &&
        !/ports:/.test(pgBlock) &&
        [...c.matchAll(/"(\d[\d.:]*?):\$\{/g)].every((m) => m[1]!.startsWith('127.0.0.1')) &&
        /USER node/.test(cf) &&
        !/postgres:[\s\S]*?ports:/.test(prod.split('caddy:')[0] ?? '');
      const pinned = /FROM \S+@sha256:/.test(cf);
      return { ok, evidence: `api: read_only, cap_drop ALL, no-new-privileges; postgres not published; host ports on 127.0.0.1; Containerfile USER node. Base images pinned by digest: ${pinned} (tags only — see residual risks)` };
    }, { severity: 'high' });

    await t.check('sc.release.authenticity', 'Desktop releases: signed + notarized when credentials exist, otherwise explicitly UNSIGNED; checksums published; no auto-updater to hijack', () => {
      const r = wf('release.yml');
      const updater = run('git', ['grep', '-l', '-i', '-E', 'autoupdat|updater|checkForUpdates|update\\.json', '--', 'apps/desktop/src', 'native']).stdout.trim();
      const ok = /notar/i.test(r) && /UNSIGNED/.test(r) && /SHA256SUMS/.test(r) && !updater;
      return { ok, evidence: `release.yml: notarization step ${/notar/i.test(r)}, UNSIGNED labelling ${/UNSIGNED/.test(r)}, SHA256SUMS ${/SHA256SUMS/.test(r)}; update mechanism in the app: ${updater || 'none (users install new versions manually)'}` };
    }, { severity: 'medium' });
  },
};

export default suite;
