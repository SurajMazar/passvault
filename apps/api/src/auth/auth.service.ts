import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Device, User } from '@prisma/client';
import type * as T from '@passvault/types';
import type { z } from 'zod';
import type * as V from '@passvault/validation';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService, isUniqueViolation, nextSeq } from '../prisma/prisma.service';
import { PasswordHasher } from '../security/password-hasher.service';
import { SecretsService } from '../security/secrets.service';
import { MailService } from '../mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { EmailLimiter, WINDOW_HOUR } from '../common/email-limiter.service';
import { E } from '../common/errors';
import { accountBundle, deviceTrusted, sessionDto } from '../common/dto';
import { addMinutes, maskEmail, randomToken, safeEqualHex, sha256Hex } from '../common/util';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';
import { UnknownAccountLockout } from './unknown-account-lockout.service';
import type { AuthContext, RequestMeta } from './auth.types';

export const REGISTRATION_CODE_TTL_MINUTES = 15;
export const REGISTRATION_TOKEN_TTL_MINUTES = 30;
export const MAX_REGISTRATION_ATTEMPTS = 5;
export const TRUSTED_DEVICE_DAYS = 30;
const FAKE_KDF = { opsLimit: 3, memLimitBytes: 64 * 1024 * 1024 } as const;

type In<S extends z.ZodType> = z.output<S>;

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly secrets: SecretsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly limiter: EmailLimiter,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly unknownLockout: UnknownAccountLockout,
  ) {}

  // ---------------------------------------------------------------- prelogin

  async prelogin(body: In<typeof V.preloginRequest>): Promise<T.PreloginResponse> {
    this.limiter.hit('prelogin', body.email, this.cfg.RATE_LIMIT_EMAIL_PER_15_MINUTES * 3);
    const u = await this.prisma.user.findUnique({
      where: { email: body.email },
      select: { kdfOpsLimit: true, kdfMemLimitBytes: true, kdfSalt: true },
    });
    if (u) {
      return { kdf: { algorithm: 'argon2id', version: 1, opsLimit: u.kdfOpsLimit, memLimitBytes: u.kdfMemLimitBytes, salt: u.kdfSalt } };
    }
    // Deterministic per email, shaped exactly like a real record (no enumeration).
    return { kdf: { algorithm: 'argon2id', version: 1, ...FAKE_KDF, salt: this.secrets.fakeSalt(body.email) } };
  }

  // ---------------------------------------------------------------- registration
  //
  // Email ownership is proven BEFORE an account exists:
  //   register/start  -> 6-digit code by email (HMAC stored, 15 min, 5 attempts)
  //   register/verify -> single-use registrationToken (SHA-256 stored, 30 min)
  //   register        -> consumes the token, creates the (verified) account

  async registerStart(body: In<typeof V.registerStartRequest>, meta: RequestMeta): Promise<void> {
    this.limiter.hit('register-start', body.email, 5, WINDOW_HOUR);
    const existing = await this.prisma.user.findUnique({ where: { email: body.email }, select: { id: true } });
    if (existing) {
      // identical response; the owner gets a notice instead of a code
      this.logger.log({ emailHint: maskEmail(body.email) }, 'registration start for existing account (notice sent)');
      this.mail.sendInBackground(this.mail.alreadyRegisteredEmail(body.email));
      return;
    }
    const code = this.secrets.newRegistrationCode();
    const now = new Date();
    const data = {
      codeHash: this.secrets.registrationCodeHash(body.email, code),
      attempts: 0,
      expiresAt: addMinutes(now, REGISTRATION_CODE_TTL_MINUTES),
      verifiedAt: null,
      tokenHash: null,
      tokenExpiresAt: null,
      usedAt: null,
      createdAt: now,
    };
    await this.prisma.pendingRegistration.upsert({ where: { email: body.email }, create: { email: body.email, ...data }, update: data });
    await this.audit.record({ type: 'user.registration_started', meta, metadata: { emailHint: maskEmail(body.email) } });
    this.mail.sendInBackground(this.mail.registrationCodeEmail(body.email, code));
  }

  async registerVerify(body: In<typeof V.registerVerifyRequest>): Promise<T.RegisterVerifyResponse> {
    this.limiter.hit('register-verify', body.email, 20, WINDOW_HOUR);
    const now = new Date();
    const p = await this.prisma.pendingRegistration.findUnique({ where: { email: body.email } });
    if (!p || p.verifiedAt || p.usedAt || p.expiresAt <= now || p.attempts >= MAX_REGISTRATION_ATTEMPTS) {
      throw E.invalidCode('The code is invalid or expired; request a new one');
    }
    if (!safeEqualHex(this.secrets.registrationCodeHash(body.email, body.code), p.codeHash)) {
      await this.prisma.pendingRegistration.updateMany({ where: { id: p.id, attempts: { lt: MAX_REGISTRATION_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
      throw E.invalidCode();
    }
    const token = randomToken(32);
    const expiresAt = addMinutes(now, REGISTRATION_TOKEN_TTL_MINUTES);
    const r = await this.prisma.pendingRegistration.updateMany({
      where: { id: p.id, verifiedAt: null, usedAt: null, attempts: { lt: MAX_REGISTRATION_ATTEMPTS }, expiresAt: { gt: now } },
      data: { verifiedAt: now, tokenHash: sha256Hex(token), tokenExpiresAt: expiresAt },
    });
    if (r.count !== 1) throw E.invalidCode('The code is invalid or expired; request a new one');
    return { registrationToken: token, expiresAt: expiresAt.toISOString() };
  }

  async register(body: In<typeof V.registerRequest>, meta: RequestMeta): Promise<T.RegisterResponse> {
    this.limiter.hit('register', body.email);
    const pending = await this.prisma.pendingRegistration.findUnique({ where: { tokenHash: sha256Hex(body.registrationToken) } });
    const now = new Date();
    if (!pending || pending.email !== body.email || !pending.verifiedAt || pending.usedAt || !pending.tokenExpiresAt || pending.tokenExpiresAt <= now) {
      throw E.invalidCode('The registration token is invalid, expired or for another email address');
    }
    const authKeyHash = this.hasher.hash(body.authKey);
    const recoveryAuthKeyHash = this.hasher.hash(body.keys.recoveryAuthKey);
    const userId = randomUUID();
    try {
      await this.prisma.seqTx(async (tx) => {
        const consumed = await tx.pendingRegistration.updateMany({
          where: { id: pending.id, usedAt: null, tokenHash: pending.tokenHash, tokenExpiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (consumed.count !== 1) throw E.invalidCode('The registration token was already used');
        if (await tx.user.findUnique({ where: { email: body.email }, select: { id: true } })) {
          throw E.alreadyExists('An account with this email already exists');
        }
        if (await tx.vault.findUnique({ where: { id: body.personalVault.id }, select: { id: true } })) {
          throw E.alreadyExists('Vault id is already in use');
        }
        await tx.user.create({
          data: {
            id: userId,
            email: body.email,
            name: body.name,
            emailVerifiedAt: now,
            authKeyHash,
            kdfAlgorithm: body.kdf.algorithm,
            kdfVersion: body.kdf.version,
            kdfOpsLimit: body.kdf.opsLimit,
            kdfMemLimitBytes: body.kdf.memLimitBytes,
            kdfSalt: body.kdf.salt,
            encryptedUserKey: body.keys.encryptedUserKey,
            encryptedUserKeyByRecovery: body.keys.encryptedUserKeyByRecovery,
            recoveryAuthKeyHash,
            publicEncryptionKey: body.keys.publicEncryptionKey,
            encryptedPrivateEncryptionKey: body.keys.encryptedPrivateEncryptionKey,
            publicSigningKey: body.keys.publicSigningKey,
            encryptedPrivateSigningKey: body.keys.encryptedPrivateSigningKey,
            publicKeySignature: body.keys.publicKeySignature,
            personalVaultId: body.personalVault.id,
            securityStamp: randomToken(16),
          },
        });
        await tx.vault.create({
          data: { id: body.personalVault.id, type: 'personal', ownerId: userId, keyVersion: 1, seq: await nextSeq(tx) },
        });
        await tx.vaultMember.create({
          data: {
            vaultId: body.personalVault.id,
            userId,
            role: 'owner',
            status: 'accepted',
            keyVersion: 1,
            encryptedVaultKey: body.personalVault.encryptedVaultKey,
            keySignature: null,
            acceptedAt: now,
            seq: await nextSeq(tx),
          },
        });
        await this.audit.record({ type: 'user.registered', actorUserId: userId, subjectUserId: userId, meta }, tx);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw E.alreadyExists('An account with this email already exists');
      throw e;
    }
    return { userId };
  }

  // ---------------------------------------------------------------- login

  async login(body: In<typeof V.loginRequest>, meta: RequestMeta): Promise<T.LoginResponse> {
    this.limiter.hit('login', body.email);
    const user = await this.prisma.user.findUnique({ where: { email: body.email } });
    if (!user) {
      // Answer exactly like a real account would, including its lockout (PV-SEC-001).
      this.hasher.verifyDummy(body.authKey);
      if (this.unknownLockout.isLocked(body.email)) throw E.rateLimited('Too many failed attempts; try again later');
      this.unknownLockout.recordFailure(body.email);
      this.logger.warn({ emailHint: maskEmail(body.email) }, 'login failed (unknown account)');
      throw E.invalidCredentials();
    }
    await this.checkCredentials(user, body.authKey, meta);

    const now = new Date();
    const device = await this.prisma.device.upsert({
      where: { userId_clientDeviceId: { userId: user.id, clientDeviceId: body.device.id } },
      create: { userId: user.id, clientDeviceId: body.device.id, name: body.device.name, clientType: body.device.clientType },
      update: { name: body.device.name, clientType: body.device.clientType, lastSeenAt: now },
    });
    const mfaEnabled = await this.mfa.isEnabled(user.id);
    const deviceMeta = { ...meta, deviceId: device.clientDeviceId };

    if (mfaEnabled && body.trustedDeviceToken && this.trustedTokenValid(device, user, body.trustedDeviceToken)) {
      const { token, session } = await this.sessions.create(this.prisma, { userId: user.id, deviceId: device.id, state: 'active', meta: deviceMeta });
      await this.audit.record({ type: 'auth.login_succeeded', actorUserId: user.id, subjectUserId: user.id, meta: deviceMeta, metadata: { method: 'trusted_device' } });
      return { status: 'ok', session: sessionDto(token, session, this.cfg.SESSION_IDLE_MINUTES), account: accountBundle(user, true) };
    }
    const state = mfaEnabled ? 'pending_mfa' : 'pending_enrollment';
    const { token, session } = await this.sessions.create(this.prisma, { userId: user.id, deviceId: device.id, state, meta: deviceMeta });
    return {
      status: mfaEnabled ? 'mfa_required' : 'mfa_enrollment_required',
      mfaToken: token,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  private trustedTokenValid(device: Device, user: User, token: string): boolean {
    return deviceTrusted(device, user) && safeEqualHex(sha256Hex(token), device.trustedTokenHash!);
  }

  /**
   * authKey check with progressive lockout. Throws invalid_credentials /
   * rate_limited. `status` lets in-session callers (reauth) avoid a 401 which
   * clients treat as "signed out".
   */
  async checkCredentials(user: User, authKey: string, meta: RequestMeta, status = 401): Promise<void> {
    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      this.hasher.verifyDummy(authKey);
      await this.audit.record({ type: 'auth.login_failed', subjectUserId: user.id, meta, metadata: { reason: 'locked' } });
      throw E.rateLimited('Too many failed attempts; try again later');
    }
    if (!this.hasher.verify(user.authKeyHash, authKey)) {
      const u = await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: { increment: 1 } } });
      const over = u.failedLoginCount - this.cfg.LOGIN_LOCKOUT_THRESHOLD;
      if (over >= 0) {
        const minutes = Math.min(this.cfg.LOGIN_LOCKOUT_MINUTES * 2 ** Math.floor(over / 5), 24 * 60);
        await this.prisma.user.update({ where: { id: user.id }, data: { lockedUntil: addMinutes(now, minutes) } });
      }
      await this.audit.record({
        type: 'auth.login_failed',
        subjectUserId: user.id,
        meta,
        metadata: { reason: 'invalid_credentials', failedCount: u.failedLoginCount },
      });
      throw E.invalidCredentials(status);
    }
    const data: { failedLoginCount?: number; lockedUntil?: null; authKeyHash?: string } = {};
    if (user.failedLoginCount > 0 || user.lockedUntil) Object.assign(data, { failedLoginCount: 0, lockedUntil: null });
    if (this.hasher.needsRehash(user.authKeyHash)) data.authKeyHash = this.hasher.hash(authKey);
    if (Object.keys(data).length) await this.prisma.user.update({ where: { id: user.id }, data });
  }

  // ---------------------------------------------------------------- MFA

  async mfaVerify(body: In<typeof V.mfaVerifyRequest>, meta: RequestMeta): Promise<T.MfaVerifyResponse> {
    const pending = await this.sessions.resolvePending(body.mfaToken, 'pending_mfa');
    const deviceMeta = { ...meta, deviceId: pending.device.clientDeviceId };
    const r = await this.mfa.verifySecondFactor(pending.userId, { code: body.code, recoveryCode: body.recoveryCode });
    if (!r.ok) {
      const remaining = await this.sessions.failPendingAttempt(pending.id);
      await this.audit.record({
        type: 'auth.mfa_failed',
        subjectUserId: pending.userId,
        meta: deviceMeta,
        metadata: { method: r.usedRecoveryCode ? 'recovery_code' : 'totp', attemptsRemaining: Math.max(0, remaining) },
      });
      throw E.mfaInvalid(401);
    }
    return this.prisma.$transaction(async (tx) => {
      const upgraded = await tx.session.updateMany({ where: { id: pending.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'mfa_completed' } });
      if (upgraded.count !== 1) throw E.unauthenticated('The sign-in attempt expired; please sign in again');
      const user = await tx.user.findUniqueOrThrow({ where: { id: pending.userId } });
      const { token, session } = await this.sessions.create(tx, { userId: user.id, deviceId: pending.deviceId, state: 'active', meta: deviceMeta });
      let trustedDeviceToken: string | undefined;
      if (body.trustDevice) {
        trustedDeviceToken = randomToken(32);
        await tx.device.update({
          where: { id: pending.deviceId },
          data: {
            trustedTokenHash: sha256Hex(trustedDeviceToken),
            trustedStamp: user.securityStamp,
            trustedUntil: addMinutes(new Date(), TRUSTED_DEVICE_DAYS * 24 * 60),
          },
        });
      }
      const method = r.usedRecoveryCode ? 'recovery_code' : 'totp';
      await this.audit.record({ type: 'auth.login_succeeded', actorUserId: user.id, subjectUserId: user.id, meta: deviceMeta, metadata: { method, trustDevice: Boolean(body.trustDevice) } }, tx);
      const res: T.MfaVerifyResponse = {
        session: sessionDto(token, session, this.cfg.SESSION_IDLE_MINUTES),
        account: accountBundle(user, true),
      };
      if (trustedDeviceToken) res.trustedDeviceToken = trustedDeviceToken;
      if (r.usedRecoveryCode) {
        res.remainingRecoveryCodes = await this.mfa.remainingRecoveryCodes(user.id, tx);
        await this.audit.record({ type: 'auth.recovery_code_used', actorUserId: user.id, subjectUserId: user.id, meta: deviceMeta, metadata: { remaining: res.remainingRecoveryCodes } }, tx);
      }
      return res;
    });
  }

  async enrollStart(target: { pendingToken?: string; auth?: AuthContext }): Promise<T.MfaEnrollStartResponse> {
    const user = target.pendingToken ? (await this.sessions.resolvePending(target.pendingToken, 'pending_enrollment')).user : target.auth!.user;
    return this.mfa.startEnrollment(user);
  }

  async enrollConfirm(
    body: In<typeof V.mfaEnrollConfirmRequest>,
    target: { auth?: AuthContext },
    meta: RequestMeta,
  ): Promise<T.MfaEnrollConfirmResponse> {
    if (body.mfaToken) {
      const pending = await this.sessions.resolvePending(body.mfaToken, 'pending_enrollment');
      const deviceMeta = { ...meta, deviceId: pending.device.clientDeviceId };
      const out = await this.prisma.$transaction(async (tx) => {
        const codes = await this.mfa.confirmEnrollment(pending.userId, body.code, tx);
        if (!codes) return null;
        const upgraded = await tx.session.updateMany({ where: { id: pending.id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'mfa_enrolled' } });
        if (upgraded.count !== 1) throw E.unauthenticated('The sign-in attempt expired; please sign in again');
        const user = await tx.user.findUniqueOrThrow({ where: { id: pending.userId } });
        const { token, session } = await this.sessions.create(tx, { userId: user.id, deviceId: pending.deviceId, state: 'active', meta: deviceMeta });
        await this.audit.record({ type: 'auth.mfa_enrolled', actorUserId: user.id, subjectUserId: user.id, meta: deviceMeta }, tx);
        await this.audit.record({ type: 'auth.login_succeeded', actorUserId: user.id, subjectUserId: user.id, meta: deviceMeta, metadata: { method: 'mfa_enrollment' } }, tx);
        return {
          recoveryCodes: codes,
          session: sessionDto(token, session, this.cfg.SESSION_IDLE_MINUTES),
          account: accountBundle(user, true),
        } satisfies T.MfaEnrollConfirmResponse;
      });
      if (!out) {
        await this.sessions.failPendingAttempt(pending.id);
        await this.audit.record({ type: 'auth.mfa_failed', subjectUserId: pending.userId, meta: deviceMeta, metadata: { method: 'enrollment' } });
        throw E.mfaInvalid(401);
      }
      return out;
    }
    const auth = target.auth!;
    const codes = await this.prisma.$transaction(async (tx) => {
      const c = await this.mfa.confirmEnrollment(auth.user.id, body.code, tx);
      if (c) await this.audit.record({ type: 'auth.mfa_enrolled', actorUserId: auth.user.id, subjectUserId: auth.user.id, meta, metadata: { reenrollment: true } }, tx);
      return c;
    });
    if (!codes) throw E.mfaInvalid(403);
    return { recoveryCodes: codes };
  }

  // ---------------------------------------------------------------- reauth / logout

  async reauth(auth: AuthContext, body: In<typeof V.reauthRequest>, meta: RequestMeta): Promise<T.ReauthResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    await this.checkCredentials(user, body.authKey, meta, 403);
    const r = await this.mfa.verifySecondFactor(user.id, { code: body.code });
    if (!r.ok) {
      await this.audit.record({ type: 'auth.mfa_failed', subjectUserId: user.id, meta, metadata: { method: 'totp', context: 'reauth' } });
      throw E.mfaInvalid(403);
    }
    const until = await this.sessions.setReauth(auth.session.id);
    await this.audit.record({ type: 'auth.reauthenticated', actorUserId: user.id, subjectUserId: user.id, meta });
    return { reauthUntil: until.toISOString() };
  }

  async logout(auth: AuthContext, meta: RequestMeta): Promise<void> {
    await this.sessions.revoke({ id: auth.session.id }, 'logout');
    await this.audit.record({ type: 'session.revoked', actorUserId: auth.user.id, subjectUserId: auth.user.id, meta, metadata: { reason: 'logout' } });
  }

  async logoutAll(auth: AuthContext, meta: RequestMeta): Promise<void> {
    const n = await this.sessions.revoke({ userId: auth.user.id }, 'logout_all');
    await this.audit.record({ type: 'session.revoked_all', actorUserId: auth.user.id, subjectUserId: auth.user.id, meta, metadata: { count: n } });
  }
}
