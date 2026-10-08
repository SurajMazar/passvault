import { z } from 'zod';
import { matchLogin, newItem, pageOrigin, siteKey, type DecryptedItem, type SessionSnapshot, type VaultSession } from '@passvault/vault-core';
import type { ChromeLike, SenderLike } from './chrome-api';

/**
 * "Offer to save passwords" — background side.
 *
 * Trust model: messages come from the save-prompt content script, i.e. from a
 * web page's tab. They are treated as untrusted input:
 *   - accepted only from this extension's content script in the TOP frame of a
 *     tab (sender.id === runtime.id, sender.tab present, frameId 0);
 *   - the page origin is taken from sender.url, never from the message;
 *   - responses never contain vault data — only the suggested action, host and
 *     (for updates) the existing item's title;
 *   - the captured password is kept in memory (and chrome.storage.session,
 *     memory-only, trusted contexts) for at most PENDING_TTL_MS and is used
 *     only if the user clicks Save/Update in the prompt.
 */

export const AUTOSAVE_ENABLED_KEY = 'pv.autoSave.enabled';
export const NEVER_SAVE_KEY = 'pv.autoSave.never';
export const PENDING_KEY = 'pv.autoSave.pending';
export const NOTE_MAX = 2000;
export const CONTENT_SCRIPT_ID = 'pv-save-prompt';
export const AUTOSAVE_ORIGINS = ['https://*/*', 'http://*/*'];
export const PENDING_TTL_MS = 3 * 60_000;

export const contentMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('savePrompt.submitted'), username: z.string().max(500), password: z.string().min(1).max(4096) }).strict(),
  z.object({ type: z.literal('savePrompt.pending') }).strict(),
  z
    .object({
      type: z.literal('savePrompt.decide'),
      decision: z.enum(['save', 'update', 'dismiss', 'never']),
      /** optional note typed into the prompt; stored in the item's notes */
      note: z.string().max(NOTE_MAX).optional(),
    })
    .strict(),
]);
export type ContentMessage = z.infer<typeof contentMessageSchema>;

export type PromptInfo = { show: true; action: 'save' | 'update'; host: string; itemTitle?: string; locked: boolean } | { show: false };
export type DecideResult = { ok: true; message: string } | { ok: false; code: string; message: string };

interface Pending {
  tabId: number;
  origin: string;
  site: string;
  host: string;
  username: string;
  password: string;
  action: 'save' | 'update';
  itemId?: string;
  itemTitle?: string;
  createdAt: number;
}

type SessionPart = Pick<VaultSession, 'getSnapshot' | 'saveItem' | 'updateItem' | 'isUnlocked'>;

export function isContentSender(c: ChromeLike, sender: SenderLike | undefined): sender is SenderLike & { tab: { id: number } } {
  if (!sender || sender.id !== c.runtime.id) return false;
  const tab = sender.tab as { id?: number } | undefined | null;
  if (!tab || typeof tab.id !== 'number') return false;
  if (sender.frameId !== 0) return false;
  return !!pageOrigin(sender.url ?? '');
}

export class SavePromptManager {
  private pending = new Map<number, Pending>();
  private loaded = false;

  constructor(
    private readonly c: ChromeLike,
    private readonly session: SessionPart,
    /** origins where PassVault never prompts (its own dashboard and API) */
    private readonly ownOrigins: string[],
    private readonly now: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------- settings

  async status(): Promise<{ enabled: boolean; permission: boolean; neverCount: number }> {
    const s = await this.c.storage.local.get([AUTOSAVE_ENABLED_KEY, NEVER_SAVE_KEY]);
    const permission = (await this.c.permissions?.contains({ origins: AUTOSAVE_ORIGINS })) ?? false;
    return { enabled: s[AUTOSAVE_ENABLED_KEY] === true && permission, permission, neverCount: ((s[NEVER_SAVE_KEY] as string[] | undefined) ?? []).length };
  }

  /** Called after the popup obtained (or the user removed) the optional host permission. */
  async setEnabled(enabled: boolean): Promise<{ enabled: boolean; permission: boolean; neverCount: number }> {
    const permission = (await this.c.permissions?.contains({ origins: AUTOSAVE_ORIGINS })) ?? false;
    const on = enabled && permission;
    await this.c.storage.local.set({ [AUTOSAVE_ENABLED_KEY]: on });
    await this.syncRegistration(on);
    return this.status();
  }

  async clearNeverList() {
    await this.c.storage.local.set({ [NEVER_SAVE_KEY]: [] });
    return this.status();
  }

  /** Keep the dynamic content script registration consistent with the setting and permission. */
  async syncRegistration(want?: boolean): Promise<void> {
    const scripting = this.c.scripting;
    if (!scripting.registerContentScripts || !scripting.getRegisteredContentScripts || !scripting.unregisterContentScripts) return;
    const enabled = want ?? (await this.status()).enabled;
    const existing = await scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    if (enabled && existing.length === 0) {
      await scripting.registerContentScripts([
        { id: CONTENT_SCRIPT_ID, matches: AUTOSAVE_ORIGINS, js: ['save-prompt.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true },
      ]);
    } else if (!enabled && existing.length > 0) {
      await scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    }
  }

  // ---------------------------------------------------------------- messages

  async handle(raw: unknown, sender: SenderLike | undefined): Promise<PromptInfo | DecideResult | null> {
    if (!isContentSender(this.c, sender)) return null;
    const parsed = contentMessageSchema.safeParse(raw);
    if (!parsed.success) return null;
    if (!(await this.status()).enabled) return { show: false };
    const url = sender.url!;
    const tabId = sender.tab.id;
    await this.load();
    this.expire();
    switch (parsed.data.type) {
      case 'savePrompt.submitted':
        return this.onSubmitted(tabId, url, parsed.data.username, parsed.data.password);
      case 'savePrompt.pending':
        return this.promptFor(tabId, url);
      case 'savePrompt.decide':
        return this.decide(tabId, url, parsed.data.decision, parsed.data.note);
    }
  }

  private async onSubmitted(tabId: number, url: string, username: string, password: string): Promise<PromptInfo> {
    const origin = pageOrigin(url)!;
    const site = siteKey(url);
    if (!site || this.ownOrigins.includes(origin)) return { show: false };
    const never = ((await this.c.storage.local.get(NEVER_SAVE_KEY))[NEVER_SAVE_KEY] as string[] | undefined) ?? [];
    if (never.includes(site)) return { show: false };
    const host = new URL(url).host;
    let action: 'save' | 'update' = 'save';
    let itemId: string | undefined;
    let itemTitle: string | undefined;
    if (this.session.isUnlocked) {
      const existing = this.findExisting(this.session.getSnapshot(), url, username);
      if (existing) {
        if (existing.payload.type === 'login' && existing.payload.fields.password === password) return { show: false }; // already saved
        if (existing.role === 'viewer') return { show: false };
        action = 'update';
        itemId = existing.id;
        itemTitle = existing.payload.title;
      }
    }
    this.pending.set(tabId, { tabId, origin, site, host, username, password, action, itemId, itemTitle, createdAt: this.now() });
    await this.persist();
    return { show: true, action, host, itemTitle, locked: !this.session.isUnlocked };
  }

  private findExisting(snap: SessionSnapshot, url: string, username: string): DecryptedItem | undefined {
    const u = username.trim().toLowerCase();
    return snap.items.find(
      (i) => i.payload.type === 'login' && !i.payload.trashedAt && i.payload.fields.username.trim().toLowerCase() === u && !!matchLogin(i.payload.fields.urls, url)?.matches,
    );
  }

  private promptFor(tabId: number, url: string): PromptInfo {
    const p = this.pending.get(tabId);
    if (!p || siteKey(url) !== p.site) return { show: false };
    return { show: true, action: p.action, host: p.host, itemTitle: p.itemTitle, locked: !this.session.isUnlocked };
  }

  private async decide(tabId: number, url: string, decision: 'save' | 'update' | 'dismiss' | 'never', rawNote?: string): Promise<DecideResult> {
    const note = (rawNote ?? '').trim();
    /** Updates keep the existing notes and append the new one. */
    const appendNote = (notes: string) => (!note ? notes : notes.trim() ? `${notes.trimEnd()}\n\n${note}` : note);
    const p = this.pending.get(tabId);
    if (!p || siteKey(url) !== p.site) return { ok: false, code: 'expired', message: 'This prompt expired. Use “Save login from this page” in PassVault.' };
    if (decision === 'dismiss') {
      await this.drop(tabId);
      return { ok: true, message: '' };
    }
    if (decision === 'never') {
      const never = ((await this.c.storage.local.get(NEVER_SAVE_KEY))[NEVER_SAVE_KEY] as string[] | undefined) ?? [];
      await this.c.storage.local.set({ [NEVER_SAVE_KEY]: [...new Set([...never, p.site])].slice(-500) });
      await this.drop(tabId);
      return { ok: true, message: '' };
    }
    if (!this.session.isUnlocked) {
      return { ok: false, code: 'locked', message: 'PassVault is locked — click the PassVault toolbar icon, unlock, then press Save again.' };
    }
    try {
      if (decision === 'update' && p.itemId) {
        await this.session.updateItem(p.itemId, (pl) => {
          if (pl.type === 'login') {
            pl.fields.password = p.password;
            pl.fields.passwordUpdatedAt = new Date().toISOString();
            pl.notes = appendNote(pl.notes);
          }
        });
        await this.drop(tabId);
        return { ok: true, message: 'Password updated in PassVault' };
      }
      // Re-check for an existing login now that the vault may have been unlocked after the capture.
      const existing = this.findExisting(this.session.getSnapshot(), url, p.username);
      if (existing && existing.payload.type === 'login') {
        const changed = existing.payload.fields.password !== p.password || !!note;
        if (changed && existing.role !== 'viewer') {
          await this.session.updateItem(existing.id, (pl) => {
            if (pl.type === 'login') {
              if (pl.fields.password !== p.password) {
                pl.fields.password = p.password;
                pl.fields.passwordUpdatedAt = new Date().toISOString();
              }
              pl.notes = appendNote(pl.notes);
            }
          });
        }
        await this.drop(tabId);
        return { ok: true, message: `Updated “${existing.payload.title}”` };
      }
      await this.session.saveItem(
        newItem('login', {
          title: p.host.replace(/^www\./, ''),
          notes: note,
          fields: { username: p.username, password: p.password, urls: [{ url: p.origin, match: 'host' }], passwordUpdatedAt: new Date().toISOString() },
        }),
      );
      await this.drop(tabId);
      return { ok: true, message: 'Saved to PassVault' };
    } catch (e) {
      return { ok: false, code: 'error', message: e instanceof Error ? e.message : 'Could not save' };
    }
  }

  // ---------------------------------------------------------------- pending store

  /** Drop everything (vault lock / logout / setting disabled). */
  async clearAll() {
    this.pending.clear();
    await this.c.storage.session.remove(PENDING_KEY);
  }

  onTabRemoved(tabId: number) {
    if (this.pending.delete(tabId)) void this.persist();
  }

  private expire() {
    const t = this.now();
    for (const [k, v] of this.pending) if (t - v.createdAt > PENDING_TTL_MS) this.pending.delete(k);
  }

  private async drop(tabId: number) {
    this.pending.delete(tabId);
    await this.persist();
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    const stored = (await this.c.storage.session.get(PENDING_KEY))[PENDING_KEY] as Pending[] | undefined;
    for (const p of stored ?? []) if (!this.pending.has(p.tabId)) this.pending.set(p.tabId, p);
  }

  private async persist() {
    // chrome.storage.session is memory-only and restricted to trusted extension contexts.
    if (this.pending.size === 0) await this.c.storage.session.remove(PENDING_KEY);
    else await this.c.storage.session.set({ [PENDING_KEY]: [...this.pending.values()] });
  }
}
