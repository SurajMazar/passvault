import type { PaymentCardFields } from '@passvault/types';

/** Digits only (for saving and comparing card numbers). */
export const cardDigits = (s: string) => s.replace(/\D/g, '');

export type CardBrand = 'Visa' | 'Mastercard' | 'American Express' | 'Discover' | 'JCB' | 'Diners Club' | 'UnionPay' | 'Maestro' | 'Card';

/** Brand from the number's prefix (IIN ranges); "Card" when unknown. */
export function cardBrand(number: string): CardBrand {
  const n = cardDigits(number);
  const p = (len: number) => Number(n.slice(0, len));
  if (/^4/.test(n)) return 'Visa';
  if ((p(2) >= 51 && p(2) <= 55) || (p(4) >= 2221 && p(4) <= 2720)) return 'Mastercard';
  if (/^3[47]/.test(n)) return 'American Express';
  if (/^(6011|65|64[4-9])/.test(n)) return 'Discover';
  if (p(4) >= 3528 && p(4) <= 3589) return 'JCB';
  if (/^(36|38|30[0-5])/.test(n)) return 'Diners Club';
  if (/^62/.test(n)) return 'UnionPay';
  if (/^(50|5[6-9]|6)/.test(n)) return 'Maestro';
  return 'Card';
}

/** Luhn checksum (typos in a card number almost always fail it). */
export function luhnValid(number: string): boolean {
  const n = cardDigits(number);
  if (n.length < 12 || n.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let d = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export const cardLast4 = (number: string) => cardDigits(number).slice(-4);

/** "•••• 4242" (never more than the last four digits). */
export function maskCard(number: string): string {
  const last = cardLast4(number);
  return last ? `•••• ${last}` : '';
}

/** "MM/YY", or "" when no expiry is set. */
export function cardExpiryLabel(f: Pick<PaymentCardFields, 'expMonth' | 'expYear'>): string {
  return f.expMonth && f.expYear ? `${f.expMonth}/${f.expYear.slice(-2)}` : '';
}

/** The last moment the card is valid (end of its expiry month), or null. */
export function cardExpiresAt(f: Pick<PaymentCardFields, 'expMonth' | 'expYear'>): Date | null {
  if (!f.expMonth || !f.expYear) return null;
  return new Date(Number(f.expYear), Number(f.expMonth), 0, 23, 59, 59);
}
