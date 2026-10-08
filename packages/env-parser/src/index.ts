/**
 * @passvault/env-parser — lossless `.env` parser for DISPLAY and STRUCTURED
 * EDITING only. Nothing is ever executed, expanded or interpolated.
 * See docs/ENV_FILES.md for the exact supported syntax.
 */
export type {
  BlankLine,
  CommentLine,
  EditResult,
  EntryLine,
  EnvDiffEntry,
  EnvIssue,
  EnvLine,
  InvalidLine,
  IssueCode,
  IssueSeverity,
  LineEnding,
  ParsedEnv,
  QuoteStyle,
} from './types';
export type { WritableQuote } from './format';
export { parseEnv, serializeEnv } from './parse';
export { formatValue } from './format';
export { entries, diffEnv, searchKeys, toDotenvObject } from './query';
export { setValue, renameKey, addEntry, removeEntry, setInlineComment } from './edit';
