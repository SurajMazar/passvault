import { sodium, wipe } from './sodium.js';
import { concatBytes, fromB64, fromUtf8, toB64, utf8 } from './encoding.js';

/**
 * Envelope wire format (all binary, then base64url without padding):
 *
 *   byte 0      format version (currently 0x01)
 *   byte 1      algorithm id
 *   bytes 2..   algorithm-specific body
 *
 * ALG_XCHACHA20POLY1305 (0x01): body = nonce(24) || ciphertext || tag(16)
 *   AEAD = XChaCha20-Poly1305-IETF (libsodium). Nonces are 192-bit random,
 *   which is safe to generate randomly for the lifetime of any key.
 *   Associated data = header(2 bytes) || utf8(context). The context string
 *   binds a ciphertext to where it is used (e.g. a specific item id), so the
 *   server cannot swap ciphertexts between records undetected.
 *
 * ALG_X25519_SEALED (0x02): body = crypto_box_seal output
 *   (ephemeral X25519 public key || XSalsa20-Poly1305 box). Sealed boxes have
 *   no associated data, so callers put binding context inside the plaintext
 *   and authenticate the sender with a separate Ed25519 signature.
 */
export const ENVELOPE_VERSION = 0x01;
export const ALG_XCHACHA20POLY1305 = 0x01;
export const ALG_X25519_SEALED = 0x02;

export type EnvelopeAlgorithm = typeof ALG_XCHACHA20POLY1305 | typeof ALG_X25519_SEALED;

export class DecryptionError extends Error {
  override name = 'DecryptionError';
  constructor(message = 'decryption failed: ciphertext was modified, the key is wrong, or the context does not match') {
    super(message);
  }
}

export class UnsupportedFormatError extends Error {
  override name = 'UnsupportedFormatError';
}

export interface EnvelopeHeader {
  version: number;
  algorithm: number;
}

export function readEnvelopeHeader(envelope: string): EnvelopeHeader {
  const raw = fromB64(envelope);
  if (raw.byteLength < 2) throw new UnsupportedFormatError('envelope too short');
  return { version: raw[0]!, algorithm: raw[1]! };
}

function aad(header: Uint8Array, context: string): Uint8Array {
  return concatBytes(header, utf8(context));
}

export function encryptBytes(key: Uint8Array, plaintext: Uint8Array, context: string): string {
  const s = sodium();
  if (key.byteLength !== s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) throw new Error('invalid key length');
  const header = new Uint8Array([ENVELOPE_VERSION, ALG_XCHACHA20POLY1305]);
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad(header, context), null, nonce, key);
  return toB64(concatBytes(header, nonce, ct));
}

export function decryptBytes(key: Uint8Array, envelope: string, context: string): Uint8Array {
  const s = sodium();
  let raw: Uint8Array;
  try {
    raw = fromB64(envelope);
  } catch {
    throw new DecryptionError('malformed envelope');
  }
  const nonceLen = s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (raw.byteLength < 2 + nonceLen + s.crypto_aead_xchacha20poly1305_ietf_ABYTES) {
    throw new DecryptionError('malformed envelope');
  }
  if (raw[0] !== ENVELOPE_VERSION) throw new UnsupportedFormatError(`unsupported envelope version ${raw[0]}`);
  if (raw[1] !== ALG_XCHACHA20POLY1305) throw new UnsupportedFormatError(`unexpected algorithm ${raw[1]}`);
  const header = raw.subarray(0, 2);
  const nonce = raw.subarray(2, 2 + nonceLen);
  const ct = raw.subarray(2 + nonceLen);
  try {
    return s.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad(header, context), nonce, key);
  } catch {
    throw new DecryptionError();
  }
}

/**
 * JSON payloads are padded (ISO/IEC 7816-4 via libsodium sodium_pad) to a
 * block size before encryption so the server learns only a coarse size.
 */
export const PAYLOAD_PAD_BLOCK = 128;

export function encryptJson(key: Uint8Array, value: unknown, context: string, padBlock = PAYLOAD_PAD_BLOCK): string {
  const s = sodium();
  const plain = utf8(JSON.stringify(value));
  const padded = s.pad(plain, padBlock);
  try {
    return encryptBytes(key, padded, context);
  } finally {
    wipe(plain, padded);
  }
}

export function decryptJson<T = unknown>(key: Uint8Array, envelope: string, context: string, padBlock = PAYLOAD_PAD_BLOCK): T {
  const s = sodium();
  const padded = decryptBytes(key, envelope, context);
  let plain: Uint8Array;
  try {
    plain = s.unpad(padded, padBlock);
  } catch {
    wipe(padded);
    throw new DecryptionError('invalid padding');
  }
  try {
    return JSON.parse(fromUtf8(plain)) as T;
  } finally {
    wipe(padded);
  }
}

export function sealTo(recipientPublicKey: Uint8Array, plaintext: Uint8Array): string {
  const s = sodium();
  const sealed = s.crypto_box_seal(plaintext, recipientPublicKey);
  return toB64(concatBytes(new Uint8Array([ENVELOPE_VERSION, ALG_X25519_SEALED]), sealed));
}

export function openSealed(publicKey: Uint8Array, privateKey: Uint8Array, envelope: string): Uint8Array {
  const s = sodium();
  let raw: Uint8Array;
  try {
    raw = fromB64(envelope);
  } catch {
    throw new DecryptionError('malformed envelope');
  }
  if (raw.byteLength < 2 + s.crypto_box_SEALBYTES) throw new DecryptionError('malformed envelope');
  if (raw[0] !== ENVELOPE_VERSION) throw new UnsupportedFormatError(`unsupported envelope version ${raw[0]}`);
  if (raw[1] !== ALG_X25519_SEALED) throw new UnsupportedFormatError(`unexpected algorithm ${raw[1]}`);
  try {
    return s.crypto_box_seal_open(raw.subarray(2), publicKey, privateKey);
  } catch {
    throw new DecryptionError();
  }
}

export function randomKey(): Uint8Array {
  const s = sodium();
  return s.crypto_aead_xchacha20poly1305_ietf_keygen();
}

export function randomBytes(n: number): Uint8Array {
  return sodium().randombytes_buf(n);
}

/** BLAKE2b-256 digest, used for fingerprints and signature transcripts (not for passwords). */
export function hash256(data: Uint8Array): Uint8Array {
  return sodium().crypto_generichash(32, data, null);
}
