import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/** 32 random bytes, base64url (no padding). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Truncate an IP address to /24 (IPv4) or /48 (IPv6). Never store/log full IPs. */
export function ipPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  let addr = ip.trim();
  if (addr.startsWith('::ffff:') && isIP(addr.slice(7)) === 4) addr = addr.slice(7);
  const v = isIP(addr);
  if (v === 4) {
    const p = addr.split('.');
    return `${p[0]}.${p[1]}.${p[2]}.0/24`;
  }
  if (v === 6) {
    const groups = expandIpv6(addr);
    if (!groups) return null;
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return null;
}

function expandIpv6(addr: string): string[] | null {
  const a = addr.split('%')[0]!;
  const [head, tail] = a.includes('::') ? a.split('::') : [a, undefined];
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail !== undefined ? (tail ? tail.split(':').filter(Boolean) : []) : [];
  const missing = 8 - h.length - t.length;
  if (tail === undefined && h.length !== 8) return null;
  const groups = [...h, ...Array(Math.max(0, missing)).fill('0'), ...t];
  return groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''));
}

/** "alice@example.com" -> "a***@example.com" (for logs only). */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function truncate(value: string | undefined | null, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function iso(d: Date): string;
export function iso(d: Date | null | undefined): string | null;
export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}
