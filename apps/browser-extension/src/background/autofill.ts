import { matchLogin, pageOrigin, type DecryptedItem } from '@passvault/vault-core';
import type { FillResponse } from '../shared/protocol';

export type FillDecision =
  | { ok: true; origin: string; insecure: boolean; username: string; password: string }
  | { ok: false; response: FillResponse };

const refuse = (reason: Extract<FillResponse, { status: 'refused' }>['reason'], message: string): FillDecision => ({
  ok: false,
  response: { status: 'refused', reason, message },
});

/**
 * Policy check performed in the background immediately before every fill,
 * using a freshly read tab URL. Fill is only ever user-selected; this decides
 * whether the selected item may go into the selected page.
 */
export function evaluateFill(item: DecryptedItem | undefined, pageUrl: string | undefined, confirmInsecure: boolean): FillDecision {
  if (!item) return refuse('no_credentials', 'Item not found.');
  if (item.payload.type !== 'login') return refuse('not_login', 'Only website logins can be filled into pages. Use copy instead.');
  if (item.payload.trashedAt) return refuse('trashed', 'This item is in the trash.');
  if (!pageUrl) return refuse('no_tab', 'Cannot read the current page. Open the popup on the page you want to fill.');
  const origin = pageOrigin(pageUrl);
  if (!origin) return refuse('unsupported_page', 'PassVault only fills regular http(s) web pages.');
  const { username, password, urls } = item.payload.fields;
  if (!password) return refuse('no_credentials', 'This login has no password to fill.');
  const m = matchLogin(urls, pageUrl);
  if (!m) return refuse('no_match', 'This login is not saved for this website. Copy the password instead if you are sure.');
  if (m.insecure && !confirmInsecure) return { ok: false, response: { status: 'needs_confirmation', reason: 'insecure', origin } };
  return { ok: true, origin, insecure: m.insecure, username, password };
}
