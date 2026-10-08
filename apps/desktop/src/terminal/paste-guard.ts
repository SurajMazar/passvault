/**
 * Paste protection for the embedded terminal. A paste that contains a line
 * break would run commands immediately; a paste with control characters can
 * smuggle escape sequences (e.g. ending bracketed-paste mode). Both require an
 * explicit confirmation that shows what will be sent.
 */

// C0 controls except TAB/LF/CR, DEL, and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE_G = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export interface PasteAnalysis {
  /** confirmation required before sending */
  needsConfirm: boolean;
  multiline: boolean;
  lineCount: number;
  /** first lines (control characters made visible), for the confirmation dialog */
  preview: string[];
  hasControlChars: boolean;
  length: number;
}

export function analyzePaste(text: string, previewLines = 5): PasteAnalysis {
  const normalized = text.replace(/\r\n?/g, '\n');
  const multiline = normalized.includes('\n');
  const lines = normalized.split('\n');
  // "ls\n" is one line that executes immediately: count it as 1 line but still confirm.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const hasControlChars = CONTROL_RE.test(text);
  return {
    needsConfirm: multiline || hasControlChars,
    multiline,
    lineCount: lines.length,
    preview: lines.slice(0, previewLines).map((l) => visibleControls(l).slice(0, 200)),
    hasControlChars,
    length: text.length,
  };
}

/** Removes control characters (keeps TAB, LF, CR). */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_RE_G, '');
}

function visibleControls(s: string): string {
  return s.replace(CONTROL_RE_G, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 ? `^${String.fromCharCode(code + 0x40)}` : `\\x${code.toString(16)}`;
  });
}

export interface PasteGuardDeps {
  confirm(a: PasteAnalysis): Promise<boolean>;
  /** sends text through the terminal's paste path (bracketed paste aware) */
  paste(text: string): void;
}

/**
 * Installs a capture-phase paste listener on the terminal container so it runs
 * before xterm's own handler on its hidden textarea.
 */
export function installPasteGuard(container: HTMLElement, deps: PasteGuardDeps): () => void {
  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const a = analyzePaste(text);
    if (!a.needsConfirm) return; // single plain line: let xterm handle it
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    void deps.confirm(a).then((ok) => {
      if (ok) deps.paste(stripControlChars(text));
    });
  };
  container.addEventListener('paste', onPaste, true);
  return () => container.removeEventListener('paste', onPaste, true);
}
