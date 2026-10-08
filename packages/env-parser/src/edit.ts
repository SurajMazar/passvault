import { formatValueAs } from './format';
import { dominantLineEnding, splitPhysicalLines } from './lines';
import { parseEnv, serializeEnv } from './parse';
import { entries } from './query';
import { HEAD_RE, KEY_RE, QuoteIndex, scanLogicalLine, type EntrySegments } from './scan';
import type { EditResult, EntryLine, EnvLine, LineEnding, ParsedEnv } from './types';

interface PlannedLine {
  raw: string;
  eol: LineEnding;
  /** Expected kind after re-parse; `null` for the edited/created line (checked separately). */
  kind: EnvLine['kind'] | null;
}

function fail(error: string): EditResult {
  return { ok: false, error };
}

function locate(parsed: ParsedEnv, entryId: string): { index: number; entry: EntryLine } | null {
  const index = parsed.lines.findIndex((line) => line.kind === 'entry' && line.id === entryId);
  const entry = parsed.lines[index];
  return entry?.kind === 'entry' ? { index, entry } : null;
}

/** Re-derives head/value/tail segments from an entry's raw text. */
function segmentsOf(entry: EntryLine): EntrySegments | null {
  const phys = splitPhysicalLines(entry.raw);
  if (phys.length === 0) return null;
  const result = scanLogicalLine(phys, 0, 1, new QuoteIndex(phys));
  if (result.kind !== 'entry' || result.consumed !== phys.length) return null;
  const { head, valueRaw, tail } = result.segments;
  return head + valueRaw + tail === entry.raw ? result.segments : null;
}

function plan(parsed: ParsedEnv): PlannedLine[] {
  return parsed.lines.map((line) => ({ raw: line.raw, eol: line.eol, kind: line.kind }));
}

const STALE = 'Entry not found; use the entry id from the latest parsed result.';
const STRUCTURE_CHANGED =
  'Edit refused: the new text would change how surrounding lines are parsed (for example an unterminated quote elsewhere in the file would swallow it). Fix the invalid lines first or edit the raw text.';

/**
 * Serializes the planned lines, re-parses, and verifies that every line
 * re-parses to exactly the planned raw text and kind, and that the target
 * entry satisfies `check`. Anything else is refused rather than guessed.
 */
function commit(
  parsed: ParsedEnv,
  planned: PlannedLine[],
  targetIndex: number | null,
  check: (entry: EntryLine) => string | null,
): EditResult {
  const text = (parsed.bom ? '﻿' : '') + planned.map((line) => line.raw + line.eol).join('');
  const env = parseEnv(text);
  if (env.lines.length !== planned.length) return fail(STRUCTURE_CHANGED);
  for (let k = 0; k < planned.length; k++) {
    const want = planned[k];
    const got = env.lines[k];
    if (!want || !got || want.raw !== got.raw || want.eol !== got.eol) return fail(STRUCTURE_CHANGED);
    if (want.kind !== null && want.kind !== got.kind) return fail(STRUCTURE_CHANGED);
  }
  if (serializeEnv(env) !== text) return fail('Internal error: round trip failed.');
  if (targetIndex === null) return { ok: true, env, text };
  const target = env.lines[targetIndex];
  if (target?.kind !== 'entry') return fail('Edit refused: the edited line would not parse as an entry.');
  const problem = check(target);
  if (problem) return fail(`Edit refused: ${problem}`);
  return { ok: true, env, text, entryId: target.id };
}

function hasLineBreak(s: string): boolean {
  return /[\r\n]/.test(s);
}

/** Encodes a value for a line whose tail is `tail`, never letting an unquoted value run into a `#`. */
function encodeFor(value: string, preferred: EntryLine['quote'], tail: string): string | null {
  const formatted = formatValueAs(value, preferred);
  if (!formatted) return null;
  if (formatted.quote === 'none' && tail !== '' && !/^[ \t]/.test(tail)) {
    return formatValueAs(value, 'single')?.text ?? null;
  }
  return formatted.text;
}

/**
 * Replaces the value of one entry. Keeps the existing quote style when it can
 * represent the value exactly; otherwise uses double quotes with escapes.
 * Prefix, key, spacing and inline comment are preserved. A multi-line entry
 * is rewritten as a single line.
 */
export function setValue(parsed: ParsedEnv, entryId: string, newValue: string): EditResult {
  const loc = locate(parsed, entryId);
  if (!loc) return fail(STALE);
  const seg = segmentsOf(loc.entry);
  if (!seg) return fail('Edit refused: the entry could not be re-read safely.');
  const encoded = encodeFor(newValue, loc.entry.quote, seg.tail);
  if (encoded === null) return fail('Value cannot be represented safely in a .env file (NUL characters are not allowed).');
  const planned = plan(parsed);
  planned[loc.index] = { raw: seg.head + encoded + seg.tail, eol: loc.entry.eol, kind: null };
  const { key, inlineComment } = loc.entry;
  return commit(parsed, planned, loc.index, (e) =>
    e.key !== key
      ? 'key changed unexpectedly.'
      : e.value !== newValue
        ? 'the value would not read back exactly.'
        : e.inlineComment !== inlineComment
          ? 'the inline comment would change.'
          : null,
  );
}

/** Renames one entry's key. Refuses invalid keys and keys that already exist. */
export function renameKey(parsed: ParsedEnv, entryId: string, newKey: string): EditResult {
  const loc = locate(parsed, entryId);
  if (!loc) return fail(STALE);
  if (!KEY_RE.test(newKey)) {
    return fail("Invalid key: must start with a letter or '_' and contain only letters, digits, '_', '.' or '-'.");
  }
  if (newKey === loc.entry.key) return commit(parsed, plan(parsed), loc.index, () => null);
  const clash = entries(parsed).find((e) => e.key === newKey);
  if (clash) return fail(`Key "${newKey}" already exists (line ${clash.lineNumber}); renaming would create a duplicate.`);
  const seg = segmentsOf(loc.entry);
  const head = seg ? HEAD_RE.exec(seg.head) : null;
  if (!seg || !head) return fail('Edit refused: the entry could not be re-read safely.');
  const newHead = (head[1] ?? '') + (head[2] ?? '') + newKey + (head[4] ?? '');
  const planned = plan(parsed);
  planned[loc.index] = { raw: newHead + seg.valueRaw + seg.tail, eol: loc.entry.eol, kind: null };
  const { value, exported, inlineComment } = loc.entry;
  return commit(parsed, planned, loc.index, (e) =>
    e.key !== newKey || e.value !== value || e.exported !== exported || e.inlineComment !== inlineComment
      ? 'the entry would not read back as intended.'
      : null,
  );
}

/**
 * Adds `KEY=value` (with optional inline comment) after `afterEntryId`, or at
 * the end of the file. Uses the file's dominant line ending. When appending to
 * a file without a trailing newline, the previous last line gets one and the
 * new line becomes the (unterminated) last line.
 */
export function addEntry(
  parsed: ParsedEnv,
  key: string,
  value: string,
  opts: { comment?: string; afterEntryId?: string } = {},
): EditResult {
  if (!KEY_RE.test(key)) {
    return fail("Invalid key: must start with a letter or '_' and contain only letters, digits, '_', '.' or '-'.");
  }
  const clash = entries(parsed).find((e) => e.key === key);
  if (clash) return fail(`Key "${key}" already exists (line ${clash.lineNumber}).`);
  if (opts.comment !== undefined && hasLineBreak(opts.comment)) return fail('Inline comments cannot contain line breaks.');
  const encoded = formatValueAs(value, 'none');
  if (!encoded) return fail('Value cannot be represented safely in a .env file (NUL characters are not allowed).');

  let index = parsed.lines.length;
  if (opts.afterEntryId !== undefined) {
    const loc = locate(parsed, opts.afterEntryId);
    if (!loc) return fail(STALE);
    index = loc.index + 1;
  }
  const eol = dominantLineEnding(serializeEnv(parsed));
  const raw = `${key}=${encoded.text}${opts.comment !== undefined ? ` # ${opts.comment}` : ''}`;
  const planned = plan(parsed);
  let newEol: LineEnding = eol;
  const previous = planned[index - 1];
  if (index === planned.length && previous && previous.eol === '') {
    previous.eol = eol;
    newEol = '';
  }
  planned.splice(index, 0, { raw, eol: newEol, kind: null });
  const wantComment = opts.comment !== undefined ? opts.comment.trim() : null;
  return commit(parsed, planned, index, (e) =>
    e.key !== key || e.value !== value || e.inlineComment !== wantComment ? 'the entry would not read back as intended.' : null,
  );
}

/** Removes one entry (all of its physical lines). Other lines are untouched. */
export function removeEntry(parsed: ParsedEnv, entryId: string): EditResult {
  const loc = locate(parsed, entryId);
  if (!loc) return fail(STALE);
  const planned = plan(parsed);
  planned.splice(loc.index, 1);
  return commit(parsed, planned, null, () => null);
}

/** Sets (string) or removes (null) an entry's inline `# comment`. The value is untouched. */
export function setInlineComment(parsed: ParsedEnv, entryId: string, comment: string | null): EditResult {
  const loc = locate(parsed, entryId);
  if (!loc) return fail(STALE);
  if (comment !== null && hasLineBreak(comment)) return fail('Inline comments cannot contain line breaks.');
  const seg = segmentsOf(loc.entry);
  const tail = seg ? /^([ \t]*)(#[^]*)?$/.exec(seg.tail) : null;
  if (!seg || !tail) return fail('Edit refused: the entry could not be re-read safely.');
  const ws = tail[1] ?? '';
  const hadComment = tail[2] !== undefined;
  let newTail: string;
  if (comment === null) newTail = hadComment ? '' : seg.tail;
  else newTail = (hadComment || ws !== '' ? ws : ' ') + (comment === '' ? '#' : `# ${comment}`);
  if (newTail.startsWith('#') && loc.entry.quote === 'none') newTail = ` ${newTail}`;
  const planned = plan(parsed);
  planned[loc.index] = { raw: seg.head + seg.valueRaw + newTail, eol: loc.entry.eol, kind: null };
  const { key, value } = loc.entry;
  const want = comment === null ? null : comment.trim();
  return commit(parsed, planned, loc.index, (e) =>
    e.key !== key || e.value !== value || e.inlineComment !== want ? 'the entry would not read back as intended.' : null,
  );
}
