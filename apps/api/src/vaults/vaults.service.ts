import { Inject, Injectable, Logger } from '@nestjs/common';
import type { VaultMember } from '@prisma/client';
import type * as T from '@passvault/types';
import type * as V from '@passvault/validation';
import type { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService, nextSeq, type Tx } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { E } from '../common/errors';
import { memberDto, membershipDto, recordDto, type MembershipRow } from '../common/dto';
import { archiveVersion, envelopeSize, tombstoneVaultRecords } from '../records/record-ops';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { AccessService } from './access.service';

type In<S extends z.ZodType> = z.output<S>;

@Injectable()
export class VaultsService {
  private readonly logger = new Logger('Vaults');

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- membership views

  private async memberCounts(vaultIds: string[], tx?: Tx): Promise<Map<string, number>> {
    if (!vaultIds.length) return new Map();
    const rows = await (tx ?? this.prisma).vaultMember.groupBy({
      by: ['vaultId'],
      where: { vaultId: { in: vaultIds }, status: 'accepted' },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.vaultId, r._count._all]));
  }

  /** Accepted, unexpired memberships in non-deleted vaults (the `vaults` list of /sync). */
  async liveMemberships(userId: string, tx?: Tx): Promise<{ dtos: T.VaultMembershipDto[]; rows: MembershipRow[] }> {
    const now = new Date();
    const rows = await (tx ?? this.prisma).vaultMember.findMany({
      where: { userId, status: 'accepted', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], vault: { deletedAt: null } },
      include: { vault: true, grantedBy: true },
      orderBy: { createdAt: 'asc' },
    });
    const counts = await this.memberCounts(rows.map((r) => r.vaultId), tx);
    return { rows, dtos: rows.map((r) => membershipDto(r, counts.get(r.vaultId) ?? 1)) };
  }

  async membership(userId: string, vaultId: string, tx?: Tx): Promise<T.VaultMembershipDto> {
    const row = await (tx ?? this.prisma).vaultMember.findUniqueOrThrow({
      where: { vaultId_userId: { vaultId, userId } },
      include: { vault: true, grantedBy: true },
    });
    const counts = await this.memberCounts([vaultId], tx);
    return membershipDto(row, counts.get(vaultId) ?? 0);
  }

  // ---------------------------------------------------------------- vault CRUD

  async create(auth: AuthContext, body: In<typeof V.createSharedVaultRequest>, meta: RequestMeta): Promise<T.VaultMembershipDto> {
    return this.prisma.seqTx(async (tx) => {
      if (await tx.vault.findUnique({ where: { id: body.id }, select: { id: true } })) throw E.alreadyExists('Vault id is already in use');
      const now = new Date();
      await tx.vault.create({
        data: { id: body.id, type: 'shared', kind: body.kind, ownerId: auth.user.id, keyVersion: 1, allowResharing: body.allowResharing, seq: await nextSeq(tx) },
      });
      await tx.vaultMember.create({
        data: {
          vaultId: body.id,
          userId: auth.user.id,
          role: 'owner',
          status: 'accepted',
          keyVersion: 1,
          encryptedVaultKey: body.encryptedVaultKey,
          keySignature: body.keySignature,
          grantedById: auth.user.id,
          acceptedAt: now,
          seq: await nextSeq(tx),
        },
      });
      await this.audit.record({ type: 'vault.created', actorUserId: auth.user.id, vaultId: body.id, meta, metadata: { kind: body.kind } }, tx);
      return this.membership(auth.user.id, body.id, tx);
    });
  }

  async update(auth: AuthContext, vaultId: string, body: In<typeof V.updateVaultRequest>, meta: RequestMeta): Promise<T.VaultMembershipDto> {
    return this.prisma.seqTx(async (tx) => {
      const { vault } = await this.access.require(auth.user.id, vaultId, 'owner', tx);
      if (body.allowResharing !== undefined && vault.type === 'personal') throw E.forbidden('Personal vaults cannot be shared');
      if (body.allowResharing !== undefined && body.allowResharing !== vault.allowResharing) {
        await tx.vault.update({ where: { id: vaultId }, data: { allowResharing: body.allowResharing, seq: await nextSeq(tx) } });
        await this.audit.record({ type: 'vault.member_updated', actorUserId: auth.user.id, vaultId, meta, metadata: { allowResharing: body.allowResharing } }, tx);
      }
      return this.membership(auth.user.id, vaultId, tx);
    });
  }

  async remove(auth: AuthContext, vaultId: string, meta: RequestMeta): Promise<void> {
    await this.prisma.seqTx(async (tx) => {
      const { vault } = await this.access.require(auth.user.id, vaultId, 'owner', tx);
      if (vault.type === 'personal') throw E.forbidden('Personal vaults cannot be deleted');
      await this.deleteVaultInTx(tx, vaultId, auth.user.id);
      await this.audit.record({ type: 'vault.deleted', actorUserId: auth.user.id, vaultId, meta }, tx);
    });
  }

  /** Tombstone all records, revoke every member, mark the vault deleted. */
  async deleteVaultInTx(tx: Tx, vaultId: string, actorId: string): Promise<void> {
    const now = new Date();
    await tombstoneVaultRecords(tx, vaultId, actorId);
    const members = await tx.vaultMember.findMany({ where: { vaultId, status: { in: ['accepted', 'invited'] } }, select: { userId: true } });
    for (const m of members) {
      await tx.vaultMember.update({
        where: { vaultId_userId: { vaultId, userId: m.userId } },
        data: { status: 'revoked', revokedAt: now, seq: await nextSeq(tx) },
      });
    }
    await tx.vault.update({ where: { id: vaultId }, data: { deletedAt: now, seq: await nextSeq(tx) } });
  }

  // ---------------------------------------------------------------- members

  async members(auth: AuthContext, vaultId: string): Promise<T.VaultMemberDto[]> {
    await this.access.require(auth.user.id, vaultId, 'read');
    const rows = await this.prisma.vaultMember.findMany({ where: { vaultId }, include: { user: true }, orderBy: { createdAt: 'asc' } });
    return rows.map(memberDto);
  }

  async invite(auth: AuthContext, vaultId: string, body: In<typeof V.inviteMemberRequest>, meta: RequestMeta): Promise<T.VaultMemberDto> {
    return this.prisma.seqTx(async (tx) => {
      const { vault, member } = await this.access.require(auth.user.id, vaultId, 'read', tx);
      if (vault.type === 'personal') throw E.forbidden('Personal vaults cannot be shared');
      if (member.role === 'viewer') throw E.forbidden('Viewers cannot invite members');
      if (member.role === 'editor') {
        if (!vault.allowResharing) throw E.forbidden('Resharing is disabled for this vault');
        if (body.role === 'owner') throw E.forbidden('Editors cannot grant the owner role');
      }
      if (body.recipientUserId === auth.user.id) throw E.conflict('You are already a member of this vault');
      const recipient = await tx.user.findUnique({ where: { id: body.recipientUserId } });
      if (!recipient || !recipient.emailVerifiedAt) throw E.notFound('Recipient not found');
      if (body.keyVersion !== vault.keyVersion) throw E.conflict('Grant was made for a stale key version', { currentKeyVersion: vault.keyVersion });
      if (vault.rotationRequired) throw E.keyRotationRequired();
      const now = new Date();
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      if (expiresAt && expiresAt <= now) throw E.validation([{ path: 'expiresAt', message: 'must be in the future' }]);
      const existing = await tx.vaultMember.findUnique({ where: { vaultId_userId: { vaultId, userId: recipient.id } } });
      if (existing && (existing.status === 'accepted' || existing.status === 'invited') && (!existing.expiresAt || existing.expiresAt > now)) {
        throw E.alreadyExists('User is already a member or has a pending invitation');
      }
      const data = {
        role: body.role,
        status: 'invited' as const,
        keyVersion: body.keyVersion,
        encryptedVaultKey: body.encryptedVaultKey,
        keySignature: body.keySignature,
        grantedById: auth.user.id,
        expiresAt,
        acceptedAt: null,
        revokedAt: null,
        seq: await nextSeq(tx),
      };
      const row = existing
        ? await tx.vaultMember.update({ where: { vaultId_userId: { vaultId, userId: recipient.id } }, data: { ...data, createdAt: now }, include: { user: true } })
        : await tx.vaultMember.create({ data: { vaultId, userId: recipient.id, ...data }, include: { user: true } });
      await this.audit.record(
        { type: 'vault.member_invited', actorUserId: auth.user.id, subjectUserId: recipient.id, vaultId, meta, metadata: { role: body.role, expires: Boolean(expiresAt) } },
        tx,
      );
      return memberDto(row);
    });
  }

  private async liveOwners(tx: Tx, vaultId: string): Promise<VaultMember[]> {
    const now = new Date();
    return tx.vaultMember.findMany({
      where: { vaultId, role: 'owner', status: 'accepted', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    });
  }

  async updateMember(
    auth: AuthContext,
    vaultId: string,
    userId: string,
    body: In<typeof V.updateMemberRequest>,
    meta: RequestMeta,
  ): Promise<T.VaultMemberDto> {
    return this.prisma.seqTx(async (tx) => {
      const { vault } = await this.access.require(auth.user.id, vaultId, 'owner', tx);
      if (vault.type === 'personal') throw E.forbidden('Personal vaults cannot be shared');
      const target = await tx.vaultMember.findUnique({ where: { vaultId_userId: { vaultId, userId } } });
      if (!target || (target.status !== 'accepted' && target.status !== 'invited')) throw E.notFound('Member not found');
      const now = new Date();
      const expiresAt = body.expiresAt === undefined ? target.expiresAt : body.expiresAt ? new Date(body.expiresAt) : null;
      if (body.expiresAt && expiresAt! <= now) throw E.validation([{ path: 'expiresAt', message: 'must be in the future' }]);
      const newRole = body.role ?? target.role;
      if (target.role === 'owner' && target.status === 'accepted' && (newRole !== 'owner' || expiresAt)) {
        const owners = await this.liveOwners(tx, vaultId);
        if (owners.filter((o) => o.userId !== userId && !o.expiresAt).length === 0) {
          throw E.conflict('A vault must keep at least one owner without an expiry');
        }
      }
      const row = await tx.vaultMember.update({
        where: { vaultId_userId: { vaultId, userId } },
        data: { role: newRole, expiresAt, seq: await nextSeq(tx) },
        include: { user: true },
      });
      await this.fixOwnerId(tx, vaultId);
      await this.audit.record(
        { type: 'vault.member_updated', actorUserId: auth.user.id, subjectUserId: userId, vaultId, meta, metadata: { role: newRole, expires: Boolean(expiresAt) } },
        tx,
      );
      return memberDto(row);
    });
  }

  /** Keep Vault.ownerId pointing at a live owner (used for "owned vaults" semantics). */
  async fixOwnerId(tx: Tx, vaultId: string): Promise<void> {
    const vault = await tx.vault.findUniqueOrThrow({ where: { id: vaultId } });
    const owners = await this.liveOwners(tx, vaultId);
    if (owners.length && !owners.some((o) => o.userId === vault.ownerId)) {
      await tx.vault.update({ where: { id: vaultId }, data: { ownerId: owners[0]!.userId } });
    }
  }

  async removeMember(auth: AuthContext, vaultId: string, userId: string, meta: RequestMeta): Promise<void> {
    await this.prisma.seqTx(async (tx) => {
      const self = userId === auth.user.id;
      const { vault } = await this.access.require(auth.user.id, vaultId, self ? 'read' : 'owner', tx);
      const target = await tx.vaultMember.findUnique({ where: { vaultId_userId: { vaultId, userId } } });
      if (!target || (target.status !== 'accepted' && target.status !== 'invited')) throw E.notFound('Member not found');
      if (target.role === 'owner' && target.status === 'accepted') {
        const owners = await this.liveOwners(tx, vaultId);
        if (owners.filter((o) => o.userId !== userId).length === 0) {
          throw E.conflict(vault.type === 'personal' ? 'You cannot leave your personal vault' : 'Cannot remove the last owner; delete the vault or add another owner first');
        }
      }
      const now = new Date();
      await tx.vaultMember.update({
        where: { vaultId_userId: { vaultId, userId } },
        data: { status: 'revoked', revokedAt: now, seq: await nextSeq(tx) },
      });
      await tx.vault.update({ where: { id: vaultId }, data: { rotationRequired: true, seq: await nextSeq(tx) } });
      await this.fixOwnerId(tx, vaultId);
      await this.audit.record(
        { type: 'vault.member_revoked', actorUserId: auth.user.id, subjectUserId: userId, vaultId, meta, metadata: { left: self } },
        tx,
      );
    });
  }

  // ---------------------------------------------------------------- key rotation

  async rotate(auth: AuthContext, vaultId: string, body: In<typeof V.rotateVaultKeyRequest>, meta: RequestMeta): Promise<T.VaultMembershipDto> {
    return this.prisma.seqTx(async (tx) => {
      const { vault } = await this.access.require(auth.user.id, vaultId, 'owner', tx);
      if (body.newKeyVersion !== vault.keyVersion + 1) {
        throw E.conflict('newKeyVersion must be the current key version + 1', { currentKeyVersion: vault.keyVersion });
      }
      const now = new Date();
      const members = await tx.vaultMember.findMany({ where: { vaultId, status: { in: ['accepted', 'invited'] } } });
      const live = members.filter((m) => !m.expiresAt || m.expiresAt > now);
      const expired = members.filter((m) => m.expiresAt && m.expiresAt <= now);

      const grantIds = body.grants.map((g) => g.userId);
      if (new Set(grantIds).size !== grantIds.length) throw E.validation([{ path: 'grants', message: 'duplicate userId' }]);
      const liveIds = new Set(live.map((m) => m.userId));
      const missingGrants = [...liveIds].filter((id) => !grantIds.includes(id));
      const unexpectedGrants = grantIds.filter((id) => !liveIds.has(id));
      if (missingGrants.length || unexpectedGrants.length) {
        throw E.conflict('Grants must cover exactly the current members', { missingGrants, unexpectedGrants });
      }
      if (vault.type === 'shared' && body.grants.some((g) => !g.keySignature)) {
        throw E.validation([{ path: 'grants', message: 'shared vault grants must be signed' }]);
      }

      const recIds = body.records.map((r) => r.id);
      if (new Set(recIds).size !== recIds.length) throw E.validation([{ path: 'records', message: 'duplicate record id' }]);
      const current = await tx.record.findMany({ where: { vaultId, deletedAt: null } });
      const byId = new Map(current.map((r) => [r.id, r]));
      const missingRecords = current.filter((r) => !recIds.includes(r.id)).map((r) => r.id);
      const unexpectedRecords = recIds.filter((id) => !byId.has(id));
      if (missingRecords.length || unexpectedRecords.length) {
        throw E.conflict('Records must cover every live record of the vault', { missingRecords, unexpectedRecords });
      }
      const stale = body.records
        .filter((r) => byId.get(r.id)!.revision !== r.baseRevision)
        .map((r) => ({ id: r.id, baseRevision: r.baseRevision, currentRevision: byId.get(r.id)!.revision }));
      if (stale.length) throw E.revisionConflict({ stale }, 'Some records changed since the rotation was prepared');

      for (const m of expired) {
        await tx.vaultMember.update({ where: { vaultId_userId: { vaultId, userId: m.userId } }, data: { status: 'expired', seq: await nextSeq(tx) } });
      }
      for (const g of body.grants) {
        await tx.vaultMember.update({
          where: { vaultId_userId: { vaultId, userId: g.userId } },
          data: {
            keyVersion: body.newKeyVersion,
            encryptedVaultKey: g.encryptedVaultKey,
            keySignature: g.keySignature,
            grantedById: auth.user.id,
            seq: await nextSeq(tx),
          },
        });
      }
      for (const r of body.records) {
        const old = byId.get(r.id)!;
        await archiveVersion(tx, old, this.cfg.RECORD_HISTORY_LIMIT);
        const payload = r.encryptedPayload ?? old.encryptedPayload;
        await tx.record.update({
          where: { id: r.id },
          data: {
            encryptedKey: r.encryptedKey,
            encryptedPayload: payload,
            size: envelopeSize(r.encryptedKey, payload),
            revision: { increment: 1 },
            updatedById: auth.user.id,
            seq: await nextSeq(tx),
          },
        });
      }
      await tx.vault.update({ where: { id: vaultId }, data: { keyVersion: body.newKeyVersion, rotationRequired: false, seq: await nextSeq(tx) } });
      await this.audit.record(
        { type: 'vault.key_rotated', actorUserId: auth.user.id, vaultId, meta, metadata: { keyVersion: body.newKeyVersion, records: body.records.length, members: body.grants.length } },
        tx,
      );
      return this.membership(auth.user.id, vaultId, tx);
    });
  }

  // ---------------------------------------------------------------- listing

  async records(auth: AuthContext, vaultId: string, cursor: bigint, limit: number): Promise<T.Page<T.RecordDto>> {
    await this.access.require(auth.user.id, vaultId, 'read');
    const rows = await this.prisma.record.findMany({
      where: { vaultId, seq: { gt: cursor } },
      orderBy: { seq: 'asc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return { data: page.map(recordDto), nextCursor: rows.length > limit ? page[page.length - 1]!.seq.toString() : null };
  }

  // ---------------------------------------------------------------- invitations

  async invitations(userId: string): Promise<T.InvitationDto[]> {
    const now = new Date();
    const rows = await this.prisma.vaultMember.findMany({
      where: { userId, status: 'invited', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], vault: { deletedAt: null } },
      include: { vault: { include: { owner: true } }, grantedBy: true },
      orderBy: { createdAt: 'desc' },
    });
    const counts = rows.length
      ? await this.prisma.record.groupBy({
          by: ['vaultId'],
          where: { vaultId: { in: rows.map((r) => r.vaultId) }, deletedAt: null },
          _count: { _all: true },
        })
      : [];
    const countMap = new Map(counts.map((c) => [c.vaultId, c._count._all]));
    return rows.map((r) => {
      const by = r.grantedBy ?? r.vault.owner;
      return {
        vaultId: r.vaultId,
        kind: r.vault.kind,
        role: r.role,
        invitedBy: { userId: by.id, email: by.email, name: by.name, publicSigningKey: by.publicSigningKey, publicEncryptionKey: by.publicEncryptionKey },
        expiresAt: r.expiresAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        itemCount: countMap.get(r.vaultId) ?? 0,
      };
    });
  }

  private async pendingInvitation(tx: Tx, userId: string, vaultId: string): Promise<VaultMember> {
    const m = await tx.vaultMember.findUnique({ where: { vaultId_userId: { vaultId, userId } }, include: { vault: true } });
    if (!m || m.vault.deletedAt || (m.status !== 'invited' && m.status !== 'expired')) throw E.notFound('Invitation not found');
    if (m.status === 'expired' || (m.expiresAt && m.expiresAt <= new Date())) throw E.membershipExpired();
    return m;
  }

  async accept(auth: AuthContext, vaultId: string, meta: RequestMeta): Promise<T.VaultMembershipDto> {
    return this.prisma.seqTx(async (tx) => {
      await this.pendingInvitation(tx, auth.user.id, vaultId);
      await tx.vaultMember.update({
        where: { vaultId_userId: { vaultId, userId: auth.user.id } },
        data: { status: 'accepted', acceptedAt: new Date(), seq: await nextSeq(tx) },
      });
      await this.audit.record({ type: 'vault.invite_accepted', actorUserId: auth.user.id, subjectUserId: auth.user.id, vaultId, meta }, tx);
      return this.membership(auth.user.id, vaultId, tx);
    });
  }

  async decline(auth: AuthContext, vaultId: string, meta: RequestMeta): Promise<void> {
    await this.prisma.seqTx(async (tx) => {
      await this.pendingInvitation(tx, auth.user.id, vaultId);
      await tx.vaultMember.update({
        where: { vaultId_userId: { vaultId, userId: auth.user.id } },
        data: { status: 'declined', seq: await nextSeq(tx) },
      });
      await this.audit.record({ type: 'vault.invite_declined', actorUserId: auth.user.id, subjectUserId: auth.user.id, vaultId, meta }, tx);
    });
  }

  // ---------------------------------------------------------------- jobs

  /** Mark memberships past `expiresAt` as expired; accepted ones require a key rotation. */
  async expireMemberships(now = new Date()): Promise<number> {
    const due = await this.prisma.vaultMember.findMany({
      where: { status: { in: ['accepted', 'invited'] }, expiresAt: { lte: now } },
      select: { vaultId: true, userId: true },
      take: 500,
    });
    let n = 0;
    for (const d of due) {
      await this.prisma.seqTx(async (tx) => {
        const m = await tx.vaultMember.findUnique({ where: { vaultId_userId: d } });
        if (!m || (m.status !== 'accepted' && m.status !== 'invited') || !m.expiresAt || m.expiresAt > now) return;
        await tx.vaultMember.update({ where: { vaultId_userId: d }, data: { status: 'expired', seq: await nextSeq(tx) } });
        await tx.vault.update({ where: { id: d.vaultId }, data: { rotationRequired: true, seq: await nextSeq(tx) } });
        await this.audit.record({ type: 'vault.membership_expired', subjectUserId: d.userId, vaultId: d.vaultId, metadata: { previousStatus: m.status } }, tx);
        n++;
      });
    }
    if (n) this.logger.log({ count: n }, 'memberships expired');
    return n;
  }
}
