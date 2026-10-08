import { sodium, wipe } from './sodium.js';
import { concatBytes, fromB64, fromBase32, toB64, toBase32, utf8, constantTimeEqual } from './encoding.js';
import { decryptBytes, encryptBytes, hash256, randomKey, DecryptionError } from './envelope.js';
import { KDF_CONTEXT, KdfParams, derivePasswordKeys, deriveSubkey, newKdfParams } from './kdf.js';

/**
 * Account key hierarchy (see docs/CRYPTO.md):
 *
 *   password --Argon2id--> masterKey --kdf--> authKey (server login credential)
 *                                      \-kdf--> wrapKey --AEAD--> User Key (UK, random 32B)
 *   recoveryKey (random 32B, shown once) --kdf--> recoveryWrapKey --AEAD--> UK
 *                                         \-kdf--> recoveryAuthKey (server proof of possession)
 *   UK --AEAD--> X25519 private key (receives shared vault keys)
 *   UK --AEAD--> Ed25519 private key (signs key grants)
 *   UK --AEAD--> personal Vault Key --AEAD--> per-item keys --AEAD--> item payloads
 */
export const CTX = {
  userKey: 'pv:user-key:v1',
  userKeyRecovery: 'pv:user-key:recovery:v1',
  privateEncryptionKey: 'pv:private-key:x25519:v1',
  privateSigningKey: 'pv:private-key:ed25519:v1',
  settings: 'pv:settings:v1',
  deviceUnlock: (deviceId: string) => `pv:device-unlock:v1:${deviceId}`,
} as const;

export interface AccountKeyBundle {
  encryptedUserKey: string;
  encryptedUserKeyByRecovery: string;
  /** base64url; server stores only a hash */
  recoveryAuthKey: string;
  publicEncryptionKey: string;
  encryptedPrivateEncryptionKey: string;
  publicSigningKey: string;
  encryptedPrivateSigningKey: string;
  /** Ed25519 signature binding the encryption public key to the signing identity */
  publicKeySignature: string;
}

export interface UnlockedAccountKeys {
  userKey: Uint8Array;
  encryptionKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
  signingKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
}

export interface RegistrationMaterial {
  kdf: KdfParams;
  authKey: string;
  keys: AccountKeyBundle;
  /** Human-readable recovery key; display once, never send to the server. */
  recoveryKey: string;
  unlocked: UnlockedAccountKeys;
}

const RECOVERY_KEY_BYTES = 32;
const RECOVERY_CHECKSUM_BYTES = 2;

export function formatRecoveryKey(raw: Uint8Array): string {
  const checksum = hash256(raw).subarray(0, RECOVERY_CHECKSUM_BYTES);
  const b32 = toBase32(concatBytes(raw, checksum));
  return b32.match(/.{1,5}/g)!.join('-');
}

export class InvalidRecoveryKeyError extends Error {
  override name = 'InvalidRecoveryKeyError';
}

export function parseRecoveryKey(formatted: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromBase32(formatted);
  } catch {
    throw new InvalidRecoveryKeyError('recovery key contains invalid characters');
  }
  if (bytes.byteLength !== RECOVERY_KEY_BYTES + RECOVERY_CHECKSUM_BYTES) {
    throw new InvalidRecoveryKeyError('recovery key has the wrong length');
  }
  const raw = bytes.slice(0, RECOVERY_KEY_BYTES);
  const checksum = bytes.subarray(RECOVERY_KEY_BYTES);
  if (!constantTimeEqual(hash256(raw).subarray(0, RECOVERY_CHECKSUM_BYTES), checksum)) {
    throw new InvalidRecoveryKeyError('recovery key checksum mismatch — check for typos');
  }
  return raw;
}

export function deriveRecoveryKeys(recoveryKey: string): { wrapKey: Uint8Array; authKey: string } {
  const raw = parseRecoveryKey(recoveryKey);
  try {
    const auth = deriveSubkey(raw, KDF_CONTEXT.recoveryAuth);
    const authKey = toB64(auth);
    wipe(auth);
    return { wrapKey: deriveSubkey(raw, KDF_CONTEXT.recoveryWrap), authKey };
  } finally {
    wipe(raw);
  }
}

function publicKeySignatureMessage(publicEncryptionKey: string): Uint8Array {
  return utf8(`pv:public-keys:v1\n${publicEncryptionKey}`);
}

export function generateRecoveryKey(): string {
  const raw = sodium().randombytes_buf(RECOVERY_KEY_BYTES);
  try {
    return formatRecoveryKey(raw);
  } finally {
    wipe(raw);
  }
}

/** Wrap the User Key with a (new) recovery key. */
export function wrapUserKeyForRecovery(userKey: Uint8Array, recoveryKey: string) {
  const r = deriveRecoveryKeys(recoveryKey);
  try {
    return {
      encryptedUserKeyByRecovery: encryptBytes(r.wrapKey, userKey, CTX.userKeyRecovery),
      recoveryAuthKey: r.authKey,
    };
  } finally {
    wipe(r.wrapKey);
  }
}

function sealAccountKeys(userKey: Uint8Array, recoveryKey: string): { keys: AccountKeyBundle; unlocked: UnlockedAccountKeys } {
  const s = sodium();
  const enc = s.crypto_box_keypair();
  const sig = s.crypto_sign_keypair();
  const publicEncryptionKey = toB64(enc.publicKey);
  const rec = wrapUserKeyForRecovery(userKey, recoveryKey);
  const keys: AccountKeyBundle = {
    encryptedUserKey: '', // filled by caller (depends on password)
    encryptedUserKeyByRecovery: rec.encryptedUserKeyByRecovery,
    recoveryAuthKey: rec.recoveryAuthKey,
    publicEncryptionKey,
    encryptedPrivateEncryptionKey: encryptBytes(userKey, enc.privateKey, CTX.privateEncryptionKey),
    publicSigningKey: toB64(sig.publicKey),
    encryptedPrivateSigningKey: encryptBytes(userKey, sig.privateKey, CTX.privateSigningKey),
    publicKeySignature: toB64(s.crypto_sign_detached(publicKeySignatureMessage(publicEncryptionKey), sig.privateKey)),
  };
  return {
    keys,
    unlocked: {
      userKey,
      encryptionKeyPair: { publicKey: enc.publicKey, privateKey: enc.privateKey },
      signingKeyPair: { publicKey: sig.publicKey, privateKey: sig.privateKey },
    },
  };
}

export function createRegistrationMaterial(
  password: string,
  kdfOverrides: Partial<Pick<KdfParams, 'opsLimit' | 'memLimitBytes'>> = {},
): RegistrationMaterial {
  const kdf = newKdfParams(kdfOverrides);
  const pk = derivePasswordKeys(password, kdf);
  const userKey = randomKey();
  const recoveryKey = generateRecoveryKey();
  const { keys, unlocked } = sealAccountKeys(userKey, recoveryKey);
  keys.encryptedUserKey = encryptBytes(pk.wrapKey, userKey, CTX.userKey);
  wipe(pk.wrapKey);
  return { kdf, authKey: pk.authKey, keys, recoveryKey, unlocked };
}

export interface EncryptedAccountKeys {
  encryptedUserKey: string;
  publicEncryptionKey: string;
  encryptedPrivateEncryptionKey: string;
  publicSigningKey: string;
  encryptedPrivateSigningKey: string;
  publicKeySignature: string;
}

/** Decrypt the asymmetric key pairs once the User Key is available. */
export function openAccountKeys(userKey: Uint8Array, keys: Omit<EncryptedAccountKeys, 'encryptedUserKey'>): UnlockedAccountKeys {
  const s = sodium();
  const encPriv = decryptBytes(userKey, keys.encryptedPrivateEncryptionKey, CTX.privateEncryptionKey);
  const sigPriv = decryptBytes(userKey, keys.encryptedPrivateSigningKey, CTX.privateSigningKey);
  const encPub = fromB64(keys.publicEncryptionKey);
  const sigPub = fromB64(keys.publicSigningKey);
  // Sanity checks: the decrypted private keys must match the published public keys.
  if (!constantTimeEqual(s.crypto_scalarmult_base(encPriv), encPub)) {
    throw new DecryptionError('encryption key pair mismatch');
  }
  if (!constantTimeEqual(s.crypto_sign_ed25519_sk_to_pk(sigPriv), sigPub)) {
    throw new DecryptionError('signing key pair mismatch');
  }
  if (!verifyPublicKeySignature(keys.publicEncryptionKey, keys.publicSigningKey, keys.publicKeySignature)) {
    throw new DecryptionError('public key signature invalid');
  }
  return {
    userKey,
    encryptionKeyPair: { publicKey: encPub, privateKey: encPriv },
    signingKeyPair: { publicKey: sigPub, privateKey: sigPriv },
  };
}

export function verifyPublicKeySignature(publicEncryptionKey: string, publicSigningKey: string, signature: string): boolean {
  try {
    return sodium().crypto_sign_verify_detached(
      fromB64(signature),
      publicKeySignatureMessage(publicEncryptionKey),
      fromB64(publicSigningKey),
    );
  } catch {
    return false;
  }
}

export class WrongPasswordError extends Error {
  override name = 'WrongPasswordError';
  constructor() {
    super('master password is incorrect');
  }
}

/** Derive login credential only (no vault material). */
export function deriveLogin(password: string, kdf: KdfParams): { authKey: string; wrapKey: Uint8Array } {
  return derivePasswordKeys(password, kdf);
}

/** Vault unlock: decrypt the User Key with the password-derived wrap key, entirely on the client. */
export function unlockWithPassword(password: string, kdf: KdfParams, keys: EncryptedAccountKeys): UnlockedAccountKeys {
  const { wrapKey } = derivePasswordKeys(password, kdf);
  return unlockWithWrapKey(wrapKey, keys);
}

export function unlockWithWrapKey(wrapKey: Uint8Array, keys: EncryptedAccountKeys): UnlockedAccountKeys {
  let userKey: Uint8Array;
  try {
    userKey = decryptBytes(wrapKey, keys.encryptedUserKey, CTX.userKey);
  } catch (e) {
    if (e instanceof DecryptionError) throw new WrongPasswordError();
    throw e;
  } finally {
    wipe(wrapKey);
  }
  return openAccountKeys(userKey, keys);
}

export function unlockWithRecoveryKey(
  recoveryKey: string,
  encryptedUserKeyByRecovery: string,
  keys: Omit<EncryptedAccountKeys, 'encryptedUserKey'>,
): UnlockedAccountKeys {
  const r = deriveRecoveryKeys(recoveryKey);
  let userKey: Uint8Array;
  try {
    userKey = decryptBytes(r.wrapKey, encryptedUserKeyByRecovery, CTX.userKeyRecovery);
  } catch (e) {
    if (e instanceof DecryptionError) throw new InvalidRecoveryKeyError('recovery key does not match this account');
    throw e;
  } finally {
    wipe(r.wrapKey);
  }
  return openAccountKeys(userKey, keys);
}

/**
 * Changing the master password re-wraps the same User Key under a new
 * password-derived key with a fresh salt. Item ciphertext is untouched.
 * Other devices that cached the old encryptedUserKey can still unlock their
 * offline cache with the OLD password until they sync (documented).
 */
export function rewrapForNewPassword(userKey: Uint8Array, newPassword: string, kdfOverrides: Partial<Pick<KdfParams, 'opsLimit' | 'memLimitBytes'>> = {}) {
  const kdf = newKdfParams(kdfOverrides);
  const pk = derivePasswordKeys(newPassword, kdf);
  try {
    return { kdf, authKey: pk.authKey, encryptedUserKey: encryptBytes(pk.wrapKey, userKey, CTX.userKey) };
  } finally {
    wipe(pk.wrapKey);
  }
}

/**
 * Full User Key rotation: a new UK re-encrypts the private keys and every
 * vault-key wrap that used the old UK (the personal vault). Item keys and
 * payloads are unchanged because they are wrapped by vault keys.
 */
export function rotateUserKey(
  current: UnlockedAccountKeys,
  newPassword: string,
  kdfOverrides: Partial<Pick<KdfParams, 'opsLimit' | 'memLimitBytes'>> = {},
) {
  const newUserKey = randomKey();
  const recoveryKey = generateRecoveryKey();
  const rec = wrapUserKeyForRecovery(newUserKey, recoveryKey);
  const pw = rewrapForNewPassword(newUserKey, newPassword, kdfOverrides);
  return {
    newUserKey,
    recoveryKey,
    kdf: pw.kdf,
    authKey: pw.authKey,
    encryptedUserKey: pw.encryptedUserKey,
    encryptedUserKeyByRecovery: rec.encryptedUserKeyByRecovery,
    recoveryAuthKey: rec.recoveryAuthKey,
    encryptedPrivateEncryptionKey: encryptBytes(newUserKey, current.encryptionKeyPair.privateKey, CTX.privateEncryptionKey),
    encryptedPrivateSigningKey: encryptBytes(newUserKey, current.signingKeyPair.privateKey, CTX.privateSigningKey),
  };
}

/** Human-comparable fingerprint of a user's public identity (signing + encryption keys). */
export function publicKeyFingerprint(publicSigningKey: string, publicEncryptionKey: string): string {
  const digest = hash256(concatBytes(utf8('pv:fingerprint:v1'), fromB64(publicSigningKey), fromB64(publicEncryptionKey)));
  const hex = sodium().to_hex(digest.subarray(0, 16));
  return hex.match(/.{4}/g)!.join(' ');
}

/** Device-bound unlock (e.g. biometric): wrap UK with a random key held in the OS keychain. */
export function wrapUserKeyForDevice(userKey: Uint8Array, deviceId: string) {
  const deviceKey = randomKey();
  return { deviceKey, encryptedUserKeyByDevice: encryptBytes(deviceKey, userKey, CTX.deviceUnlock(deviceId)) };
}

export function unwrapUserKeyWithDeviceKey(deviceKey: Uint8Array, deviceId: string, encrypted: string): Uint8Array {
  return decryptBytes(deviceKey, encrypted, CTX.deviceUnlock(deviceId));
}

export function wipeUnlocked(keys: UnlockedAccountKeys | null | undefined): void {
  if (!keys) return;
  wipe(keys.userKey, keys.encryptionKeyPair.privateKey, keys.signingKeyPair.privateKey);
}
