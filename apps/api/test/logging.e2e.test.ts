import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { P, auth, boot, buildRegistration, freshTotp, loginBody, newRecord, onboard, registrationCode, uniqueEmail, type Ctx } from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await boot({ LOG_LEVEL: 'trace' });
});
afterAll(async () => {
  await ctx.close();
});

describe('log redaction', () => {
  it('logs never contain authKey, tokens, TOTP/recovery codes, ciphertext or full emails', async () => {
    const secrets: string[] = [];
    const codes: string[] = [];
    // registration: the emailed code and the registration token must never be logged
    const regEmail = uniqueEmail('logs-reg');
    await ctx.http.post(`${P}/auth/register/start`).send({ email: regEmail }).expect(202);
    const regCode = await registrationCode(ctx, regEmail);
    await ctx.http.post(`${P}/auth/register/verify`).send({ email: regEmail, code: regCode === '000000' ? '000001' : '000000' }).expect(400);
    const v = await ctx.http.post(`${P}/auth/register/verify`).send({ email: regEmail, code: regCode }).expect(200);
    const reg = buildRegistration(regEmail);
    await ctx.http.post(`${P}/auth/register`).send({ ...reg.body, registrationToken: v.body.registrationToken }).expect(201);
    codes.push(regCode);
    secrets.push(regEmail, v.body.registrationToken, reg.body.authKey, reg.body.keys.recoveryAuthKey);

    const u = await onboard(ctx, 'logs');
    secrets.push(u.authKey, u.token, u.totpSecret, u.email, u.material.keys.recoveryAuthKey, u.material.keys.encryptedUserKey, ...u.recoveryCodes);

    const l1 = await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(200);
    const code = freshTotp(u.totpSecret);
    codes.push(code);
    const v1 = await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: l1.body.mfaToken, code, trustDevice: true }).expect(200);
    secrets.push(l1.body.mfaToken, v1.body.session.token, v1.body.trustedDeviceToken);
    // failures are logged too (warn level) — still without secrets
    const l2 = await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(200);
    secrets.push(l2.body.mfaToken);
    await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: l2.body.mfaToken, recoveryCode: u.recoveryCodes[0] }).expect(200);
    await ctx.http.post(`${P}/auth/login`).send(loginBody({ ...u, authKey: Buffer.alloc(32, 3).toString('base64url') })).expect(401);
    secrets.push(Buffer.alloc(32, 3).toString('base64url'));
    await ctx.http.post(`${P}/auth/login`).send(loginBody({ ...u, email: 'unknown-person@example.test' })).expect(401);
    secrets.push('unknown-person@example.test');

    const rec = newRecord(u.personalVaultId, u.personalVaultKey, { password: 'hunter2' });
    await ctx.http.post(`${P}/records`).set(auth(u.token)).send(rec.body).expect(201);
    secrets.push(rec.body.encryptedPayload, rec.body.encryptedKey);
    await ctx.http.get(`${P}/users/lookup`).query({ email: u.email }).set(auth(u.token)).expect(200);
    await ctx.http.post(`${P}/records`).set(auth(u.token)).send({ ...rec.body, id: randomUUID(), extra: 'x' }).expect(400);

    const out = ctx.logs.join('');
    expect(out).toContain('request completed');
    expect(out).toContain('/api/v1/records');
    for (const s of secrets) expect(out.includes(s), `log contains a secret (${s.slice(0, 4)}…)`).toBe(false);
    for (const c of codes) expect(new RegExp(`(?<!\\d)${c}(?!\\d)`).test(out)).toBe(false);
    expect(out).not.toMatch(/authorization/i);
    expect(out).not.toMatch(/Bearer /);
    // IPs are truncated
    expect(out).toMatch(/"ip":"127\.0\.0\.0\/24"/);
  });
});
