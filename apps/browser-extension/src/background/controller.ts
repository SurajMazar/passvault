import { z } from 'zod';
import type { ItemPayload } from '@passvault/types';
import {
  generatePassphrase,
  generatePassword,
  passphraseEntropyBits,
  passwordEntropyBits,
  wipe,
} from '@passvault/crypto';
import {
  cardBrand,
  cardExpiresAt,
  cardExpiryLabel,
  cardLast4,
  filterItems,
  matchLogin,
  newItem,
  normalizeLoginUrl,
  pageOrigin,
  VaultLockedError,
  type DecryptedItem,
  type SessionSnapshot,
  type VaultSession,
} from '@passvault/vault-core';
import {
  OFFSCREEN_TARGET,
  UNPRIVILEGED,
  requestSchema,
  type CaptureResponse,
  type CardFillResponse,
  type ErrorCode,
  type FillResponse,
  type LoginMatch,
  type MatchesResponse,
  type PopupPhase,
  type PopupState,
  type Request,
  type ResponseMap,
  type Result,
  type TabInfo,
} from '../shared/protocol';
import { pvCaptureCredentials, pvFillCard, pvFillCredentials, type PageFillResult } from '../inject/page-functions';
import { evaluateFill } from './autofill';
import type { ChromeLike, SenderLike } from './chrome-api';
import { itemDetail, summarize } from './detail';
import { TOKEN_KEY } from './platform';
import type { ServerCheck } from '@passvault/vault-core/servers';
import type { ServerInfo, TouchIdStatus } from '../shared/protocol';
import { checkSender } from './sender';
import type { SavePromptManager } from './save-prompt';

export const RESUME_KEY = 'pv.resumeUserKey';
export const CLIPBOARD_PENDING_KEY = 'pv.clipboardClearPending';
export const AUTOLOCK_ALARM = 'pv-autolock';
export const CLIPBOARD_ALARM = 'pv-clipboard-clear';
/** chrome.alarms fires no more often than every 30 seconds. */
export const MIN_ALARM_SECONDS = 30;

type SessionLike = Pick<
  VaultSession,
  | 'init'
  | 'getSnapshot'
  | 'subscribe'
  | 'onLock'
  | 'login'
  | 'verifyMfa'
  | 'startMfaEnrollment'
  | 'confirmMfaEnrollment'
  | 'acknowledgeRecoveryCodes'
  | 'cancelLogin'
  | 'unlock'
  | 'lock'
  | 'logout'
  | 'syncNow'
  | 'saveItem'
  | 'updateItem'
  | 'exportUserKeyForResume'
  | 'resumeWithUserKey'
  | 'isUnlocked'
  | 'touch'
  | 'setOnline'
  | 'unlockWithBiometrics'
  | 'enableBiometrics'
  | 'disableBiometrics'
  | 'biometricsEnabled'
>;

export interface ControllerDeps {
  chrome: ChromeLike;
  session: SessionLike;
  webUrl: string;
  /** opt-in "offer to save passwords" feature (content-script side is in save-prompt.ts) */
  savePrompt?: Pick<SavePromptManager, 'status' | 'setEnabled' | 'setInline' | 'clearNeverList' | 'clearAll'>;
  /** Logger that receives only fixed strings and codes — never payloads. */
  log?: (event: string, detail?: string) => void;
  /** storage key of this server's session token (default: the legacy global key) */
  tokenKey?: string;
  /** server connection (index.ts rebuilds the session when the server changes) */
  server?: ServerControl;
  /** Touch ID availability (the platform's biometrics adapter) */
  touchIdStatus?: () => Promise<{ available: boolean; reason?: string }>;
}

/** What the controller may do with the server connection (implemented by ServerManager). */
export interface ServerControl {
  info(): ServerInfo;
  check(url: string): Promise<ServerCheck>;
  connect(url: string): Promise<string>;
  switchTo(id: string): Promise<string>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  setLocalDev(on: boolean): Promise<boolean>;
}

const LOCKED_TYPES = new Set<Request['type']>([
  'vault.list',
  'vault.matches',
  'vault.meta',
  'item.get',
  'item.secret',
  'cards.list',
  'card.secret',
  'card.fill',
  'autofill.fill',
  'autofill.capture',
  'item.saveLogin',
  'item.updatePassword',
]);

/** Shape check for what an injected capture function returned (page-controlled strings). */
const captureResultSchema = z.object({
  code: z.enum(['ok', 'not_top_frame']),
  origin: z.string().max(2048),
  url: z.string().max(8192),
  title: z.string().max(500),
  username: z.string().max(500),
  password: z.string().max(4096),
  foundPasswordField: z.boolean(),
});
const cardFillResultSchema = z.object({
  code: z.enum(['filled', 'origin_mismatch', 'no_card_field', 'not_top_frame']),
  filled: z.array(z.enum(['name', 'number', 'expiry', 'cvv'])).max(4),
});
const fillResultSchema = z.object({
  code: z.enum(['filled', 'origin_mismatch', 'no_password_field', 'not_top_frame']),
  filledUsername: z.boolean(),
});

export class ControllerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function b64encode(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64decode(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The background service worker's brain. Owns the VaultSession; every
 * privileged operation goes through `handleMessage`, which validates the
 * sender and the message before doing anything.
 */
export class BackgroundController {
  readonly ready: Promise<void>;
  private readonly c: ChromeLike;
  private readonly session: SessionLike;
  private readonly log: (event: string, detail?: string) => void;
  private stateListeners = new Set<(s: PopupState) => void>();
  private lastStateJson = '';
  private dataVersion = 0;
  private lastItemsRef: unknown = null;
  private resumeStored = false;
  private pendingAfterLock: Promise<void> | null = null;
  /** whether a server session token exists (unlocked-but-signed-out = offline copy only) */
  private hasToken = false;

  constructor(private readonly deps: ControllerDeps) {
    this.c = deps.chrome;
    this.session = deps.session;
    this.log = deps.log ?? (() => undefined);
    this.session.onLock(() => {
      // Covers every lock path (alarm, popup, in-memory timer, revoked session).
      this.pendingAfterLock = this.afterLocked();
      // Captured-but-unsaved passwords never outlive an unlocked session.
      void this.deps.savePrompt?.clearAll();
    });
    this.ready = this.start();
  }

  // --------------------------------------------------------------- lifecycle

  private async start() {
    try {
      await this.c.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    } catch {
      /* older Chrome: TRUSTED_CONTEXTS is the default anyway */
    }
    await this.session.init();
    await this.refreshToken();
    const stored = (await this.c.storage.session.get(RESUME_KEY))[RESUME_KEY];
    if (typeof stored === 'string') {
      if (this.session.getSnapshot().auth.phase === 'locked') {
        let key: Uint8Array | null = null;
        try {
          key = b64decode(stored);
          await this.session.resumeWithUserKey(key);
          this.resumeStored = true;
          this.log('resumed');
          await this.ensureAutolockAlarm();
        } catch {
          this.log('resume failed');
          await this.c.storage.session.remove(RESUME_KEY);
        } finally {
          if (key) wipe(key);
        }
      } else {
        await this.c.storage.session.remove(RESUME_KEY);
      }
    }
    this.session.subscribe((s) => this.onSnapshot(s));
  }

  onState(fn: (s: PopupState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  /** Re-sends the popup state (e.g. the saved servers changed). */
  pushState(): void {
    this.lastStateJson = '';
    this.onSnapshot(this.session.getSnapshot());
  }

  private onSnapshot(s: SessionSnapshot) {
    if (s.items !== this.lastItemsRef) {
      this.lastItemsRef = s.items;
      this.dataVersion++;
    }
    const st = this.popupState();
    const json = JSON.stringify(st);
    if (json === this.lastStateJson) return;
    this.lastStateJson = json;
    for (const l of this.stateListeners) l(st);
  }

  private async touchIdStatus(): Promise<TouchIdStatus> {
    const enabled = await this.session.biometricsEnabled();
    return { enabled, ...(await this.touchIdAvailability()) };
  }

  private async touchIdAvailability(): Promise<{ available: boolean; reason?: string }> {
    const status = this.deps.touchIdStatus;
    return status ? status() : { available: false, reason: 'Touch ID is not available' };
  }

  popupState(): PopupState {
    const s = this.session.getSnapshot();
    const a = s.auth;
    const phase: PopupPhase = a.phase;
    const email = a.phase === 'locked' || a.phase === 'mfa_verify' || a.phase === 'mfa_enroll' ? a.email : (s.user?.email ?? null);
    return {
      phase,
      email,
      name: a.phase === 'locked' ? a.name : (s.user?.name ?? null),
      ...(a.phase === 'mfa_enroll' ? { mfaEnroll: { secret: a.secret, otpauthUri: a.otpauthUri } } : {}),
      ...(a.phase === 'recovery_codes' ? { recoveryCodes: a.codes } : {}),
      hasSession: a.phase === 'locked' ? a.hasSession : (a.phase === 'unlocked' || a.phase === 'recovery_codes') && this.hasToken,
      ...(a.phase === 'locked' ? { biometricAvailable: a.biometricAvailable } : {}),
      online: s.online,
      sync: {
        state: s.sync.state,
        lastSyncAt: s.sync.lastSyncAt,
        lastError: s.sync.lastError,
        pending: s.sync.pending,
        failed: s.sync.failed,
        conflicts: s.sync.conflicts,
      },
      lockTimeoutMinutes: s.settings.lockTimeoutMinutes,
      clipboardClearSeconds: s.settings.clipboardClearSeconds,
      dataVersion: this.dataVersion,
      webUrl: this.deps.webUrl,
      ...(this.deps.server ? { server: this.deps.server.info() } : {}),
    };
  }

  // ------------------------------------------------------------- lock & keys

  /** Lock now: drop the resume key first so a concurrent SW restart cannot resume. */
  async lock(reason: string): Promise<void> {
    this.log('lock', reason);
    await this.c.storage.session.remove(RESUME_KEY);
    this.resumeStored = false;
    await this.c.alarms.clear(AUTOLOCK_ALARM);
    await this.runLocking(() => this.session.lock());
  }

  /** Run a session operation that may lock, then finish the lock clean-up exactly once. */
  private async runLocking(op: () => void | Promise<void>) {
    this.pendingAfterLock = null;
    await op();
    const p = this.pendingAfterLock ?? this.afterLocked();
    this.pendingAfterLock = null;
    await p;
  }

  private async afterLocked() {
    this.resumeStored = false;
    await this.c.storage.session.remove(RESUME_KEY);
    await this.c.alarms.clear(AUTOLOCK_ALARM);
    // A secret copied earlier should not outlive the unlocked session.
    const pending = (await this.c.storage.session.get(CLIPBOARD_PENDING_KEY))[CLIPBOARD_PENDING_KEY];
    if (pending) await this.clearClipboard();
  }

  /** Keep (or drop) the User Key copy in chrome.storage.session to match the unlock state. */
  private async syncResumeKey() {
    if (this.session.isUnlocked) {
      if (this.resumeStored) return;
      const key = this.session.exportUserKeyForResume();
      try {
        await this.c.storage.session.set({ [RESUME_KEY]: b64encode(key) });
        this.resumeStored = true;
      } finally {
        wipe(key);
      }
      await this.touchActivity();
    } else if (this.resumeStored) {
      this.resumeStored = false;
      await this.c.storage.session.remove(RESUME_KEY);
    }
  }

  private async ensureAutolockAlarm() {
    const minutes = this.session.getSnapshot().settings.lockTimeoutMinutes;
    if (minutes <= 0) return;
    if (!(await this.c.alarms.get(AUTOLOCK_ALARM))) await this.c.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: Math.max(MIN_ALARM_SECONDS / 60, minutes) });
  }

  /** User activity: restart the inactivity timer (chrome.alarms survives SW suspension). */
  private async touchActivity() {
    if (!this.session.isUnlocked) return;
    this.session.touch();
    const minutes = this.session.getSnapshot().settings.lockTimeoutMinutes;
    if (minutes > 0) await this.c.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: Math.max(MIN_ALARM_SECONDS / 60, minutes) });
    else await this.c.alarms.clear(AUTOLOCK_ALARM);
  }

  async onAlarm(alarm: { name: string }): Promise<void> {
    if (alarm.name === AUTOLOCK_ALARM) {
      // Remove the key before anything else so a resume racing with this cannot succeed later.
      await this.c.storage.session.remove(RESUME_KEY);
      await this.ready.catch(() => undefined);
      await this.lock('inactivity');
    } else if (alarm.name === CLIPBOARD_ALARM) {
      await this.clearClipboard();
    }
  }

  // ---------------------------------------------------------------- clipboard

  private async scheduleClipboardClear(): Promise<ResponseMap['clipboard.scheduleClear']> {
    const secs = this.session.getSnapshot().settings.clipboardClearSeconds;
    if (secs <= 0 || !this.c.offscreen) return { scheduled: false, seconds: 0 };
    const seconds = Math.max(MIN_ALARM_SECONDS, secs);
    await this.c.alarms.create(CLIPBOARD_ALARM, { when: Date.now() + seconds * 1000 });
    await this.c.storage.session.set({ [CLIPBOARD_PENDING_KEY]: true });
    return { scheduled: true, seconds };
  }

  private async clearClipboard() {
    await this.c.alarms.clear(CLIPBOARD_ALARM);
    await this.c.storage.session.remove(CLIPBOARD_PENDING_KEY);
    const off = this.c.offscreen;
    if (!off) return;
    try {
      const exists = off.hasDocument ? await off.hasDocument() : false;
      if (!exists) {
        await off.createDocument({
          url: 'offscreen.html',
          reasons: ['CLIPBOARD'],
          justification: 'Clear a copied secret from the clipboard after the configured timeout.',
        });
      }
      await this.c.runtime.sendMessage({ target: OFFSCREEN_TARGET, type: 'clipboard.clear' });
      await off.closeDocument();
      this.log('clipboard cleared');
    } catch {
      this.log('clipboard clear failed');
    }
  }

  // ---------------------------------------------------------------- messages

  async handleMessage(raw: unknown, sender: SenderLike | undefined): Promise<Result<unknown>> {
    let type = 'unknown';
    try {
      if (!sender || sender.id !== this.c.runtime.id) return this.fail('forbidden', 'Unknown sender.', type);
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) return this.fail('invalid_message', 'Malformed request.', type);
      const req = parsed.data;
      type = req.type;
      const privileged = !UNPRIVILEGED.has(req.type);
      const check = checkSender(this.c, sender, privileged);
      if (!check.ok) return this.fail('forbidden', 'This request is only accepted from the PassVault popup.', `${type}:${check.reason}`);
      await this.ready;
      if (privileged) await this.touchActivity();
      if (LOCKED_TYPES.has(req.type) && !this.session.isUnlocked) throw new VaultLockedError();
      if (req.type.startsWith('auth.') || req.type === 'vault.sync') {
        const data = await this.dispatch(req).finally(() => this.refreshToken());
        // Re-read state after the token refresh so hasSession is current.
        return { ok: true, data: data && typeof data === 'object' && 'phase' in data ? { ...data, hasSession: this.popupState().hasSession } : data };
      }
      const data = await this.dispatch(req);
      return { ok: true, data };
    } catch (e) {
      const { code, message } = this.toError(e);
      return this.fail(code, message, type);
    }
  }

  private fail(code: ErrorCode, message: string, context: string): Result<never> {
    this.log('request rejected', `${context}:${code}`);
    return { ok: false, error: { code, message } };
  }

  private toError(e: unknown): { code: ErrorCode; message: string } {
    if (e instanceof ControllerError) return { code: e.code, message: e.message };
    const err = e as { name?: string; message?: string; status?: number; code?: string; isNetwork?: boolean };
    const msg = typeof err?.message === 'string' ? err.message.slice(0, 300) : 'Unexpected error';
    switch (err?.name) {
      case 'VaultLockedError':
        return { code: 'locked', message: 'PassVault is locked.' };
      case 'WrongPasswordError':
        return { code: 'wrong_password', message: 'The master password is incorrect.' };
      case 'PermissionError':
        return { code: 'forbidden', message: msg };
      case 'ZodError':
        return { code: 'invalid_message', message: 'The item is not valid.' };
      case 'InvalidServerUrlError':
        return { code: 'invalid_message', message: msg };
      case 'ApiError':
        if (err.isNetwork) return { code: 'network', message: msg };
        if (err.status === 409) return { code: 'conflict', message: msg };
        return { code: 'refused', message: msg };
    }
    return { code: 'internal', message: msg };
  }

  private async dispatch(req: Request): Promise<unknown> {
    const s = this.session;
    switch (req.type) {
      case 'ping':
        return { ok: true, version: this.c.runtime.getManifest().version } satisfies ResponseMap['ping'];
      case 'state.get':
        return this.popupState();
      case 'auth.login':
        await s.login(req.email, req.password);
        await this.syncResumeKey();
        return this.popupState();
      case 'auth.mfaVerify': {
        const r = await s.verifyMfa({
          ...(req.code ? { code: req.code } : {}),
          ...(req.recoveryCode ? { recoveryCode: req.recoveryCode } : {}),
          trustDevice: req.trustDevice,
        });
        await this.syncResumeKey();
        return { ...this.popupState(), remainingRecoveryCodes: r.remainingRecoveryCodes };
      }
      case 'auth.mfaEnrollStart':
        await s.startMfaEnrollment();
        return this.popupState();
      case 'auth.mfaEnrollConfirm':
        await s.confirmMfaEnrollment(req.code);
        await this.syncResumeKey();
        return this.popupState();
      case 'auth.ackRecoveryCodes':
        s.acknowledgeRecoveryCodes();
        return this.popupState();
      case 'auth.cancel':
        s.cancelLogin();
        return this.popupState();
      case 'auth.unlock':
        await s.unlock(req.password);
        await this.syncResumeKey();
        return this.popupState();
      case 'auth.lock':
        await this.lock('user');
        return this.popupState();
      case 'auth.unlockBiometric':
        await s.unlockWithBiometrics();
        await this.syncResumeKey();
        return this.popupState();
      case 'touchid.status':
        return this.touchIdStatus();
      case 'touchid.set':
        if (req.enabled) await s.enableBiometrics();
        else await s.disableBiometrics();
        return this.touchIdStatus();
      case 'auth.logout':
        await this.c.storage.session.remove(RESUME_KEY);
        this.resumeStored = false;
        await this.runLocking(() => s.logout());
        return this.popupState();
      case 'vault.sync':
        if (s.isUnlocked) await s.syncNow().catch(() => undefined);
        return this.popupState();
      case 'vault.list': {
        // The browser only deals with website logins; SSH keys, .env files and the rest stay in the apps.
        const all = filterItems(s.getSnapshot().items, { query: req.query ?? '', status: 'active', types: ['login'] });
        const limit = req.limit ?? 200;
        return { items: all.slice(0, limit).map(summarize), total: all.length } satisfies ResponseMap['vault.list'];
      }
      case 'vault.matches':
        return this.matches(req.tabId);
      case 'vault.meta': {
        const snap = s.getSnapshot();
        const active = snap.items.filter((i) => !i.payload.trashedAt);
        return {
          folders: [...new Set(active.map((i) => i.payload.folder).filter(Boolean))].sort(),
          tags: [...new Set(active.flatMap((i) => i.payload.tags))].sort(),
          projects: snap.projects.filter((p) => !p.payload.trashedAt && p.role !== 'viewer').map((p) => ({ id: p.id, name: p.payload.name })),
        } satisfies ResponseMap['vault.meta'];
      }
      case 'item.get':
        return itemDetail(this.item(req.id));
      case 'item.secret': {
        const it = this.item(req.id);
        if (it.payload.type !== 'login') throw new ControllerError('refused', 'Quick copy is only available for logins.');
        return { value: req.field === 'username' ? it.payload.fields.username : it.payload.fields.password } satisfies ResponseMap['item.secret'];
      }
      case 'cards.list': {
        const cards = filterItems(s.getSnapshot().items, { status: 'active', types: ['payment_card'] }).map((it) => {
          const p = it.payload as ItemPayload<'payment_card'>;
          const end = cardExpiresAt(p.fields);
          return { ...summarize(it), brand: cardBrand(p.fields.number), last4: cardLast4(p.fields.number), expiry: cardExpiryLabel(p.fields), expired: !!end && end.getTime() < Date.now() };
        });
        return { cards } satisfies ResponseMap['cards.list'];
      }
      case 'card.secret': {
        const it = this.item(req.id);
        if (it.payload.type !== 'payment_card') throw new ControllerError('refused', 'Not a payment card.');
        const f = it.payload.fields;
        const value = req.field === 'expiry' ? cardExpiryLabel(f) : f[req.field];
        return { value } satisfies ResponseMap['card.secret'];
      }
      case 'card.fill':
        return this.fillCard(req.tabId, req.itemId);
      case 'autofill.fill':
        return this.fill(req.tabId, req.itemId, req.confirmInsecure);
      case 'autofill.capture':
        return this.capture(req.tabId);
      case 'item.saveLogin': {
        const d = req.draft;
        const u = normalizeLoginUrl(d.url);
        if (!u) throw new ControllerError('invalid_message', 'Enter an http(s) website address.');
        const payload = newItem('login', {
          title: d.title.trim(),
          notes: d.notes,
          folder: d.folder.trim(),
          tags: [...new Set(d.tags.map((t) => t.trim()).filter(Boolean))],
          projectId: d.projectId,
          fields: {
            username: d.username,
            password: d.password,
            urls: [{ url: d.match === 'host' || d.match === 'base_domain' ? u.origin : u.href, match: d.match }],
            passwordUpdatedAt: new Date().toISOString(),
          },
        });
        const id = await s.saveItem(payload);
        return { id } satisfies ResponseMap['item.saveLogin'];
      }
      case 'item.updatePassword': {
        const it = this.item(req.id);
        if (it.payload.type !== 'login') throw new ControllerError('refused', 'Only logins can be updated from a page.');
        if (it.role === 'viewer') throw new ControllerError('forbidden', 'You have view-only access to this item.');
        await s.updateItem(req.id, (p) => {
          if (p.type === 'login') {
            p.fields.password = req.password;
            p.fields.passwordUpdatedAt = new Date().toISOString();
          }
        });
        return { id: req.id } satisfies ResponseMap['item.updatePassword'];
      }
      case 'generator.generate': {
        if (req.kind === 'password') {
          const o = {
            length: req.length ?? 20,
            symbols: req.symbols ?? true,
            digits: req.digits ?? true,
            avoidAmbiguous: req.avoidAmbiguous ?? false,
          };
          return { value: generatePassword(o), entropyBits: passwordEntropyBits(o) } satisfies ResponseMap['generator.generate'];
        }
        const o = {
          words: req.words ?? 6,
          separator: req.separator ?? '-',
          capitalize: req.capitalize ?? false,
          includeNumber: req.includeNumber ?? false,
        };
        return { value: generatePassphrase(o), entropyBits: passphraseEntropyBits(o) } satisfies ResponseMap['generator.generate'];
      }
      case 'clipboard.scheduleClear':
        return this.scheduleClipboardClear();
      case 'autosave.status':
        return this.autosave().status();
      case 'autosave.set':
        return this.autosave().setEnabled(req.enabled);
      case 'autosave.clearNever':
        return this.autosave().clearNeverList();
      case 'inline.set':
        return this.autosave().setInline(req.enabled);
      case 'server.check':
        return (await this.servers().check(req.url)) satisfies ResponseMap['server.check'];
      case 'server.set':
        return { url: await this.servers().connect(req.url) } satisfies ResponseMap['server.set'];
      case 'server.switch':
        return { url: await this.servers().switchTo(req.id) } satisfies ResponseMap['server.switch'];
      case 'server.rename':
        await this.servers().rename(req.id, req.name);
        return { ok: true } satisfies ResponseMap['server.rename'];
      case 'server.remove':
        await this.servers().remove(req.id);
        return { ok: true } satisfies ResponseMap['server.remove'];
      case 'server.localDev':
        return { localDev: await this.servers().setLocalDev(req.on) } satisfies ResponseMap['server.localDev'];
    }
  }

  private servers(): ServerControl {
    if (!this.deps.server) throw new ControllerError('bad_state', 'Changing servers is not available.');
    return this.deps.server;
  }

  private autosave() {
    if (!this.deps.savePrompt) throw new ControllerError('bad_state', 'Offer-to-save is not available.');
    return this.deps.savePrompt;
  }

  private async refreshToken() {
    const prev = this.hasToken;
    const key = this.deps.tokenKey ?? TOKEN_KEY;
    this.hasToken = !!(await this.c.storage.local.get(key))[key];
    if (prev !== this.hasToken) this.onSnapshot(this.session.getSnapshot());
  }

  private item(id: string): DecryptedItem {
    const it = this.session.getSnapshot().items.find((i) => i.id === id);
    if (!it) throw new ControllerError('not_found', 'Item not found.');
    return it;
  }

  private async tabUrl(tabId: number): Promise<string | undefined> {
    try {
      return (await this.c.tabs.get(tabId)).url;
    } catch {
      return undefined;
    }
  }

  private tabInfo(url: string | undefined): TabInfo {
    if (!url) return { origin: null, host: null, eligible: false, insecure: false, reason: 'PassVault can only see the page you opened the popup on.' };
    const origin = pageOrigin(url);
    if (!origin) return { origin: null, host: null, eligible: false, insecure: false, reason: 'This page cannot be filled (not an http(s) website).' };
    const u = new URL(url);
    return { origin, host: u.host, eligible: true, insecure: u.protocol === 'http:' };
  }

  /** Logins saved for the tab's current URL (popup list and inline suggestions). */
  async matches(tabId: number): Promise<MatchesResponse> {
    const url = await this.tabUrl(tabId);
    const tab = this.tabInfo(url);
    const out: LoginMatch[] = [];
    if (url && tab.eligible) {
      for (const it of this.session.getSnapshot().items) {
        const p = it.payload;
        if (p.type !== 'login' || p.trashedAt) continue;
        const m = matchLogin(p.fields.urls, url);
        if (!m) continue;
        out.push({ ...summarize(it), username: p.fields.username, hasPassword: !!p.fields.password, insecure: m.insecure, mode: m.mode });
      }
    }
    out.sort((a, b) => Number(a.insecure) - Number(b.insecure) || Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title));
    return { tab, matches: out };
  }

  /** The one fill path (popup and inline suggestions): policy check on a fresh tab URL, then top-frame injection. */
  async fill(tabId: number, itemId: string, confirmInsecure: boolean): Promise<FillResponse> {
    const item = this.session.getSnapshot().items.find((i) => i.id === itemId);
    // Re-read the tab URL right before filling; never trust an earlier lookup.
    const url = await this.tabUrl(tabId);
    const d = evaluateFill(item, url, confirmInsecure);
    if (!d.ok) {
      this.log('fill refused', d.response.status === 'refused' ? d.response.reason : d.response.status);
      return d.response;
    }
    let results;
    try {
      results = await this.c.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: pvFillCredentials,
        args: [d.origin, d.username, d.password],
      });
    } catch {
      return { status: 'refused', reason: 'injection_failed', message: 'PassVault could not access this page.' };
    }
    const top = results.find((r) => r.frameId === 0);
    const parsed = fillResultSchema.safeParse(top?.result);
    if (!parsed.success) return { status: 'refused', reason: 'injection_failed', message: 'PassVault could not access this page.' };
    const r: PageFillResult = parsed.data;
    switch (r.code) {
      case 'filled':
        this.log('filled');
        return { status: 'filled', filledUsername: r.filledUsername };
      case 'origin_mismatch':
      case 'not_top_frame':
        return { status: 'refused', reason: 'origin_changed', message: 'The page changed before filling. Nothing was filled.' };
      case 'no_password_field':
        return { status: 'refused', reason: 'no_password_field', message: 'No visible password field on this page. Use copy instead.' };
    }
  }

  /**
   * Fill a payment card into the active tab's checkout form, after a click in the popup.
   * HTTPS only (or a local development host), top frame only, origin re-checked in the page.
   */
  private async fillCard(tabId: number, itemId: string): Promise<CardFillResponse> {
    const it = this.session.getSnapshot().items.find((i) => i.id === itemId);
    if (!it || it.payload.type !== 'payment_card' || it.payload.trashedAt) return { status: 'refused', message: 'That card is not in your vault.' };
    const url = await this.tabUrl(tabId);
    const info = this.tabInfo(url);
    if (!url || !info.origin || !info.eligible) return { status: 'refused', message: info.reason ?? 'PassVault cannot fill this page.' };
    if (info.insecure) return { status: 'refused', message: 'Card details are only filled into secure (https) pages.' };
    const f = it.payload.fields;
    let results;
    try {
      results = await this.c.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: pvFillCard,
        args: [info.origin, { name: f.cardholder, number: f.number, expMonth: f.expMonth, expYear: f.expYear, cvv: f.cvv }],
      });
    } catch {
      return { status: 'refused', message: 'PassVault could not access this page.' };
    }
    const r = cardFillResultSchema.safeParse(results.find((x) => x.frameId === 0)?.result);
    if (!r.success) return { status: 'refused', message: 'PassVault could not fill this page.' };
    if (r.data.code === 'origin_mismatch') return { status: 'refused', message: 'The page changed while filling. Try again.' };
    if (r.data.code !== 'filled')
      return { status: 'refused', message: 'No card form found on this page. If the payment form is embedded from another site, use the copy buttons.' };
    this.log('card filled');
    return { status: 'filled', filled: r.data.filled };
  }

  private async capture(tabId: number): Promise<CaptureResponse> {
    const url = await this.tabUrl(tabId);
    const info = this.tabInfo(url);
    if (!url || !info.origin) throw new ControllerError('refused', info.reason ?? 'This page cannot be saved.');
    let results;
    try {
      results = await this.c.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: pvCaptureCredentials });
    } catch {
      throw new ControllerError('refused', 'PassVault could not access this page.');
    }
    const parsed = captureResultSchema.safeParse(results.find((r) => r.frameId === 0)?.result);
    if (!parsed.success || parsed.data.code !== 'ok') throw new ControllerError('refused', 'PassVault could not read this page.');
    const r = parsed.data;
    if (r.origin !== info.origin) throw new ControllerError('refused', 'The page changed while reading it. Try again.');
    const host = info.host!;
    const uname = r.username.trim().toLowerCase();
    const existing: CaptureResponse['existing'] = [];
    for (const it of this.session.getSnapshot().items) {
      const p = it.payload;
      if (p.type !== 'login' || p.trashedAt) continue;
      if (!matchLogin(p.fields.urls, r.url)) continue;
      if (p.fields.username.trim().toLowerCase() !== uname) continue;
      existing.push({ id: it.id, title: p.title, username: p.fields.username, passwordDiffers: p.fields.password !== r.password, readOnly: it.role === 'viewer' });
    }
    return {
      origin: r.origin,
      url: r.url,
      host,
      insecure: info.insecure,
      suggestedTitle: host.replace(/^www\./, '').replace(/:\d+$/, ''),
      username: r.username,
      password: r.password,
      foundPasswordField: r.foundPasswordField,
      existing,
    };
  }
}
