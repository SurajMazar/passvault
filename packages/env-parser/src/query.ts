import type { EntryLine, EnvDiffEntry, ParsedEnv } from './types';

/** All entries in file order (including every occurrence of duplicate keys). */
export function entries(parsed: ParsedEnv): EntryLine[] {
  return parsed.lines.filter((line): line is EntryLine => line.kind === 'entry');
}

/** Effective (last) occurrence of each key, in order of first appearance. */
function effectiveEntries(parsed: ParsedEnv): Map<string, EntryLine> {
  const map = new Map<string, EntryLine>();
  for (const entry of entries(parsed)) map.set(entry.key, entry);
  return map;
}

/**
 * Compares the effective (last) definition of every key. Values are compared
 * but NEVER included in the result.
 */
export function diffEnv(left: ParsedEnv, right: ParsedEnv): EnvDiffEntry[] {
  const l = effectiveEntries(left);
  const r = effectiveEntries(right);
  const out: EnvDiffEntry[] = [];
  for (const [key, le] of l) {
    const re = r.get(key);
    if (!re) out.push({ key, status: 'removed', leftLine: le.lineNumber });
    else
      out.push({
        key,
        status: le.value === re.value ? 'unchanged' : 'changed',
        leftLine: le.lineNumber,
        rightLine: re.lineNumber,
      });
  }
  for (const [key, re] of r) {
    if (!l.has(key)) out.push({ key, status: 'added', rightLine: re.lineNumber });
  }
  return out;
}

/** Case-insensitive substring match on key names (never on values). Empty query → all entries. */
export function searchKeys(parsed: ParsedEnv, query: string): EntryLine[] {
  const needle = query.toLowerCase();
  return entries(parsed).filter((entry) => entry.key.toLowerCase().includes(needle));
}

/**
 * Plain object of key → decoded value, last occurrence wins. The result is
 * PLAINTEXT SECRET MATERIAL; callers must treat it as such. Null-prototype
 * object so keys like `__proto__` are safe.
 */
export function toDotenvObject(parsed: ParsedEnv): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const entry of entries(parsed)) out[entry.key] = entry.value;
  return out;
}
