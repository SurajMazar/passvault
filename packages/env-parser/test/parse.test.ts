import { describe, expect, it } from 'vitest';
import { entries, parseEnv, serializeEnv, type EnvIssue, type ParsedEnv } from '../src/index';
import { entryByKey } from './helpers';

function rt(text: string): ParsedEnv {
  const env = parseEnv(text);
  expect(serializeEnv(env)).toBe(text);
  return env;
}

function codes(env: ParsedEnv): Array<[number, EnvIssue['code']]> {
  return env.issues.map((i) => [i.lineNumber, i.code]);
}

describe('line structure', () => {
  it('handles empty input and BOM-only input', () => {
    expect(rt('').lines).toEqual([]);
    const bomOnly = rt('\uFEFF');
    expect(bomOnly.bom).toBe(true);
    expect(bomOnly.lines).toEqual([]);
  });

  it('keeps per-line CRLF / LF and a missing trailing newline', () => {
    const env = rt('A=1\r\nB=2\nC=3');
    expect(env.lines.map((l) => l.eol)).toEqual(['\r\n', '\n', '']);
    expect(entries(env).map((e) => e.value)).toEqual(['1', '2', '3']);
  });

  it('strips the BOM from the first key and re-emits it', () => {
    const env = rt('\uFEFFKEY=v\n');
    expect(env.bom).toBe(true);
    expect(entryByKey(env, 'KEY').value).toBe('v');
  });

  it('classifies blank lines (incl. whitespace-only) and comments', () => {
    const env = rt('\n   \n\t\n# hello\n   #indented comment  \n');
    expect(env.lines.map((l) => l.kind)).toEqual(['blank', 'blank', 'blank', 'comment', 'comment']);
    const comment = env.lines[4];
    expect(comment?.kind === 'comment' && comment.text).toBe('indented comment');
    expect(env.issues).toEqual([]);
    expect(env.fullySupported).toBe(true);
  });

  it('keeps tabs and trailing whitespace in raw while trimming the unquoted value', () => {
    const env = rt('KEY=value \t \nTAB=\tx\t\n');
    expect(entryByKey(env, 'KEY').value).toBe('value');
    expect(entryByKey(env, 'KEY').raw).toBe('KEY=value \t ');
    expect(entryByKey(env, 'TAB').value).toBe('x');
  });

  it('reports a stray carriage return but keeps it', () => {
    const env = rt('A=1\r\r\nB=2\n');
    expect(entryByKey(env, 'A').value).toBe('1\r');
    expect(codes(env)).toEqual([[1, 'stray-carriage-return']]);
  });

  it('handles very long lines', () => {
    const big = 'x'.repeat(200_000);
    const env = rt(`BIG=${big}\nQ="${big}"\n`);
    expect(entryByKey(env, 'BIG').value).toBe(big);
    expect(entryByKey(env, 'Q').value).toBe(big);
  });

  it('stays fast on pathological unterminated quotes', () => {
    const text = 'A="\\"\n'.repeat(20_000) + "B='x\n".repeat(20_000);
    const start = performance.now();
    const env = rt(text);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(env.lines.every((l) => l.kind === 'invalid')).toBe(true);
  });
});

describe('entries', () => {
  it('parses export prefix, keys with dots/dashes, and = inside values', () => {
    const env = rt('export TOKEN=abc\nexport  SPACED=1\napi.key=x\nmy-key=y\nURL=postgres://u:p@h/db?a=b&c=d\n');
    expect(entryByKey(env, 'TOKEN').exported).toBe(true);
    expect(entryByKey(env, 'SPACED').exported).toBe(true);
    expect(entryByKey(env, 'URL').value).toBe('postgres://u:p@h/db?a=b&c=d');
    expect(codes(env)).toEqual([
      [3, 'non-portable-key'],
      [4, 'non-portable-key'],
    ]);
  });

  it('treats a key literally named export correctly', () => {
    const env = rt('export=1\nexport export=2\n');
    expect(entries(env).map((e) => [e.key, e.exported, e.value])).toEqual([
      ['export', false, '1'],
      ['export', true, '2'],
    ]);
  });

  it('parses empty values', () => {
    const env = rt("A=\nB=\"\"\nC=''\nD=   \nE= # only comment\n");
    expect(entries(env).map((e) => [e.key, e.value, e.quote])).toEqual([
      ['A', '', 'none'],
      ['B', '', 'double'],
      ['C', '', 'single'],
      ['D', '', 'none'],
      ['E', '', 'none'],
    ]);
    expect(entryByKey(env, 'E').inlineComment).toBe('only comment');
    expect(env.issues).toEqual([]);
  });

  it('handles inline comments: unquoted needs whitespace before #, quoted may follow directly', () => {
    const env = rt('A=v # note\nB=v#notcomment\nC="v" # note\nD=\'v\'#tight\nE="a # b"\nF=#hash\n');
    expect(entryByKey(env, 'A')).toMatchObject({ value: 'v', inlineComment: 'note' });
    expect(entryByKey(env, 'B')).toMatchObject({ value: 'v#notcomment', inlineComment: null });
    expect(entryByKey(env, 'C')).toMatchObject({ value: 'v', inlineComment: 'note' });
    expect(entryByKey(env, 'D')).toMatchObject({ value: 'v', inlineComment: 'tight' });
    expect(entryByKey(env, 'E')).toMatchObject({ value: 'a # b', inlineComment: null });
    expect(entryByKey(env, 'F')).toMatchObject({ value: '#hash', inlineComment: null });
    expect(codes(env)).toEqual([
      [2, 'hash-in-unquoted-value'],
      [6, 'hash-in-unquoted-value'],
    ]);
  });

  it('decodes double-quote escapes and flags unknown ones', () => {
    const env = rt('A="l1\\nl2\\tT\\r\\"q\\" \\\\"\nB="C:\\path"\n');
    expect(entryByKey(env, 'A').value).toBe('l1\nl2\tT\r"q" \\');
    expect(entryByKey(env, 'B').value).toBe('C:\\path');
    expect(codes(env)).toEqual([[2, 'unknown-escape']]);
  });

  it('keeps single quotes literal (no escapes)', () => {
    const env = rt("A='a\\nb $HOME \"x\"'\n");
    expect(entryByKey(env, 'A')).toMatchObject({ value: 'a\\nb $HOME "x"', hasInterpolation: false });
  });

  it('keeps backtick quotes literal and flags them', () => {
    const env = rt('A=`echo hi`\n');
    expect(entryByKey(env, 'A')).toMatchObject({ value: 'echo hi', quote: 'backtick' });
    expect(codes(env)).toEqual([[1, 'backtick-quote']]);
  });

  it('parses multiline single and double quoted values with exact line numbers', () => {
    const text = 'BEFORE=1\r\nKEY="-----BEGIN-----\r\nabc\\n\r\n-----END-----"  # pem\r\nS=\'x\ny\'\nAFTER=2\n';
    const env = rt(text);
    const key = entryByKey(env, 'KEY');
    expect(key).toMatchObject({ lineNumber: 2, endLineNumber: 4, multiline: true, inlineComment: 'pem', eol: '\r\n' });
    expect(key.value).toBe('-----BEGIN-----\nabc\n\n-----END-----');
    expect(entryByKey(env, 'S')).toMatchObject({ value: 'x\ny', lineNumber: 5, endLineNumber: 6 });
    expect(entryByKey(env, 'AFTER').lineNumber).toBe(7);
    expect(codes(env)).toEqual([
      [2, 'multiline-value'],
      [5, 'multiline-value'],
    ]);
  });

  it('warns when a multiline value swallows assignment-looking lines', () => {
    const env = rt('A="start\nB=2\nC=3"\n');
    expect(env.lines).toHaveLength(1);
    expect(codes(env)).toContainEqual([1, 'suspicious-multiline']);
  });

  it('handles # and = inside quotes, escaped quotes and unicode', () => {
    const env = rt('A="pa#ss=word"\nB="say \\"hi\\""\nC=héllo🔑日本\nD=\'q"uote\'\n');
    expect(entryByKey(env, 'A').value).toBe('pa#ss=word');
    expect(entryByKey(env, 'B').value).toBe('say "hi"');
    expect(entryByKey(env, 'C').value).toBe('héllo🔑日本');
    expect(entryByKey(env, 'D').value).toBe('q"uote');
  });

  it('accepts whitespace around = with a warning', () => {
    const env = rt('A = 1\nB= "x"\nC =2\n');
    expect(entries(env).map((e) => e.value)).toEqual(['1', 'x', '2']);
    expect(codes(env)).toEqual([
      [1, 'whitespace-around-equals'],
      [2, 'whitespace-around-equals'],
      [3, 'whitespace-around-equals'],
    ]);
  });

  it('accepts indented entries with an info note', () => {
    const env = rt('  A=1\n');
    expect(entryByKey(env, 'A').value).toBe('1');
    expect(codes(env)).toEqual([[1, 'leading-whitespace']]);
  });
});

describe('unsupported / malformed lines', () => {
  it('preserves invalid lines verbatim with correct line numbers and reasons', () => {
    const text = 'OK=1\nthis is garbage\n1BAD=x\nexport ONLY\n=novalue\nMY KEY=v\nQ="v" junk\nLAST=2';
    const env = rt(text);
    expect(env.lines.map((l) => l.kind)).toEqual(['entry', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'entry']);
    expect(env.lines[1]?.raw).toBe('this is garbage');
    expect(codes(env)).toEqual([
      [2, 'invalid-line'],
      [3, 'invalid-key'],
      [4, 'bare-export'],
      [5, 'invalid-key'],
      [6, 'invalid-key'],
      [7, 'trailing-garbage'],
    ]);
    expect(env.issues.every((i) => i.severity === 'error')).toBe(true);
    for (const line of env.lines) if (line.kind === 'invalid') expect(line.reason.length).toBeGreaterThan(10);
    expect(env.fullySupported).toBe(false);
  });

  it('does not let an unterminated quote swallow the rest of the file', () => {
    const env = rt('A="never closed\nB=2\nC=3\n');
    expect(env.lines.map((l) => l.kind)).toEqual(['invalid', 'entry', 'entry']);
    expect(codes(env)).toEqual([[1, 'unterminated-quote']]);
    expect(entryByKey(env, 'C').lineNumber).toBe(3);
  });

  it('treats a quote whose next closing quote is followed by garbage as unterminated', () => {
    const env = rt('A="open\nB="two"\n');
    expect(env.lines.map((l) => l.kind)).toEqual(['invalid', 'entry']);
    expect(codes(env)).toEqual([[1, 'unterminated-quote']]);
    expect(entryByKey(env, 'B').value).toBe('two');
  });

  it("rejects escaped single quotes (single quotes have no escapes)", () => {
    const env = rt("A='it\\'s'\n");
    expect(env.lines[0]?.kind).toBe('invalid');
  });

  it('never puts value text into issue messages', () => {
    const secret = 'SuPeRsEcReT';
    const env = rt(
      `A=${secret} # c\nB="${secret}\nC='${secret}' ${secret}\nD="${secret}\\q"\nE=\`${secret}\`\nF=$${secret}\nG=${secret}#x\nH="${secret}\nI=1"\n`,
    );
    expect(env.issues.length).toBeGreaterThan(4);
    expect(JSON.stringify(env.issues)).not.toContain(secret);
    for (const line of env.lines) if (line.kind === 'invalid') expect(line.reason).not.toContain(secret);
  });
});

describe('interpolation and command substitution are never evaluated', () => {
  it('keeps ${VAR}, $VAR, $(...) and backticks literally and flags them', () => {
    process.env.PASSVAULT_TEST_VAR = 'expanded!';
    const env = rt('A=${PASSVAULT_TEST_VAR}\nB="$PASSVAULT_TEST_VAR/x"\nC=$(echo pwned)\nD=`echo pwned`\nE=\'${PASSVAULT_TEST_VAR}\'\nF=price$5\n');
    expect(entryByKey(env, 'A')).toMatchObject({ value: '${PASSVAULT_TEST_VAR}', hasInterpolation: true });
    expect(entryByKey(env, 'B')).toMatchObject({ value: '$PASSVAULT_TEST_VAR/x', hasInterpolation: true });
    expect(entryByKey(env, 'C')).toMatchObject({ value: '$(echo pwned)', hasInterpolation: true });
    expect(entryByKey(env, 'D')).toMatchObject({ value: 'echo pwned', quote: 'backtick' });
    expect(entryByKey(env, 'E')).toMatchObject({ value: '${PASSVAULT_TEST_VAR}', hasInterpolation: false });
    expect(entryByKey(env, 'F')).toMatchObject({ value: 'price$5', hasInterpolation: false });
    const flagged = env.issues.filter((i) => i.code === 'interpolation-not-expanded').map((i) => i.key);
    expect(flagged).toEqual(['A', 'B', 'C']);
    delete process.env.PASSVAULT_TEST_VAR;
  });

  it('flags backticks inside unquoted values', () => {
    expect(entryByKey(rt('A=x`id`\n'), 'A').hasInterpolation).toBe(true);
  });
});

describe('duplicates', () => {
  it('reports every line of a duplicated key', () => {
    const env = rt('A=1\nB=1\nA=2\n# c\nA=3\nB=2\nC=1\n');
    expect(env.duplicates).toEqual({ A: [1, 3, 5], B: [2, 6] });
    const dupIssues = env.issues.filter((i) => i.code === 'duplicate-key');
    expect(dupIssues.map((i) => [i.lineNumber, i.key])).toEqual([
      [1, 'A'],
      [2, 'B'],
      [3, 'A'],
      [5, 'A'],
      [6, 'B'],
    ]);
    expect(dupIssues[0]?.message).toMatch(/lines 1, 3, 5/);
    expect(dupIssues[0]?.message).toMatch(/first or the last/);
    expect(env.fullySupported).toBe(true);
  });

  it('gives duplicate occurrences distinct ids', () => {
    const ids = entries(rt('A=1\nA=2\n')).map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('handles keys like __proto__ safely', () => {
    const env = rt('__proto__=1\n__proto__=2\nconstructor=3\n');
    expect(env.duplicates.__proto__).toEqual([1, 2]);
    expect(Object.keys(env.duplicates)).toEqual(['__proto__']);
  });
});
