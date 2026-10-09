// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://example.com/login"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pvCaptureCredentials, pvFillCredentials } from '../src/inject/page-functions';

/**
 * jsdom has no layout. Give every element a 120x24 box unless it (or an
 * ancestor) is display:none, or it is explicitly positioned off-screen.
 */
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const off = (this as HTMLElement).dataset?.offscreen === '1';
    const x = off ? -10_000 : 10;
    return { x, y: 10, left: x, top: 10, width: 120, height: 24, right: x + 120, bottom: 34, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** Chrome serializes the function; prove it is self-contained by re-creating it from source. */
function serialized<T extends (...a: never[]) => unknown>(fn: T): T {
  // eslint-disable-next-line no-new-func -- re-creates the function from source exactly as chrome.scripting does
  return new Function(`return (${fn.toString()})`)() as T;
}
const fill = serialized(pvFillCredentials);
const capture = serialized(pvCaptureCredentials);

function track(el: Element) {
  const events: string[] = [];
  el.addEventListener('input', () => events.push('input'));
  el.addEventListener('change', () => events.push('change'));
  return events;
}

describe('injected fill function', () => {
  it('refuses when location.origin differs from the expected origin', () => {
    document.body.innerHTML = `<form><input id="u" type="text" name="username"><input id="p" type="password"></form>`;
    expect(location.origin).toBe('https://example.com');
    const r = fill('https://example.com.evil.test', 'alice', 'secret');
    expect(r).toEqual({ code: 'origin_mismatch', filledUsername: false });
    expect((document.getElementById('u') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('p') as HTMLInputElement).value).toBe('');
  });

  it('fills only visible, editable fields and dispatches input/change events', () => {
    document.body.innerHTML = `
      <input id="search" type="text" name="q">
      <form id="login">
        <input id="hiddenUser" type="hidden" name="username" value="">
        <input id="trap" type="text" name="email" style="display:none">
        <div style="visibility:hidden"><input id="trap2" type="text" name="login"></div>
        <input id="off" type="text" name="user" data-offscreen="1">
        <input id="ro" type="text" name="account" readonly>
        <input id="u" type="email" name="email" autocomplete="username">
        <input id="hp" type="password" name="hp" style="display:none">
        <input id="p" type="password" name="password" autocomplete="current-password">
      </form>`;
    const uEvents = track(document.getElementById('u')!);
    const pEvents = track(document.getElementById('p')!);
    const r = fill('https://example.com', 'alice@example.com', 's3cret');
    expect(r).toEqual({ code: 'filled', filledUsername: true, filledExtras: 0 });
    const v = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    expect(v('u')).toBe('alice@example.com');
    expect(v('p')).toBe('s3cret');
    for (const id of ['search', 'hiddenUser', 'trap', 'trap2', 'off', 'ro', 'hp']) expect(v(id), id).toBe('');
    expect(uEvents).toEqual(['input', 'change']);
    expect(pEvents).toEqual(['input', 'change']);
  });

  it('prefers the form that contains the password field', () => {
    document.body.innerHTML = `
      <form><input id="news" type="email" name="newsletter_email"></form>
      <form><input id="u" type="text" name="login"><input id="p" type="password"></form>`;
    fill('https://example.com', 'bob', 'pw');
    expect((document.getElementById('news') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('u') as HTMLInputElement).value).toBe('bob');
  });

  it('skips disabled password fields and uses the native value setter (framework-friendly)', () => {
    document.body.innerHTML = `<form><input id="u" type="text"><input id="p0" type="password" disabled><input id="p" type="password"></form>`;
    const p = document.getElementById('p') as HTMLInputElement;
    // Simulate a framework that shadows the instance `value` property.
    let shadowed = '';
    Object.defineProperty(p, 'value', { configurable: true, get: () => shadowed, set: (x: string) => void (shadowed = `framework:${x}`) });
    const r = fill('https://example.com', '', 'pw');
    expect(r).toEqual({ code: 'filled', filledUsername: false, filledExtras: 0 });
    expect(shadowed).toBe(''); // instance setter bypassed
    delete (p as unknown as { value?: string }).value;
    expect(p.value).toBe('pw');
    expect((document.getElementById('p0') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('u') as HTMLInputElement).value).toBe('');
  });

  it('does nothing on pages without a visible password field', () => {
    document.body.innerHTML = `<form><input id="u" type="text" name="username"><input id="p" type="password" style="display:none"></form>`;
    const events = track(document.getElementById('u')!);
    expect(fill('https://example.com', 'alice', 'secret')).toEqual({ code: 'no_password_field', filledUsername: false });
    expect((document.getElementById('u') as HTMLInputElement).value).toBe('');
    expect(events).toEqual([]);
  });
});

describe('injected capture function', () => {
  it('returns the username and password typed into the top document', () => {
    document.title = 'Sign in';
    document.body.innerHTML = `<form><input id="q" type="search"><input type="text" name="username" value="alice"><input type="password" value="typed-pw"></form>`;
    const r = capture();
    expect(r).toMatchObject({ code: 'ok', origin: 'https://example.com', url: 'https://example.com/login', title: 'Sign in', username: 'alice', password: 'typed-pw', foundPasswordField: true });
  });

  it('never reads fields inside iframes', () => {
    document.body.innerHTML = `<form><input type="text" name="username" value="top-user"></form><iframe id="f"></iframe>`;
    const doc = (document.getElementById('f') as HTMLIFrameElement).contentDocument!;
    doc.body.innerHTML = `<form><input type="text" name="username" value="frame-user"><input type="password" value="frame-secret"></form>`;
    const r = capture();
    expect(r.foundPasswordField).toBe(false);
    expect(r.password).toBe('');
    expect(JSON.stringify(r)).not.toContain('frame-');
    // Fill likewise ignores the iframe's password field.
    expect(fill('https://example.com', 'u', 'p').code).toBe('no_password_field');
    expect((doc.querySelector('input[type=password]') as HTMLInputElement).value).toBe('frame-secret');
  });
});

describe('login forms with an extra field (AWS IAM: account, username, password)', () => {
  const awsForm = (account = '', user = '') => `<form>
    <label for="account">Account ID or alias</label><input id="account" name="account" type="text" value="${account}">
    <label for="username">IAM username</label><input id="username" name="username" type="text" value="${user}">
    <label for="password">Password</label><input id="password" name="password" type="password"></form>`;

  it('fills the username into the username field and the account from a custom field', () => {
    document.body.innerHTML = awsForm();
    const r = fill('https://example.com', 'alice', 'secret', [{ label: 'Account ID or alias', value: '123456789012' }]);
    expect(r).toEqual({ code: 'filled', filledUsername: true, filledExtras: 1 });
    expect((document.getElementById('username') as HTMLInputElement).value).toBe('alice');
    expect((document.getElementById('account') as HTMLInputElement).value).toBe('123456789012');
  });

  it('captures the account as an extra field, not as the username', () => {
    document.body.innerHTML = awsForm('123456789012', 'alice');
    (document.getElementById('password') as HTMLInputElement).value = 'secret';
    const c = capture();
    expect(c.username).toBe('alice');
    expect(c.extras).toEqual([{ label: 'Account ID or alias', value: '123456789012' }]);
  });
});
