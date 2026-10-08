import { Injectable } from '@nestjs/common';
import type { Vault, VaultMember, VaultRole } from '@prisma/client';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { E } from '../common/errors';

export type AccessLevel = 'read' | 'write' | 'owner';

export function isMembershipLive(m: Pick<VaultMember, 'status' | 'expiresAt'>, now = new Date()): boolean {
  return m.status === 'accepted' && (!m.expiresAt || m.expiresAt > now);
}

const WRITE_ROLES: VaultRole[] = ['owner', 'editor'];

/**
 * Central vault authorization. Callers that are not members get 404 (no
 * existence oracle); members with insufficient rights get 403; expired
 * members get 403 membership_expired.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async require(userId: string, vaultId: string, level: AccessLevel, tx?: Tx): Promise<{ vault: Vault; member: VaultMember }> {
    const db = tx ?? this.prisma;
    const member = await db.vaultMember.findUnique({ where: { vaultId_userId: { vaultId, userId } }, include: { vault: true } });
    if (!member || member.vault.deletedAt) throw E.notFound('Vault not found');
    const { vault, ...m } = member;
    if (m.status === 'expired' || (m.status === 'accepted' && m.expiresAt && m.expiresAt <= new Date())) throw E.membershipExpired();
    if (m.status === 'invited') throw E.forbidden('Accept the invitation first');
    if (m.status !== 'accepted') throw E.notFound('Vault not found');
    if (level === 'write' && !WRITE_ROLES.includes(m.role)) throw E.forbidden('Viewers cannot modify this vault');
    if (level === 'owner' && m.role !== 'owner') throw E.forbidden('Only vault owners can do this');
    return { vault, member: m };
  }

  /** Vault ids the user can currently read (accepted, unexpired, not deleted). */
  async readableVaultIds(userId: string, tx?: Tx): Promise<string[]> {
    const now = new Date();
    const rows = await (tx ?? this.prisma).vaultMember.findMany({
      where: { userId, status: 'accepted', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], vault: { deletedAt: null } },
      select: { vaultId: true },
    });
    return rows.map((r) => r.vaultId);
  }
}
