import { isProductionEnvironment as isProduction } from '@passvault/types';
import type { DecryptedItem } from '@passvault/vault-core';
import { describeHelperError, HelperError, type HelperClient, type HelperStatus, type SessionResetReason } from '../ipc/helper-client';
import type { AgentStatus, HostKeyEvent, PromptEvent, SignRequestEvent, SshStateName, SshTestResult } from '../ipc/types';
import { buildConnection, buildExternalParams, HopBuildError, isSshConnection, isSshKey, resolveJumpItem, type SessionTrust, type SshConnectionItem } from '../ssh/hops';
import { persistTrustedHostKey, type TrustSessionLike } from '../ssh/host-keys';
import { b64ToBytes, bytesToB64 } from '../util/b64';
import { Store } from '../util/store';

/** The subset of VaultSession the desktop controller needs. */
export interface SessionLike extends TrustSessionLike {
  onLock(fn: () => void): () => void;
  lock(): void;
  readonly isUnlocked: boolean;
}

export interface TerminalSink {
  write(data: Uint8Array): void;
}

/** Owns the xterm instances (disposing wipes their scrollback). */
export interface TerminalHost {
  dispose(connId: string): void;
  disposeAll(): void;
}

export interface UiBridge {
  goToTerminal(): void;
  openItem(itemId: string): void;
  bringToFront(): void;
}

export type NoticeTone = 'info' | 'success' | 'error' | 'warn';

export interface TerminalTab {
  connId: string;
  itemId: string;
  title: string;
  /** user@host:port */
  endpoint: string;
  /** user@jump:port when a jump host is used */
  via?: string;
  environment: string | null;
  production: boolean;
  phase: SshStateName | 'starting';
  ended: boolean;
  error?: { code?: string; message: string };
  /** why the session ended when it was not the server (lock, helper restart, user) */
  endReason?: string;
  exit?: { status?: number; signal?: string };
}

export type HostKeyRequest =
  | { id: string; kind: 'connect'; connId: string; hop: 'jump' | 'target'; ev: HostKeyEvent; itemId: string; itemTitle: string; canSave: boolean }
  | { id: string; kind: 'test'; hop: 'jump' | 'target'; ev: HostKeyEvent; itemId: string; itemTitle: string; canSave: boolean; resolve: (trust: boolean) => void }
  | { id: string; kind: 'mismatch'; connId?: string; hop: 'jump' | 'target'; ev: HostKeyEvent; itemId: string; itemTitle: string };

export interface PromptRequest extends PromptEvent {
  id: string;
  itemId: string | null;
  itemTitle: string;
  hasStoredPassword: boolean;
}

export interface ConfirmRequest {
  id: string;
  title: string;
  body: string;
  url?: string;
  lines?: { shown: string[]; total: number };
  warning?: string;
  confirmLabel: string;
  tone: 'primary' | 'danger';
  resolve: (ok: boolean) => void;
}

export interface Notice {
  id: number;
  message: string;
  tone: NoticeTone;
}

export interface DesktopState {
  helper: HelperStatus;
  tabs: TerminalTab[];
  activeTabId: string | null;
  hostKeys: HostKeyRequest[];
  prompts: PromptRequest[];
  signRequests: SignRequestEvent[];
  confirms: ConfirmRequest[];
  agent: AgentStatus | null;
  notices: Notice[];
}

export const LOCK_REASON = 'Disconnected because the vault locked';
const SIGN_REQUEST_TTL_MS = 125_000;
const MAX_BUFFER = 2 * 1024 * 1024;
const MAX_WRITE = 48 * 1024;

let seq = 0;
const uid = (p: string) => {
  const c = globalThis.crypto;
  return `${p}-${c && typeof c.randomUUID === 'function' ? c.randomUUID() : `${Date.now()}-${++seq}`}`;
};

export class DesktopController {
  readonly store: Store<DesktopState>;
  private session: SessionLike | null = null;
  private unsubLock: (() => void) | null = null;
  private sinks = new Map<string, TerminalSink>();
  private buffers = new Map<string, { chunks: Uint8Array[]; size: number }>();
  private conns = new Map<string, { targetItemId: string; jumpItemId?: string }>();
  private resizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private signTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sessionTrust: SessionTrust = new Map();
  private terminalHost: TerminalHost | null = null;
  private toaster: ((message: string, tone: NoticeTone) => void) | null = null;
  private noticeSeq = 0;
  lastSize = { cols: 120, rows: 32 };

  constructor(
    readonly helper: HelperClient,
    private readonly ui: UiBridge,
    private readonly hooks: { onLocked?: () => void } = {},
  ) {
    this.store = new Store<DesktopState>({
      helper: helper.status,
      tabs: [],
      activeTabId: null,
      hostKeys: [],
      prompts: [],
      signRequests: [],
      confirms: [],
      agent: null,
      notices: [],
    });
    helper.onStatus((s) => {
      this.store.set({ helper: s });
      if (s.state === 'ready') void this.refreshAgent();
    });
    helper.onSessionReset((r) => this.onHelperSessionReset(r));
    helper.on('ssh.state', (d) => this.onSshState(d.connId, d.state, d.code, d.message));
    helper.on('ssh.data', (d) => this.onData(d.connId, d.dataB64));
    helper.on('ssh.exit', (d) => {
      if (d.exitStatus === undefined && !d.signal) return;
      this.patchTab(d.connId, { exit: { ...(d.exitStatus !== undefined ? { status: d.exitStatus } : {}), ...(d.signal ? { signal: d.signal } : {}) } });
    });
    helper.on('ssh.hostKey', (d) => this.onHostKey(d));
    helper.on('ssh.prompt', (d) => this.onPrompt(d));
    helper.on('agent.signRequest', (d) => this.onSignRequest(d));
    helper.on('agent.state', () => void this.refreshAgent());
    helper.on('system.event', (d) => {
      if (d.type === 'screen_locked' || d.type === 'will_sleep') this.session?.lock();
    });
  }

  // ------------------------------------------------------------------ wiring

  attachSession(session: SessionLike) {
    if (this.session === session) return;
    this.unsubLock?.();
    this.session = session;
    this.unsubLock = session.onLock(() => this.onVaultLocked());
  }

  setTerminalHost(host: TerminalHost | null) {
    this.terminalHost = host;
  }

  setToaster(fn: ((message: string, tone: NoticeTone) => void) | null) {
    this.toaster = fn;
  }

  notify(message: string, tone: NoticeTone = 'info') {
    if (this.toaster) {
      this.toaster(message, tone);
      return;
    }
    const id = ++this.noticeSeq;
    this.store.set((s) => ({ notices: [...s.notices.slice(-3), { id, message, tone }] }));
    setTimeout(() => this.dismissNotice(id), tone === 'error' ? 8000 : 4000);
  }

  dismissNotice(id: number) {
    this.store.set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
  }

  private items(): DecryptedItem[] {
    return this.session?.getSnapshot().items ?? [];
  }

  private requireUnlocked(): SessionLike {
    if (!this.session || !this.session.isUnlocked) throw new Error('Unlock the vault first');
    return this.session;
  }

  openItem(itemId: string) {
    this.ui.openItem(itemId);
  }

  // ------------------------------------------------------------------ confirm

  confirm(opts: Omit<ConfirmRequest, 'id' | 'resolve' | 'tone' | 'confirmLabel'> & { tone?: 'primary' | 'danger'; confirmLabel?: string }): Promise<boolean> {
    return new Promise((resolve) => {
      const req: ConfirmRequest = { tone: 'primary', confirmLabel: 'Continue', ...opts, id: uid('cf'), resolve };
      this.store.set((s) => ({ confirms: [...s.confirms, req] }));
    });
  }

  resolveConfirm(id: string, ok: boolean) {
    const req = this.store.get().confirms.find((c) => c.id === id);
    if (!req) return;
    this.store.set((s) => ({ confirms: s.confirms.filter((c) => c.id !== id) }));
    req.resolve(ok);
  }

  // ------------------------------------------------------------------ lock / helper reset

  /** session.onLock hook: runs synchronously while the vault locks. */
  private onVaultLocked() {
    if (this.helper.isReady) {
      // Disconnects app-managed SSH sessions, removes agent keys, cancels prompts.
      void this.helper.request('vault.locked', {}).catch(() => undefined);
    }
    this.endAllTabs(LOCK_REASON);
    this.terminalHost?.disposeAll();
    this.sessionTrust.clear();
    this.clearQueues();
    this.store.set((s) => ({ agent: s.agent ? { ...s.agent, locked: true, keys: [] } : s.agent }));
    this.hooks.onLocked?.();
  }

  private onHelperSessionReset(r: SessionResetReason) {
    const reason =
      r === 'new_session' ? 'Disconnected because the desktop helper session was restarted' : 'Disconnected because the desktop helper stopped or restarted';
    if (this.store.get().tabs.some((t) => !t.ended)) this.notify(reason, 'warn');
    this.endAllTabs(reason);
    this.clearQueues();
    this.store.set({ agent: null });
  }

  private endAllTabs(reason: string) {
    this.store.set((s) => ({
      tabs: s.tabs.map((t) => (t.ended ? t : { ...t, ended: true, phase: 'closed' as const, endReason: reason })),
    }));
    this.buffers.clear();
  }

  private clearQueues() {
    for (const h of this.store.get().hostKeys) if (h.kind === 'test') h.resolve(false);
    for (const t of this.signTimers.values()) clearTimeout(t);
    this.signTimers.clear();
    this.store.set({ hostKeys: [], prompts: [], signRequests: [] });
  }

  // ------------------------------------------------------------------ terminals

  registerSink(connId: string, sink: TerminalSink): () => void {
    this.sinks.set(connId, sink);
    const buf = this.buffers.get(connId);
    if (buf) {
      this.buffers.delete(connId);
      for (const c of buf.chunks) sink.write(c);
    }
    return () => {
      if (this.sinks.get(connId) === sink) this.sinks.delete(connId);
    };
  }

  private onData(connId: string, dataB64: string) {
    if (!this.store.get().tabs.some((t) => t.connId === connId && !t.ended)) return;
    let bytes: Uint8Array;
    try {
      bytes = b64ToBytes(dataB64);
    } catch {
      return;
    }
    const sink = this.sinks.get(connId);
    if (sink) {
      sink.write(bytes);
      return;
    }
    const buf = this.buffers.get(connId) ?? { chunks: [], size: 0 };
    buf.chunks.push(bytes);
    buf.size += bytes.length;
    while (buf.size > MAX_BUFFER && buf.chunks.length > 1) buf.size -= buf.chunks.shift()!.length;
    this.buffers.set(connId, buf);
  }

  private patchTab(connId: string, patch: Partial<TerminalTab>) {
    this.store.set((s) => ({ tabs: s.tabs.map((t) => (t.connId === connId ? { ...t, ...patch } : t)) }));
  }

  private tab(connId: string) {
    return this.store.get().tabs.find((t) => t.connId === connId);
  }

  private onSshState(connId: string, state: SshStateName, code?: string, message?: string) {
    const t = this.tab(connId);
    if (!t) return;
    if (state === 'error') {
      this.patchTab(connId, { phase: 'error', error: { ...(code ? { code } : {}), message: message || code || 'Connection error' } });
      return;
    }
    if (state === 'closed') {
      this.patchTab(connId, { ended: true, phase: t.error ? 'error' : 'closed' });
      this.conns.delete(connId);
      this.store.set((s) => ({
        hostKeys: s.hostKeys.filter((h) => h.kind === 'mismatch' || h.kind === 'test' || h.connId !== connId),
        prompts: s.prompts.filter((p) => p.connId !== connId),
      }));
      return;
    }
    if (!t.ended) this.patchTab(connId, { phase: state });
  }

  setActiveTab(connId: string | null) {
    this.store.set({ activeTabId: connId });
  }

  /** Opens a new terminal tab for an ssh_connection item. Returns the connId. */
  async connect(itemId: string): Promise<string | null> {
    let session: SessionLike;
    try {
      session = this.requireUnlocked();
    } catch (e) {
      this.notify((e as Error).message, 'error');
      return null;
    }
    if (!this.helper.isReady) {
      this.notify(describeHelperError(new HelperError('helper_unavailable', '')), 'error');
      return null;
    }
    const items = session.getSnapshot().items;
    const item = items.find((i) => i.id === itemId);
    if (!isSshConnection(item)) {
      this.notify('Server item not found', 'error');
      return null;
    }
    let conn;
    try {
      conn = buildConnection(item, items, this.sessionTrust);
    } catch (e) {
      this.notify(e instanceof HopBuildError ? e.message : String(e), 'error');
      return null;
    }
    const connId = uid('c');
    const f = item.payload.fields;
    const tab: TerminalTab = {
      connId,
      itemId,
      title: item.payload.title,
      endpoint: `${f.username}@${f.host}:${f.port}`,
      ...(conn.jumpItem ? { via: `${conn.jumpItem.payload.fields.username}@${conn.jumpItem.payload.fields.host}:${conn.jumpItem.payload.fields.port}` } : {}),
      environment: item.payload.environment ?? null,
      production: isProduction(item.payload.environment),
      phase: 'starting',
      ended: false,
    };
    this.conns.set(connId, { targetItemId: item.id, ...(conn.jumpItem ? { jumpItemId: conn.jumpItem.id } : {}) });
    this.store.set((s) => ({ tabs: [...s.tabs, tab], activeTabId: connId }));
    this.ui.goToTerminal();
    try {
      await this.helper.request('ssh.connect', {
        connId,
        label: item.payload.title.slice(0, 300),
        target: conn.target,
        ...(conn.jump ? { jump: conn.jump } : {}),
        cols: this.lastSize.cols,
        rows: this.lastSize.rows,
      });
      const cur = this.tab(connId);
      if (cur && cur.phase === 'starting') this.patchTab(connId, { phase: 'connecting' });
    } catch (e) {
      this.patchTab(connId, {
        ended: true,
        phase: 'error',
        error: { code: e instanceof HelperError ? e.code : undefined, message: describeHelperError(e) },
      });
    }
    return connId;
  }

  async reconnect(connId: string) {
    const t = this.tab(connId);
    if (!t) return;
    this.closeTab(connId);
    await this.connect(t.itemId);
  }

  disconnect(connId: string) {
    const t = this.tab(connId);
    if (!t || t.ended) return;
    this.patchTab(connId, { endReason: 'Disconnected' });
    void this.helper.request('ssh.disconnect', { connId }).catch(() => undefined);
  }

  closeTab(connId: string) {
    this.disconnect(connId);
    this.terminalHost?.dispose(connId);
    this.sinks.delete(connId);
    this.buffers.delete(connId);
    this.conns.delete(connId);
    this.store.set((s) => {
      const idx = s.tabs.findIndex((t) => t.connId === connId);
      const tabs = s.tabs.filter((t) => t.connId !== connId);
      const activeTabId = s.activeTabId === connId ? (tabs[Math.min(idx, tabs.length - 1)]?.connId ?? null) : s.activeTabId;
      return {
        tabs,
        activeTabId,
        hostKeys: s.hostKeys.filter((h) => h.kind === 'test' || h.connId !== connId),
        prompts: s.prompts.filter((p) => p.connId !== connId),
      };
    });
  }

  /** Terminal input (string from xterm onData / binary string from onBinary). */
  write(connId: string, data: string, binary = false) {
    const t = this.tab(connId);
    if (!t || t.ended || t.phase !== 'connected') return;
    const bytes = binary ? Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff) : new TextEncoder().encode(data);
    for (let i = 0; i < bytes.length; i += MAX_WRITE) {
      void this.helper.request('ssh.write', { connId, dataB64: bytesToB64(bytes.subarray(i, i + MAX_WRITE)) }).catch(() => undefined);
    }
  }

  /** Debounced `ssh.resize`. */
  resize(connId: string, cols: number, rows: number, delayMs = 120) {
    if (cols < 1 || rows < 1) return;
    this.lastSize = { cols: Math.min(cols, 2000), rows: Math.min(rows, 2000) };
    const prev = this.resizeTimers.get(connId);
    if (prev) clearTimeout(prev);
    this.resizeTimers.set(
      connId,
      setTimeout(() => {
        this.resizeTimers.delete(connId);
        const t = this.tab(connId);
        if (!t || t.ended) return;
        void this.helper.request('ssh.resize', { connId, cols: this.lastSize.cols, rows: this.lastSize.rows }).catch(() => undefined);
      }, delayMs),
    );
  }

  // ------------------------------------------------------------------ host keys

  private hopItemId(connId: string, hop: 'jump' | 'target'): string | null {
    const c = this.conns.get(connId);
    if (!c) return null;
    return hop === 'jump' ? (c.jumpItemId ?? null) : c.targetItemId;
  }

  private onHostKey(ev: HostKeyEvent) {
    const connId = ev.connId ?? '';
    const itemId = this.hopItemId(connId, ev.hop);
    if (!itemId) return;
    const item = this.items().find((i) => i.id === itemId);
    const itemTitle = item?.payload.title ?? 'Server';
    if (ev.status === 'mismatch') {
      this.store.set((s) => ({ hostKeys: [...s.hostKeys, { id: uid('hk'), kind: 'mismatch', connId, hop: ev.hop, ev, itemId, itemTitle }] }));
      this.ui.bringToFront();
      return;
    }
    this.store.set((s) => ({
      hostKeys: [...s.hostKeys, { id: uid('hk'), kind: 'connect', connId, hop: ev.hop, ev, itemId, itemTitle, canSave: !!item && item.role !== 'viewer' }],
    }));
    this.patchTab(connId, { phase: 'verifying_host' });
  }

  /** Answer for a host-key dialog. Trust also persists the key into the item (never for mismatches). */
  async decideHostKey(id: string, trust: boolean) {
    const req = this.store.get().hostKeys.find((h) => h.id === id);
    if (!req) return;
    this.store.set((s) => ({ hostKeys: s.hostKeys.filter((h) => h.id !== id) }));
    if (req.kind === 'mismatch') return;
    if (req.kind === 'test') {
      req.resolve(trust);
      return;
    }
    try {
      await this.helper.request('ssh.hostKeyDecision', { connId: req.connId, hop: req.hop, trust });
    } catch (e) {
      this.notify(describeHelperError(e), 'error');
      return;
    }
    if (trust) await this.saveTrustedKey(req.itemId, req.ev);
  }

  private async saveTrustedKey(itemId: string, ev: HostKeyEvent) {
    if (!this.session) return;
    try {
      const r = await persistTrustedHostKey(this.session, itemId, ev, this.sessionTrust);
      if (r.saved) this.notify(`Host key for ${ev.hostPort} saved`, 'success');
      else this.notify(r.reason, 'warn');
    } catch (e) {
      this.notify(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  // ------------------------------------------------------------------ keyboard-interactive

  private onPrompt(p: PromptEvent) {
    const itemId = this.hopItemId(p.connId, p.hop);
    const item = itemId ? this.items().find((i) => i.id === itemId) : undefined;
    const hasStoredPassword = isSshConnection(item) && !!item.payload.fields.password;
    this.store.set((s) => ({ prompts: [...s.prompts, { ...p, id: uid('pr'), itemId: itemId ?? null, itemTitle: item?.payload.title ?? 'Server', hasStoredPassword }] }));
    this.patchTab(p.connId, { phase: 'authenticating' });
  }

  /** Read on explicit user click only ("Fill stored password"). */
  storedPasswordFor(promptId: string): string {
    const p = this.store.get().prompts.find((x) => x.id === promptId);
    if (!p?.itemId) return '';
    const item = this.items().find((i) => i.id === p.itemId);
    return isSshConnection(item) ? (item.payload.fields.password ?? '') : '';
  }

  async answerPrompt(id: string, answers: string[] | null) {
    const p = this.store.get().prompts.find((x) => x.id === id);
    if (!p) return;
    this.store.set((s) => ({ prompts: s.prompts.filter((x) => x.id !== id) }));
    const params = answers ? { connId: p.connId, promptId: p.promptId, answers } : { connId: p.connId, promptId: p.promptId, cancel: true };
    await this.helper.request('ssh.promptResponse', params).catch((e) => this.notify(describeHelperError(e), 'error'));
  }

  // ------------------------------------------------------------------ connection test

  async testConnection(itemId: string): Promise<{ ok: boolean; message: string }> {
    const session = this.requireUnlocked();
    if (!this.helper.isReady) throw new HelperError('helper_unavailable', '');
    for (let attempt = 0; attempt < 4; attempt++) {
      const items = session.getSnapshot().items;
      const item = items.find((i) => i.id === itemId);
      if (!isSshConnection(item)) throw new Error('Server item not found');
      const conn = buildConnection(item, items, this.sessionTrust);
      const res = await this.helper.request<SshTestResult>('ssh.test', { target: conn.target, ...(conn.jump ? { jump: conn.jump } : {}) });
      if (res.ok) return { ok: true, message: res.message || 'Connected and authenticated' };
      if (res.stage === 'host_key' && res.hostKey) {
        const hop = res.hostKey.hop === 'jump' ? 'jump' : 'target';
        const hopItem: SshConnectionItem | undefined = hop === 'jump' ? conn.jumpItem : conn.targetItem;
        if (!hopItem) return { ok: false, message: res.message };
        if (res.hostKey.status === 'mismatch') {
          this.store.set((s) => ({ hostKeys: [...s.hostKeys, { id: uid('hk'), kind: 'mismatch', hop, ev: res.hostKey!, itemId: hopItem.id, itemTitle: hopItem.payload.title }] }));
          return { ok: false, message: 'The server’s host key changed. Nothing was sent to the server.' };
        }
        const trust = await new Promise<boolean>((resolve) => {
          this.store.set((s) => ({
            hostKeys: [...s.hostKeys, { id: uid('hk'), kind: 'test', hop, ev: res.hostKey!, itemId: hopItem.id, itemTitle: hopItem.payload.title, canSave: hopItem.role !== 'viewer', resolve }],
          }));
        });
        if (!trust) return { ok: false, message: 'Host key not trusted' };
        await this.saveTrustedKey(hopItem.id, res.hostKey);
        continue;
      }
      return { ok: false, message: res.message || `Failed at ${res.stage}` };
    }
    return { ok: false, message: 'Too many host-key rounds' };
  }

  // ------------------------------------------------------------------ external terminal

  async openExternal(itemId: string, app: 'terminal' | 'iterm') {
    const session = this.requireUnlocked();
    const items = session.getSnapshot().items;
    const item = items.find((i) => i.id === itemId);
    if (!isSshConnection(item)) throw new Error('Server item not found');
    const jump = resolveJumpItem(item, items);
    // Key-based hops authenticate through the PassVault agent (keys never leave the helper).
    for (const hop of [item, ...(jump ? [jump] : [])]) {
      if (hop.payload.fields.authMethod !== 'key') continue;
      const keyId = hop.payload.fields.sshKeyItemId;
      const loaded = keyId && this.store.get().agent?.keys?.some((k) => k.keyId === keyId);
      if (keyId && (!loaded || !this.store.get().agent?.running)) {
        const keyItem = items.find((i) => i.id === keyId);
        const ok = await this.confirm({
          title: 'Use the PassVault SSH agent?',
          body: `“${hop.payload.title}” authenticates with the SSH key “${keyItem?.payload.title ?? 'key'}”. The external ssh client can only use it through the PassVault SSH agent. Start the agent and add the key? Every signature will still ask for your approval.`,
          confirmLabel: 'Add key and open',
        });
        if (!ok) return;
        await this.addKeyToAgent(keyId, { quiet: true });
      }
    }
    await this.refreshAgent();
    const { params, missingTrust } = buildExternalParams(item, items, { app, agentRunning: !!this.store.get().agent?.running, sessionTrust: this.sessionTrust });
    if (missingTrust.length) {
      this.notify(
        `No trusted host key for the ${missingTrust.join(' and ')} server yet. Connect once inside PassVault or run “Test connection” to verify the fingerprint first.`,
        'warn',
      );
      return;
    }
    await this.helper.request('term.openExternal', params);
    const usesPassword = [item, ...(jump ? [jump] : [])].some((h) => h.payload.fields.authMethod === 'password' || h.payload.fields.authMethod === 'keyboard_interactive');
    this.notify(
      `Opened in ${app === 'iterm' ? 'iTerm' : 'Terminal'}.${usesPassword ? ' Passwords are never passed to external terminals; type it when ssh asks.' : ''} Sessions started outside PassVault keep running when the vault locks.`,
      'info',
    );
  }

  // ------------------------------------------------------------------ agent

  async refreshAgent(): Promise<AgentStatus | null> {
    if (!this.helper.isReady) return null;
    try {
      const st = await this.helper.request<AgentStatus>('agent.status', {});
      this.store.set({ agent: { ...st, keys: st.keys ?? [] } });
      return st;
    } catch {
      return null;
    }
  }

  async startAgent() {
    await this.helper.request('agent.start', {});
    await this.refreshAgent();
  }

  async stopAgent() {
    await this.helper.request('agent.stop', {});
    await this.refreshAgent();
  }

  async addKeyToAgent(keyItemId: string, opts: { quiet?: boolean } = {}) {
    const session = this.requireUnlocked();
    const item = session.getSnapshot().items.find((i) => i.id === keyItemId);
    if (!isSshKey(item) || !item.payload.fields.privateKey) throw new Error('This item has no private key');
    if (!this.store.get().agent?.running) await this.helper.request('agent.start', {});
    const r = await this.helper.request<{ fingerprint: string }>('agent.addKey', {
      keyId: item.id,
      name: item.payload.title.slice(0, 200),
      privateKey: item.payload.fields.privateKey,
      ...(item.payload.fields.passphrase ? { passphrase: item.payload.fields.passphrase } : {}),
    });
    await this.refreshAgent();
    if (!opts.quiet) this.notify(`Added “${item.payload.title}” to the SSH agent (${r.fingerprint})`, 'success');
  }

  async removeKeyFromAgent(keyId: string) {
    await this.helper.request('agent.removeKey', { keyId });
    await this.refreshAgent();
  }

  isKeyInAgent(keyId: string): boolean {
    return !!this.store.get().agent?.keys?.some((k) => k.keyId === keyId);
  }

  private onSignRequest(r: SignRequestEvent) {
    this.store.set((s) => ({ signRequests: [...s.signRequests.filter((x) => x.requestId !== r.requestId), r] }));
    // The helper denies after 2 minutes without an answer; drop the stale dialog.
    this.signTimers.set(
      r.requestId,
      setTimeout(() => {
        this.signTimers.delete(r.requestId);
        this.store.set((s) => ({ signRequests: s.signRequests.filter((x) => x.requestId !== r.requestId) }));
      }, SIGN_REQUEST_TTL_MS),
    );
    this.ui.bringToFront();
  }

  async decideSign(requestId: string, decision: 'deny' | 'once' | 'timed', minutes?: number) {
    const t = this.signTimers.get(requestId);
    if (t) clearTimeout(t);
    this.signTimers.delete(requestId);
    this.store.set((s) => ({ signRequests: s.signRequests.filter((x) => x.requestId !== requestId) }));
    try {
      await this.helper.request('agent.signDecision', { requestId, decision, ...(decision === 'timed' ? { minutes } : {}) });
    } catch (e) {
      if (!(e instanceof HelperError && e.code === 'not_found')) this.notify(describeHelperError(e), 'error');
    }
  }
}

