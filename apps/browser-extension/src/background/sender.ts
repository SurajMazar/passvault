import type { ChromeLike, SenderLike } from './chrome-api';

export type SenderCheck = { ok: true } | { ok: false; reason: 'foreign_extension' | 'tab_context' | 'not_extension_page' | 'not_popup' };

/**
 * Decide whether a runtime message/port sender may talk to the background.
 *  - must be this extension (`sender.id === chrome.runtime.id`);
 *  - must not come from a tab (content scripts / injected functions have `sender.tab`);
 *  - must be one of this extension's own pages;
 *  - privileged operations additionally require the popup page itself.
 */
export function checkSender(c: ChromeLike, sender: SenderLike | undefined, privileged: boolean): SenderCheck {
  if (!sender || sender.id !== c.runtime.id) return { ok: false, reason: 'foreign_extension' };
  if (sender.tab !== undefined && sender.tab !== null) return { ok: false, reason: 'tab_context' };
  // Compare strings, not URL.origin: non-special schemes have an opaque ("null") origin in
  // some URL implementations, which would make every opaque origin look equal.
  const base = c.runtime.getURL('/'); // chrome-extension://<id>/
  const extOrigin = base.replace(/\/+$/, '');
  const url = sender.url ?? '';
  if (!url.startsWith(base)) return { ok: false, reason: 'not_extension_page' };
  if (sender.origin !== undefined && sender.origin !== extOrigin) return { ok: false, reason: 'not_extension_page' };
  if (!privileged) return { ok: true };
  const path = url.slice(base.length).split(/[?#]/)[0];
  if (path !== 'popup.html') return { ok: false, reason: 'not_popup' };
  if (sender.frameId !== undefined && sender.frameId !== 0) return { ok: false, reason: 'not_popup' };
  return { ok: true };
}
