import type { DecryptedItem } from '@passvault/vault-core';
import { filterItems } from '@passvault/vault-core';

/**
 * The buddy's command understanding. Entirely local and deterministic: the
 * text the user types is matched against a few phrasings — nothing is sent
 * anywhere, and replies never contain secret values.
 *
 *   copy github password · password for github · github pw
 *   username for aws · copy aws user
 *   new password · generate 24 · passphrase
 *   ssh prod · connect to web-1
 *   save login for netflix · save
 *   lock · settings · open github · help
 *   anything else → search
 */

export type Intent =
  | { kind: 'copy'; field: 'password' | 'username'; query: string }
  | { kind: 'generate'; length: number; passphrase: boolean }
  | { kind: 'connect'; query: string }
  | { kind: 'save'; site: string }
  | { kind: 'open'; query: string }
  | { kind: 'lock' }
  | { kind: 'settings' }
  | { kind: 'help' }
  | { kind: 'search'; query: string };

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const strip = (s: string, ...words: RegExp[]) => clean(words.reduce((acc, w) => acc.replace(w, ' '), s));
const FILLER = /\b(my|the|a|an|please|pls|for|of|on|to|me|in)\b/gi;

export function parseIntent(raw: string): Intent {
  const text = clean(raw.toLowerCase());
  if (!text) return { kind: 'help' };
  if (/^(help|\?|what can you do\??|commands)$/.test(text)) return { kind: 'help' };
  if (/^(lock|lock (the )?vault|lock it)$/.test(text)) return { kind: 'lock' };
  if (/^(settings|preferences|prefs|options)$/.test(text)) return { kind: 'settings' };

  // generate
  const gen = /^(generate|gen|new|create|make)( a| me a)?( strong)?\s*(password|pass ?phrase|pw|pwd)?\s*(\d{1,3})?(\s*(chars?|characters))?$/.exec(text);
  if (gen && (gen[4] || gen[5] || gen[1] === 'generate' || gen[1] === 'gen')) {
    const passphrase = /phrase/.test(gen[4] ?? '');
    const n = gen[5] ? Number(gen[5]) : passphrase ? 5 : 20;
    return { kind: 'generate', passphrase, length: passphrase ? Math.min(Math.max(n, 3), 12) : Math.min(Math.max(n, 8), 128) };
  }
  if (/^pass ?phrase$/.test(text)) return { kind: 'generate', passphrase: true, length: 5 };

  // connect
  const ssh = /^(ssh( to| into)?|connect( to)?|open terminal( for| to)?|terminal( for| to)?)\s+(.+)$/.exec(text);
  if (ssh) return { kind: 'connect', query: clean(ssh[6]!) };

  // save
  const save = /^(save|add|store|remember)( a| new)?( login| password| credential| account)?(\s+(for|to|on))?\s*(.*)$/.exec(text);
  if (save && (save[3] || save[6] || text === 'save' || text === 'add')) return { kind: 'save', site: clean(save[6] ?? '') };

  // copy username / password
  const userWords = /\b(user ?name|user|login name|email|e-mail)\b/;
  const passWords = /\b(password|passwd|pass|pw|pwd|secret)\b/;
  const copyVerb = /^(copy|get|give( me)?|show( me)?|what'?s|what is)\s+/;
  if (passWords.test(text) || userWords.test(text) || copyVerb.test(text)) {
    const field = userWords.test(text) && !passWords.test(text) ? 'username' : 'password';
    const query = strip(text, copyVerb, passWords, userWords, FILLER, /'s\b/g);
    if (query) return { kind: 'copy', field, query };
  }

  const open = /^(open|show|find|search( for)?|look up)\s+(.+)$/.exec(text);
  if (open) return { kind: 'open', query: clean(open[3]!) };

  return { kind: 'search', query: clean(raw) };
}

/** Best matches for a spoken target ("github", "prod"), most specific first. */
export function findTargets(items: DecryptedItem[], query: string, types?: Array<DecryptedItem['payload']['type']>): DecryptedItem[] {
  const pool = types ? items.filter((i) => types.includes(i.payload.type)) : items;
  const hits = filterItems(pool, { query, status: 'active' });
  const q = query.toLowerCase();
  const score = (i: DecryptedItem) => {
    const t = i.payload.title.toLowerCase();
    if (t === q) return 0;
    if (t.startsWith(q)) return 1;
    const p = i.payload;
    if (p.type === 'login' && p.fields.urls.some((u) => u.url.toLowerCase().includes(q))) return 2;
    if (p.type === 'ssh_connection' && p.fields.host.toLowerCase().includes(q)) return 2;
    return 3 + (i.payload.favorite ? 0 : 0.5);
  };
  return [...hits].sort((a, b) => score(a) - score(b) || a.payload.title.localeCompare(b.payload.title));
}

/** One unambiguous answer, or the candidates to choose from. */
export function resolveOne(candidates: DecryptedItem[]): DecryptedItem | null {
  if (candidates.length === 1) return candidates[0]!;
  return null;
}

export const HELP_LINES = [
  '“copy github password”',
  '“username for aws”',
  '“new password 24” · “passphrase”',
  '“ssh prod”',
  '“save login for netflix”',
  '“lock” · “settings”',
];
