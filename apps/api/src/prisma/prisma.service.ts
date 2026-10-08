import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../config/config';

export type Tx = Prisma.TransactionClient;

/** Advisory lock key that serialises every transaction drawing from pv_change_seq. */
export const SEQ_LOCK_KEY = 0x50565351; // "PVSQ"

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    super({ datasourceUrl: cfg.DATABASE_URL, log: [] });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run a mutating transaction that may draw sequence numbers. Takes the global
   * transaction-scoped advisory lock first so that sequence order == commit
   * order (a sync cursor can never skip a late-committing change).
   */
  async seqTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await lockSeq(tx);
        return fn(tx);
      },
      { timeout: 60_000, maxWait: 15_000 },
    );
  }
}

export async function lockSeq(tx: Tx): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${SEQ_LOCK_KEY})`);
}

/** Draw the next global change sequence number (call only after lockSeq in the same tx). */
export async function nextSeq(tx: Tx): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ v: bigint }>>`SELECT nextval('pv_change_seq') AS v`;
  return rows[0]!.v;
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}
