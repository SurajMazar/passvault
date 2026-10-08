/**
 * Full-feature PassVault tour with Kokoro voice-over.
 *
 * Playwright drives the real web dashboard, the extension's save-prompt
 * content script, and the desktop app UI (Neutralino bundle + Go helper in
 * window-less mode) against a real API; a second user (Bob) runs headlessly.
 * Each chapter is held for at least the length of its narration, and the
 * chapter start times are used by ffmpeg to place the narration exactly.
 *
 * See docs/E2E_VIDEO.md for the stack this expects.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { TOTP } from 'otpauth';
import { newItem } from '@passvault/vault-core';
import type { ItemPayload } from '@passvault/types';
import { SavePromptManager } from '../../../../apps/browser-extension/src/background/save-prompt';
import type { ChromeLike } from '../../../../apps/browser-extension/src/background/chrome-api';
import { CHAPTERS } from './narration';
import { OUT_DIR, RAW_DIR, ROOT, TTS_DIR } from './paths';
import { caption, headlessSession, mailCode, sleep, titleCard, type } from './lib';

const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const API = process.env.API_URL ?? 'http://localhost:3000';
const DESKTOP = process.env.DESKTOP_URL ?? 'http://localhost:47391';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const DEMO_KEY = process.env.DEMO_KEY ?? join(RAW_DIR, 'demo_key');
const RUN = Date.now().toString(36);
const ALICE = { name: 'Alice Rivera', email: `alice.${RUN}@example.com`, password: 'marble-orchid-tundra-signal-84', newPassword: 'cobalt-meadow-violin-prism-61' };
const BOB = { name: 'Bob Chen', email: `bob.${RUN}@example.com`, password: 'copper-lantern-violet-quill-27' };
const W = 1440;
const H = 900;
const VIDEO_DIR = join(RAW_DIR, 'tour-video');

const durations = JSON.parse(readFileSync(join(TTS_DIR, 'durations.json'), 'utf8')) as Record<string, { seconds: number }>;
const timeline: Array<{ id: string; offsetMs: number }> = [];
let videoStart = 0;

let page!: Page;
const nav = (name: RegExp | string) => page.getByRole('complementary', { name: 'Main navigation' }).getByRole('button', { name });
const settingsNav = (name: string) => page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true });
const dlg = () => page.getByRole('dialog').last();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function chapter(id: string, fn: () => Promise<void>, opts: { caption?: boolean } = {}) {
  const c = CHAPTERS.find((x) => x.id === id);
  if (!c) throw new Error(`no narration for ${id}`);
  const start = Date.now();
  timeline.push({ id, offsetMs: start - videoStart });
  console.log(`  ${((start - videoStart) / 1000).toFixed(1).padStart(6)}s  ${id}`);
  if (opts.caption !== false) await caption(page, c.title, c.sub ?? '').catch(() => undefined);
  try {
    await fn();
  } catch (e) {
    await page.screenshot({ path: join(RAW_DIR, `fail-${id}.png`) }).catch(() => undefined);
    throw e;
  }
  if (opts.caption !== false) await caption(page, c.title, c.sub ?? '').catch(() => undefined);
  const hold = (durations[id]?.seconds ?? 5) * 1000 + 700 - (Date.now() - start);
  if (hold > 0) await sleep(hold);
}

const totps = new Map<string, TOTP>();
const lastStep = new Map<string, number>();
async function freshCode(email: string): Promise<string> {
  const t = totps.get(email)!;
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    if (lastStep.get(email) !== step) {
      lastStep.set(email, step);
      return t.generate();
    }
    await sleep(500);
  }
}

async function newVaultItem(menuLabel: string) {
  await page.getByRole('button', { name: 'New item' }).click();
  await page.getByRole('menuitem', { name: menuLabel, exact: true }).click();
  await dlg().waitFor();
}
async function create(title: string) {
  await dlg().getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
}
async function openItem(navName: RegExp, title: string) {
  await nav(navName).click();
  await page.getByRole('option', { name: new RegExp(esc(title)) }).first().click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
}
async function moreAction(label: string) {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: label }).click();
}
async function syncNow() {
  await page.getByRole('button', { name: /Sync now/ }).click();
  await sleep(1500);
}
async function openProject(name: string) {
  await nav(/^Projects/).click();
  await sleep(300);
  if (await page.getByRole('button', { name: 'All projects' }).isVisible()) await page.getByRole('button', { name: 'All projects' }).click();
  await page.getByRole('button', { name: new RegExp(esc(name)) }).first().click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
}

// ---------------------------------------------------------------- main

async function main() {
  rmSync(VIDEO_DIR, { recursive: true, force: true });
  mkdirSync(VIDEO_DIR, { recursive: true });
  for (const u of [API, WEB, DESKTOP]) if (!(await fetch(u.includes('3000') ? `${u}/api/v1/health` : u)).ok) throw new Error(`${u} is not up`);

  console.log('Preparing Bob (headless)…');
  const bob = headlessSession(API, WEB);
  await bob.init();
  {
    const t = Date.now();
    await bob.startRegistration(BOB.email);
    const token = await bob.verifyRegistration(BOB.email, await mailCode(MAILPIT, BOB.email, t));
    await bob.register(token, BOB.email, BOB.name, BOB.password);
    await bob.login(BOB.email, BOB.password);
    const { secret } = await bob.startMfaEnrollment();
    await bob.confirmMfaEnrollment(new TOTP({ secret }).generate());
    bob.acknowledgeRecoveryCodes();
    await bob.syncNow();
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    recordVideo: { dir: VIDEO_DIR, size: { width: W, height: H } },
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: false,
  });
  context.setDefaultTimeout(30_000);
  page = await context.newPage();
  videoStart = Date.now();

  // extension demo bridge (only active on shop.example.com)
  const saved: ItemPayload[] = [];
  const area = () => {
    const m = new Map<string, unknown>();
    const ks = (k: string | string[]) => (Array.isArray(k) ? k : [k]);
    return { get: async (k: string | string[]) => Object.fromEntries(ks(k).filter((x) => m.has(x)).map((x) => [x, m.get(x)])), set: async (o: Record<string, unknown>) => void Object.entries(o).forEach(([k, v]) => m.set(k, v)), remove: async (k: string | string[]) => void ks(k).forEach((x) => m.delete(x)) };
  };
  const fakeChrome = { runtime: { id: 'pv', getURL: (p: string) => p, getManifest: () => ({ version: '0' }), sendMessage: async () => undefined }, storage: { local: area(), session: area() }, alarms: { create: () => undefined, clear: async () => true, get: async () => undefined }, tabs: { get: async () => ({}), create: async () => undefined }, scripting: { executeScript: async () => [] }, permissions: { contains: async () => true } } as unknown as ChromeLike;
  await fakeChrome.storage.local.set({ 'pv.autoSave.enabled': true });
  const savePrompt = new SavePromptManager(fakeChrome, { isUnlocked: true, getSnapshot: () => ({ items: [] }), saveItem: async (p: ItemPayload) => (saved.push(p), 'id'), updateItem: async () => undefined } as never, [WEB]);
  await page.exposeFunction('__pvBridge', (msg: unknown) => savePrompt.handle(msg, { id: 'pv', url: page.url(), origin: new URL(page.url()).origin, tab: { id: 1 }, frameId: 0 }));
  await page.addInitScript(`if (location.host === 'shop.example.com') window.chrome = { runtime: { lastError: undefined, sendMessage: (m, cb) => void window.__pvBridge(m).then(cb) } };`);
  await page.route('https://shop.example.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><meta charset="utf-8"><title>Example Shop — Sign in</title><body style="font-family:system-ui;background:#eef1f4;display:grid;place-items:center;height:100vh;margin:0">
      <form onsubmit="event.preventDefault();document.getElementById('ok').hidden=false" style="background:#fff;padding:36px;border-radius:14px;width:360px;box-shadow:0 8px 30px #0002;color:#111">
        <h2 style="margin-top:0">Example Shop</h2><p style="color:#555;margin-top:-6px">Sign in to your account</p>
        <label>Email<br><input name="email" type="email" autocomplete="username" style="width:100%;padding:10px;margin-top:4px;box-sizing:border-box"></label><br><br>
        <label>Password<br><input name="password" type="password" autocomplete="current-password" style="width:100%;padding:10px;margin-top:4px;box-sizing:border-box"></label><br><br>
        <button type="submit" style="padding:10px 18px;background:#111;color:#fff;border:0;border-radius:8px">Sign in</button>
        <p id="ok" hidden>✓ Signed in</p></form></body>`,
    }),
  );

  // ================================================================ intro
  await chapter('intro', async () => {
    await titleCard(page, 'PassVault', 'Passwords and developer secrets — end-to-end encrypted<br>Web dashboard · Browser extension · macOS app');
  }, { caption: false });

  // ================================================================ account
  await page.goto(WEB);
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await chapter('register-email', async () => {
    await page.getByRole('button', { name: 'Create an account' }).click();
    await type(page.getByLabel('Email', { exact: true }), ALICE.email);
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Send verification code' }).click();
    const code = await mailCode(MAILPIT, ALICE.email, t0);
    await type(page.getByLabel('Verification code', { exact: true }), code, 110);
    await page.getByRole('button', { name: 'Verify email' }).click();
    await page.getByLabel('Your name', { exact: true }).waitFor();
  });
  await chapter('register-password', async () => {
    await type(page.getByLabel('Your name', { exact: true }), ALICE.name);
    await type(page.getByLabel('Master password', { exact: true }), ALICE.password, 30);
    await page.getByRole('button', { name: 'What is a master password?' }).click();
    await sleep(1500);
    await type(page.getByLabel('Confirm master password', { exact: true }), ALICE.password, 12);
  });
  let recoveryKey = '';
  await chapter('recovery-key', async () => {
    await page.getByRole('button', { name: 'Create account' }).click();
    const box = page.getByLabel('Recovery key', { exact: true });
    await box.waitFor();
    recoveryKey = (await box.textContent())!.trim();
    await sleep(2500);
    await type(page.getByLabel('Type the last group of the key to confirm you saved it', { exact: true }), recoveryKey.split('-').pop()!, 90);
    await page.getByLabel('I stored the recovery key somewhere safe, offline', { exact: true }).check();
  });
  await chapter('mfa', async () => {
    await page.getByRole('button', { name: 'Continue to two-step setup' }).click();
    await page.getByRole('heading', { name: 'Set up two-step verification' }).waitFor();
    await sleep(2500);
    await page.getByRole('button', { name: "Can't scan? Show setup key" }).click();
    const secret = (await page.locator('.select-all').first().textContent())!.trim();
    totps.set(ALICE.email, new TOTP({ secret }));
    await type(page.getByLabel('6-digit code', { exact: true }), await freshCode(ALICE.email), 100);
    await page.getByRole('button', { name: 'Verify and continue' }).click();
    await page.getByRole('heading', { name: 'Save your two-step recovery codes' }).waitFor();
  });
  await chapter('recovery-codes', async () => {
    await sleep(3500);
    await page.getByLabel('I saved these codes somewhere safe', { exact: true }).check();
    await page.getByRole('button', { name: 'Open my vault' }).click();
    await page.getByRole('button', { name: 'Add demo data' }).waitFor();
  });

  // ================================================================ vault basics
  await chapter('overview', async () => {
    await page.getByRole('button', { name: 'Add demo data' }).click();
    await page.getByText('Storefront .env (production)').first().waitFor();
    await syncNow();
  });
  await chapter('login-item', async () => {
    await openItem(/^Logins/, 'Example Admin');
    await sleep(1200);
    await page.getByRole('button', { name: 'Reveal' }).first().click();
    await sleep(2200);
    await page.getByRole('button', { name: /^Copy password/ }).first().click();
  });
  await chapter('create-login', async () => {
    await newVaultItem('Login');
    await type(dlg().getByLabel('Title', { exact: true }), 'GitHub (work)');
    await type(dlg().getByLabel('Username or email', { exact: true }), 'alice@example.com');
    await dlg().getByRole('button', { name: 'Generate password' }).click();
    await sleep(1200);
    await dlg().getByRole('button', { name: 'Add website' }).click();
    await type(dlg().getByLabel('Website 1', { exact: true }), 'https://github.com');
    await type(dlg().getByLabel('Tags', { exact: true }), 'work, code');
    await sleep(800);
    await create('GitHub (work)');
  });
  await chapter('ssh-server', async () => {
    await newVaultItem('Server');
    await type(dlg().getByLabel('Title', { exact: true }), 'Dev server', 15);
    await type(dlg().getByLabel('Hostname or IP', { exact: true }), '127.0.0.1', 15);
    await dlg().getByLabel('Port', { exact: true }).fill('2222');
    await type(dlg().getByLabel('Username', { exact: true }), 'dev', 15);
    await dlg().getByLabel('Authentication', { exact: true }).selectOption('password');
    await type(dlg().getByLabel('Password (optional)', { exact: true }), 'dev-password', 15);
    await dlg().getByLabel('Environment', { exact: true }).fill('Production');
    await create('Dev server');
    // second server for the interactive-prompt demo
    await newVaultItem('Server');
    await dlg().getByLabel('Title', { exact: true }).fill('OTP server');
    await dlg().getByLabel('Hostname or IP', { exact: true }).fill('127.0.0.1');
    await dlg().getByLabel('Port', { exact: true }).fill('2222');
    await dlg().getByLabel('Username', { exact: true }).fill('kbd');
    await dlg().getByLabel('Authentication', { exact: true }).selectOption('keyboard_interactive');
    await dlg().getByLabel('Password (optional)', { exact: true }).fill('dev-password');
    await create('OTP server');
  });
  await chapter('ssh-key', async () => {
    await newVaultItem('SSH key');
    await dlg().getByLabel('Title', { exact: true }).fill('Deploy key');
    await dlg().getByLabel('Private key', { exact: true }).fill(readFileSync(DEMO_KEY, 'utf8'));
    await dlg().getByLabel('Public key', { exact: true }).fill(readFileSync(`${DEMO_KEY}.pub`, 'utf8').trim());
    await dlg().getByLabel('Title', { exact: true }).click(); // blur → fingerprint computed locally
    await sleep(1500);
    await create('Deploy key');
  });
  await chapter('database', async () => {
    await newVaultItem('Database');
    await type(dlg().getByLabel('Title', { exact: true }), 'Orders DB (staging)', 15);
    await type(dlg().getByLabel('Host', { exact: true }), 'db.staging.example.net', 12);
    await type(dlg().getByLabel('Database', { exact: true }), 'orders', 15);
    await type(dlg().getByLabel('Username', { exact: true }), 'orders_app', 15);
    await dlg().getByRole('button', { name: 'Generate password' }).click();
    await dlg().getByLabel('Environment', { exact: true }).fill('Staging');
    await sleep(600);
    await create('Orders DB (staging)');
  });
  await chapter('api-credential', async () => {
    await newVaultItem('API credential');
    await type(dlg().getByLabel('Title', { exact: true }), 'Stripe test key', 15);
    await type(dlg().getByLabel('Service', { exact: true }), 'Stripe', 15);
    await dlg().getByLabel('Token', { exact: true }).fill('sk_test_51DUMMYdummyDUMMYdummyDUMMY0000');
    await dlg().getByLabel('Expires (optional)', { exact: true }).fill('2026-12-31');
    await dlg().getByRole('button', { name: 'Add field' }).click();
    await dlg().getByLabel('Field label', { exact: true }).fill('Webhook secret');
    await dlg().getByLabel('Field type', { exact: true }).selectOption('secret');
    await dlg().locator('input[type=password]').last().fill('whsec_dummy_0123456789');
    await sleep(600);
    await create('Stripe test key');
  });
  await chapter('secure-note', async () => {
    await newVaultItem('Secure note');
    await dlg().getByLabel('Title', { exact: true }).fill('Break-glass procedure');
    await type(dlg().getByLabel('Note', { exact: true }), "1. Page the on-call\n2. <script>alert('this stays text')</script>", 10);
    await create('Break-glass procedure');
    await page.getByRole('button', { name: 'Reveal' }).first().click();
  });

  // ================================================================ organising
  await chapter('search', async () => {
    const search = page.getByLabel('Search vault', { exact: true });
    await type(search, 'orders', 80);
    await sleep(1800);
    await search.fill('');
    await type(search, 'STRIPE_KEY', 60);
    await sleep(1800);
    await search.fill('');
    await nav(/^All items/).click();
    await page.getByLabel('Filter by environment', { exact: true }).selectOption('Production');
    await sleep(1800);
    await page.getByLabel('Filter by environment', { exact: true }).selectOption('');
    await page.getByRole('button', { name: /^Sorted by/ }).click();
    await sleep(1200);
    await page.getByRole('button', { name: /^Sorted by/ }).click();
  });
  await chapter('palette', async () => {
    await page.keyboard.press('Meta+k');
    await sleep(500);
    await page.keyboard.type('bastion', { delay: 90 });
    await sleep(600);
    await page.keyboard.press('Backspace', { delay: 0 });
    for (let i = 0; i < 7; i++) await page.keyboard.press('Backspace');
    await page.keyboard.type('dev server', { delay: 80 });
    await sleep(900);
    await page.keyboard.press('Enter');
  });
  await chapter('favorites', async () => {
    await openItem(/^Logins/, 'Example Admin');
    await page.getByRole('button', { name: 'Add to favorites' }).click();
    await nav(/^Favorites/).click();
    await sleep(1500);
    await openItem(/^Secure notes/, 'Incident runbook');
    await moreAction('Archive');
    await nav(/^Archive/).click();
    await sleep(1200);
    await openItem(/^Logins/, 'Reused password demo');
    await moreAction('Move to trash');
    await nav(/^Trash/).click();
    await page.getByRole('option', { name: /Reused password demo/ }).click();
    await sleep(800);
    await moreAction('Delete permanently…');
    await sleep(1200);
    await dlg().getByRole('button', { name: 'Delete permanently' }).click();
  });
  await chapter('bulk', async () => {
    await nav(/^All items/).click();
    await page.getByLabel('Select GitHub (work)', { exact: true }).check();
    await page.getByLabel('Select Stripe test key', { exact: true }).check();
    await type(page.getByLabel('Add tag to selected', { exact: true }), 'q4-audit', 60);
    await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  });
  await chapter('projects', async () => {
    await nav(/^Projects/).click();
    if (await page.getByRole('button', { name: 'All projects' }).isVisible()) await page.getByRole('button', { name: 'All projects' }).click();
    await page.getByRole('button', { name: 'New project' }).click();
    await type(dlg().getByLabel('Name', { exact: true }), 'Payments API', 25);
    await type(dlg().getByLabel('New environment', { exact: true }), 'QA', 60);
    await dlg().getByRole('button', { name: 'Add', exact: true }).click();
    await sleep(700);
    await dlg().getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('heading', { name: 'Payments API' }).waitFor();
    await sleep(1500);
    await openProject('Acme Storefront');
  });
  await chapter('env-compare', async () => {
    await page.getByRole('button', { name: 'Compare environments' }).click();
    await sleep(1800);
    await dlg().getByRole('button', { name: /^Reveal STRIPE_KEY/ }).click();
    await sleep(2500);
    await page.keyboard.press('Escape');
  });
  await chapter('env-edit', async () => {
    await openItem(/^Environment files/, 'Storefront .env (development)');
    await page.getByRole('button', { name: 'Edit FEATURE_FLAGS' }).click();
    const v = page.locator('div.grid:has(input[aria-label="Variable name"]) input').nth(1);
    await v.fill('');
    await v.pressSequentially('checkout,search,wishlist', { delay: 35 });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await sleep(1000);
    await page.getByRole('button', { name: 'Add variable' }).click();
    await type(page.getByLabel('Variable name', { exact: true }), 'CACHE_TTL', 40);
    await page.getByPlaceholder('value').fill('300');
    await type(page.getByLabel('Note (stored outside the file)', { exact: true }), 'Seconds; keep under 600', 20);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
  });
  await chapter('env-raw', async () => {
    await page.getByRole('tab', { name: 'Raw file' }).click();
    await sleep(3000);
    await page.getByRole('tab', { name: 'Variables' }).click();
    await openItem(/^Environment files/, 'Storefront .env (production)');
    await page.getByRole('button', { name: 'Download' }).click();
    await sleep(1200);
    await type(dlg().getByRole('textbox'), 'EXPORT', 120);
    await sleep(1500);
    await dlg().getByRole('button', { name: 'Cancel' }).click();
  });
  await chapter('history', async () => {
    await openItem(/^Environment files/, 'Storefront .env (development)');
    await moreAction('Version history');
    await sleep(1200);
    await dlg().getByRole('button', { name: 'Compare' }).first().click();
    await sleep(3000);
    await page.keyboard.press('Escape');
  });
  await chapter('generator', async () => {
    await page.getByRole('button', { name: 'Password generator' }).click();
    await sleep(1500);
    await dlg().getByRole('tab', { name: 'Passphrase' }).click();
    await sleep(1200);
    await dlg().getByRole('button', { name: 'Regenerate' }).click();
    await sleep(1500);
    await page.keyboard.press('Escape');
  });

  // ================================================================ teams
  let sharedVaultId = '';
  await chapter('share', async () => {
    await openProject('Acme Storefront');
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await type(dlg().getByLabel('Recipient email', { exact: true }), BOB.email, 15);
    await dlg().getByRole('button', { name: 'Find' }).click();
    await dlg().getByLabel('I compared this fingerprint with the recipient', { exact: true }).check();
    await dlg().getByLabel('Access', { exact: true }).selectOption('editor');
    await sleep(800);
  });
  await chapter('share-confirm', async () => {
    await dlg().getByRole('button', { name: 'Send invitation' }).click();
    await sleep(800);
    await type(dlg().getByRole('textbox'), 'SHARE', 120);
    await dlg().getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByText(/Invitation sent/).waitFor();
  });
  await chapter('collaborate', async () => {
    const [inv] = await bob.invitations();
    sharedVaultId = inv!.vaultId;
    await bob.acceptInvitation(inv!, true);
    const db = bob.getSnapshot().items.find((i) => i.payload.title === 'Orders DB (production)')!;
    await bob.updateItem(db.id, (p) => void (p.notes = 'Password rotated after incident drill — Bob'));
    await bob.syncNow();
    await syncNow();
    await openItem(/^Databases/, 'Orders DB (production)');
  });
  await chapter('conflict', async () => {
    await context.setOffline(true);
    await sleep(800);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await dlg().getByLabel('Private notes', { exact: true }).fill('Alice: rotate again during the maintenance window');
    await dlg().getByRole('button', { name: 'Save changes' }).click();
    await sleep(1200);
    const db = bob.getSnapshot().items.find((i) => i.payload.title === 'Orders DB (production)')!;
    await bob.updateItem(db.id, (p) => void (p.notes = 'Bob: rotation finished, nothing pending'));
    await bob.syncNow();
    await context.setOffline(false);
    await sleep(1500);
    await syncNow();
    await page.getByRole('button', { name: 'Resolve…' }).click();
    await sleep(2500);
    await dlg().getByRole('button', { name: 'Keep mine' }).click();
  });
  await chapter('invitation', async () => {
    const bobId = await bob.saveItem(newItem('login', { title: 'Grafana (team)', fields: { username: 'team@example.com', password: 'Dummy-Grafana-Pass-1', urls: [{ url: 'https://grafana.example.com', match: 'host' }] } }));
    await bob.syncNow();
    const alice = await bob.lookupRecipient(ALICE.email);
    await bob.share({ target: { kind: 'items', itemIds: [bobId] }, recipients: [{ recipient: { ...alice, verified: true }, role: 'viewer', expiresAt: null }], allowResharing: false });
    await syncNow();
    await nav(/^Shared with me/).click();
    await page.getByLabel('Fingerprint verified with sender', { exact: true }).check();
    await sleep(1500);
    await page.getByRole('button', { name: 'Accept' }).click();
    await page.getByRole('option', { name: /Grafana \(team\)/ }).waitFor();
  });
  await chapter('revoke', async () => {
    await openProject('Acme Storefront');
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    await sleep(1200);
    await dlg().getByRole('button', { name: `Remove ${BOB.email}` }).click();
    await sleep(1500);
    await dlg().getByRole('button', { name: 'Remove and rotate key' }).click();
    await page.getByText('Rotate the underlying secrets').waitFor();
    await sleep(2000);
    await page.keyboard.press('Escape');
    void sharedVaultId;
  });

  // ================================================================ settings
  await chapter('settings-security', async () => {
    await nav(/Security & settings/).click();
    await sleep(800);
    await page.mouse.wheel(0, 500);
  });
  await chapter('settings-account', async () => {
    await settingsNav('Account').click();
    await sleep(2500);
    await page.mouse.wheel(0, 600);
  });
  await chapter('settings-sessions', async () => {
    await settingsNav('Sessions & devices').click();
  });
  await chapter('settings-sharing', async () => {
    await settingsNav('Sharing').click();
  });
  await chapter('settings-prefs', async () => {
    await settingsNav('Preferences').click();
    await page.getByLabel('Lock after inactivity', { exact: true }).selectOption('5');
    await sleep(1500);
    await page.getByLabel('Theme', { exact: true }).selectOption('light');
    await sleep(2500);
    await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  });
  await chapter('settings-activity', async () => {
    await settingsNav('Sync').click();
    await sleep(3500);
    await settingsNav('Activity').click();
  });
  await chapter('settings-export', async () => {
    await settingsNav('Export & privacy').click();
    await sleep(1500);
    await page.getByRole('button', { name: 'Export…' }).click();
    await type(dlg().getByRole('textbox'), 'EXPORT', 110);
    await sleep(1200);
    await dlg().getByRole('button', { name: 'Cancel' }).click();
    await page.mouse.wheel(0, 600);
  });
  await chapter('lock', async () => {
    await page.getByRole('button', { name: 'Lock vault (⇧⌘L)' }).first().click();
    await page.getByRole('heading', { name: 'Vault locked' }).waitFor();
    await sleep(1500);
    await type(page.getByLabel('Master password', { exact: true }), ALICE.password, 18);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await page.getByRole('complementary', { name: 'Main navigation' }).waitFor();
  });

  // ================================================================ extension
  await chapter('extension', async () => {
    await page.goto('https://shop.example.com/login');
    await page.addScriptTag({ path: join(ROOT, 'apps/browser-extension/dist/save-prompt.js') });
    await caption(page, 'Browser extension: offer to save', 'Opt-in · isolated from the page · nothing saved without your click');
    await type(page.locator('input[name=email]'), 'alice@example.com', 40);
    await type(page.locator('input[name=password]'), 'Shop-Pass-2026!', 40);
    await page.click('button[type=submit]');
    await page.waitForSelector('passvault-save-prompt', { state: 'attached' });
    await sleep(4500);
    await page.keyboard.press('Enter');
    await sleep(2000);
    if (!saved.length) throw new Error('save prompt did not save');
  });

  // ================================================================ desktop
  await page.goto(DESKTOP);
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await chapter('desktop-server', async () => {
    await sleep(1200);
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    await sleep(2200);
    await page.getByRole('radio', { name: /Local development/ }).click();
    await sleep(1200);
    await page.getByRole('button', { name: 'Use this server' }).click();
    await page.getByText('localhost:3000').first().waitFor();
  });
  await chapter('desktop-signin', async () => {
    await type(page.getByLabel('Email', { exact: true }), ALICE.email, 15);
    await type(page.getByLabel('Master password', { exact: true }), ALICE.password, 12);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await type(page.getByLabel('Authentication code', { exact: true }), await freshCode(ALICE.email), 80);
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await nav(/^Terminal/).waitFor();
  });
  await chapter('desktop-ssh', async () => {
    await openItem(/^SSH & servers/, 'Dev server');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('heading', { name: 'Verify the server’s identity' }).waitFor();
    await sleep(5000);
    await dlg().getByRole('button', { name: 'Trust and connect' }).click();
    await page.getByText('Connected').first().waitFor();
  });
  await chapter('desktop-terminal', async () => {
    const term = page.locator('.xterm').first();
    await term.click();
    for (const cmd of ['whoami', 'link']) {
      await page.keyboard.type(cmd, { delay: 90 });
      await page.keyboard.press('Enter');
      await sleep(900);
    }
    // click the plain link in the terminal output → confirmation dialog
    const box = await page.evaluate(() => {
      for (const row of Array.from(document.querySelectorAll('.xterm-rows > div'))) {
        const node = Array.from(row.childNodes).find((n) => n.textContent?.includes('https://example.com/docs'));
        if (!node) continue;
        const text = row.textContent ?? '';
        const idx = text.indexOf('https://example.com/docs');
        const r = row.getBoundingClientRect();
        const cw = r.width / Math.max(1, (document.querySelector('.xterm') as HTMLElement).offsetWidth / 9);
        void cw;
        const range = document.createRange();
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        let pos = 0;
        let t: Node | null;
        while ((t = walker.nextNode())) {
          const len = t.textContent!.length;
          if (pos + len > idx + 5) {
            range.setStart(t, Math.max(0, idx + 5 - pos));
            range.setEnd(t, Math.max(0, idx + 6 - pos));
            const b = range.getBoundingClientRect();
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          }
          pos += len;
        }
      }
      return null;
    });
    if (box) {
      await page.mouse.move(box.x, box.y);
      await sleep(400);
      await page.mouse.click(box.x, box.y);
      const confirmLink = page.getByRole('button', { name: 'Open link' });
      if (await confirmLink.isVisible({ timeout: 2500 }).catch(() => false)) {
        await sleep(1800);
        await dlg().getByRole('button', { name: 'Cancel' }).click();
      }
    }
    await page.evaluate(() => navigator.clipboard.writeText('sudo systemctl restart api\nrm -rf /tmp/cache'));
    await term.click();
    await page.keyboard.press('Meta+v');
    const pasteBtn = page.getByRole('button', { name: 'Paste', exact: true });
    if (await pasteBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await sleep(2200);
      await dlg().getByRole('button', { name: 'Cancel' }).click();
    }
  });
  await chapter('desktop-kbd', async () => {
    await openItem(/^SSH & servers/, 'OTP server');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('heading', { name: 'Verify the server’s identity' }).waitFor();
    await dlg().getByRole('button', { name: 'Trust and connect' }).click();
    await page.getByRole('button', { name: 'Fill stored password' }).first().waitFor();
    await sleep(1500);
    await page.getByRole('button', { name: 'Fill stored password' }).first().click();
    await dlg().getByRole('button', { name: 'Submit' }).click();
    await sleep(1500);
    await type(dlg().locator('input').first(), '123456', 140);
    await dlg().getByRole('button', { name: 'Submit' }).click();
    await sleep(1500);
  });
  await chapter('desktop-keys', async () => {
    await nav(/^SSH keys/).click();
    await newVaultItem('SSH key');
    await dlg().getByRole('button', { name: 'Generate' }).click();
    await sleep(1500);
    await dlg().getByLabel('Title', { exact: true }).fill('Desktop deploy key');
    await create('Desktop deploy key');
    const pub = (await page.locator('article').getByText(/^ssh-ed25519 /).first().textContent())!.trim();
    await nav(/Security & settings/).click();
    await settingsNav('SSH agent').click();
    const start = page.getByRole('button', { name: 'Start agent' });
    if (await start.isVisible().catch(() => false)) await start.click();
    await page.getByRole('button', { name: 'Stop agent' }).waitFor();
    await sleep(800);
    const sock = /SSH_AUTH_SOCK='([^']+)'/.exec(await page.content())?.[1];
    const row = page.getByText('Desktop deploy key', { exact: true }).locator('xpath=ancestor::*[.//button[normalize-space()="Add to agent"]][1]');
    await row.getByRole('button', { name: 'Add to agent' }).click();
    await sleep(1500);
    // A real signature request through the agent socket → approval dialog.
    const pubFile = join(RAW_DIR, 'desktop_key.pub');
    writeFileSync(pubFile, `${pub}\n`);
    if (sock) {
      const child = spawn('/usr/bin/ssh-add', ['-T', pubFile], { env: { ...process.env, SSH_AUTH_SOCK: sock }, stdio: 'ignore' });
      await page.getByRole('button', { name: 'Allow once' }).waitFor({ timeout: 15_000 });
      await sleep(3500);
      await page.getByRole('button', { name: 'Allow once' }).click();
      await new Promise((r) => child.on('exit', r));
    }
  });
  await chapter('desktop-lock', async () => {
    await page.getByRole('button', { name: 'Lock vault (⇧⌘L)' }).first().click();
    await page.getByRole('heading', { name: 'Vault locked' }).waitFor();
    await type(page.getByLabel('Master password', { exact: true }), ALICE.password, 8);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await nav(/^Terminal/).click();
    await page.getByText('Disconnected because the vault locked').filter({ visible: true }).first().waitFor();
  });
  // Sign out of the desktop app so its Keychain session item is removed.
  await page.getByRole('button', { name: 'Lock vault (⇧⌘L)' }).first().click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await dlg().getByRole('button', { name: 'Sign out' }).click();
  await sleep(800);

  // ================================================================ recovery + outro
  await chapter('recovery', async () => {
    // Forgot the master password: sign out of the locked web session first.
    await page.goto(WEB);
    const signOut = page.getByRole('button', { name: 'Sign out' });
    if (await signOut.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
      await signOut.click();
      const confirm = dlg().getByRole('button', { name: 'Sign out' });
      if (await confirm.waitFor({ timeout: 2000 }).then(() => true, () => false)) await confirm.click();
      await sleep(800);
    }
    const t = Date.now();
    await fetch(`${API}/api/v1/recovery/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: ALICE.email }) });
    const token = await mailCode(MAILPIT, ALICE.email, t, /recover#token=([A-Za-z0-9_-]+)/);
    await page.goto(`${WEB}/recover#token=${token}`);
    await caption(page, 'Account recovery', 'Email link + authenticator + recovery key');
    await type(page.getByLabel('Authenticator code', { exact: true }), await freshCode(ALICE.email), 90);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'I have my vault recovery key' }).click();
    await page.getByLabel('Vault recovery key', { exact: true }).fill(recoveryKey);
    await type(page.getByLabel('New master password', { exact: true }), ALICE.newPassword, 12);
    await type(page.getByLabel('Confirm new master password', { exact: true }), ALICE.newPassword, 8);
    await page.getByRole('button', { name: 'Recover vault' }).click();
    await page.getByText(/Save your new recovery key/).waitFor();
  });
  await chapter('outro', async () => {
    await titleCard(page, 'PassVault', 'End-to-end encrypted logins and developer secrets<br>Web · Browser extension · macOS — github.com/SurajMazar/passvault');
  }, { caption: false });

  const raw = await page.video()!.path();
  await context.close();
  await browser.close();
  await bob.logout().catch(() => undefined);
  writeFileSync(join(RAW_DIR, 'tour-timeline.json'), JSON.stringify({ timeline, durations }, null, 2));
  console.log(`recorded ${raw}`);

  // ---------------------------------------------------------------- mux narration
  const wavs = timeline.map((t) => ({ ...t, wav: join(TTS_DIR, `${t.id}.wav`) }));
  const inputs = ['-i', raw, ...wavs.flatMap((w) => ['-i', w.wav])];
  const delays = wavs.map((w, i) => `[${i + 1}:a]adelay=${Math.max(0, w.offsetMs + 350)}:all=1[a${i}]`).join(';');
  const mix = `${wavs.map((_, i) => `[a${i}]`).join('')}amix=inputs=${wavs.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
  const mp4 = join(OUT_DIR, 'passvault-feature-tour.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${delays};${mix}`, '-map', '0:v', '-map', '[aout]', '-vf', 'scale=1280:-2:flags=lanczos,fps=30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-movflags', '+faststart', '-shortest', mp4], { stdio: 'inherit' });
  const poster = join(OUT_DIR, 'passvault-feature-tour.jpg');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.round((timeline.find((t) => t.id === 'projects')?.offsetMs ?? 60_000) / 1000) + 6), '-i', mp4, '-frames:v', '1', '-q:v', '3', poster]);
  const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { encoding: 'utf8' }).trim();
  console.log(`\n${mp4}\n  ${(Number(dur) / 60).toFixed(1)} min, ${(statSync(mp4).size / 1e6).toFixed(1)} MB, ${timeline.length} narrated chapters`);
  for (const f of readdirSync(VIDEO_DIR)) void f;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
