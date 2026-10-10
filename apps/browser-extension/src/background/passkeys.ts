import { z } from 'zod';
import type { ItemPayload, StoredPasskey } from '@passvault/types';
import { isValidRpIdForHost, matchLogin, newItem, pageOrigin, type DecryptedItem, type VaultSession } from '@passvault/vault-core';
import type { ChromeLike, SenderLike } from './chrome-api';
import { isContentSender } from './save-prompt';
import { createPasskey, signAssertion } from './webauthn';

/**
 * PassVault as a passkey provider. The page script (content/passkey-main.ts) hands a
 * site's navigator.credentials.create/get request here through the isolated bridge.
 * Nothing happens without the user: the request waits until they approve it in
 * PassVault's own popup (opened for them, or by clicking the toolbar icon), where they
 * can also send it back to the browser ("Use another device").
 *
 * Trust: the origin comes from the browser's record of the sending tab (sender.url),
 * top frame only, https (or localhost); the RP ID must be that host or a parent domain
 * that is not a public suffix. The page's options are size-checked data only.
 */

const b64u = z.string().regex(/^[A-Za-z0-9_-]*$/).max(1400);
const createOptions = z
  .object({
    rp: z.object({ id: z.string().max(253).optional(), name: z.string().max(200).optional() }),
    user: z.object({ id: b64u.min(1).max(86), name: z.string().max(500), displayName: z.string().max(500) }),
    challenge: b64u.min(16),
    pubKeyCredParams: z.array(z.object({ type: z.string().max(20), alg: z.number() })).max(20),
    excludeCredentials: z.array(b64u).max(100),
  })
  .strip();
const getOptions = z
  .object({ rpId: z.string().max(253).optional(), challenge: b64u.min(16), allowCredentials: z.array(b64u).max(100) })
  .strip();
const requestMessage = z.object({
  type: z.literal('passkey.request'),
  requestId: z.string().min(1).max(100),
  kind: z.enum(['create', 'get', 'abort']),
  options: z.unknown(),
});

/** What the popup shows and decides on. */
export interface PasskeyRequestView {
  id: string;
  kind: 'create' | 'get';
  host: string;
  rpId: string;
  rpName: string;
  /** create: the account the site wants a passkey for */
  userName: string;
  /** get: passkeys PassVault can use for this site (filled once the vault is unlocked) */
  candidates: Array<{ credentialId: string; itemId: string; title: string; userName: string }>;
  /** create: the login it will be added to, if one exists */
  intoTitle: string | null;
}

export type PasskeyResult = Record<string, unknown>;

interface Pending {
  id: string;
  requestId: string;
  tabId: number;
  kind: 'create' | 'get';
  origin: string;
  host: string;
  rpId: string;
  rpName: string;
  challenge: string;
  user?: { id: string; name: string; displayName: string };
  allow: string[];
  resolve: (r: PasskeyResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const FALLBACK: PasskeyResult = { fallback: true };
const TIMEOUT_MS = 3 * 60_000;
/** How long a request waits for the popup to be opened before it goes back to the browser. */
export const PROMPT_GRACE_MS = 20_000;

type SessionPart = Pick<VaultSession, 'getSnapshot' | 'isUnlocked' | 'saveItem' | 'updateItem'>;

export class PasskeyManager {
  private pending: Pending | null = null;

  constructor(
    private readonly c: ChromeLike,
    private readonly session: SessionPart,
    private readonly hooks: { enabled(): Promise<boolean>; changed(): void; ownOrigins?: string[]; popupOpen?: () => boolean },
  ) {}

  /** The request waiting for the user, as the popup shows it. */
  view(): PasskeyRequestView | null {
    const p = this.pending;
    if (!p) return null;
    const unlocked = this.session.isUnlocked;
    return {
      id: p.id,
      kind: p.kind,
      host: p.host,
      rpId: p.rpId,
      rpName: p.rpName || p.rpId,
      userName: p.user?.name ?? '',
      candidates: unlocked && p.kind === 'get' ? this.candidates(p.rpId, p.allow) : [],
      intoTitle: unlocked && p.kind === 'create' && p.user ? (this.loginFor(p.origin, p.user.name)?.payload.title ?? null) : null,
    };
  }

  /** From the content bridge (web page tab). */
  async handle(raw: unknown, sender: SenderLike | undefined): Promise<PasskeyResult | null> {
    if (!isContentSender(this.c, sender)) return null;
    const msg = requestMessage.safeParse(raw);
    if (!msg.success) return null;
    const tabId = sender.tab.id;
    if (msg.data.kind === 'abort') {
      if (this.pending?.tabId === tabId && this.pending.requestId === msg.data.requestId) this.finish({ error: 'AbortError' });
      return { ok: true };
    }
    if (!(await this.hooks.enabled())) return FALLBACK;
    const url = new URL(sender.url!);
    const origin = pageOrigin(sender.url!);
    const secure = url.protocol === 'https:' || url.hostname === 'localhost';
    if (!origin || !secure || this.hooks.ownOrigins?.includes(origin)) return FALLBACK;
    const host = url.hostname;

    let p: Omit<Pending, 'resolve' | 'timer'>;
    if (msg.data.kind === 'create') {
      const o = createOptions.safeParse(msg.data.options);
      if (!o.success) return FALLBACK;
      const rpId = (o.data.rp.id || host).toLowerCase();
      if (!isValidRpIdForHost(rpId, host)) return { error: 'SecurityError', message: 'The passkey domain does not match this site.' };
      const params = o.data.pubKeyCredParams;
      if (params.length > 0 && !params.some((x) => x.type === 'public-key' && x.alg === -7)) return FALLBACK; // only ES256
      if (this.session.isUnlocked && o.data.excludeCredentials.some((id) => this.findPasskey(rpId, id))) {
        return { error: 'InvalidStateError', message: 'PassVault already has a passkey for this account.' };
      }
      p = { id: crypto.randomUUID(), requestId: msg.data.requestId, tabId, kind: 'create', origin, host, rpId, rpName: o.data.rp.name || rpId, challenge: o.data.challenge, user: o.data.user, allow: [] };
    } else {
      const o = getOptions.safeParse(msg.data.options);
      if (!o.success) return FALLBACK;
      const rpId = (o.data.rpId || host).toLowerCase();
      if (!isValidRpIdForHost(rpId, host)) return { error: 'SecurityError', message: 'The passkey domain does not match this site.' };
      // Unlocked and nothing saved for this site: leave it to the browser without asking.
      if (this.session.isUnlocked && this.candidates(rpId, o.data.allowCredentials).length === 0) return FALLBACK;
      p = { id: crypto.randomUUID(), requestId: msg.data.requestId, tabId, kind: 'get', origin, host, rpId, rpName: rpId, challenge: o.data.challenge, allow: o.data.allowCredentials };
    }

    // One request at a time: a newer one replaces an older one (which goes back to the browser).
    if (this.pending) this.finish(FALLBACK);
    return new Promise<PasskeyResult>((resolve) => {
      this.pending = { ...p, resolve, timer: setTimeout(() => this.finish({ error: 'NotAllowedError', message: 'Timed out waiting for PassVault.' }), TIMEOUT_MS) };
      this.hooks.changed();
      void this.openPrompt();
    });
  }

  /** From the popup: approve (with the chosen passkey for sign-in), hand back to the browser, or cancel. */
  async decide(id: string, action: 'approve' | 'fallback' | 'cancel', credentialId?: string): Promise<{ ok: boolean; message?: string }> {
    const p = this.pending;
    if (!p || p.id !== id) return { ok: false, message: 'This passkey request is no longer waiting.' };
    if (action === 'fallback') return this.finish(FALLBACK), { ok: true };
    if (action === 'cancel') return this.finish({ error: 'NotAllowedError', message: 'Cancelled in PassVault.' }), { ok: true };
    if (!this.session.isUnlocked) return { ok: false, message: 'Unlock PassVault first.' };
    try {
      if (p.kind === 'create') {
        const reg = await createPasskey({ rpId: p.rpId, rpName: p.rpName, origin: p.origin, challenge: p.challenge, user: p.user! });
        await this.store(p, reg.passkey);
        this.finish({
          credentialId: reg.credentialId,
          clientDataJSON: reg.clientDataJSON,
          attestationObject: reg.attestationObject,
          authenticatorData: reg.authenticatorData,
          publicKey: reg.publicKey,
        });
        return { ok: true, message: `Passkey saved for ${p.rpId}.` };
      }
      const found = credentialId ? this.findPasskey(p.rpId, credentialId) : null;
      if (!found || (p.allow.length > 0 && !p.allow.includes(found.credentialId))) return { ok: false, message: 'Choose one of the passkeys for this site.' };
      this.finish({ ...(await signAssertion(found, { origin: p.origin, challenge: p.challenge })) });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Passkey operation failed.' };
    }
  }

  /** The popup closed while a request was waiting: give it back to the browser. */
  popupClosed(): void {
    if (this.pending) this.finish(FALLBACK);
  }

  /** Vault locked or server switched: nothing may stay pending. */
  clear(): void {
    if (this.pending) this.finish(FALLBACK);
  }

  // ---------------------------------------------------------------- internals

  private finish(result: PasskeyResult) {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    void this.c.action?.setBadgeText?.({ text: '' });
    p.resolve(result);
    this.hooks.changed();
  }

  private async openPrompt() {
    const id = this.pending?.id;
    try {
      await this.c.action?.openPopup?.();
    } catch {
      // Chrome did not let us open the popup (window not focused): flag the toolbar icon instead.
      await this.c.action?.setBadgeText?.({ text: '1' })?.catch?.(() => undefined);
    }
    // Never leave a site waiting on a prompt the user cannot see: if no PassVault popup is
    // open shortly after, the request goes back to the browser.
    setTimeout(() => {
      if (this.pending?.id === id && this.hooks.popupOpen && !this.hooks.popupOpen()) this.finish(FALLBACK);
    }, PROMPT_GRACE_MS);
  }

  private logins(): Array<DecryptedItem & { payload: ItemPayload<'login'> }> {
    return this.session.getSnapshot().items.filter((i): i is DecryptedItem & { payload: ItemPayload<'login'> } => i.payload.type === 'login' && !i.payload.trashedAt);
  }

  private candidates(rpId: string, allow: string[]): PasskeyRequestView['candidates'] {
    const out: PasskeyRequestView['candidates'] = [];
    for (const it of this.logins()) {
      for (const pk of it.payload.fields.passkeys ?? []) {
        if (pk.rpId !== rpId || (allow.length > 0 && !allow.includes(pk.credentialId))) continue;
        out.push({ credentialId: pk.credentialId, itemId: it.id, title: it.payload.title, userName: pk.userName || it.payload.fields.username });
      }
    }
    return out;
  }

  private findPasskey(rpId: string, credentialId: string): StoredPasskey | null {
    for (const it of this.logins()) for (const pk of it.payload.fields.passkeys ?? []) if (pk.rpId === rpId && pk.credentialId === credentialId) return pk;
    return null;
  }

  private loginFor(origin: string, userName: string) {
    const u = userName.trim().toLowerCase();
    return this.logins().find((it) => it.role !== 'viewer' && it.payload.fields.username.trim().toLowerCase() === u && !!matchLogin(it.payload.fields.urls, origin));
  }

  /** Into the matching login (same site and account), else a new login for the site. */
  private async store(p: Pending, pk: StoredPasskey) {
    const existing = this.loginFor(p.origin, p.user!.name);
    if (existing) {
      await this.session.updateItem(existing.id, (pl) => {
        if (pl.type !== 'login') return;
        // A new passkey for the same account replaces the old one for this RP.
        const others = (pl.fields.passkeys ?? []).filter((x) => !(x.rpId === pk.rpId && x.userHandle === pk.userHandle));
        pl.fields.passkeys = [...others, pk].slice(-20);
      });
      return;
    }
    await this.session.saveItem(
      newItem('login', {
        title: p.rpName || p.host,
        fields: { username: p.user!.name, password: '', urls: [{ url: p.origin, match: 'host' }], passkeys: [pk] },
      }),
    );
  }
}
