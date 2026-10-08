import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { initCrypto } from '@passvault/crypto';
import { newItem } from '@passvault/vault-core';
import { freshTotp, newActor } from '../lib/actors';
import { signIn } from '../lib/client';
import { brief, traffic } from '../lib/http';
import { ROOT, WORK } from '../lib/paths';
import { assert } from '../lib/results';
import type { Suite } from '../lib/suite';
import { gitGrep, run, sleep } from '../lib/util';

const XSS_FLAG = '__pvxss';
const PAYLOADS = [
  `<img src=x onerror="window.${XSS_FLAG}=(window.${XSS_FLAG}||0)+1">`,
  `"><svg onload="window.${XSS_FLAG}=1">`,
  `<script>window.${XSS_FLAG}=1</script>`,
  `javascript:window.${XSS_FLAG}=1`,
  `<a href="javascript:window.${XSS_FLAG}=1">click</a>`,
  `{{constructor.constructor('window.${XSS_FLAG}=1')()}}`,
  `<iframe srcdoc="<script>parent.${XSS_FLAG}=1</script>"></iframe>`,
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Names of server-only configuration that a client never needs. (Generic names such as DATABASE_URL are
// not listed: the env-file editor legitimately shows them as examples; actual secret VALUES are checked below.)
const SERVER_ONLY = ['MFA_ENCRYPTION_KEY', 'RECOVERY_CODE_PEPPER', 'PRELOGIN_SECRET', 'SMTP_PASSWORD', 'POSTGRES_PASSWORD', 'AUTH_HASH_', 'MACOS_CERT', 'APPLE_ID', 'CWS_CLIENT_SECRET'];
// Hostnames (not bare words: dictionaries such as zxcvbn's contain words like "amplitude" or "clarity").
const TRACKERS = ['google-analytics.com', 'googletagmanager.com', 'sentry.io', 'ingest.sentry', 'segment.io', 'cdn.segment.com', 'api.mixpanel.com', 'hotjar.com', 'posthog.com', 'fullstory.com', 'datadoghq.com', 'nr-data.net', 'logrocket.com', 'clarity.ms', 'amplitude.com', 'browser-intake'];

const suite: Suite = {
  id: 'web',
  title: 'Web application and API surface (headers, XSS, injection, limits, bundles)',
  needsApi: true,
  async run(ctx) {
    const { t, log } = ctx;
    const env = ctx.env!;
    const api = env.api;
    await initCrypto();

    await t.check('web.api.headers', 'API responses carry restrictive security headers', async () => {
      const r = await fetch(`${api.base}/api/v1/health`);
      const h = (n: string) => r.headers.get(n);
      const csp = h('content-security-policy') ?? '';
      const ok = csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'") && h('x-content-type-options') === 'nosniff' && !h('x-powered-by') && !!h('referrer-policy');
      return { ok, evidence: `CSP "${csp}"; nosniff=${h('x-content-type-options')}; x-powered-by=${h('x-powered-by')}; referrer-policy=${h('referrer-policy')}; x-frame-options=${h('x-frame-options')}` };
    }, { severity: 'medium' });

    await t.check('web.errors.no-internals', 'Error responses do not leak stack traces, SQL or framework internals', async () => {
      const probes = [
        await api.call('POST', '/auth/login', { rawBody: '{"email":' }),
        await api.call('POST', '/auth/login', { rawBody: '[]' }),
        await api.get('/records/not-a-uuid', { token: 'A'.repeat(43) }),
        await api.get('/does/not/exist'),
        await api.post('/auth/prelogin', { email: { $ne: null } }),
      ];
      const bad = probes.filter((p) => /\bat \w+ \(|prisma|node_modules|Error:|SELECT |stack/i.test(p.text));
      return { ok: bad.length === 0 && probes.every((p) => p.status < 500), evidence: probes.map((p) => `${brief(p)}`).join('; ') + (bad.length ? `\nleaky: ${bad.map((b) => b.text.slice(0, 200)).join(' | ')}` : '') };
    }, { severity: 'medium' });

    await t.check('web.api.body-limits', 'Oversized and deeply nested bodies are rejected quickly and the API stays healthy', async () => {
      const big = await api.call('POST', '/auth/prelogin', { rawBody: JSON.stringify({ email: 'a@b.c', pad: 'x'.repeat(4 * 1024 * 1024) }), noRetry: true });
      const t0 = Date.now();
      const deep = await api.call('POST', '/auth/prelogin', { rawBody: '['.repeat(100_000) + ']'.repeat(100_000), noRetry: true });
      const deepMs = Date.now() - t0;
      const health = await fetch(`${api.base}/api/v1/health`);
      return { ok: big.status === 413 && deep.status === 400 && deepMs < 3000 && health.ok, evidence: `4 MB body → ${brief(big)}; 100k-deep JSON → ${brief(deep)} in ${deepMs} ms; health afterwards ${health.status}` };
    }, { severity: 'medium' });

    await t.check('web.api.injection', 'Injection-shaped input is rejected by validation, never reaching the database as code', async () => {
      const probes = [
        await api.post('/auth/prelogin', { email: "a@b.c' OR '1'='1" }),
        await api.post('/auth/register/start', { email: 'x@y.z"; DROP TABLE "User";--' }),
        await api.get(`/records/${encodeURIComponent("1' OR '1'='1")}`, { token: 'A'.repeat(43) }),
        await api.get('/health', { query: { cursor: "1;SELECT pg_sleep(5)" } }),
      ];
      const raw = gitGrep('\\$queryRawUnsafe|\\$executeRawUnsafe|Prisma\\.raw\\(', ['apps/api/src'], { extended: true });
      const interp = gitGrep('\\$queryRaw`[^`]*\\$\\{', ['apps/api/src'], { extended: true });
      return {
        ok: probes.every((p) => p.status < 500) && raw.length === 0 && interp.length === 0,
        evidence: `probe statuses: ${probes.map(brief).join(', ')}; unsafe raw SQL in apps/api/src: ${raw.length}; interpolated $queryRaw: ${interp.length}`,
      };
    }, { severity: 'high' });

    await t.check('web.api.prototype-pollution', '__proto__/constructor payloads are rejected and do not alter server objects', async () => {
      const a = await api.call('POST', '/auth/prelogin', { rawBody: '{"email":"p@q.r","__proto__":{"polluted":"yes"}}' });
      const b = await api.call('POST', '/auth/prelogin', { rawBody: '{"email":"p@q.r","constructor":{"prototype":{"polluted":"yes"}}}' });
      const after = await api.post('/auth/prelogin', { email: 'clean@example.test' });
      return { ok: a.status === 400 && b.status === 400 && !after.text.includes('polluted'), evidence: `__proto__ → ${brief(a)}; constructor.prototype → ${brief(b)}; later response clean: ${!after.text.includes('polluted')}` };
    }, { severity: 'medium' });

    await t.check('web.api.path-traversal', 'Traversal-shaped paths never reach the filesystem', async () => {
      const paths = ['/api/v1/../../../../etc/passwd', '/api/v1/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/api/v1/..%2f..%2f..%2fetc%2fpasswd', '/api/v1/records/..%5c..%5cwindows'];
      const out: string[] = [];
      for (const p of paths) {
        const r = await fetch(`${api.base}${p}`);
        const text = await r.text();
        out.push(`${p} → ${r.status}`);
        assert(!text.includes('root:'), `${p} returned file content`);
      }
      return { ok: true, evidence: out.join('; ') };
    }, { severity: 'high' });

    await t.check('web.api.no-ssrf-surface', 'The server makes no outbound requests to user-supplied URLs', () => {
      const hits = gitGrep('fetch\\(|http\\.request|https\\.request|axios|undici|got\\(', ['apps/api/src'], { extended: true });
      return { ok: hits.length === 0, evidence: hits.length ? hits.join('\n') : 'no HTTP client calls in apps/api/src (only SMTP via nodemailer to the configured host)' };
    }, { severity: 'medium' });

    await t.check('web.edge.headers', 'Production edge (deploy/Caddyfile) sets CSP without inline/eval scripts, framing protection, HSTS, nosniff', () => {
      const c = readFileSync(join(ROOT, 'deploy/Caddyfile'), 'utf8');
      const csp = /Content-Security-Policy "([^"]+)"/.exec(c)?.[1] ?? '';
      const script = /script-src ([^;]+)/.exec(csp)?.[1] ?? '';
      const ok =
        !!csp &&
        !/'unsafe-inline'|'unsafe-eval'|\*/.test(script) &&
        csp.includes("frame-ancestors 'none'") &&
        csp.includes("object-src 'none'") &&
        csp.includes("base-uri 'none'") &&
        /Strict-Transport-Security/.test(c) &&
        /X-Content-Type-Options "nosniff"/.test(c) &&
        /X-Frame-Options "DENY"/.test(c);
      return { ok, evidence: `CSP: ${csp}\n(style-src allows 'unsafe-inline' for React inline styles; scripts do not)` };
    }, { severity: 'medium' });

    // ------------------------------------------------------------------ build the web app against the disposable API
    const webOut = join(WORK, 'web-dist');
    const build = run('npx', ['vite', 'build', '--outDir', webOut, '--emptyOutDir'], { cwd: join(ROOT, 'apps/web'), env: { VITE_API_URL: api.base } });
    const built = build.status === 0 && existsSync(join(webOut, 'index.html'));
    if (!built) t.unverified('web.build', 'Web app production build', `vite build failed (exit ${build.status}): ${build.stderr.slice(-1500)}`);

    if (built) {
      await t.check('web.bundle.no-server-secrets', 'Public web assets contain no server-only configuration names or values and no source maps', () => {
        const files = walk(webOut);
        const text = files.filter((f) => /\.(js|html|css|json|txt)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
        const names = SERVER_ONLY.filter((n) => text.includes(n));
        const values: string[] = [];
        for (const envFile of ['.env', 'deploy/.env.production', 'tests/security/.work/stack.env']) {
          const p = join(ROOT, envFile);
          if (!existsSync(p)) continue;
          for (const line of readFileSync(p, 'utf8').split('\n')) {
            const m = /^([A-Z0-9_]+)=(.{12,})$/.exec(line.trim());
            if (m && !/URL|ORIGIN|PORT|LEVEL|ENV|DOMAIN|EMAIL|FROM|HOST/.test(m[1]!) && text.includes(m[2]!)) values.push(m[1]!);
          }
        }
        const maps = files.filter((f) => f.endsWith('.map'));
        const pem = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text);
        return { ok: !names.length && !values.length && !maps.length && !pem, evidence: `${files.length} files; server-only names: ${names.join(',') || 'none'}; secret values: ${values.join(',') || 'none'}; source maps: ${maps.length}; private keys: ${pem}` };
      }, { severity: 'high' });

      await t.check('web.bundle.no-third-party', 'The web app loads no third-party scripts, analytics, crash reporting or session replay', () => {
        const files = walk(webOut).filter((f) => /\.(js|html)$/.test(f));
        const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
        const found = TRACKERS.filter((d) => text.includes(d));
        const extScripts = [...readFileSync(join(webOut, 'index.html'), 'utf8').matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map((m) => m[1]);
        return { ok: !found.length && !extScripts.length, evidence: `tracker/telemetry hosts: ${found.join(', ') || 'none'}; external <script src>: ${extScripts.join(', ') || 'none'}` };
      }, { severity: 'medium' });
    }

    await t.check('web.no-secrets-in-urls', 'No credentials or tokens travel in URL query strings (API traffic so far; emailed links use #fragments)', () => {
      // Requests the harness deliberately sends with a token in the URL (to prove they are refused) are tagged x-pv-probe.
      const bad = traffic.filter((x) => /[?&](token|code|authKey|password|secret|key)=/i.test(x.url) && !x.requestHeaders['x-pv-probe']);
      return { ok: bad.length === 0, evidence: `${traffic.length} requests inspected; ${bad.length} with credential-like query parameters` };
    }, { severity: 'medium' });

    if (!built) return;
    // ------------------------------------------------------------------ stored/reflected XSS in a real browser
    log('creating items with script payloads and opening them in Chromium…');
    const xss = await newActor(env, 'web-xss');
    const client = await signIn(env, xss);
    const s = client.session;
    const p = PAYLOADS;
    const refused: string[] = [];
    const trySave = async (label: string, payload: unknown) => {
      try {
        await s.saveItem(payload as never);
      } catch (e) {
        refused.push(`${label}: ${e instanceof Error ? e.message.replace(/\s+/g, ' ').slice(0, 120) : e}`);
      }
    };
    await trySave('login (javascript: URL)', newItem('login', { title: p[0]!, notes: p.join('\n'), tags: [p[1]!.slice(0, 40)], folder: p[2]!.slice(0, 60), fields: { username: p[1]!, password: 'pw', urls: [{ url: p[3]!, match: 'host' }] } } as never));
    await trySave('login', newItem('login', { title: p[0]!, notes: p.join('\n'), tags: [p[1]!.slice(0, 40)], folder: p[2]!.slice(0, 60), fields: { username: p[1]!, password: 'pw', urls: [{ url: 'https://example.com/<script>', match: 'host' }] } } as never));
    await trySave('secure note', newItem('secure_note', { title: p[2]!, fields: { content: p.join('\n\n') } } as never));
    let traversalRefused = '';
    try {
      await s.saveItem(newItem('env_file', { title: 'traversal', fields: { filename: '../../.ssh/authorized_keys', content: 'A=1\n', variableNotes: {} } } as never));
    } catch (e) {
      traversalRefused = e instanceof Error ? e.message.replace(/\s+/g, ' ').slice(0, 160) : String(e);
    }
    await t.check('web.env-filename.validation', 'Env-file names with path separators are refused by item validation', () => ({ ok: !!traversalRefused, evidence: traversalRefused ? `refused: ${traversalRefused}` : 'ACCEPTED ../../.ssh/authorized_keys' }), { severity: 'medium' });
    await trySave('env file', newItem('env_file', { title: p[4]!.slice(0, 120), fields: { filename: `${p[0]!.replace(/[\\/]/g, '').slice(0, 40)}.env`, content: `HTML=${p[0]}\nSCRIPT="${p[2]!.replace(/"/g, '\\"')}"\nURL=${p[3]}\n`, variableNotes: { HTML: p[1]! } } } as never));
    await trySave('api credential', newItem('api_credential', { title: p[5]!, fields: { service: p[6]!.slice(0, 100), kind: 'token', token: 't', endpoint: p[3] } } as never));
    await s.syncNow();

    const preview: ChildProcess = spawn('npx', ['vite', 'preview', '--outDir', webOut, '--host', '127.0.0.1', '--port', '4317', '--strictPort'], { cwd: join(ROOT, 'apps/web'), stdio: 'ignore' });
    try {
      for (let i = 0; i < 60; i++) {
        try {
          if ((await fetch('http://127.0.0.1:4317/')).ok) break;
        } catch {
          /* starting */
        }
        await sleep(250);
      }
      await t.check('web.xss.stored', 'Script payloads in titles, notes, tags, folders, usernames, URLs, env files and API credentials never execute', async () => {
        const browser = await chromium.launch();
        const page = await browser.newPage();
        const dialogs: string[] = [];
        page.on('dialog', (d) => {
          dialogs.push(d.message());
          void d.dismiss();
        });
        try {
          await page.goto('http://127.0.0.1:4317/');
          await page.getByLabel('Email', { exact: true }).fill(xss.email);
          await page.getByLabel('Master password', { exact: true }).fill(xss.password);
          await page.getByRole('button', { name: 'Sign in', exact: true }).click();
          await page.getByLabel('Authentication code', { exact: true }).fill(await freshTotp(xss.totpSecret));
          await page.getByRole('button', { name: 'Verify', exact: true }).click();
          await page.getByRole('complementary', { name: 'Main navigation' }).waitFor({ timeout: 20_000 });
              await page.getByRole('complementary', { name: 'Main navigation' }).getByRole('button', { name: /^All items/ }).click();
              await page.getByRole('listbox', { name: 'Items' }).getByRole('option').first().waitFor({ timeout: 20_000 });
          let opened = 0;
          const options = page.getByRole('listbox', { name: 'Items' }).getByRole('option');
          const n = await options.count();
          for (let i = 0; i < n; i++) {
            await options.nth(i).click();
            await sleep(500);
            // reveal hidden values where possible, so masked fields render too
            for (const b of await page.getByRole('button', { name: /Reveal|Show/ }).all()) await b.click().catch(() => undefined);
            await sleep(300);
            opened++;
          }
          const search = page.getByRole('searchbox').or(page.getByPlaceholder(/Search/)).first();
          await search.fill(PAYLOADS[0]!).catch(() => undefined);
          await sleep(500);
          await page.goto(`http://127.0.0.1:4317/#${encodeURIComponent(PAYLOADS[0]!)}`);
          await page.goto(`http://127.0.0.1:4317/?q=${encodeURIComponent(PAYLOADS[1]!)}&next=javascript:alert(1)`);
          await sleep(1000);
          const flag = await page.evaluate(`window.${XSS_FLAG} ?? null`);
          const jsLinks = await page.evaluate(`document.querySelectorAll('a[href^="javascript:" i]').length`);
          return { ok: !flag && !dialogs.length && jsLinks === 0 && opened >= 3, evidence: `${opened} items opened (values revealed); execution flag=${flag}; dialogs=${dialogs.length}; javascript: links rendered=${jsLinks}; refused by client validation: ${refused.join(' | ') || 'none'}` };
        } finally {
          await browser.close();
        }
      }, { severity: 'critical' });
    } finally {
      preview.kill();
    }
  },
};

export default suite;
