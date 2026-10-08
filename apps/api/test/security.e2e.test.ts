/**
 * Time- and configuration-dependent security properties (run by the security
 * harness: tests/security, check `auth.time-dependent`). Real app + real
 * Postgres; only Date is faked so windows can be crossed without waiting.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  P,
  advance,
  auth,
  boot,
  buildRegistration,
  createSharedVault,
  freshTotp,
  loginBody,
  mailTokenFor,
  onboard,
  registrationCode,
  share,
  uniqueEmail,
  type Ctx,
} from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  // Production defaults for every limit under test.
  ctx = await boot({
    RATE_LIMIT_EMAIL_PER_15_MINUTES: '10',
    LOGIN_LOCKOUT_THRESHOLD: '10',
    LOGIN_LOCKOUT_MINUTES: '15',
    SESSION_IDLE_MINUTES: '10080',
    SESSION_TTL_HOURS: '720',
  });
});
afterAll(async () => {
  await ctx.close();
});

const wrongKey = () => buildRegistration(uniqueEmail('k')).body.authKey;
const login = (email: string, authKey: string) => ctx.http.post(`${P}/auth/login`).send({ email, authKey, device: { id: randomUUID(), name: 'sec', clientType: 'cli' } });
const shape = (r: { status: number; body: { error?: { code?: string; message?: string } } }) => `${r.status} ${r.body.error?.code} ${r.body.error?.message}`;

describe('account lockout does not reveal which emails have accounts', () => {
  it('known and unknown emails answer identically through failures, lockout and limiter windows', async () => {
    const known = await onboard(ctx, 'lock-known');
    const unknown = uniqueEmail('lock-unknown');
    const transcript = async (email: string, key: string) => {
      const out: string[] = [];
      // 9 failures, then wait out the per-email limiter window (failure counts persist), then 3 more.
      for (let i = 0; i < 9; i++) out.push(shape(await login(email, key)));
      advance(16 * 60_000);
      for (let i = 0; i < 3; i++) out.push(shape(await login(email, key)));
      return out;
    };
    const a = await transcript(known.email, wrongKey());
    // The lockout itself still applies to the real account (even with the right password).
    expect((await login(known.email, known.authKey)).status).toBe(429);
    const b = await transcript(unknown, wrongKey());
    expect([...b, shape(await login(unknown, wrongKey()))]).toEqual([...a, '429 rate_limited Too many failed attempts; try again later']);
  });
});

describe('expiry windows', () => {
  it('registration code (15 min) and registration token (30 min) expire', async () => {
    const email = uniqueEmail('exp-code');
    await ctx.http.post(`${P}/auth/register/start`).send({ email }).expect(202);
    const code = await registrationCode(ctx, email);
    advance(16 * 60_000);
    expect((await ctx.http.post(`${P}/auth/register/verify`).send({ email, code })).status).toBe(400);

    const email2 = uniqueEmail('exp-token');
    await ctx.http.post(`${P}/auth/register/start`).send({ email: email2 }).expect(202);
    const v = await ctx.http.post(`${P}/auth/register/verify`).send({ email: email2, code: await registrationCode(ctx, email2) }).expect(200);
    advance(31 * 60_000);
    const reg = buildRegistration(email2);
    expect((await ctx.http.post(`${P}/auth/register`).send({ ...reg.body, registrationToken: v.body.registrationToken })).status).toBe(400);
  });

  it('pending MFA sign-in expires after 10 minutes', async () => {
    const u = await onboard(ctx, 'exp-mfa');
    const l = await login(u.email, u.authKey).expect(200);
    advance(11 * 60_000);
    const r = await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: l.body.mfaToken, code: freshTotp(u.totpSecret) });
    expect(r.status).toBe(401);
  });

  it('recovery link (30 min) and verified recovery token (15 min) expire', async () => {
    const u = await onboard(ctx, 'exp-recovery');
    await ctx.http.post(`${P}/recovery/start`).send({ email: u.email }).expect(202);
    const link = mailTokenFor(ctx, u.email, '/recover');
    advance(31 * 60_000);
    expect((await ctx.http.post(`${P}/recovery/verify`).send({ token: link, code: freshTotp(u.totpSecret) })).status).toBe(401);

    await ctx.http.post(`${P}/recovery/start`).send({ email: u.email }).expect(202);
    const link2 = mailTokenFor(ctx, u.email, '/recover');
    const v = await ctx.http.post(`${P}/recovery/verify`).send({ token: link2, code: freshTotp(u.totpSecret) }).expect(200);
    advance(16 * 60_000);
    const reg = buildRegistration(u.email);
    const r = await ctx.http.post(`${P}/recovery/reset-account`).send({
      recoveryToken: v.body.recoveryToken,
      confirmation: 'DELETE MY VAULT DATA',
      authKey: reg.body.authKey,
      kdf: reg.body.kdf,
      keys: reg.body.keys,
      personalVault: reg.body.personalVault,
    });
    expect(r.status).toBe(401);
  });

  it('sessions end after the idle timeout and after the absolute lifetime', async () => {
    const u = await onboard(ctx, 'exp-session');
    advance(10080 * 60_000 + 60_000);
    expect((await ctx.http.get(`${P}/account`).set(auth(u.token))).status).toBe(401);

    const v = await onboard(ctx, 'exp-absolute');
    // Keep the session active (touch every 6 days) until the 30-day absolute TTL passes.
    for (let d = 0; d < 5; d++) {
      advance(6 * 24 * 60 * 60_000);
      await ctx.http.get(`${P}/account`).set(auth(v.token));
    }
    advance(1 * 24 * 60 * 60_000);
    expect((await ctx.http.get(`${P}/account`).set(auth(v.token))).status).toBe(401);
  });

  it('an expired vault membership loses access immediately, before the expiry job runs', async () => {
    const owner = await onboard(ctx, 'exp-owner');
    const guest = await onboard(ctx, 'exp-guest');
    const vault = await createSharedVault(ctx, owner);
    await share(ctx, vault, owner, guest, 'viewer', new Date(Date.now() + 60 * 60_000).toISOString());
    expect((await ctx.http.get(`${P}/vaults/${vault.vaultId}/records`).set(auth(guest.token))).status).toBe(200);
    advance(61 * 60_000);
    const r = await ctx.http.get(`${P}/vaults/${vault.vaultId}/records`).set(auth(guest.token));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('membership_expired');
    const sync = await ctx.http.get(`${P}/sync`).set(auth(guest.token)).expect(200);
    expect(sync.body.vaults.map((x: { vaultId: string }) => x.vaultId)).not.toContain(vault.vaultId);
  });
});
