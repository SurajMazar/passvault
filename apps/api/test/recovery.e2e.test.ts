import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decryptRecord,
  deriveRecoveryKeys,
  generateRecoveryKey,
  rewrapForNewPassword,
  unlockWithRecoveryKey,
  wrapUserKeyForRecovery,
} from '@passvault/crypto';
import type * as T from '@passvault/types';
import { P, TEST_KDF, auth, boot, buildRegistration, createSharedVault, freshTotp, loginBody, mailTokenFor, newRecord, onboard, share, waitFor, type Ctx } from './helpers';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await boot();
});
afterAll(async () => {
  await ctx.close();
});

async function recoveryLink(email: string): Promise<string> {
  const before = ctx.mail.outbox.filter((m) => m.to === email && m.text.includes('/recover')).length;
  await ctx.http.post(`${P}/recovery/start`).send({ email }).expect(202);
  await waitFor(() => ctx.mail.outbox.filter((m) => m.to === email && m.text.includes('/recover')).length > before);
  const mail = [...ctx.mail.outbox].reverse().find((m) => m.to === email && m.text.includes('/recover'))!;
  expect(mail.text).toMatch(/^http:\/\/localhost:5173\/recover#token=/m);
  return mailTokenFor(ctx, email, '/recover');
}

describe('recovery', () => {
  it('complete-vault: rejects a wrong recoveryAuthKey, succeeds with the right one and revokes sessions', async () => {
    const u = await onboard(ctx, 'rec-vault');
    const rec = newRecord(u.personalVaultId, u.personalVaultKey, { secret: 'kept' });
    await ctx.http.post(`${P}/records`).set(auth(u.token)).send(rec.body).expect(201);

    const link = await recoveryLink(u.email);
    await ctx.http.post(`${P}/recovery/verify`).send({ token: link, code: '000000' }).expect(401);
    const v = await ctx.http.post(`${P}/recovery/verify`).send({ token: link, code: freshTotp(u.totpSecret) }).expect(200);
    expect(v.body.encryptedUserKeyByRecovery).toBe(u.material.keys.encryptedUserKeyByRecovery);
    expect(v.body.keys).not.toHaveProperty('encryptedUserKey');
    // link token is single use
    await ctx.http.post(`${P}/recovery/verify`).send({ token: link, code: freshTotp(u.totpSecret) }).expect(401);

    // client side: open the User Key with the recovery key, set a new password and a new recovery key
    const unlocked = unlockWithRecoveryKey(u.material.recoveryKey, v.body.encryptedUserKeyByRecovery, v.body.keys);
    const pw = rewrapForNewPassword(unlocked.userKey, 'brand new password', TEST_KDF);
    const newRecoveryKey = generateRecoveryKey();
    const rewrapped = wrapUserKeyForRecovery(unlocked.userKey, newRecoveryKey);
    const body: T.RecoveryCompleteVaultRequest = {
      recoveryToken: v.body.recoveryToken,
      recoveryAuthKey: Buffer.alloc(32, 9).toString('base64url'),
      kdf: pw.kdf,
      authKey: pw.authKey,
      encryptedUserKey: pw.encryptedUserKey,
      newEncryptedUserKeyByRecovery: rewrapped.encryptedUserKeyByRecovery,
      newRecoveryAuthKey: rewrapped.recoveryAuthKey,
    };
    // email + MFA alone is not enough
    await ctx.http.post(`${P}/recovery/complete-vault`).send(body).expect(401)
      .expect((r) => expect(r.body.error.code).toBe('invalid_credentials'));
    await ctx.http.post(`${P}/recovery/complete-vault`).send({ ...body, recoveryAuthKey: deriveRecoveryKeys(u.material.recoveryKey).authKey }).expect(204);
    // single use
    await ctx.http.post(`${P}/recovery/complete-vault`).send({ ...body, recoveryAuthKey: deriveRecoveryKeys(u.material.recoveryKey).authKey }).expect(401);

    await ctx.http.get(`${P}/account`).set(auth(u.token)).expect(401);
    await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(401);
    const login = await ctx.http.post(`${P}/auth/login`).send(loginBody({ ...u, authKey: pw.authKey })).expect(200);
    expect(login.body.status).toBe('mfa_required');
    const s = await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: login.body.mfaToken, code: freshTotp(u.totpSecret) }).expect(200);
    expect(s.body.account.keys.encryptedUserKey).toBe(pw.encryptedUserKey);
    // vault data is intact and still decryptable with the same vault key
    const r = await ctx.http.get(`${P}/records/${rec.id}`).set(auth(s.body.session.token)).expect(200);
    const dec = decryptRecord<{ secret: string }>({ recordId: rec.id, vaultId: u.personalVaultId, vaultKey: u.personalVaultKey, encryptedKey: r.body.encryptedKey, encryptedPayload: r.body.encryptedPayload });
    expect(dec.payload.secret).toBe('kept');
    // the new recovery key now works, the old one no longer does
    const link2 = await recoveryLink(u.email);
    const v2 = await ctx.http.post(`${P}/recovery/verify`).send({ token: link2, code: freshTotp(u.totpSecret) }).expect(200);
    expect(() => unlockWithRecoveryKey(u.material.recoveryKey, v2.body.encryptedUserKeyByRecovery, v2.body.keys)).toThrow();
    expect(() => unlockWithRecoveryKey(newRecoveryKey, v2.body.encryptedUserKeyByRecovery, v2.body.keys)).not.toThrow();
  });

  it('recovery link dies after 5 wrong MFA codes', async () => {
    const u = await onboard(ctx, 'rec-brute');
    const link = await recoveryLink(u.email);
    for (let i = 0; i < 5; i++) await ctx.http.post(`${P}/recovery/verify`).send({ token: link, code: '000000' }).expect(401);
    await ctx.http.post(`${P}/recovery/verify`).send({ token: link, code: freshTotp(u.totpSecret) }).expect(401);
  });

  it('reset-account (with an MFA recovery code) tombstones personal records, drops shared access, installs new keys', async () => {
    const u = await onboard(ctx, 'reset');
    const friend = await onboard(ctx, 'reset-friend');
    const rec = newRecord(u.personalVaultId, u.personalVaultKey);
    await ctx.http.post(`${P}/records`).set(auth(u.token)).send(rec.body).expect(201);
    // u owns a shared vault (with friend) and is a member of friend's vault
    const owned = await createSharedVault(ctx, u);
    const ownedRec = newRecord(owned.vaultId, owned.vaultKey);
    await ctx.http.post(`${P}/records`).set(auth(u.token)).send(ownedRec.body).expect(201);
    await share(ctx, owned, u, friend, 'editor');
    const theirs = await createSharedVault(ctx, friend);
    await share(ctx, theirs, friend, u, 'viewer');

    const link = await recoveryLink(u.email);
    const v = await ctx.http.post(`${P}/recovery/verify`).send({ token: link, recoveryCode: u.recoveryCodes[0] }).expect(200);
    const fresh = buildRegistration(u.email);
    const body: T.RecoveryResetAccountRequest = {
      recoveryToken: v.body.recoveryToken,
      confirmation: 'DELETE MY VAULT DATA',
      kdf: fresh.body.kdf,
      authKey: fresh.body.authKey,
      keys: fresh.body.keys,
      personalVault: fresh.body.personalVault,
    };
    await ctx.http.post(`${P}/recovery/reset-account`).send({ ...body, confirmation: 'yes' }).expect(400);
    await ctx.http.post(`${P}/recovery/reset-account`).send(body).expect(204);
    await ctx.http.get(`${P}/account`).set(auth(u.token)).expect(401);

    const tomb = await ctx.prisma.record.findUniqueOrThrow({ where: { id: rec.id } });
    expect(tomb.deletedAt).not.toBeNull();
    expect(tomb.encryptedPayload).toBeNull();
    expect((await ctx.prisma.vault.findUniqueOrThrow({ where: { id: owned.vaultId } })).deletedAt).not.toBeNull();
    expect((await ctx.prisma.record.findUniqueOrThrow({ where: { id: ownedRec.id } })).deletedAt).not.toBeNull();
    const friendView = await ctx.http.get(`${P}/vaults`).set(auth(friend.token)).expect(200);
    expect(friendView.body.map((x: T.VaultMembershipDto) => x.vaultId)).not.toContain(owned.vaultId);
    const theirsView = friendView.body.find((x: T.VaultMembershipDto) => x.vaultId === theirs.vaultId);
    expect(theirsView.rotationRequired).toBe(true);

    // MFA stays; new keys are in effect
    const login = await ctx.http.post(`${P}/auth/login`).send(loginBody({ ...u, authKey: fresh.body.authKey })).expect(200);
    expect(login.body.status).toBe('mfa_required');
    const s = await ctx.http.post(`${P}/auth/mfa/verify`).send({ mfaToken: login.body.mfaToken, code: freshTotp(u.totpSecret) }).expect(200);
    expect(s.body.account.keys.publicSigningKey).toBe(fresh.body.keys.publicSigningKey);
    expect(s.body.account.personalVaultId).toBe(fresh.personalVaultId);
    const sync = await ctx.http.get(`${P}/sync?cursor=0`).set(auth(s.body.session.token)).expect(200);
    expect(sync.body.vaults.map((x: T.VaultMembershipDto) => x.vaultId)).toEqual([fresh.personalVaultId]);
    const audit = await ctx.http.get(`${P}/audit-events`).set(auth(s.body.session.token)).expect(200);
    expect(audit.body.data.map((e: T.AuditEventDto) => e.type)).toContain('recovery.account_reset');
    expect(randomUUID()).toBeTruthy();
  });
});
