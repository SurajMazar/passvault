/**
 * End-to-end check of "Offer to save passwords" in the REAL extension: the
 * packaged build is loaded in Chromium, the setting is on with all-sites
 * access (test-only: the optional host permissions are granted in a copy of
 * the manifest, as if the user clicked Allow), the content script is
 * registered by the background exactly as in production, and a login form on
 * a local test site is submitted with trusted input (DevTools Input events).
 *
 *   PV_EXT_DIR=<unzipped extension> pnpm --filter @passvault/e2e-video check:save-prompt-extension
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const SRC = process.env.PV_EXT_DIR;
if (!SRC) throw new Error('Set PV_EXT_DIR to an unzipped extension build');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), 'pv-save-'));
const EXT = join(work, 'ext');
cpSync(SRC, EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8')) as { host_permissions: string[] };
manifest.host_permissions = [...new Set([...manifest.host_permissions, 'https://*/*', 'http://*/*'])];
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ------------------------------------------------------------ local test site (classic POST login)
const site = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/session') {
    req.resume();
    res.writeHead(303, { Location: '/welcome' }).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    req.url === '/welcome'
      ? '<!doctype html><title>Welcome</title><h1>Signed in</h1>'
      : `<!doctype html><title>Login</title><form method="post" action="/session">
           <label>Username <input id="username" name="username" autocomplete="username"></label>
           <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
           <button type="submit">Login</button></form>`,
  );
});
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

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
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

const PORT = 9300 + Math.floor(Math.random() * 400);
const profile = join(work, 'profile');
const proc = spawn(
  chromium.executablePath(),
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, 'about:blank'],
  { stdio: 'ignore' },
);
type TargetInfo = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
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
async function serviceWorker(): Promise<Target> {
  for (let i = 0; i < 60; i++) {
    for (const t of (await targets()).filter((x) => x.type === 'service_worker')) {
      const cand = await Target.open(t.webSocketDebuggerUrl);
      if ((await cand.eval<string>(`chrome.runtime.getManifest().name`).catch(() => '')) === 'PassVault') return cand;
      cand.close();
    }
    await sleep(250);
  }
  throw new Error('PassVault service worker not found');
}
async function waitFor(t: Target, expr: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await t.eval<boolean>(`!!(${expr})`).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}
async function clickEl(t: Target, sel: string) {
  const b = await t.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await t.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 });
}
async function typeInto(t: Target, sel: string, text: string) {
  await clickEl(t, sel);
  await t.send('Input.insertText', { text });
}

try {
  const sw = await serviceWorker();
  const status = () => sw.eval<{ enabled: boolean; permission: boolean }>(`chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] }).then(async (permission) => ({ permission, enabled: (await chrome.storage.local.get('pv.autoSave.enabled'))['pv.autoSave.enabled'] === true }))`);
  check('all-sites access granted (as after the user clicked Allow)', (await status()).permission);

  // Turn the setting on from the real toolbar popup, with the message its Settings toggle sends.
  const browserTarget = await Target.open(((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
  for (let i = 0; ; i++) {
    try {
      await sw.eval(`chrome.action.openPopup()`);
      break;
    } catch (e) {
      if (i >= 20) throw e;
      await sleep(300);
    }
  }
  let popupInfo: TargetInfo | undefined;
  for (let i = 0; i < 50 && !popupInfo; i++) {
    popupInfo = (await targets()).find((t) => t.url.endsWith('/popup.html'));
    if (!popupInfo) await sleep(200);
  }
  const popup = await Target.open(popupInfo!.webSocketDebuggerUrl);
  const set = await popup.eval<unknown>(`chrome.runtime.sendMessage({ type: 'autosave.set', enabled: true })`);
  check('the popup turns the setting on', JSON.stringify(set).includes('"enabled":true'), JSON.stringify(set));
  await popup.eval(`window.close()`).catch(() => undefined);
  const registered = await waitFor(sw, `chrome.scripting.getRegisteredContentScripts().then((s) => s.some((x) => x.js?.includes('save-prompt.js')))`, 10_000);
  check('content script registered by the background', registered, JSON.stringify(await sw.eval(`chrome.scripting.getRegisteredContentScripts()`)));

  const { targetId } = await browserTarget.send<{ targetId: string }>('Target.createTarget', { url: `${SITE}/login` });
  await sleep(500);
  const page = await Target.open((await targets()).find((t) => t.id === targetId)!.webSocketDebuggerUrl);
  await waitFor(page, `document.readyState === 'complete' && document.querySelector('#password')`);
  await sleep(800); // document_idle injection
  check('content script runs on the login page', await waitFor(page, `globalThis.__pvSavePrompt === undefined`, 1000).then(() => true));
  await typeInto(page, '#username', 'tester@example.com');
  await typeInto(page, '#password', 'correct-horse-battery-staple');
  await clickEl(page, 'button[type=submit]');
  await waitFor(page, `location.pathname === '/welcome'`, 10_000);
  const shown = await waitFor(page, `document.querySelector('passvault-save-prompt')`, 8000);
  check('save prompt shown after the login (post-navigation)', shown, `page ${await page.eval<string>('location.pathname')}`);
  const pending = await sw.eval<string>(`chrome.storage.session.get(null).then((r) => Object.keys(r).join(','))`);
  check('pending capture kept only in session storage', !(await sw.eval<string>(`chrome.storage.local.get(null).then((r) => JSON.stringify(r))`)).includes('correct-horse'), `session keys: ${pending}`);
  page.close();
  sw.close();
} finally {
  proc.kill();
  site.close();
  await sleep(300);
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
