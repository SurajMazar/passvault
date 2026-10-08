import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { pvCaptureCredentials, pvFillCredentials } from '../../../../apps/browser-extension/src/inject/page-functions';
import { ROOT, WORK } from '../lib/paths';
import type { Suite } from '../lib/suite';
import { run } from '../lib/util';
import { vitestCheck } from '../lib/vitest';

const EXT = join(ROOT, 'apps/browser-extension');

function page(body: string) {
  return `<!doctype html><meta charset="utf-8"><title>t</title><body>${body}</body>`;
}
const LOGIN = `<form><input id="u" name="email" type="email" autocomplete="username"><input id="p" type="password" autocomplete="current-password"><button>Sign in</button></form>`;

const suite: Suite = {
  id: 'extension',
  title: 'Manifest V3 browser extension',
  needsApi: false,
  async run(ctx) {
    const { t } = ctx;
    await vitestCheck(t, 'ext.unit-tests', 'Extension unit tests: sender/message validation, origin matching incl. lookalikes, fill/capture, lock/resume, logs, manifest, save prompt, servers', 'apps/browser-extension', { severity: 'critical' });

    // ------------------------------------------------------------------ production build + manifest
    const out = join(WORK, 'ext-prod');
    const b = run('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], { cwd: EXT, env: { VITE_API_URL: 'https://vault.example.com', VITE_WEB_URL: 'https://vault.example.com' } });
    if (b.status !== 0 || !existsSync(join(out, 'manifest.json'))) {
      t.unverified('ext.manifest', 'Production manifest', `build failed: ${b.stderr.slice(-1500)}`);
    } else {
      await t.check('ext.manifest', 'Production manifest: MV3, minimal permissions, one host, optional all-sites only, no web-accessible resources or external messaging', () => {
        const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
        const perms = [...m.permissions].sort().join(',');
        const ok =
          m.manifest_version === 3 &&
          perms === 'activeTab,alarms,clipboardWrite,offscreen,scripting,storage' &&
          JSON.stringify(m.host_permissions) === JSON.stringify(['https://vault.example.com/*']) &&
          JSON.stringify(m.optional_host_permissions) === JSON.stringify(['https://*/*', 'http://*/*']) &&
          !m.content_scripts &&
          !m.web_accessible_resources &&
          !m.externally_connectable &&
          !perms.includes('nativeMessaging') &&
          m.content_security_policy?.extension_pages === "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";
        return { ok, evidence: `permissions ${perms}; hosts ${JSON.stringify(m.host_permissions)}; optional ${JSON.stringify(m.optional_host_permissions)}; content_scripts ${!!m.content_scripts}; web_accessible_resources ${!!m.web_accessible_resources}; externally_connectable ${!!m.externally_connectable}; CSP ${m.content_security_policy?.extension_pages}` };
      }, { severity: 'high' });

      await t.check('ext.no-remote-code', 'The packaged extension loads no remote code and contains no source maps', () => {
        const files = readdirSync(out, { recursive: true }) as string[];
        const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, f), 'utf8')).join('\n');
        const remoteImports = [...js.matchAll(/import\s*\(\s*["'](https?:[^"']+)/g)].map((x) => x[1]);
        const scriptTags = files.filter((f) => f.endsWith('.html')).flatMap((f) => [...readFileSync(join(out, f), 'utf8').matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map((x) => x[1]));
        const maps = files.filter((f) => f.endsWith('.map'));
        return { ok: !remoteImports.length && !scriptTags.length && !maps.length, evidence: `remote dynamic imports: ${remoteImports.length}; remote <script>: ${scriptTags.length}; source maps: ${maps.length}` };
      }, { severity: 'high' });
    }

    // ------------------------------------------------------------------ the real fill/capture functions in a real browser engine
    const browser = await chromium.launch();
    try {
      const ctxB = await browser.newContext();
      const pages: Record<string, string> = {
        'https://bank.example.test/login': page(LOGIN),
        'https://bank.example.test.evil.test/login': page(LOGIN),
        'https://bank.example.test/honeypot': page(
          `<form><input id="decoy" name="username" style="opacity:0"><input id="u" name="email" type="email"><input id="hp" type="password" style="display:none"><input id="off" type="password" style="position:absolute;left:-9999px"><input id="p" type="password"></form>`,
        ),
        'https://bank.example.test/hidden-only': page(`<form><input id="u"><input id="p" type="password" style="display:none"></form>`),
        'https://bank.example.test/iframe': page(`<p>outer</p><iframe id="f" src="https://idp.other.test/frame" width="400" height="200"></iframe>`),
        'https://idp.other.test/frame': page(LOGIN),
        'https://bank.example.test/signup': page(`<form><input id="u" autocomplete="username"><input id="new" type="password" autocomplete="new-password"><input id="cur" type="password" autocomplete="current-password"></form>`),
      };
      await ctxB.route('https://**/*', (route) => {
        const html = pages[route.request().url()];
        return html ? route.fulfill({ contentType: 'text/html', body: html }) : route.fulfill({ status: 404, body: '' });
      });
      // tsx compiles named arrow functions with a __name helper; provide it in pages so the source runs as-is.
      await ctxB.addInitScript('window.__name = (f) => f;');
      const fillSrc = pvFillCredentials.toString();
      const capSrc = pvCaptureCredentials.toString();
      const open = async (url: string): Promise<Page> => {
        const p = await ctxB.newPage();
        await p.goto(url);
        return p;
      };
      const fill = (p: Page, origin: string) => p.evaluate(`(${fillSrc})(${JSON.stringify(origin)}, "ann@example.com", "S3cret-fill-value")`) as Promise<{ code: string; filledUsername: boolean }>;
      const val = (p: Page, id: string) => p.evaluate(`document.getElementById(${JSON.stringify(id)}).value`) as Promise<string>;

      await t.check('ext.fill.correct-origin', 'Fill on the verified origin sets exactly the visible username and password', async () => {
        const p = await open('https://bank.example.test/login');
        const r = await fill(p, 'https://bank.example.test');
        return { ok: r.code === 'filled' && (await val(p, 'u')) === 'ann@example.com' && (await val(p, 'p')) === 'S3cret-fill-value', evidence: JSON.stringify(r) };
      }, { severity: 'high' });

      await t.check('ext.fill.lookalike-origin', 'A lookalike host (bank.example.test.evil.test) gets nothing even if asked to fill for the real origin', async () => {
        const p = await open('https://bank.example.test.evil.test/login');
        const r = await fill(p, 'https://bank.example.test');
        return { ok: r.code === 'origin_mismatch' && (await val(p, 'p')) === '' && (await val(p, 'u')) === '', evidence: JSON.stringify(r) };
      }, { severity: 'critical' });

      await t.check('ext.fill.honeypots', 'Hidden, transparent and off-screen fields are never filled', async () => {
        const p = await open('https://bank.example.test/honeypot');
        const r = await fill(p, 'https://bank.example.test');
        const v = { decoy: await val(p, 'decoy'), hp: await val(p, 'hp'), off: await val(p, 'off'), u: await val(p, 'u'), p: await val(p, 'p') };
        return { ok: r.code === 'filled' && !v.decoy && !v.hp && !v.off && v.u === 'ann@example.com' && v.p === 'S3cret-fill-value', evidence: `${JSON.stringify(r)} values: decoy="${v.decoy}", display:none="${v.hp}", off-screen="${v.off}", username filled=${!!v.u}, password filled=${!!v.p}` };
      }, { severity: 'high' });

      await t.check('ext.fill.hidden-only', 'A page with only a hidden password field gets nothing', async () => {
        const p = await open('https://bank.example.test/hidden-only');
        const r = await fill(p, 'https://bank.example.test');
        return { ok: r.code === 'no_password_field' && (await val(p, 'p')) === '' && (await val(p, 'u')) === '', evidence: JSON.stringify(r) };
      }, { severity: 'high' });

      await t.check('ext.fill.cross-origin-iframe', 'Credentials never reach a cross-origin iframe; the function refuses to run inside frames', async () => {
        const p = await open('https://bank.example.test/iframe');
        const r = await fill(p, 'https://bank.example.test');
        const frame = p.frames().find((f) => f.url().startsWith('https://idp.other.test'))!;
        await frame.waitForLoadState();
        const inFrame = (await frame.evaluate(`(${fillSrc})("https://idp.other.test", "x", "y")`)) as { code: string };
        const frameVal = (await frame.evaluate(`document.getElementById('p').value`)) as string;
        return { ok: r.code === 'no_password_field' && inFrame.code === 'not_top_frame' && frameVal === '', evidence: `top page → ${r.code}; executed inside the iframe → ${inFrame.code}; iframe password value empty: ${frameVal === ''}` };
      }, { severity: 'critical' });

      await t.check('ext.fill.signup-form', 'On sign-up/change forms the current-password field is chosen, never the new-password field', async () => {
        const p = await open('https://bank.example.test/signup');
        const r = await fill(p, 'https://bank.example.test');
        return { ok: r.code === 'filled' && (await val(p, 'cur')) === 'S3cret-fill-value' && (await val(p, 'new')) === '', evidence: JSON.stringify(r) };
      }, { severity: 'medium' });

      await t.check('ext.capture.top-frame-only', 'Capture reads only the top document and refuses inside frames', async () => {
        const p = await open('https://bank.example.test/iframe');
        const frame = p.frames().find((f) => f.url().startsWith('https://idp.other.test'))!;
        await frame.evaluate(`document.getElementById('p').value = 'typed-in-frame'`);
        const top = (await p.evaluate(`(${capSrc})()`)) as { password: string; foundPasswordField: boolean };
        const inFrame = (await frame.evaluate(`(${capSrc})()`)) as { code: string };
        return { ok: !top.foundPasswordField && top.password === '' && inFrame.code === 'not_top_frame', evidence: `top capture found password: ${top.foundPasswordField}; in-frame capture → ${inFrame.code}` };
      }, { severity: 'high' });
    } finally {
      await browser.close();
    }

    // ------------------------------------------------------------------ real extension loaded in Chromium
    const local = join(WORK, 'ext-local');
    const lb = run('npx', ['vite', 'build', '--mode', 'e2e', '--outDir', local, '--emptyOutDir'], { cwd: EXT });
    if (lb.status !== 0) {
      t.unverified('ext.page-isolation', 'Web pages cannot talk to the extension', `local build failed: ${lb.stderr.slice(-800)}`);
    } else {
      await t.check('ext.page-isolation', 'A web page cannot message the extension, and no content script runs before the user opts in', async () => {
        const profile = mkdtempSync(join(tmpdir(), 'pv-ext-sec-'));
        const c = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${local}`, `--load-extension=${local}`] });
        try {
          const sw = c.serviceWorkers()[0] ?? (await c.waitForEvent('serviceworker'));
          await c.route('https://shop.example.test/**', (r) => r.fulfill({ contentType: 'text/html', body: page(LOGIN) }));
          const p = await c.newPage();
          await p.goto('https://shop.example.test/');
          const extId = new URL(sw.url()).host;
          const fromPage = await p.evaluate(`(() => { try { if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.sendMessage) return 'no chrome.runtime on the page'; chrome.runtime.sendMessage(${JSON.stringify(extId)}, { type: 'state.get' }, () => {}); return 'sendMessage callable: ' + (chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no error'); } catch (e) { return 'threw: ' + e.message; } })()`);
          const registered = (await sw.evaluate(`chrome.scripting.getRegisteredContentScripts()`)) as unknown[];
          const injected = await p.evaluate(`!!document.querySelector('passvault-save-prompt')`);
          return { ok: (String(fromPage).startsWith('no chrome.runtime') || String(fromPage).startsWith('threw')) && registered.length === 0 && !injected, evidence: `page → ${fromPage}; registered content scripts: ${registered.length}; prompt element present: ${injected}` };
        } finally {
          await c.close();
          rmSync(profile, { recursive: true, force: true });
        }
      }, { severity: 'critical' });
    }

    t.notApplicable('ext.native-messaging', 'Native messaging accepts only approved extensions and paired clients', 'not implemented: the manifest has no nativeMessaging permission (checked by ext.manifest); desktop pairing is deferred (docs/EXTENSION.md)');

    // ------------------------------------------------------------------ trusted-input browser checks (tests/e2e-video)
    const saveBuild = run('pnpm', ['--filter', '@passvault/browser-extension', 'build'], {});
    const sp = saveBuild.status === 0 ? run('pnpm', ['--filter', '@passvault/e2e-video', 'check:save-prompt'], {}) : saveBuild;
    await t.check('ext.save-prompt.trusted-input', 'Save prompt with trusted input in Chromium: saves the login (and an optional note) for the real page origin', () => ({
      ok: sp.status === 0 && /✓ trusted submit/.test(sp.stdout) && /✓ trusted typing/.test(sp.stdout),
      evidence: (sp.stdout + sp.stderr).split('\n').filter((l) => /✓|✗|Error/.test(l)).join('\n') || `exit ${sp.status}`,
    }), { severity: 'high' });

    const apiPort = ctx.env?.stack ? new URL(ctx.env.stack.apiUrl).port : null;
    if (apiPort !== '3000') {
      t.unverified('ext.server-switch.real-popup', 'Server switching in the real toolbar popup', `needs the stack on 127.0.0.1:3000 (the extension's built-in local server); this run's API is ${ctx.env?.stack?.apiUrl ?? 'not started'} — stop other stacks using port 3000 and re-run`);
    } else {
      const ss = run('pnpm', ['--filter', '@passvault/e2e-video', 'check:server-switch'], { env: { PV_EXT_DIR: local, MAILPIT_URL: ctx.env!.mailpit } });
      await t.check('ext.server-switch.real-popup', 'Server switching in the real toolbar popup: validation, Chrome host permission required, per-server isolation', () => ({
        ok: ss.status === 0 && /passed/.test(ss.stdout) && !/✗/.test(ss.stdout),
        evidence: (ss.stdout + ss.stderr).split('\n').filter((l) => /✓|✗|passed|Error/.test(l)).join('\n') || `exit ${ss.status}`,
      }), { severity: 'high' });
    }
  },
};

export default suite;
