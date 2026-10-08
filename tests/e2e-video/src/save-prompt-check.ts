/**
 * Real-browser check of the extension's "offer to save" flow with TRUSTED
 * input events (Playwright keyboard/mouse), which jsdom cannot produce.
 *
 * The built content script (apps/browser-extension/dist/save-prompt.js) runs
 * on a login page; chrome.runtime.sendMessage is bridged to the real
 * SavePromptManager from the background worker, backed by an unlocked fake
 * vault. Also writes a screenshot of the prompt.
 *
 *   pnpm --filter @passvault/browser-extension build
 *   pnpm --filter @passvault/e2e-video check:save-prompt
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { ItemPayload } from '@passvault/types';
import { SavePromptManager } from '../../../apps/browser-extension/src/background/save-prompt';
import type { ChromeLike } from '../../../apps/browser-extension/src/background/chrome-api';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(ROOT, 'apps/browser-extension/dist/save-prompt.js');
const OUT = join(ROOT, 'tests/e2e-video/.raw');
mkdirSync(OUT, { recursive: true });

function area() {
  const m = new Map<string, unknown>();
  const ks = (k: string | string[]) => (Array.isArray(k) ? k : [k]);
  return {
    get: async (k: string | string[]) => Object.fromEntries(ks(k).filter((x) => m.has(x)).map((x) => [x, m.get(x)])),
    set: async (o: Record<string, unknown>) => void Object.entries(o).forEach(([k, v]) => m.set(k, v)),
    remove: async (k: string | string[]) => void ks(k).forEach((x) => m.delete(x)),
  };
}

const saved: ItemPayload[] = [];
const chromeFake = {
  runtime: { id: 'pv-ext', getURL: (p: string) => `chrome-extension://pv-ext/${p}`, getManifest: () => ({ version: '0' }), sendMessage: async () => undefined },
  storage: { local: area(), session: area() },
  alarms: { create: () => undefined, clear: async () => true, get: async () => undefined },
  tabs: { get: async () => ({}), create: async () => undefined },
  scripting: { executeScript: async () => [] },
  permissions: { contains: async () => true },
} as unknown as ChromeLike;
await chromeFake.storage.local.set({ 'pv.autoSave.enabled': true });
const session = {
  isUnlocked: true,
  getSnapshot: () => ({ items: [] }),
  saveItem: async (p: ItemPayload) => {
    saved.push(p);
    return 'new-id';
  },
  updateItem: async () => undefined,
};
const manager = new SavePromptManager(chromeFake, session as never, ['http://localhost:5173']);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, colorScheme: 'light' });
await page.route('https://shop.example.com/**', (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><meta charset="utf-8"><title>Example Shop — Sign in</title>
      <body style="font-family:system-ui;background:#f4f6f8;display:grid;place-items:center;height:100vh;margin:0">
      <form id="f" onsubmit="event.preventDefault();document.getElementById('ok').hidden=false" style="background:#fff;padding:32px;border-radius:12px;width:320px;box-shadow:0 4px 20px #0001">
        <h2 style="margin-top:0">Example Shop</h2>
        <label>Email<br><input name="email" type="email" autocomplete="username" style="width:100%;padding:8px"></label><br><br>
        <label>Password<br><input name="password" type="password" autocomplete="current-password" style="width:100%;padding:8px"></label><br><br>
        <button type="submit" style="padding:8px 16px">Sign in</button>
        <p id="ok" hidden>Signed in ✓</p>
      </form></body>`,
  }),
);
const DEBUG = !!process.env.DEBUG;
page.on('console', (m) => DEBUG && console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.exposeFunction('__pvBridge', async (msg: { type?: string }) => {
  const r = await manager.handle(msg, { id: 'pv-ext', url: page.url(), origin: new URL(page.url()).origin, tab: { id: 1 }, frameId: 0 });
  if (DEBUG) console.log('[bridge]', msg.type, JSON.stringify(r));
  return r;
});
// Plain string (not a transpiled function) so no bundler helpers leak into the page.
await page.addInitScript(`window.chrome = { runtime: { lastError: undefined, sendMessage: (m, cb) => void window.__pvBridge(m).then(cb) } };`);
await page.goto('https://shop.example.com/login');
await page.addScriptTag({ path: SCRIPT });
await page.fill('input[name=email]', 'ann@example.com');
await page.fill('input[name=password]', 'Hunter2-secret!');
await page.click('button[type=submit]'); // trusted click → submit
await page.waitForSelector('passvault-save-prompt', { state: 'attached', timeout: 5000 });
await page.waitForTimeout(400);
const shot = join(OUT, 'save-prompt.png');
await page.screenshot({ path: shot });
// The prompt focuses its primary button; Enter produces a trusted click inside the closed shadow root.
await page.keyboard.press('Enter');
await page.waitForTimeout(500);

// Second sign-in: add a note with real keyboard input. Focus order inside the prompt:
// Save (focused) → Add note; opening the note focuses it, Tab returns to Save.
await page.goto('https://shop.example.com/login');
await page.addScriptTag({ path: SCRIPT });
await page.fill('input[name=email]', 'bob@example.com');
await page.fill('input[name=password]', 'Second-secret-42');
await page.click('button[type=submit]');
await page.waitForSelector('passvault-save-prompt', { state: 'attached', timeout: 5000 });
await page.waitForTimeout(400);
await page.keyboard.press('Tab');
await page.keyboard.press('Enter'); // "Add note"
await page.keyboard.type('Team account — ask Ann before rotating', { delay: 10 });
const noteShot = join(OUT, 'save-prompt-note.png');
await page.screenshot({ path: noteShot });
await page.keyboard.press('Tab');
await page.keyboard.press('Enter'); // Save
await page.waitForTimeout(500);
await browser.close();

const item = saved[0];
const ok = item?.type === 'login' && item.fields.username === 'ann@example.com' && item.fields.password === 'Hunter2-secret!' && item.fields.urls[0]?.url === 'https://shop.example.com';
console.log(ok ? '✓ trusted submit → prompt → Save stored the login for https://shop.example.com' : `✗ unexpected result: ${JSON.stringify(saved)}`);
const withNote = saved[1];
const okNote = withNote?.type === 'login' && withNote.fields.username === 'bob@example.com' && withNote.notes === 'Team account — ask Ann before rotating';
console.log(okNote ? '✓ trusted typing → Add note → Save stored the note with the login' : `✗ note not saved: ${JSON.stringify(withNote ?? null)}`);
console.log(`screenshots: ${shot}, ${noteShot}`);
process.exit(ok && okNote ? 0 : 1);
