/** Line terminator of a physical line. `''` means "last line, no terminator". */
export type LineEnding = '\n' | '\r\n' | '';

export type QuoteStyle = 'none' | 'single' | 'double' | 'backtick';

export interface BlankLine {
  kind: 'blank';
  raw: string;
  eol: LineEnding;
  lineNumber: number;
}

export interface CommentLine {
  kind: 'comment';
  raw: string;
  eol: LineEnding;
  lineNumber: number;
  /** Text after the leading `#`, trimmed. Display only; `raw` is authoritative. */
  text: string;
}

export interface EntryLine {
  kind: 'entry';
  /**
   * Exact source text of the entry. For multi-line quoted values this spans
   * several physical lines and contains their original internal line endings.
   */
  raw: string;
  /** Line ending after the entry's last physical line. */
  eol: LineEnding;
  /** 1-based physical line number where the entry starts. */
  lineNumber: number;
  /** 1-based physical line number where the entry ends (=== lineNumber unless multiline). */
  endLineNumber: number;
  key: string;
  /** Decoded value for DISPLAY. Never interpolated or executed. */
  value: string;
  quote: QuoteStyle;
  exported: boolean;
  /** Text after the inline `#`, trimmed; `null` when there is no inline comment. */
  inlineComment: string | null;
  multiline: boolean;
  /** Value contains `${...}`, `$VAR`, `$(...)` or backticks. Kept literally; informational only. */
  hasInterpolation: boolean;
  /** `${key}#${occurrenceIndex}` — stable within a parse; always use ids from the latest ParsedEnv. */
  id: string;
}

export interface InvalidLine {
  kind: 'invalid';
  raw: string;
  eol: LineEnding;
  lineNumber: number;
  /** Human-readable reason. Never contains value text. */
  reason: string;
}

export type EnvLine = BlankLine | CommentLine | EntryLine | InvalidLine;

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface EnvIssue {
  severity: IssueSeverity;
  lineNumber: number;
  code: IssueCode;
  /** Human-readable message. Never contains (secret) value text — only key names and line numbers. */
  message: string;
  key?: string;
}

export type IssueCode =
  | 'invalid-line'
  | 'invalid-key'
  | 'bare-export'
  | 'unterminated-quote'
  | 'trailing-garbage'
  | 'duplicate-key'
  | 'whitespace-around-equals'
  | 'non-portable-key'
  | 'backtick-quote'
  | 'hash-in-unquoted-value'
  | 'multiline-value'
  | 'suspicious-multiline'
  | 'unknown-escape'
  | 'interpolation-not-expanded'
  | 'leading-whitespace'
  | 'stray-carriage-return';

export interface ParsedEnv {
  lines: EnvLine[];
  /** Sorted by line number. */
  issues: EnvIssue[];
  /** Input started with U+FEFF (re-emitted by serializeEnv). */
  bom: boolean;
  /** Keys defined more than once → every line number defining them. */
  duplicates: Record<string, number[]>;
  /** True when no line is `invalid` (no error-level issues). Warnings/info do not affect this. */
  fullySupported: boolean;
}

export type EditResult =
  | {
      ok: true;
      env: ParsedEnv;
      text: string;
      /** Id (in `env`) of the entry that was created/changed; absent for removals. */
      entryId?: string;
    }
  | { ok: false; error: string };

export interface EnvDiffEntry {
  key: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  leftLine?: number;
  rightLine?: number;
}
