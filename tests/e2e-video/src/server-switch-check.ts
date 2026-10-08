/**
 * Real-browser check of the extension's server connection (editable at any time).
 *
 * Loads the unpacked extension in Chromium, opens the REAL toolbar popup
 * (chrome.action.openPopup) and drives it over the DevTools protocol:
 * Input.dispatch* events are trusted user input, so the popup's
 * chrome.permissions.request runs exactly as for a person clicking.
 * (Playwright does not expose action popups as pages.)
 *
 * Checks:
 *   1. the popup shows the current server (local development by default);
 *   2. plain http to a public host is refused;
 *   3. a server Chrome has not granted host access to is not used while
 *      Chrome's permission prompt is unanswered (headless Chrome cannot
 *      answer it; the "denied" message path is covered by unit tests only);
 *   4. an address that fails the compatibility check is not applied: the
 *      current connection is kept and the error is shown;
 *   5. sign-in on server A, change the address to server B → B starts signed
 *      out in its own storage namespace; switch back from the saved servers →
 *      A's locked account is back and unlocks with its master password;
 *   6. Settings → Server connection while unlocked: the URL is prefilled,
 *      Save changes asks to lock, and the vault is locked after switching;
 *   7. the master password never lands in chrome.storage.local.
 *
 * Needs the local stack (podman compose up -d: API :3000, Mailpit :8025) and
 * an extension build WITHOUT a production URL; the script adds
 * 127.0.0.1:3000 as a second granted host in that build's manifest
 * (test-only) so server B needs no prompt:
 *
 *   (cd apps/browser-extension && npx vite build --mode e2e --outDir /tmp/pv-ext-local)
 *   PV_EXT_DIR=/tmp/pv-ext-local pnpm --filter @passvault/e2e-video check:server-switch
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { TOTP } from 'otpauth';
import { headlessSession, mailCode, sleep } from './tour/lib';

const EXT = process.env.PV_EXT_DIR;
if (!EXT) throw new Error('Set PV_EXT_DIR to an extension build directory');
const manifestPath = join(EXT, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { host_permissions: string[] };
if (!manifest.host_permissions.includes('http://localhost:3000/*')) throw new Error('Expected a local-development build (host http://localhost:3000)');
if (!manifest.host_permissions.includes('http://127.0.0.1:3000/*')) {
  manifest.host_permissions.push('http://127.0.0.1:3000/*');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ------------------------------------------------------------ synthetic account (server A)
const API = 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const EMAIL = `switch.${Date.now().toString(36)}@example.com`;
const PASSWORD = 'quartz-meadow-signal-harbor-71';
const setup = headlessSession(API, 'http://localhost:5173');
await setup.init();
const t0 = Date.now();
await setup.startRegistration(EMAIL);
await setup.register(await setup.verifyRegistration(EMAIL, await mailCode(MAILPIT, EMAIL, t0)), EMAIL, 'Switch Tester', PASSWORD);
await setup.login(EMAIL, PASSWORD);
const { secret } = await setup.startMfaEnrollment();
const totp = new TOTP({ secret });
await setup.confirmMfaEnrollment(totp.generate());
setup.acknowledgeRecoveryCodes();
await setup.logout();

// ------------------------------------------------------------ minimal CDP client
class Target {
  private id = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const w = m.id !== undefined ? this.waiting.get(m.id) : undefined;
      if (!w) return;
      this.waiting.delete(m.id!);
      if (m.error) w.reject(new Error(m.error.message));
      else w.resolve(m.result);
    });
  }
  static async open(url: string) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Target(ws);
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text} in: ${expression.slice(0, 120)}`);
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

const PORT = 9300 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'pv-ext-profile-'));
const proc = spawn(
  chromium.executablePath(),
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, 'about:blank'],
  { stdio: 'ignore' },
);

type TargetInfo = { type: string; url: string; webSocketDebuggerUrl: string };
async function targets(): Promise<TargetInfo[]> {
  for (let i = 0; i < 50; i++) {
    try {
      return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as TargetInfo[];
    } catch {
      await sleep(200);
    }
  }
  throw new Error('Chromium did not start');
}
async function waitTarget(pred: (t: TargetInfo) => boolean, ms = 10_000): Promise<TargetInfo> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = (await targets()).find(pred);
    if (t) return t;
    await sleep(200);
  }
  throw new Error('target not found');
}

// Popup DOM helpers: reads via Runtime.evaluate, all input via trusted Input events.
const q = (s: string) => JSON.stringify(s);
async function waitFor(t: Target, expr: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await t.eval<boolean>(`!!(${expr})`).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}
const hasText = (s: string) => `(document.body && document.body.innerText.includes(${q(s)}))`;
const byLabel = (label: string) => `(() => { const l = [...document.querySelectorAll('label')].find((x) => x.textContent.trim() === ${q(label)}); return l && document.getElementById(l.htmlFor); })()`;
const byButton = (name: string) => `[...document.querySelectorAll('button')].find((b) => (b.textContent.trim() === ${q(name)} || b.getAttribute('aria-label') === ${q(name)}) && !b.disabled)`;
async function click(t: Target, elExpr: string) {
  if (!(await waitFor(t, elExpr))) throw new Error(`element not found: ${elExpr.slice(0, 100)}`);
  const box = await t.eval<{ x: number; y: number }>(`(() => { const e = ${elExpr}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await t.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(150);
}
async function fill(t: Target, elExpr: string, text: string) {
  await click(t, elExpr);
  await t.eval(`(() => { const e = ${elExpr}; e.select && e.select(); })()`);
  await t.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await t.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await t.send('Input.insertText', { text });
  await sleep(100);
}

/** PV_SHOTS=<dir>: save popup screenshots for review. */
async function shot(t: Target, name: string) {
  const dir = process.env.PV_SHOTS;
  if (!dir) return;
  const r = await t.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(r.data, 'base64'));
}

try {
  // Chromium's own component extensions also run service workers; pick ours by its manifest.
  let sw: Target | null = null;
  for (let i = 0; i < 50 && !sw; i++) {
    for (const t of (await targets()).filter((x) => x.type === 'service_worker')) {
      const cand = await Target.open(t.webSocketDebuggerUrl);
      if ((await cand.eval<string>(`chrome.runtime.getManifest().name`).catch(() => '')) === 'PassVault') sw = cand;
      else cand.close();
      if (sw) break;
    }
    if (!sw) await sleep(200);
  }
  if (!sw) throw new Error('PassVault service worker not found');
  // URL of the active saved server (pv.servers).
  const storedServer = () => sw!.eval<string>(`chrome.storage.local.get('pv.servers').then((r) => { const s = r['pv.servers']; return s.profiles.find((p) => p.id === s.activeId).url; })`);
  async function closePopup(p: Target) {
    await p.eval(`window.close()`).catch(() => undefined);
    p.close();
    for (let i = 0; i < 50 && (await targets()).some((t) => t.url.endsWith('/popup.html')); i++) await sleep(100);
  }
  async function openPopup(): Promise<Target> {
    // openPopup needs a focused browser window; retry while Chromium finishes starting.
    for (let i = 0; ; i++) {
      try {
        await sw!.eval(`chrome.action.openPopup()`);
        break;
      } catch (e) {
        if (i >= 20) throw e;
        await sleep(300);
      }
    }
    const info = await waitTarget((t) => t.url.endsWith('/popup.html'));
    const p = await Target.open(info.webSocketDebuggerUrl);
    await waitFor(p, `document.readyState === 'complete'`);
    return p;
  }

  let popup = await openPopup();
  await waitFor(popup, hasText('Sign in to PassVault'));
  check('popup shows the current server', await popup.eval<boolean>(`${hasText('Server · Local development')} && ${hasText('http://localhost:3000')}`));

  await click(popup, byButton('Change'));
  check('the address field is prefilled with the current URL', await popup.eval<boolean>(`${byLabel('Server URL')}.value === 'http://localhost:3000'`));
  await fill(popup, byLabel('Server URL'), 'http://vault.example.com');
  await click(popup, byButton('Save changes'));
  check('plain http to a public host is refused', await waitFor(popup, hasText('plain http:// is only allowed for local development'), 3000));

  // A server without host access: Chrome shows its permission prompt, which a headless browser
  // leaves unanswered. Nothing may switch while it is pending; closing the popup abandons it.
  await fill(popup, byLabel('Server URL'), 'https://vault.example.com');
  await click(popup, byButton('Save changes'));
  await sleep(2500);
  const stillLocal = await storedServer();
  const granted = await sw.eval<boolean>(`chrome.permissions.contains({ origins: ['https://vault.example.com/*'] })`);
  check('an ungranted server is not used while the permission prompt is unanswered', stillLocal === 'http://localhost:3000' && !granted, `selected=${stillLocal}, granted=${granted}`);
  await closePopup(popup);
  popup = await openPopup();
  await waitFor(popup, hasText('Sign in to PassVault'));

  // An address that is reachable but not a PassVault API (wrong path prefix): nothing changes.
  await click(popup, byButton('Change'));
  await fill(popup, byLabel('Server URL'), 'http://127.0.0.1:3000/not-passvault');
  await click(popup, byButton('Save changes'));
  const refused = await waitFor(popup, `${hasText('Not a PassVault server')} && ${hasText('still connected to localhost:3000')}`, 10_000);
  await shot(popup, '1-signin-check-failed');
  check('a failed compatibility check keeps the current connection', refused && (await storedServer()) === 'http://localhost:3000', `selected=${await storedServer()}`);
  await click(popup, byButton('Test connection'));
  await fill(popup, byLabel('Server URL'), 'http://127.0.0.1:3000');
  await click(popup, byButton('Test connection'));
  check('Test connection reports a compatible server without switching', (await waitFor(popup, hasText('Compatible PassVault server'), 10_000)) && (await storedServer()) === 'http://localhost:3000');
  await closePopup(popup);
  popup = await openPopup();
  await waitFor(popup, hasText('Sign in to PassVault'));

  // Server A: sign in (in a fresh TOTP window so the code is not a replay of enrollment), then lock.
  await sleep(30_000 - (Date.now() % 30_000) + 500);
  await fill(popup, byLabel('Email'), EMAIL);
  await fill(popup, byLabel('Master password'), PASSWORD);
  await click(popup, byButton('Sign in'));
  await fill(popup, byLabel('Authenticator code'), totp.generate());
  await click(popup, byButton('Verify'));
  check('signed in on server A', await waitFor(popup, byButton('Lock'), 20_000));
  await click(popup, byButton('Lock'));
  await waitFor(popup, hasText('PassVault is locked'));

  // Change the address to server B (vault already locked: no confirmation needed).
  await click(popup, byButton('Change'));
  await fill(popup, byLabel('Server URL'), 'http://127.0.0.1:3000');
  await click(popup, byButton('Save changes'));
  await waitFor(popup, `${hasText('127.0.0.1:3000')} && ${hasText('Sign in to PassVault')}`, 10_000);
  const sel = await storedServer();
  check('server B starts signed out in its own namespace', sel === 'http://127.0.0.1:3000' && (await popup.eval<boolean>(hasText('Sign in to PassVault'))), `selected=${sel}`);

  // Reopen the popup (fresh page) and switch back from the saved servers.
  await closePopup(popup);
  popup = await openPopup();
  await click(popup, byButton('Change'));
  check('the previous server is kept to switch back to', await waitFor(popup, `(document.querySelector('section[aria-label="Saved servers"]')?.textContent ?? '').includes('http://localhost:3000')`, 5000));
  await click(popup, byButton('Switch'));
  check('switching back restores server A’s locked account', await waitFor(popup, `${hasText('PassVault is locked')} && ${hasText(EMAIL)}`, 10_000));
  await fill(popup, byLabel('Master password'), PASSWORD);
  await click(popup, byButton('Unlock'));
  check('server A unlocks with its master password after switching back', await waitFor(popup, byButton('Lock'), 15_000));

  // Settings → Server connection while unlocked: changing the address asks to lock first.
  await click(popup, `[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === 'Settings')`);
  check('Settings shows the connected server', await waitFor(popup, `${hasText('Server connection')} && ${hasText('Connected to')} && ${byLabel('Server URL')}.value === 'http://localhost:3000' && ${hasText('Ready')}`, 5000));
  await fill(popup, byLabel('Server URL'), 'http://127.0.0.1:3000');
  await click(popup, byButton('Save changes'));
  check('changing the server while unlocked asks to lock', await waitFor(popup, hasText('Your vault will be locked'), 10_000));
  await shot(popup, '2-settings-confirm');
  await click(popup, byButton('Lock and switch'));
  check('after Lock and switch the new server starts signed out', await waitFor(popup, hasText('Sign in to PassVault'), 10_000) && (await storedServer()) === 'http://127.0.0.1:3000');
  await click(popup, byButton('Change'));
  await shot(popup, '3-saved-servers');
  await click(popup, byButton('Switch'));
  check('server A was locked by the switch', await waitFor(popup, `${hasText('PassVault is locked')} && ${hasText(EMAIL)}`, 10_000));

  const dump = await sw.eval<string>(`chrome.storage.local.get(null).then((r) => JSON.stringify(r))`);
  check('master password is not in chrome.storage.local', !dump.includes(PASSWORD));
  check('storage holds one namespace per server', dump.includes('pv.http_localhost_3000.') && dump.includes('pv.http_127_0_0_1_3000.') && !dump.includes('"pv.sessionToken"'));
  await closePopup(popup);
  sw.close();
} finally {
  proc.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
