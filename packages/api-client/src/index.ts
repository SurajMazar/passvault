import type * as T from '@passvault/types';

/**
 * Typed HTTP client for the PassVault API. Platform-neutral (uses fetch).
 * Never logs request bodies. Callers supply the session token getter so the
 * token can live wherever the platform keeps it.
 */

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    public readonly status: number,
    public readonly code: T.ApiErrorCode | 'network_error' | 'offline' | 'cancelled',
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
  }
  get isConflict() {
    return this.code === 'revision_conflict';
  }
  /** No answer from the server; queued changes stay pending (a cancelled request is retried later too). */
  get isNetwork() {
    return this.code === 'network_error' || this.code === 'offline' || this.code === 'cancelled';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => string | null;
  /** called when the server reports the session is no longer valid */
  onUnauthenticated?: () => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class ApiClient {
  private readonly base: string;
  /** in-flight requests, so a server switch can cancel them (abortAll) */
  private readonly inflight = new Set<AbortController>();
  private closed = false;
  constructor(private readonly opts: ApiClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
  }

  get baseUrl() {
    return this.base;
  }

  /**
   * Cancels every in-flight request and refuses new ones. Used when the client
   * switches servers: nothing started for the old server may finish later.
   */
  abortAll(): void {
    this.closed = true;
    for (const c of this.inflight) c.abort();
    this.inflight.clear();
  }

  async request<R>(method: Method, path: string, body?: unknown, opts: { auth?: boolean; query?: Record<string, string | number | undefined> } = {}): Promise<R> {
    const url = new URL(`${this.base}/api/v1${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false) {
      const token = this.opts.getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    if (this.closed) throw new ApiError(0, 'cancelled', 'This connection was closed (server changed)');
    const ctrl = new AbortController();
    this.inflight.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (e) {
      if (this.closed) throw new ApiError(0, 'cancelled', 'This connection was closed (server changed)');
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      throw new ApiError(0, offline ? 'offline' : 'network_error', offline ? 'You are offline' : 'Could not reach the PassVault server');
    } finally {
      clearTimeout(timer);
      this.inflight.delete(ctrl);
    }
    if (res.status === 204) return undefined as R;
    let json: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const err = (json as T.ApiErrorBody | null)?.error;
      const apiErr = new ApiError(res.status, err?.code ?? 'internal_error', err?.message ?? `Request failed (${res.status})`, err?.details, (json as T.ApiErrorBody | null)?.requestId);
      if (res.status === 401 && opts.auth !== false) this.opts.onUnauthenticated?.();
      throw apiErr;
    }
    return json as R;
  }

  // ---- auth ----
  prelogin(body: T.PreloginRequest) {
    return this.request<T.PreloginResponse>('POST', '/auth/prelogin', body, { auth: false });
  }
  register(body: T.RegisterRequest) {
    return this.request<T.RegisterResponse>('POST', '/auth/register', body, { auth: false });
  }
  registerStart(body: T.RegisterStartRequest) {
    return this.request<void>('POST', '/auth/register/start', body, { auth: false });
  }
  registerVerify(body: T.RegisterVerifyRequest) {
    return this.request<T.RegisterVerifyResponse>('POST', '/auth/register/verify', body, { auth: false });
  }
  login(body: T.LoginRequest) {
    return this.request<T.LoginResponse>('POST', '/auth/login', body, { auth: false });
  }
  mfaEnrollStart(body: T.MfaEnrollStartRequest) {
    return this.request<T.MfaEnrollStartResponse>('POST', '/auth/mfa/enroll/start', body, { auth: !body.mfaToken });
  }
  mfaEnrollConfirm(body: T.MfaEnrollConfirmRequest) {
    return this.request<T.MfaEnrollConfirmResponse>('POST', '/auth/mfa/enroll/confirm', body, { auth: !body.mfaToken });
  }
  mfaVerify(body: T.MfaVerifyRequest) {
    return this.request<T.MfaVerifyResponse>('POST', '/auth/mfa/verify', body, { auth: false });
  }
  reauth(body: T.ReauthRequest) {
    return this.request<T.ReauthResponse>('POST', '/auth/reauth', body);
  }
  logout() {
    return this.request<void>('POST', '/auth/logout', {});
  }
  logoutAll() {
    return this.request<void>('POST', '/auth/logout-all', {});
  }
  account() {
    return this.request<T.AccountBundle>('GET', '/account');
  }
  changePassword(body: T.ChangePasswordRequest) {
    return this.request<void>('POST', '/account/password', body);
  }
  regenerateRecoveryCodes() {
    return this.request<{ recoveryCodes: string[] }>('POST', '/account/mfa/recovery-codes', {});
  }
  getSettings() {
    return this.request<T.SettingsDto>('GET', '/account/settings');
  }
  putSettings(body: T.UpdateSettingsRequest) {
    return this.request<T.SettingsDto>('PUT', '/account/settings', body);
  }
  sessions() {
    return this.request<T.SessionListItem[]>('GET', '/sessions');
  }
  revokeSession(id: string) {
    return this.request<void>('DELETE', `/sessions/${encodeURIComponent(id)}`);
  }
  devices() {
    return this.request<T.DeviceListItem[]>('GET', '/devices');
  }
  untrustDevice(id: string) {
    return this.request<void>('DELETE', `/devices/${encodeURIComponent(id)}/trust`);
  }
  forgetDevice(id: string) {
    return this.request<void>('DELETE', `/devices/${encodeURIComponent(id)}`);
  }

  // ---- recovery ----
  recoveryStart(body: T.RecoveryStartRequest) {
    return this.request<void>('POST', '/recovery/start', body, { auth: false });
  }
  recoveryVerify(body: T.RecoveryVerifyRequest) {
    return this.request<T.RecoveryVerifyResponse>('POST', '/recovery/verify', body, { auth: false });
  }
  recoveryCompleteVault(body: T.RecoveryCompleteVaultRequest) {
    return this.request<void>('POST', '/recovery/complete-vault', body, { auth: false });
  }
  recoveryResetAccount(body: T.RecoveryResetAccountRequest) {
    return this.request<void>('POST', '/recovery/reset-account', body, { auth: false });
  }

  // ---- users / vaults ----
  lookupUser(email: string) {
    return this.request<T.UserLookupResponse>('GET', '/users/lookup', undefined, { query: { email } });
  }
  vaults() {
    return this.request<T.VaultMembershipDto[]>('GET', '/vaults');
  }
  createSharedVault(body: T.CreateSharedVaultRequest) {
    return this.request<T.VaultMembershipDto>('POST', '/vaults', body);
  }
  updateVault(id: string, body: T.UpdateVaultRequest) {
    return this.request<T.VaultMembershipDto>('PATCH', `/vaults/${id}`, body);
  }
  deleteVault(id: string) {
    return this.request<void>('DELETE', `/vaults/${id}`);
  }
  members(vaultId: string) {
    return this.request<T.VaultMemberDto[]>('GET', `/vaults/${vaultId}/members`);
  }
  invite(vaultId: string, body: T.InviteMemberRequest) {
    return this.request<T.VaultMemberDto>('POST', `/vaults/${vaultId}/members`, body);
  }
  updateMember(vaultId: string, userId: string, body: T.UpdateMemberRequest) {
    return this.request<T.VaultMemberDto>('PATCH', `/vaults/${vaultId}/members/${userId}`, body);
  }
  removeMember(vaultId: string, userId: string) {
    return this.request<void>('DELETE', `/vaults/${vaultId}/members/${userId}`);
  }
  rotateVault(vaultId: string, body: T.RotateVaultKeyRequest) {
    return this.request<T.VaultMembershipDto>('POST', `/vaults/${vaultId}/rotate`, body);
  }
  vaultRecords(vaultId: string, cursor?: string, limit = 500) {
    return this.request<T.Page<T.RecordDto>>('GET', `/vaults/${vaultId}/records`, undefined, { query: { cursor, limit } });
  }
  invitations() {
    return this.request<T.InvitationDto[]>('GET', '/invitations');
  }
  acceptInvitation(vaultId: string) {
    return this.request<T.VaultMembershipDto>('POST', `/invitations/${vaultId}/accept`, {});
  }
  declineInvitation(vaultId: string) {
    return this.request<void>('POST', `/invitations/${vaultId}/decline`, {});
  }

  // ---- records ----
  createRecord(body: T.CreateRecordRequest) {
    return this.request<T.RecordDto>('POST', '/records', body);
  }
  getRecord(id: string) {
    return this.request<T.RecordDto>('GET', `/records/${id}`);
  }
  updateRecord(id: string, body: T.UpdateRecordRequest) {
    return this.request<T.RecordDto>('PUT', `/records/${id}`, body);
  }
  deleteRecord(id: string, body: T.DeleteRecordRequest) {
    return this.request<T.RecordDto>('DELETE', `/records/${id}`, body);
  }
  versions(id: string) {
    return this.request<T.RecordVersionDto[]>('GET', `/records/${id}/versions`);
  }

  // ---- sync / audit ----
  sync(cursor: string, limit = 500) {
    return this.request<T.SyncResponse>('GET', '/sync', undefined, { query: { cursor, limit } });
  }
  auditEvents(cursor?: string, limit = 100) {
    return this.request<T.Page<T.AuditEventDto>>('GET', '/audit-events', undefined, { query: { cursor, limit } });
  }
  health() {
    return this.request<T.HealthResponse>('GET', '/health', undefined, { auth: false });
  }
}
