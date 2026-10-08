# `.env` files

Status: **implemented** in `packages/env-parser` (`@passvault/env-parser`, no runtime
dependencies). Tests: `packages/env-parser/test/*.test.ts`.

PassVault stores `.env` files as first-class vault items. The **raw text is the
authoritative content**; the parser exists only to *display* the file and to
make *structured edits* to it. It never executes anything, never runs shell
commands (`$(...)`, backticks) and never interpolates variables (`${VAR}`,
`$VAR`). Such content is shown literally and flagged.

## Guarantees

- **Lossless round trip.** For every string `s`,
  `serializeEnv(parseEnv(s)) === s`: BOM, per-line `\n` / `\r\n`, missing final
  newline, tabs, trailing whitespace, comments, blank lines, ordering, quoting,
  `export ` prefixes, inline comments and malformed lines are all preserved.
  Verified by property tests over thousands of random inputs, including lone
  UTF-16 surrogates.
- **Total.** `parseEnv` never throws. Unsupported content becomes an `invalid`
  line, kept verbatim and reported; it is never dropped or normalised.
- **Minimal edits.** A structured edit rewrites only the target line(s). Every
  other line is reproduced byte-for-byte. Each edit is verified by re-parsing.
  If the result would not read back exactly as intended, or would change how
  any other line parses, the edit is refused with an error. The parser does not
  guess.
- **No secrets in diagnostics.** Issue messages, invalid-line reasons and diff
  results contain only key names and line numbers, never value text.

## Supported syntax

Line numbers are 1-based physical lines. Only `\n` and `\r\n` end a line. A
lone `\r` stays in the line content and is reported (`stray-carriage-return`).
A leading U+FEFF BOM is stripped for parsing (`bom: true`) and written back on
serialization.

| Construct | Example | Notes |
|---|---|---|
| Blank line | `` / `   ` | Only spaces/tabs. |
| Full-line comment | `# text`, `  # text` | `#` after optional spaces/tabs. `text` is trimmed for display. |
| Assignment | `KEY=value` | |
| `export` prefix | `export KEY=value` | One or more spaces/tabs after `export`. Preserved; `exported: true`. A key literally named `export` (`export=1`) also works. |
| Whitespace around `=` | `KEY = value` | Accepted and preserved. Warning `whitespace-around-equals`, because shells and some loaders reject it. |
| Indented entry | `  KEY=value` | Accepted. Info `leading-whitespace`. |
| Key names | `[A-Za-z_][A-Za-z0-9_.-]*` | Keys containing `.` or `-` get warning `non-portable-key` (shells cannot use them). |
| Unquoted value | `KEY=some value` | Runs to end of line or to an inline comment. Leading/trailing spaces and tabs are trimmed from the displayed value but kept in raw. Backslashes are literal. |
| Inline comment (unquoted) | `KEY=value # note` | Starts at a `#` **preceded by a space or tab**. `KEY=a#b` has value `a#b` (warning `hash-in-unquoted-value`, since some loaders cut at `#`). `KEY= # note` is an empty value with a comment. |
| Single-quoted | `KEY='literal $X \n'` | Fully literal, no escapes (`'it\'s'` is invalid). May span lines. |
| Double-quoted | `KEY="a\nb"` | Escapes `\n` `\r` `\t` `\"` `\\` are decoded for display. Other `\x` sequences are kept literally (both characters), with info `unknown-escape`. May span lines. |
| Backtick-quoted | ``KEY=`text` `` | Kept literally, like single quotes. Warning `backtick-quote`: not supported by all loaders, and shells execute the content. |
| Multi-line value | `KEY="line1`⏎`line2"` | Quoted values may contain raw line breaks. A literal `\r\n` inside the value displays as `\n`; raw keeps it. Info `multiline-value`. Warning `suspicious-multiline` if a swallowed line looks like `KEY=...`. |
| After a closing quote | `KEY="v" # note`, `KEY="v"#note` | Only spaces/tabs and an optional `#` comment may follow. |
| Empty values | `KEY=`, `KEY=""`, `KEY=''` | |

### Interpolation and command substitution

Values containing `${...}`, `$NAME`, `$(...)` or a backtick get
`hasInterpolation: true` and info `interpolation-not-expanded`. The exception is
single-quoted values, which are literal in every loader. PassVault displays such
values literally. It does not expand, evaluate or execute them. The loader you
use at runtime may.

### Invalid lines (kept verbatim, `kind: 'invalid'`, severity `error`)

| Code | Cause |
|---|---|
| `invalid-line` | Not blank, not a comment, and no `=`. |
| `bare-export` | `export KEY` with no `=`. |
| `invalid-key` | Text before the first `=` is not a valid (optionally `export`-prefixed) key, e.g. `1KEY=x`, `MY KEY=x`, `=x`. |
| `trailing-garbage` | Text other than a comment after a closing quote on the same line (`KEY="v" junk`, `KEY='it\'s'`). |
| `unterminated-quote` | No closing quote before EOF, or the next matching quote is followed by garbage. |

**Unterminated quotes never swallow the file.** When a quote opened on line *N*
has no valid closing quote, only line *N* becomes `invalid` and parsing resumes
normally at line *N+1*. A "valid closing quote" is the next unescaped matching
quote character, followed only by whitespace and/or a comment. Everything in
between becomes part of the multi-line value. As a result, `A="x` followed later
by a line ending in `"` forms one multi-line entry. `suspicious-multiline`
flags this when the swallowed lines look like assignments.

`fullySupported` is `true` exactly when there are no `invalid` lines (no
error-level issues). Warnings and info do not affect it.

### Duplicate keys

`duplicates` maps each repeated key to **all** its line numbers. Each
occurrence gets a `duplicate-key` warning. Loaders differ on whether the first
or last definition wins. PassVault treats the **last** occurrence as effective
in `diffEnv` and `toDotenvObject`.

## API (`@passvault/env-parser`)

```ts
parseEnv(text: string): ParsedEnv
serializeEnv(parsed: ParsedEnv): string
entries(parsed): EntryLine[]                       // file order, all occurrences
searchKeys(parsed, query): EntryLine[]             // case-insensitive substring on KEY NAMES only
diffEnv(left, right): EnvDiffEntry[]               // effective (last) values compared, never returned
toDotenvObject(parsed): Record<string, string>     // last wins; null-prototype; PLAINTEXT SECRETS
formatValue(value, preferred = 'none'): { quote, text } | null

setValue(parsed, entryId, newValue): EditResult
renameKey(parsed, entryId, newKey): EditResult
addEntry(parsed, key, value, { comment?, afterEntryId? }?): EditResult
removeEntry(parsed, entryId): EditResult
setInlineComment(parsed, entryId, comment | null): EditResult

type EditResult = { ok: true; env: ParsedEnv; text: string; entryId?: string } | { ok: false; error: string }
```

`EditResult.entryId` is the id of the created or changed entry in the returned
`env`. It is absent for `removeEntry`.

### Entry ids

The id is `KEY#n`, where `n` is the 0-based occurrence index of that key in the
file. It is stable within a parse. It is unaffected by edits to *other* keys,
including lines added or removed above it. It changes on rename, and when an
earlier duplicate of the same key is removed. **Always use ids from the most
recent `ParsedEnv`** (the `env` returned by the last edit). A stale id returns
an error rather than editing the wrong line.

### How values are written

`formatValue` and the edit functions always write a value on **one line**.

- **Unquoted** only if the value has no whitespace, quotes, `#`, `\` or `$`. This
  stops loaders from re-interpreting the value.
- Otherwise **single quotes**, if the value has no `'` and no line break.
- Otherwise **double quotes**, with `\` → `\\`, `"` → `\"`, LF → `\n`, CR → `\r`.

`setValue` prefers the entry's existing style (single, double or backtick) and
falls back along the same chain. Newlines therefore turn an unquoted or
single-quoted value into a double-quoted one with `\n` escapes, and a
multi-line entry is rewritten as a single line. Values containing NUL are
refused.

Other edit behaviour:

- `setValue`, `renameKey` and `setInlineComment` preserve the `export` prefix,
  indentation, spacing around `=`, the inline comment, and the line ending.
- `addEntry` writes `KEY=value` (plus ` # comment` when `comment` is given)
  using the file's dominant line ending. When the file lacked a final newline,
  the previous last line gets one and the new line becomes the unterminated
  last line. Keys that already exist are refused.
- `renameKey` refuses invalid keys and keys that already exist.
- `removeEntry` deletes all physical lines of the entry and nothing else.

## Limitations

- Not supported (reported as invalid, never dropped): `KEY: value` (YAML style),
  bare `export KEY`, keys with other characters, and escaped single quotes.
- A trailing `\` on an unquoted value is not a line continuation. It is kept
  literally as part of the value.
- Interpolation is never performed. Values that rely on `${VAR}` show the
  unexpanded text.
- Double-quote escape decoding follows the common subset (`\n \r \t \" \\`).
  Loaders that decode only `\n`, or that also decode `\uXXXX`, will show a
  different runtime value than PassVault displays.
- Display values normalise literal `\r\n` inside multi-line quoted values to
  `\n`. `diffEnv` compares these display values, so CRLF and LF versions of
  the same multi-line value compare as `unchanged`.
- Edits never produce literal multi-line values, and `removeEntry` does not
  adjust neighbouring line endings.
- An edit that would change how other lines parse is refused. This happens
  when an earlier unterminated quote would close inside the new text. Fix the
  invalid line, or edit the raw text instead.
