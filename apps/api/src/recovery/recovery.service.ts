import { Injectable, Logger } from '@nestjs/common';
import type { EmailToken } from '@prisma/client';
import type * as T from '@passvault/types';
import type * as V from '@passvault/validation';
import type { z } from 'zod';
import { PrismaService, nextSeq, type Tx } from '../prisma/prisma.service';
import { PasswordHasher } from '../security/password-hasher.service';
import { MailService } from '../mail/mail.service';
import { AuditService } from '../audit/audit.service';
import { EmailLimiter } from '../common/email-limiter.service';
import { E } from '../common/errors';
import { addMinutes, randomToken, sha256Hex } from '../common/util';
import { MfaService } from '../auth/mfa.service';
import { SessionService } from '../auth/session.service';
import { VaultsService } from '../vaults/vaults.service';
import { tombstoneVaultRecords } from '../records/record-ops';
import type { RequestMeta } from '../auth/auth.types';

type In<S extends z.ZodType> = z.output<S>;
const LINK_TTL_MINUTES = 30;
const RECOVERY_TOKEN_TTL_MINUTES = 15;
const MAX_TOKEN_ATTEMPTS = 5;

/**
 * Account recovery (docs/API.md "Recovery", docs/CRYPTO.md "Recovery").
 * Step 1: emailed link token (proves mailbox). Step 2: + MFA (TOTP or MFA
 * recovery code) -> short-lived recoveryToken. Step 3a: complete-vault proves
 * possession of the vault recovery key (recoveryAuthKey). Step 3b: reset-account
 * destroys vault data and installs new keys.
 */
@Injectable()
export class RecoveryService {
  private readonly logger = new Logger('Recovery');

  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly limiter: EmailLimiter,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly vaults: VaultsService,
  ) {}

  async start(body: In<typeof V.recoveryStartRequest>, meta: RequestMeta): Promise<void> {
    this.limiter.hit('recovery', body.email, 5);
    const user = await this.prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !user.emailVerifiedAt || !(await this.mfa.isEnabled(user.id))) return;
    const token = randomToken(32);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.emailToken.updateMany({ where: { userId: user.id, purpose: { in: ['recovery', 'recovery_verified'] }, usedAt: null }, data: { usedAt: now } });
      await tx.emailToken.create({ data: { userId: user.id, purpose: 'recovery', tokenHash: sha256Hex(token), expiresAt: addMinutes(now, LINK_TTL_MINUTES) } });
      await this.audit.record({ type: 'recovery.started', subjectUserId: user.id, meta }, tx);
    });
    this.mail.sendInBackground(this.mail.recoveryEmail(user.email, token));
  }

  private async liveToken(token: string, purpose: 'recovery' | 'recovery_verified'): Promise<EmailToken> {
    const t = await this.prisma.emailToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!t || t.purpose !== purpose || t.usedAt || t.expiresAt <= new Date() || t.attempts >= MAX_TOKEN_ATTEMPTS) {
      throw E.unauthenticated('The recovery link is invalid or expired; start again');
    }
    return t;
  }

  private async failToken(t: EmailToken): Promise<void> {
    const u = await this.prisma.emailToken.update({ where: { id: t.id }, data: { attempts: { increment: 1 } } });
    if (u.attempts >= MAX_TOKEN_ATTEMPTS) await this.prisma.emailToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
  }

  private async consume(tx: Tx, t: EmailToken): Promise<void> {
    const r = await tx.emailToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
    if (r.count !== 1) throw E.unauthenticated('The recovery link is invalid or expired; start again');
  }

  async verify(body: In<typeof V.recoveryVerifyRequest>, meta: RequestMeta): Promise<T.RecoveryVerifyResponse> {
    const t = await this.liveToken(body.token, 'recovery');
    const r = await this.mfa.verifySecondFactor(t.userId, { code: body.code, recoveryCode: body.recoveryCode });
    if (!r.ok) {
      await this.failToken(t);
      await this.audit.record({ type: 'auth.mfa_failed', subjectUserId: t.userId, meta, metadata: { context: 'recovery' } });
      throw E.mfaInvalid(401);
    }
    const recoveryToken = randomToken(32);
    const expiresAt = addMinutes(new Date(), RECOVERY_TOKEN_TTL_MINUTES);
    const user = await this.prisma.$transaction(async (tx) => {
      await this.consume(tx, t);
      await tx.emailToken.create({ data: { userId: t.userId, purpose: 'recovery_verified', tokenHash: sha256Hex(recoveryToken), expiresAt } });
      if (r.usedRecoveryCode) {
        await this.audit.record({ type: 'auth.recovery_code_used', actorUserId: t.userId, subjectUserId: t.userId, meta, metadata: { context: 'recovery' } }, tx);
      }
      return tx.user.findUniqueOrThrow({ where: { id: t.userId } });
    });
    return {
      recoveryToken,
      expiresAt: expiresAt.toISOString(),
      encryptedUserKeyByRecovery: user.encryptedUserKeyByRecovery,
      keys: {
        publicEncryptionKey: user.publicEncryptionKey,
        encryptedPrivateEncryptionKey: user.encryptedPrivateEncryptionKey,
        publicSigningKey: user.publicSigningKey,
        encryptedPrivateSigningKey: user.encryptedPrivateSigningKey,
        publicKeySignature: user.publicKeySignature,
      },
    };
  }

  async completeVault(body: In<typeof V.recoveryCompleteVaultRequest>, meta: RequestMeta): Promise<void> {
    const t = await this.liveToken(body.recoveryToken, 'recovery_verified');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: t.userId } });
    // Proof of possession of the vault recovery key: email + MFA alone must not be enough.
    if (!this.hasher.verify(user.recoveryAuthKeyHash, body.recoveryAuthKey)) {
      await this.failToken(t);
      await this.audit.record({ type: 'auth.login_failed', subjectUserId: user.id, meta, metadata: { reason: 'invalid_recovery_key' } });
      throw E.invalidCredentials();
    }
    const authKeyHash = this.hasher.hash(body.authKey);
    const recoveryAuthKeyHash = this.hasher.hash(body.newRecoveryAuthKey);
    await this.prisma.$transaction(async (tx) => {
      await this.consume(tx, t);
      await tx.user.update({
        where: { id: user.id },
        data: {
          authKeyHash,
          kdfAlgorithm: body.kdf.algorithm,
          kdfVersion: body.kdf.version,
          kdfOpsLimit: body.kdf.opsLimit,
          kdfMemLimitBytes: body.kdf.memLimitBytes,
          kdfSalt: body.kdf.salt,
          encryptedUserKey: body.encryptedUserKey,
          encryptedUserKeyByRecovery: body.newEncryptedUserKeyByRecovery,
          recoveryAuthKeyHash,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await this.mfa.rotateSecurityStamp(user.id, tx);
      await this.sessions.revoke({ userId: user.id }, 'account_recovered', tx);
      await tx.emailToken.updateMany({ where: { userId: user.id, purpose: { in: ['recovery', 'recovery_verified'] }, usedAt: null }, data: { usedAt: new Date() } });
      await this.audit.record({ type: 'recovery.vault_recovered', actorUserId: user.id, subjectUserId: user.id, meta }, tx);
    });
  }

  async resetAccount(body: In<typeof V.recoveryResetAccountRequest>, meta: RequestMeta): Promise<void> {
    const t = await this.liveToken(body.recoveryToken, 'recovery_verified');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: t.userId } });
    const authKeyHash = this.hasher.hash(body.authKey);
    const recoveryAuthKeyHash = this.hasher.hash(body.keys.recoveryAuthKey);
    const oldVaultId = user.personalVaultId!;
    const newVaultId = body.personalVault.id;
    await this.prisma.seqTx(async (tx) => {
      await this.consume(tx, t);
      if (newVaultId !== oldVaultId && (await tx.vault.findUnique({ where: { id: newVaultId }, select: { id: true } }))) {
        throw E.alreadyExists('Vault id is already in use');
      }
      const now = new Date();
      // 1. personal vault: all records tombstoned (data is unrecoverable by design)
      const tombstoned = await tombstoneVaultRecords(tx, oldVaultId, user.id);
      // 2. shared vaults: owned (sole owner) -> deleted; otherwise membership revoked (+ rotation required)
      const memberships = await tx.vaultMember.findMany({
        where: { userId: user.id, status: { in: ['accepted', 'invited'] }, vault: { type: 'shared', deletedAt: null } },
        include: { vault: true },
      });
      let deletedVaults = 0;
      for (const m of memberships) {
        const otherOwners = await tx.vaultMember.count({ where: { vaultId: m.vaultId, role: 'owner', status: 'accepted', NOT: { userId: user.id } } });
        if (m.role === 'owner' && m.status === 'accepted' && otherOwners === 0) {
          await this.vaults.deleteVaultInTx(tx, m.vaultId, user.id);
          deletedVaults++;
        } else {
          await tx.vaultMember.update({
            where: { vaultId_userId: { vaultId: m.vaultId, userId: user.id } },
            data: { status: 'revoked', revokedAt: now, seq: await nextSeq(tx) },
          });
          await tx.vault.update({ where: { id: m.vaultId }, data: { rotationRequired: true, seq: await nextSeq(tx) } });
          await this.vaults.fixOwnerId(tx, m.vaultId);
        }
      }
      // 3. new personal vault grant
      if (newVaultId === oldVaultId) {
        await tx.vault.update({ where: { id: oldVaultId }, data: { keyVersion: 1, rotationRequired: false, seq: await nextSeq(tx) } });
        await tx.vaultMember.update({
          where: { vaultId_userId: { vaultId: oldVaultId, userId: user.id } },
          data: { keyVersion: 1, encryptedVaultKey: body.personalVault.encryptedVaultKey, keySignature: null, seq: await nextSeq(tx) },
        });
      } else {
        await tx.vaultMember.update({
          where: { vaultId_userId: { vaultId: oldVaultId, userId: user.id } },
          data: { status: 'revoked', revokedAt: now, seq: await nextSeq(tx) },
        });
        await tx.vault.update({ where: { id: oldVaultId }, data: { deletedAt: now, seq: await nextSeq(tx) } });
        await tx.vault.create({ data: { id: newVaultId, type: 'personal', ownerId: user.id, keyVersion: 1, seq: await nextSeq(tx) } });
        await tx.vaultMember.create({
          data: {
            vaultId: newVaultId,
            userId: user.id,
            role: 'owner',
            status: 'accepted',
            keyVersion: 1,
            encryptedVaultKey: body.personalVault.encryptedVaultKey,
            keySignature: null,
            acceptedAt: now,
            seq: await nextSeq(tx),
          },
        });
      }
      // 4. new account keys
      await tx.user.update({
        where: { id: user.id },
        data: {
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
          personalVaultId: newVaultId,
          encryptedSettings: null,
          settingsRevision: { increment: 1 },
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await this.mfa.rotateSecurityStamp(user.id, tx);
      await this.sessions.revoke({ userId: user.id }, 'account_reset', tx);
      await tx.emailToken.updateMany({ where: { userId: user.id, purpose: { in: ['recovery', 'recovery_verified'] }, usedAt: null }, data: { usedAt: now } });
      await this.audit.record(
        { type: 'recovery.account_reset', actorUserId: user.id, subjectUserId: user.id, meta, metadata: { tombstonedRecords: tombstoned, deletedVaults, revokedMemberships: memberships.length - deletedVaults } },
        tx,
      );
    });
    this.logger.warn({ userId: user.id }, 'account reset via recovery (vault data destroyed)');
  }
}
