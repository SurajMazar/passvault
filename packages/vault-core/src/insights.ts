import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as en from '@zxcvbn-ts/language-en';
import type { ItemPayload } from '@passvault/types';

let factory: ZxcvbnFactory | null = null;
function estimator(): ZxcvbnFactory {
  factory ??= new ZxcvbnFactory({
    dictionary: { ...common.dictionary, ...en.dictionary },
    graphs: common.adjacencyGraphs,
    translations: en.translations,
  });
  return factory;
}

export interface StrengthResult {
  score: 0 | 1 | 2 | 3 | 4;
  label: 'Very weak' | 'Weak' | 'Fair' | 'Strong' | 'Very strong';
  warning: string | null;
  suggestions: string[];
}

const LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const;

/** Computed locally; passwords never leave the client. */
export function passwordStrength(password: string, userInputs: string[] = []): StrengthResult {
  const r = estimator().check(password.slice(0, 256), userInputs.filter(Boolean));
  return { score: r.score, label: LABELS[r.score]!, warning: r.feedback.warning || null, suggestions: r.feedback.suggestions };
}

export interface ItemRef {
  id: string;
  payload: ItemPayload;
}

export interface SecurityInsights {
  weak: Array<{ id: string; score: number }>;
  reused: Array<{ ids: string[] }>;
  old: string[];
  expiringSoon: Array<{ id: string; expiresAt: string; expired: boolean }>;
  insecureUrls: string[];
  checked: number;
}

/** Secrets that represent passwords for strength/reuse checks. */
function passwordsOf(p: ItemPayload): string[] {
  switch (p.type) {
    case 'login':
      return [p.fields.password];
    case 'database':
      return [p.fields.password];
    case 'ssh_connection':
      return p.fields.password ? [p.fields.password] : [];
    case 'api_credential':
      return p.fields.password ? [p.fields.password] : [];
    default:
      return [];
  }
}

export function computeInsights(items: ItemRef[], now = new Date()): SecurityInsights {
  const active = items.filter((i) => !i.payload.trashedAt && !i.payload.archived);
  const weak: SecurityInsights['weak'] = [];
  const byPassword = new Map<string, Set<string>>();
  const old: string[] = [];
  const expiringSoon: SecurityInsights['expiringSoon'] = [];
  const insecureUrls: string[] = [];
  let checked = 0;
  const yearAgo = now.getTime() - 365 * 24 * 3600 * 1000;
  for (const { id, payload } of active) {
    for (const pw of passwordsOf(payload)) {
      if (!pw) continue;
      checked++;
      const inputs = payload.type === 'login' ? [payload.fields.username, payload.title] : [payload.title];
      const s = passwordStrength(pw, inputs);
      if (s.score < 3) weak.push({ id, score: s.score });
      if (!byPassword.has(pw)) byPassword.set(pw, new Set());
      byPassword.get(pw)!.add(id);
    }
    if (payload.type === 'login') {
      if (payload.fields.passwordUpdatedAt && Date.parse(payload.fields.passwordUpdatedAt) < yearAgo) old.push(id);
      if (payload.fields.urls.some((u) => /^http:\/\//i.test(u.url.trim()) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(u.url.trim()))) insecureUrls.push(id);
    }
    if (payload.type === 'api_credential' && payload.fields.expiresAt) {
      const exp = Date.parse(`${payload.fields.expiresAt}T00:00:00Z`);
      if (exp - now.getTime() < 30 * 24 * 3600 * 1000) expiringSoon.push({ id, expiresAt: payload.fields.expiresAt, expired: exp < now.getTime() });
    }
  }
  const reused = [...byPassword.values()].filter((s) => s.size > 1).map((s) => ({ ids: [...s] }));
  return { weak, reused, old, expiringSoon, insecureUrls, checked };
}
