import { Controller, Get, Query } from '@nestjs/common';
import * as V from '@passvault/validation';
import type * as T from '@passvault/types';
import { CurrentAuth } from '../common/decorators';
import { parseOrThrow } from '../common/zod';
import { recordDto } from '../common/dto';
import { PrismaService } from '../prisma/prisma.service';
import { VaultsService } from '../vaults/vaults.service';
import type { AuthContext } from '../auth/auth.types';

@Controller('sync')
export class SyncController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vaults: VaultsService,
  ) {}

  /**
   * Incremental sync by global sequence (docs/API.md "Sync"). Runs in one
   * REPEATABLE READ snapshot. Because writers draw sequence numbers under a
   * global advisory lock and commit before releasing it, every committed change
   * has a smaller seq than any change still in flight, so returning
   * max(committed seq) as the cursor can never skip a late commit.
   */
  @Get()
  async sync(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<T.SyncResponse> {
    const q = parseOrThrow(V.syncQuery, query);
    const cursor = BigInt(q.cursor ?? '0');
    const limit = q.limit ?? 500;
    const userId = auth.user.id;
    return this.prisma.$transaction(
      async (tx) => {
        const maxRows = await tx.$queryRaw<Array<{ max: bigint }>>`
          SELECT GREATEST(
            COALESCE((SELECT MAX(seq) FROM "Record"), 0),
            COALESCE((SELECT MAX(seq) FROM "Vault"), 0),
            COALESCE((SELECT MAX(seq) FROM "VaultMember"), 0)
          )::bigint AS max`;
        const max = BigInt(maxRows[0]?.max ?? 0);
        const { dtos, rows } = await this.vaults.liveMemberships(userId, tx);
        const vaultIds = rows.map((r) => r.vaultId);
        const records = vaultIds.length
          ? await tx.record.findMany({
              where: { vaultId: { in: vaultIds }, seq: { gt: cursor, lte: max } },
              orderBy: { seq: 'asc' },
              take: limit + 1,
            })
          : [];
        const hasMore = records.length > limit;
        const page = records.slice(0, limit);
        let next = hasMore ? page[page.length - 1]!.seq : max;
        if (next < cursor) next = cursor; // never move backwards
        const resyncVaults = rows.filter((r) => r.seq > cursor && r.seq <= max).map((r) => r.vaultId);
        const now = new Date();
        const pendingInvitations = await tx.vaultMember.count({
          where: { userId, status: 'invited', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], vault: { deletedAt: null } },
        });
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { settingsRevision: true } });
        return {
          cursor: next.toString(),
          hasMore,
          vaults: dtos,
          records: page.map(recordDto),
          resyncVaults: cursor === 0n ? [] : resyncVaults,
          settingsRevision: user.settingsRevision,
          pendingInvitations,
          serverTime: now.toISOString(),
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 30_000 },
    );
  }
}
