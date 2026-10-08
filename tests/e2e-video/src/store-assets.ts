/**
 * Chrome Web Store assets from the REAL extension UI.
 *
 * Creates a demo account with fictional logins on the local stack, loads the
 * extension in Chromium, signs in through the real popup, captures the popup,
 * the in-page suggestions menu, the save bar, the generator and the server
 * settings, then composes the store images:
 *
 *   docs/store/icon-128.png                 store icon
 *   docs/store/screenshot-{1..5}.jpg        1280×800, no alpha
 *   docs/store/promo-small.jpg              440×280
 *   docs/store/promo-marquee.jpg            1400×560
 *
 *   (cd apps/browser-extension && npx vite build --mode e2e --outDir <dir>)
 *   PV_EXT_DIR=<dir> pnpm --filter @passvault/e2e-video store-assets
 *
 * Needs the local stack (API :3000, Mailpit :8025).
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { TOTP } from 'otpauth';
import { newItem } from '@passvault/vault-core';
import { headlessSession, mailCode } from './tour/lib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = join(ROOT, 'docs/store');
const SRC = process.env.PV_EXT_DIR;
if (!SRC) throw new Error('Set PV_EXT_DIR to an extension build for the local stack (vite build --mode e2e)');
const API = process.env.PV_API ?? 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'pv-store-'));
const RAW = join(work, 'raw');
mkdirSync(RAW);

// ------------------------------------------------------------ extension copy with all-sites access (as after "Allow")
const EXT = join(work, 'ext');
cpSync(SRC, EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8')) as { host_permissions: string[] };
manifest.host_permissions = [...new Set([...manifest.host_permissions, 'https://*/*', 'http://*/*'])];
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));

// ------------------------------------------------------------ fictional websites (https, self-signed — test browser only)
const cert = join(work, 'cert.pem');
const key = join(work, 'key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
const page = (brand: string, color: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${brand}</title>
<style>*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6fb;color:#1c2330}
header{display:flex;align-items:center;justify-content:center;gap:10px;padding:18px 40px;background:#fff;border-bottom:1px solid #e3e7ef}
.logo{width:28px;height:28px;border-radius:8px;background:${color}}header b{font-size:18px}
main{display:flex;justify-content:center;padding:70px 20px}.card{width:380px;background:#fff;border:1px solid #e3e7ef;border-radius:14px;padding:30px;box-shadow:0 8px 30px rgba(20,30,60,.08)}
h1{font-size:22px;margin:0 0 6px}p{color:#5d6878;margin:0 0 22px}label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input{width:100%;height:42px;border:1px solid #cfd6e2;border-radius:9px;padding:0 12px;font:inherit}button{margin-top:22px;width:100%;height:44px;border:0;border-radius:9px;background:${color};color:#fff;font:600 15px inherit;cursor:pointer}</style></head>
<body><header><div class="logo"></div><b>${brand}</b></header><main>${body}</main></body></html>`;
const login = (brand: string, color: string) =>
  page(brand, color, `<form class="card" method="post" action="/session"><h1>Sign in</h1><p>Welcome back to ${brand}.</p>
<label for="username">Email</label><input id="username" name="username" autocomplete="username">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
<button type="submit">Sign in</button></form>`);
const sites = new Map<number, { brand: string; color: string }>();
async function site(brand: string, color: string): Promise<string> {
  const srv = createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    if (req.method === 'POST' && req.url === '/session') {
      req.resume();
      res.writeHead(303, { Location: '/home' }).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url === '/home' ? page(brand, color, `<div class="card"><h1>Hi Alex 👋</h1><p>You're signed in to ${brand}.</p></div>`) : login(brand, color));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const host = `${brand.toLowerCase().replace(/[^a-z]+/g, '-')}.example`;
  sites.set(port, { brand, color });
  hostRules.push(`MAP ${host}:443 127.0.0.1:${port}`);
  return `https://${host}`;
}
const hostRules: string[] = [];
const step = (m: string) => console.log(`• ${m}`);
const ACME = await site('Acme Cloud', '#4f6df5');
const NORTHWIND = await site('Northwind Mail', '#e8743b');

// ------------------------------------------------------------ demo account with fictional logins
// Demo account on the LOCAL stack only; its TOTP secret is kept (gitignored .raw/) so reruns reuse it.
const STATE = join(ROOT, 'tests/e2e-video/.raw/store-account.json');
const MASTER = 'quartz-meadow-signal-harbor-73';
let EMAIL = 'alex.rivera@example.com';
let stored: { email: string; secret: string } | null = null;
try {
  stored = JSON.parse(readFileSync(STATE, 'utf8')) as { email: string; secret: string };
} catch {
  /* first run */
}
const setup = headlessSession(API, 'http://localhost:5173');
await setup.init();
let totp: TOTP;
step('demo account');
if (stored) {
  EMAIL = stored.email;
  totp = new TOTP({ secret: stored.secret });
  await setup.login(EMAIL, MASTER);
  await setup.verifyMfa({ code: totp.generate() });
  await setup.syncNow();
} else {
  const t0 = Date.now();
  await setup.startRegistration(EMAIL);
  await setup.register(await setup.verifyRegistration(EMAIL, await mailCode(MAILPIT, EMAIL, t0)), EMAIL, 'Alex Rivera', MASTER);
  await setup.login(EMAIL, MASTER);
  const { secret } = await setup.startMfaEnrollment();
  totp = new TOTP({ secret });
  await setup.confirmMfaEnrollment(totp.generate());
  setup.acknowledgeRecoveryCodes();
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ email: EMAIL, secret }), { mode: 0o600 });
}
const L = (title: string, username: string, url: string, folder = '', tags: string[] = []) =>
  newItem('login', { title, folder, tags, fields: { username, password: `Demo-${Math.random().toString(36).slice(2, 10)}-Pw!`, urls: [{ url, match: 'host' }] } });
step('demo logins');
for (const old of setup.getSnapshot().items) await setup.deletePermanently(old.id).catch(() => undefined);
for (const it of [
  L('Acme Cloud', 'alex@acme.example', ACME, 'Work', ['admin']),
  L('Acme Cloud (billing)', 'billing@acme.example', ACME, 'Work'),
  L('Contoso Docs', 'alex.rivera', 'https://docs.contoso.example', 'Work'),
  L('Fabrikam CRM', 'alex@fabrikam.example', 'https://crm.fabrikam.example', 'Sales'),
  L('Tailspin Bank', 'arivera', 'https://bank.tailspin.example', 'Personal'),
  L('Wingtip Travel', 'alex.rivera@example.com', 'https://wingtip.example', 'Personal'),
]) {
  await setup.saveItem(it);
}
await setup.syncNow();
await setup.logout({ keepCache: false });

// ------------------------------------------------------------ Chromium + CDP
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
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  async shot(file: string, clip?: { x: number; y: number; width: number; height: number }) {
    const r = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  close() {
    this.ws.close();
  }
}

step('chromium');
const PORT = 9300 + Math.floor(Math.random() * 400);
const proc = spawn(
  chromium.executablePath(),
  ['--headless=new', '--ignore-certificate-errors', `--host-resolver-rules=${hostRules.join(', ')}`, '--window-size=1280,800', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, 'about:blank'],
  { stdio: 'ignore' },
);
type Info = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
const targets = async (): Promise<Info[]> => {
  for (let i = 0; i < 50; i++) {
    try {
      return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Info[];
    } catch {
      await sleep(200);
    }
  }
  throw new Error('Chromium did not start');
};
async function waitFor(t: Target, expr: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await t.eval<boolean>(`!!(${expr})`).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}
const q = (s: string) => JSON.stringify(s);
const byLabel = (label: string) => `(() => { const l = [...document.querySelectorAll('label')].find((x) => x.textContent.trim() === ${q(label)}); return l && document.getElementById(l.htmlFor); })()`;
const byButton = (name: string) => `[...document.querySelectorAll('button')].find((b) => (b.textContent.trim() === ${q(name)} || b.getAttribute('aria-label') === ${q(name)}) && !b.disabled)`;
const byTab = (name: string) => `[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === ${q(name)})`;
async function click(t: Target, expr: string) {
  if (!(await waitFor(t, expr))) throw new Error(`not found: ${expr.slice(0, 80)}`);
  const b = await t.eval<{ x: number; y: number }>(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await t.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await sleep(200);
}
async function type(t: Target, expr: string, text: string) {
  await click(t, expr);
  await t.send('Input.insertText', { text });
}

const POPUP = { width: 380, height: 600 };
let settingsTop = 0; // where the privacy switches start in the settings capture
try {
  let sw: Target | null = null;
  for (let i = 0; i < 60 && !sw; i++) {
    for (const t of (await targets()).filter((x) => x.type === 'service_worker')) {
      const c = await Target.open(t.webSocketDebuggerUrl);
      if ((await c.eval<string>('chrome.runtime.getManifest().name').catch(() => '')) === 'PassVault') sw = c;
      else c.close();
      if (sw) break;
    }
    if (!sw) await sleep(250);
  }
  if (!sw) throw new Error('PassVault service worker not found');
  const browser = await Target.open(((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);

  const openTab = async (url: string): Promise<Target> => {
    const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url });
    await browser.send('Target.activateTarget', { targetId });
    await sleep(600);
    const t = await Target.open((await targets()).find((x) => x.id === targetId)!.webSocketDebuggerUrl);
    await t.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }).catch(() => undefined);
    await waitFor(t, `document.readyState === 'complete'`);
    return t;
  };
  const openPopup = async (): Promise<Target> => {
    for (let i = 0; ; i++) {
      try {
        await sw!.eval('chrome.action.openPopup()');
        break;
      } catch (e) {
        if (i >= 20) throw e;
        await sleep(300);
      }
    }
    let info: Info | undefined;
    for (let i = 0; i < 50 && !info; i++) {
      info = (await targets()).find((t) => t.url.endsWith('/popup.html'));
      if (!info) await sleep(200);
    }
    const p = await Target.open(info!.webSocketDebuggerUrl);
    await waitFor(p, `document.readyState === 'complete'`);
    await sleep(500);
    return p;
  };
  const closePopup = async (p: Target) => {
    await p.eval('window.close()').catch(() => undefined);
    p.close();
    await sleep(400);
  };

  // Settings: suggestions + offer to save on (the popup's toggles send these messages).
  let acme = await openTab(`${ACME}/login`);
  let pop = await openPopup();
  await pop.eval(`chrome.runtime.sendMessage({ type: 'autosave.set', enabled: true })`);
  await pop.eval(`chrome.runtime.sendMessage({ type: 'inline.set', enabled: true })`);
  step('sign in (waits for a fresh TOTP window)');
  // Sign in (fresh TOTP window).
  await sleep(30_000 - (Date.now() % 30_000) + 500);
  await type(pop, byLabel('Email'), EMAIL);
  await type(pop, byLabel('Master password'), MASTER);
  await click(pop, byButton('Sign in'));
  await type(pop, byLabel('Authenticator code'), totp.generate());
  await click(pop, byButton('Verify'));
  if (!(await waitFor(pop, byButton('Lock'), 30_000))) throw new Error('sign-in failed');
  await closePopup(pop);

  step('captures');
  // 1. Popup on the site: logins for this site.
  await acme.send('Page.reload');
  await sleep(1200);
  pop = await openPopup();
  await waitFor(pop, `document.body.innerText.includes('On this site')`, 10_000);
  await sleep(600);
  await pop.shot(join(RAW, 'popup-vault.png'));
  // 4. Generator.
  await click(pop, byTab('Generator'));
  await sleep(700);
  await pop.shot(join(RAW, 'popup-generator.png'));
  // 5. Settings → server connection.
  await click(pop, byTab('Settings'));
  await sleep(900);
  // The privacy switches (suggestions / offer to save) sit below the server panel.
  await pop.eval(`(() => { const target = [...document.querySelectorAll('[role=switch]')].find((x) => (x.parentElement?.textContent ?? '').startsWith('Suggestions in login fields') || (x.nextElementSibling?.textContent ?? '').startsWith('Suggestions in login fields')); let el = target?.parentElement; while (el && getComputedStyle(el).overflowY !== 'auto') el = el.parentElement; if (el && target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 16; })()`);
  await sleep(500);
  settingsTop = await pop.eval<number>(`(() => { const t = [...document.querySelectorAll('[role=switch]')].find((x) => (x.parentElement?.textContent ?? '').startsWith('Suggestions in login fields')); return Math.round((t?.getBoundingClientRect().top ?? 0) - 18); })()`);
  await pop.shot(join(RAW, 'popup-settings.png'));
  await closePopup(pop);

  // 2. In-page suggestions on the login field.
  acme.close();
  acme = await openTab(`${ACME}/login`);
  await sleep(900);
  await click(acme, `document.querySelector('#username')`);
  await waitFor(acme, `document.querySelector('passvault-inline-menu')`, 8000);
  await sleep(700);
  await acme.shot(join(RAW, 'page-suggestions.png'), { x: 340, y: 0, width: 600, height: 520 });

  // 3. Offer to save after signing in somewhere new.
  const nw = await openTab(`${NORTHWIND}/login`);
  await sleep(900);
  await type(nw, `document.querySelector('#username')`, 'alex.rivera@example.com');
  await type(nw, `document.querySelector('#password')`, 'correct-horse-battery-staple');
  await click(nw, `document.querySelector('button[type=submit]')`);
  await waitFor(nw, `location.pathname === '/home' && document.querySelector('passvault-save-prompt')`, 10_000);
  await sleep(900);
  await nw.shot(join(RAW, 'page-save.png'), { x: 400, y: 0, width: 880, height: 470 });
} finally {
  proc.kill();
}

step('compose');
// ------------------------------------------------------------ compose the store images
const b64 = (f: string) => `data:image/png;base64,${readFileSync(join(RAW, f)).toString('base64')}`;
const icon = `data:image/png;base64,${readFileSync(join(SRC, 'icons/icon-128.png')).toString('base64')}`;
const BASE = `*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;color:#e8edf3;overflow:hidden}
.bg{position:absolute;inset:0;background:radial-gradient(1200px 600px at 85% 20%,rgba(43,195,174,.28),transparent 60%),radial-gradient(900px 500px at 0% 100%,rgba(79,109,245,.22),transparent 60%),#0b1117}
.brand{display:flex;align-items:center;gap:12px;font-weight:700;letter-spacing:-.01em}.brand img{border-radius:12px}
h1{font-size:46px;line-height:1.08;letter-spacing:-.02em;margin:0}p{color:#a6b0bd;margin:0}
.popup{border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08);display:block}
.pagecap{border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08);display:block}`;
const shots: Array<{ file: string; title: string; sub: string; img: string; kind: 'popup' | 'page' }> = [
  { file: 'screenshot-1', title: 'Your logins,\nright where you sign in', sub: 'Click a username or password field and pick the login saved for that site.', img: 'page-suggestions.png', kind: 'page' },
  { file: 'screenshot-2', title: 'Everything for\nthis site, one click', sub: 'Logins that match the page you are on, ready to fill or copy.', img: 'popup-vault.png', kind: 'popup' },
  { file: 'screenshot-3', title: 'Never lose a\nnew password', sub: 'After you sign in, PassVault offers to save or update the login — with a note.', img: 'page-save.png', kind: 'page' },
  { file: 'screenshot-4', title: 'Strong passwords\nin a second', sub: 'Random passwords and passphrases; the clipboard clears itself.', img: 'popup-generator.png', kind: 'popup' },
  { file: 'screenshot-5', title: 'Private by design', sub: 'End-to-end encrypted, two-factor sign-in, your own server. PassVault reads web pages only if you turn these on.', img: 'popup-settings.png', kind: 'popup' },
];
const pw = await chromium.launch();
try {
  const render = async (html: string, w: number, h: number, file: string) => {
    const pg = await pw.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await pg.setContent(html, { waitUntil: 'load' });
    await sleep(200);
    const png = join(work, `${file}.png`);
    await pg.screenshot({ path: png });
    await pg.close();
    // JPEG: the store wants no alpha channel.
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', png, '--out', join(OUT, `${file}.jpg`)], { stdio: 'ignore' });
  };
  for (const s of shots) {
    const visual =
      s.file === 'screenshot-5'
        ? `<div class="popup" style="width:${POPUP.width}px;height:300px;overflow:hidden;position:relative;background:#0b1117"><img src="${b64(s.img)}" style="display:block;width:${POPUP.width}px;margin-top:-${settingsTop}px"><div style="position:absolute;left:0;right:0;bottom:0;height:90px;background:linear-gradient(rgba(11,17,23,0),#0b1117)"></div></div>`
        : s.kind === 'popup'
        ? `<img class="popup" src="${b64(s.img)}" style="width:${POPUP.width}px;height:${POPUP.height}px">`
        : `<img class="pagecap" src="${b64(s.img)}" style="width:${s.file === 'screenshot-1' ? 600 : 700}px">`;
    await render(
      `<html><head><style>${BASE}</style></head><body><div class="bg"></div>
      <div style="position:absolute;inset:0;display:flex;align-items:center;gap:56px;padding:0 70px">
        <div style="flex:1;display:flex;flex-direction:column;gap:20px">
          <div class="brand" style="font-size:22px"><img src="${icon}" width="44" height="44">PassVault</div>
          <h1>${s.title.replace('\n', '<br>')}</h1>
          <p style="font-size:20px;line-height:1.45;max-width:420px">${s.sub}</p>
        </div>
        <div style="flex:none">${visual}</div>
      </div></body></html>`,
      1280,
      800,
      s.file,
    );
  }
  await render(
    `<html><head><style>${BASE}</style></head><body><div class="bg"></div>
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:14px;padding:0 34px">
      <div class="brand" style="font-size:30px"><img src="${icon}" width="58" height="58">PassVault</div>
      <p style="font-size:19px;line-height:1.35;color:#d3dae3">Your passwords, encrypted on your device.<br>Fill and save logins in one click.</p>
    </div></body></html>`,
    440,
    280,
    'promo-small',
  );
  await render(
    `<html><head><style>${BASE}</style></head><body><div class="bg"></div>
    <div style="position:absolute;inset:0;display:flex;align-items:center;gap:60px;padding:0 90px">
      <div style="flex:1;display:flex;flex-direction:column;gap:18px">
        <div class="brand" style="font-size:28px"><img src="${icon}" width="56" height="56">PassVault</div>
        <h1 style="font-size:52px">The password manager<br>that never sees your passwords</h1>
        <p style="font-size:21px">End-to-end encrypted · fill &amp; save in one click · your own server</p>
      </div>
      <div style="flex:none;transform:translateY(70px)"><img class="popup" src="${b64('popup-vault.png')}" style="width:340px;height:537px"></div>
    </div></body></html>`,
    1400,
    560,
    'promo-marquee',
  );
} finally {
  await pw.close();
}
copyFileSync(join(SRC, 'icons/icon-128.png'), join(OUT, 'icon-128.png'));
rmSync(work, { recursive: true, force: true });
console.log(`store assets written to ${OUT}`);
process.exit(0); // the demo https servers would keep the process alive
