import { describe, expect, it } from 'vitest';
import { diffEnv, entries, parseEnv, searchKeys, toDotenvObject } from '../src/index';

describe('diffEnv', () => {
  const left = parseEnv('SAME=s3cr3t-same\nCHANGED=old-s3cr3t\nREMOVED=gone-s3cr3t\nDUP=first\nDUP=last-s3cr3t\n');
  const right = parseEnv('# c\nSAME="s3cr3t-same"\nCHANGED=new-s3cr3t\nADDED=fresh-s3cr3t\nDUP=last-s3cr3t\n');

  it('reports statuses using the effective (last) occurrence', () => {
    expect(diffEnv(left, right)).toEqual([
      { key: 'SAME', status: 'unchanged', leftLine: 1, rightLine: 2 },
      { key: 'CHANGED', status: 'changed', leftLine: 2, rightLine: 3 },
      { key: 'REMOVED', status: 'removed', leftLine: 3 },
      { key: 'DUP', status: 'unchanged', leftLine: 5, rightLine: 5 },
      { key: 'ADDED', status: 'added', rightLine: 4 },
    ]);
  });

  it('never includes values in its output', () => {
    const json = JSON.stringify(diffEnv(left, right));
    for (const env of [left, right]) {
      for (const e of entries(env)) expect(json).not.toContain(e.value);
    }
    expect(json).not.toContain('s3cr3t');
  });

  it('handles empty inputs', () => {
    expect(diffEnv(parseEnv(''), parseEnv(''))).toEqual([]);
  });
});

describe('searchKeys', () => {
  const env = parseEnv('DATABASE_URL=x\nREDIS_URL=y\napi.key=url\n# URL comment\n');

  it('matches key names case-insensitively, never values', () => {
    expect(searchKeys(env, 'url').map((e) => e.key)).toEqual(['DATABASE_URL', 'REDIS_URL']);
    expect(searchKeys(env, 'API').map((e) => e.key)).toEqual(['api.key']);
    expect(searchKeys(env, '').length).toBe(3);
    expect(searchKeys(env, 'nomatch')).toEqual([]);
  });
});

describe('toDotenvObject', () => {
  it('uses the last occurrence and decoded values', () => {
    const obj = toDotenvObject(parseEnv('A=1\nB="x\\ny"\nA=2\nbad line\n__proto__=p\n'));
    expect(Object.entries(obj)).toEqual([
      ['A', '2'],
      ['B', 'x\ny'],
      ['__proto__', 'p'],
    ]);
    expect(Object.getPrototypeOf(obj)).toBeNull();
  });
});
