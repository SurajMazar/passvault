import { describe, expect, it } from 'vitest';
import { cardBrand, cardExpiresAt, cardExpiryLabel, itemSubtitle, luhnValid, maskCard, newItem, searchableText } from '../src/index';

describe('payment cards', () => {
  it('detects brands and checks numbers', () => {
    expect(cardBrand('4242 4242 4242 4242')).toBe('Visa');
    expect(cardBrand('5555555555554444')).toBe('Mastercard');
    expect(cardBrand('2223003122003222')).toBe('Mastercard');
    expect(cardBrand('378282246310005')).toBe('American Express');
    expect(cardBrand('6011111111111117')).toBe('Discover');
    expect(luhnValid('4242424242424242')).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
    expect(maskCard('4242424242424242')).toBe('•••• 4242');
  });

  it('works out expiry from month and year', () => {
    expect(cardExpiryLabel({ expMonth: '07', expYear: '2031' })).toBe('07/31');
    expect(cardExpiresAt({ expMonth: '02', expYear: '2028' })?.getDate()).toBe(29);
    expect(cardExpiresAt({ expMonth: '', expYear: '2028' })).toBeNull();
  });

  it('never exposes the full number, CVV or PIN in subtitles or search', () => {
    const p = newItem('payment_card', { title: 'Visa' });
    p.fields = { cardholder: 'Alex Rivera', number: '4242424242424242', expMonth: '07', expYear: '2031', cvv: '123', pin: '9876' };
    expect(itemSubtitle(p)).toBe('Visa •••• 4242 · exp 07/31');
    const text = searchableText(p);
    expect(text).toContain('4242');
    expect(text).not.toContain('4242424242424242');
    expect(text).not.toContain('123\n');
    expect(text).not.toContain('9876');
  });
});
