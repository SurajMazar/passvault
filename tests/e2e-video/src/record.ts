/**
 * Records an end-to-end PassVault product walkthrough with Playwright, then
 * encodes it with ffmpeg into docs/media/passvault-walkthrough.mp4.
 *
 * Requires a running stack (see docs/E2E_VIDEO.md):
 *   - API with SMTP → Mailpit   (podman compose up -d → API :3100, Mailpit :8025)
 *   - web dashboard pointed at that API (VITE_API_URL=http://localhost:3100 pnpm dev:web)
 *
 *   WEB_URL=http://localhost:5173 API_URL=http://localhost:3100 MAILPIT_URL=http://localhost:8025 \
 *     pnpm --filter @passvault/e2e-video record
 *
 * Every account and value is dummy data (example.com addresses, generated secrets).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import { TOTP } from 'otpauth';
import { MemoryStore } from '@passvault/sync';
import { VaultSession, type Platform } from '@passvault/vault-core';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5173';
const API_URL = process.env.API_URL ?? 'http://localhost:3100';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT_DIR = join(ROOT, 'docs/media');
const RAW_DIR = join(ROOT, 'tests/e2e-video/.raw');
const RUN = Date.now().toString(36);
const ALICE = { name: 'Alice Rivera', email: `alice.${RUN}@example.com`, password: 'marble-orchid-tundra-signal-84' };
const BOB = { name: 'Bob Chen', email: `bob.${RUN}@example.com`, password: 'copper-lantern-violet-quill-27' };
const W = 1440;
const H = 900;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers

async function mailCode(email: string, after: number): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const j = (await r.json()) as { messages: Array<{ ID: string; Created: string }> };
    const msg = j.messages.find((m) => Date.parse(m.Created) >= after - 1000);
    if (msg) {
      const m = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${msg.ID}`)).json()) as { Text: string };
      const code = /\b(\d{6})\b/.exec(m.Text)?.[1] ?? null;
      if (code) return code;
    }
    await sleep(250);
  }
  throw new Error(`no email for ${email}`);
}

/** Bottom-centre chapter caption rendered inside the page (ffmpeg here has no drawtext). */
async function caption(page: Page, title: string, sub = '', holdMs = 0) {
  await page.evaluate(
    ([t, s]) => {
      let el = document.getElementById('pv-caption');
      if (!el) {
        el = document.createElement('div');
        el.id = 'pv-caption';
        el.setAttribute('aria-hidden', 'true');
        Object.assign(el.style, {
          position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)', zIndex: '2147483647',
          padding: '12px 22px', borderRadius: '14px', background: 'rgba(8,21,26,0.88)', color: '#fff',
          font: '500 17px/1.35 Inter Variable, system-ui, sans-serif', boxShadow: '0 12px 32px rgba(0,0,0,.35)',
          border: '1px solid rgba(127,240,222,.35)', textAlign: 'center', maxWidth: '80vw', pointerEvents: 'none',
          transition: 'opacity .35s ease', opacity: '0',
        } as CSSStyleDeclaration);
        document.body.appendChild(el);
      }
      el.innerHTML = '';
      const h = document.createElement('div');
      h.textContent = t ?? "";
      h.style.fontWeight = '650';
      el.appendChild(h);
      if (s) {
        const p = document.createElement('div');
        p.textContent = s ?? "";
        Object.assign(p.style, { fontSize: '14px', opacity: '.75', marginTop: '2px' });
        el.appendChild(p);
      }
      requestAnimationFrame(() => (el!.style.opacity = '1'));
    },
    [title, sub],
  );
  if (holdMs) await sleep(holdMs);
}

async function titleCard(page: Page, heading: string, sub: string, ms: number) {
  await page.setContent(`<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(120% 80% at 0% 0%, rgba(43,195,174,.35), transparent 60%),radial-gradient(90% 70% at 100% 100%, rgba(11,127,114,.45), transparent 60%),linear-gradient(160deg,#0b1f22,#060d12);
    color:#fff;font-family:Inter,system-ui,-apple-system,sans-serif">
    <div style="text-align:center">
      <svg viewBox="0 0 32 32" width="84" height="84"><rect x="2" y="2" width="28" height="28" rx="8" fill="#2bc3ae"/><circle cx="16" cy="16" r="8.5" fill="none" stroke="#03201b" stroke-width="2.4"/><circle cx="16" cy="14.2" r="2.4" fill="#03201b"/><rect x="14.9" y="15" width="2.2" height="5.4" rx="1.1" fill="#03201b"/></svg>
      <h1 style="font-size:56px;margin:24px 0 8px;letter-spacing:-.02em">${heading}</h1>
      <p style="font-size:22px;opacity:.75;margin:0">${sub}</p>
    </div></body></html>`);
  await sleep(ms);
}

async function type(page: Page, locator: ReturnType<Page['locator']>, text: string, delay = 28) {
  await locator.click();
  await locator.pressSequentially(text, { delay });
}

const nav = (page: Page, name: RegExp | string) => page.getByRole('complementary', { name: 'Main navigation' }).getByRole('button', { name });

/** Headless second user (same VaultSession the clients use) for the sharing scene. */
function headlessDevice(): VaultSession {
  const prefs = new Map<string, string>();
  let token: string | null = null;
  const stores = new Map<string, MemoryStore>();
  const platform: Platform = {
    clientType: 'cli',
    deviceName: 'bob-laptop',
    apiBaseUrl: API_URL,
    webAppUrl: WEB_URL,
    tokens: { get: async () => token, set: async (t) => void (token = t), clear: async () => void (token = null) },
    prefs: { get: async (k) => prefs.get(k) ?? null, set: async (k, v) => void prefs.set(k, v), remove: async (k) => void prefs.delete(k) },
    createCacheStore: (s) => (stores.get(s) ?? stores.set(s, new MemoryStore()).get(s))!,
    clipboard: { copySecret: async () => undefined, copyText: async () => undefined },
    files: { pickTextFile: async () => null, saveTextFile: async () => ({ saved: false }) },
    openExternal: async () => undefined,
  };
  return new VaultSession(platform);
}

async function registerHeadless(s: VaultSession, u: typeof BOB) {
  await s.init();
  const t = Date.now();
  await s.startRegistration(u.email);
  const token = await s.verifyRegistration(u.email, await mailCode(u.email, t));
  await s.register(token, u.email, u.name, u.password);
  await s.login(u.email, u.password);
  const { secret } = await s.startMfaEnrollment();
  await s.confirmMfaEnrollment(new TOTP({ secret }).generate());
  s.acknowledgeRecoveryCodes();
  await s.syncNow();
}

// ---------------------------------------------------------------- scenes

async function main() {
  rmSync(RAW_DIR, { recursive: true, force: true });
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const health = (await (await fetch(`${API_URL}/api/v1/health`)).json()) as { status: string };
  if (health.status !== 'ok') throw new Error('API not healthy');

  console.log('Preparing second user (headless)…');
  const bob = headlessDevice();
  await registerHeadless(bob, BOB);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    recordVideo: { dir: RAW_DIR, size: { width: W, height: H } },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  context.setDefaultTimeout(30_000);
  const page = await context.newPage();
  const started = Date.now();
  const step = (s: string) => console.log(`  ${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s  ${s}`);

  await titleCard(page, 'PassVault', 'Passwords and developer secrets — end-to-end encrypted', 3500);

  // 1. Registration (email verified first) ----------------------------------------
  step('registration');
  await page.goto(WEB_URL);
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await caption(page, '1 · Create an account', 'The email address is verified before anything is created', 2200);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await type(page, page.getByLabel('Email'), ALICE.email);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Send verification code' }).click();
  const code = await mailCode(ALICE.email, t0);
  await caption(page, 'A 6-digit code arrives by email', 'No account exists until the code is confirmed');
  await type(page, page.getByLabel('Verification code'), code, 90);
  await page.getByRole('button', { name: 'Verify email' }).click();
  await caption(page, 'Choose a master password', 'It never leaves this device — keys are derived locally with Argon2id');
  await type(page, page.getByLabel('Your name'), ALICE.name);
  await type(page, page.getByLabel('Master password', { exact: true }), ALICE.password, 22);
  await page.getByRole('button', { name: 'What is a master password?' }).click();
  await sleep(1800);
  await type(page, page.getByLabel('Confirm master password'), ALICE.password, 12);
  await sleep(500);
  await page.getByRole('button', { name: 'Create account' }).click();
  const keyBox = page.getByLabel('Recovery key', { exact: true });
  await keyBox.waitFor();
  await caption(page, 'Vault recovery key — shown once', 'The only way back in if the master password is forgotten', 3000);
  const recoveryKey = (await keyBox.textContent())!.trim();
  await type(page, page.getByLabel('Type the last group of the key to confirm you saved it'), recoveryKey.split('-').pop()!, 70);
  await page.getByLabel('I stored the recovery key somewhere safe, offline').check();
  await page.getByRole('button', { name: 'Continue to two-step setup' }).click();

  // 2. Mandatory MFA ------------------------------------------------------------
  step('mfa');
  await page.getByRole('heading', { name: 'Set up two-step verification' }).waitFor();
  await caption(page, '2 · Two-step verification is mandatory', 'Scan with any authenticator app', 2500);
  await page.getByRole('button', { name: "Can't scan? Show setup key" }).click();
  const secret = (await page.locator('.select-all').first().textContent())!.trim();
  await sleep(800);
  await type(page, page.getByLabel('6-digit code'), new TOTP({ secret }).generate(), 90);
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page.getByRole('heading', { name: 'Save your two-step recovery codes' }).waitFor();
  await caption(page, 'One-time recovery codes', 'Restore account access if the phone is lost — they cannot decrypt the vault', 2800);
  await page.getByLabel('I saved these codes somewhere safe').check();
  await page.getByRole('button', { name: 'Open my vault' }).click();

  // 3. Overview + demo data -------------------------------------------------------
  step('overview');
  await page.getByRole('button', { name: 'Add demo data' }).waitFor();
  await caption(page, '3 · The vault', 'Everything is encrypted on this device before it syncs', 1800);
  await page.getByRole('button', { name: 'Add demo data' }).click();
  await page.getByText('Storefront .env (production)').first().waitFor();
  await sleep(2500);
  await caption(page, 'Security insights are computed locally', 'Weak, reused and expiring credentials — nothing is sent for checking', 3000);

  // 4. Logins: reveal + copy ----------------------------------------------------------
  step('logins');
  await nav(page, /^Logins/).click();
  await page.getByRole('option', { name: /Example Admin/ }).click();
  await caption(page, '4 · Website logins', 'Secrets are masked until you reveal them; copies auto-clear', 1500);
  await page.getByRole('button', { name: 'Reveal' }).first().click();
  await sleep(1500);
  await page.getByRole('button', { name: /^Copy password/ }).first().click();
  await sleep(1800);

  // 5. Create an SSH server (no URL required) ---------------------------------------------
  step('ssh server');
  await caption(page, '5 · Developer secrets are first-class', 'Servers, SSH keys, databases, API tokens and .env files — no website URL needed');
  await page.getByRole('button', { name: 'New item' }).click();
  await page.getByRole('menuitem', { name: 'Server' }).click();
  await type(page, page.getByRole('dialog').first().getByLabel('Title'), 'Production bastion');
  await type(page, page.getByRole('dialog').first().getByLabel('Hostname or IP'), 'bastion.example.net');
  await page.getByRole('dialog').first().getByLabel('Port').fill('2222');
  await type(page, page.getByRole('dialog').first().getByLabel('Username', { exact: true }), 'deploy');
  await page.getByRole('dialog').first().getByLabel('Environment').fill('Production');
  await sleep(700);
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('heading', { name: 'Production bastion' }).waitFor();
  await sleep(2200);

  // 6. Projects + environment comparison ------------------------------------------------
  step('projects');
  await nav(page, /^Projects/).click();
  await page.getByRole('button', { name: /Acme Storefront/ }).click();
  await caption(page, '6 · Projects and environments', 'Development, Staging and Production side by side — Production stands out', 2600);
  await page.getByRole('button', { name: 'Compare environments' }).click();
  await caption(page, 'Compare .env files across environments', 'Added, removed and changed variable names — values stay masked', 2200);
  await page.getByRole('dialog').getByRole('button', { name: /^Reveal STRIPE_KEY/ }).click();
  await sleep(2200);
  await page.keyboard.press('Escape');

  // 7. .env structured editing + history ----------------------------------------------------
  step('env editing');
  await nav(page, /^Environment files/).click();
  await page.getByRole('option', { name: /Storefront \.env \(development\)/ }).click();
  await caption(page, '7 · Structured .env editing', 'Only the edited line changes — comments, order and quoting are preserved');
  await page.getByRole('button', { name: 'Edit FEATURE_FLAGS' }).click();
  const valueInput = page.locator('div.grid:has(input[aria-label="Variable name"]) input').nth(1);
  await valueInput.fill('');
  await valueInput.pressSequentially('checkout,search,wishlist', { delay: 35 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await sleep(1500);
  await page.getByRole('tab', { name: 'Raw file' }).click();
  await caption(page, 'Raw mode shows the exact file', 'Nothing is executed or interpolated', 2400);
  await page.getByRole('tab', { name: 'Variables' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Version history' }).click();
  await caption(page, 'Encrypted version history', 'Compare or restore any revision — restores create a new version', 1600);
  await page.getByRole('dialog').getByRole('button', { name: 'Compare' }).first().click();
  await sleep(2600);
  await page.keyboard.press('Escape');

  // 8. Command palette --------------------------------------------------------------------
  step('palette');
  await caption(page, '8 · ⌘K command palette', 'Search is local: titles, hosts, tags and variable names — never secret values');
  await page.keyboard.press('Meta+k');
  await sleep(500);
  await page.keyboard.type('orders', { delay: 90 });
  await sleep(1400);
  await page.keyboard.press('Enter');
  await sleep(2000);

  // 9. Sharing with verified recipients ------------------------------------------------------
  step('sharing');
  await nav(page, /^Projects/).click();
  await sleep(400);
  if (!(await page.getByRole('heading', { name: 'Acme Storefront' }).isVisible())) await page.getByRole('button', { name: /Acme Storefront/ }).click();
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await caption(page, '9 · Share a project end-to-end encrypted', 'Keys are wrapped to the recipient’s public key; compare fingerprints out of band');
  await type(page, page.getByRole('dialog').first().getByLabel('Recipient email'), BOB.email, 22);
  await page.getByRole('dialog').getByRole('button', { name: 'Find' }).click();
  await page.getByRole('dialog').first().getByLabel('I compared this fingerprint with the recipient').check();
  await page.getByRole('dialog').first().getByLabel('Access').selectOption('editor');
  await sleep(1600);
  await page.getByRole('dialog').getByRole('button', { name: 'Send invitation' }).click();
  await caption(page, 'Production secrets need an extra confirmation', 'Recipients can copy what they can view — rotate secrets if access is removed');
  const confirmDialog = page.getByRole('dialog').last();
  await type(page, confirmDialog.getByRole('textbox'), 'SHARE', 120);
  await sleep(600);
  await confirmDialog.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByText(/Invitation sent/).waitFor();
  // Bob accepts on his own device (headless) and edits a shared item.
  const [inv] = await bob.invitations();
  await bob.acceptInvitation(inv!, true);
  const prodDb = bob.getSnapshot().items.find((i) => i.payload.title === 'Orders DB (production)')!;
  await bob.updateItem(prodDb.id, (p) => void (p.notes = 'Rotated password after incident drill — Bob'));
  await bob.syncNow();
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  await caption(page, 'Bob accepted and can edit', 'Owners change roles, set expiry, or revoke — revocation rotates the vault key', 3200);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Sync now/ }).click();
  await sleep(1500);
  await nav(page, /^Databases/).click();
  await page.getByRole('option', { name: /Orders DB/ }).click();
  await caption(page, 'Bob’s encrypted edit synced to Alice', 'Conflicting edits are never overwritten silently', 3000);

  // 10. Settings ---------------------------------------------------------------------------
  step('settings');
  await nav(page, /Security & settings/).click();
  await caption(page, '10 · Security & settings', 'Insights, sessions & devices, sharing fingerprints, lock timeout, export', 2400);
  await page.getByRole('button', { name: 'Sessions & devices' }).click();
  await sleep(2200);
  await page.getByRole('button', { name: 'Light theme' }).click();
  await caption(page, 'Light and dark themes', '', 2200);
  await page.getByRole('button', { name: 'Dark theme' }).click();

  // 11. Lock -----------------------------------------------------------------------------------
  step('lock');
  await caption(page, '11 · Lock', 'Keys and decrypted data are wiped from memory — manually, on inactivity, or on screen lock (desktop)', 1500);
  await page.getByRole('button', { name: 'Lock vault (⇧⌘L)' }).first().click();
  await page.getByRole('heading', { name: 'Vault locked' }).waitFor();
  await sleep(1500);
  await type(page, page.getByLabel('Master password', { exact: true }), ALICE.password, 18);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.getByRole('complementary', { name: 'Main navigation' }).waitFor();
  await caption(page, 'Unlocked locally — no server round-trip needed', '', 2400);

  await titleCard(page, 'PassVault', 'Web · Chrome extension · macOS app — github.com/SurajMazar/passvault', 3500);
  const videoPath = await page.video()!.path();
  await context.close();
  await browser.close();
  await bob.logout().catch(() => undefined);
  step('recorded');

  // ffmpeg: WebM (VP8) → H.264 MP4 (web-friendly, small), plus a poster frame.
  const mp4 = join(OUT_DIR, 'passvault-walkthrough.mp4');
  const poster = join(OUT_DIR, 'passvault-walkthrough.jpg');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoPath, '-vf', 'scale=1280:-2:flags=lanczos,fps=30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '58', '-i', mp4, '-frames:v', '1', '-q:v', '3', poster]);
  const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { encoding: 'utf8' }).trim();
  console.log(`\n${mp4}\n  duration ${Number(dur).toFixed(1)} s, size ${(statSync(mp4).size / 1e6).toFixed(1)} MB\n${poster}`);
  for (const f of readdirSync(RAW_DIR)) if (f.endsWith('.webm')) renameSync(join(RAW_DIR, f), join(RAW_DIR, `last-raw.webm`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
