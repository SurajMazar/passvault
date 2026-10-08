import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type * as T from '@passvault/types';
import type * as V from '@passvault/validation';
import type { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService, isUniqueViolation, nextSeq, type Tx } from '../prisma/prisma.service';
import { AccessService } from '../vaults/access.service';
import { AuditService } from '../audit/audit.service';
import { E } from '../common/errors';
import { recordDto, recordVersionDto } from '../common/dto';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { archiveVersion, envelopeSize, tombstoneRecord } from './record-ops';

type In<S extends z.ZodType> = z.output<S>;
export interface MutationResult<B> {
  status: number;
  body: B;
}

@Injectable()
export class RecordsService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Idempotent mutation: a retried (userId, mutationId) returns the stored
   * status/body without re-applying. Only successful results are stored, so a
   * failed attempt (e.g. 409) can be retried after the client rebases.
   */
  private async idempotent<B>(userId: string, mutationId: string, status: number, fn: (tx: Tx) => Promise<B>): Promise<MutationResult<B>> {
    const key = { userId_mutationId: { userId, mutationId } };
    const prior = await this.prisma.mutation.findUnique({ where: key });
    if (prior) return { status: prior.statusCode, body: prior.response as B };
    try {
      return await this.prisma.seqTx(async (tx) => {
        const again = await tx.mutation.findUnique({ where: key });
        if (again) return { status: again.statusCode, body: again.response as B };
        const body = await fn(tx);
        await tx.mutation.create({ data: { userId, mutationId, statusCode: status, response: body as Prisma.InputJsonValue } });
        return { status, body };
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        const stored = await this.prisma.mutation.findUnique({ where: key });
        if (stored) return { status: stored.statusCode, body: stored.response as B };
      }
      throw e;
    }
  }

  create(auth: AuthContext, body: In<typeof V.createRecordRequest>): Promise<MutationResult<T.RecordDto>> {
    return this.idempotent(auth.user.id, body.mutationId, 201, async (tx) => {
      await this.access.require(auth.user.id, body.vaultId, 'write', tx);
      // ids are never reused, including ids of permanently deleted records (tombstones)
      if (await tx.record.findUnique({ where: { id: body.id }, select: { id: true } })) throw E.alreadyExists('Record id already exists');
      const rec = await tx.record.create({
        data: {
          id: body.id,
          vaultId: body.vaultId,
          kind: body.kind,
          revision: 1,
          formatVersion: body.formatVersion,
          encryptedKey: body.encryptedKey,
          encryptedPayload: body.encryptedPayload,
          size: envelopeSize(body.encryptedKey, body.encryptedPayload),
          createdById: auth.user.id,
          updatedById: auth.user.id,
          seq: await nextSeq(tx),
        },
      });
      return recordDto(rec);
    });
  }

  /** Load a record the caller may access at `level`; 404 if it does not exist or is invisible. */
  private async load(tx: Tx | PrismaService, auth: AuthContext, id: string, level: 'read' | 'write') {
    const rec = await tx.record.findUnique({ where: { id } });
    if (!rec) throw E.notFound('Record not found');
    await this.access.require(auth.user.id, rec.vaultId, level, tx as Tx);
    return rec;
  }

  async get(auth: AuthContext, id: string): Promise<T.RecordDto> {
    const rec = await this.load(this.prisma, auth, id, 'read');
    if (rec.deletedAt) throw E.gone('This record was permanently deleted', { current: recordDto(rec) });
    return recordDto(rec);
  }

  update(auth: AuthContext, id: string, body: In<typeof V.updateRecordRequest>): Promise<MutationResult<T.RecordDto>> {
    return this.idempotent(auth.user.id, body.mutationId, 200, async (tx) => {
      const rec = await this.load(tx, auth, id, 'write');
      if (rec.deletedAt) throw E.gone('This record was permanently deleted', { current: recordDto(rec) });
      if (rec.revision !== body.baseRevision) throw E.revisionConflict({ current: recordDto(rec) } satisfies T.RevisionConflictDetails);
      const targetVault = body.vaultId ?? rec.vaultId;
      const moving = targetVault !== rec.vaultId;
      if (moving) await this.access.require(auth.user.id, targetVault, 'write', tx);
      await archiveVersion(tx, rec, this.cfg.RECORD_HISTORY_LIMIT);
      const updated = await tx.record.update({
        where: { id },
        data: {
          vaultId: targetVault,
          revision: { increment: 1 },
          formatVersion: body.formatVersion,
          encryptedKey: body.encryptedKey,
          encryptedPayload: body.encryptedPayload,
          size: envelopeSize(body.encryptedKey, body.encryptedPayload),
          updatedById: auth.user.id,
          seq: await nextSeq(tx),
        },
      });
      if (moving) {
        // Members of the source vault never see the record row again (it now
        // belongs to another vault), so flag the source vault for a full
        // re-listing (resyncVaults) which drops the moved record from caches.
        const members = await tx.vaultMember.findMany({ where: { vaultId: rec.vaultId, status: 'accepted' }, select: { userId: true } });
        for (const m of members) {
          await tx.vaultMember.update({ where: { vaultId_userId: { vaultId: rec.vaultId, userId: m.userId } }, data: { seq: await nextSeq(tx) } });
        }
      }
      return recordDto(updated);
    });
  }

  remove(auth: AuthContext, id: string, body: In<typeof V.deleteRecordRequest>, meta: RequestMeta): Promise<MutationResult<T.RecordDto>> {
    return this.idempotent(auth.user.id, body.mutationId, 200, async (tx) => {
      const rec = await this.load(tx, auth, id, 'write');
      if (rec.deletedAt) throw E.gone('This record was already permanently deleted', { current: recordDto(rec) });
      if (rec.revision !== body.baseRevision) throw E.revisionConflict({ current: recordDto(rec) } satisfies T.RevisionConflictDetails);
      const tomb = await tombstoneRecord(tx, id, auth.user.id);
      await this.audit.record({ type: 'record.deleted', actorUserId: auth.user.id, vaultId: rec.vaultId, recordId: id, meta, metadata: { kind: rec.kind } }, tx);
      return recordDto(tomb);
    });
  }

  async versions(auth: AuthContext, id: string): Promise<T.RecordVersionDto[]> {
    const rec = await this.load(this.prisma, auth, id, 'read');
    if (rec.deletedAt) throw E.gone('This record was permanently deleted');
    const rows = await this.prisma.recordVersion.findMany({ where: { recordId: id }, orderBy: { revision: 'desc' } });
    return rows.map(recordVersionDto);
  }
}
