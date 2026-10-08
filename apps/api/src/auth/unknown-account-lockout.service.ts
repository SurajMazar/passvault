import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { sha256Hex } from '../common/util';

const KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_ENTRIES = 200_000;

/**
 * Failed-login bookkeeping for emails that have NO account, mirroring the
 * per-account progressive lockout (User.failedLoginCount / lockedUntil).
 * Without it an attacker could tell accounts apart: after enough failures a
 * real account answers "locked" (429) while an unknown email keeps answering
 * "invalid credentials" (401). Finding PV-SEC-001.
 *
 * In memory, keyed by SHA-256(email), bounded (oldest entries are evicted)
 * and kept for 30 days since the last failure. With several API replicas
 * each keeps its own copy (same caveat as EmailLimiter, see OPERATIONS.md).
 */
@Injectable()
export class UnknownAccountLockout implements OnModuleDestroy {
  private readonly entries = new Map<string, { failed: number; lockedUntil: number; lastFailure: number }>();
  private readonly timer: NodeJS.Timeout;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.timer = setInterval(() => this.sweep(), 60 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** True while the email is (phantom-)locked. */
  isLocked(email: string, now = Date.now()): boolean {
    const e = this.entries.get(sha256Hex(email));
    return !!e && e.lockedUntil > now;
  }

  /** Same progression as AuthService.checkCredentials for real accounts. */
  recordFailure(email: string, now = Date.now()): void {
    const key = sha256Hex(email);
    const e = this.entries.get(key) ?? { failed: 0, lockedUntil: 0, lastFailure: now };
    e.failed++;
    e.lastFailure = now;
    const over = e.failed - this.cfg.LOGIN_LOCKOUT_THRESHOLD;
    if (over >= 0) {
      const minutes = Math.min(this.cfg.LOGIN_LOCKOUT_MINUTES * 2 ** Math.floor(over / 5), 24 * 60);
      e.lockedUntil = now + minutes * 60_000;
    }
    this.entries.delete(key); // re-insert: Map order = least recently failed first
    this.entries.set(key, e);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }

  private sweep(now = Date.now()): void {
    for (const [k, v] of this.entries) if (now - v.lastFailure > KEEP_MS && v.lockedUntil <= now) this.entries.delete(k);
  }
}
