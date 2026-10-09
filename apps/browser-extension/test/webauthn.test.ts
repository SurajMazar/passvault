import { describe, expect, it } from 'vitest';
import { isValidRpIdForHost } from '@passvault/vault-core';
import { createPasskey, rawToDer, signAssertion, unb64url } from '../src/background/webauthn';

/** Minimal CBOR reader for the test (what a relying party does on its side). */
function readCbor(b: Uint8Array, at = 0): [unknown, number] {
  const ib = b[at]!;
  const major = ib >> 5;
  const info = ib & 31;
  let n = info;
  let p = at + 1;
  if (info === 24) {
    n = b[p]!;
    p += 1;
  } else if (info === 25) {
    n = (b[p]! << 8) | b[p + 1]!;
    p += 2;
  }
  if (major === 0) return [n, p];
  if (major === 1) return [-1 - n, p];
  if (major === 2) return [b.slice(p, p + n), p + n];
  if (major === 3) return [new TextDecoder().decode(b.slice(p, p + n)), p + n];
  if (major === 5) {
    const m = new Map();
    for (let i = 0; i < n; i++) {
      const [k, p1] = readCbor(b, p);
      const [v, p2] = readCbor(b, p1);
      m.set(k, v);
      p = p2;
    }
    return [m, p];
  }
  throw new Error(`unsupported CBOR major ${major}`);
}

const derToRaw = (der: Uint8Array) => {
  let p = 2;
  const int = () => {
    const len = der[p + 1]!;
    let v = der.slice(p + 2, p + 2 + len);
    p += 2 + len;
    while (v.length > 32) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = int();
  const s = int();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
};

const sha256 = async (d: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', d as Uint8Array<ArrayBuffer>));

describe('PassVault WebAuthn authenticator', () => {
  it('registers a passkey a relying party can parse, and signs verifiable assertions', async () => {
    const reg = await createPasskey({ rpId: 'example.com', rpName: 'Example', origin: 'https://login.example.com', challenge: 'Y2hhbGxlbmdl', user: { id: 'dXNlcg', name: 'alice', displayName: 'Alice' } });

    const cdj = JSON.parse(new TextDecoder().decode(unb64url(reg.clientDataJSON)));
    expect(cdj).toEqual({ type: 'webauthn.create', challenge: 'Y2hhbGxlbmdl', origin: 'https://login.example.com', crossOrigin: false });

    const [att] = readCbor(unb64url(reg.attestationObject)) as [Map<string, unknown>, number];
    expect(att.get('fmt')).toBe('none');
    const authData = att.get('authData') as Uint8Array;
    expect(authData.slice(0, 32)).toEqual(await sha256(new TextEncoder().encode('example.com')));
    expect(authData[32]! & 0x45).toBe(0x45); // UP, UV, AT
    const credLen = (authData[53]! << 8) | authData[54]!;
    expect(Buffer.from(authData.slice(55, 55 + credLen)).toString('base64url')).toBe(reg.credentialId);
    const [cose] = readCbor(authData, 55 + credLen) as [Map<number, unknown>, number];
    expect(cose.get(3)).toBe(-7);

    const pub = await crypto.subtle.importKey('spki', unb64url(reg.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const jwk = await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('spki', unb64url(reg.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']));
    expect(Buffer.from(cose.get(-2) as Uint8Array).toString('base64url')).toBe(jwk.x);

    const a = await signAssertion(reg.passkey, { origin: 'https://login.example.com', challenge: 'bmV4dA' });
    expect(a.userHandle).toBe('dXNlcg');
    const ad = unb64url(a.authenticatorData);
    expect(ad[32]! & 0x40).toBe(0); // no attested data on sign-in
    const signed = new Uint8Array([...ad, ...(await sha256(unb64url(a.clientDataJSON)))]);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, derToRaw(unb64url(a.signature)), signed);
    expect(ok).toBe(true);
  });

  it('encodes ECDSA signatures as DER with sign padding', () => {
    const raw = new Uint8Array(64).fill(0x80);
    const der = rawToDer(raw);
    expect(der[0]).toBe(0x30);
    expect(der[2]).toBe(0x02);
    expect(der[3]).toBe(33); // leading 0x00 because the high bit is set
  });

  it('accepts only the page host or a parent domain as the RP ID', () => {
    expect(isValidRpIdForHost('example.com', 'login.example.com')).toBe(true);
    expect(isValidRpIdForHost('login.example.com', 'login.example.com')).toBe(true);
    expect(isValidRpIdForHost('evil.com', 'login.example.com')).toBe(false);
    expect(isValidRpIdForHost('com', 'example.com')).toBe(false);
    expect(isValidRpIdForHost('github.io', 'alice.github.io')).toBe(false);
    expect(isValidRpIdForHost('ample.com', 'example.com')).toBe(false);
  });
});
