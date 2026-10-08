import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type * as T from '@passvault/types';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { ipPrefix } from '../common/util';
import type { RequestMeta } from '../auth/auth.types';

export type AuditType =
  | 'user.registration_started'
  | 'user.registered'
  | 'auth.login_succeeded'
  | 'auth.login_failed'
  | 'auth.mfa_enrolled'
  | 'auth.mfa_failed'
  | 'auth.mfa_reset'
  | 'auth.recovery_code_used'
  | 'auth.recovery_codes_regenerated'
  | 'auth.reauthenticated'
  | 'session.revoked'
  | 'session.revoked_all'
  | 'device.untrusted'
  | 'account.password_changed'
  | 'account.user_key_rotated'
  | 'recovery.started'
  | 'recovery.vault_recovered'
  | 'recovery.account_reset'
  | 'vault.created'
  | 'vault.deleted'
  | 'vault.member_invited'
  | 'vault.invite_accepted'
  | 'vault.invite_declined'
  | 'vault.member_updated'
  | 'vault.member_revoked'
  | 'vault.key_rotated'
  | 'vault.membership_expired'
  | 'record.deleted';

/** Only primitive, non-secret values. Callers must never pass tokens, codes, keys or ciphertext. */
export type AuditMetadata = Record<string, string | number | boolean | null>;

export interface AuditInput {
  type: AuditType;
  actorUserId?: string | null;
  subjectUserId?: string | null;
  vaultId?: string | null;
  recordId?: string | null;
  meta?: RequestMeta | null;
  metadata?: AuditMetadata;
}

const SECRETISH = /(token|key|code|secret|payload|password|hash|signature)/i;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput, tx?: Tx): Promise<void> {
    const metadata: AuditMetadata = {};
    for (const [k, v] of Object.entries(input.metadata ?? {})) {
      // defence in depth: drop anything that looks like secret material
      if (SECRETISH.test(k)) continue;
      metadata[k] = typeof v === 'string' ? v.slice(0, 200) : v;
    }
    await (tx ?? this.prisma).auditEvent.create({
      data: {
        type: input.type,
        actorUserId: input.actorUserId ?? null,
        subjectUserId: input.subjectUserId ?? null,
        vaultId: input.vaultId ?? null,
        recordId: input.recordId ?? null,
        deviceId: input.meta?.deviceId ?? null,
        ipPrefix: ipPrefix(input.meta?.ip),
        metadata: metadata as Prisma.InputJsonObject,
      },
    });
  }

  async list(userId: string, cursor: bigint | null, limit: number): Promise<T.Page<T.AuditEventDto>> {
    const owned = await this.prisma.vaultMember.findMany({
      where: { userId, role: 'owner', status: 'accepted' },
      select: { vaultId: true },
    });
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        AND: [
          cursor !== null ? { seq: { lt: cursor } } : {},
          {
            OR: [
              { actorUserId: userId },
              { subjectUserId: userId },
              ...(owned.length ? [{ vaultId: { in: owned.map((o) => o.vaultId) } }] : []),
            ],
          },
        ],
      },
      orderBy: { seq: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      data: page.map((e) => ({
        id: e.id,
        type: e.type,
        actorUserId: e.actorUserId,
        vaultId: e.vaultId,
        recordId: e.recordId,
        deviceId: e.deviceId,
        ipPrefix: e.ipPrefix,
        metadata: (e.metadata ?? {}) as T.AuditEventDto['metadata'],
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.seq.toString() : null,
    };
  }
}
