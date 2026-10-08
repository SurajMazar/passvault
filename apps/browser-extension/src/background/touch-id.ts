import type { BiometricUnlockAdapter } from '@passvault/vault-core';
import type { ChromeLike } from './chrome-api';

/**
 * Touch ID unlock through PassVault for Mac.
 *
 * The extension cannot reach Touch ID itself. The macOS app installs a native
 * messaging host (io.passvault.touchid → pv-touchid in PassVault.app) when the
 * user turns on "Touch ID in the browser extension"; it seals the device
 * unlock key (vault-core's enableBiometrics) to a Secure Enclave key that
 * needs a fresh Touch ID match. Chrome passes our origin to the host, which
 * keeps each extension's secrets separate from the app's and other callers'.
 * The master password always remains the fallback.
 *
 * Needs the optional "nativeMessaging" permission, requested by the popup when
 * the user turns Touch ID on.
 */
import { TOUCH_ID_HOST } from '../shared/constants';
export { TOUCH_ID_HOST };

export const TOUCH_ID_SETUP_HINT =
  'Open PassVault for Mac → Settings → Touch ID and turn on “Touch ID in the browser extension”, then try again.';

interface HostReply {
  ok?: boolean;
  code?: string;
  message?: string;
  available?: boolean;
  reason?: string;
  enrolled?: boolean;
  secretB64?: string;
}

export class TouchIdError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

/** Host-side account name: per server scope and account (host allows [A-Za-z0-9._:@-]). */
export function touchIdAccount(scope: string | undefined, accountId: string): string {
  return `${scope ?? 'default'}.${accountId}`.replace(/[^A-Za-z0-9._:@-]/g, '_').slice(0, 160);
}

/** Sends one message to the Touch ID host from an extension page (see relayFromPopup). */
export type NativeRelay = (message: Record<string, unknown>) => Promise<unknown>;

export function createTouchIdAdapter(c: ChromeLike, scope: string | undefined, relay?: NativeRelay): BiometricUnlockAdapter {
  const send = async (msg: Record<string, unknown>): Promise<HostReply> => {
    // Chrome adds runtime.sendNativeMessage to a context only if the permission was granted
    // before that context started. A worker already running when the user allowed it lacks
    // it until its next start, so the open popup (reloaded after the grant) makes the call.
    const direct = c.runtime.sendNativeMessage;
    const native = direct ? (m: Record<string, unknown>) => direct.call(c.runtime, TOUCH_ID_HOST, m) : relay;
    if (!native) throw new TouchIdError('unavailable', 'This browser cannot use Touch ID.');
    if (c.permissions && !(await c.permissions.contains({ permissions: ['nativeMessaging'] }).catch(() => false))) {
      throw new TouchIdError('unavailable', 'Touch ID is turned off for the extension.');
    }
    let r: HostReply;
    try {
      r = ((await native(msg)) ?? {}) as HostReply;
    } catch {
      throw new TouchIdError('unavailable', `PassVault for Mac is not set up for Touch ID in this browser. ${TOUCH_ID_SETUP_HINT}`);
    }
    if (!r.ok) {
      const code = r.code ?? 'io_error';
      if (code === 'denied') throw new TouchIdError(code, 'Touch ID was cancelled or did not match');
      throw new TouchIdError(code, r.message || 'Touch ID failed');
    }
    return r;
  };
  return {
    async status() {
      try {
        const r = await send({ op: 'status' });
        return { available: !!r.available, reason: r.reason || undefined };
      } catch (e) {
        return { available: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    async storeKey(accountId, key) {
      await send({ op: 'enroll', account: touchIdAccount(scope, accountId), secretB64: toB64(key) });
    },
    async retrieveKey(accountId, reason) {
      const r = await send({ op: 'unlock', account: touchIdAccount(scope, accountId), reason: reason.slice(0, 160) });
      if (typeof r.secretB64 !== 'string') throw new TouchIdError('io_error', 'Touch ID returned no key');
      return fromB64(r.secretB64);
    },
    async removeKey(accountId) {
      await send({ op: 'remove', account: touchIdAccount(scope, accountId) }).catch(() => undefined);
    },
  };
}
