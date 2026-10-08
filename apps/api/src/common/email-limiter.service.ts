import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { E } from './errors';
import { sha256Hex } from './util';

export const WINDOW_15_MIN = 15 * 60_000;
export const WINDOW_HOUR = 60 * 60_000;

/**
 * Per-email (per-account-identifier) fixed-window limiter for prelogin, login,
 * register, recovery and lookup. Complements the per-IP throttler so that a
 * distributed attacker cannot hammer one account. In-memory: with several API
 * replicas each enforces its own window (see OPERATIONS.md).
 */
@Injectable()
export class EmailLimiter implements OnModuleDestroy {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly timer: NodeJS.Timeout;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  hit(scope: string, email: string, limit = this.cfg.RATE_LIMIT_EMAIL_PER_15_MINUTES, windowMs = WINDOW_15_MIN): void {
    const key = `${scope}:${sha256Hex(email)}`;
    const now = Date.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    cur.count++;
    if (cur.count > limit) throw E.rateLimited();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
