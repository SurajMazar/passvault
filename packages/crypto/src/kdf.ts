import { sodium, wipe } from './sodium.js';
import { fromB64, toB64 } from './encoding.js';

/**
 * Master-password key derivation.
 *
 *   masterKey = Argon2id(NFC(password), salt, opsLimit, memLimit) -> 32 bytes
 *   authKey   = crypto_kdf_derive_from_key(32, 1, "PVauthky", masterKey)
 *   wrapKey   = crypto_kdf_derive_from_key(32, 1, "PVwrapky", masterKey)
 *
 * authKey is the login credential sent to the server (which stores only an
 * Argon2id hash of it). wrapKey never leaves the client; it encrypts the
 * account's random User Key. Because both are independent BLAKE2b-derived
 * subkeys, knowing authKey does not reveal wrapKey.
 */
export interface KdfParams {
  algorithm: 'argon2id';
  version: 1;
  opsLimit: number;
  memLimitBytes: number;
  /** 16-byte salt, base64url */
  salt: string;
}

export const KDF_DEFAULTS = { opsLimit: 3, memLimitBytes: 64 * 1024 * 1024 } as const;
export const KDF_LIMITS = {
  minOpsLimit: 2,
  maxOpsLimit: 10,
  minMemLimitBytes: 32 * 1024 * 1024,
  maxMemLimitBytes: 1024 * 1024 * 1024,
} as const;

export function validateKdfParams(p: KdfParams): void {
  if (p.algorithm !== 'argon2id' || p.version !== 1) throw new Error('unsupported KDF');
  if (!Number.isInteger(p.opsLimit) || p.opsLimit < KDF_LIMITS.minOpsLimit || p.opsLimit > KDF_LIMITS.maxOpsLimit) {
    throw new Error('KDF opsLimit out of range');
  }
  if (
    !Number.isInteger(p.memLimitBytes) ||
    p.memLimitBytes < KDF_LIMITS.minMemLimitBytes ||
    p.memLimitBytes > KDF_LIMITS.maxMemLimitBytes
  ) {
    throw new Error('KDF memLimit out of range');
  }
  if (fromB64(p.salt).byteLength !== 16) throw new Error('KDF salt must be 16 bytes');
}

export function newKdfParams(overrides: Partial<Pick<KdfParams, 'opsLimit' | 'memLimitBytes'>> = {}): KdfParams {
  const s = sodium();
  return {
    algorithm: 'argon2id',
    version: 1,
    opsLimit: overrides.opsLimit ?? KDF_DEFAULTS.opsLimit,
    memLimitBytes: overrides.memLimitBytes ?? KDF_DEFAULTS.memLimitBytes,
    salt: toB64(s.randombytes_buf(s.crypto_pwhash_SALTBYTES)),
  };
}

export function normalizePassword(password: string): string {
  return password.normalize('NFC');
}

export function deriveMasterKey(password: string, params: KdfParams): Uint8Array {
  validateKdfParams(params);
  const s = sodium();
  return s.crypto_pwhash(
    32,
    normalizePassword(password),
    fromB64(params.salt),
    params.opsLimit,
    params.memLimitBytes,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export const KDF_CONTEXT = {
  auth: 'PVauthky',
  wrap: 'PVwrapky',
  recoveryWrap: 'PVrcwrap',
  recoveryAuth: 'PVrcauth',
} as const;

export function deriveSubkey(root: Uint8Array, context: string, id = 1): Uint8Array {
  if (context.length !== 8) throw new Error('kdf context must be 8 characters');
  return sodium().crypto_kdf_derive_from_key(32, id, context, root);
}

export interface PasswordKeys {
  /** base64url; sent to the server as the login credential */
  authKey: string;
  /** never leaves the client */
  wrapKey: Uint8Array;
}

export function derivePasswordKeys(password: string, params: KdfParams): PasswordKeys {
  const master = deriveMasterKey(password, params);
  try {
    const auth = deriveSubkey(master, KDF_CONTEXT.auth);
    const authKey = toB64(auth);
    wipe(auth);
    return { authKey, wrapKey: deriveSubkey(master, KDF_CONTEXT.wrap) };
  } finally {
    wipe(master);
  }
}
