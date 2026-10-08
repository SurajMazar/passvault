import type { QuoteStyle } from './types';

export type WritableQuote = 'none' | 'single' | 'double';

/**
 * Characters that make an unquoted value unsafe to write: whitespace (incl.
 * newlines), quotes, `#` (comment in some loaders), `\` (escape in shells) and
 * `$` (interpolation in shells / dotenv-expand / Docker Compose).
 */
const UNQUOTED_SAFE_RE = /^[^\s'"`#\\$]*$/;

function encode(value: string, quote: QuoteStyle): string | null {
  switch (quote) {
    case 'none':
      return UNQUOTED_SAFE_RE.test(value) ? value : null;
    case 'single':
      return /['\r\n]/.test(value) ? null : `'${value}'`;
    case 'backtick':
      return /[`\r\n]/.test(value) ? null : `\`${value}\``;
    case 'double':
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  }
}

const FALLBACKS: Record<QuoteStyle, QuoteStyle[]> = {
  none: ['none', 'single', 'double'],
  single: ['single', 'double'],
  double: ['double'],
  backtick: ['backtick', 'double'],
};

/**
 * Encodes `value` using `preferred` quoting when that can represent it
 * exactly, otherwise falls back (none → single → double; single → double).
 * Values are always written on ONE line (newlines become `\n` escapes inside
 * double quotes). Returns `null` for values that are refused (NUL characters).
 */
export function formatValue(
  value: string,
  preferred: WritableQuote = 'none',
): { quote: WritableQuote; text: string } | null {
  const result = formatValueAs(value, preferred);
  return result && result.quote !== 'backtick' ? { quote: result.quote, text: result.text } : null;
}

/** Like formatValue but may keep an existing backtick style. Internal. */
export function formatValueAs(value: string, preferred: QuoteStyle): { quote: QuoteStyle; text: string } | null {
  if (value.includes('\0')) return null;
  for (const quote of FALLBACKS[preferred]) {
    const text = encode(value, quote);
    if (text !== null) return { quote, text };
  }
  return null;
}
