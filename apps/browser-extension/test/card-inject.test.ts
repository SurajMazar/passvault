// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://shop.example/checkout"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pvFillCard } from '../src/inject/page-functions';

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ x: 10, y: 10, left: 10, top: 10, width: 120, height: 24, right: 130, bottom: 34, toJSON: () => ({}) }) as DOMRect,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// eslint-disable-next-line no-new-func -- re-created from source exactly as chrome.scripting does
const fillCard = new Function(`return (${pvFillCard.toString()})`)() as typeof pvFillCard;
const card = { name: 'Alex Rivera', number: '4242424242424242', expMonth: '07', expYear: '2031', cvv: '123' };
const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;

describe('injected card fill', () => {
  it('fills a form that uses the standard autocomplete tokens', () => {
    document.body.innerHTML = `<form>
      <input id="n" autocomplete="cc-name"><input id="c" autocomplete="cc-number">
      <input id="e" autocomplete="cc-exp" placeholder="MM / YY"><input id="v" autocomplete="cc-csc"></form>`;
    const r = fillCard('https://shop.example', card);
    expect(r).toEqual({ code: 'filled', filled: ['number', 'name', 'expiry', 'cvv'] });
    expect(val('c')).toBe('4242424242424242');
    expect(val('n')).toBe('Alex Rivera');
    expect(val('e')).toBe('07 / 31');
    expect(val('v')).toBe('123');
  });

  it('falls back to names and fills month/year dropdowns', () => {
    document.body.innerHTML = `<form>
      <label for="num">Card number</label><input id="num" name="cardnumber">
      <select id="m" name="exp_month"><option value="">MM</option><option value="7">07</option></select>
      <select id="y" name="exp_year"><option value="">YYYY</option><option value="2031">2031</option></select>
      <input id="cvc" name="cvc"></form>`;
    const r = fillCard('https://shop.example', card);
    expect(r.code).toBe('filled');
    expect(val('num')).toBe('4242424242424242');
    expect(val('m')).toBe('7');
    expect(val('y')).toBe('2031');
    expect(val('cvc')).toBe('123');
  });

  it('refuses another origin and pages without a card field', () => {
    document.body.innerHTML = `<input id="c" autocomplete="cc-number">`;
    expect(fillCard('https://evil.example', card)).toEqual({ code: 'origin_mismatch', filled: [] });
    expect(val('c')).toBe('');
    document.body.innerHTML = `<input id="q" name="search">`;
    expect(fillCard('https://shop.example', card)).toEqual({ code: 'no_card_field', filled: [] });
  });
});
