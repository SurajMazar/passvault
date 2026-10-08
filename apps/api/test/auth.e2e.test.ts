import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rewrapForNewPassword } from '@passvault/crypto';
import {
  P,
  TEST_KDF,
  auth,
  boot,
  buildRegistration,
  advance,
  freshTotp,
  loginBody,
  registrationCode,
  registrationToken,
  onboard,
  reauth,
  registerVerified,
  totp,
  uniqueEmail,
  waitFor,
  type Ctx,
} from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await boot();
});
afterAll(async () => {
  await ctx.close();
});

describe('registration, login and mandatory MFA', () => {
  it('register/start -> code -> verify -> register -> login -> enroll -> active session; account matches registration keys', async () => {
    const email = uniqueEmail('alice');
    const reg = buildRegistration(email, 'Alice');
    await ctx.http.post(`${P}/auth/register/start`).send({ email }).expect(202)
      .expect((r) => expect(r.text).toBe(''));
    const code = await registrationCode(ctx, email);
    // no account exists before register
    expect(await ctx.prisma.user.count({ where: { email } })).toBe(0);
    const v = await ctx.http.post(`${P}/auth/register/verify`).send({ email, code }).expect(200);
    expect(v.body).toEqual({ registrationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(String) });
    expect(await ctx.prisma.user.count({ where: { email } })).toBe(0);
    const res = await ctx.http.post(`${P}/auth/register`).send({ ...reg.body, registrationToken: v.body.registrationToken }).expect(201);
    expect(res.body).toEqual({ userId: expect.any(String) });
    const created = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(created.emailVerifiedAt).not.toBeNull();

    const device = { id: randomUUID(), name: 'Alice laptop', clientType: 'web' as const };
    const wrongKey = Buffer.alloc(32, 7).toString('base64url');
    await ctx.http.post(`${P}/auth/login`).send({ email, authKey: wrongKey, device }).expect(401)
      .expect((r) => expect(r.body.error.code).toBe('invalid_credentials'));

    const login = await ctx.http.post(`${P}/auth/login`).send({ email, authKey: reg.material.authKey, device }).expect(200);
    expect(login.body).toEqual({ status: 'mfa_enrollment_required', mfaToken: expect.any(String), expiresAt: expect.any(String) });
    // pending token is not a session
    await ctx.http.get(`${P}/account`).set(auth(login.body.mfaToken)).expect(401);

    const start = await ctx.http.post(`${P}/auth/mfa/enroll/start`).send({ mfaToken: login.body.mfaToken }).expect(200);
    expect(start.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/PassVault:/);
    await ctx.http.post(`${P}/auth/mfa/enroll/confirm`).send({ mfaToken: login.body.mfaToken, code: '000000' }).expect(401);
    const confirm = await ctx.http
      .post(`${P}/auth/mfa/enroll/confirm`)
      .send({ mfaToken: login.body.mfaToken, code: freshTotp(start.body.secret) })
      .expect(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);
    for (const c of confirm.body.recoveryCodes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect(confirm.body.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const acct = await ctx.http.get(`${P}/account`).set(auth(confirm.body.session.token)).expect(200);
    expect(acct.body.user).toMatchObject({ email, name: 'Alice', emailVerified: true, mfaEnabled: true });
    expect(acct.body.kdf).toEqual(reg.body.kdf);
    const { recoveryAuthKey: _r, encryptedUserKeyByRecovery: _e, ...publicKeys } = reg.body.keys;
    expect(acct.body.keys).toEqual(publicKeys);
    expect(acct.body.personalVaultId).toBe(reg.personalVaultId);
    expect(acct.body.settings).toEqual({ encryptedSettings: null, revision: 0 });
    // the mfaToken was consumed by the upgrade
    await ctx.http.post(`${P}/auth/mfa/enroll/confirm`).send({ mfaToken: login.body.mfaToken, code: freshTotp(start.body.secret) }).expect(401);

    const vaults = await ctx.http.get(`${P}/vaults`).set(auth(confirm.body.session.token)).expect(200);
    expect(vaults.body).toHaveLength(1);
    expect(vaults.body[0]).toMatchObject({ vaultId: reg.personalVaultId, type: 'personal', role: 'owner', keyVersion: 1, encryptedVaultKey: reg.body.personalVault.encryptedVaultKey });
  });

  it('mfa_required on later logins; replayed TOTP rejected; trusted device skips MFA; password change invalidates it', async () => {
    const u = await onboard(ctx, 'bob');
    const login = await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(200);
    expect(login.body.status).toBe('mfa_required');

    const code = freshTotp(u.totpSecret);
    const ok = await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: login.body.mfaToken, code, trustDevice: true }).expect(200);
    expect(ok.body.trustedDeviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ok.body.account.user.email).toBe(u.email);
    const trusted = ok.body.trustedDeviceToken as string;

    // replay: same code (same time step) on a fresh pending token
    const login2 = await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(200);
    await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: login2.body.mfaToken, code }).expect(401)
      .expect((r) => expect(r.body.error.code).toBe('mfa_invalid'));
    // the token from the first verify cannot be reused either
    await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: login.body.mfaToken, code: freshTotp(u.totpSecret) }).expect(401);

    // trusted device -> status ok without MFA
    const t = await ctx.http.post(`${P}/auth/login`).send(loginBody(u, { trustedDeviceToken: trusted })).expect(200);
    expect(t.body.status).toBe('ok');
    expect(t.body.session.token).toBeTruthy();
    // trusted token is bound to the device
    const other = await ctx.http.post(`${P}/auth/login`).send(loginBody({ ...u, deviceId: randomUUID() }, { trustedDeviceToken: trusted })).expect(200);
    expect(other.body.status).toBe('mfa_required');

    const devices = await ctx.http.get(`${P}/devices`).set(auth(t.body.session.token)).expect(200);
    expect(devices.body.find((d: { id: string }) => d.id === u.deviceId)).toMatchObject({ trusted: true });

    // password change (reauth) rotates securityStamp -> trusted device no longer skips MFA
    const session = t.body.session.token as string;
    const newPw = rewrapForNewPassword(u.material.unlocked.userKey, 'new password!', TEST_KDF);
    const body = { kdf: newPw.kdf, authKey: newPw.authKey, encryptedUserKey: newPw.encryptedUserKey, signOutOtherSessions: true };
    await ctx.http.post(`${P}/account/password`).set(auth(session)).send(body).expect(403)
      .expect((r) => expect(r.body.error.code).toBe('reauth_required'));
    await reauth(ctx, { ...u, token: session });
    await ctx.http.post(`${P}/account/password`).set(auth(session)).send(body).expect(204);
    // other sessions revoked, current one survives
    await ctx.http.get(`${P}/account`).set(auth(u.token)).expect(401);
    const acct = await ctx.http.get(`${P}/account`).set(auth(session)).expect(200);
    expect(acct.body.kdf.salt).toBe(newPw.kdf.salt);

    await ctx.http.post(`${P}/auth/login`).send(loginBody(u, { trustedDeviceToken: trusted })).expect(401); // old authKey
    const after = await ctx.http.post(`${P}/auth/login`).send(loginBody({ ...u, authKey: newPw.authKey }, { trustedDeviceToken: trusted })).expect(200);
    expect(after.body.status).toBe('mfa_required');
    // prelogin now returns the new KDF params
    const pre = await ctx.http.post(`${P}/auth/prelogin`).send({ email: u.email }).expect(200);
    expect(pre.body.kdf).toEqual(newPw.kdf);
  });

  it('register/start for an existing account sends a notice, same 202, nothing created', async () => {
    const u = await registerVerified(ctx, 'dup');
    const before = await ctx.prisma.pendingRegistration.count({ where: { email: u.email } });
    const known = await ctx.http.post(`${P}/auth/register/start`).send({ email: u.email }).expect(202);
    const unknown = await ctx.http.post(`${P}/auth/register/start`).send({ email: uniqueEmail('fresh') }).expect(202);
    expect(known.text).toBe(unknown.text);
    expect(Object.keys(known.body)).toEqual(Object.keys(unknown.body));
    const notice = await waitFor(() => ctx.mail.outbox.find((m) => m.to === u.email && m.subject.includes('registration attempt')));
    expect(notice.text).not.toMatch(/\b\d{6}\b/);
    // the earlier (consumed) pending row is untouched; no new code issued for the existing account
    const rows = await ctx.prisma.pendingRegistration.findMany({ where: { email: u.email } });
    expect(rows.length).toBe(before);
    expect(rows.every((r) => r.usedAt !== null)).toBe(true);
    await ctx.http.post(`${P}/auth/register/verify`).send({ email: u.email, code: '123456' }).expect(400)
      .expect((r) => expect(r.body.error.code).toBe('invalid_code'));
    expect(await ctx.prisma.user.count({ where: { email: u.email } })).toBe(1);
  });

  it('wrong codes exhaust the pending registration (5 attempts); restart issues a new code', async () => {
    const email = uniqueEmail('wrongcode');
    await ctx.http.post(`${P}/auth/register/start`).send({ email }).expect(202);
    const code = await registrationCode(ctx, email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await ctx.http.post(`${P}/auth/register/verify`).send({ email, code: wrong }).expect(400)
        .expect((r) => expect(r.body.error.code).toBe('invalid_code'));
    }
    // even the right code is now refused
    await ctx.http.post(`${P}/auth/register/verify`).send({ email, code }).expect(400);
    // restart -> new code works
    await ctx.http.post(`${P}/auth/register/start`).send({ email }).expect(202);
    const code2 = await registrationCode(ctx, email, 1);
    await ctx.http.post(`${P}/auth/register/verify`).send({ email, code: code2 }).expect(200);
    // a code is single use
    await ctx.http.post(`${P}/auth/register/verify`).send({ email, code: code2 }).expect(400);
  });

  it('expired codes are rejected', async () => {
    const email = uniqueEmail('expired');
    await ctx.http.post(`${P}/auth/register/start`).send({ email }).expect(202);
    const code = await registrationCode(ctx, email);
    advance(16 * 60_000);
    await ctx.http.post(`${P}/auth/register/verify`).send({ email, code }).expect(400);
  });

  it('registration token: single use and bound to its email', async () => {
    const emailA = uniqueEmail('tok-a');
    const emailB = uniqueEmail('tok-b');
    const token = await registrationToken(ctx, emailA);
    const regB = buildRegistration(emailB);
    await ctx.http.post(`${P}/auth/register`).send({ ...regB.body, registrationToken: token }).expect(400)
      .expect((r) => expect(r.body.error.code).toBe('invalid_code'));
    expect(await ctx.prisma.user.count({ where: { email: emailB } })).toBe(0);
    const regA = buildRegistration(emailA);
    await ctx.http.post(`${P}/auth/register`).send({ ...regA.body, registrationToken: token }).expect(201);
    const again = buildRegistration(emailA);
    await ctx.http.post(`${P}/auth/register`).send({ ...again.body, registrationToken: token }).expect(400)
      .expect((r) => expect(r.body.error.code).toBe('invalid_code'));
    await ctx.http.post(`${P}/auth/register`).send({ ...again.body, registrationToken: 'x'.repeat(43) }).expect(400);
    expect(await ctx.prisma.user.count({ where: { email: emailA } })).toBe(1);
    expect(await ctx.prisma.vault.count({ where: { id: again.personalVaultId } })).toBe(0);
    // legacy endpoints are gone
    await ctx.http.post(`${P}/auth/verify-email`).send({ token: 'abc' }).expect(404);
    await ctx.http.post(`${P}/auth/resend-verification`).send({ email: emailA }).expect(404);
  });

  it('progressive lockout after repeated failures', async () => {
    const u = await registerVerified(ctx, 'lock');
    const bad = Buffer.alloc(32, 1).toString('base64url');
    for (let i = 0; i < ctx.cfg.LOGIN_LOCKOUT_THRESHOLD; i++) {
      await ctx.http.post(`${P}/auth/login`).send(loginBody({ ...u, authKey: bad })).expect(401);
    }
    // even the right key is refused while locked
    await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(429)
      .expect((r) => expect(r.body.error.code).toBe('rate_limited'));
    const failures = await ctx.prisma.auditEvent.count({ where: { subjectUserId: u.userId, type: 'auth.login_failed' } });
    expect(failures).toBeGreaterThanOrEqual(ctx.cfg.LOGIN_LOCKOUT_THRESHOLD);
    await ctx.prisma.user.update({ where: { id: u.userId }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(200);
  });
});

describe('recovery codes', () => {
  it('are single use, regeneration invalidates the old batch', async () => {
    const u = await onboard(ctx, 'codes');
    const [c1, c2] = u.recoveryCodes;
    const l1 = await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(200);
    const ok = await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: l1.body.mfaToken, recoveryCode: c1!.toLowerCase() }).expect(200);
    expect(ok.body.remainingRecoveryCodes).toBe(9);

    const l2 = await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(200);
    await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: l2.body.mfaToken, recoveryCode: c1 }).expect(401);

    // regenerate (reauth) -> old c2 stops working
    const session = ok.body.session.token as string;
    await ctx.http.post(`${P}/account/mfa/recovery-codes`).set(auth(session)).send({}).expect(403);
    await reauth(ctx, { ...u, token: session });
    const regen = await ctx.http.post(`${P}/account/mfa/recovery-codes`).set(auth(session)).send({}).expect(200);
    expect(regen.body.recoveryCodes).toHaveLength(10);
    const l3 = await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(200);
    await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: l3.body.mfaToken, recoveryCode: c2 }).expect(401);
    const fresh = await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: l3.body.mfaToken, recoveryCode: regen.body.recoveryCodes[0].replaceAll('-', '') }).expect(200);
    expect(fresh.body.remainingRecoveryCodes).toBe(9);
  });

  it('a pending mfaToken dies after 5 wrong attempts', async () => {
    const u = await onboard(ctx, 'attempts');
    const l = await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(200);
    for (let i = 0; i < 5; i++) {
      await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: l.body.mfaToken, code: '123456' === totp(u.totpSecret) ? '654321' : '123456' }).expect(401);
    }
    await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: l.body.mfaToken, code: freshTotp(u.totpSecret) }).expect(401)
      .expect((r) => expect(r.body.error.code).toBe('unauthenticated'));
    expect(await ctx.prisma.auditEvent.count({ where: { subjectUserId: u.userId, type: 'auth.mfa_failed' } })).toBe(5);
  });
});

describe('sessions', () => {
  it('logout revokes; logout-all requires reauth; revoked token -> 401; sessions list/revoke', async () => {
    const u = await onboard(ctx, 'sess');
    const second = await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(200);
    const s2 = await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: second.body.mfaToken, code: freshTotp(u.totpSecret) }).expect(200);
    const third = await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(200);
    const s3 = await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: third.body.mfaToken, code: freshTotp(u.totpSecret) }).expect(200);

    const list = await ctx.http.get(`${P}/sessions`).set(auth(u.token)).expect(200);
    expect(list.body).toHaveLength(3);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(list.body[0].ipPrefix === null || /\/(24|48)$/.test(list.body[0].ipPrefix)).toBe(true);

    // revoke one specific session
    await ctx.http.delete(`${P}/sessions/${s3.body.session.sessionId}`).set(auth(u.token)).expect(204);
    await ctx.http.get(`${P}/account`).set(auth(s3.body.session.token)).expect(401);
    // cannot revoke someone else's / unknown session
    await ctx.http.delete(`${P}/sessions/${randomUUID()}`).set(auth(u.token)).expect(404);

    // logout
    await ctx.http.post(`${P}/auth/logout`).set(auth(s2.body.session.token)).send({}).expect(204);
    await ctx.http.get(`${P}/sync`).set(auth(s2.body.session.token)).expect(401);

    // logout-all needs reauth
    await ctx.http.post(`${P}/auth/logout-all`).set(auth(u.token)).send({}).expect(403)
      .expect((r) => expect(r.body.error.code).toBe('reauth_required'));
    await reauth(ctx, u);
    await ctx.http.post(`${P}/auth/logout-all`).set(auth(u.token)).send({}).expect(204);
    await ctx.http.get(`${P}/account`).set(auth(u.token)).expect(401);
  });

  it('reauth window expires after 5 minutes; wrong reauth code does not sign out', async () => {
    const u = await onboard(ctx, 'reauth');
    await ctx.http.post(`${P}/auth/reauth`).set(auth(u.token)).send({ authKey: u.authKey, code: '000000' }).expect(403)
      .expect((r) => expect(r.body.error.code).toBe('mfa_invalid'));
    await reauth(ctx, u);
    await ctx.http.post(`${P}/account/mfa/recovery-codes`).set(auth(u.token)).send({}).expect(200);
    // 30 s steps from freshTotp already moved the clock; jump past the window
    const s = await ctx.prisma.session.findFirstOrThrow({ where: { userId: u.userId, revokedAt: null, state: 'active' } });
    await ctx.prisma.session.update({ where: { id: s.id }, data: { reauthUntil: new Date(Date.now() - 1) } });
    await ctx.http.post(`${P}/account/mfa/recovery-codes`).set(auth(u.token)).send({}).expect(403);
  });

  it('settings get/put with revision conflict', async () => {
    const u = await onboard(ctx, 'settings');
    const s0 = await ctx.http.get(`${P}/account/settings`).set(auth(u.token)).expect(200);
    expect(s0.body).toEqual({ encryptedSettings: null, revision: 0 });
    const s1 = await ctx.http.put(`${P}/account/settings`).set(auth(u.token)).send({ baseRevision: 0, encryptedSettings: 'AQEabc' }).expect(200);
    expect(s1.body).toEqual({ encryptedSettings: 'AQEabc', revision: 1 });
    const c = await ctx.http.put(`${P}/account/settings`).set(auth(u.token)).send({ baseRevision: 0, encryptedSettings: 'AQEzzz' }).expect(409);
    expect(c.body.error.code).toBe('revision_conflict');
    expect(c.body.error.details.current).toEqual({ encryptedSettings: 'AQEabc', revision: 1 });
  });
});

describe('validation and prelogin', () => {
  it('unknown fields -> 400 validation_failed with details', async () => {
    const r = await ctx.http.post(`${P}/auth/prelogin`).send({ email: 'a@example.test', extra: true }).expect(400);
    expect(r.body.error.code).toBe('validation_failed');
    expect(r.body.error.details).toEqual([expect.objectContaining({ path: expect.any(String), message: expect.any(String) })]);
    expect(r.body.requestId).toEqual(expect.any(String));
    const u = await onboard(ctx, 'val');
    const bad = await ctx.http.post(`${P}/records`).set(auth(u.token)).send({ nope: 1 }).expect(400);
    expect(bad.body.error.code).toBe('validation_failed');
    await ctx.http.get(`${P}/sync?cursor=abc`).set(auth(u.token)).expect(400);
    await ctx.http.get(`${P}/sync?foo=1`).set(auth(u.token)).expect(400);
  });

  it('prelogin for unknown email is deterministic and shaped like a real one', async () => {
    const email = uniqueEmail('ghost');
    const a = await ctx.http.post(`${P}/auth/prelogin`).send({ email }).expect(200);
    const b = await ctx.http.post(`${P}/auth/prelogin`).send({ email: email.toUpperCase() }).expect(200);
    expect(a.body).toEqual(b.body);
    expect(a.body.kdf).toEqual({ algorithm: 'argon2id', version: 1, opsLimit: expect.any(Number), memLimitBytes: expect.any(Number), salt: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });
    const c = await ctx.http.post(`${P}/auth/prelogin`).send({ email: uniqueEmail('ghost') }).expect(200);
    expect(c.body.kdf.salt).not.toBe(a.body.kdf.salt);
    const real = await registerVerified(ctx, 'real');
    const r = await ctx.http.post(`${P}/auth/prelogin`).send({ email: real.email }).expect(200);
    expect(Object.keys(r.body.kdf).sort()).toEqual(Object.keys(a.body.kdf).sort());
    expect(r.body.kdf).toEqual(real.material.kdf);
    // unknown account login -> same 401 as a wrong key
    const l = await ctx.http.post(`${P}/auth/login`).send(loginBody({ ...real, email })).expect(401);
    expect(l.body.error.code).toBe('invalid_credentials');
  });

  it('health exposes only status/db/version', async () => {
    const r = await ctx.http.get(`${P}/health`).expect(200);
    expect(r.body).toEqual({ status: 'ok', db: 'ok', version: expect.any(String) });
  });

  it('recovery/start always 202', async () => {
    await ctx.http.post(`${P}/recovery/start`).send({ email: uniqueEmail('nobody') }).expect(202);
  });
});
