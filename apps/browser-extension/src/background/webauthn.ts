import type { StoredPasskey } from '@passvault/types';

/**
 * PassVault as a WebAuthn authenticator: ES256 (P-256) passkeys kept in the vault.
 *
 *  - registration: a new key pair, "none" attestation, authenticator data with the
 *    attested credential (COSE public key);
 *  - sign-in: authenticator data + SHA-256(clientDataJSON), signed with the stored key
 *    (WebCrypto gives r||s; WebAuthn wants DER).
 *
 * clientDataJSON is built here from the origin the browser reported for the calling
 * tab — never from anything the page supplies. Flags: user present + verified (the
 * vault was unlocked and the user approved in PassVault's own window), backup
 * eligible + backed up (passkeys sync). The signature counter stays 0 ("not
 * supported"), as for other synced passkeys.
 */

// ------------------------------------------------------------------ encoding helpers

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));

/** Minimal canonical CBOR for what WebAuthn needs: ints, byte/text strings, maps. */
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;
function cborHead(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
  if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
  return Uint8Array.of((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}
export function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') {
    const b = new TextEncoder().encode(v);
    return concat(cborHead(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(cborHead(2, v.length), v);
  const entries = [...v.entries()];
  return concat(cborHead(5, entries.length), ...entries.flatMap(([k, val]) => [cbor(k), cbor(val)]));
}

/** WebCrypto ECDSA r||s (64 bytes) → ASN.1 DER SEQUENCE { INTEGER r, INTEGER s }. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let x = b.slice(i);
    if (x[0]! & 0x80) x = concat(Uint8Array.of(0), x);
    return concat(Uint8Array.of(0x02, x.length), x);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32, 64)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

// ------------------------------------------------------------------ authenticator

/** All-zero AAGUID: PassVault makes no attestation claims ("none"). */
const AAGUID = new Uint8Array(16);
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

async function authenticatorData(rpId: string, flags: number, attested?: Uint8Array): Promise<Uint8Array> {
  const counter = new Uint8Array(4); // 0: synced passkeys report no counter
  return concat(await sha256(new TextEncoder().encode(rpId)), Uint8Array.of(flags), counter, attested ?? new Uint8Array());
}

export function clientDataJSON(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): Uint8Array {
  // Field order and spelling follow the WebAuthn serialization browsers use.
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

export interface RegistrationResult {
  passkey: StoredPasskey;
  credentialId: string;
  clientDataJSON: string;
  attestationObject: string;
  authenticatorData: string;
  /** SubjectPublicKeyInfo, for AuthenticatorAttestationResponse.getPublicKey() */
  publicKey: string;
}

export async function createPasskey(o: {
  rpId: string;
  rpName: string;
  origin: string;
  challenge: string;
  user: { id: string; name: string; displayName: string };
}): Promise<RegistrationResult> {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const cose = cbor(
    new Map<number, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, unb64url(jwk.x!)],
      [-3, unb64url(jwk.y!)],
    ]),
  );
  const attested = concat(AAGUID, Uint8Array.of(credId.length >> 8, credId.length & 0xff), credId, cose);
  const authData = await authenticatorData(o.rpId, FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT, attested);
  const attestationObject = cbor(
    new Map<string, Cbor>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]),
  );
  const credentialId = b64url(credId);
  return {
    passkey: {
      credentialId,
      rpId: o.rpId,
      rpName: o.rpName.slice(0, 200),
      userHandle: o.user.id,
      userName: o.user.name.slice(0, 500),
      userDisplayName: o.user.displayName.slice(0, 500),
      alg: -7,
      privateKey: b64url(pkcs8),
      createdAt: new Date().toISOString(),
    },
    credentialId,
    clientDataJSON: b64url(clientDataJSON('webauthn.create', o.challenge, o.origin)),
    attestationObject: b64url(attestationObject),
    authenticatorData: b64url(authData),
    publicKey: b64url(spki),
  };
}

export interface AssertionResult {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle: string;
}

export async function signAssertion(pk: StoredPasskey, o: { origin: string; challenge: string }): Promise<AssertionResult> {
  const key = await crypto.subtle.importKey('pkcs8', unb64url(pk.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const authData = await authenticatorData(pk.rpId, FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS);
  const cdj = clientDataJSON('webauthn.get', o.challenge, o.origin);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, concat(authData, await sha256(cdj)) as Uint8Array<ArrayBuffer>));
  return { credentialId: pk.credentialId, clientDataJSON: b64url(cdj), authenticatorData: b64url(authData), signature: b64url(rawToDer(raw)), userHandle: pk.userHandle };
}
