import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { describeError } from '../common/exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { VaultsService } from '../vaults/vaults.service';

const DAY = 24 * 60 * 60_000;
export const MUTATION_RETENTION_DAYS = 7;

/** Background maintenance (disable with JOBS_ENABLED=false, e.g. for extra replicas or tests). */
@Injectable()
export class JobsService {
  private readonly logger = new Logger('Jobs');

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly vaults: VaultsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'expire-memberships' })
  async expireMembershipsJob(): Promise<void> {
    if (!this.cfg.JOBS_ENABLED) return;
    try {
      await this.vaults.expireMemberships();
    } catch (e) {
      this.logger.error({ err: describeError(e) }, 'expire-memberships failed');
    }
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'purge' })
  async purgeJob(): Promise<void> {
    if (!this.cfg.JOBS_ENABLED) return;
    try {
      await this.purge();
    } catch (e) {
      this.logger.error({ err: describeError(e) }, 'purge failed');
    }
  }

  /** Remove expired/revoked sessions, spent email tokens, dead pending registrations and idempotency rows older than 7 days. */
  async purge(now = new Date()): Promise<{ sessions: number; emailTokens: number; pendingRegistrations: number; mutations: number }> {
    const dayAgo = new Date(now.getTime() - DAY);
    const sessions = await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { idleExpiresAt: { lt: now } }, { revokedAt: { lt: dayAgo } }] },
    });
    const emailTokens = await this.prisma.emailToken.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: dayAgo } }] },
    });
    const pending = await this.prisma.pendingRegistration.deleteMany({
      where: {
        OR: [
          { usedAt: { lt: dayAgo } },
          { AND: [{ expiresAt: { lt: now } }, { OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { lt: now } }] }] },
        ],
      },
    });
    const mutations = await this.prisma.mutation.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - MUTATION_RETENTION_DAYS * DAY) } },
    });
    const r = { sessions: sessions.count, emailTokens: emailTokens.count, pendingRegistrations: pending.count, mutations: mutations.count };
    if (r.sessions || r.emailTokens || r.pendingRegistrations || r.mutations) this.logger.log(r, 'purged expired rows');
    return r;
  }
}
