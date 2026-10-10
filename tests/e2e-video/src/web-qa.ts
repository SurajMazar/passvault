/**
 * Web dashboard QA in real Chromium, driven like a person: registration with
 * email code, mandatory two-step setup, every new-item path that changed
 * recently (logins with identifier + comma tags, payment cards), search,
 * hover titles, menus inside the viewport, trash/restore, lock/unlock,
 * fingerprint unlock with Chrome's virtual authenticator (WebAuthn PRF), sign
 * out and sign in with TOTP, a phone-width layout, and no page errors.
 *
 * Needs the local stack (podman compose up -d: API, Mailpit) and the
 * dashboard pointed at it:
 *
 *   VITE_API_URL=http://localhost:3100 pnpm --filter @passvault/web exec vite --port 5173
 *   WEB_URL=http://localhost:5173 pnpm --filter @passvault/e2e-video check:web
 *
 * Dummy data only (example.com accounts, test card number).
 */
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { TOTP } from 'otpauth';
import { mailCode, sleep } from './tour/lib';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5173';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const SHOTS = process.env.PV_SHOTS;
const RUN = Date.now().toString(36);
const USER = { name: 'Web QA', email: `webqa.${RUN}@example.com`, password: 'cobalt-lantern-frost-meadow-29' };

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    check(name, false, (e instanceof Error ? e.message : String(e)).split('\n')[0]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/fail-${results.length}.png` }).catch(() => undefined);
  }
}

const nav = (p: Page, name: RegExp | string) => p.getByRole('complementary', { name: 'Main navigation' }).getByRole('button', { name });
const dialog = (p: Page) => p.getByRole('dialog').first();
async function inViewport(p: Page, selector: string) {
  return p.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)];
    return els.length > 0 && els.every((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
    });
  }, selector);
}

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 860 }, permissions: ['clipboard-read', 'clipboard-write'] });
context.setDefaultTimeout(20_000);
const page = await context.newPage();
const pageErrors: string[] = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) pageErrors.push(m.text());
});

// Chrome's virtual platform authenticator: user verification + PRF, like Touch ID.
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
});

let totp: TOTP | null = null;

await step('register with email code, recovery key and mandatory two-step', async () => {
  await page.goto(WEB_URL);
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email').fill(USER.email);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await page.getByLabel('Verification code').fill(await mailCode(MAILPIT, USER.email, t0));
  await page.getByRole('button', { name: 'Verify email' }).click();
  await page.getByLabel('Your name').fill(USER.name);
  await page.getByLabel('Master password', { exact: true }).fill(USER.password);
  await page.getByLabel('Confirm master password').fill(USER.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  const key = (await page.getByLabel('Recovery key', { exact: true }).textContent())!.trim();
  await page.getByLabel('Type the last group of the key to confirm you saved it').fill(key.split('-').pop()!);
  await page.getByLabel('I stored the recovery key somewhere safe, offline').check();
  await page.getByRole('button', { name: 'Continue to two-step setup' }).click();
  await page.getByRole('heading', { name: 'Set up two-step verification' }).waitFor();
  await page.getByRole('button', { name: "Can't scan? Show setup key" }).click();
  totp = new TOTP({ secret: (await page.locator('.select-all').first().textContent())!.trim().replace(/\s/g, '') });
  await page.getByLabel('6-digit code').fill(totp.generate());
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await page.getByRole('heading', { name: 'Save your two-step recovery codes' }).waitFor();
  await page.getByLabel('I saved these codes somewhere safe').check();
  await page.getByRole('button', { name: 'Open my vault' }).click();
  await nav(page, /^Overview/).waitFor();
  check('register with email code, recovery key and mandatory two-step', true);
});

await step('new-item menu fits in the window and lists every type', async () => {
  await nav(page, 'New item').click();
  const labels = await page.getByRole('menuitem').allTextContents();
  const want = ['Login', 'Server', 'SSH key', 'Database', 'API credential', 'Environment file', 'Secure note', 'Payment card'];
  check('new-item menu lists every type', want.every((w) => labels.some((l) => l.trim() === w)), labels.join(', '));
  check('new-item menu fits in the window', await inViewport(page, '[role="menu"]'));
  await page.keyboard.press('Escape');
});

const LOGIN_TITLE = 'Acme customer portal — production administrator account for the EU region';
await step('login with identifier, comma tags, autocorrect off', async () => {
  await nav(page, 'New item').click();
  await page.getByRole('menuitem', { name: 'Login', exact: true }).click();
  const d = dialog(page);
  await d.getByLabel('Title').fill(LOGIN_TITLE);
  await d.getByLabel('Username or email').fill('admin@example.com');
  await d.getByLabel('Password', { exact: true }).fill('Dummy-Portal-Pass-42!');
  if (!(await d.getByLabel('Website 1').isVisible().catch(() => false))) await d.getByRole('button', { name: /Add website/ }).click();
  await d.getByLabel('Website 1').fill('https://portal.example.com');
  const tags = d.getByLabel('Tags');
  await tags.click();
  await page.keyboard.type('work,client a,');
  const chips = await d.locator('[data-tag], .pv-tag').allTextContents().catch(() => [] as string[]);
  const tagText = await d.getByText('client a', { exact: true }).count();
  check('comma separates tags', tagText > 0 && (await d.getByText('work', { exact: true }).count()) > 0, chips.join('|'));
  await d.getByLabel('Identifier').fill('client-a-eu');
  const attrs = await d.evaluate((root) =>
    [...root.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea')].filter(
      (el) => el.getAttribute('autocorrect') !== 'off' || el.getAttribute('spellcheck') !== 'false' || el.getAttribute('autocapitalize') !== 'off',
    ).map((el) => el.getAttribute('aria-label') || el.id || el.tagName),
  );
  check('autocorrect, spellcheck and autocapitalize are off in every editor field', attrs.length === 0, attrs.join(', '));
  await d.getByRole('button', { name: 'Create', exact: true }).click();
  await d.waitFor({ state: 'detached' });
  check('login saved', true);
});

await step('list shows identifier and full title on hover', async () => {
  await nav(page, /^Logins/).click();
  const row = page.getByRole('option', { name: /Acme customer portal/ });
  await row.waitFor();
  check('identifier visible on the row', (await row.getByText('client-a-eu').count()) > 0);
  const titled = await row.evaluate((el, t) => !!el.querySelector(`[title="${t}"]`) || el.getAttribute('title') === t, LOGIN_TITLE);
  check('hover shows the untruncated title', titled);
});

await step('search finds by identifier and by tag', async () => {
  const search = page.getByLabel('Search vault');
  await search.fill('client-a-eu');
  await sleep(300);
  check('search by identifier', (await page.getByRole('option', { name: /Acme customer portal/ }).count()) === 1);
  check('search box has autocorrect off', (await search.getAttribute('autocorrect')) === 'off' && (await search.getAttribute('spellcheck')) === 'false');
  await search.fill('');
});

await step('payment card: create, masked detail, sidebar section', async () => {
  await nav(page, 'New item').click();
  await page.getByRole('menuitem', { name: 'Payment card' }).click();
  const d = dialog(page);
  await d.getByLabel('Title').fill('Team Visa');
  await d.getByLabel('Name on card').fill('Alex Rivera');
  await d.getByLabel('Card number').fill('4111 1111 1111 1111');
  check('card number grouped while typing', (await d.getByLabel('Card number').inputValue()) === '4111 1111 1111 1111');
  await d.getByLabel('Expiry month').selectOption('08');
  await d.getByLabel('Expiry year').selectOption('2031');
  await d.getByLabel('Security code (CVV)').fill('123');
  await d.getByRole('button', { name: 'Create', exact: true }).click();
  await d.waitFor({ state: 'detached' });
  await nav(page, /^Payment cards/).click();
  const row = page.getByRole('option', { name: /Team Visa/ });
  check('card row shows brand and last four only', /Visa.*1111/.test(await row.innerText()) && !(await row.innerText()).includes('4111'), (await row.innerText()).replace(/\s+/g, ' '));
  await row.click();
  await page.getByRole('heading', { name: 'Team Visa' }).waitFor();
  const body = await page.locator('main').innerText();
  check('card number and CVV masked in detail', !body.includes('4111') && !/\b123\b/.test(body));
  check('card number never shown in full in the list', !(await page.getByRole('listbox').innerText().catch(() => '')).includes('4111111111111111'));
  const cardsNav = nav(page, /^Payment cards/);
  check('Payment cards in the sidebar', await cardsNav.isVisible());
  await cardsNav.click();
  check('card listed under Payment cards', (await page.getByRole('option', { name: /Team Visa/ }).count()) === 1);
});

await step('item actions menu stays inside the window', async () => {
  await page.getByRole('option', { name: /Team Visa/ }).click();
  await page.getByRole('button', { name: 'More actions' }).first().click();
  check('actions menu fits in the window', await inViewport(page, '[role="menu"]'));
  await page.keyboard.press('Escape');
});

await step('trash and restore', async () => {
  await page.getByRole('button', { name: 'More actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await nav(page, /^Trash/).click();
  await page.getByRole('option', { name: /Team Visa/ }).click();
  await page.getByRole('button', { name: 'More actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Restore' }).click();
  await nav(page, /^Payment cards/).click();
  check('trash then restore', (await page.getByRole('option', { name: /Team Visa/ }).count()) === 1);
});

await step('fingerprint unlock (WebAuthn PRF) and master-password unlock', async () => {
  await nav(page, /Security & settings/).click();
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  const sw = page.getByRole('switch', { name: /Unlock with/ });
  await sw.waitFor();
  await sw.click();
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-checked="true"]') !== null, null, { timeout: 15_000 });
  check('turn on fingerprint unlock', (await sw.getAttribute('aria-checked')) === 'true');
  await page.getByRole('button', { name: /Lock vault/ }).first().click();
  await page.getByRole('heading', { name: 'Vault locked' }).waitFor();
  const bio = page.getByRole('button', { name: /^Unlock with / });
  await bio.waitFor({ timeout: 10_000 });
  await bio.click();
  await nav(page, /^Overview/).waitFor({ timeout: 15_000 });
  check('unlock with fingerprint', true);
  await page.getByRole('button', { name: /Lock vault/ }).first().click();
  await page.getByLabel('Master password', { exact: true }).fill(USER.password);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await nav(page, /^Overview/).waitFor();
  check('unlock with master password', true);
});

await step('sign out, sign in with two-step code; items are still there', async () => {
  await nav(page, /Security & settings/).click();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out of this device' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await page.getByLabel('Email').fill(USER.email);
  await page.getByLabel('Master password', { exact: true }).fill(USER.password);
  await page.getByRole('button', { name: /^Sign in|^Continue/ }).first().click();
  // a fresh 30-second step: the server refuses a code it already accepted
  await sleep(30_000 - (Date.now() % 30_000) + 500);
  await page.getByLabel(/6-digit code|Authentication code/).fill(totp!.generate());
  await page.getByRole('button', { name: /Verify|Continue|Sign in/ }).first().click();
  await nav(page, /^Overview/).waitFor({ timeout: 30_000 });
  await nav(page, /^All items/).click();
  await page.getByRole('option', { name: /Team Visa/ }).waitFor({ timeout: 15_000 });
  const rows = (await page.getByRole('option').allInnerTexts()).filter((t) => /Team Visa|Acme customer portal/.test(t));
  check('sign in again with two-step code; items synced back', rows.length === 2, `${rows.length} items`);
});

await step('phone width: no sideways scrolling', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check('no horizontal overflow at 390 px', overflow <= 1, `${overflow}px`);
  await page.setViewportSize({ width: 1360, height: 860 });
});

check('no page errors in the console', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
