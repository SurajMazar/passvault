import { splitPhysicalLines } from './lines';
import { QuoteIndex, scanLogicalLine } from './scan';
import type { EntryLine, EnvIssue, EnvLine, ParsedEnv } from './types';

const BOM = '﻿';

/**
 * Parses `.env` text for display and structured editing. Never executes,
 * expands or interpolates anything. Total: never throws for any string, and
 * `serializeEnv(parseEnv(s)) === s` for every `s`.
 */
export function parseEnv(text: string): ParsedEnv {
  const bom = text.startsWith(BOM);
  const phys = splitPhysicalLines(bom ? text.slice(1) : text);
  const quotes = new QuoteIndex(phys);
  const lines: EnvLine[] = [];
  const issues: EnvIssue[] = [];
  const occurrences = new Map<string, number[]>();

  phys.forEach((line, idx) => {
    if (line.content.includes('\r')) {
      issues.push({
        severity: 'warning',
        lineNumber: idx + 1,
        code: 'stray-carriage-return',
        message: 'Line contains a carriage return (\\r) that is not part of a \\r\\n line ending; it is kept as-is.',
      });
    }
  });

  let i = 0;
  while (i < phys.length) {
    const lineNumber = i + 1;
    const result = scanLogicalLine(phys, i, lineNumber, quotes);
    const last = phys[i + result.consumed - 1];
    const eol = last?.eol ?? '';
    switch (result.kind) {
      case 'blank':
        lines.push({ kind: 'blank', raw: phys[i]?.content ?? '', eol, lineNumber });
        break;
      case 'comment':
        lines.push({ kind: 'comment', raw: phys[i]?.content ?? '', eol, lineNumber, text: result.text });
        break;
      case 'invalid':
        lines.push({ kind: 'invalid', raw: phys[i]?.content ?? '', eol, lineNumber, reason: result.issue.message });
        issues.push(result.issue);
        break;
      case 'entry': {
        const seen = occurrences.get(result.entry.key) ?? [];
        const entry: EntryLine = {
          kind: 'entry',
          ...result.entry,
          eol,
          lineNumber,
          endLineNumber: lineNumber + result.consumed - 1,
          id: `${result.entry.key}#${seen.length}`,
        };
        seen.push(lineNumber);
        occurrences.set(result.entry.key, seen);
        lines.push(entry);
        issues.push(...result.issues);
        break;
      }
    }
    i += result.consumed;
  }

  const duplicates: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
  for (const [key, lineNumbers] of occurrences) {
    if (lineNumbers.length < 2) continue;
    duplicates[key] = lineNumbers;
    for (const lineNumber of lineNumbers) {
      issues.push({
        severity: 'warning',
        lineNumber,
        code: 'duplicate-key',
        key,
        message: `Key "${key}" is defined ${lineNumbers.length} times (lines ${lineNumbers.join(', ')}). Loaders differ on whether the first or the last definition wins; PassVault treats the last one as effective.`,
      });
    }
  }

  issues.sort((a, b) => a.lineNumber - b.lineNumber);
  return { lines, issues, bom, duplicates, fullySupported: !issues.some((x) => x.severity === 'error') };
}

/** Reproduces the original text exactly (byte-for-byte for an unmodified parse). */
export function serializeEnv(parsed: ParsedEnv): string {
  let out = parsed.bom ? BOM : '';
  for (const line of parsed.lines) out += line.raw + line.eol;
  return out;
}
