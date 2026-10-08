import { describe, expect, it } from 'vitest';
import {
  addEntry,
  entries,
  parseEnv,
  removeEntry,
  renameKey,
  serializeEnv,
  setInlineComment,
  setValue,
  type ParsedEnv,
} from '../src/index';
import { expectOnlyChanged, pick, rng } from './helpers';

const TRICKY = [
  'A', 'b', 'Z', '_', '.', '-', '0', '9', ' ', '  ', '\t', '=', '==', '#', ' #', '"', "'", '`', '\\', '\\"', "\\'",
  '\n', '\r', '\r\n', '\n\n', '$', '${', '}', '$(', ')', '$HOME', 'export ', 'export', 'KEY', 'é', '🔑', '日本',
  '\uFEFF', '\u00A0', '\0', 'x', 'value', 'n', 't', '\\n', '\\t', '\\\\',
];

function randomText(rand: () => number): string {
  const len = Math.floor(rand() * 60);
  let s = rand() < 0.05 ? '\uFEFF' : '';
  for (let k = 0; k < len; k++) s += pick(rand, TRICKY);
  return s;
}

const KEYS = ['A', 'DB_URL', 'api.key', 'my-key', '_X', 'A', 'export', 'B2'];
const VALUES = [
  '', 'v', 'hello world', 'p@ss#word', "it's", 'say "hi"', 'C:\\path\\n', '${HOME}/x', '$(whoami)', '`id`',
  'line1\nline2', 'tab\there', 'é🔑', '  padded  ', '#notacomment', 'a=b=c', '"', "'", '\\', '\r\n',
];

function randomLine(rand: () => number): string {
  const key = pick(rand, KEYS);
  const value = pick(rand, VALUES).replace(/[\r\n]/g, '');
  const prefix = rand() < 0.2 ? 'export ' : rand() < 0.1 ? '  ' : '';
  const eq = pick(rand, ['=', '=', '=', ' = ', '= ']);
  const comment = rand() < 0.2 ? ` # note ${pick(rand, ['', '"', "'", '#'])}` : '';
  switch (Math.floor(rand() * 10)) {
    case 0:
      return '';
    case 1:
      return `# ${value}`;
    case 2:
      return `${prefix}${key}${eq}'${value}'${comment}`;
    case 3:
      return `${prefix}${key}${eq}"${value.replace(/"/g, '\\"')}"${comment}`;
    case 4:
      return `${prefix}${key}${eq}"multi${pick(rand, ['\n', '\r\n'])}line"${comment}`;
    case 5:
      return `${key}${eq}\`${value}\``;
    case 6:
      return pick(rand, ['garbage line', `${key}="unterminated`, `${key}='x' junk`, '1BAD=x', 'export ONLY', '=x']);
    default:
      return `${prefix}${key}${eq}${value}${comment}`;
  }
}

function randomFile(rand: () => number): string {
  const n = Math.floor(rand() * 12);
  let s = rand() < 0.1 ? '\uFEFF' : '';
  for (let k = 0; k < n; k++) {
    s += randomLine(rand);
    if (k < n - 1 || rand() < 0.7) s += pick(rand, ['\n', '\n', '\r\n']);
  }
  return s;
}

function checkInvariants(text: string, env: ParsedEnv): void {
  expect(serializeEnv(env)).toBe(text);
  let expectedLine = 1;
  for (const line of env.lines) {
    expect(line.lineNumber).toBe(expectedLine);
    const end = line.kind === 'entry' ? line.endLineNumber : line.lineNumber;
    const internalBreaks = (line.raw.match(/\n/g) ?? []).length;
    expect(end - line.lineNumber).toBe(internalBreaks);
    if (line.kind !== 'entry') expect(internalBreaks).toBe(0);
    expectedLine = end + 1;
  }
  expect(env.fullySupported).toBe(!env.lines.some((l) => l.kind === 'invalid'));
}

describe('round trip (property)', () => {
  it('serializeEnv(parseEnv(s)) === s for 6000 random strings over a tricky alphabet', () => {
    const rand = rng(0xc0ffee);
    for (let n = 0; n < 6000; n++) {
      const text = randomText(rand);
      checkInvariants(text, parseEnv(text));
    }
  });

  it('round-trips 4000 random grammar-shaped files', () => {
    const rand = rng(42);
    for (let n = 0; n < 4000; n++) {
      const text = randomFile(rand);
      checkInvariants(text, parseEnv(text));
    }
  });

  it('round-trips random UTF-16 code units, including lone surrogates', () => {
    const rand = rng(7);
    for (let n = 0; n < 1000; n++) {
      let text = '';
      const len = Math.floor(rand() * 40);
      for (let k = 0; k < len; k++) text += String.fromCharCode(Math.floor(rand() * 0x10000));
      checkInvariants(text, parseEnv(text));
    }
  });
});

describe('structured edits (property)', () => {
  it('random edits either succeed touching only target lines, or are refused', () => {
    const rand = rng(1234);
    let succeeded = 0;
    for (let n = 0; n < 2500; n++) {
      const text = randomFile(rand);
      const env = parseEnv(text);
      const list = entries(env);
      const target = list.length > 0 ? pick(rand, list) : undefined;
      const index = target ? env.lines.indexOf(target) : -1;
      const value = pick(rand, VALUES);
      const op = Math.floor(rand() * 5);

      if (op === 0 && target) {
        const r = setValue(env, target.id, value);
        if (!r.ok) continue;
        succeeded++;
        expectOnlyChanged(env.lines, r.env.lines, { replaced: index });
        const after = r.env.lines[index];
        expect(after?.kind === 'entry' && after.value).toBe(value);
        expect(after?.kind === 'entry' && after.key).toBe(target.key);
        expect(serializeEnv(r.env)).toBe(r.text);
      } else if (op === 1 && target) {
        const r = removeEntry(env, target.id);
        if (!r.ok) continue;
        succeeded++;
        expectOnlyChanged(env.lines, r.env.lines, { removed: index });
      } else if (op === 2) {
        const key = `NEW_${n}`;
        const r = addEntry(env, key, value, rand() < 0.5 ? { comment: 'c' } : {});
        if (!r.ok) continue;
        succeeded++;
        const last = env.lines[env.lines.length - 1];
        expectOnlyChanged(env.lines, r.env.lines, {
          insertedAt: env.lines.length,
          eolChangedAt: last && last.eol === '' ? env.lines.length - 1 : undefined,
        });
        const added = r.env.lines.find((l) => l.kind === 'entry' && l.key === key);
        expect(added?.kind === 'entry' && added.value).toBe(value);
      } else if (op === 3 && target) {
        const r = renameKey(env, target.id, `R_${n}`);
        if (!r.ok) continue;
        succeeded++;
        expectOnlyChanged(env.lines, r.env.lines, { replaced: index });
        const after = r.env.lines[index];
        expect(after?.kind === 'entry' && after.value).toBe(target.value);
      } else if (op === 4 && target) {
        const comment = rand() < 0.3 ? null : 'hello # "world"';
        const r = setInlineComment(env, target.id, comment);
        if (!r.ok) continue;
        succeeded++;
        expectOnlyChanged(env.lines, r.env.lines, { replaced: index });
        const after = r.env.lines[index];
        expect(after?.kind === 'entry' && after.value).toBe(target.value);
        expect(after?.kind === 'entry' && after.inlineComment).toBe(comment);
      }
    }
    expect(succeeded).toBeGreaterThan(1000);
  });
});
