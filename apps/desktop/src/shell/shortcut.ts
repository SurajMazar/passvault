/**
 * Global shortcut model: a key (KeyboardEvent.code) plus modifiers, mapped to
 * the macOS virtual key code the helper registers (hotkey.set).
 */

export interface Shortcut {
  code: string;
  cmd: boolean;
  shift: boolean;
  option: boolean;
  control: boolean;
}

/** ⌃⌥P: rarely used by other apps, unlike ⌘⇧P / ⌘⇧L. */
export const DEFAULT_SHORTCUT: Shortcut = { code: 'KeyP', cmd: false, shift: false, option: true, control: true };

// kVK_* (HIToolbox/Events.h) for the keys a shortcut may use.
const KEY_CODES: Record<string, number> = {
  KeyA: 0x00, KeyS: 0x01, KeyD: 0x02, KeyF: 0x03, KeyH: 0x04, KeyG: 0x05, KeyZ: 0x06, KeyX: 0x07, KeyC: 0x08, KeyV: 0x09,
  KeyB: 0x0b, KeyQ: 0x0c, KeyW: 0x0d, KeyE: 0x0e, KeyR: 0x0f, KeyY: 0x10, KeyT: 0x11, Digit1: 0x12, Digit2: 0x13, Digit3: 0x14,
  Digit4: 0x15, Digit6: 0x16, Digit5: 0x17, Equal: 0x18, Digit9: 0x19, Digit7: 0x1a, Minus: 0x1b, Digit8: 0x1c, Digit0: 0x1d,
  BracketRight: 0x1e, KeyO: 0x1f, KeyU: 0x20, BracketLeft: 0x21, KeyI: 0x22, KeyP: 0x23, KeyL: 0x25, KeyJ: 0x26, Quote: 0x27,
  KeyK: 0x28, Semicolon: 0x29, Backslash: 0x2a, Comma: 0x2b, Slash: 0x2c, KeyN: 0x2d, KeyM: 0x2e, Period: 0x2f, Backquote: 0x32,
  Space: 0x31, F1: 0x7a, F2: 0x78, F3: 0x63, F4: 0x76, F5: 0x60, F6: 0x61, F7: 0x62, F8: 0x64, F9: 0x65, F10: 0x6d, F11: 0x67,
  F12: 0x6f, F13: 0x69, F14: 0x6b, F15: 0x71, F16: 0x6a, F17: 0x40, F18: 0x4f, F19: 0x50, F20: 0x5a,
};

const LABELS: Record<string, string> = { Space: 'Space', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`' };

export function macKeyCode(code: string): number | null {
  return code in KEY_CODES ? KEY_CODES[code]! : null;
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return LABELS[code] ?? code;
}

/** "⌃⌥P" — macOS order: ⌃ ⌥ ⇧ ⌘. */
export function formatShortcut(s: Shortcut): string {
  return `${s.control ? '⌃' : ''}${s.option ? '⌥' : ''}${s.shift ? '⇧' : ''}${s.cmd ? '⌘' : ''}${keyLabel(s.code)}`;
}

/** Why a combination cannot be used, or null when it can (same rules as the helper). */
export function shortcutProblem(s: Shortcut): string | null {
  if (macKeyCode(s.code) === null) return 'Use a letter, digit, punctuation key, Space or F1–F20.';
  if (!s.cmd && !s.control && !s.option) return 'Use ⌘, ⌃ or ⌥ in the shortcut.';
  if (s.cmd && !s.shift && !s.control && !s.option) return '⌘ with one key would take over shortcuts other apps use; add ⇧, ⌥ or ⌃.';
  return null;
}

/** A shortcut from a key press in the recorder, or null while only modifiers are held. */
export function fromKeyEvent(e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'shiftKey' | 'altKey' | 'ctrlKey'>): Shortcut | null {
  if (/^(Meta|Shift|Alt|Control|OS|CapsLock|Fn)/.test(e.code)) return null;
  return { code: e.code, cmd: e.metaKey, shift: e.shiftKey, option: e.altKey, control: e.ctrlKey };
}

export function parseShortcut(raw: string | null): Shortcut | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Shortcut>;
    const s: Shortcut = { code: String(v.code ?? ''), cmd: !!v.cmd, shift: !!v.shift, option: !!v.option, control: !!v.control };
    return shortcutProblem(s) ? null : s;
  } catch {
    return null;
  }
}

/** Parameters for the helper's hotkey.set. */
export function helperParams(s: Shortcut) {
  return { keyCode: macKeyCode(s.code)!, cmd: s.cmd, shift: s.shift, option: s.option, control: s.control };
}
