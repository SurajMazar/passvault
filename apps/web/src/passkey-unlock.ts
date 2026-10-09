import type { BiometricUnlockAdapter } from '@passvault/vault-core';

/**
 * Fingerprint unlock for the web dashboard: a passkey on this device (Touch ID,
 * Windows Hello, …) with the WebAuthn PRF extension.
 *
 *   turn on: create a platform passkey for this site (user verification
 *            required) and ask it for a PRF secret over a random salt; HKDF of
 *            that secret is an AES-256-GCM key that seals vault-core's device
 *            key. Only { credential id, salt, iv, sealed key } are kept, in this
 *            browser's storage.
 *   unlock:  ask the same passkey for the same PRF secret — the authenticator
 *            releases it only after the fingerprint — and open the seal.
 *
 * The secret never leaves the authenticator unverified and is never stored, so
 * the stored record is useless without this device and the user's finger. The
 * master password always works too. Browsers or devices without platform
 * passkeys or PRF report it as unavailable.
 */

interface Store {
  get(k: string): Promise<string | null>;
  set(k: string, v: string): Promise<void>;
  remove(k: string): Promise<void>;
}

interface PasskeyRecord {
  v: 1;
  cred: string;
  salt: string;
  iv: string;
  sealed: string;
}

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } };

const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export function deviceUnlockLabel(): string {
  const ua = navigator.userAgent;
  if (/Mac OS X/.test(ua)) return 'Touch ID';
  if (/Windows/.test(ua)) return 'Windows Hello';
  return 'fingerprint';
}

async function supported(): Promise<{ available: boolean; reason?: string }> {
  if (!window.isSecureContext || !window.PublicKeyCredential) return { available: false, reason: 'this browser does not support passkeys' };
  const uv = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
  if (!uv) return { available: false, reason: 'no fingerprint or face unlock is set up on this device' };
  const caps = await (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities?.().catch(() => null);
  if (caps && caps['extension:prf'] === false) return { available: false, reason: 'this browser cannot use passkeys for encryption (PRF); try Chrome or Safari' };
  return { available: true };
}

async function sealingKey(prf: BufferSource): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('PassVault web passkey unlock v1'), info: enc.encode('device-key seal') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function cancelled(e: unknown): Error {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return new Error(`${deviceUnlockLabel()} was cancelled or did not match`);
  return e instanceof Error ? e : new Error(String(e));
}

/** The PRF secret for `salt` from passkey `credId`, after user verification. */
async function prfSecret(credId: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<BufferSource> {
  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: credId }],
        userVerification: 'required',
        timeout: 60_000,
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw cancelled(e);
  }
  const first = (assertion?.getClientExtensionResults() as { prf?: PrfResults }).prf?.results?.first;
  if (!first) throw new Error('This passkey cannot be used for encryption (no PRF support)');
  return first;
}

export function createPasskeyUnlock(store: Store): BiometricUnlockAdapter {
  const recKey = (accountId: string) => `passkey-unlock-${accountId}`;
  return {
    label: deviceUnlockLabel(),
    description: `Uses a passkey on this device: ${deviceUnlockLabel()} releases a secret that unseals your vault key in this browser. Nothing leaves the device, and your master password always works too.`,
    status: supported,
    async storeKey(accountId, key) {
      const st = await supported();
      if (!st.available) throw new Error(`${deviceUnlockLabel()} unlock is not available: ${st.reason}`);
      const salt = random(32);
      let cred: PublicKeyCredential | null;
      try {
        cred = (await navigator.credentials.create({
          publicKey: {
            rp: { name: 'PassVault', id: location.hostname },
            user: { id: random(16), name: `PassVault unlock (${location.hostname})`, displayName: 'PassVault unlock' },
            challenge: random(32),
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -257 },
            ],
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
            timeout: 60_000,
            extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
          },
        })) as PublicKeyCredential | null;
      } catch (e) {
        throw cancelled(e);
      }
      if (!cred) throw new Error('No passkey was created');
      const prf = (cred.getClientExtensionResults() as { prf?: PrfResults }).prf;
      if (prf && prf.enabled === false) throw new Error('This device’s passkeys cannot be used for encryption (no PRF support)');
      const credId = new Uint8Array(cred.rawId);
      // Some browsers return the secret at creation; others only on the first use.
      const secret = prf?.results?.first ?? (await prfSecret(credId, salt));
      const iv = random(12);
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(accountId) }, await sealingKey(secret), new Uint8Array(key));
      const rec: PasskeyRecord = { v: 1, cred: b64(credId), salt: b64(salt), iv: b64(iv), sealed: b64(sealed) };
      await store.set(recKey(accountId), JSON.stringify(rec));
    },
    async retrieveKey(accountId) {
      const raw = await store.get(recKey(accountId));
      if (!raw) throw new Error(`${deviceUnlockLabel()} unlock is not set up in this browser. Unlock with your master password.`);
      const rec = JSON.parse(raw) as PasskeyRecord;
      const secret = await prfSecret(unb64(rec.cred), unb64(rec.salt));
      try {
        const key = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv), additionalData: enc.encode(accountId) }, await sealingKey(secret), unb64(rec.sealed));
        return new Uint8Array(key);
      } catch {
        throw new Error(`${deviceUnlockLabel()} unlock no longer matches. Unlock with your master password and turn it on again.`);
      }
    },
    async removeKey(accountId) {
      await store.remove(recKey(accountId));
    },
  };
}
