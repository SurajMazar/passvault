import { expect } from 'vitest';
import type { EditResult, EntryLine, EnvLine, ParsedEnv } from '../src/index';

/** Deterministic PRNG (mulberry32) so fuzz failures are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

export function entryByKey(env: ParsedEnv, key: string): EntryLine {
  const found = env.lines.find((l): l is EntryLine => l.kind === 'entry' && l.key === key);
  if (!found) throw new Error(`no entry ${key}`);
  return found;
}

export function expectOk(result: EditResult): Extract<EditResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result;
}

/**
 * Asserts that `after` equals `before` except at `changed` indexes of `before`
 * (removed/replaced) — every other line's raw + eol is byte-identical and in order.
 */
export function expectOnlyChanged(
  before: readonly EnvLine[],
  after: readonly EnvLine[],
  opts: { replaced?: number; removed?: number; insertedAt?: number; eolChangedAt?: number },
): void {
  const expected: Array<{ raw: string; eol: string } | null> = before.map((l) => ({ raw: l.raw, eol: l.eol }));
  if (opts.replaced !== undefined) expected[opts.replaced] = null;
  if (opts.removed !== undefined) expected.splice(opts.removed, 1);
  if (opts.insertedAt !== undefined) expected.splice(opts.insertedAt, 0, null);
  expect(after.length).toBe(expected.length);
  expected.forEach((want, k) => {
    const got = after[k];
    if (want === null || !got) return;
    expect(got.raw).toBe(want.raw);
    if (k !== opts.eolChangedAt) expect(got.eol).toBe(want.eol);
  });
}
