import { describe, expect, it } from 'vitest';
import {
  addEntry,
  formatValue,
  parseEnv,
  removeEntry,
  renameKey,
  setInlineComment,
  setValue,
} from '../src/index';
import { entryByKey, expectOk, expectOnlyChanged } from './helpers';

const FILE = [
  '﻿# header comment\r\n',
  'export DB_URL = postgres://x  # primary\r\n',
  "SINGLE='literal'\n",
  '\n',
  'garbage line that is invalid\r\n',
  'PEM="a\nb"\n',
  'BT=`tick`\n',
  'LAST=end',
].join('');

describe('formatValue', () => {
  it('keeps the preferred style when it can represent the value', () => {
    expect(formatValue('abc')).toEqual({ quote: 'none', text: 'abc' });
    expect(formatValue('', 'none')).toEqual({ quote: 'none', text: '' });
    expect(formatValue('a b', 'single')).toEqual({ quote: 'single', text: "'a b'" });
    expect(formatValue('abc', 'double')).toEqual({ quote: 'double', text: '"abc"' });
  });

  it('falls back none → single → double', () => {
    expect(formatValue('has space')).toEqual({ quote: 'single', text: "'has space'" });
    expect(formatValue('pa$$word')).toEqual({ quote: 'single', text: "'pa$$word'" });
    expect(formatValue("it's")).toEqual({ quote: 'double', text: '"it\'s"' });
    expect(formatValue('a\nb')).toEqual({ quote: 'double', text: '"a\\nb"' });
    expect(formatValue('x', 'single')).toEqual({ quote: 'single', text: "'x'" });
    expect(formatValue('q"\\\r', 'double')).toEqual({ quote: 'double', text: '"q\\"\\\\\\r"' });
  });

  it('refuses NUL characters', () => {
    expect(formatValue('a\0b')).toBeNull();
  });

  it('round-trips every formatted value through the parser', () => {
    const samples = ['', 'x', ' lead', 'trail ', 'a#b', 'a # b', '"', "'", '`', '\\', '\\n', '\r\n', '\t', '$(x)', '🔑', "'\"`\\\n"];
    for (const value of samples) {
      for (const pref of ['none', 'single', 'double'] as const) {
        const f = formatValue(value, pref);
        if (!f) throw new Error('unexpected null');
        const entry = parseEnv(`K=${f.text}\n`).lines[0];
        expect(entry?.kind === 'entry' && entry.value).toBe(value);
      }
    }
  });
});

describe('setValue', () => {
  const env = parseEnv(FILE);

  it('changes only the target line and keeps prefix, spacing and inline comment', () => {
    const target = entryByKey(env, 'DB_URL');
    const r = expectOk(setValue(env, target.id, 'mysql://y'));
    expectOnlyChanged(env.lines, r.env.lines, { replaced: 1 });
    expect(r.env.lines[1]?.raw).toBe('export DB_URL = mysql://y  # primary');
    expect(r.env.lines[1]?.eol).toBe('\r\n');
    expect(entryByKey(r.env, 'DB_URL')).toMatchObject({ value: 'mysql://y', inlineComment: 'primary', exported: true });
    expect(r.text.startsWith('﻿')).toBe(true);
    expect(r.entryId).toBe(target.id);
  });

  it('switches unquoted to double quotes for newlines', () => {
    const r = expectOk(setValue(env, entryByKey(env, 'LAST').id, 'multi\nline'));
    expect(r.env.lines[r.env.lines.length - 1]?.raw).toBe('LAST="multi\\nline"');
    expect(entryByKey(r.env, 'LAST').value).toBe('multi\nline');
    expect(r.text.endsWith('LAST="multi\\nline"')).toBe(true);
  });

  it('keeps single quotes when possible, otherwise double', () => {
    const id = entryByKey(env, 'SINGLE').id;
    expect(expectOk(setValue(env, id, 'has $dollar')).env.lines[2]?.raw).toBe("SINGLE='has $dollar'");
    expect(expectOk(setValue(env, id, "it's")).env.lines[2]?.raw).toBe('SINGLE="it\'s"');
  });

  it('keeps backticks when possible', () => {
    const id = entryByKey(env, 'BT').id;
    expect(expectOk(setValue(env, id, 'x y')).env.lines[6]?.raw).toBe('BT=`x y`');
    expect(expectOk(setValue(env, id, 'x`y')).env.lines[6]?.raw).toBe('BT="x`y"');
  });

  it('rewrites a multiline entry as a single line without touching neighbours', () => {
    const r = expectOk(setValue(env, entryByKey(env, 'PEM').id, 'a\nb\nc'));
    expectOnlyChanged(env.lines, r.env.lines, { replaced: 5 });
    expect(entryByKey(r.env, 'PEM')).toMatchObject({ value: 'a\nb\nc', multiline: false, raw: 'PEM="a\\nb\\nc"' });
  });

  it('does not let an unquoted value run into a tight comment', () => {
    const e = parseEnv('A="v"#c\n');
    const r = expectOk(setValue(e, entryByKey(e, 'A').id, 'plain'));
    expect(entryByKey(r.env, 'A')).toMatchObject({ value: 'plain', inlineComment: 'c' });
  });

  it('refuses stale ids and impossible values', () => {
    expect(setValue(env, 'NOPE#0', 'x')).toMatchObject({ ok: false });
    expect(setValue(env, entryByKey(env, 'LAST').id, 'nul\0')).toMatchObject({ ok: false });
  });

  it('refuses when an earlier unterminated quote would swallow the edited line', () => {
    const e = parseEnv('A="open\nB=1\n');
    // A comment containing a quote would close A's quote and swallow B.
    const r = setInlineComment(e, entryByKey(e, 'B').id, '"');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/surrounding lines/);
  });

  it('works on one occurrence of a duplicated key', () => {
    const e = parseEnv('A=1\nA=2\n');
    const second = e.lines[1];
    if (second?.kind !== 'entry') throw new Error('expected entry');
    const r = expectOk(setValue(e, second.id, '3'));
    expect(r.text).toBe('A=1\nA=3\n');
  });
});

describe('renameKey', () => {
  const env = parseEnv(FILE);

  it('renames preserving export, spacing, value and comment', () => {
    const r = expectOk(renameKey(env, entryByKey(env, 'DB_URL').id, 'DATABASE_URL'));
    expectOnlyChanged(env.lines, r.env.lines, { replaced: 1 });
    expect(r.env.lines[1]?.raw).toBe('export DATABASE_URL = postgres://x  # primary');
    expect(r.entryId).toBe('DATABASE_URL#0');
  });

  it('renames multiline entries', () => {
    const r = expectOk(renameKey(env, entryByKey(env, 'PEM').id, 'CERT'));
    expect(entryByKey(r.env, 'CERT')).toMatchObject({ value: 'a\nb', raw: 'CERT="a\nb"' });
  });

  it('refuses invalid or clashing keys', () => {
    const id = entryByKey(env, 'LAST').id;
    expect(renameKey(env, id, '1BAD')).toMatchObject({ ok: false });
    expect(renameKey(env, id, 'HAS SPACE')).toMatchObject({ ok: false });
    expect(renameKey(env, id, '')).toMatchObject({ ok: false });
    expect(renameKey(env, id, 'SINGLE')).toMatchObject({ ok: false });
  });
});

describe('addEntry', () => {
  it('appends with the dominant line ending and terminates the previous last line', () => {
    const env = parseEnv('A=1\r\nB=2\r\nC=3');
    const r = expectOk(addEntry(env, 'D', 'four'));
    expect(r.text).toBe('A=1\r\nB=2\r\nC=3\r\nD=four');
    expectOnlyChanged(env.lines, r.env.lines, { insertedAt: 3, eolChangedAt: 2 });
  });

  it('appends after a trailing newline', () => {
    const r = expectOk(addEntry(parseEnv('A=1\n'), 'B', 'x y', { comment: 'note' }));
    expect(r.text).toBe("A=1\nB='x y' # note\n");
    expect(entryByKey(r.env, 'B')).toMatchObject({ value: 'x y', inlineComment: 'note' });
    expect(r.entryId).toBe('B#0');
  });

  it('adds to an empty file and to a BOM-only file', () => {
    expect(expectOk(addEntry(parseEnv(''), 'A', '1')).text).toBe('A=1\n');
    expect(expectOk(addEntry(parseEnv('﻿'), 'A', '1')).text).toBe('﻿A=1\n');
  });

  it('inserts after a given entry', () => {
    const env = parseEnv('A=1\nB=2\n');
    const r = expectOk(addEntry(env, 'AA', 'v', { afterEntryId: entryByKey(env, 'A').id }));
    expect(r.text).toBe('A=1\nAA=v\nB=2\n');
  });

  it('refuses bad keys, existing keys, multi-line comments and stale anchors', () => {
    const env = parseEnv('A=1\n');
    expect(addEntry(env, 'A', 'x')).toMatchObject({ ok: false });
    expect(addEntry(env, '9', 'x')).toMatchObject({ ok: false });
    expect(addEntry(env, 'B', 'x', { comment: 'a\nb' })).toMatchObject({ ok: false });
    expect(addEntry(env, 'B', 'x', { afterEntryId: 'Z#0' })).toMatchObject({ ok: false });
  });
});

describe('removeEntry', () => {
  it('removes all physical lines of one entry and nothing else', () => {
    const env = parseEnv(FILE);
    const r = expectOk(removeEntry(env, entryByKey(env, 'PEM').id));
    expectOnlyChanged(env.lines, r.env.lines, { removed: 5 });
    expect(r.text).toBe(FILE.replace('PEM="a\nb"\n', ''));
  });

  it('refuses stale ids', () => {
    expect(removeEntry(parseEnv('A=1'), 'B#0')).toMatchObject({ ok: false });
  });
});

describe('setInlineComment', () => {
  const env = parseEnv('A=1\nB="x" # old\nC=v   \nD=\n');

  it('adds, replaces and removes comments, touching only the target', () => {
    const add = expectOk(setInlineComment(env, entryByKey(env, 'A').id, 'new'));
    expect(add.text).toBe('A=1 # new\nB="x" # old\nC=v   \nD=\n');
    expectOnlyChanged(env.lines, add.env.lines, { replaced: 0 });

    const replace = expectOk(setInlineComment(env, entryByKey(env, 'B').id, 'newer'));
    expect(replace.env.lines[1]?.raw).toBe('B="x" # newer');

    const remove = expectOk(setInlineComment(env, entryByKey(env, 'B').id, null));
    expect(remove.env.lines[1]?.raw).toBe('B="x"');

    const keepWs = expectOk(setInlineComment(env, entryByKey(env, 'C').id, 'c'));
    expect(entryByKey(keepWs.env, 'C')).toMatchObject({ value: 'v', inlineComment: 'c' });

    const empty = expectOk(setInlineComment(env, entryByKey(env, 'D').id, 'empty'));
    expect(entryByKey(empty.env, 'D')).toMatchObject({ value: '', inlineComment: 'empty', raw: 'D= # empty' });
  });

  it('refuses line breaks', () => {
    expect(setInlineComment(env, entryByKey(env, 'A').id, 'a\r\nb')).toMatchObject({ ok: false });
  });
});

describe('chained edits', () => {
  it('use ids from the latest result', () => {
    let env = parseEnv('# app\nA=1\nB=2\n');
    env = expectOk(addEntry(env, 'C', '3')).env;
    env = expectOk(setValue(env, entryByKey(env, 'A').id, 'one')).env;
    env = expectOk(renameKey(env, entryByKey(env, 'B').id, 'BEE')).env;
    env = expectOk(removeEntry(env, entryByKey(env, 'C').id)).env;
    const final = expectOk(setInlineComment(env, entryByKey(env, 'A').id, 'first'));
    expect(final.text).toBe('# app\nA=one # first\nBEE=2\n');
  });
});
