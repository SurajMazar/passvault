import { z } from 'zod';
import type { BiometricUnlockAdapter } from '@passvault/vault-core';
import type { ChromeLike, SenderLike } from './chrome-api';

/**
 * Unlock the extension with a passkey (Touch ID, Windows Hello, a phone…), the same
 * way the web dashboard does — no desktop app involved.
 *
 *   turn on: a passkey is created for this extension (relying party = the extension's
 *            own origin) and asked for a WebAuthn PRF secret over a random salt; HKDF
 *            of that secret is an AES-256-GCM key that seals vault-core's device key.
 *            Only { credential id, salt, iv, sealed key } are kept (chrome.storage.local,
 *            per server).
 *   unlock:  the same passkey releases the same secret only after user verification,
 *            and the seal opens.
 *
 * The WebAuthn steps run in a small extension window (unlock.html), never the toolbar
 * popup: Chrome closes the popup as soon as the passkey sheet takes focus, which would
 * cancel the request. The window talks only to the worker, only for the request it was
 * opened for, and is closed as soon as the request ends.
 */

export const UNLOCK_PAGE = 'unlock.html';
const CEREMONY_TIMEOUT_MS = 2 * 60_000;
/** How long the window shows its success before it closes. */
export const CLOSE_AFTER_SUCCESS_MS = 600;
const HKDF_SALT = 'PassVault extension passkey unlock v1';
const HKDF_INFO = 'device-key seal';

export type Ceremony = { kind: 'enroll'; salt: string; userName: string } | { kind: 'unlock'; salt: string; credentialId: string };
export interface CeremonyResult {
  credentialId: string;
  prf: string;
}

const b64u = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const unlockPageMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('passkeyUnlock.get'), id: z.string().max(100) }).strict(),
  z.object({ type: z.literal('passkeyUnlock.done'), id: z.string().max(100), credentialId: b64u.max(1400), prf: b64u.min(43).max(86) }).strict(),
  z.object({ type: z.literal('passkeyUnlock.fail'), id: z.string().max(100), message: z.string().max(300), usePassword: z.boolean().optional() }).strict(),
]);
const PAGE_TYPES = new Set(['passkeyUnlock.get', 'passkeyUnlock.done', 'passkeyUnlock.fail']);
/** Messages of unlock.html (the popup's own passkeyUnlock.status/set requests go to the controller). */
export const isUnlockPageMessage = (m: unknown) => !!m && typeof m === 'object' && PAGE_TYPES.has(String((m as { type?: unknown }).type));

export class UnlockCancelled extends Error {
  constructor(
    message: string,
    /** the user chose "Use master password" */
    readonly usePassword = false,
  ) {
    super(message);
  }
}

interface Pending {
  id: string;
  ceremony: Ceremony;
  promise: Promise<CeremonyResult>;
  resolve: (r: CeremonyResult) => void;
  reject: (e: Error) => void;
  windowId?: number;
  tabId?: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Opens the unlock window for one WebAuthn request at a time and collects its answer. */
export class UnlockWindow {
  private pending: Pending | null = null;

  constructor(private readonly c: ChromeLike) {
    c.windows?.onRemoved?.addListener((windowId) => {
      if (this.pending && this.pending.windowId === windowId) this.finish(new UnlockCancelled('The passkey window was closed.'));
    });
  }

  get busy(): boolean {
    return !!this.pending;
  }

  /** Runs a passkey step in the unlock window. A second call for the same step focuses the open window. */
  async run(ceremony: Ceremony): Promise<CeremonyResult> {
    const p = this.pending;
    if (p && p.ceremony.kind === ceremony.kind) {
      if (p.windowId !== undefined) await this.c.windows?.update?.(p.windowId, { focused: true })?.catch?.(() => undefined);
      return p.promise;
    }
    if (p) this.finish(new UnlockCancelled('Replaced by a newer request.'));
    if (!this.c.windows?.create) throw new Error('This browser cannot open the passkey window.');
    let resolve!: (r: CeremonyResult) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<CeremonyResult>((res, rej) => ((resolve = res), (reject = rej)));
    const id = crypto.randomUUID();
    const next: Pending = { id, ceremony, promise, resolve, reject, timer: setTimeout(() => this.finish(new UnlockCancelled('The passkey request timed out.')), CEREMONY_TIMEOUT_MS) };
    this.pending = next;
    try {
      const win = await this.c.windows.create({ url: this.c.runtime.getURL(`${UNLOCK_PAGE}#${id}`), type: 'popup', width: 400, height: 480, focused: true });
      if (this.pending !== next) {
        if (win?.id !== undefined) await this.c.windows.remove?.(win.id).catch(() => undefined);
      } else {
        next.windowId = win?.id;
        next.tabId = win?.tabs?.[0]?.id;
      }
    } catch (e) {
      this.finish(e instanceof Error ? e : new Error(String(e)));
    }
    return promise;
  }

  /** Closes the window and ends a request still waiting (vault unlocked another way, locked, switched server). */
  cancel(reason = 'No longer needed.', kind?: Ceremony['kind']): void {
    if (this.pending && (!kind || this.pending.ceremony.kind === kind)) this.finish(new UnlockCancelled(reason));
  }

  /** Messages from unlock.html. Only the window opened for the current request is answered. */
  handle(raw: unknown, sender: SenderLike | undefined): unknown {
    const p = this.pending;
    if (!p || !sender || sender.id !== this.c.runtime.id) return null;
    const page = this.c.runtime.getURL(UNLOCK_PAGE);
    if (!(sender.url ?? '').startsWith(page)) return null;
    const tabId = (sender.tab as { id?: number } | undefined)?.id;
    if (p.tabId !== undefined && tabId !== p.tabId) return null;
    const msg = unlockPageMessage.safeParse(raw);
    if (!msg.success || msg.data.id !== p.id) return null;
    switch (msg.data.type) {
      case 'passkeyUnlock.get':
        // The page may load before windows.create returns: bind it to the first asker.
        if (p.tabId === undefined && tabId !== undefined) p.tabId = tabId;
        return { ...p.ceremony, rpName: 'PassVault' };
      case 'passkeyUnlock.done':
        this.finish({ credentialId: msg.data.credentialId, prf: msg.data.prf }, CLOSE_AFTER_SUCCESS_MS);
        return { ok: true };
      case 'passkeyUnlock.fail':
        this.finish(new UnlockCancelled(msg.data.message, !!msg.data.usePassword));
        return { ok: true };
    }
  }

  /** Closes the window (after `closeAfterMs`: a success stays visible for a moment) and settles the request. */
  private finish(result: CeremonyResult | Error, closeAfterMs = 0) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    const windowId = p.windowId;
    if (windowId !== undefined) {
      const close = () => void this.c.windows?.remove?.(windowId).catch(() => undefined);
      if (closeAfterMs) setTimeout(close, closeAfterMs);
      else close();
    }
    if (result instanceof Error) p.reject(result);
    else p.resolve(result);
  }
}

// ------------------------------------------------------------------ sealing

const enc = new TextEncoder();
const b64uEncode = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDecode = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));

async function sealingKey(prf: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HKDF_SALT), info: enc.encode(HKDF_INFO) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

interface PasskeyRecord {
  v: 1;
  cred: string;
  salt: string;
  iv: string;
  sealed: string;
}
const recordSchema = z.object({ v: z.literal(1), cred: b64u, salt: b64u, iv: b64u, sealed: b64u });

/** Storage key of an account's record (per server, like the other prefs). */
export const passkeyRecordKey = (scope: string | undefined, accountId: string) => `pv.${scope ? `${scope}.` : ''}passkeyUnlock.${accountId}`;

export function createPasskeyUnlockAdapter(c: ChromeLike, opts: { scope?: string; serverHost: string; window: UnlockWindow }): BiometricUnlockAdapter {
  const local = c.storage.local;
  const read = async (accountId: string): Promise<PasskeyRecord | null> => {
    const k = passkeyRecordKey(opts.scope, accountId);
    const r = recordSchema.safeParse((await local.get(k))[k]);
    return r.success ? r.data : null;
  };
  return {
    label: 'passkey',
    description:
      'Uses a passkey (Touch ID, Windows Hello or your phone) that releases a secret to unseal your vault key in this browser. Nothing leaves the device, and your master password always works too.',
    // Whether this computer can do it is only known in a page (the unlock window says so).
    status: async () => (c.windows?.create ? { available: true } : { available: false, reason: 'this browser cannot open the passkey window' }),
    async hasKey(accountId) {
      return !!(await read(accountId));
    },
    async storeKey(accountId, key) {
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const r = await opts.window.run({ kind: 'enroll', salt: b64uEncode(salt), userName: `PassVault unlock · ${opts.serverHost}` });
      const prf = b64uDecode(r.prf);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(accountId) }, await sealingKey(prf), new Uint8Array(key)));
      prf.fill(0);
      const rec: PasskeyRecord = { v: 1, cred: r.credentialId, salt: b64uEncode(salt), iv: b64uEncode(iv), sealed: b64uEncode(sealed) };
      await local.set({ [passkeyRecordKey(opts.scope, accountId)]: rec });
    },
    async retrieveKey(accountId) {
      const rec = await read(accountId);
      if (!rec) throw new Error('Passkey unlock is not set up in this browser. Unlock with your master password.');
      const r = await opts.window.run({ kind: 'unlock', salt: rec.salt, credentialId: rec.cred });
      if (r.credentialId !== rec.cred) throw new Error('That passkey is not the one set up for PassVault in this browser.');
      const prf = b64uDecode(r.prf);
      try {
        const key = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64uDecode(rec.iv), additionalData: enc.encode(accountId) }, await sealingKey(prf), b64uDecode(rec.sealed));
        return new Uint8Array(key);
      } catch {
        throw new Error('Passkey unlock no longer matches. Unlock with your master password and turn it on again in Settings.');
      } finally {
        prf.fill(0);
      }
    },
    async removeKey(accountId) {
      opts.window.cancel();
      await local.remove(passkeyRecordKey(opts.scope, accountId));
    },
  };
}
