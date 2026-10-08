import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import { inject, vi } from 'vitest';
import {
  createRegistrationMaterial,
  encryptRecord,
  generateVaultKey,
  grantVaultKey,
  initCrypto,
  wrapVaultKeyForSelf,
  type RegistrationMaterial,
} from '@passvault/crypto';
import type * as T from '@passvault/types';
import { loadConfig, type AppConfig } from '../src/config/config';
import { createApp } from '../src/app.factory';
import { MailService } from '../src/mail/mail.service';
import { JobsService } from '../src/jobs/jobs.service';
import { VaultsService } from '../src/vaults/vaults.service';
import { PrismaService } from '../src/prisma/prisma.service';

export const P = '/api/v1';
export const TEST_KDF = { opsLimit: 2, memLimitBytes: 32 * 1024 * 1024 };

export interface Ctx {
  app: INestApplication;
  http: ReturnType<typeof request>;
  mail: MailService;
  prisma: PrismaService;
  jobs: JobsService;
  vaults: VaultsService;
  logs: string[];
  cfg: AppConfig;
  close: () => Promise<void>;
}

const rnd = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    MFA_ENCRYPTION_KEY: rnd(),
    RECOVERY_CODE_PEPPER: rnd(),
    PRELOGIN_SECRET: rnd(),
    WEB_APP_URL: 'http://localhost:5173',
    MAIL_TRANSPORT: 'memory',
    CORS_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'debug',
    AUTH_HASH_OPSLIMIT: '1',
    AUTH_HASH_MEMLIMIT: '8192',
    RATE_LIMIT_GLOBAL_PER_MINUTE: '100000',
    RATE_LIMIT_AUTH_PER_MINUTE: '100000',
    RATE_LIMIT_EMAIL_PER_15_MINUTES: '100000',
    JOBS_ENABLED: 'false',
    ...overrides,
  });
}

/** Boot the real app (real Postgres), capturing structured log lines. */
export async function boot(overrides: Record<string, string> = {}): Promise<Ctx> {
  await initCrypto();
  // Only Date is faked (so TOTP time steps can be advanced); timers/IO stay real.
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString('utf8'));
      cb();
    },
  });
  const cfg = testConfig(overrides);
  const app = await createApp(cfg, { logStream: stream });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  return {
    app,
    http: request(url.replace('[::1]', '127.0.0.1')),
    mail: app.get(MailService),
    prisma: app.get(PrismaService),
    jobs: app.get(JobsService),
    vaults: app.get(VaultsService),
    logs,
    cfg,
    close: async () => {
      await app.close();
      vi.useRealTimers();
    },
  };
}

export function advance(ms: number): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

export function totp(secret: string): string {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate({
    timestamp: Date.now(),
  });
}

/** Move to the next 30 s step and return a never-used code. */
export function freshTotp(secret: string): string {
  advance(30_000);
  return totp(secret);
}

export function uniqueEmail(tag = 'user'): string {
  return `${tag}-${randomUUID().slice(0, 8)}@example.test`;
}

export interface TestUser {
  email: string;
  name: string;
  password: string;
  material: RegistrationMaterial;
  authKey: string;
  userId: string;
  personalVaultId: string;
  personalVaultKey: Uint8Array;
  deviceId: string;
  token?: string;
  totpSecret?: string;
  recoveryCodes?: string[];
}

export function auth(token: string | undefined): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function mailTokenFor(ctx: Ctx, email: string, path = '/verify-email'): string {
  const msg = [...ctx.mail.outbox].reverse().find((m) => m.to === email && m.text.includes(path));
  if (!msg) throw new Error(`no ${path} mail for ${email}`);
  const m = /#token=([A-Za-z0-9_-]+)/.exec(msg.text);
  if (!m) throw new Error('no token in mail');
  return m[1]!;
}

export async function waitFor<T>(fn: () => T | undefined | null, ms = 2000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function buildRegistration(email: string, name = 'Test User', password = `pw-${randomUUID()}`) {
  const material = createRegistrationMaterial(password, TEST_KDF);
  const personalVaultId = randomUUID();
  const personalVaultKey = generateVaultKey();
  const body: Omit<T.RegisterRequest, 'registrationToken'> = {
    email,
    name,
    kdf: material.kdf,
    authKey: material.authKey,
    keys: material.keys,
    personalVault: { id: personalVaultId, encryptedVaultKey: wrapVaultKeyForSelf(material.unlocked.userKey, personalVaultKey, personalVaultId, 1) },
  };
  return { body, material, password, personalVaultId, personalVaultKey };
}

/** Latest 6-digit registration code mailed to `email` (memory transport). */
export async function registrationCode(ctx: Ctx, email: string, after = 0): Promise<string> {
  const msg = await waitFor(() => {
    const all = ctx.mail.outbox.filter((m) => m.to === email && m.subject === 'Your PassVault verification code');
    return all.length > after ? all[all.length - 1] : undefined;
  });
  return /^\s+(\d{6})$/m.exec(msg.text)![1]!;
}

/** register/start -> code from mail -> register/verify -> registrationToken */
export async function registrationToken(ctx: Ctx, email: string): Promise<string> {
  const before = ctx.mail.outbox.filter((m) => m.to === email && m.subject === 'Your PassVault verification code').length;
  await ctx.http.post(`${P}/auth/register/start`).send({ email }).expect(202);
  const code = await registrationCode(ctx, email, before);
  const v = await ctx.http.post(`${P}/auth/register/verify`).send({ email, code }).expect(200);
  return v.body.registrationToken;
}

/** Full email-verified registration (account is created already verified). */
export async function registerVerified(ctx: Ctx, tag = 'user'): Promise<TestUser> {
  const email = uniqueEmail(tag);
  const r = buildRegistration(email);
  const token = await registrationToken(ctx, email);
  const res = await ctx.http.post(`${P}/auth/register`).send({ ...r.body, registrationToken: token }).expect(201);
  return {
    email,
    name: 'Test User',
    password: r.password,
    material: r.material,
    authKey: r.material.authKey,
    userId: res.body.userId,
    personalVaultId: r.personalVaultId,
    personalVaultKey: r.personalVaultKey,
    deviceId: randomUUID(),
  };
}

export function loginBody(u: TestUser, extra: Partial<T.LoginRequest> = {}): T.LoginRequest {
  return { email: u.email, authKey: u.authKey, device: { id: u.deviceId, name: 'vitest', clientType: 'web' }, ...extra };
}

/** Full onboarding: register, verify, login, enroll TOTP -> active session. */
export async function onboard(ctx: Ctx, tag = 'user'): Promise<TestUser & { token: string; totpSecret: string; recoveryCodes: string[] }> {
  const u = await registerVerified(ctx, tag);
  const login = await ctx.http.post(`${P}/auth/login`).send(loginBody(u)).expect(200);
  const start = await ctx.http.post(`${P}/auth/mfa/enroll/start`).send({ mfaToken: login.body.mfaToken }).expect(200);
  const confirm = await ctx.http
    .post(`${P}/auth/mfa/enroll/confirm`)
    .send({ mfaToken: login.body.mfaToken, code: freshTotp(start.body.secret) })
    .expect(200);
  return { ...u, token: confirm.body.session.token, totpSecret: start.body.secret, recoveryCodes: confirm.body.recoveryCodes };
}

export async function reauth(ctx: Ctx, u: TestUser & { token: string; totpSecret: string }): Promise<void> {
  await ctx.http.post(`${P}/auth/reauth`).set(auth(u.token)).send({ authKey: u.authKey, code: freshTotp(u.totpSecret) }).expect(200);
}

export function newRecord(vaultId: string, vaultKey: Uint8Array, payload: unknown = { title: 'secret', password: 'hunter2' }, id = randomUUID()) {
  const enc = encryptRecord({ recordId: id, vaultId, vaultKey, payload });
  const body: T.CreateRecordRequest = {
    id,
    vaultId,
    kind: 'item',
    formatVersion: enc.formatVersion,
    encryptedKey: enc.encryptedKey,
    encryptedPayload: enc.encryptedPayload,
    mutationId: randomUUID(),
  };
  return { id, body, itemKey: enc.itemKey };
}

export async function createSharedVault(ctx: Ctx, owner: TestUser & { token: string }, allowResharing = false) {
  const vaultId = randomUUID();
  const vaultKey = generateVaultKey();
  const grant = grantVaultKey({
    vaultKey,
    vaultId,
    keyVersion: 1,
    recipientUserId: owner.userId,
    recipientPublicEncryptionKey: owner.material.keys.publicEncryptionKey,
    grantor: owner.material.unlocked,
  });
  const res = await ctx.http
    .post(`${P}/vaults`)
    .set(auth(owner.token))
    .send({ id: vaultId, kind: 'item', allowResharing, encryptedVaultKey: grant.encryptedVaultKey, keySignature: grant.keySignature })
    .expect(201);
  return { vaultId, vaultKey, membership: res.body as T.VaultMembershipDto };
}

export function inviteBody(
  vault: { vaultId: string; vaultKey: Uint8Array },
  grantor: TestUser,
  recipient: TestUser,
  role: T.VaultRole,
  keyVersion = 1,
  expiresAt?: string | null,
): T.InviteMemberRequest {
  const grant = grantVaultKey({
    vaultKey: vault.vaultKey,
    vaultId: vault.vaultId,
    keyVersion,
    recipientUserId: recipient.userId,
    recipientPublicEncryptionKey: recipient.material.keys.publicEncryptionKey,
    grantor: grantor.material.unlocked,
  });
  return { recipientUserId: recipient.userId, role, keyVersion, ...grant, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

/** Owner shares a vault with `recipient` who accepts. */
export async function share(
  ctx: Ctx,
  vault: { vaultId: string; vaultKey: Uint8Array },
  owner: TestUser & { token: string },
  recipient: TestUser & { token: string },
  role: T.VaultRole,
  expiresAt?: string | null,
): Promise<void> {
  await ctx.http.post(`${P}/vaults/${vault.vaultId}/members`).set(auth(owner.token)).send(inviteBody(vault, owner, recipient, role, 1, expiresAt)).expect(201);
  await ctx.http.post(`${P}/invitations/${vault.vaultId}/accept`).set(auth(recipient.token)).send({}).expect(200);
}
