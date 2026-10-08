import { sodium } from './sodium.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(s: string): Uint8Array {
  return textEncoder.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return textDecoder.decode(b);
}

/** URL-safe base64 without padding — the only binary encoding used on the wire. */
export function toB64(b: Uint8Array): string {
  const s = sodium();
  return s.to_base64(b, s.base64_variants.URLSAFE_NO_PADDING);
}

export function fromB64(s: string): Uint8Array {
  const so = sodium();
  try {
    return so.from_base64(s, so.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    throw new EncodingError('invalid base64url');
  }
}

export function toHex(b: Uint8Array): string {
  return sodium().to_hex(b);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return sodium().memcmp(a, b);
}

export class EncodingError extends Error {
  override name = 'EncodingError';
}

// RFC 4648 base32 (no padding). Used only for human-transcribed recovery keys.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new EncodingError('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
