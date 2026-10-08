import {
  createRegistrationMaterial,
  decryptRecord,
  decryptSettings,
  deriveLogin,
  encryptRecord,
  encryptSettings,
  generateVaultKey,
  grantVaultKey,
  initCrypto,
  openVaultGrant,
  publicKeyFingerprint,
  rewrapForNewPassword,
  rewrapRecordKey,
  rotateUserKey,
  unlockWithPassword,
  unlockWithWrapKey,
  unwrapUserKeyWithDeviceKey,
  verifyPublicKeySignature,
  wipe,
  wipeUnlocked,
  wrapUserKeyForDevice,
  wrapVaultKeyForSelf,
  openAccountKeys,
  WrongPasswordError,
  type UnlockedAccountKeys,
  type KdfParams,
} from '@passvault/crypto';
import { ApiClient, ApiError } from '@passvault/api-client';
import { SyncEngine, type CacheStore, type OutboxEntry, type SyncStatus } from '@passvault/sync';
import {
  DEFAULT_USER_SETTINGS,
  isProductionEnvironment,
  type AccountBundle,
  type InvitationDto,
  type ItemPayload,
  type LoginResponse,
  type ProjectPayload,
  type RecordDto,
  type SessionDto,
  type UserSettingsPayload,
  type VaultMembershipDto,
  type VaultRole,
  type DeviceListItem,
  type SessionListItem,
  type VaultMemberDto,
  type AuditEventDto,
} from '@passvault/types';
import { itemPayloadSchema, projectPayloadSchema, userSettingsSchema } from '@passvault/validation';
import type { Platform } from './platform';
import { duplicatePayload } from './items';

// ---------------------------------------------------------------------------
// Public state

export type AuthPhase =
  | { phase: 'initializing' }
  | { phase: 'signed_out' }
  | { phase: 'mfa_verify'; email: string; mfaToken: string }
  | { phase: 'mfa_enroll'; email: string; mfaToken: string; secret?: string; otpauthUri?: string }
  | { phase: 'recovery_codes'; codes: string[] }
  | { phase: 'locked'; email: string; name: string; biometricAvailable: boolean; hasSession: boolean }
  | { phase: 'unlocked' };

export interface DecryptedRecordBase {
  id: string;
  vaultId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  /** local edit not yet confirmed by the server */
  pending: boolean;
  /** outbox entry in conflict state for this record */
  conflict: OutboxEntry | null;
  failed: OutboxEntry | null;
  shared: boolean;
  sharedByMe: boolean;
  role: VaultRole;
}

export interface DecryptedItem extends DecryptedRecordBase {
  kind: 'item';
  payload: ItemPayload;
  favorite: boolean;
}

export interface DecryptedProject extends DecryptedRecordBase {
  kind: 'project';
  payload: ProjectPayload;
}

export interface UndecryptableRecord {
  id: string;
  vaultId: string;
  reason: string;
}

export interface VaultInfo {
  vaultId: string;
  type: 'personal' | 'shared';
  kind: 'item' | 'project' | null;
  role: VaultRole;
  keyVersion: number;
  allowResharing: boolean;
  rotationRequired: boolean;
  expiresAt: string | null;
  memberCount: number;
  grantedBy: VaultMembershipDto['grantedBy'];
  /** null when the vault key could be opened */
  error: string | null;
}

export interface SessionSnapshot {
  auth: AuthPhase;
  user: AccountBundle['user'] | null;
  items: DecryptedItem[];
  projects: DecryptedProject[];
  vaults: VaultInfo[];
  undecryptable: UndecryptableRecord[];
  settings: UserSettingsPayload;
  sync: SyncStatus;
  online: boolean;
  /** monotonically increasing; lets UIs memoize */
  version: number;
}

export interface RecipientInfo {
  userId: string;
  email: string;
  name: string;
  fingerprint: string;
  publicEncryptionKey: string;
  publicSigningKey: string;
  pinned: 'new' | 'match' | 'changed';
  verified: boolean;
}

export class VaultLockedError extends Error {
  override name = 'VaultLockedError';
  constructor() {
    super('The vault is locked');
  }
}

export class PermissionError extends Error {
  override name = 'PermissionError';
}

const PREF_DEVICE_ID = 'deviceId';
const PREF_LAST_EMAIL = 'lastEmail';
const PREF_TRUSTED_DEVICE = 'trustedDeviceToken';
const META_BIOMETRIC = 'biometricWrappedUserKey';

function uuid() {
  return crypto.randomUUID();
}
function nowIso() {
  return new Date().toISOString();
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------

/**
 * VaultSession owns the client side of an account: authentication, the
 * unlocked key material, decrypted state, the encrypted cache, and sync.
 *
 * Key material and decrypted payloads live only in this object's private
 * fields while unlocked. `lock()` wipes key buffers (best effort, see
 * docs/CRYPTO.md) and drops every reference to decrypted data.
 */
export class VaultSession {
  readonly api: ApiClient;
  private token: string | null = null;
  private account: AccountBundle | null = null;
  private keys: UnlockedAccountKeys | null = null;
  private vaultKeys = new Map<string, { key: Uint8Array; keyVersion: number }>();
  private vaultErrors = new Map<string, string>();
  private itemKeys = new Map<string, Uint8Array>();
  private decryptCache = new Map<string, { payload: unknown; itemKey: Uint8Array }>();
  private settings: UserSettingsPayload = structuredClone(DEFAULT_USER_SETTINGS);
  private settingsRevision = 0;
  private store: CacheStore | null = null;
  private engine: SyncEngine | null = null;
  private pendingWrapKey: Uint8Array | null = null;
  private pendingLogin: { email: string; authKey: string; kdf: KdfParams } | null = null;
  private listeners = new Set<(s: SessionSnapshot) => void>();
  private lockListeners = new Set<() => void>();
  private snapshot: SessionSnapshot;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity = Date.now();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private unsubSync: (() => void) | null = null;
  private deviceId = '';
  private online = true;

  constructor(private readonly platform: Platform) {
    this.api = new ApiClient({
      baseUrl: platform.apiBaseUrl,
      getToken: () => this.token,
      onUnauthenticated: () => void this.handleSessionInvalid(),
      ...(platform.fetchImpl ? { fetchImpl: platform.fetchImpl } : {}),
    });
    this.snapshot = {
      auth: { phase: 'initializing' },
      user: null,
      items: [],
      projects: [],
      vaults: [],
      undecryptable: [],
      settings: structuredClone(DEFAULT_USER_SETTINGS),
      sync: { state: 'idle', lastSyncAt: null, lastError: null, pending: 0, failed: 0, conflicts: 0, pendingInvitations: 0 },
      online: true,
      version: 0,
    };
  }

  // ---------------- subscriptions ----------------

  subscribe(fn: (s: SessionSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  /** Called synchronously whenever the vault locks (platforms close terminals, agents, etc). */
  onLock(fn: () => void): () => void {
    this.lockListeners.add(fn);
    return () => this.lockListeners.delete(fn);
  }

  getSnapshot(): SessionSnapshot {
    return this.snapshot;
  }

  private emit(patch: Partial<SessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch, version: this.snapshot.version + 1 };
    for (const l of this.listeners) l(this.snapshot);
  }

  get isUnlocked() {
    return this.keys !== null;
  }

  get userId(): string | null {
    return this.account?.user.id ?? null;
  }

  get personalVaultId(): string | null {
    return this.account?.personalVaultId ?? null;
  }

  setOnline(online: boolean) {
    this.online = online;
    this.emit({ online });
    if (online && this.isUnlocked) void this.syncNow().catch(() => undefined);
  }

  // ---------------- lifecycle ----------------

  async init(): Promise<void> {
    await initCrypto();
    this.deviceId = (await this.platform.prefs.get(PREF_DEVICE_ID)) ?? '';
    if (!this.deviceId) {
      this.deviceId = uuid();
      await this.platform.prefs.set(PREF_DEVICE_ID, this.deviceId);
    }
    this.token = await this.platform.tokens.get();
    const lastEmail = await this.platform.prefs.get(PREF_LAST_EMAIL);
    if (lastEmail) {
      const store = this.platform.createCacheStore(lastEmail);
      const cached = await store.getAccount();
      if (cached) {
        this.store = store;
        this.account = cached.account;
        await this.toLocked();
        return;
      }
    }
    this.emit({ auth: { phase: 'signed_out' } });
  }

  private async toLocked() {
    const acc = this.account!;
    let biometricAvailable = false;
    if (this.platform.biometrics && this.store) {
      const wrapped = await this.store.getMeta<string>(META_BIOMETRIC);
      biometricAvailable = !!wrapped && (await this.platform.biometrics.status()).available;
    }
    this.emit({
      auth: { phase: 'locked', email: acc.user.email, name: acc.user.name, biometricAvailable, hasSession: !!this.token },
      user: acc.user,
    });
  }

  get deviceInfo() {
    return { id: this.deviceId, name: this.platform.deviceName, clientType: this.platform.clientType };
  }

  // ---------------- registration ----------------

  /** Step 1 of registration: email a 6-digit code (the account does not exist yet). */
  startRegistration(email: string) {
    return this.api.registerStart({ email: email.trim().toLowerCase() });
  }

  /** Step 2: exchange the emailed code for a single-use registration token. */
  async verifyRegistration(email: string, code: string): Promise<string> {
    return (await this.api.registerVerify({ email: email.trim().toLowerCase(), code: code.trim() })).registrationToken;
  }

  /** Step 3: create the verified account. Returns the one-time vault recovery key that the user must store. */
  async register(registrationToken: string, email: string, name: string, password: string): Promise<{ recoveryKey: string }> {
    await initCrypto();
    if (password.length < 12) throw new Error('Use a master password of at least 12 characters.');
    await tick();
    const m = createRegistrationMaterial(password);
    const personalVaultId = uuid();
    try {
      await this.api.register({
        registrationToken,
        email: email.trim().toLowerCase(),
        name,
        kdf: m.kdf,
        authKey: m.authKey,
        keys: { ...m.keys },
        personalVault: {
          id: personalVaultId,
          encryptedVaultKey: wrapVaultKeyForSelf(m.unlocked.userKey, generateVaultKey(), personalVaultId, 1),
        },
      });
      return { recoveryKey: m.recoveryKey };
    } finally {
      wipeUnlocked(m.unlocked);
    }
  }

  // ---------------- login & MFA ----------------

  async login(email: string, password: string): Promise<AuthPhase> {
    await initCrypto();
    const normalized = email.trim().toLowerCase();
    const { kdf } = await this.api.prelogin({ email: normalized });
    await tick();
    const { authKey, wrapKey } = deriveLogin(password, kdf);
    this.clearPendingLogin();
    this.pendingWrapKey = wrapKey;
    this.pendingLogin = { email: normalized, authKey, kdf };
    const trustedDeviceToken = (await this.platform.prefs.get(`${PREF_TRUSTED_DEVICE}:${normalized}`)) ?? undefined;
    let res: LoginResponse;
    try {
      res = await this.api.login({ email: normalized, authKey, device: this.deviceInfo, ...(trustedDeviceToken ? { trustedDeviceToken } : {}) });
    } catch (e) {
      this.clearPendingLogin();
      throw e;
    }
    return this.handleLoginResponse(normalized, res);
  }

  private async handleLoginResponse(email: string, res: LoginResponse): Promise<AuthPhase> {
    if (res.status === 'ok') {
      await this.finishLogin(res.session, res.account);
      return this.snapshot.auth;
    }
    const auth: AuthPhase =
      res.status === 'mfa_required'
        ? { phase: 'mfa_verify', email, mfaToken: res.mfaToken }
        : { phase: 'mfa_enroll', email, mfaToken: res.mfaToken };
    this.emit({ auth });
    return auth;
  }

  async startMfaEnrollment(): Promise<{ secret: string; otpauthUri: string }> {
    const a = this.snapshot.auth;
    if (a.phase !== 'mfa_enroll') throw new Error('not enrolling');
    const r = await this.api.mfaEnrollStart({ mfaToken: a.mfaToken });
    this.emit({ auth: { ...a, secret: r.secret, otpauthUri: r.otpauthUri } });
    return r;
  }

  async confirmMfaEnrollment(code: string): Promise<string[]> {
    const a = this.snapshot.auth;
    if (a.phase !== 'mfa_enroll') throw new Error('not enrolling');
    const r = await this.api.mfaEnrollConfirm({ mfaToken: a.mfaToken, code });
    if (!r.session || !r.account) throw new Error('server did not return a session');
    await this.finishLogin(r.session, r.account, { showRecoveryCodes: r.recoveryCodes });
    return r.recoveryCodes;
  }

  /** After the user saved their MFA recovery codes. */
  acknowledgeRecoveryCodes() {
    if (this.snapshot.auth.phase === 'recovery_codes') this.emit({ auth: { phase: 'unlocked' } });
  }

  async verifyMfa(input: { code?: string; recoveryCode?: string; trustDevice?: boolean }): Promise<{ remainingRecoveryCodes?: number }> {
    const a = this.snapshot.auth;
    if (a.phase !== 'mfa_verify') throw new Error('not verifying');
    const r = await this.api.mfaVerify({ mfaToken: a.mfaToken, ...input });
    if (r.trustedDeviceToken) await this.platform.prefs.set(`${PREF_TRUSTED_DEVICE}:${a.email}`, r.trustedDeviceToken);
    await this.finishLogin(r.session, r.account);
    return { remainingRecoveryCodes: r.remainingRecoveryCodes };
  }

  cancelLogin() {
    this.clearPendingLogin();
    if (this.account && this.store) void this.toLocked();
    else this.emit({ auth: { phase: 'signed_out' } });
  }

  private clearPendingLogin() {
    if (this.pendingWrapKey) wipe(this.pendingWrapKey);
    this.pendingWrapKey = null;
    this.pendingLogin = null;
  }

  private async finishLogin(session: SessionDto, account: AccountBundle, opts: { showRecoveryCodes?: string[] } = {}) {
    if (!this.pendingWrapKey) throw new Error('login state lost; please sign in again');
    this.token = session.token;
    await this.platform.tokens.set(session.token);
    await this.platform.prefs.set(PREF_LAST_EMAIL, account.user.email);
    this.account = account;
    // Switching accounts on this device must never mix caches.
    this.store = this.platform.createCacheStore(account.user.email);
    const cached = await this.store.getAccount();
    if (cached && cached.account.user.id !== account.user.id) await this.store.clear();
    await this.store.putAccount({ account, cachedAt: nowIso() });
    const wrapKey = this.pendingWrapKey;
    this.pendingWrapKey = null;
    this.pendingLogin = null;
    this.keys = unlockWithWrapKey(wrapKey, account.keys);
    await this.afterUnlock();
    if (opts.showRecoveryCodes) this.emit({ auth: { phase: 'recovery_codes', codes: opts.showRecoveryCodes } });
  }

  // ---------------- unlock / lock ----------------

  /** Unlock locally with the master password (works offline from the encrypted cache). */
  async unlock(password: string): Promise<void> {
    await initCrypto();
    if (!this.account || !this.store) throw new Error('No account on this device');
    await tick();
    try {
      this.keys = unlockWithPassword(password, this.account.kdf, this.account.keys);
    } catch (e) {
      // The password may have been changed on another device; refresh the wrapped key if online.
      if (e instanceof WrongPasswordError && this.token) {
        try {
          const fresh = await this.api.account();
          if (fresh.kdf.salt !== this.account.kdf.salt || fresh.keys.encryptedUserKey !== this.account.keys.encryptedUserKey) {
            this.keys = unlockWithPassword(password, fresh.kdf, fresh.keys);
            this.account = fresh;
            await this.store.putAccount({ account: fresh, cachedAt: nowIso() });
          } else throw e;
        } catch (inner) {
          if (inner instanceof ApiError && inner.status === 401) throw e;
          throw inner instanceof WrongPasswordError || !(inner instanceof ApiError) ? inner : e;
        }
      } else throw e;
    }
    await this.afterUnlock();
  }

  async unlockWithBiometrics(): Promise<void> {
    if (!this.platform.biometrics || !this.account || !this.store) throw new Error('Biometric unlock is not available');
    const wrapped = await this.store.getMeta<string>(META_BIOMETRIC);
    if (!wrapped) throw new Error('Biometric unlock is not set up on this device');
    const deviceKey = await this.platform.biometrics.retrieveKey(this.account.user.id, 'Unlock PassVault');
    try {
      const userKey = unwrapUserKeyWithDeviceKey(deviceKey, this.deviceId, wrapped);
      this.keys = openAccountKeys(userKey, this.account.keys);
    } finally {
      wipe(deviceKey);
    }
    await this.afterUnlock();
  }

  /** Enable biometric unlock: stores a random device key in the OS keychain behind biometric access control. */
  async enableBiometrics(): Promise<void> {
    const keys = this.requireKeys();
    if (!this.platform.biometrics || !this.store || !this.account) throw new Error('Biometric unlock is not available');
    const st = await this.platform.biometrics.status();
    if (!st.available) throw new Error(st.reason ?? 'Biometric unlock is not available');
    const { deviceKey, encryptedUserKeyByDevice } = wrapUserKeyForDevice(keys.userKey, this.deviceId);
    try {
      await this.platform.biometrics.storeKey(this.account.user.id, deviceKey);
    } finally {
      wipe(deviceKey);
    }
    await this.store.setMeta(META_BIOMETRIC, encryptedUserKeyByDevice);
  }

  async disableBiometrics(): Promise<void> {
    if (this.platform.biometrics && this.account) await this.platform.biometrics.removeKey(this.account.user.id);
    await this.store?.setMeta(META_BIOMETRIC, null);
  }

  async biometricsEnabled(): Promise<boolean> {
    return !!(await this.store?.getMeta<string>(META_BIOMETRIC));
  }

  /**
   * Browser extension only: a copy of the User Key so an MV3 service worker
   * can resume an unlocked session after suspension. The caller must keep it
   * in `chrome.storage.session` (memory-only, trusted contexts) and delete it
   * on lock. See docs/EXTENSION.md.
   */
  exportUserKeyForResume(): Uint8Array {
    return this.requireKeys().userKey.slice();
  }

  async resumeWithUserKey(userKey: Uint8Array): Promise<void> {
    if (!this.account || !this.store) throw new Error('No account on this device');
    this.keys = openAccountKeys(userKey.slice(), this.account.keys);
    await this.afterUnlock();
  }

  private async afterUnlock() {
    const keys = this.requireKeys();
    const acc = this.account!;
    if (acc.settings.encryptedSettings) {
      try {
        const parsed = userSettingsSchema.safeParse(decryptSettings(keys.userKey, acc.settings.encryptedSettings));
        this.settings = parsed.success ? parsed.data : structuredClone(DEFAULT_USER_SETTINGS);
      } catch {
        this.settings = structuredClone(DEFAULT_USER_SETTINGS);
      }
    } else this.settings = structuredClone(DEFAULT_USER_SETTINGS);
    this.settingsRevision = acc.settings.revision;
    this.engine = new SyncEngine(this.api, this.store!);
    this.unsubSync = this.engine.onStatus((s) => this.emit({ sync: s }));
    await this.engine.loadStatus();
    this.emit({ auth: { phase: 'unlocked' }, user: acc.user, settings: this.settings });
    await this.rebuild();
    this.touch();
    this.syncTimer = setInterval(() => {
      if (this.online && this.token) void this.syncNow().catch(() => undefined);
    }, 60_000);
    if (this.token) void this.syncNow().catch(() => undefined);
  }

  /**
   * Lock: stop timers, notify platform hooks (terminal/agent shutdown),
   * wipe key buffers, and drop all decrypted state.
   */
  lock(): void {
    if (!this.keys) return;
    for (const l of this.lockListeners) {
      try {
        l();
      } catch {
        /* platform hooks must not prevent locking */
      }
    }
    this.wipeUnlockedState();
    void this.toLocked();
  }

  /**
   * Ends this session for good (the client switched servers): locks the vault,
   * drops a half-finished sign-in and cancels every in-flight request, so
   * nothing started for this server completes afterwards. Not reusable.
   */
  dispose(): void {
    this.lock();
    this.clearPendingLogin();
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.api.abortAll();
  }

  private wipeUnlockedState() {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.lockTimer = null;
    this.syncTimer = null;
    this.unsubSync?.();
    this.unsubSync = null;
    this.engine = null;
    wipeUnlocked(this.keys);
    this.keys = null;
    for (const v of this.vaultKeys.values()) wipe(v.key);
    this.vaultKeys.clear();
    this.vaultErrors.clear();
    for (const k of this.itemKeys.values()) wipe(k);
    this.itemKeys.clear();
    for (const d of this.decryptCache.values()) wipe(d.itemKey);
    this.decryptCache.clear();
    this.settings = structuredClone(DEFAULT_USER_SETTINGS);
    this.clearPendingLogin();
    this.emit({ items: [], projects: [], vaults: [], undecryptable: [], settings: structuredClone(DEFAULT_USER_SETTINGS) });
  }

  /** Sign out: revoke the server session, clear tokens and the local encrypted cache. */
  async logout(opts: { keepCache?: boolean } = {}): Promise<void> {
    const wasToken = this.token;
    if (this.keys) for (const l of this.lockListeners) l();
    this.wipeUnlockedState();
    if (wasToken) await this.api.logout().catch(() => undefined);
    this.token = null;
    await this.platform.tokens.clear();
    if (!opts.keepCache) {
      await this.store?.clear();
      await this.platform.prefs.remove(PREF_LAST_EMAIL);
    }
    this.store = null;
    this.account = null;
    this.emit({ auth: { phase: 'signed_out' }, user: null });
  }

  private async handleSessionInvalid() {
    // Session revoked/expired on the server: keep the encrypted cache, require a new login.
    this.token = null;
    await this.platform.tokens.clear();
    if (this.keys) {
      this.lock();
    }
  }

  /** Record user activity for the inactivity lock. */
  touch() {
    this.lastActivity = Date.now();
    if (!this.keys) return;
    if (this.lockTimer) clearTimeout(this.lockTimer);
    const minutes = this.settings.lockTimeoutMinutes;
    if (minutes > 0) {
      this.lockTimer = setTimeout(() => {
        if (Date.now() - this.lastActivity >= minutes * 60_000 - 50) this.lock();
      }, minutes * 60_000);
    }
  }

  private requireKeys(): UnlockedAccountKeys {
    if (!this.keys) throw new VaultLockedError();
    return this.keys;
  }

  // ---------------- sync & decryption ----------------

  async syncNow(): Promise<void> {
    if (!this.engine) return;
    if (!this.token) return; // offline-only unlocked session: read cached data
    try {
      await this.engine.sync();
    } finally {
      if (this.keys) await this.rebuild();
    }
    // refresh account bundle (password changes elsewhere, settings)
    try {
      const acc = await this.api.account();
      if (this.store && this.keys) {
        await this.store.putAccount({ account: acc, cachedAt: nowIso() });
        this.account = acc;
        if (acc.settings.revision !== this.settingsRevision && acc.settings.encryptedSettings) {
          const parsed = userSettingsSchema.safeParse(decryptSettings(this.keys.userKey, acc.settings.encryptedSettings));
          if (parsed.success) {
            this.settings = parsed.data;
            this.settingsRevision = acc.settings.revision;
            this.emit({ settings: this.settings });
          }
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  private vaultInfo(v: VaultMembershipDto): VaultInfo {
    return {
      vaultId: v.vaultId,
      type: v.type,
      kind: v.kind,
      role: v.role,
      keyVersion: v.keyVersion,
      allowResharing: v.allowResharing,
      rotationRequired: v.rotationRequired,
      expiresAt: v.expiresAt,
      memberCount: v.memberCount,
      grantedBy: v.grantedBy,
      error: this.vaultErrors.get(v.vaultId) ?? null,
    };
  }

  private async openVaultKeys(vaults: VaultMembershipDto[]) {
    const keys = this.requireKeys();
    const me = this.account!.user.id;
    let settingsChanged = false;
    for (const v of vaults) {
      const existing = this.vaultKeys.get(v.vaultId);
      if (existing && existing.keyVersion === v.keyVersion) continue;
      try {
        let grantorKey: string | null = null;
        if (v.type === 'shared') {
          const g = v.grantedBy;
          if (!g) throw new Error('missing grantor');
          if (g.userId === me) {
            if (g.publicSigningKey !== this.account!.keys.publicSigningKey) throw new Error('grant claims to be from you but uses a different key');
          } else {
            const pinned = this.settings.contacts[g.userId];
            if (pinned && pinned.publicSigningKey !== g.publicSigningKey) {
              throw new Error(`${g.email}'s key changed since you last shared with them. Verify their fingerprint before trusting this vault.`);
            }
            if (!pinned) {
              this.settings.contacts[g.userId] = { email: g.email, fingerprint: '', publicSigningKey: g.publicSigningKey, verified: false, pinnedAt: nowIso() };
              settingsChanged = true;
            }
          }
          grantorKey = g.publicSigningKey;
        }
        const key = openVaultGrant({
          encryptedVaultKey: v.encryptedVaultKey,
          keySignature: v.keySignature,
          vaultId: v.vaultId,
          keyVersion: v.keyVersion,
          myUserId: me,
          me: keys,
          grantorPublicSigningKey: grantorKey,
        });
        if (existing) wipe(existing.key);
        this.vaultKeys.set(v.vaultId, { key, keyVersion: v.keyVersion });
        this.vaultErrors.delete(v.vaultId);
      } catch (e) {
        this.vaultErrors.set(v.vaultId, e instanceof Error ? e.message : 'could not open vault key');
      }
    }
    if (settingsChanged) await this.saveSettings(this.settings).catch(() => undefined);
  }

  private decryptOne(id: string, vaultId: string, encryptedKey: string, encryptedPayload: string): { payload: unknown; itemKey: Uint8Array } {
    const ck = `${id}|${vaultId}|${encryptedKey}|${encryptedPayload.length}|${encryptedPayload.slice(-24)}`;
    const hit = this.decryptCache.get(ck);
    if (hit) return hit;
    const vk = this.vaultKeys.get(vaultId);
    if (!vk) throw new Error(this.vaultErrors.get(vaultId) ?? 'no access to this vault key');
    const r = decryptRecord({ recordId: id, vaultId, vaultKey: vk.key, encryptedKey, encryptedPayload });
    this.decryptCache.set(ck, r);
    return r;
  }

  /** Rebuild decrypted state from the encrypted cache + outbox overlay. */
  async rebuild(): Promise<void> {
    if (!this.keys || !this.store) return;
    const [records, outbox, vaults] = await Promise.all([this.store.allRecords(), this.store.outbox(), this.store.getVaults()]);
    if (!this.keys) return;
    await this.openVaultKeys(vaults);
    const vaultById = new Map(vaults.map((v) => [v.vaultId, v]));
    type View = { server: RecordDto | null; local: OutboxEntry | null; conflict: OutboxEntry | null; failed: OutboxEntry | null; pendingDelete: boolean };
    const views = new Map<string, View>();
    for (const r of records) views.set(r.id, { server: r, local: null, conflict: null, failed: null, pendingDelete: false });
    for (const e of outbox) {
      const v = views.get(e.recordId) ?? { server: null, local: null, conflict: null, failed: null, pendingDelete: false };
      if (e.status === 'conflict') v.conflict = e;
      else if (e.status === 'failed') v.failed = e;
      if (e.status !== 'failed' || e.op === 'create') {
        if (e.op === 'delete') v.pendingDelete = e.status !== 'failed';
        else v.local = e;
      }
      views.set(e.recordId, v);
    }
    const items: DecryptedItem[] = [];
    const projects: DecryptedProject[] = [];
    const undecryptable: UndecryptableRecord[] = [];
    const me = this.account!.user.id;
    for (const [id, v] of views) {
      if (v.pendingDelete) continue;
      const s = v.server;
      if (s?.deletedAt) continue; // tombstone: never resurrect, local edits become failed in the outbox
      const vaultId = v.local ? (v.local.targetVaultId ?? v.local.vaultId) : s!.vaultId;
      const encKey = v.local?.encryptedKey ?? s?.encryptedKey;
      const encPayload = v.local?.encryptedPayload ?? s?.encryptedPayload;
      const kind = v.local?.kind ?? s!.kind;
      if (!encKey || !encPayload) continue;
      const membership = vaultById.get(vaultId);
      if (!membership) continue;
      let payload: unknown;
      let itemKey: Uint8Array;
      try {
        ({ payload, itemKey } = this.decryptOne(id, vaultId, encKey, encPayload));
      } catch (e) {
        undecryptable.push({ id, vaultId, reason: e instanceof Error ? e.message : 'decryption failed' });
        continue;
      }
      this.itemKeys.set(id, itemKey);
      const base: DecryptedRecordBase = {
        id,
        vaultId,
        revision: s?.revision ?? 0,
        createdAt: s?.createdAt ?? v.local!.createdAt,
        updatedAt: v.local ? v.local.createdAt : s!.updatedAt,
        createdBy: s?.createdBy ?? me,
        updatedBy: v.local ? me : s!.updatedBy,
        pending: !!v.local && v.local.status === 'pending',
        conflict: v.conflict,
        failed: v.failed,
        shared: membership.type === 'shared',
        sharedByMe: membership.type === 'shared' && membership.role === 'owner',
        role: membership.role,
      };
      if (kind === 'project') {
        const parsed = projectPayloadSchema.safeParse(payload);
        if (parsed.success) projects.push({ ...base, kind: 'project', payload: parsed.data });
        else undecryptable.push({ id, vaultId, reason: 'unsupported project format' });
      } else {
        const parsed = itemPayloadSchema.safeParse(payload);
        if (parsed.success) {
          const p = parsed.data as ItemPayload;
          const favorite = base.shared ? this.settings.sharedFavorites.includes(id) : p.favorite;
          items.push({ ...base, kind: 'item', payload: p, favorite });
        } else undecryptable.push({ id, vaultId, reason: 'unsupported item format (created by a newer client?)' });
      }
    }
    if (!this.keys) return;
    this.emit({ items, projects, undecryptable, vaults: vaults.map((v) => this.vaultInfo(v)) });
  }

  // ---------------- records ----------------

  private writableVault(vaultId: string) {
    const v = this.snapshot.vaults.find((x) => x.vaultId === vaultId);
    if (!v) throw new PermissionError('You no longer have access to this vault.');
    if (v.role === 'viewer') throw new PermissionError('You have view-only access to this shared item.');
    if (v.error) throw new PermissionError(v.error);
    return v;
  }

  /** Vault an item should live in: its project's vault (inherits sharing) or the personal vault. */
  vaultForProject(projectId: string | null | undefined): string {
    if (projectId) {
      const p = this.snapshot.projects.find((x) => x.id === projectId);
      if (p) return p.vaultId;
    }
    return this.account!.personalVaultId;
  }

  private async enqueueWrite(params: { id: string; kind: 'item' | 'project'; vaultId: string; payload: unknown; existing: boolean; targetVaultId?: string }) {
    const engine = this.engine;
    if (!engine) throw new VaultLockedError();
    const targetVault = params.targetVaultId ?? params.vaultId;
    let vk = this.vaultKeys.get(targetVault);
    // Right after the first sign-in on a device the vault list may not have synced yet.
    if (!vk && this.token) {
      await this.syncNow().catch(() => undefined);
      vk = this.vaultKeys.get(targetVault);
    }
    if (!vk) throw new PermissionError('The vault key is not available.');
    this.writableVault(targetVault);
    if (params.targetVaultId) this.writableVault(params.vaultId);
    const existingKey = params.existing ? this.itemKeys.get(params.id) : undefined;
    if (params.existing && !existingKey) throw new Error('item key missing');
    const enc = encryptRecord({ recordId: params.id, vaultId: targetVault, vaultKey: vk.key, payload: params.payload, itemKey: existingKey });
    if (!params.existing) this.itemKeys.set(params.id, enc.itemKey);
    let baseRevision: number | null = null;
    let afterMutationId: string | null = null;
    if (params.existing) {
      const latest = await engine.latestEntryFor(params.id);
      if (latest?.status === 'conflict') throw new Error('Resolve the sync conflict on this item first.');
      if (latest && latest.status === 'pending') afterMutationId = latest.mutationId;
      else {
        const rec = (await this.store!.allRecords()).find((r) => r.id === params.id);
        if (!rec) throw new Error('item not found');
        if (rec.deletedAt) throw new Error('This item was permanently deleted on another device.');
        baseRevision = rec.revision;
      }
    }
    await engine.enqueue({
      recordId: params.id,
      vaultId: params.vaultId,
      kind: params.kind,
      op: params.existing ? 'update' : 'create',
      baseRevision,
      afterMutationId,
      formatVersion: enc.formatVersion,
      encryptedKey: enc.encryptedKey,
      encryptedPayload: enc.encryptedPayload,
      ...(params.targetVaultId ? { targetVaultId: params.targetVaultId } : {}),
    });
    await this.rebuild();
    void this.syncNow().catch(() => undefined);
  }

  /** Create or update an item. Validates the payload before encrypting. */
  async saveItem(payload: ItemPayload, id?: string): Promise<string> {
    this.requireKeys();
    const parsed = itemPayloadSchema.parse(payload) as ItemPayload;
    if (id) {
      const cur = this.snapshot.items.find((i) => i.id === id);
      if (!cur) throw new Error('item not found');
      if (cur.shared && cur.payload.favorite !== parsed.favorite) parsed.favorite = cur.payload.favorite;
      await this.enqueueWrite({ id, kind: 'item', vaultId: cur.vaultId, payload: parsed, existing: true });
      return id;
    }
    const newId = uuid();
    const vaultId = this.vaultForProject(parsed.projectId);
    await this.enqueueWrite({ id: newId, kind: 'item', vaultId, payload: parsed, existing: false });
    return newId;
  }

  async updateItem(id: string, mutate: (p: ItemPayload) => ItemPayload | void): Promise<void> {
    const cur = this.snapshot.items.find((i) => i.id === id);
    if (!cur) throw new Error('item not found');
    const copy = structuredClone(cur.payload);
    const next = mutate(copy) ?? copy;
    await this.saveItem(next, id);
  }

  async duplicateItem(id: string): Promise<string> {
    const cur = this.snapshot.items.find((i) => i.id === id);
    if (!cur) throw new Error('item not found');
    return this.saveItem(duplicatePayload(cur.payload));
  }

  moveToTrash(id: string) {
    return this.updateItem(id, (p) => void (p.trashedAt = nowIso()));
  }
  restoreFromTrash(id: string) {
    return this.updateItem(id, (p) => void (p.trashedAt = null));
  }
  setArchived(id: string, archived: boolean) {
    return this.updateItem(id, (p) => void (p.archived = archived));
  }

  async toggleFavorite(id: string): Promise<void> {
    const cur = this.snapshot.items.find((i) => i.id === id);
    if (!cur) return;
    if (cur.shared) {
      const set = new Set(this.settings.sharedFavorites);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      await this.saveSettings({ ...this.settings, sharedFavorites: [...set] });
      await this.rebuild();
    } else {
      await this.updateItem(id, (p) => void (p.favorite = !p.favorite));
    }
  }

  /** Permanent deletion (tombstone on the server). Only allowed from trash. */
  async deletePermanently(id: string): Promise<void> {
    const engine = this.engine;
    if (!engine) throw new VaultLockedError();
    const cur = this.snapshot.items.find((i) => i.id === id) ?? this.snapshot.projects.find((p) => p.id === id);
    if (!cur) throw new Error('not found');
    this.writableVault(cur.vaultId);
    const latest = await engine.latestEntryFor(id);
    if (latest?.status === 'conflict') throw new Error('Resolve the sync conflict on this item first.');
    const rec = (await this.store!.allRecords()).find((r) => r.id === id);
    if (!rec && latest?.op === 'create' && latest.status === 'pending') {
      // never reached the server: just drop it
      await engine.discard(latest.mutationId);
      await this.rebuild();
      return;
    }
    await engine.enqueue({
      recordId: id,
      vaultId: cur.vaultId,
      kind: cur.kind,
      op: 'delete',
      baseRevision: latest?.status === 'pending' ? null : rec!.revision,
      afterMutationId: latest?.status === 'pending' ? latest.mutationId : null,
      formatVersion: 1,
      encryptedKey: null,
      encryptedPayload: null,
    });
    await this.rebuild();
    void this.syncNow().catch(() => undefined);
  }

  async emptyTrash(): Promise<number> {
    const trashed = this.snapshot.items.filter((i) => i.payload.trashedAt && i.role !== 'viewer');
    for (const t of trashed) await this.deletePermanently(t.id);
    return trashed.length;
  }

  async bulkUpdate(ids: string[], mutate: (p: ItemPayload) => void): Promise<{ ok: number; failed: Array<{ id: string; error: string }> }> {
    let ok = 0;
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of ids) {
      try {
        await this.updateItem(id, mutate);
        ok++;
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { ok, failed };
  }

  // ---------------- versions ----------------

  async itemVersions(id: string): Promise<Array<{ revision: number; createdAt: string; createdBy: string; payload: ItemPayload | ProjectPayload | null; error?: string }>> {
    this.requireKeys();
    const versions = await this.api.versions(id);
    return versions.map((v) => {
      try {
        const vk = this.vaultKeys.get(v.vaultId);
        if (!vk) throw new Error('vault key unavailable (version predates a key rotation or move)');
        const { payload, itemKey } = decryptRecord<ItemPayload | ProjectPayload>({ recordId: id, vaultId: v.vaultId, vaultKey: vk.key, encryptedKey: v.encryptedKey, encryptedPayload: v.encryptedPayload });
        wipe(itemKey);
        return { revision: v.revision, createdAt: v.createdAt, createdBy: v.createdBy, payload };
      } catch (e) {
        return { revision: v.revision, createdAt: v.createdAt, createdBy: v.createdBy, payload: null, error: e instanceof Error ? e.message : 'unreadable' };
      }
    });
  }

  /** Restore writes the old content as a NEW revision; history is never rewritten. */
  async restoreVersion(id: string, payload: ItemPayload): Promise<void> {
    const cur = this.snapshot.items.find((i) => i.id === id);
    if (!cur) throw new Error('item not found');
    await this.saveItem({ ...payload, trashedAt: null, favorite: cur.payload.favorite }, id);
  }

  // ---------------- conflicts ----------------

  async resolveConflict(id: string, keep: 'mine' | 'theirs' | 'both'): Promise<void> {
    const engine = this.engine;
    if (!engine) throw new VaultLockedError();
    const item = this.snapshot.items.find((i) => i.id === id) ?? this.snapshot.projects.find((p) => p.id === id);
    const conflict = item?.conflict;
    if (!item || !conflict) throw new Error('no conflict');
    if (keep === 'theirs') {
      await engine.resolveConflict(conflict.mutationId, { keep: 'theirs' });
    } else if (keep === 'mine') {
      if (!conflict.encryptedKey || !conflict.encryptedPayload) {
        // my side was a delete
        await engine.resolveConflict(conflict.mutationId, { keep: 'theirs' });
        if (conflict.conflict && !conflict.conflict.deletedAt) {
          await engine.enqueue({ recordId: id, vaultId: conflict.conflict.vaultId, kind: conflict.kind, op: 'delete', baseRevision: conflict.conflict.revision, formatVersion: 1, encryptedKey: null, encryptedPayload: null });
        }
      } else {
        await engine.resolveConflict(conflict.mutationId, { keep: 'mine', encryptedKey: conflict.encryptedKey, encryptedPayload: conflict.encryptedPayload });
      }
    } else {
      // keep both: my version becomes a new item; theirs stays
      const mine = conflict.encryptedKey && conflict.encryptedPayload ? this.decryptOne(id, conflict.targetVaultId ?? conflict.vaultId, conflict.encryptedKey, conflict.encryptedPayload).payload : null;
      await engine.resolveConflict(conflict.mutationId, { keep: 'theirs' });
      if (mine && item.kind === 'item') {
        const p = itemPayloadSchema.parse(mine) as ItemPayload;
        await this.rebuild();
        await this.saveItem({ ...p, title: `${p.title} (my version)` });
      }
    }
    await this.rebuild();
    void this.syncNow().catch(() => undefined);
  }

  /** Decrypt my side of a conflict for side-by-side comparison. */
  conflictVersions(id: string): { mine: unknown; theirs: unknown } | null {
    const item = this.snapshot.items.find((i) => i.id === id) ?? this.snapshot.projects.find((p) => p.id === id);
    const c = item?.conflict;
    if (!c) return null;
    const mine = c.encryptedKey && c.encryptedPayload ? this.decryptOne(id, c.targetVaultId ?? c.vaultId, c.encryptedKey, c.encryptedPayload).payload : null;
    const t = c.conflict;
    const theirs = t && t.encryptedKey && t.encryptedPayload ? this.decryptOne(id, t.vaultId, t.encryptedKey, t.encryptedPayload).payload : null;
    return { mine, theirs };
  }

  async retryFailed(id: string) {
    const item = this.snapshot.items.find((i) => i.id === id);
    if (item?.failed && this.engine) await this.engine.retry(item.failed.mutationId);
    await this.syncNow();
  }

  async discardFailed(id: string) {
    const item = this.snapshot.items.find((i) => i.id === id) ?? this.snapshot.projects.find((p) => p.id === id);
    if (item?.failed && this.engine) await this.engine.discard(item.failed.mutationId);
    await this.rebuild();
  }

  // ---------------- projects ----------------

  async saveProject(payload: ProjectPayload, id?: string): Promise<string> {
    this.requireKeys();
    const parsed = projectPayloadSchema.parse(payload);
    if (id) {
      const cur = this.snapshot.projects.find((p) => p.id === id);
      if (!cur) throw new Error('project not found');
      await this.enqueueWrite({ id, kind: 'project', vaultId: cur.vaultId, payload: parsed, existing: true });
      return id;
    }
    const newId = uuid();
    await this.enqueueWrite({ id: newId, kind: 'project', vaultId: this.account!.personalVaultId, payload: parsed, existing: false });
    return newId;
  }

  // ---------------- settings ----------------

  async saveSettings(next: UserSettingsPayload): Promise<void> {
    const keys = this.requireKeys();
    const parsed = userSettingsSchema.parse(next);
    this.settings = parsed;
    this.emit({ settings: parsed });
    this.touch();
    if (!this.token) return;
    const enc = encryptSettings(keys.userKey, parsed);
    try {
      const r = await this.api.putSettings({ baseRevision: this.settingsRevision, encryptedSettings: enc });
      this.settingsRevision = r.revision;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'revision_conflict') {
        // merge: union contacts and favorites, prefer local scalar choices
        const remote = await this.api.getSettings();
        const theirs = remote.encryptedSettings ? userSettingsSchema.parse(decryptSettings(keys.userKey, remote.encryptedSettings)) : DEFAULT_USER_SETTINGS;
        const merged: UserSettingsPayload = {
          ...parsed,
          contacts: { ...theirs.contacts, ...parsed.contacts },
          sharedFavorites: [...new Set([...theirs.sharedFavorites, ...parsed.sharedFavorites])],
        };
        const r = await this.api.putSettings({ baseRevision: remote.revision, encryptedSettings: encryptSettings(keys.userKey, merged) });
        this.settingsRevision = r.revision;
        this.settings = merged;
        this.emit({ settings: merged });
      } else throw e;
    }
  }

  // ---------------- account security ----------------

  /** Reauthenticate for sensitive changes (master password + current TOTP). */
  async reauthenticate(password: string, code: string): Promise<void> {
    const { authKey, wrapKey } = deriveLogin(password, this.account!.kdf);
    wipe(wrapKey);
    await this.api.reauth({ authKey, code });
  }

  /**
   * Change the master password. The User Key is re-wrapped (items untouched).
   * With `rotateUserKey`, a new User Key and recovery key are generated and the
   * personal vault key, private keys, and settings are re-wrapped.
   */
  async changeMasterPassword(params: { currentPassword: string; newPassword: string; code: string; signOutOtherSessions: boolean; rotateUserKey: boolean }): Promise<{ newRecoveryKey?: string }> {
    const keys = this.requireKeys();
    if (params.newPassword.length < 12) throw new Error('Use a master password of at least 12 characters.');
    // verify current password locally first
    const check = unlockWithPassword(params.currentPassword, this.account!.kdf, this.account!.keys);
    wipeUnlocked({ ...check, userKey: check.userKey });
    await this.reauthenticate(params.currentPassword, params.code);
    const personalVaultId = this.account!.personalVaultId;
    let newRecoveryKey: string | undefined;
    if (params.rotateUserKey) {
      const personal = this.vaultKeys.get(personalVaultId);
      if (!personal) throw new Error('personal vault key unavailable');
      const rot = rotateUserKey(keys, params.newPassword);
      newRecoveryKey = rot.recoveryKey;
      await this.api.changePassword({
        kdf: rot.kdf,
        authKey: rot.authKey,
        encryptedUserKey: rot.encryptedUserKey,
        signOutOtherSessions: params.signOutOtherSessions,
        rotation: {
          encryptedPrivateEncryptionKey: rot.encryptedPrivateEncryptionKey,
          encryptedPrivateSigningKey: rot.encryptedPrivateSigningKey,
          encryptedUserKeyByRecovery: rot.encryptedUserKeyByRecovery,
          recoveryAuthKey: rot.recoveryAuthKey,
          personalVault: { id: personalVaultId, encryptedVaultKey: wrapVaultKeyForSelf(rot.newUserKey, personal.key, personalVaultId, personal.keyVersion) },
          encryptedSettings: encryptSettings(rot.newUserKey, this.settings),
        },
      });
      wipe(keys.userKey);
      this.keys = { ...keys, userKey: rot.newUserKey };
      await this.disableBiometrics().catch(() => undefined);
    } else {
      const pw = rewrapForNewPassword(keys.userKey, params.newPassword);
      await this.api.changePassword({ kdf: pw.kdf, authKey: pw.authKey, encryptedUserKey: pw.encryptedUserKey, signOutOtherSessions: params.signOutOtherSessions });
    }
    const fresh = await this.api.account();
    this.account = fresh;
    this.settingsRevision = fresh.settings.revision;
    await this.store!.putAccount({ account: fresh, cachedAt: nowIso() });
    await this.platform.prefs.remove(`${PREF_TRUSTED_DEVICE}:${fresh.user.email}`);
    return { newRecoveryKey };
  }

  async regenerateRecoveryCodes(password: string, code: string): Promise<string[]> {
    await this.reauthenticate(password, code);
    return (await this.api.regenerateRecoveryCodes()).recoveryCodes;
  }

  /** Re-enroll the authenticator (requires reauth). */
  async startMfaReenrollment(password: string, code: string) {
    await this.reauthenticate(password, code);
    return this.api.mfaEnrollStart({});
  }

  async confirmMfaReenrollment(code: string): Promise<string[]> {
    return (await this.api.mfaEnrollConfirm({ code })).recoveryCodes;
  }

  listSessions(): Promise<SessionListItem[]> {
    return this.api.sessions();
  }
  revokeSession(id: string) {
    return this.api.revokeSession(id);
  }
  listDevices(): Promise<DeviceListItem[]> {
    return this.api.devices();
  }
  untrustDevice(id: string) {
    return this.api.untrustDevice(id);
  }
  forgetDevice(id: string) {
    return this.api.forgetDevice(id);
  }
  async logoutEverywhere(password: string, code: string) {
    await this.reauthenticate(password, code);
    await this.api.logoutAll();
    await this.logout({ keepCache: false });
  }
  async auditEvents(cursor?: string): Promise<{ data: AuditEventDto[]; nextCursor: string | null }> {
    return this.api.auditEvents(cursor);
  }

  // ---------------- sharing ----------------

  /** Look up a registered user and compare their key fingerprint to the pinned one. */
  async lookupRecipient(email: string): Promise<RecipientInfo> {
    this.requireKeys();
    const u = await this.api.lookupUser(email.trim().toLowerCase());
    if (!verifyPublicKeySignature(u.publicEncryptionKey, u.publicSigningKey, u.publicKeySignature)) {
      throw new Error('This user’s public keys are not correctly signed. Sharing is blocked.');
    }
    const fingerprint = publicKeyFingerprint(u.publicSigningKey, u.publicEncryptionKey);
    const pinned = this.settings.contacts[u.userId];
    return {
      userId: u.userId,
      email: u.email,
      name: u.name,
      fingerprint,
      publicEncryptionKey: u.publicEncryptionKey,
      publicSigningKey: u.publicSigningKey,
      pinned: !pinned ? 'new' : pinned.publicSigningKey === u.publicSigningKey && (!pinned.fingerprint || pinned.fingerprint === fingerprint) ? 'match' : 'changed',
      verified: !!pinned?.verified && pinned.publicSigningKey === u.publicSigningKey,
    };
  }

  myFingerprint(): string {
    const k = this.account!.keys;
    return publicKeyFingerprint(k.publicSigningKey, k.publicEncryptionKey);
  }

  async pinContact(r: RecipientInfo, verified: boolean) {
    await this.saveSettings({
      ...this.settings,
      contacts: { ...this.settings.contacts, [r.userId]: { email: r.email, fingerprint: r.fingerprint, publicSigningKey: r.publicSigningKey, verified, pinnedAt: nowIso() } },
    });
  }

  /** Reasons an item needs extra confirmation before sharing. */
  sharingWarnings(itemIds: string[]): string[] {
    const w = new Set<string>();
    for (const id of itemIds) {
      const it = this.snapshot.items.find((i) => i.id === id);
      if (!it) continue;
      if (isProductionEnvironment(it.payload.environment)) w.add('Includes Production secrets.');
      if (it.payload.type === 'ssh_key' && it.payload.fields.privateKey) w.add('Includes a private SSH key. Recipients can copy it and keep using it after you revoke access; prefer adding their own public key to the server.');
      if (it.payload.type === 'env_file' && /prod/i.test(it.payload.fields.filename)) w.add('Includes a production environment file.');
    }
    return [...w];
  }

  private async createSharedVault(kind: 'item' | 'project', allowResharing: boolean): Promise<{ vaultId: string; key: Uint8Array }> {
    const keys = this.requireKeys();
    const vaultId = uuid();
    const vk = generateVaultKey();
    const me = this.account!.user.id;
    const grant = grantVaultKey({ vaultKey: vk, vaultId, keyVersion: 1, recipientUserId: me, recipientPublicEncryptionKey: this.account!.keys.publicEncryptionKey, grantor: keys });
    await this.api.createSharedVault({ id: vaultId, kind, allowResharing, encryptedVaultKey: grant.encryptedVaultKey, keySignature: grant.keySignature });
    this.vaultKeys.set(vaultId, { key: vk, keyVersion: 1 });
    return { vaultId, key: vk };
  }

  /** Move records into another vault by re-wrapping their item keys (server-side PUT with vaultId). */
  private async moveRecords(ids: string[], targetVaultId: string, targetKey: Uint8Array) {
    await this.syncNow();
    const records = await this.store!.allRecords();
    for (const id of ids) {
      const rec = records.find((r) => r.id === id);
      if (!rec || rec.deletedAt || !rec.encryptedPayload) throw new Error('Sync pending changes before sharing.');
      const itemKey = this.itemKeys.get(id);
      if (!itemKey) throw new Error('item key unavailable');
      const updated = await this.api.updateRecord(id, {
        baseRevision: rec.revision,
        formatVersion: rec.formatVersion,
        encryptedKey: rewrapRecordKey(itemKey, targetVaultId, targetKey, id),
        encryptedPayload: rec.encryptedPayload,
        vaultId: targetVaultId,
        mutationId: uuid(),
      });
      await this.store!.putRecords([updated]);
    }
  }

  private async grantTo(vaultId: string, key: Uint8Array, keyVersion: number, r: RecipientInfo, role: VaultRole, expiresAt: string | null) {
    const keys = this.requireKeys();
    if (r.pinned === 'changed') throw new Error(`${r.email}'s key fingerprint changed. Verify it before sharing.`);
    const grant = grantVaultKey({ vaultKey: key, vaultId, keyVersion, recipientUserId: r.userId, recipientPublicEncryptionKey: r.publicEncryptionKey, grantor: keys });
    await this.api.invite(vaultId, { recipientUserId: r.userId, role, keyVersion, encryptedVaultKey: grant.encryptedVaultKey, keySignature: grant.keySignature, expiresAt });
    if (r.pinned === 'new') await this.pinContact(r, r.verified);
  }

  /**
   * Share items (individually selected) or a whole project with recipients.
   * A project share creates a shared vault for the project: items added to the
   * project later are created in that vault and therefore inherit sharing.
   */
  async share(params: {
    target: { kind: 'items'; itemIds: string[] } | { kind: 'project'; projectId: string };
    recipients: Array<{ recipient: RecipientInfo; role: VaultRole; expiresAt: string | null }>;
    allowResharing: boolean;
  }): Promise<string> {
    this.requireKeys();
    const personal = this.account!.personalVaultId;
    let ids: string[];
    let kind: 'item' | 'project';
    if (params.target.kind === 'project') {
      const projectId = params.target.projectId;
      const project = this.snapshot.projects.find((p) => p.id === projectId);
      if (!project) throw new Error('project not found');
      if (project.vaultId !== personal) {
        // already shared: just invite
        const v = this.snapshot.vaults.find((x) => x.vaultId === project.vaultId)!;
        const vk = this.vaultKeys.get(project.vaultId)!;
        for (const r of params.recipients) await this.grantTo(project.vaultId, vk.key, v.keyVersion, r.recipient, r.role, r.expiresAt);
        await this.syncNow();
        return project.vaultId;
      }
      ids = [projectId, ...this.snapshot.items.filter((i) => i.payload.projectId === projectId && i.vaultId === personal).map((i) => i.id)];
      kind = 'project';
    } else {
      ids = params.target.itemIds;
      kind = 'item';
      const items = ids.map((id) => this.snapshot.items.find((i) => i.id === id));
      if (items.some((i) => !i)) throw new Error('item not found');
      const sharedAlready = items.filter((i) => i!.vaultId !== personal);
      if (sharedAlready.length) {
        const vaults = new Set(sharedAlready.map((i) => i!.vaultId));
        if (vaults.size === 1 && sharedAlready.length === items.length) {
          const vaultId = [...vaults][0]!;
          const v = this.snapshot.vaults.find((x) => x.vaultId === vaultId)!;
          const vk = this.vaultKeys.get(vaultId)!;
          for (const r of params.recipients) await this.grantTo(vaultId, vk.key, v.keyVersion, r.recipient, r.role, r.expiresAt);
          await this.syncNow();
          return vaultId;
        }
        throw new Error('Some selected items are already shared in another collection. Share them separately.');
      }
    }
    const { vaultId, key } = await this.createSharedVault(kind, params.allowResharing);
    await this.moveRecords(ids, vaultId, key);
    for (const r of params.recipients) await this.grantTo(vaultId, key, 1, r.recipient, r.role, r.expiresAt);
    await this.syncNow();
    return vaultId;
  }

  async invite(vaultId: string, recipient: RecipientInfo, role: VaultRole, expiresAt: string | null) {
    const v = this.snapshot.vaults.find((x) => x.vaultId === vaultId);
    const vk = this.vaultKeys.get(vaultId);
    if (!v || !vk) throw new Error('vault unavailable');
    await this.grantTo(vaultId, vk.key, v.keyVersion, recipient, role, expiresAt);
  }

  members(vaultId: string): Promise<VaultMemberDto[]> {
    return this.api.members(vaultId);
  }

  updateMember(vaultId: string, userId: string, patch: { role?: VaultRole; expiresAt?: string | null }) {
    return this.api.updateMember(vaultId, userId, patch);
  }

  setResharing(vaultId: string, allowResharing: boolean) {
    return this.api.updateVault(vaultId, { allowResharing });
  }

  /**
   * Revoke a member's future access, then rotate the vault key and re-encrypt
   * every record with fresh item keys so the removed member cannot read future
   * edits even with keys they retained. Prior copies cannot be erased.
   */
  async revokeMember(vaultId: string, userId: string): Promise<{ rotated: boolean }> {
    await this.api.removeMember(vaultId, userId);
    try {
      await this.rotateVaultKey(vaultId);
      return { rotated: true };
    } catch {
      await this.syncNow();
      return { rotated: false };
    }
  }

  async rotateVaultKey(vaultId: string): Promise<void> {
    const keys = this.requireKeys();
    await this.syncNow();
    const v = this.snapshot.vaults.find((x) => x.vaultId === vaultId);
    if (!v || v.role !== 'owner') throw new PermissionError('Only owners can rotate the vault key.');
    const outbox = await this.store!.outbox();
    if (outbox.some((e) => e.vaultId === vaultId || e.targetVaultId === vaultId)) throw new Error('Sync pending changes in this vault first.');
    const members = (await this.api.members(vaultId)).filter((m) => m.status === 'accepted' || m.status === 'invited');
    const me = this.account!.user.id;
    const newVersion = v.keyVersion + 1;
    const newKey = generateVaultKey();
    const grants = [];
    for (const m of members) {
      if (m.userId !== me) {
        const pinned = this.settings.contacts[m.userId];
        if (pinned && pinned.publicSigningKey !== m.publicSigningKey) throw new Error(`${m.email}'s key changed; verify before rotating.`);
      }
      const g = grantVaultKey({ vaultKey: newKey, vaultId, keyVersion: newVersion, recipientUserId: m.userId, recipientPublicEncryptionKey: m.publicEncryptionKey, grantor: keys });
      grants.push({ userId: m.userId, encryptedVaultKey: g.encryptedVaultKey, keySignature: g.keySignature });
    }
    const records = (await this.store!.allRecords()).filter((r) => r.vaultId === vaultId && !r.deletedAt);
    const rotated = records.map((r) => {
      const { payload, itemKey } = this.decryptOne(r.id, vaultId, r.encryptedKey!, r.encryptedPayload!);
      void itemKey;
      // fresh item key: retained old item keys cannot decrypt future ciphertext
      const enc = encryptRecord({ recordId: r.id, vaultId, vaultKey: newKey, payload });
      wipe(enc.itemKey);
      return { id: r.id, baseRevision: r.revision, encryptedKey: enc.encryptedKey, encryptedPayload: enc.encryptedPayload };
    });
    await this.api.rotateVault(vaultId, { newKeyVersion: newVersion, grants, records: rotated });
    const old = this.vaultKeys.get(vaultId);
    if (old) wipe(old.key);
    this.vaultKeys.set(vaultId, { key: newKey, keyVersion: newVersion });
    await this.syncNow();
  }

  async leaveVault(vaultId: string) {
    await this.api.removeMember(vaultId, this.account!.user.id);
    await this.syncNow();
  }

  /** Move shared items back into the personal vault and delete the shared vault (owner only). */
  async unshare(vaultId: string) {
    const personal = this.account!.personalVaultId;
    const pk = this.vaultKeys.get(personal)!;
    const ids = [...this.snapshot.items, ...this.snapshot.projects].filter((r) => r.vaultId === vaultId).map((r) => r.id);
    await this.moveRecords(ids, personal, pk.key);
    await this.api.deleteVault(vaultId);
    await this.syncNow();
  }

  async invitations(): Promise<Array<InvitationDto & { fingerprint: string }>> {
    const inv = await this.api.invitations();
    return inv.map((i) => ({ ...i, fingerprint: publicKeyFingerprint(i.invitedBy.publicSigningKey, i.invitedBy.publicEncryptionKey) }));
  }

  async acceptInvitation(inv: InvitationDto & { fingerprint: string }, verified: boolean) {
    const pinned = this.settings.contacts[inv.invitedBy.userId];
    if (pinned && pinned.publicSigningKey !== inv.invitedBy.publicSigningKey) {
      throw new Error(`${inv.invitedBy.email}'s key changed since you last verified it. Verify their fingerprint before accepting.`);
    }
    if (!pinned || (verified && !pinned.verified)) {
      await this.saveSettings({
        ...this.settings,
        contacts: {
          ...this.settings.contacts,
          [inv.invitedBy.userId]: { email: inv.invitedBy.email, fingerprint: inv.fingerprint, publicSigningKey: inv.invitedBy.publicSigningKey, verified, pinnedAt: nowIso() },
        },
      });
    }
    await this.api.acceptInvitation(inv.vaultId);
    await this.syncNow();
  }

  async declineInvitation(vaultId: string) {
    await this.api.declineInvitation(vaultId);
  }

  // ---------------- export ----------------

  /** Plaintext export of selected items (caller must have confirmed with the user). */
  exportPlaintext(ids?: string[]): string {
    this.requireKeys();
    const items = this.snapshot.items.filter((i) => !ids || ids.includes(i.id));
    return JSON.stringify(
      {
        format: 'passvault-plaintext-export',
        version: 1,
        exportedAt: nowIso(),
        warning: 'This file contains unencrypted secrets. Store it securely and delete it when no longer needed.',
        projects: this.snapshot.projects.map((p) => ({ id: p.id, ...p.payload })),
        items: items.map((i) => ({ id: i.id, ...i.payload })),
      },
      null,
      2,
    );
  }

  get platformRef() {
    return this.platform;
  }
}

// ---------------------------------------------------------------------------
// Recovery flows (no session required)

export async function startRecovery(api: ApiClient, email: string) {
  await api.recoveryStart({ email: email.trim().toLowerCase() });
}

export async function verifyRecovery(api: ApiClient, token: string, factor: { code?: string; recoveryCode?: string }) {
  return api.recoveryVerify({ token, ...factor });
}

/**
 * Recover the vault with the recovery key: the User Key is unwrapped locally,
 * re-wrapped under a new master password, and a NEW recovery key is issued.
 */
export async function completeVaultRecovery(
  api: ApiClient,
  verified: Awaited<ReturnType<typeof verifyRecovery>>,
  recoveryKey: string,
  newPassword: string,
): Promise<{ newRecoveryKey: string }> {
  const crypto = await import('@passvault/crypto');
  await crypto.initCrypto();
  if (newPassword.length < 12) throw new Error('Use a master password of at least 12 characters.');
  const unlocked = crypto.unlockWithRecoveryKey(recoveryKey, verified.encryptedUserKeyByRecovery, verified.keys);
  try {
    const old = crypto.deriveRecoveryKeys(recoveryKey);
    crypto.wipe(old.wrapKey);
    const pw = crypto.rewrapForNewPassword(unlocked.userKey, newPassword);
    const newRecoveryKey = crypto.generateRecoveryKey();
    const rec = crypto.wrapUserKeyForRecovery(unlocked.userKey, newRecoveryKey);
    await api.recoveryCompleteVault({
      recoveryToken: verified.recoveryToken,
      recoveryAuthKey: old.authKey,
      kdf: pw.kdf,
      authKey: pw.authKey,
      encryptedUserKey: pw.encryptedUserKey,
      newEncryptedUserKeyByRecovery: rec.encryptedUserKeyByRecovery,
      newRecoveryAuthKey: rec.recoveryAuthKey,
    });
    return { newRecoveryKey };
  } finally {
    crypto.wipeUnlocked(unlocked);
  }
}

/** Last resort: permanently delete vault data and start with fresh keys. */
export async function resetAccount(api: ApiClient, recoveryToken: string, newPassword: string): Promise<{ recoveryKey: string }> {
  const crypto = await import('@passvault/crypto');
  await crypto.initCrypto();
  const m = crypto.createRegistrationMaterial(newPassword);
  const personalVaultId = globalThis.crypto.randomUUID();
  try {
    await api.recoveryResetAccount({
      recoveryToken,
      confirmation: 'DELETE MY VAULT DATA',
      kdf: m.kdf,
      authKey: m.authKey,
      keys: m.keys,
      personalVault: { id: personalVaultId, encryptedVaultKey: crypto.wrapVaultKeyForSelf(m.unlocked.userKey, crypto.generateVaultKey(), personalVaultId, 1) },
    });
    return { recoveryKey: m.recoveryKey };
  } finally {
    crypto.wipeUnlocked(m.unlocked);
  }
}
