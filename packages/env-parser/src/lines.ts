import type { LineEnding } from './types';

export interface PhysicalLine {
  /** Line content without its terminator. May contain a lone `\r`. */
  content: string;
  eol: LineEnding;
}

/**
 * Splits text into physical lines. Only `\n` and `\r\n` terminate a line; a lone
 * `\r` stays part of the content. A final empty segment (text ending in a
 * terminator, or empty text) produces no line, so `lines.map(c + eol).join('')`
 * reproduces the input exactly.
 */
export function splitPhysicalLines(text: string): PhysicalLine[] {
  const out: PhysicalLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    const crlf = i > start && text.charCodeAt(i - 1) === 13;
    out.push({ content: text.slice(start, crlf ? i - 1 : i), eol: crlf ? '\r\n' : '\n' });
    start = i + 1;
  }
  if (start < text.length) out.push({ content: text.slice(start), eol: '' });
  return out;
}

/** Most common line terminator in `text` (`\n` on ties or when there is none). */
export function dominantLineEnding(text: string): '\n' | '\r\n' {
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}
