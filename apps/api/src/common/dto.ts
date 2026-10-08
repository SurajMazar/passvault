import type { Device, Record as DbRecord, RecordVersion, Session, User, Vault, VaultMember } from '@prisma/client';
import type * as T from '@passvault/types';
import { iso } from './util';

export function kdfDto(u: User): T.KdfParamsDto {
  return {
    algorithm: 'argon2id',
    version: 1,
    opsLimit: u.kdfOpsLimit,
    memLimitBytes: u.kdfMemLimitBytes,
    salt: u.kdfSalt,
  };
}

export function userDto(u: User, mfaEnabled: boolean): T.UserDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    emailVerified: u.emailVerifiedAt !== null,
    mfaEnabled,
    createdAt: u.createdAt.toISOString(),
  };
}

export function accountKeysDto(u: User): T.AccountKeysDto {
  return {
    encryptedUserKey: u.encryptedUserKey,
    publicEncryptionKey: u.publicEncryptionKey,
    encryptedPrivateEncryptionKey: u.encryptedPrivateEncryptionKey,
    publicSigningKey: u.publicSigningKey,
    encryptedPrivateSigningKey: u.encryptedPrivateSigningKey,
    publicKeySignature: u.publicKeySignature,
  };
}

export function accountBundle(u: User, mfaEnabled: boolean): T.AccountBundle {
  return {
    user: userDto(u, mfaEnabled),
    kdf: kdfDto(u),
    keys: accountKeysDto(u),
    personalVaultId: u.personalVaultId!,
    settings: { encryptedSettings: u.encryptedSettings, revision: u.settingsRevision },
  };
}

export function recordDto(r: DbRecord): T.RecordDto {
  return {
    id: r.id,
    vaultId: r.vaultId,
    kind: r.kind,
    revision: r.revision,
    formatVersion: r.formatVersion,
    encryptedKey: r.encryptedKey,
    encryptedPayload: r.encryptedPayload,
    size: r.size,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    createdBy: r.createdById,
    updatedBy: r.updatedById,
    deletedAt: iso(r.deletedAt),
    seq: r.seq.toString(),
  };
}

export function recordVersionDto(v: RecordVersion): T.RecordVersionDto {
  return {
    recordId: v.recordId,
    revision: v.revision,
    vaultId: v.vaultId,
    formatVersion: v.formatVersion,
    encryptedKey: v.encryptedKey,
    encryptedPayload: v.encryptedPayload,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdById,
  };
}

export type MembershipRow = VaultMember & { vault: Vault; grantedBy: User | null };

export function membershipDto(m: MembershipRow, memberCount: number): T.VaultMembershipDto {
  return {
    vaultId: m.vaultId,
    type: m.vault.type,
    kind: m.vault.kind,
    role: m.role,
    status: m.status,
    keyVersion: m.keyVersion,
    encryptedVaultKey: m.encryptedVaultKey,
    keySignature: m.keySignature,
    grantedBy: m.grantedBy
      ? { userId: m.grantedBy.id, email: m.grantedBy.email, publicSigningKey: m.grantedBy.publicSigningKey }
      : null,
    allowResharing: m.vault.allowResharing,
    expiresAt: iso(m.expiresAt),
    rotationRequired: m.vault.rotationRequired,
    memberCount,
    createdAt: m.createdAt.toISOString(),
    updatedAt: (m.updatedAt > m.vault.updatedAt ? m.updatedAt : m.vault.updatedAt).toISOString(),
  };
}

export function memberDto(m: VaultMember & { user: User }): T.VaultMemberDto {
  return {
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    role: m.role,
    status: m.status,
    expiresAt: iso(m.expiresAt),
    invitedBy: m.grantedById,
    createdAt: m.createdAt.toISOString(),
    publicEncryptionKey: m.user.publicEncryptionKey,
    publicSigningKey: m.user.publicSigningKey,
  };
}

export function sessionDto(token: string, s: Session, idleMinutes: number): T.SessionDto {
  return {
    token,
    sessionId: s.id,
    expiresAt: s.expiresAt.toISOString(),
    idleTimeoutSeconds: idleMinutes * 60,
  };
}

export function deviceTrusted(d: Device, u: User, now = new Date()): boolean {
  return Boolean(d.trustedTokenHash && d.trustedUntil && d.trustedUntil > now && d.trustedStamp === u.securityStamp);
}
