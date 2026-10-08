import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROOT, WORK } from '../lib/paths';
import type { Suite } from '../lib/suite';
import { isMac } from '../lib/suite';
import { gitGrep, run, sleep } from '../lib/util';
import { vitestCheck } from '../lib/vitest';

const DESKTOP = join(ROOT, 'apps/desktop');
/** Native APIs the UI genuinely needs. Everything else must stay off the allowlist. */
const NEEDED = new Set([
  'app.exit',
  // used by the helper extension (not the UI) to deliver responses/events: docs/DESKTOP_HELPER.md
  'app.broadcast',
  'window.show',
  'window.focus',
  'window.unminimize',
  'window.setMainMenu',
  'os.showOpenDialog',
  'os.showSaveDialog',
  'os.setTray',
  'extensions.dispatch',
  'extensions.getStats',
  'storage.getData',
  'storage.setData',
  'storage.removeData',
  // lists key names only: forgetting a saved server removes its prefs and cache (Settings → Server connection)
  'storage.getKeys',
  'clipboard.readText',
  'clipboard.writeText',
]);
/** Never acceptable for a webview that renders vault data. */
const DANGEROUS = /^(os\.(execCommand|spawnProcess|open|getEnv|getEnvs)|filesystem\.|app\.(readProcessInput|writeProcessOutput)|debug\.|computer\.|window\.(setSize|move)|extensions\.(broadcast))/;

const suite: Suite = {
  id: 'desktop',
  title: 'Neutralinojs desktop app: permissions, webview isolation, IPC exposure',
  needsApi: false,
  async run({ t }) {
    await vitestCheck(t, 'desktop.unit-tests', 'Desktop app unit tests: server isolation, CSP builder, links, clipboard, terminal controller, lock handling, IPC client', 'apps/desktop', { severity: 'high' });

    const cfg = JSON.parse(readFileSync(join(DESKTOP, 'neutralino.config.json'), 'utf8'));
    await t.check('desktop.config.production', 'Production Neutralino config: one-time token, no exported auth info, no inspector, local document root, helper as the only extension', () => {
      const ok =
        cfg.tokenSecurity === 'one-time' &&
        cfg.exportAuthInfo === false &&
        cfg.modes?.window?.enableInspector === false &&
        cfg.defaultMode === 'window' &&
        cfg.url === '/' &&
        cfg.documentRoot === '/resources/app/' &&
        cfg.extensions.length === 1 &&
        cfg.extensions[0].id === 'io.passvault.helper' &&
        !cfg.globalVariables;
      return { ok, evidence: `tokenSecurity=${cfg.tokenSecurity}, exportAuthInfo=${cfg.exportAuthInfo}, inspector=${cfg.modes?.window?.enableInspector}, mode=${cfg.defaultMode}, url=${cfg.url}, extensions=${cfg.extensions.map((e: { id: string }) => e.id).join(',')}, globalVariables=${!!cfg.globalVariables}` };
    }, { severity: 'high' });

    await t.check('desktop.config.native-allowlist', 'Native API allowlist is minimal: no shell-backed os.open, no process/filesystem/env access, nothing unused', () => {
      const list: string[] = cfg.nativeAllowList;
      const dangerous = list.filter((a) => DANGEROUS.test(a));
      const unused = list.filter((a) => !NEEDED.has(a));
      return { ok: dangerous.length === 0 && unused.length === 0, evidence: `allowlist (${list.length}): ${list.join(', ')}\ndangerous: ${dangerous.join(', ') || 'none'}; not needed by the UI: ${unused.join(', ') || 'none'}` };
    }, { severity: 'high', finding: 'PV-SEC-002' });

    await t.check('desktop.no-direct-native-exec', 'UI code never calls shell-backed or process APIs directly', () => {
      const hits = gitGrep('(nl|Neutralino)\\.os\\.(open|execCommand|spawnProcess)|filesystem\\.', ['apps/desktop/src'], { extended: true }).filter((l) => !/\.test\.tsx?:/.test(l));
      return { ok: hits.length === 0, evidence: hits.length ? hits.join('\n') : 'none' };
    }, { severity: 'high', finding: 'PV-SEC-002' });

    // ------------------------------------------------------------------ webview CSP of a production build
    const ui = join(WORK, 'desktop-ui');
    const b = run('npx', ['vite', 'build', '--outDir', ui, '--emptyOutDir'], { cwd: DESKTOP, env: { VITE_PRODUCTION_URL: 'https://vault.example.com', VITE_API_URL: 'https://vault.example.com' } });
    if (b.status !== 0 || !existsSync(join(ui, 'index.html'))) {
      t.unverified('desktop.csp', 'Desktop webview CSP', `build failed: ${b.stderr.slice(-1200)}`);
    } else {
      await t.check('desktop.csp', 'Desktop webview CSP: scripts only from the app; connections only to the helper, https:// servers the user chooses, and http only on this computer', () => {
        const html = readFileSync(join(ui, 'index.html'), 'utf8');
        const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
        const dir = (n: string) => new RegExp(`${n} ([^;]+)`).exec(csp)?.[1]?.trim() ?? '';
        const script = dir('script-src');
        const connect = dir('connect-src').split(/\s+/);
        // Users connect to their own servers (any https://); plain http is limited to loopback.
        const allowedConnect = (s: string) => s === "'self'" || /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(s) || s === 'https:' || /^http:\/\/(localhost|127\.0\.0\.1)(:(\d+|\*))?$/.test(s);
        const ok = !!csp && !/'unsafe-inline'|'unsafe-eval'|\*|https?:|data:/.test(script) && connect.every(allowedConnect) && /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp);
        return { ok, evidence: `CSP: ${csp}` };
      }, { severity: 'high' });
    }

    // ------------------------------------------------------------------ the real app (verification harness, cloud mode)
    const app = join(DESKTOP, 'dist/PassVault.app');
    if (!isMac) {
      t.unverified('desktop.runtime', 'Runtime checks of the packaged app', 'not macOS (run on a macOS runner: see docs/security/RUNBOOK.md)');
      return;
    }
    if (!existsSync(app)) {
      t.unverified('desktop.runtime', 'Runtime checks of the packaged app', 'apps/desktop/dist/PassVault.app not built (bash apps/desktop/scripts/build.sh)');
      return;
    }
    const port = cfg.port as number;
    const busy = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim();
    if (busy) {
      t.unverified('desktop.runtime', 'Runtime checks of the packaged app', `port ${port} is in use (another PassVault/harness instance)`);
      return;
    }
    const proc = spawn('bash', [join(DESKTOP, 'scripts/verify-harness.sh'), 'cloud'], { cwd: DESKTOP, stdio: 'ignore', detached: true });
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        try {
          up = (await fetch(`http://127.0.0.1:${port}/`)).ok;
        } catch {
          await sleep(250);
        }
      }
      if (!up) {
        t.unverified('desktop.runtime', 'Runtime checks of the packaged app', 'the verification harness did not start');
        return;
      }
      await sleep(1500);
      // Load the real UI first (it takes the one-time token, like the webview does in window mode).
      const { chromium } = await import('playwright');
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
        await t.check('desktop.runtime.helper-roundtrip', 'The packaged app works end to end: the UI loads and the native helper answers it (allowlist not over-restricted)', async () => {
          await page.goto(`http://127.0.0.1:${port}/`);
          // Reaching sign-in (or the lock screen) requires keychain.get answered by the helper.
          const ready = await page
            .getByRole('heading', { name: /Sign in|Welcome|Vault locked|Choose a server/ })
            .first()
            .waitFor({ timeout: 25_000 })
            .then(() => true, () => false);
          const helperErr = errors.filter((e) => /helper|not permitted|NE_RT_NATPRME|NE_EX/i.test(e));
          return { ok: ready && helperErr.length === 0, evidence: `UI reached its first screen: ${ready}; helper/permission errors in console: ${helperErr.join(' | ') || 'none'}` };
        }, { severity: 'high' });

        // Same page (the one-time token is spent): Settings-equivalent panel from the sign-in screen.
        await t.check('desktop.runtime.server-connection', 'Server URL is editable in the packaged app: prefilled, invalid and unreachable addresses refused with a reason (helper TLS probe), current server kept', async () => {
          const steps: string[] = [];
          await page.getByRole('button', { name: 'Change' }).first().click({ timeout: 10_000 });
          const field = page.getByLabel('Server URL');
          const before = await field.inputValue();
          steps.push(`prefilled: ${before}`);
          await field.fill('http://vault.example.com');
          await page.getByRole('button', { name: 'Save changes' }).click();
          const httpRefused = await page.getByText(/plain http:\/\/ is only allowed/).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
          steps.push(`plain http refused: ${httpRefused}`);
          // Nothing listens on port 1: the webview fetch fails, then the helper's TLS probe (net.inspectTls) reports it unreachable.
          await field.fill('https://127.0.0.1:1');
          await page.getByRole('button', { name: 'Test connection' }).click();
          const unreachable = await page.getByText('Can’t reach the server').first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
          steps.push(`unreachable explained: ${unreachable}`);
          await page.getByRole('button', { name: 'Cancel' }).first().click();
          const after = await field.inputValue().catch(() => '');
          const kept = after === before && (await page.getByText(before).first().isVisible().catch(() => false));
          steps.push(`current server kept: ${kept}`);
          const helperErr = errors.filter((e) => /not permitted|NE_RT_NATPRME|unknown op|net\.inspectTls/i.test(e));
          steps.push(`helper/permission errors: ${helperErr.join(' | ') || 'none'}`);
          return { ok: !!before && httpRefused && unreachable && kept && helperErr.length === 0, evidence: steps.join('\n') };
        }, { severity: 'medium' });
      } finally {
        await browser.close();
      }

      await t.check('desktop.runtime.process-args', 'No secrets in the command lines of the app and helper processes', () => {
        const ps = spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /neutralino-mac|pv-helper/.test(l));
        const suspicious = ps.filter((l) => /token|secret|password|key=|NL_TOKEN/i.test(l));
        return { ok: ps.length >= 2 && suspicious.length === 0, evidence: `${ps.length} processes:\n${ps.map((l) => l.trim().replace(homedir(), '~')).join('\n')}\nsuspicious arguments: ${suspicious.length}` };
      }, { severity: 'high' });

      await t.check('desktop.runtime.one-time-token', 'After the UI has loaded, other local clients requesting the globals get no access token', async () => {
        const g1 = await (await fetch(`http://127.0.0.1:${port}/__neutralino_globals.js`)).text();
        const g2 = await (await fetch(`http://127.0.0.1:${port}/__neutralino_globals.js`)).text();
        const tok = (s: string) => /NL_TOKEN\s*=\s*['"]([^'"]*)['"]/.exec(s)?.[1] ?? '';
        return {
          ok: g1.includes('NL_TOKEN') && tok(g1) === '' && tok(g2) === '',
          evidence: `requests after the UI took the token: ${tok(g1) || tok(g2) ? 'TOKEN RETURNED' : 'no token'}. Residual: a local process that requests the globals before the webview does would win the token — in window mode the webview loads immediately at start (documented).`,
        };
      }, { severity: 'medium' });

      await t.check('desktop.runtime.ws-without-token', 'Native API websocket refuses clients without the token, and extension connections need the connect token', async () => {
        const attempt = (url: string) =>
          new Promise<string>((res) => {
            const ws = new WebSocket(url);
            const timer = setTimeout(() => {
              ws.close();
              res('no response (timeout)');
            }, 4000);
            ws.onopen = () => {
              ws.send(JSON.stringify({ id: '1', method: 'os.execCommand', accessToken: 'bogus', data: { command: 'touch /tmp/pv-ws-pwned' } }));
              ws.onmessage = (m) => {
                clearTimeout(timer);
                ws.close();
                res(`opened; reply ${String(m.data).slice(0, 160)}`);
              };
            };
            ws.onerror = () => {
              clearTimeout(timer);
              res('refused');
            };
            ws.onclose = (e) => {
              clearTimeout(timer);
              res(`closed (${e.code})`);
            };
          });
        const a = await attempt(`ws://127.0.0.1:${port}`);
        const b2 = await attempt(`ws://127.0.0.1:${port}?extensionId=io.passvault.helper&connectToken=bogus`);
        const pwned = existsSync('/tmp/pv-ws-pwned');
        return { ok: !pwned && !/"success"\s*:\s*true|stdOut/.test(a + b2), evidence: `no token → ${a}; fake extension connect token → ${b2}; command executed: ${pwned}` };
      }, { severity: 'critical' });

      const info = join(homedir(), 'Library/Application Support/io.passvault.desktop.verify/.tmp/auth_info.json');
      t.notApplicable('desktop.runtime.auth-info-file', 'Exported auth-info file', `exportAuthInfo is false in the production config; the verification harness enables it on purpose (${existsSync(info) ? 'present for the harness' : 'absent'}) and scripts/build.sh refuses to package with it`);
    } finally {
      try {
        process.kill(-proc.pid!, 'SIGTERM');
      } catch {
        /* already gone */
      }
      spawnSync('pkill', ['-f', 'neutralino-mac_arm64.*io.passvault.desktop.verify|\\.build/verify']);
      await sleep(500);
    }
  },
};

export default suite;
