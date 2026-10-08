import type { EventEnvelope, HelloResult, HelperErrorCode, HelperEventMap, HelperEventType, RequestEnvelope, ResponseEnvelope } from './types';

/**
 * Client for the pv-helper Neutralino extension.
 *
 *  - Correlates `pv.request` / `pv.response` by a random request id.
 *  - Binds every request (except `hello`) to the current helper session id and
 *    drops events that belong to another (stale) session.
 *  - Never logs params, results or event payloads: they can contain secrets
 *    (passwords, private keys, keychain values, terminal I/O).
 */

export class HelperError extends Error {
  override name = 'HelperError';
  constructor(
    readonly code: HelperErrorCode | string,
    message: string,
  ) {
    super(message);
  }
}

export interface HelperTransport {
  send(req: RequestEnvelope): Promise<void>;
  /** Subscribes to `pv.response` and `pv.event`; returns an unsubscribe function. */
  subscribe(onResponse: (r: unknown) => void, onEvent: (e: unknown) => void): () => void;
}

export type HelperState = 'starting' | 'ready' | 'unavailable';

export interface HelperStatus {
  state: HelperState;
  reason?: string;
  hello?: HelloResult;
  /** increments with every successful hello (a new helper session) */
  generation: number;
}

/** Why the previous helper session (and its SSH connections, prompts, agent keys) ended. */
export type SessionResetReason = 'helper_disconnected' | 'invalid_session' | 'new_session' | 'unavailable';

const OP_TIMEOUTS: Record<string, number> = {
  hello: 10_000,
  'ssh.test': 75_000,
  'ssh.keygen': 90_000,
  'keychain.get': 120_000,
  'keychain.set': 60_000,
  'fs.writeExport': 30_000,
  'fs.readImport': 30_000,
};

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function defaultId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `r-${c.randomUUID()}`;
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return `r-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

interface Pending {
  op: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HelperClientOptions {
  clientVersion: string;
  defaultTimeoutMs?: number;
  idFactory?: () => string;
}

export class HelperClient {
  private sessionId: string | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Map<string, Set<(data: never) => void>>();
  private statusListeners = new Set<(s: HelperStatus) => void>();
  private resetListeners = new Set<(r: SessionResetReason) => void>();
  private unsubscribe: (() => void) | null = null;
  private _status: HelperStatus = { state: 'starting', generation: 0 };
  private settledWaiters: Array<() => void> = [];
  private readonly defaultTimeout: number;
  private readonly newId: () => string;

  constructor(
    private readonly transport: HelperTransport,
    private readonly opts: HelperClientOptions,
  ) {
    this.defaultTimeout = opts.defaultTimeoutMs ?? 15_000;
    this.newId = opts.idFactory ?? defaultId;
    this.unsubscribe = transport.subscribe(
      (r) => this.handleResponse(r),
      (e) => this.handleEvent(e),
    );
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.failAll('helper_unavailable', 'Helper client closed');
  }

  get status(): HelperStatus {
    return this._status;
  }

  get isReady(): boolean {
    return this._status.state === 'ready' && this.sessionId !== null;
  }

  /** Current session id (exposed for tests/diagnostics only). */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  onStatus(fn: (s: HelperStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Called when a previous helper session ended (its connections and prompts are gone). */
  onSessionReset(fn: (r: SessionResetReason) => void): () => void {
    this.resetListeners.add(fn);
    return () => this.resetListeners.delete(fn);
  }

  on<T extends HelperEventType>(type: T, fn: (data: HelperEventMap[T]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn as (data: never) => void);
    return () => set!.delete(fn as (data: never) => void);
  }

  /** Resolves once the helper is ready or known to be unavailable (bounded by `ms`). */
  waitUntilSettled(ms: number): Promise<HelperStatus> {
    if (this._status.state !== 'starting') return Promise.resolve(this._status);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        resolve(this._status);
      };
      const t = setTimeout(() => {
        this.settledWaiters = this.settledWaiters.filter((w) => w !== done);
        resolve(this._status);
      }, ms);
      this.settledWaiters.push(done);
    });
  }

  private setStatus(s: HelperStatus) {
    this._status = s;
    if (s.state !== 'starting') {
      const w = this.settledWaiters;
      this.settledWaiters = [];
      w.forEach((f) => f());
    }
    for (const l of this.statusListeners) {
      try {
        l(s);
      } catch {
        /* listener errors must not break the client */
      }
    }
  }

  private fireReset(r: SessionResetReason) {
    for (const l of this.resetListeners) {
      try {
        l(r);
      } catch {
        /* ignore */
      }
    }
  }

  /** Starts a new helper session. Tears down whatever the previous session owned (helper-side). */
  async hello(): Promise<HelloResult> {
    const hadSession = this.sessionId !== null;
    this.sessionId = null;
    if (hadSession) {
      this.failAll('invalid_session', 'The helper session was replaced');
      this.fireReset('new_session');
    }
    try {
      const res = await this.send<HelloResult>('hello', { clientVersion: this.opts.clientVersion }, undefined, true);
      if (!res || typeof res.sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(res.sessionId)) throw new HelperError('internal', 'Invalid hello response');
      this.sessionId = res.sessionId;
      this.setStatus({ state: 'ready', hello: res, generation: this._status.generation + 1 });
      return res;
    } catch (e) {
      this.setStatus({ state: 'unavailable', reason: e instanceof Error ? e.message : String(e), generation: this._status.generation });
      throw e;
    }
  }

  /** The extension disconnected or could not be reached. */
  markUnavailable(reason: string) {
    const hadSession = this.sessionId !== null;
    this.sessionId = null;
    this.failAll('helper_unavailable', reason);
    this.setStatus({ state: 'unavailable', reason, generation: this._status.generation });
    if (hadSession) this.fireReset('helper_disconnected');
  }

  request<T = unknown>(op: string, params: object = {}, opts?: { timeoutMs?: number }): Promise<T> {
    if (op === 'hello') return this.hello() as Promise<T>;
    return this.send<T>(op, params, opts?.timeoutMs, false);
  }

  private send<T>(op: string, params: object, timeoutMs: number | undefined, noSession: boolean): Promise<T> {
    if (!noSession && !this.sessionId) {
      return Promise.reject(new HelperError('helper_unavailable', 'The PassVault desktop helper is not connected'));
    }
    const id = this.newId();
    if (!ID_RE.test(id)) return Promise.reject(new HelperError('internal', 'invalid request id'));
    const env: RequestEnvelope = { v: 1, id, op, params };
    if (!noSession) env.sessionId = this.sessionId!;
    const ms = timeoutMs ?? OP_TIMEOUTS[op] ?? this.defaultTimeout;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new HelperError('timeout', `The desktop helper did not answer (${op})`));
      }, ms);
      this.pending.set(id, { op, resolve: resolve as (v: unknown) => void, reject, timer });
      this.transport.send(env).catch((e: unknown) => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : 'dispatch failed';
        reject(new HelperError('helper_unavailable', `Could not reach the desktop helper: ${msg}`));
      });
    });
  }

  private failAll(code: HelperErrorCode, message: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new HelperError(code, message));
    }
  }

  /** Handles a `pv.response` payload (exported for tests). */
  handleResponse(raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Partial<ResponseEnvelope> & { id?: unknown; ok?: unknown };
    if (r.v !== 1 || typeof r.id !== 'string' || r.id === '') return;
    const p = this.pending.get(r.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(r.id);
    if (r.ok === true) {
      p.resolve((r as { result?: unknown }).result ?? {});
      return;
    }
    const err = (r as { error?: { code?: unknown; message?: unknown } }).error;
    const code = typeof err?.code === 'string' ? err.code : 'internal';
    const message = typeof err?.message === 'string' ? err.message : 'helper error';
    p.reject(new HelperError(code, message));
    if (code === 'invalid_session' && p.op !== 'hello' && this.sessionId) {
      // The helper no longer knows our session (it restarted or another client said hello).
      this.sessionId = null;
      this.setStatus({ state: 'unavailable', reason: 'The helper session ended', generation: this._status.generation });
      this.fireReset('invalid_session');
    }
  }

  /** Handles a `pv.event` payload (exported for tests). */
  handleEvent(raw: unknown) {
    if (!raw || typeof raw !== 'object') return;
    const e = raw as Partial<EventEnvelope>;
    if (e.v !== 1 || typeof e.type !== 'string' || typeof e.sessionId !== 'string') return;
    if (!this.sessionId || e.sessionId !== this.sessionId) return; // stale or foreign session
    const set = this.listeners.get(e.type);
    if (!set) return;
    for (const l of [...set]) {
      try {
        (l as (d: unknown) => void)(e.data ?? {});
      } catch {
        /* listener errors must not break event delivery */
      }
    }
  }
}

/** User-facing text for helper error codes. */
export function describeHelperError(e: unknown): string {
  if (!(e instanceof HelperError)) return e instanceof Error ? e.message : String(e);
  switch (e.code) {
    case 'host_key_unknown':
      return 'The server’s host key is not trusted yet. Connect once inside PassVault (or run “Test connection”) to verify and trust it.';
    case 'host_key_mismatch':
      return 'The server presented a different host key than the one you trusted. The connection was stopped.';
    case 'auth_failed':
      return 'Authentication failed. Check the username and credentials.';
    case 'connect_failed':
      return `Could not connect to the server. ${e.message}`;
    case 'denied':
      return e.message || 'The action was denied.';
    case 'unavailable':
      return e.message || 'This feature is unavailable.';
    case 'helper_unavailable':
      return 'The PassVault desktop helper is not running. Quit and reopen PassVault.';
    case 'timeout':
      return e.message;
    case 'invalid_session':
      return 'The desktop helper restarted. Try again.';
    default:
      return e.message || e.code;
  }
}
