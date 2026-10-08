import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import * as V from '@passvault/validation';
import type * as T from '@passvault/types';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { CurrentAuth, Meta, Reauth } from '../common/decorators';
import { ZodPipe, parseOrThrow } from '../common/zod';
import { E } from '../common/errors';
import { accountBundle, deviceTrusted } from '../common/dto';
import { iso } from '../common/util';
import { PrismaService, nextSeq } from '../prisma/prisma.service';
import { PasswordHasher } from '../security/password-hasher.service';
import { AuditService } from '../audit/audit.service';
import { MfaService } from '../auth/mfa.service';
import { SessionService } from '../auth/session.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';

const emptyBody = z.strictObject({});
const uuidPipe = new ParseUUIDPipe({ exceptionFactory: () => E.notFound() });

@Controller()
export class AccountController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
  ) {}

  @Get('account')
  async account(@CurrentAuth() auth: AuthContext): Promise<T.AccountBundle> {
    return accountBundle(auth.user, await this.mfa.isEnabled(auth.user.id));
  }

  @Reauth()
  @Post('account/password')
  @HttpCode(204)
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(V.changePasswordRequest)) body: z.output<typeof V.changePasswordRequest>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    const user = auth.user;
    const rot = body.rotation;
    if (rot && rot.personalVault.id !== user.personalVaultId) {
      throw E.validation([{ path: 'rotation.personalVault.id', message: 'must be your personal vault id' }]);
    }
    const authKeyHash = this.hasher.hash(body.authKey);
    const recoveryAuthKeyHash = rot ? this.hasher.hash(rot.recoveryAuthKey) : undefined;
    await this.prisma.seqTx(async (tx) => {
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
          failedLoginCount: 0,
          lockedUntil: null,
          ...(rot
            ? {
                encryptedPrivateEncryptionKey: rot.encryptedPrivateEncryptionKey,
                encryptedPrivateSigningKey: rot.encryptedPrivateSigningKey,
                encryptedUserKeyByRecovery: rot.encryptedUserKeyByRecovery,
                recoveryAuthKeyHash,
                encryptedSettings: rot.encryptedSettings,
                settingsRevision: { increment: 1 },
              }
            : {}),
        },
      });
      if (rot) {
        await tx.vaultMember.update({
          where: { vaultId_userId: { vaultId: rot.personalVault.id, userId: user.id } },
          data: { encryptedVaultKey: rot.personalVault.encryptedVaultKey, seq: await nextSeq(tx) },
        });
      }
      await this.mfa.rotateSecurityStamp(user.id, tx);
      if (body.signOutOtherSessions) {
        await this.sessions.revoke({ userId: user.id, NOT: { id: auth.session.id } }, 'password_changed', tx);
      }
      await this.audit.record(
        { type: 'account.password_changed', actorUserId: user.id, subjectUserId: user.id, meta, metadata: { signOutOtherSessions: body.signOutOtherSessions } },
        tx,
      );
      if (rot) await this.audit.record({ type: 'account.user_key_rotated', actorUserId: user.id, subjectUserId: user.id, meta }, tx);
    });
  }

  @Reauth()
  @Post('account/mfa/recovery-codes')
  @HttpCode(200)
  async regenerateRecoveryCodes(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta): Promise<{ recoveryCodes: string[] }> {
    parseOrThrow(emptyBody, body);
    const recoveryCodes = await this.prisma.$transaction(async (tx) => {
      const codes = await this.mfa.replaceRecoveryCodes(auth.user.id, tx);
      await this.audit.record({ type: 'auth.recovery_codes_regenerated', actorUserId: auth.user.id, subjectUserId: auth.user.id, meta }, tx);
      return codes;
    });
    return { recoveryCodes };
  }

  @Get('account/settings')
  settings(@CurrentAuth() auth: AuthContext): T.SettingsDto {
    return { encryptedSettings: auth.user.encryptedSettings, revision: auth.user.settingsRevision };
  }

  @Put('account/settings')
  async putSettings(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(V.updateSettingsRequest)) body: z.output<typeof V.updateSettingsRequest>,
  ): Promise<T.SettingsDto> {
    const r = await this.prisma.user.updateMany({
      where: { id: auth.user.id, settingsRevision: body.baseRevision },
      data: { encryptedSettings: body.encryptedSettings, settingsRevision: { increment: 1 } },
    });
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    const current: T.SettingsDto = { encryptedSettings: u.encryptedSettings, revision: u.settingsRevision };
    if (r.count !== 1) throw E.revisionConflict({ current }, 'Settings were changed on another device');
    return current;
  }

  // ---------------------------------------------------------------- sessions & devices

  @Get('sessions')
  async listSessions(@CurrentAuth() auth: AuthContext): Promise<T.SessionListItem[]> {
    const now = new Date();
    const rows = await this.prisma.session.findMany({
      where: { userId: auth.user.id, state: 'active', revokedAt: null, expiresAt: { gt: now }, idleExpiresAt: { gt: now } },
      include: { device: true },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id,
      deviceId: s.device.clientDeviceId,
      deviceName: s.device.name,
      clientType: s.device.clientType,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.id === auth.session.id,
      ipPrefix: s.ipPrefix,
      userAgent: s.userAgent,
    }));
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentAuth() auth: AuthContext, @Param('id', uuidPipe) id: string, @Meta() meta: RequestMeta): Promise<void> {
    const n = await this.sessions.revoke({ id, userId: auth.user.id }, 'revoked_by_user');
    if (n === 0) throw E.notFound('Session not found');
    await this.audit.record({ type: 'session.revoked', actorUserId: auth.user.id, subjectUserId: auth.user.id, meta, metadata: { sessionId: id } });
  }

  @Get('devices')
  async listDevices(@CurrentAuth() auth: AuthContext): Promise<T.DeviceListItem[]> {
    const now = new Date();
    const rows = await this.prisma.device.findMany({
      where: { userId: auth.user.id },
      include: {
        _count: {
          select: { sessions: { where: { state: 'active', revokedAt: null, expiresAt: { gt: now }, idleExpiresAt: { gt: now } } } },
        },
      },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map((d) => {
      const trusted = deviceTrusted(d, auth.user, now);
      return {
        id: d.clientDeviceId,
        name: d.name,
        clientType: d.clientType,
        trusted,
        trustedUntil: trusted ? iso(d.trustedUntil) : null,
        firstSeenAt: d.firstSeenAt.toISOString(),
        lastSeenAt: d.lastSeenAt.toISOString(),
        activeSessions: d._count.sessions,
      };
    });
  }

  @Delete('devices/:id/trust')
  @HttpCode(204)
  async untrustDevice(@CurrentAuth() auth: AuthContext, @Param('id', uuidPipe) id: string, @Meta() meta: RequestMeta): Promise<void> {
    const r = await this.prisma.device.updateMany({
      where: { userId: auth.user.id, clientDeviceId: id },
      data: { trustedTokenHash: null, trustedStamp: null, trustedUntil: null },
    });
    if (r.count === 0) throw E.notFound('Device not found');
    await this.audit.record({ type: 'device.untrusted', actorUserId: auth.user.id, subjectUserId: auth.user.id, meta, metadata: { device: id } });
  }

  @Delete('devices/:id')
  @HttpCode(204)
  async forgetDevice(@CurrentAuth() auth: AuthContext, @Param('id', uuidPipe) id: string, @Meta() meta: RequestMeta): Promise<void> {
    const d = await this.prisma.device.findUnique({ where: { userId_clientDeviceId: { userId: auth.user.id, clientDeviceId: id } } });
    if (!d) throw E.notFound('Device not found');
    await this.prisma.$transaction(async (tx) => {
      const n = await this.sessions.revoke({ deviceId: d.id }, 'device_removed', tx);
      await tx.device.delete({ where: { id: d.id } });
      await this.audit.record({ type: 'device.untrusted', actorUserId: auth.user.id, subjectUserId: auth.user.id, meta, metadata: { device: id, forgotten: true } }, tx);
      if (n > 0) await this.audit.record({ type: 'session.revoked', actorUserId: auth.user.id, subjectUserId: auth.user.id, meta, metadata: { device: id, count: n } }, tx);
    });
  }
}
