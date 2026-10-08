import { Injectable } from '@nestjs/common';
import type { MfaEnrollment, User } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { SecretsService } from '../security/secrets.service';
import { randomToken } from '../common/util';

export interface SecondFactor {
  code?: string;
  recoveryCode?: string;
}

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
  ) {}

  activeEnrollment(userId: string, tx?: Tx): Promise<MfaEnrollment | null> {
    return (tx ?? this.prisma).mfaEnrollment.findFirst({ where: { userId, status: 'active' }, orderBy: { activatedAt: 'desc' } });
  }

  async isEnabled(userId: string, tx?: Tx): Promise<boolean> {
    return (await (tx ?? this.prisma).mfaEnrollment.count({ where: { userId, status: 'active' } })) > 0;
  }

  /** TOTP check with replay protection: the matched step must be newer than lastUsedStep (atomic). */
  async verifyTotp(enrollment: MfaEnrollment, code: string, tx?: Tx): Promise<boolean> {
    let secret: string;
    try {
      secret = this.secrets.decryptMfaSecret(enrollment.userId, enrollment.encryptedSecret);
    } catch {
      return false;
    }
    const step = this.secrets.matchTotp(secret, code);
    if (step === null) return false;
    const r = await (tx ?? this.prisma).mfaEnrollment.updateMany({
      where: { id: enrollment.id, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
      data: { lastUsedStep: step },
    });
    return r.count === 1;
  }

  /** Single-use recovery code (atomic: only succeeds while usedAt IS NULL). */
  async consumeRecoveryCode(userId: string, code: string, tx?: Tx): Promise<boolean> {
    const r = await (tx ?? this.prisma).recoveryCode.updateMany({
      where: { userId, codeHash: this.secrets.recoveryCodeHash(code), usedAt: null },
      data: { usedAt: new Date() },
    });
    return r.count === 1;
  }

  remainingRecoveryCodes(userId: string, tx?: Tx): Promise<number> {
    return (tx ?? this.prisma).recoveryCode.count({ where: { userId, usedAt: null } });
  }

  /** Verify a TOTP code or a recovery code. */
  async verifySecondFactor(userId: string, f: SecondFactor, tx?: Tx): Promise<{ ok: boolean; usedRecoveryCode: boolean }> {
    if (f.recoveryCode) {
      return { ok: await this.consumeRecoveryCode(userId, f.recoveryCode, tx), usedRecoveryCode: true };
    }
    if (!f.code) return { ok: false, usedRecoveryCode: false };
    const e = await this.activeEnrollment(userId, tx);
    return { ok: e ? await this.verifyTotp(e, f.code, tx) : false, usedRecoveryCode: false };
  }

  async startEnrollment(user: User): Promise<{ secret: string; otpauthUri: string }> {
    const secret = this.secrets.newTotpSecret();
    await this.prisma.$transaction([
      this.prisma.mfaEnrollment.deleteMany({ where: { userId: user.id, status: 'pending' } }),
      this.prisma.mfaEnrollment.create({
        data: { userId: user.id, status: 'pending', encryptedSecret: this.secrets.encryptMfaSecret(user.id, secret) },
      }),
    ]);
    return { secret, otpauthUri: this.secrets.otpauthUri(secret, user.email) };
  }

  /**
   * Activate the pending TOTP enrollment if `code` matches. Replaces previous
   * TOTP + recovery codes, rotates securityStamp (invalidates trusted devices).
   * Returns the new plaintext recovery codes (shown once) or null on a bad code.
   */
  async confirmEnrollment(userId: string, code: string, tx: Tx): Promise<string[] | null> {
    const pending = await tx.mfaEnrollment.findFirst({ where: { userId, status: 'pending' }, orderBy: { createdAt: 'desc' } });
    if (!pending || !(await this.verifyTotp(pending, code, tx))) return null;
    await tx.mfaEnrollment.deleteMany({ where: { userId, NOT: { id: pending.id } } });
    await tx.mfaEnrollment.update({ where: { id: pending.id }, data: { status: 'active', activatedAt: new Date() } });
    const codes = await this.replaceRecoveryCodes(userId, tx);
    await this.rotateSecurityStamp(userId, tx);
    return codes;
  }

  async replaceRecoveryCodes(userId: string, tx: Tx): Promise<string[]> {
    const codes = this.secrets.newRecoveryCodes();
    const batchId = randomUUID();
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({
      data: codes.map((c) => ({ userId, batchId, codeHash: this.secrets.recoveryCodeHash(c) })),
    });
    return codes;
  }

  /** New securityStamp and no trusted devices (password change, MFA (re-)enrollment, recovery). */
  async rotateSecurityStamp(userId: string, tx: Tx): Promise<void> {
    await tx.user.update({ where: { id: userId }, data: { securityStamp: randomToken(16) } });
    await tx.device.updateMany({ where: { userId }, data: { trustedTokenHash: null, trustedStamp: null, trustedUntil: null } });
  }
}
