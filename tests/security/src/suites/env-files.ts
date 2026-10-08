import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffEnv, entries, parseEnv, serializeEnv, setValue, toDotenvObject } from '@passvault/env-parser';
import { assert } from '../lib/results';
import type { Suite } from '../lib/suite';
import { gitGrep } from '../lib/util';
import { vitestCheck } from '../lib/vitest';

/** Deterministic PRNG so fuzz failures are reproducible from the printed seed. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  'KEY=value',
  'export TOKEN=abc123',
  'QUOTED="hello world"',
  "SINGLE='it''s'",
  'MULTI="line one\nline two\nline three"',
  'URL=https://example.com/?a=1&b=2 # inline comment',
  '# full line comment',
  '',
  '   ',
  'EMPTY=',
  'SPACES = around',
  'UNICODE=päss✓wörd-日本',
  'SUBST=$(touch /tmp/pv-env-canary)',
  'BACKTICK=`id`',
  'INTERP=${HOME}/x',
  'HTML=<script>alert(1)</script>',
  'DUP=first',
  'DUP=second',
  'not a valid line',
  'BAD KEY=x',
  '=novalue',
  'UNTERMINATED="abc',
  'ESC="tab\\tnew\\nquote\\"end"',
  'JSON={"a":[1,2,{"b":null}]}',
];

function randomEnv(r: () => number): string {
  const n = Math.floor(r() * 14);
  const eol = r() < 0.3 ? '\r\n' : '\n';
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(PIECES[Math.floor(r() * PIECES.length)]!.replace(/\n/g, eol));
  return lines.join(eol) + (r() < 0.5 ? eol : '');
}

const suite: Suite = {
  id: 'env-files',
  title: '.env import, editing and export',
  needsApi: false,
  async run({ t }) {
    await t.check('env.no-exec.static', 'The env parser has no code-execution or process primitives', () => {
      const hits = gitGrep('child_process|\\beval\\(|new Function|\\bimport\\(|spawn|execSync|process\\.env', ['packages/env-parser/src'], { extended: true });
      return { ok: hits.length === 0, evidence: hits.length ? hits.join('\n') : 'no child_process/eval/Function/dynamic import/process.env in packages/env-parser/src' };
    }, { severity: 'critical' });

    await t.check('env.no-exec.dynamic', 'Importing, editing, diffing and exporting shell-substitution content never executes it', () => {
      const marker = join(tmpdir(), `pv-env-canary-${process.pid}`);
      rmSync(marker, { force: true });
      const text = `A=$(touch ${marker})\nB=\`touch ${marker}\`\nC="\${X:-$(touch ${marker})}"\n`;
      const p = parseEnv(text);
      const es = entries(p);
      setValue(p, es[0]!.id, `$(touch ${marker})-edited`);
      diffEnv(p, parseEnv(serializeEnv(p)));
      toDotenvObject(p);
      assert(!existsSync(marker), 'marker file was created');
      assert(es[0]!.hasInterpolation && es[2]!.hasInterpolation, '$(…) / ${…} not flagged as interpolation');
      // dotenv treats backticks as a quote style: literal text plus a warning (never command substitution).
      assert(es[1]!.quote === 'backtick' && p.issues.some((i) => i.code === 'backtick-quote'), 'backtick value not reported');
      assert(es[0]!.value === `$(touch ${marker})`, 'value was not kept literally');
      return { ok: true, evidence: 'values kept literally; $(…)/${…} flagged hasInterpolation, backticks parsed as a quote style with a warning; no marker file created' };
    }, { severity: 'critical' });

    await t.check('env.roundtrip.fuzz', 'Raw → structured → raw is byte-for-byte lossless, including invalid and unsupported lines (5,000 random files)', () => {
      const seed = 20261008;
      const r = rng(seed);
      for (let i = 0; i < 5000; i++) {
        const text = randomEnv(r);
        const out = serializeEnv(parseEnv(text));
        assert(out === text, `case ${i} (seed ${seed}) changed:\n${JSON.stringify(text)}\n→\n${JSON.stringify(out)}`);
      }
      return { ok: true, evidence: `5000 generated files (seed ${seed}) incl. CRLF, multiline, duplicates, invalid lines, unterminated quotes` };
    }, { severity: 'high' });

    await t.check('env.edit.fuzz', 'Structured edits change only the target entry; unsafe edits are refused, never applied partially (3,000 edits)', () => {
      const seed = 4242;
      const r = rng(seed);
      let applied = 0;
      let refused = 0;
      const values = ['plain', 'with space', 'quote"inside', "single'quote", 'multi\nline', '#hash', 'x=y', '$(id)', '日本', ''];
      for (let i = 0; i < 3000; i++) {
        const text = randomEnv(r);
        const p = parseEnv(text);
        const es = entries(p);
        if (!es.length) continue;
        const target = es[Math.floor(r() * es.length)]!;
        const v = values[Math.floor(r() * values.length)]!;
        const res = setValue(p, target.id, v);
        if (!res.ok) {
          refused++;
          continue;
        }
        applied++;
        const after = parseEnv(res.text);
        const edited = entries(after).find((e) => e.id === target.id);
        assert(edited && edited.value === v, `case ${i} (seed ${seed}): edited value differs`);
        const others = (lines: typeof p.lines) => lines.filter((l) => !(l.kind === 'entry' && l.id === target.id)).map((l) => l.raw);
        assert(JSON.stringify(others(after.lines)) === JSON.stringify(others(p.lines)), `case ${i} (seed ${seed}): other lines changed`);
      }
      return { ok: true, evidence: `${applied} edits applied exactly, ${refused} refused (seed ${seed})` };
    }, { severity: 'high' });

    await t.check('env.issues.no-values', 'Parser issue messages never contain value text', () => {
      const canary = 'CANARYvalue-9f8e7d';
      const text = `DUP=${canary}\nDUP=${canary}\nBAD KEY=${canary}\nX="${canary}\nY = ${canary}\n`;
      const p = parseEnv(text);
      const msgs = JSON.stringify(p.issues) + JSON.stringify(p.lines.filter((l) => l.kind === 'invalid').map((l) => (l as { reason: string }).reason));
      return { ok: !msgs.includes(canary) && p.issues.length > 0, evidence: `${p.issues.length} issues reported; canary ${msgs.includes(canary) ? 'FOUND' : 'absent'} in messages` };
    }, { severity: 'medium' });

    await t.check('env.resource-limits', 'Large and pathological inputs parse in bounded time (no catastrophic backtracking)', () => {
      const cases: Array<[string, string]> = [
        ['5 MB value', `BIG=${'x'.repeat(5 * 1024 * 1024)}\n`],
        ['100k escaped quotes', `Q="${'\\"'.repeat(100_000)}`],
        ['50k lines', Array.from({ length: 50_000 }, (_, i) => `K${i}=v${i}`).join('\n')],
        ['unterminated quote + 20k lines', `A="${'\nline'.repeat(20_000)}`],
      ];
      const times: string[] = [];
      for (const [name, text] of cases) {
        const t0 = performance.now();
        const out = serializeEnv(parseEnv(text));
        const ms = performance.now() - t0;
        assert(out === text, `${name}: not lossless`);
        assert(ms < 5000, `${name}: ${ms.toFixed(0)} ms`);
        times.push(`${name} ${ms.toFixed(0)} ms`);
      }
      return { ok: true, evidence: times.join('; ') };
    }, { severity: 'medium' });

    await vitestCheck(t, 'env.unit-tests', 'env-parser unit tests (parse, edit, query, round-trip)', 'packages/env-parser', { severity: 'high' });
    t.notApplicable('env.export.path', 'Desktop export path/symlink handling', 'covered by security/native (Go fsops tests: traversal, symlinks, permissions)');
  },
};

export default suite;
