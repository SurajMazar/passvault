import { z } from 'zod';

/** base64url without padding */
export const b64url = (max = 4096) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');

/** 32-byte key encoded as base64url (43 chars) */
export const key32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'must be a 32-byte base64url key');

export const envelope = (max = 8192) => b64url(max);
/** Encrypted record payloads (env files can be large). ~1.5 MiB plaintext. */
export const MAX_PAYLOAD_CHARS = 2_100_000;
export const payloadEnvelope = envelope(MAX_PAYLOAD_CHARS);

export const uuid = z.uuid();
export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email());

export const isoDateTime = z.iso.datetime({ offset: true });
export const totpCode = z.string().regex(/^\d{6}$/, 'must be a 6-digit code');
/** Recovery codes: 4 groups of 5 base32 chars, dashes optional */
export const recoveryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z2-7]{5}-?[A-Z2-7]{5}-?[A-Z2-7]{5}-?[A-Z2-7]{5}$/, 'invalid recovery code format');

export const kdfParams = z.strictObject({
  algorithm: z.literal('argon2id'),
  version: z.literal(1),
  opsLimit: z.int().min(2).max(10),
  memLimitBytes: z
    .int()
    .min(32 * 1024 * 1024)
    .max(1024 * 1024 * 1024),
  salt: z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'salt must be 16 bytes base64url'),
});

export const clientType = z.enum(['web', 'extension', 'desktop', 'cli']);
export const deviceInfo = z.strictObject({
  id: uuid,
  name: z.string().trim().min(1).max(100),
  clientType,
});

export const cursorParam = z
  .string()
  .regex(/^\d{1,19}$/)
  .optional();
export const limitParam = z.coerce.number().int().min(1).max(1000).optional();
