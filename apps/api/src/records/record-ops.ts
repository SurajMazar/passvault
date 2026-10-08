import type { Record as DbRecord } from '@prisma/client';
import { nextSeq, type Tx } from '../prisma/prisma.service';

/** Byte length of the stored envelopes (server-visible size metadata). */
export function envelopeSize(encryptedKey: string | null, encryptedPayload: string | null): number {
  return Buffer.byteLength(encryptedKey ?? '', 'utf8') + Buffer.byteLength(encryptedPayload ?? '', 'utf8');
}

/** Store the current ciphertext as a history version and keep only the newest `limit`. */
export async function archiveVersion(tx: Tx, rec: DbRecord, limit: number): Promise<void> {
  if (limit <= 0 || !rec.encryptedKey || !rec.encryptedPayload) return;
  await tx.recordVersion.upsert({
    where: { recordId_revision: { recordId: rec.id, revision: rec.revision } },
    create: {
      recordId: rec.id,
      revision: rec.revision,
      vaultId: rec.vaultId,
      formatVersion: rec.formatVersion,
      encryptedKey: rec.encryptedKey,
      encryptedPayload: rec.encryptedPayload,
      createdById: rec.updatedById,
      createdAt: rec.updatedAt,
    },
    update: {},
  });
  const old = await tx.recordVersion.findMany({
    where: { recordId: rec.id },
    orderBy: { revision: 'desc' },
    skip: limit,
    select: { id: true },
  });
  if (old.length) await tx.recordVersion.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
}

/** Permanent delete: keep a tombstone row (no ciphertext) so the deletion syncs; drop history. */
export async function tombstoneRecord(tx: Tx, recordId: string, userId: string): Promise<DbRecord> {
  await tx.recordVersion.deleteMany({ where: { recordId } });
  return tx.record.update({
    where: { id: recordId },
    data: {
      encryptedKey: null,
      encryptedPayload: null,
      size: 0,
      deletedAt: new Date(),
      revision: { increment: 1 },
      updatedById: userId,
      seq: await nextSeq(tx),
    },
  });
}

export async function tombstoneVaultRecords(tx: Tx, vaultId: string, userId: string): Promise<number> {
  const live = await tx.record.findMany({ where: { vaultId, deletedAt: null }, select: { id: true }, orderBy: { seq: 'asc' } });
  for (const r of live) await tombstoneRecord(tx, r.id, userId);
  return live.length;
}
