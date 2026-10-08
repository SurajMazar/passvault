import type { Env } from './actors';
import type { SuiteApi } from './results';
import type { Stack } from './stack';

export interface SuiteContext {
  t: SuiteApi;
  /** present when the suite needs a live API and one is available */
  env: (Env & { stack: Stack | null; disposable: boolean }) | null;
  log: (msg: string) => void;
}

export interface Suite {
  id: string;
  title: string;
  /** needs the live API (disposable stack or an allow-listed target) */
  needsApi: boolean;
  run(ctx: SuiteContext): Promise<void>;
}

/** Destructive checks (lockouts, resets, rate-limit exhaustion) only on the disposable stack. */
export function requireDisposable(ctx: SuiteContext, t: SuiteApi, id: string, title: string): boolean {
  if (ctx.env?.disposable) return true;
  t.blocked(id, title, 'destructive check: runs only against the disposable stack started by the harness');
  return false;
}

export const isMac = process.platform === 'darwin';
