import { z } from 'zod';
import { pageOrigin, type VaultSession } from '@passvault/vault-core';
import type { ChromeLike, SenderLike } from './chrome-api';
import { AUTOSAVE_ORIGINS, INLINE_ENABLED_KEY } from './save-prompt';
import type { FillResponse, MatchesResponse } from '../shared/protocol';

/**
 * Inline suggestions ("fill from the login field", like other password
 * managers): when the user clicks into a login field, the content script asks
 * for the logins saved for this site and shows them in a small menu; a click
 * fills the form.
 *
 * Security:
 *   - the page origin comes from sender.url (top frame only), never from the message;
 *   - suggestions carry id, title and username only — never a password;
 *   - a fill re-reads the tab URL and goes through the same policy as the
 *     popup (evaluateFill: same site, login items only, http needs the popup's
 *     confirmation) and pvFillCredentials (top frame, origin re-checked);
 *   - the content script acts only on trusted (user) input;
 *   - PassVault's own pages never get suggestions.
 */

export { INLINE_ENABLED_KEY };
export const MAX_SUGGESTIONS = 8;

const contentMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inline.suggest') }).strict(),
  z.object({ type: z.literal('inline.fill'), itemId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('inline.unlock') }).strict(),
]);

export interface InlineSuggestion {
  id: string;
  title: string;
  username: string;
  insecure: boolean;
}

export type InlineSuggestResult = { show: false } | { show: true; locked: true; items: [] } | { show: true; locked: false; items: InlineSuggestion[] };
export type InlineFillResult = { ok: true } | { ok: false; message: string };

export interface InlineDeps {
  /** logins matching the tab's current URL (same rules as the popup) */
  matches(tabId: number): Promise<MatchesResponse>;
  /** the popup's fill path (policy check + top-frame injection) */
  fill(tabId: number, itemId: string, confirmInsecure: boolean): Promise<FillResponse>;
}

export function isInlineMessage(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string' && (raw as { type: string }).type.startsWith('inline.');
}

export class InlineMenuManager {
  constructor(
    private readonly c: ChromeLike,
    private readonly session: Pick<VaultSession, 'isUnlocked'>,
    private readonly ownOrigins: string[],
    private readonly deps: InlineDeps,
  ) {}

  async status(): Promise<{ enabled: boolean; permission: boolean }> {
    const permission = (await this.c.permissions?.contains({ origins: AUTOSAVE_ORIGINS })) ?? false;
    const v = (await this.c.storage.local.get(INLINE_ENABLED_KEY))[INLINE_ENABLED_KEY];
    return { enabled: v !== false && permission, permission };
  }

  async handle(raw: unknown, sender: SenderLike | undefined): Promise<InlineSuggestResult | InlineFillResult | null> {
    // Only this extension's content script, top frame of a tab.
    const tab = sender?.tab as { id?: unknown } | undefined;
    if (!sender || sender.id !== this.c.runtime.id || !tab || typeof tab.id !== 'number' || (sender.frameId ?? 0) !== 0 || !sender.url) return null;
    const parsed = contentMessage.safeParse(raw);
    if (!parsed.success) return null;
    const origin = pageOrigin(sender.url);
    if (!origin || this.ownOrigins.includes(origin) || !(await this.status()).enabled) {
      return parsed.data.type === 'inline.suggest' ? { show: false } : { ok: false, message: 'Not available on this page.' };
    }
    const tabId = tab.id;
    switch (parsed.data.type) {
      case 'inline.suggest': {
        if (!this.session.isUnlocked) return { show: true, locked: true, items: [] };
        const m = await this.deps.matches(tabId);
        // The tab may have navigated since the content script asked.
        if (m.tab.origin !== origin) return { show: false };
        const items = m.matches.filter((x) => x.hasPassword).slice(0, MAX_SUGGESTIONS);
        if (!items.length) return { show: false };
        return { show: true, locked: false, items: items.map((x) => ({ id: x.id, title: x.title, username: x.username, insecure: x.insecure })) };
      }
      case 'inline.fill': {
        if (!this.session.isUnlocked) return { ok: false, message: 'PassVault is locked.' };
        const r = await this.deps.fill(tabId, parsed.data.itemId, false);
        if (r.status === 'filled') return { ok: true };
        if (r.status === 'needs_confirmation') return { ok: false, message: 'This page is not secure (http). Fill it from the PassVault popup to confirm.' };
        return { ok: false, message: r.message };
      }
      case 'inline.unlock': {
        // Opens the toolbar popup (where the vault is unlocked) when Chrome allows it.
        try {
          await this.c.action?.openPopup?.();
          return { ok: true };
        } catch {
          return { ok: false, message: 'Click the PassVault icon in the toolbar to unlock.' };
        }
      }
    }
  }
}
