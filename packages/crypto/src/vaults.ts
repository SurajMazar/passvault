import { sodium, wipe } from './sodium.js';
import { fromB64, fromUtf8, toB64, utf8 } from './encoding.js';
import {
  ALG_X25519_SEALED,
  ALG_XCHACHA20POLY1305,
  DecryptionError,
  decryptBytes,
  encryptBytes,
  hash256,
  openSealed,
  randomKey,
  readEnvelopeHeader,
  sealTo,
  UnsupportedFormatError,
} from './envelope.js';
import type { UnlockedAccountKeys } from './account.js';

/**
 * Vault keys.
 *
 * Every vault (a user's personal vault, or a shared vault created for a shared
 * item or project) has a random 32-byte Vault Key. Each member holds the key
 * in a membership "grant":
 *
 *  - personal vault: AEAD(UK, vaultKey, "pv:vault-key:v1:<vaultId>:<keyVersion>")
 *  - shared vault:   crypto_box_seal(recipientX25519, JSON{vaultId, userId, keyVersion, key})
 *                    + Ed25519 signature by the granting member over a transcript
 *                    that includes the envelope hash.
 *
 * The recipient checks that the sealed plaintext names the expected vault,
 * itself, and key version, and verifies the grantor's signature against a
 * public key whose fingerprint the user can verify out-of-band.
 */
export interface VaultGrantPlaintext {
  v: 1;
  vaultId: string;
  userId: string;
  keyVersion: number;
  key: string;
}

export function generateVaultKey(): Uint8Array {
  return randomKey();
}

function personalCtx(vaultId: string, keyVersion: number) {
  return `pv:vault-key:v1:${vaultId}:${keyVersion}`;
}

export function wrapVaultKeyForSelf(userKey: Uint8Array, vaultKey: Uint8Array, vaultId: string, keyVersion: number): string {
  return encryptBytes(userKey, vaultKey, personalCtx(vaultId, keyVersion));
}

function grantTranscript(vaultId: string, recipientUserId: string, keyVersion: number, envelope: string): Uint8Array {
  const envHash = toB64(hash256(utf8(envelope)));
  return utf8(`pv:vault-grant:v1\n${vaultId}\n${recipientUserId}\n${keyVersion}\n${envHash}`);
}

export interface VaultGrant {
  encryptedVaultKey: string;
  keySignature: string;
}

export function grantVaultKey(params: {
  vaultKey: Uint8Array;
  vaultId: string;
  keyVersion: number;
  recipientUserId: string;
  recipientPublicEncryptionKey: string;
  grantor: UnlockedAccountKeys;
}): VaultGrant {
  const s = sodium();
  const pt: VaultGrantPlaintext = {
    v: 1,
    vaultId: params.vaultId,
    userId: params.recipientUserId,
    keyVersion: params.keyVersion,
    key: toB64(params.vaultKey),
  };
  const bytes = utf8(JSON.stringify(pt));
  const envelope = sealTo(fromB64(params.recipientPublicEncryptionKey), bytes);
  wipe(bytes);
  const sig = s.crypto_sign_detached(
    grantTranscript(params.vaultId, params.recipientUserId, params.keyVersion, envelope),
    params.grantor.signingKeyPair.privateKey,
  );
  return { encryptedVaultKey: envelope, keySignature: toB64(sig) };
}

export class GrantVerificationError extends Error {
  override name = 'GrantVerificationError';
}

/**
 * Open a membership grant. For shared vaults, `grantorPublicSigningKey` must
 * be supplied; callers should compare its fingerprint against a pinned value.
 */
export function openVaultGrant(params: {
  encryptedVaultKey: string;
  keySignature?: string | null;
  vaultId: string;
  keyVersion: number;
  myUserId: string;
  me: UnlockedAccountKeys;
  grantorPublicSigningKey?: string | null;
}): Uint8Array {
  const { algorithm } = readEnvelopeHeader(params.encryptedVaultKey);
  if (algorithm === ALG_XCHACHA20POLY1305) {
    return decryptBytes(params.me.userKey, params.encryptedVaultKey, personalCtx(params.vaultId, params.keyVersion));
  }
  if (algorithm !== ALG_X25519_SEALED) throw new UnsupportedFormatError('unknown grant algorithm');
  if (!params.keySignature || !params.grantorPublicSigningKey) {
    throw new GrantVerificationError('shared vault grant is missing its signature');
  }
  const s = sodium();
  const ok = s.crypto_sign_verify_detached(
    fromB64(params.keySignature),
    grantTranscript(params.vaultId, params.myUserId, params.keyVersion, params.encryptedVaultKey),
    fromB64(params.grantorPublicSigningKey),
  );
  if (!ok) throw new GrantVerificationError('vault key grant signature is invalid');
  const plain = openSealed(params.me.encryptionKeyPair.publicKey, params.me.encryptionKeyPair.privateKey, params.encryptedVaultKey);
  let parsed: VaultGrantPlaintext;
  try {
    parsed = JSON.parse(fromUtf8(plain)) as VaultGrantPlaintext;
  } catch {
    throw new DecryptionError('malformed grant');
  } finally {
    wipe(plain);
  }
  if (parsed.v !== 1 || parsed.vaultId !== params.vaultId || parsed.userId !== params.myUserId || parsed.keyVersion !== params.keyVersion) {
    throw new GrantVerificationError('grant does not match this vault, user, or key version');
  }
  const key = fromB64(parsed.key);
  if (key.byteLength !== 32) throw new GrantVerificationError('grant key has wrong length');
  return key;
}
