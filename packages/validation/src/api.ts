import { z } from 'zod';
import type * as T from '@passvault/types';
import {
  b64url,
  clientType as _clientType,
  cursorParam,
  deviceInfo,
  email,
  envelope,
  isoDateTime,
  kdfParams,
  key32,
  limitParam,
  payloadEnvelope,
  recoveryCode,
  totpCode,
  uuid,
} from './common';

void _clientType;

export const preloginRequest = z.strictObject({ email }) satisfies z.ZodType<T.PreloginRequest>;

const accountKeys = z.strictObject({
  encryptedUserKey: envelope(),
  publicEncryptionKey: key32,
  encryptedPrivateEncryptionKey: envelope(),
  publicSigningKey: key32,
  encryptedPrivateSigningKey: envelope(),
  publicKeySignature: b64url(128),
});

export const registerStartRequest = z.strictObject({ email }) satisfies z.ZodType<T.RegisterStartRequest>;
export const registerVerifyRequest = z.strictObject({
  email,
  code: z.string().regex(/^\d{6}$/, 'must be the 6-digit code from the email'),
}) satisfies z.ZodType<T.RegisterVerifyRequest>;

export const registerRequest = z.strictObject({
  registrationToken: b64url(128),
  email,
  name: z.string().trim().min(1).max(100),
  kdf: kdfParams,
  authKey: key32,
  keys: accountKeys.extend({
    encryptedUserKeyByRecovery: envelope(),
    recoveryAuthKey: key32,
  }),
  personalVault: z.strictObject({ id: uuid, encryptedVaultKey: envelope() }),
}) satisfies z.ZodType<T.RegisterRequest>;


export const loginRequest = z.strictObject({
  email,
  authKey: key32,
  device: deviceInfo,
  trustedDeviceToken: b64url(128).optional(),
}) satisfies z.ZodType<T.LoginRequest>;

export const mfaEnrollStartRequest = z.strictObject({ mfaToken: b64url(128).optional() }) satisfies z.ZodType<T.MfaEnrollStartRequest>;
export const mfaEnrollConfirmRequest = z.strictObject({
  mfaToken: b64url(128).optional(),
  code: totpCode,
}) satisfies z.ZodType<T.MfaEnrollConfirmRequest>;

export const mfaVerifyRequest = z
  .strictObject({
    mfaToken: b64url(128),
    code: totpCode.optional(),
    recoveryCode: recoveryCode.optional(),
    trustDevice: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'provide exactly one of code or recoveryCode',
  }) satisfies z.ZodType<T.MfaVerifyRequest>;

export const reauthRequest = z.strictObject({ authKey: key32, code: totpCode }) satisfies z.ZodType<T.ReauthRequest>;

export const changePasswordRequest = z.strictObject({
  kdf: kdfParams,
  authKey: key32,
  encryptedUserKey: envelope(),
  signOutOtherSessions: z.boolean(),
  rotation: z
    .strictObject({
      encryptedPrivateEncryptionKey: envelope(),
      encryptedPrivateSigningKey: envelope(),
      encryptedUserKeyByRecovery: envelope(),
      recoveryAuthKey: key32,
      personalVault: z.strictObject({ id: uuid, encryptedVaultKey: envelope() }),
      encryptedSettings: payloadEnvelope.nullable(),
    })
    .optional(),
}) satisfies z.ZodType<T.ChangePasswordRequest>;

export const recoveryStartRequest = z.strictObject({ email }) satisfies z.ZodType<T.RecoveryStartRequest>;
export const recoveryVerifyRequest = z
  .strictObject({
    token: b64url(128),
    code: totpCode.optional(),
    recoveryCode: recoveryCode.optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), {
    message: 'provide exactly one of code or recoveryCode',
  }) satisfies z.ZodType<T.RecoveryVerifyRequest>;

export const recoveryCompleteVaultRequest = z.strictObject({
  recoveryToken: b64url(128),
  recoveryAuthKey: key32,
  kdf: kdfParams,
  authKey: key32,
  encryptedUserKey: envelope(),
  newEncryptedUserKeyByRecovery: envelope(),
  newRecoveryAuthKey: key32,
}) satisfies z.ZodType<T.RecoveryCompleteVaultRequest>;

export const recoveryResetAccountRequest = z.strictObject({
  recoveryToken: b64url(128),
  confirmation: z.literal('DELETE MY VAULT DATA'),
  kdf: kdfParams,
  authKey: key32,
  keys: registerRequest.shape.keys,
  personalVault: registerRequest.shape.personalVault,
}) satisfies z.ZodType<T.RecoveryResetAccountRequest>;

// ---------- Vaults ----------

const vaultRole = z.enum(['owner', 'editor', 'viewer']);

export const createSharedVaultRequest = z.strictObject({
  id: uuid,
  kind: z.enum(['item', 'project']),
  allowResharing: z.boolean(),
  encryptedVaultKey: envelope(),
  keySignature: b64url(128),
}) satisfies z.ZodType<T.CreateSharedVaultRequest>;

export const updateVaultRequest = z.strictObject({ allowResharing: z.boolean().optional() }) satisfies z.ZodType<T.UpdateVaultRequest>;

export const userLookupQuery = z.strictObject({ email });

export const inviteMemberRequest = z.strictObject({
  recipientUserId: uuid,
  role: vaultRole,
  keyVersion: z.int().min(1),
  encryptedVaultKey: envelope(),
  keySignature: b64url(128),
  expiresAt: isoDateTime.nullable().optional(),
}) satisfies z.ZodType<T.InviteMemberRequest>;

export const updateMemberRequest = z.strictObject({
  role: vaultRole.optional(),
  expiresAt: isoDateTime.nullable().optional(),
}) satisfies z.ZodType<T.UpdateMemberRequest>;

export const rotateVaultKeyRequest = z.strictObject({
  newKeyVersion: z.int().min(2),
  grants: z
    .array(z.strictObject({ userId: uuid, encryptedVaultKey: envelope(), keySignature: b64url(128).nullable() }))
    .min(1)
    .max(500),
  records: z
    .array(
      z.strictObject({
        id: uuid,
        baseRevision: z.int().min(1),
        encryptedKey: envelope(),
        encryptedPayload: payloadEnvelope.optional(),
      }),
    )
    .max(5000),
}) satisfies z.ZodType<T.RotateVaultKeyRequest>;

// ---------- Records ----------

const recordKind = z.enum(['item', 'project']);

export const createRecordRequest = z.strictObject({
  id: uuid,
  vaultId: uuid,
  kind: recordKind,
  formatVersion: z.int().min(1).max(1000),
  encryptedKey: envelope(),
  encryptedPayload: payloadEnvelope,
  mutationId: uuid,
}) satisfies z.ZodType<T.CreateRecordRequest>;

export const updateRecordRequest = z.strictObject({
  baseRevision: z.int().min(1),
  formatVersion: z.int().min(1).max(1000),
  encryptedKey: envelope(),
  encryptedPayload: payloadEnvelope,
  vaultId: uuid.optional(),
  mutationId: uuid,
}) satisfies z.ZodType<T.UpdateRecordRequest>;

export const deleteRecordRequest = z.strictObject({
  baseRevision: z.int().min(1),
  mutationId: uuid,
}) satisfies z.ZodType<T.DeleteRecordRequest>;

export const syncQuery = z.strictObject({ cursor: cursorParam, limit: limitParam });
export const pageQuery = z.strictObject({ cursor: cursorParam, limit: limitParam });

export const updateSettingsRequest = z.strictObject({
  baseRevision: z.int().min(0),
  encryptedSettings: payloadEnvelope,
}) satisfies z.ZodType<T.UpdateSettingsRequest>;

export const idParam = z.strictObject({ id: uuid });
