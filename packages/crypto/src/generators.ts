import { sodium } from './sodium.js';
import { EFF_LARGE_WORDLIST } from './wordlist.js';

export interface PasswordOptions {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  /** Exclude visually ambiguous characters (Il1O0). */
  avoidAmbiguous: boolean;
}

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  length: 20,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
  avoidAmbiguous: false,
};

const SETS = {
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.<>/?~',
} as const;
const AMBIGUOUS = /[Il1O0]/g;

function uniform(n: number): number {
  return sodium().randombytes_uniform(n);
}

/** Unbiased CSPRNG password with at least one character from each enabled class. */
export function generatePassword(opts: Partial<PasswordOptions> = {}): string {
  const o = { ...DEFAULT_PASSWORD_OPTIONS, ...opts };
  if (!Number.isInteger(o.length) || o.length < 8 || o.length > 256) throw new Error('length must be 8–256');
  const classes = (Object.keys(SETS) as Array<keyof typeof SETS>)
    .filter((k) => o[k])
    .map((k) => (o.avoidAmbiguous ? SETS[k].replace(AMBIGUOUS, '') : SETS[k]));
  if (classes.length === 0) throw new Error('enable at least one character class');
  const all = classes.join('');
  const chars: string[] = classes.map((c) => c[uniform(c.length)]!);
  while (chars.length < o.length) chars.push(all[uniform(all.length)]!);
  // Fisher–Yates shuffle so required characters are not at fixed positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = uniform(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

export interface PassphraseOptions {
  words: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
}

export const DEFAULT_PASSPHRASE_OPTIONS: PassphraseOptions = { words: 6, separator: '-', capitalize: false, includeNumber: false };

export function generatePassphrase(opts: Partial<PassphraseOptions> = {}): string {
  const o = { ...DEFAULT_PASSPHRASE_OPTIONS, ...opts };
  if (!Number.isInteger(o.words) || o.words < 3 || o.words > 20) throw new Error('words must be 3–20');
  const words = Array.from({ length: o.words }, () => {
    const w = EFF_LARGE_WORDLIST[uniform(EFF_LARGE_WORDLIST.length)]!;
    return o.capitalize ? w[0]!.toUpperCase() + w.slice(1) : w;
  });
  if (o.includeNumber) {
    const i = uniform(words.length);
    words[i] = `${words[i]}${uniform(10)}`;
  }
  return words.join(o.separator);
}

/** Estimated entropy in bits for generator output (for UI display). */
export function passwordEntropyBits(opts: Partial<PasswordOptions> = {}): number {
  const o = { ...DEFAULT_PASSWORD_OPTIONS, ...opts };
  const size = (Object.keys(SETS) as Array<keyof typeof SETS>)
    .filter((k) => o[k])
    .reduce((n, k) => n + (o.avoidAmbiguous ? SETS[k].replace(AMBIGUOUS, '') : SETS[k]).length, 0);
  return size ? Math.floor(o.length * Math.log2(size)) : 0;
}

export function passphraseEntropyBits(opts: Partial<PassphraseOptions> = {}): number {
  const o = { ...DEFAULT_PASSPHRASE_OPTIONS, ...opts };
  return Math.floor(o.words * Math.log2(EFF_LARGE_WORDLIST.length) + (o.includeNumber ? Math.log2(10) : 0));
}
