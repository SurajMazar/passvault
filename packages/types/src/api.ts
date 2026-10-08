/**
 * Wire contracts for the PassVault HTTP API (base path /api/v1).
 * All binary values are base64url without padding. All "encrypted*" fields
 * are opaque envelopes produced by @passvault/crypto on clients.
 * See docs/API.md for semantics and authorization rules.
 */

export type ClientType = 'web' | 'extension' | 'desktop' | 'cli';

export interface KdfParamsDto {
  algorithm: 'argon2id';
  version: 1;
  opsLimit: number;
  memLimitBytes: number;
  salt: string;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

export const API_ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'invalid_credentials',
  'invalid_code',
  'mfa_required',
  'mfa_invalid',
  'mfa_enrollment_required',
  'reauth_required',
  'forbidden',
  'not_found',
  'conflict',
  'revision_conflict',
  'already_exists',
  'rate_limited',
  'gone',
  'membership_expired',
  'key_rotation_required',
  'registration_closed',
  'internal_error',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

// ---------- Auth ----------

export interface PreloginRequest {
  email: string;
}
export interface PreloginResponse {
  kdf: KdfParamsDto;
}

export interface AccountKeysDto {
  encryptedUserKey: string;
  publicEncryptionKey: string;
  encryptedPrivateEncryptionKey: string;
  publicSigningKey: string;
  encryptedPrivateSigningKey: string;
  publicKeySignature: string;
}

/** Step 1: request a verification code for an email address (always 202). */
export interface RegisterStartRequest {
  email: string;
}
/** Step 2: prove control of the mailbox; returns a single-use registration token. */
export interface RegisterVerifyRequest {
  email: string;
  code: string;
}
export interface RegisterVerifyResponse {
  registrationToken: string;
  expiresAt: string;
}

/** Step 3: create the (already verified) account. */
export interface RegisterRequest {
  registrationToken: string;
  email: string;
  name: string;
  kdf: KdfParamsDto;
  authKey: string;
  keys: AccountKeysDto & {
    encryptedUserKeyByRecovery: string;
    recoveryAuthKey: string;
  };
  personalVault: {
    id: string;
    encryptedVaultKey: string;
  };
}
export interface RegisterResponse {
  userId: string;
}

export interface DeviceInfo {
  /** client-generated stable UUID for this installation */
  id: string;
  name: string;
  clientType: ClientType;
}

export interface LoginRequest {
  email: string;
  authKey: string;
  device: DeviceInfo;
  trustedDeviceToken?: string;
}

export interface SessionDto {
  token: string;
  sessionId: string;
  expiresAt: string;
  idleTimeoutSeconds: number;
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  createdAt: string;
}

export interface AccountBundle {
  user: UserDto;
  kdf: KdfParamsDto;
  keys: AccountKeysDto;
  personalVaultId: string;
  settings: { encryptedSettings: string | null; revision: number };
}

export type LoginResponse =
  | { status: 'mfa_required'; mfaToken: string; expiresAt: string }
  | { status: 'mfa_enrollment_required'; mfaToken: string; expiresAt: string }
  | { status: 'ok'; session: SessionDto; account: AccountBundle };

export interface MfaEnrollStartRequest {
  mfaToken?: string;
}
export interface MfaEnrollStartResponse {
  secret: string;
  otpauthUri: string;
}
export interface MfaEnrollConfirmRequest {
  mfaToken?: string;
  code: string;
}
export interface MfaEnrollConfirmResponse {
  recoveryCodes: string[];
  session?: SessionDto;
  account?: AccountBundle;
}

export interface MfaVerifyRequest {
  mfaToken: string;
  code?: string;
  recoveryCode?: string;
  trustDevice?: boolean;
}
export interface MfaVerifyResponse {
  session: SessionDto;
  account: AccountBundle;
  trustedDeviceToken?: string;
  /** present when a recovery code was used */
  remainingRecoveryCodes?: number;
}

export interface ReauthRequest {
  authKey: string;
  code: string;
}
export interface ReauthResponse {
  reauthUntil: string;
}

export interface ChangePasswordRequest {
  kdf: KdfParamsDto;
  authKey: string;
  encryptedUserKey: string;
  signOutOtherSessions: boolean;
  /** present when the User Key was rotated as well */
  rotation?: {
    encryptedPrivateEncryptionKey: string;
    encryptedPrivateSigningKey: string;
    encryptedUserKeyByRecovery: string;
    recoveryAuthKey: string;
    personalVault: { id: string; encryptedVaultKey: string };
    encryptedSettings: string | null;
  };
}

export interface SessionListItem {
  id: string;
  deviceId: string;
  deviceName: string;
  clientType: ClientType;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
  ipPrefix: string | null;
  userAgent: string | null;
}

export interface DeviceListItem {
  id: string;
  name: string;
  clientType: ClientType;
  trusted: boolean;
  trustedUntil: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  activeSessions: number;
}

// ---------- Recovery ----------

export interface RecoveryStartRequest {
  email: string;
}
export interface RecoveryVerifyRequest {
  /** token from the recovery email link */
  token: string;
  code?: string;
  recoveryCode?: string;
}
export interface RecoveryVerifyResponse {
  recoveryToken: string;
  expiresAt: string;
  encryptedUserKeyByRecovery: string;
  keys: Omit<AccountKeysDto, 'encryptedUserKey'>;
}
export interface RecoveryCompleteVaultRequest {
  recoveryToken: string;
  /** proves possession of the vault recovery key */
  recoveryAuthKey: string;
  kdf: KdfParamsDto;
  authKey: string;
  encryptedUserKey: string;
  /** the used recovery key is replaced by a new one */
  newEncryptedUserKeyByRecovery: string;
  newRecoveryAuthKey: string;
}
export interface RecoveryResetAccountRequest {
  recoveryToken: string;
  confirmation: 'DELETE MY VAULT DATA';
  kdf: KdfParamsDto;
  authKey: string;
  keys: RegisterRequest['keys'];
  personalVault: RegisterRequest['personalVault'];
}

// ---------- Vaults, sharing ----------

export type VaultType = 'personal' | 'shared';
export type VaultRole = 'owner' | 'editor' | 'viewer';
export type MembershipStatus = 'invited' | 'accepted' | 'declined' | 'revoked' | 'expired';
export type SharedVaultKind = 'item' | 'project';

export interface VaultMembershipDto {
  vaultId: string;
  type: VaultType;
  kind: SharedVaultKind | null;
  role: VaultRole;
  status: MembershipStatus;
  keyVersion: number;
  encryptedVaultKey: string;
  keySignature: string | null;
  grantedBy: { userId: string; email: string; publicSigningKey: string } | null;
  allowResharing: boolean;
  expiresAt: string | null;
  rotationRequired: boolean;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSharedVaultRequest {
  id: string;
  kind: SharedVaultKind;
  allowResharing: boolean;
  /** creator's own grant (sealed to self, signed by self) */
  encryptedVaultKey: string;
  keySignature: string;
}

export interface UpdateVaultRequest {
  allowResharing?: boolean;
}

export interface UserLookupResponse {
  userId: string;
  email: string;
  name: string;
  publicEncryptionKey: string;
  publicSigningKey: string;
  publicKeySignature: string;
}

export interface InviteMemberRequest {
  recipientUserId: string;
  role: Exclude<VaultRole, 'owner'> | 'owner';
  keyVersion: number;
  encryptedVaultKey: string;
  keySignature: string;
  expiresAt?: string | null;
}

export interface VaultMemberDto {
  userId: string;
  email: string;
  name: string;
  role: VaultRole;
  status: MembershipStatus;
  expiresAt: string | null;
  invitedBy: string | null;
  createdAt: string;
  publicEncryptionKey: string;
  publicSigningKey: string;
}

export interface InvitationDto {
  vaultId: string;
  kind: SharedVaultKind | null;
  role: VaultRole;
  invitedBy: { userId: string; email: string; name: string; publicSigningKey: string; publicEncryptionKey: string };
  expiresAt: string | null;
  createdAt: string;
  itemCount: number;
}

export interface UpdateMemberRequest {
  role?: VaultRole;
  expiresAt?: string | null;
}

export interface RotateVaultKeyRequest {
  newKeyVersion: number;
  grants: Array<{ userId: string; encryptedVaultKey: string; keySignature: string | null }>;
  records: Array<{ id: string; baseRevision: number; encryptedKey: string; encryptedPayload?: string }>;
}

// ---------- Records ----------

export type RecordKind = 'item' | 'project';

export interface RecordDto {
  id: string;
  vaultId: string;
  kind: RecordKind;
  revision: number;
  formatVersion: number;
  encryptedKey: string | null;
  encryptedPayload: string | null;
  size: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  /** tombstone: set when permanently deleted; payload is null */
  deletedAt: string | null;
  seq: string;
}

export interface CreateRecordRequest {
  id: string;
  vaultId: string;
  kind: RecordKind;
  formatVersion: number;
  encryptedKey: string;
  encryptedPayload: string;
  mutationId: string;
}

export interface UpdateRecordRequest {
  baseRevision: number;
  formatVersion: number;
  encryptedKey: string;
  encryptedPayload: string;
  /** moving to another vault (requires write access to both) */
  vaultId?: string;
  mutationId: string;
}

export interface DeleteRecordRequest {
  baseRevision: number;
  mutationId: string;
}

export interface RecordVersionDto {
  recordId: string;
  revision: number;
  vaultId: string;
  formatVersion: number;
  encryptedKey: string;
  encryptedPayload: string;
  createdAt: string;
  createdBy: string;
}

export interface RevisionConflictDetails {
  current: RecordDto;
}

// ---------- Sync ----------

export interface SyncResponse {
  /** opaque cursor (stringified bigint sequence) */
  cursor: string;
  hasMore: boolean;
  /** complete list of the caller's current vault memberships (accepted only) */
  vaults: VaultMembershipDto[];
  records: RecordDto[];
  /** vault ids whose full contents the client must (re)load because access was newly granted */
  resyncVaults: string[];
  settingsRevision: number;
  pendingInvitations: number;
  serverTime: string;
}

export interface SettingsDto {
  encryptedSettings: string | null;
  revision: number;
}
export interface UpdateSettingsRequest {
  baseRevision: number;
  encryptedSettings: string;
}

// ---------- Audit ----------

export interface AuditEventDto {
  id: string;
  type: string;
  actorUserId: string | null;
  vaultId: string | null;
  recordId: string | null;
  deviceId: string | null;
  ipPrefix: string | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: 'ok' | 'error';
  version: string;
}

/** Version of the HTTP API (`/api/v1`) this server implements, and the oldest it still serves. */
export const SERVER_API_VERSION = { current: 1, min: 1 } as const;

/** Features a client can rely on; clients refuse servers missing the ones they need. */
export const SERVER_CAPABILITIES = [
  'vault.e2ee.v1',
  'sync.v1',
  'auth.mfa.totp',
  'auth.recovery-codes',
  'sharing.v1',
  'env-files.v1',
  'ssh.v1',
] as const;

/**
 * `GET /api/v1/meta` — public, unauthenticated, no-store. Lets a client check
 * that an address is a compatible PassVault server before any credential is
 * sent. Never exposes configuration beyond these fields.
 */
export interface MetaResponse {
  service: 'passvault';
  version: string;
  api: { current: number; min: number };
  capabilities: string[];
  /** whether new accounts can be created on this server */
  registration: 'open' | 'closed';
}
