/**
 * Result model. A check is only `pass` when its assertion actually ran and
 * held. Anything that could not run is `unverified` (missing platform/tool) or
 * `blocked` (deliberately not run, e.g. destructive check against a
 * non-disposable target) — never `pass`.
 */
export type Status = 'pass' | 'fail' | 'unverified' | 'blocked' | 'not_applicable';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface CheckResult {
  suite: string;
  id: string;
  title: string;
  status: Status;
  /** severity of the property being verified (used when it fails) */
  severity: Severity;
  /** what was actually observed; never contains secret values (see redact()) */
  evidence: string;
  /** finding id when this check reproduces / guards a recorded finding */
  finding?: string;
  /** accepted-risk entry that currently covers a failing check */
  acceptedRisk?: { id: string; owner: string; expires: string; rationale: string };
  durationMs: number;
}

export interface RunMeta {
  startedAt: string;
  finishedAt?: string;
  gitCommit: string;
  gitDirty: boolean;
  platform: string;
  node: string;
  target: { apiUrl: string | null; disposable: boolean };
  suites: string[];
}

export interface CheckOpts {
  severity?: Severity;
  finding?: string;
}

export type CheckFn = () => Promise<CheckOutcome | void> | CheckOutcome | void;
export type CheckOutcome = { ok: boolean; evidence: string } | { status: Exclude<Status, 'pass' | 'fail'>; evidence: string };

/** Strings registered here are replaced in every evidence line before it is stored. */
const secrets = new Set<string>();
export function registerSecret(...values: Array<string | undefined | null>) {
  for (const v of values) if (v && v.length >= 6) secrets.add(v);
}
export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out;
}
const clip = (s: string) => (s.length > 4000 ? `${s.slice(0, 4000)}… (${s.length - 4000} more chars)` : s);

export class Recorder {
  readonly results: CheckResult[] = [];
  constructor(private readonly onResult: (r: CheckResult) => void = () => undefined) {}

  forSuite(suite: string) {
    const add = (r: Omit<CheckResult, 'suite'>) => {
      const full = { suite, ...r, evidence: clip(redact(r.evidence)) };
      this.results.push(full);
      this.onResult(full);
      return full;
    };
    return {
      /** Run an assertion. Throwing counts as a failure with the error message as evidence. */
      check: async (id: string, title: string, fn: CheckFn, opts: CheckOpts = {}): Promise<boolean> => {
        const t0 = Date.now();
        let status: Status;
        let evidence: string;
        try {
          const out = (await fn()) ?? { ok: true, evidence: 'assertions held' };
          if ('status' in out) {
            status = out.status;
            evidence = out.evidence;
          } else {
            status = out.ok ? 'pass' : 'fail';
            evidence = out.evidence;
          }
        } catch (e) {
          status = 'fail';
          evidence = `error: ${e instanceof Error ? `${e.message}${e.stack ? `\n${e.stack.split('\n').slice(1, 4).join('\n')}` : ''}` : String(e)}`;
        }
        add({ id, title, status, severity: opts.severity ?? 'medium', evidence, finding: opts.finding, durationMs: Date.now() - t0 });
        return status === 'pass';
      },
      unverified: (id: string, title: string, reason: string, opts: CheckOpts = {}) =>
        add({ id, title, status: 'unverified', severity: opts.severity ?? 'medium', evidence: reason, finding: opts.finding, durationMs: 0 }),
      blocked: (id: string, title: string, reason: string, opts: CheckOpts = {}) =>
        add({ id, title, status: 'blocked', severity: opts.severity ?? 'medium', evidence: reason, finding: opts.finding, durationMs: 0 }),
      notApplicable: (id: string, title: string, reason: string) =>
        add({ id, title, status: 'not_applicable', severity: 'info', evidence: reason, durationMs: 0 }),
    };
  }
}

export type SuiteApi = ReturnType<Recorder['forSuite']>;

export class AssertionError extends Error {}
export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new AssertionError(message);
}
