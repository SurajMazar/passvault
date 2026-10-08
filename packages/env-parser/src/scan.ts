import type { PhysicalLine } from './lines';
import type { EnvIssue, IssueCode, QuoteStyle } from './types';

/** Valid key name. Dots and dashes are accepted but flagged as non-portable. */
export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PORTABLE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Everything left of the first `=`: optional indentation, optional `export `, key, optional spaces. */
const LEFT_RE = /^([ \t]*)(export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)([ \t]*)$/;
/** An entry's head segment (everything before the value). Used by edits. */
export const HEAD_RE = /^([ \t]*)(export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)([ \t]*=[ \t]*)$/;
const BARE_EXPORT_RE = /^[ \t]*export[ \t]+[A-Za-z_][A-Za-z0-9_.-]*[ \t]*$/;
/** What may follow a closing quote: optional spaces, optional `#` comment. */
const QUOTED_TAIL_RE = /^[ \t]*(?:#[^]*)?$/;
const ASSIGNMENT_LIKE_RE = /^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_.-]*[ \t]*=/;
const INTERPOLATION_RE = /\$\{|\$\(|\$[A-Za-z_]|`/;

type QuoteChar = "'" | '"' | '`';
const QUOTE_STYLE: Record<QuoteChar, Exclude<QuoteStyle, 'none'>> = {
  "'": 'single',
  '"': 'double',
  '`': 'backtick',
};

/**
 * Segments of an entry's raw text: `head + valueRaw + tail === raw`.
 * head = indentation, `export `, key, `=` and surrounding spaces;
 * valueRaw = the value as written (including quotes);
 * tail = whatever follows (trailing spaces and/or inline comment).
 */
export interface EntrySegments {
  head: string;
  valueRaw: string;
  tail: string;
}

export interface ScannedEntry {
  raw: string;
  key: string;
  value: string;
  quote: QuoteStyle;
  exported: boolean;
  inlineComment: string | null;
  multiline: boolean;
  hasInterpolation: boolean;
}

export type ScanResult =
  | { kind: 'blank'; consumed: 1 }
  | { kind: 'comment'; consumed: 1; text: string }
  | { kind: 'invalid'; consumed: 1; issue: EnvIssue }
  | { kind: 'entry'; consumed: number; entry: ScannedEntry; segments: EntrySegments; issues: EnvIssue[] };

interface Pos {
  line: number;
  col: number;
}

/** Index of the first closing `q` in `content` at or after `from`, honouring `\` escapes for `"`. */
function findQuoteInLine(content: string, from: number, q: QuoteChar): number {
  for (let p = from; p < content.length; p++) {
    const ch = content[p];
    if (q === '"' && ch === '\\') {
      p++;
      continue;
    }
    if (ch === q) return p;
  }
  return -1;
}

/**
 * Lazily-built lookup "first closing quote at or after the start of line k".
 * Escape state never carries across a line break, so the answer for a line
 * start is independent of where the quote was opened. This keeps parsing
 * linear even for files full of unterminated quotes.
 */
export class QuoteIndex {
  private readonly cache = new Map<QuoteChar, Array<Pos | null>>();

  constructor(private readonly phys: readonly PhysicalLine[]) {}

  fromLineStart(q: QuoteChar, k: number): Pos | null {
    if (k >= this.phys.length) return null;
    let table = this.cache.get(q);
    if (!table) {
      table = new Array<Pos | null>(this.phys.length + 1).fill(null);
      for (let line = this.phys.length - 1; line >= 0; line--) {
        const col = findQuoteInLine(this.phys[line]?.content ?? '', 0, q);
        table[line] = col >= 0 ? { line, col } : (table[line + 1] ?? null);
      }
      this.cache.set(q, table);
    }
    return table[k] ?? null;
  }
}

function decodeDouble(inner: string): { value: string; unknownEscape: boolean } {
  let value = '';
  let unknownEscape = false;
  for (let p = 0; p < inner.length; p++) {
    const ch = inner[p];
    if (ch === '\\') {
      const next = inner[p + 1];
      if (next === 'n') value += '\n';
      else if (next === 'r') value += '\r';
      else if (next === 't') value += '\t';
      else if (next === '"') value += '"';
      else if (next === '\\') value += '\\';
      else {
        // Unknown escape: keep the backslash literally; the next char is processed normally.
        unknownEscape = true;
        value += '\\';
        continue;
      }
      p++;
    } else if (ch === '\r' && inner[p + 1] === '\n') {
      value += '\n';
      p++;
    } else {
      value += ch;
    }
  }
  return { value, unknownEscape };
}

function issue(
  severity: EnvIssue['severity'],
  lineNumber: number,
  code: IssueCode,
  message: string,
  key?: string,
): EnvIssue {
  return key === undefined ? { severity, lineNumber, code, message } : { severity, lineNumber, code, message, key };
}

function invalid(lineNumber: number, code: IssueCode, message: string, key?: string): ScanResult {
  return { kind: 'invalid', consumed: 1, issue: issue('error', lineNumber, code, message, key) };
}

/**
 * Scans the logical line starting at physical line `i`.
 * `lineNumber` is the 1-based number used in issues.
 */
export function scanLogicalLine(
  phys: readonly PhysicalLine[],
  i: number,
  lineNumber: number,
  quotes: QuoteIndex,
): ScanResult {
  const first = phys[i];
  if (!first) throw new RangeError(`no physical line ${i}`);
  const content = first.content;

  if (/^[ \t]*$/.test(content)) return { kind: 'blank', consumed: 1 };
  const commentMatch = /^[ \t]*#/.exec(content);
  if (commentMatch) return { kind: 'comment', consumed: 1, text: content.slice(commentMatch[0].length).trim() };

  const eq = content.indexOf('=');
  if (eq < 0) {
    if (BARE_EXPORT_RE.test(content)) {
      return invalid(
        lineNumber,
        'bare-export',
        "`export KEY` without '=' is shell syntax for exporting an existing variable; it defines no value and is not supported.",
      );
    }
    return invalid(lineNumber, 'invalid-line', "Not a comment and has no '=': expected KEY=value.");
  }

  const left = LEFT_RE.exec(content.slice(0, eq));
  if (!left) {
    return invalid(
      lineNumber,
      'invalid-key',
      "Text before '=' is not a valid key. Keys must start with a letter or '_' and contain only letters, digits, '_', '.' or '-' (optionally preceded by 'export ').",
    );
  }
  const indent = left[1] ?? '';
  const exportPrefix = left[2];
  const key = left[3] ?? '';
  const wsBefore = left[4] ?? '';
  const wsAfter = /^[ \t]*/.exec(content.slice(eq + 1))?.[0] ?? '';
  const valueStart = eq + 1 + wsAfter.length;
  const opener = content[valueStart];

  const issues: EnvIssue[] = [];
  if (indent !== '') {
    issues.push(issue('info', lineNumber, 'leading-whitespace', `Key "${key}" is indented; some loaders do not accept leading whitespace.`, key));
  }
  if (!PORTABLE_KEY_RE.test(key)) {
    issues.push(
      issue('warning', lineNumber, 'non-portable-key', `Key "${key}" contains '.' or '-', which shells cannot use as a variable name.`, key),
    );
  }

  let raw: string;
  let value: string;
  let quote: QuoteStyle;
  let inlineComment: string | null;
  let segments: EntrySegments;
  let endLine = i;

  if (opener === "'" || opener === '"' || opener === '`') {
    const q: QuoteChar = opener;
    quote = QUOTE_STYLE[q];
    const inLine = findQuoteInLine(content, valueStart + 1, q);
    const close: Pos | null = inLine >= 0 ? { line: i, col: inLine } : quotes.fromLineStart(q, i + 1);
    if (!close) {
      return invalid(
        lineNumber,
        'unterminated-quote',
        `Unterminated ${quote} quote for key "${key}": no closing ${q} before end of file. Only this line is treated as invalid; parsing continues on the next line.`,
        key,
      );
    }
    const closeContent = phys[close.line]?.content ?? '';
    const tail = closeContent.slice(close.col + 1);
    if (!QUOTED_TAIL_RE.test(tail)) {
      if (close.line === i) {
        return invalid(
          lineNumber,
          'trailing-garbage',
          `Unexpected text after the closing quote of "${key}" (only spaces or a '# comment' may follow).`,
          key,
        );
      }
      return invalid(
        lineNumber,
        'unterminated-quote',
        `Unterminated ${quote} quote for key "${key}": the next ${q} (line ${close.line + 1}) is followed by unexpected text. Only this line is treated as invalid; parsing continues on the next line.`,
        key,
      );
    }

    let inner: string;
    if (close.line === i) {
      raw = content;
      inner = content.slice(valueStart + 1, close.col);
    } else {
      raw = content + first.eol;
      inner = content.slice(valueStart + 1) + first.eol;
      for (let k = i + 1; k < close.line; k++) {
        const line = phys[k];
        if (!line) break;
        raw += line.content + line.eol;
        inner += line.content + line.eol;
      }
      raw += closeContent;
      inner += closeContent.slice(0, close.col);
      endLine = close.line;
    }

    if (q === '"') {
      const decoded = decodeDouble(inner);
      value = decoded.value;
      if (decoded.unknownEscape) {
        issues.push(
          issue(
            'info',
            lineNumber,
            'unknown-escape',
            `Value of "${key}" contains a backslash sequence other than \\n \\r \\t \\" \\\\; it is shown literally (loaders differ).`,
            key,
          ),
        );
      }
    } else {
      value = inner.replace(/\r\n/g, '\n');
    }
    if (q === '`') {
      issues.push(
        issue(
          'warning',
          lineNumber,
          'backtick-quote',
          `Backtick-quoted value for "${key}" is not supported by all loaders (shells execute backtick content as a command). PassVault shows it literally.`,
          key,
        ),
      );
    }
    const hash = tail.indexOf('#');
    inlineComment = hash >= 0 ? tail.slice(hash + 1).trim() : null;
    segments = { head: content.slice(0, valueStart), valueRaw: raw.slice(valueStart, raw.length - tail.length), tail };
    if (wsBefore !== '' || wsAfter !== '') {
      issues.push(whitespaceIssue(lineNumber, key));
    }
  } else {
    quote = 'none';
    raw = content;
    let commentPos = -1;
    for (let p = valueStart; p < content.length; p++) {
      if (content[p] === '#' && (content[p - 1] === ' ' || content[p - 1] === '\t')) {
        commentPos = p;
        break;
      }
    }
    value = content.slice(valueStart, commentPos >= 0 ? commentPos : content.length).replace(/[ \t]+$/, '');
    inlineComment = commentPos >= 0 ? content.slice(commentPos + 1).trim() : null;
    segments =
      value === ''
        ? { head: content.slice(0, eq + 1), valueRaw: '', tail: content.slice(eq + 1) }
        : { head: content.slice(0, valueStart), valueRaw: value, tail: content.slice(valueStart + value.length) };
    if (wsBefore !== '' || (wsAfter !== '' && value !== '')) {
      issues.push(whitespaceIssue(lineNumber, key));
    }
    if (value.includes('#')) {
      issues.push(
        issue(
          'warning',
          lineNumber,
          'hash-in-unquoted-value',
          `Unquoted value of "${key}" contains '#'; some loaders treat it as the start of a comment. Quote the value to be safe.`,
          key,
        ),
      );
    }
  }

  const multiline = endLine > i;
  if (multiline) {
    issues.push(
      issue(
        'info',
        lineNumber,
        'multiline-value',
        `Value of "${key}" spans lines ${lineNumber}-${lineNumber + endLine - i}; multi-line values are not supported by all loaders.`,
        key,
      ),
    );
    for (let k = i + 1; k <= endLine; k++) {
      if (ASSIGNMENT_LIKE_RE.test(phys[k]?.content ?? '')) {
        issues.push(
          issue(
            'warning',
            lineNumber,
            'suspicious-multiline',
            `The quoted value of "${key}" continues over line ${lineNumber + k - i}, which looks like a KEY=value assignment. If unintended, a closing quote is missing.`,
            key,
          ),
        );
        break;
      }
    }
  }

  const hasInterpolation = quote !== 'single' && INTERPOLATION_RE.test(value);
  if (hasInterpolation) {
    issues.push(
      issue(
        'info',
        lineNumber,
        'interpolation-not-expanded',
        `Value of "${key}" contains \${...}, $VAR, $(...) or backticks. PassVault shows it literally and never expands or executes it; your loader may.`,
        key,
      ),
    );
  }

  return {
    kind: 'entry',
    consumed: endLine - i + 1,
    entry: { raw, key, value, quote, exported: exportPrefix !== undefined, inlineComment, multiline, hasInterpolation },
    segments,
    issues,
  };
}

function whitespaceIssue(lineNumber: number, key: string): EnvIssue {
  return issue(
    'warning',
    lineNumber,
    'whitespace-around-equals',
    `Whitespace around '=' for "${key}"; some loaders (and shells) reject or misread it.`,
    key,
  );
}
