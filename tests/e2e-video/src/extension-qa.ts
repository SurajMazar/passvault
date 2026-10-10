/**
 * Extension QA in real Chromium: the packaged popup is opened with
 * chrome.action.openPopup() and driven with trusted DevTools input, against a
 * local https test site (self-signed certificate, accepted by this throwaway
 * browser only) and the local API.
 *
 *   sign in with two-step code · website logins only (no SSH keys or notes)
 *   · identifiers · "this site" and "other websites" searches · fill a login
 *   · fill a login with an extra field (AWS-style account ID) · fill a card
 *   on a checkout page · lock closes the popup · Touch ID: turn on, the lock
 *   screen unlocks by itself when the popup opens, and a missing or
 *   unavailable Touch ID never blocks the master password · nothing secret
 *   in chrome.storage.local.
 *
 * Touch ID goes through Chrome's real native messaging to a stand-in host
 * that speaks pv-touchid's protocol (no fingerprint prompt on the tester's
 * screen); pv-touchid itself is checked separately. Test-only manifest
 * changes in a copy of the build: nativeMessaging granted up front and
 * https host access (as if the user had allowed them).
 *
 *   (cd apps/browser-extension && npx vite build --mode e2e --outDir /tmp/pv-ext-local)
 *   PV_EXT_DIR=/tmp/pv-ext-local pnpm --filter @passvault/e2e-video check:extension
 */
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { TOTP } from 'otpauth';
import { newItem } from '@passvault/vault-core';
import { headlessSession, mailCode, sleep } from './tour/lib';

const SRC = process.env.PV_EXT_DIR;
if (!SRC) throw new Error('Set PV_EXT_DIR to a local-development extension build');
const API = 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ------------------------------------------------------------ extension copy (test-only grants)
const work = mkdtempSync(join(tmpdir(), 'pv-extqa-'));
const EXT = join(work, 'ext');
cpSync(SRC, EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8')) as { permissions: string[]; optional_permissions?: string[]; host_permissions: string[] };
if (!manifest.host_permissions.includes('http://localhost:3000/*')) throw new Error('Expected a local-development build (host http://localhost:3000)');
manifest.permissions = [...new Set([...manifest.permissions, 'nativeMessaging'])];
manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== 'nativeMessaging');
manifest.host_permissions = [...new Set([...manifest.host_permissions, 'https://*/*', 'http://*/*'])];
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ------------------------------------------------------------ https test site
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem')], { stdio: 'ignore' });
const PAGES: Record<string, string> = {
  '/login': `<form><label>Email <input id="u" name="email" autocomplete="username"></label>
    <label>Password <input id="p" name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`,
  // AWS IAM-style: account ID first, then IAM user name and password.
  '/aws': `<form><label for="account">Account ID (12 digits) or account alias</label><input id="account" name="account" type="text">
    <label for="username">IAM username</label><input id="username" name="username" type="text">
    <label for="password">Password</label><input id="password" name="password" type="password"><button>Sign in</button></form>`,
  // Same form posting to the server, for the save prompt.
  '/aws-post': `<form method="post" action="/aws-done"><label for="account">Account ID (12 digits) or account alias</label><input id="account" name="account" type="text">
    <label for="username">IAM username</label><input id="username" name="username" type="text">
    <label for="password">Password</label><input id="password" name="password" type="password"><button type="submit">Sign in</button></form>`,
  '/aws-done': '<p>Signed in</p>',
  '/checkout': `<form><label>Name on card <input id="cn" autocomplete="cc-name"></label>
    <label>Card number <input id="cc" autocomplete="cc-number" inputmode="numeric"></label>
    <label>Month <input id="mm" autocomplete="cc-exp-month"></label><label>Year <input id="yy" autocomplete="cc-exp-year"></label>
    <label>CVC <input id="cvc" autocomplete="cc-csc"></label><button>Pay</button></form>`,
};
const site = createServer({ key: readFileSync(join(work, 'key.pem')), cert: readFileSync(join(work, 'cert.pem')) }, (req, res) => {
  if (req.method === 'POST') {
    req.resume();
    res.writeHead(303, { Location: '/aws-done' }).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>QA ${req.url}</title><h1>QA</h1>${PAGES[req.url ?? ''] ?? ''}`);
});
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const SITE_PORT = (site.address() as { port: number }).port;
const SITE = `https://localhost:${SITE_PORT}`;
const AWS_SITE = `https://127.0.0.1:${SITE_PORT}`;

// ------------------------------------------------------------ stand-in Touch ID host (pv-touchid protocol)
const hostDir = join(work, 'host');
mkdirSync(hostDir);
const HOST_LOG = join(hostDir, 'calls.log');
const HOST_MODE = join(hostDir, 'mode'); // "ok" | "unavailable"
writeFileSync(HOST_MODE, 'ok');
const hostScript = join(hostDir, 'host.js');
writeFileSync(
  hostScript,
  `#!${process.execPath}
const fs = require('fs'), path = require('path');
const DB = path.join(__dirname, 'db.json');
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    const msg = JSON.parse(buf.subarray(4, 4 + n).toString());
    buf = buf.subarray(4 + n);
    const out = Buffer.from(JSON.stringify(handle(msg)));
    const h = Buffer.alloc(4); h.writeUInt32LE(out.length);
    process.stdout.write(Buffer.concat([h, out]));
  }
});
function handle(m) {
  fs.appendFileSync(${JSON.stringify(HOST_LOG)}, m.op + ' ' + (m.account || '') + ' ' + (m.reason || '') + '\\n');
  const mode = fs.readFileSync(${JSON.stringify(HOST_MODE)}, 'utf8').trim();
  const db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : {};
  if (mode === 'unavailable') return m.op === 'status' ? { ok: true, available: false, reason: 'Touch ID is not set up on this Mac' } : { ok: false, code: 'unavailable', message: 'Touch ID is not set up on this Mac' };
  switch (m.op) {
    case 'status': return { ok: true, available: true };
    case 'enroll': db[m.account] = m.secretB64; fs.writeFileSync(DB, JSON.stringify(db)); return { ok: true };
    case 'unlock': return db[m.account] ? { ok: true, secretB64: db[m.account] } : { ok: false, code: 'not_enrolled', message: 'Touch ID is not set up for this account' };
    case 'remove': delete db[m.account]; fs.writeFileSync(DB, JSON.stringify(db)); return { ok: true };
    default: return { ok: false, code: 'bad_request', message: 'unknown op' };
  }
}
`,
);
chmodSync(hostScript, 0o755);

// ------------------------------------------------------------ synthetic account + items
const EMAIL = `extqa.${Date.now().toString(36)}@example.com`;
const PASSWORD = 'harbor-quartz-ember-willow-58';
const setup = headlessSession(API, 'http://localhost:5173');
await setup.init();
const t0 = Date.now();
await setup.startRegistration(EMAIL);
await setup.register(await setup.verifyRegistration(EMAIL, await mailCode(MAILPIT, EMAIL, t0)), EMAIL, 'Extension QA', PASSWORD);
await setup.login(EMAIL, PASSWORD);
const { secret } = await setup.startMfaEnrollment();
const totp = new TOTP({ secret });
await setup.confirmMfaEnrollment(totp.generate());
setup.acknowledgeRecoveryCodes();
await setup.syncNow();
const L = (title: string, url: string, username: string, password: string, extra: Partial<Parameters<typeof newItem<'login'>>[1]> = {}) =>
  setup.saveItem(newItem('login', { title, fields: { username, password, urls: [{ url, match: 'host' }] }, ...extra }));
await L('QA site', SITE, 'personal@example.com', 'Personal-Pass-1!', { description: 'personal-qa' });
await L('QA site (work)', SITE, 'work@example.com', 'Work-Pass-2!', { description: 'work-qa' });
await L('AWS root', AWS_SITE, 'ops-admin', 'Aws-Pass-3!', { description: 'aws-prod', customFields: [{ id: crypto.randomUUID(), label: 'Account ID', type: 'text', value: '123456789012' }] });
await L('Billing portal', 'https://billing.example.com', 'billing@example.com', 'Billing-Pass-4!', { description: 'billing-acct' });
await setup.saveItem(newItem('ssh_key', { title: 'Deploy key QA', fields: { privateKey: '', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGl1c3QtYS1xYS1rZXktbm90LXJlYWwtYXQtYWxsLW9r qa', fingerprint: '', algorithm: 'ed25519' } }));
await setup.saveItem(newItem('secure_note', { title: 'Wifi note QA', fields: { content: 'dummy' } }));
await setup.saveItem(newItem('payment_card', { title: 'QA Visa', fields: { cardholder: 'Alex Rivera', number: '4111111111111111', expMonth: '08', expYear: '2031', cvv: '123', pin: '' } }));
await setup.syncNow();
await setup.logout();

// ------------------------------------------------------------ Chromium + CDP
class Target {
  private id = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    // A closed window (e.g. the popup closing itself) must fail the step, not hang it.
    ws.addEventListener('close', () => {
      for (const w of this.waiting.values()) w.reject(new Error('target closed'));
      this.waiting.clear();
    });
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
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('target closed'));
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
const profile = join(work, 'profile');
mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true });
const proc = spawn(
  chromium.executablePath(),
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--ignore-certificate-errors',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    'about:blank',
  ],
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
async function waitTarget(pred: (t: TargetInfo) => boolean, ms = 10_000): Promise<TargetInfo> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = (await targets()).find(pred);
    if (t) return t;
    await sleep(200);
  }
  throw new Error('target not found');
}
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
const byTab = (name: string) => `[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === ${q(name)})`;
const byPlaceholder = (p: string) => `document.querySelector('input[placeholder=${q(p)}]')`;
/** The row (list item) that contains `title`, or null. */
const rowWith = (title: string) => `[...document.querySelectorAll('li, [role=option], [role=listitem]')].find((r) => r.innerText.includes(${q(title)}))`;
async function click(t: Target, elExpr: string) {
  if (!(await waitFor(t, elExpr))) throw new Error(`element not found: ${elExpr.slice(0, 120)}`);
  const box = await t.eval<{ x: number; y: number }>(`(() => { const e = ${elExpr}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await t.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(150);
}
async function fill(t: Target, elExpr: string, text: string) {
  await click(t, elExpr);
  await t.eval(`(() => { const e = ${elExpr}; e.select && e.select(); })()`);
  await t.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await t.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  if (text) await t.send('Input.insertText', { text });
  await sleep(250);
}
async function shot(t: Target, name: string) {
  const dir = process.env.PV_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const r = await t.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(r.data, 'base64'));
}
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    check(name, false, (e instanceof Error ? e.message : String(e)).split('\n')[0]);
  }
}

let browserTarget: Target | null = null;
try {
  await targets(); // waits for Chromium to start
  const version = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  browserTarget = await Target.open(version.webSocketDebuggerUrl);
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
  const extId = await sw.eval<string>('chrome.runtime.id');
  writeFileSync(
    join(profile, 'NativeMessagingHosts', 'io.passvault.touchid.json'),
    JSON.stringify({ name: 'io.passvault.touchid', description: 'QA stand-in', path: hostScript, type: 'stdio', allowed_origins: [`chrome-extension://${extId}/`] }),
  );

  /** Opens `url` in a new foreground tab and returns its page target. */
  async function openTab(url: string): Promise<Target> {
    const { targetId } = await browserTarget!.send<{ targetId: string }>('Target.createTarget', { url });
    await browserTarget!.send('Target.activateTarget', { targetId });
    const info = await waitTarget((t) => t.id === targetId && t.url.startsWith(url.split('?')[0]!));
    const page = await Target.open(info.webSocketDebuggerUrl);
    await waitFor(page, `document.readyState === 'complete'`);
    return page;
  }
  const popupOpen = async () => (await targets()).some((t) => t.url.endsWith('/popup.html'));
  async function closePopup(p: Target) {
    await p.eval(`window.close()`).catch(() => undefined);
    p.close();
    for (let i = 0; i < 50 && (await popupOpen()); i++) await sleep(100);
  }
  async function openPopup(): Promise<Target> {
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
  const fieldValues = (page: Target, ids: string[]) => page.eval<Record<string, string>>(`Object.fromEntries(${JSON.stringify(ids)}.map((id) => [id, document.getElementById(id).value]))`);

  // ---------------------------------------------------------- sign in
  let page = await openTab(`${SITE}/login`);
  let popup = await openPopup();
  await step('sign in with two-step code', async () => {
    await waitFor(popup, hasText('Sign in to PassVault'));
    await sleep(30_000 - (Date.now() % 30_000) + 500); // a fresh TOTP step (enrollment used the current one)
    await fill(popup, byLabel('Email'), EMAIL);
    await fill(popup, byLabel('Master password'), PASSWORD);
    await click(popup, byButton('Sign in'));
    await fill(popup, byLabel('Authenticator code'), totp.generate());
    await click(popup, byButton('Verify'));
    check('sign in with two-step code', await waitFor(popup, byButton('Lock'), 20_000));
  });

  // ---------------------------------------------------------- lists, identifiers, searches
  await step('this site / other websites', async () => {
    await waitFor(popup, hasText('QA site (work)'), 10_000);
    await shot(popup, 'ext-1-site');
    const text = await popup.eval<string>('document.body.innerText');
    check('this site lists both logins for the page', text.includes('QA site') && text.includes('QA site (work)'));
    check('identifiers shown next to titles', text.includes('personal-qa') && text.includes('work-qa'));
    check('SSH keys, notes and cards are not in the logins list', !text.includes('Deploy key QA') && !text.includes('Wifi note QA') && !text.includes('QA Visa'));
    await fill(popup, byPlaceholder('Search this site’s logins…'), 'work-qa');
    const site = await popup.eval<string>(`document.getElementById('pv-site')?.closest('section')?.innerText ?? document.body.innerText`);
    check('this-site search filters by identifier', site.includes('QA site (work)') && !/QA site\n|QA site$/m.test(site.replace('QA site (work)', '')), site.replace(/\s+/g, ' ').slice(0, 160));
    await fill(popup, byPlaceholder('Search this site’s logins…'), '');
    await fill(popup, byPlaceholder('Search other websites…'), 'billing-acct');
    check('other-websites search finds by identifier', await waitFor(popup, hasText('Billing portal'), 3000));
    await fill(popup, byPlaceholder('Search other websites…'), 'Deploy key');
    await sleep(300);
    check('other-websites search never returns an SSH key', !(await popup.eval<boolean>(hasText('Deploy key QA'))));
    await fill(popup, byPlaceholder('Search other websites…'), '');
  });

  // ---------------------------------------------------------- fill a login
  await step('fill a login from the popup', async () => {
    await click(popup, `${rowWith('personal-qa')}?.querySelector('button:last-of-type')`);
    await sleep(800);
    const v = await fieldValues(page, ['u', 'p']);
    check('fill a login from the popup', v.u === 'personal@example.com' && v.p === 'Personal-Pass-1!', JSON.stringify({ u: v.u, p: v.p ? '(set)' : '' }));
  });
  if (await popupOpen()) await closePopup(popup);

  // ---------------------------------------------------------- AWS-style form with an extra field
  await step('fill an AWS-style form including the account ID', async () => {
    page = await openTab(`${AWS_SITE}/aws`);
    popup = await openPopup();
    await waitFor(popup, hasText('AWS root'), 10_000);
    await click(popup, `${rowWith('aws-prod')}?.querySelector('button:last-of-type')`);
    await sleep(800);
    const v = await fieldValues(page, ['account', 'username', 'password']);
    check('AWS-style form: account ID, user name and password filled', v.account === '123456789012' && v.username === 'ops-admin' && v.password === 'Aws-Pass-3!', JSON.stringify({ ...v, password: v.password ? '(set)' : '' }));
  });
  if (await popupOpen()) await closePopup(popup);

  // ---------------------------------------------------------- card on a checkout page
  await step('fill a card on a checkout page', async () => {
    page = await openTab(`${SITE}/checkout`);
    popup = await openPopup();
    await click(popup, byTab('Cards'));
    await waitFor(popup, hasText('QA Visa'));
    const cardsText = await popup.eval<string>('document.body.innerText');
    check('card list shows brand and last four, never the full number', /1111/.test(cardsText) && !cardsText.includes('4111111111111111') && !cardsText.includes('4111 1111'));
    await click(popup, `${rowWith('QA Visa')}?.querySelector('button:last-of-type')`);
    await sleep(800);
    const v = await fieldValues(page, ['cn', 'cc', 'mm', 'yy', 'cvc']);
    check('card filled: name, number, expiry, security code', v.cn === 'Alex Rivera' && (v.cc ?? '').replace(/\s/g, '') === '4111111111111111' && v.mm === '08' && (v.yy === '2031' || v.yy === '31') && v.cvc === '123', JSON.stringify({ ...v, cc: v.cc ? `…${v.cc.slice(-4)}` : '', cvc: v.cvc ? '(set)' : '' }));
  });
  if (!(await popupOpen())) popup = await openPopup();

  // ---------------------------------------------------------- save prompt with an extra field (trusted typing + submit)
  await step('save an AWS-style login with its account ID from the save bar', async () => {
    const set = await popup.eval<unknown>(`chrome.runtime.sendMessage({ type: 'autosave.set', enabled: true })`);
    check('offer-to-save turned on', JSON.stringify(set).includes('"enabled":true'), JSON.stringify(set));
    await closePopup(popup);
    await waitFor(sw!, `chrome.scripting.getRegisteredContentScripts().then((s) => s.some((x) => x.js?.includes('save-prompt.js')))`, 10_000);
    page = await openTab(`${AWS_SITE}/aws-post`);
    await sleep(800); // document_idle injection
    await fill(page, `document.getElementById('account')`, '999988887777');
    await fill(page, `document.getElementById('username')`, 'new-iam-user');
    await fill(page, `document.getElementById('password')`, 'New-Iam-Pass-9!');
    await click(page, `document.querySelector('button[type=submit]')`);
    await waitFor(page, `location.pathname === '/aws-done'`, 10_000);
    check('save bar shown after signing in', await waitFor(page, `document.querySelector('passvault-save-prompt')`, 8000));
    // The bar lives in a closed shadow root: find its Save button through the DevTools DOM tree.
    type DomNode = { nodeId: number; nodeName: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };
    const { root } = await page.send<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: true });
    const find = (n: DomNode): DomNode | null => {
      const a = n.attributes ?? [];
      if (n.nodeName === 'BUTTON' && a.includes('data-d') && a[a.indexOf('data-d') + 1] === 'save') return n;
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
        const f = find(c);
        if (f) return f;
      }
      return null;
    };
    const btn = find(root);
    if (!btn) throw new Error('Save button not found in the save bar');
    const { model } = await page.send<{ model: { content: number[] } }>('DOM.getBoxModel', { nodeId: btn.nodeId });
    const [x1, y1, , , x3, y3] = model.content as [number, number, number, number, number, number];
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: (x1 + x3) / 2, y: (y1 + y3) / 2, button: 'left', clickCount: 1 });
    await sleep(1500);
    // Fill it back on a fresh form: the account ID must come back too.
    page = await openTab(`${AWS_SITE}/aws`);
    popup = await openPopup();
    check('saved login listed for the site', await waitFor(popup, hasText('new-iam-user'), 10_000));
    await click(popup, `${rowWith('new-iam-user')}?.querySelector('button:last-of-type')`);
    await sleep(800);
    const v = await fieldValues(page, ['account', 'username', 'password']);
    check('saved extra field (account ID) is filled back', v.account === '999988887777' && v.username === 'new-iam-user' && v.password === 'New-Iam-Pass-9!', JSON.stringify({ ...v, password: v.password ? '(set)' : '' }));
  });
  if (!(await popupOpen())) popup = await openPopup();

  // ---------------------------------------------------------- Touch ID
  await step('Touch ID: turn on, lock closes the popup, reopening unlocks', async () => {
    await click(popup, byTab('Settings'));
    const sw2 = `[...document.querySelectorAll('[role=switch]')].find((s) => (s.getAttribute('aria-labelledby') ? document.getElementById(s.getAttribute('aria-labelledby')).textContent : s.closest('label, div')?.textContent ?? '').includes('Unlock with Touch ID'))`;
    await click(popup, sw2);
    check('turn on Touch ID', await waitFor(popup, `${sw2}?.getAttribute('aria-checked') === 'true'`, 10_000));
    check('the key was handed to the Touch ID host', readFileSync(HOST_LOG, 'utf8').includes('enroll '));
    await click(popup, byTab('Vault'));
    await click(popup, byButton('Lock'));
    await sleep(1500);
    check('locking closes the popup', !(await popupOpen()));
    popup.close();
    popup = await openPopup();
    const unlocked = await waitFor(popup, byButton('Lock'), 15_000);
    await shot(popup, 'ext-2-after-touchid');
    check('reopening the popup unlocks with Touch ID by itself', unlocked && readFileSync(HOST_LOG, 'utf8').includes('unlock '));
  });

  await step('Touch ID unavailable: master password still works', async () => {
    writeFileSync(HOST_MODE, 'unavailable');
    if (!(await popupOpen())) popup = await openPopup();
    await click(popup, byButton('Lock'));
    await sleep(1200);
    if (await popupOpen()) await closePopup(popup);
    popup = await openPopup();
    await waitFor(popup, hasText('PassVault is locked'), 10_000);
    await sleep(1500);
    await shot(popup, 'ext-3-touchid-unavailable');
    const pwField = await waitFor(popup, byLabel('Master password'), 3000);
    check('lock screen offers the master password when Touch ID cannot be used', pwField);
    check('lock screen says why Touch ID cannot be used', await popup.eval<boolean>(`${hasText('Touch ID is on but can’t be used right now')} && ${hasText('Touch ID is not set up on this Mac')}`));
    await fill(popup, byLabel('Master password'), PASSWORD);
    await click(popup, byButton('Unlock'));
    check('master password unlocks', await waitFor(popup, byButton('Lock'), 15_000));
  });

  await step('Touch ID host missing entirely: no hang, master password works', async () => {
    writeFileSync(HOST_MODE, 'ok');
    rmSync(join(profile, 'NativeMessagingHosts', 'io.passvault.touchid.json'));
    await click(popup, byButton('Lock'));
    await sleep(1200);
    if (await popupOpen()) await closePopup(popup);
    popup = await openPopup();
    const ready = await waitFor(popup, byLabel('Master password'), 8000);
    await shot(popup, 'ext-4-host-missing');
    check('lock screen usable within a few seconds when the Mac app is missing', ready);
    check('lock screen points to PassVault for Mac when its Touch ID host is missing', await waitFor(popup, `${hasText('Touch ID is on but can’t be used right now')} && ${hasText('PassVault for Mac')}`, 6000));
    await fill(popup, byLabel('Master password'), PASSWORD);
    await click(popup, byButton('Unlock'));
    check('master password unlocks without the Mac app', await waitFor(popup, byButton('Lock'), 15_000));
  });

  const dump = await sw.eval<string>(`chrome.storage.local.get(null).then((r) => JSON.stringify(r))`);
  check('nothing secret in chrome.storage.local', !dump.includes(PASSWORD) && !dump.includes('Personal-Pass-1!') && !dump.includes('4111111111111111') && !dump.includes('123456789012'));
  if (existsSync(HOST_LOG)) check('Touch ID host never received the master password', !readFileSync(HOST_LOG, 'utf8').includes(PASSWORD));
  sw.close();
} finally {
  browserTarget?.close();
  proc.kill();
  site.close();
  await sleep(300);
  rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
