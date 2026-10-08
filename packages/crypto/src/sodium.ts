import _sodium from 'libsodium-wrappers-sumo';

/**
 * libsodium (sumo build, for Argon2id) is the only cryptographic primitive
 * provider used by PassVault clients. Nothing in this package implements a
 * primitive itself; it composes libsodium's reviewed constructions.
 */
export type Sodium = typeof _sodium;

let readyPromise: Promise<Sodium> | null = null;
let initialized = false;

export function initCrypto(): Promise<Sodium> {
  if (!readyPromise) {
    readyPromise = _sodium.ready.then(() => {
      initialized = true;
      return _sodium;
    });
  }
  return readyPromise;
}

export function sodium(): Sodium {
  if (!initialized) {
    throw new Error('PassVault crypto is not initialized; await initCrypto() first');
  }
  return _sodium;
}

export function isCryptoReady(): boolean {
  return initialized;
}

/**
 * Best-effort zeroing of a key buffer. JavaScript engines may have copied the
 * bytes elsewhere (GC moves, string conversions), so this reduces exposure but
 * cannot guarantee erasure. See docs/CRYPTO.md "Memory limitations".
 */
export function wipe(...buffers: Array<Uint8Array | null | undefined>): void {
  for (const b of buffers) {
    if (b && b.byteLength > 0) {
      try {
        sodium().memzero(b);
      } catch {
        b.fill(0);
      }
    }
  }
}
