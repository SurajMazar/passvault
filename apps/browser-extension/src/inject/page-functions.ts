/**
 * Functions injected into a page with `chrome.scripting.executeScript({ func, args })`
 * for ONE user-initiated action. They are serialized by Chrome (Function#toString),
 * so they MUST be fully self-contained: no imports, no references to module scope,
 * no helper functions outside their own body.
 *
 * They run in the extension's ISOLATED world of the top frame only. They have no
 * vault access: the fill function receives exactly one username/password pair.
 */

export interface PageFillResult {
  code: 'filled' | 'origin_mismatch' | 'no_password_field' | 'not_top_frame';
  filledUsername: boolean;
}

export interface PageCaptureResult {
  code: 'ok' | 'not_top_frame';
  origin: string;
  url: string;
  title: string;
  username: string;
  password: string;
  foundPasswordField: boolean;
}

/**
 * Fill a username/password into the current page.
 * TOCTOU guard: does nothing unless `location.origin === expectedOrigin`.
 */
export function pvFillCredentials(expectedOrigin: string, username: string, password: string): PageFillResult {
  if (window.top !== window) return { code: 'not_top_frame', filledUsername: false };
  if (location.origin !== expectedOrigin) return { code: 'origin_mismatch', filledUsername: false };

  const isUsable = (el: HTMLInputElement): boolean => {
    if (el.disabled || el.readOnly || el.type === 'hidden' || el.hidden) return false;
    for (let n: Element | null = el; n; n = n.parentElement) {
      if ((n as HTMLElement).hidden) return false;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0) return false; // positioned off-screen (honeypot)
    return true;
  };
  const inputs = Array.from(document.querySelectorAll('input')).filter(isUsable);
  const passwords = inputs.filter((i) => i.type === 'password');
  if (passwords.length === 0) return { code: 'no_password_field', filledUsername: false };

  const pick =
    passwords.find((p) => (p.getAttribute('autocomplete') || '').includes('current-password')) ??
    passwords.find((p) => !(p.getAttribute('autocomplete') || '').includes('new-password')) ??
    passwords[0]!;
  const form = pick.form;
  const scope = form ? inputs.filter((i) => i.form === form) : inputs;

  const textTypes = ['text', 'email', 'tel', ''];
  const before = scope.filter(
    (i) => textTypes.includes(i.type) && i.compareDocumentPosition(pick) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const userish = /user|email|login|account|identifier|e-mail/i;
  const userField =
    before.find((i) => (i.getAttribute('autocomplete') || '').split(/\s+/).includes('username')) ??
    before.filter((i) => userish.test(`${i.name} ${i.id} ${i.getAttribute('autocomplete') || ''}`)).pop() ??
    before.pop() ??
    null;

  const setValue = (el: HTMLInputElement, value: string) => {
    el.focus({ preventScroll: true });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  let filledUsername = false;
  if (userField && username) {
    setValue(userField, username);
    filledUsername = true;
  }
  setValue(pick, password);
  pick.blur();
  return { code: 'filled', filledUsername };
}

/**
 * Read what the user typed into the login form of the top document, for the
 * "Save login from this page" flow. Never descends into iframes.
 */
export function pvCaptureCredentials(): PageCaptureResult {
  const empty = { origin: '', url: '', title: '', username: '', password: '', foundPasswordField: false };
  if (window.top !== window) return { code: 'not_top_frame', ...empty };

  const inputs = Array.from(document.querySelectorAll('input')).filter((i) => i.type !== 'hidden' && !i.disabled);
  const passwords = inputs.filter((i) => i.type === 'password');
  const pick = passwords.find((p) => p.value) ?? passwords[0] ?? null;
  let username = '';
  if (pick) {
    const scope = pick.form ? inputs.filter((i) => i.form === pick.form) : inputs;
    const textTypes = ['text', 'email', 'tel', ''];
    const before = scope.filter(
      (i) => textTypes.includes(i.type) && i.value && i.compareDocumentPosition(pick) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const userish = /user|email|login|account|identifier|e-mail/i;
    const u =
      before.find((i) => (i.getAttribute('autocomplete') || '').split(/\s+/).includes('username')) ??
      before.filter((i) => userish.test(`${i.name} ${i.id}`)).pop() ??
      before.pop();
    username = u ? u.value.trim() : '';
  }
  return {
    code: 'ok',
    origin: location.origin,
    url: location.href,
    title: (document.title || '').slice(0, 200),
    username: username.slice(0, 500),
    password: pick ? pick.value.slice(0, 4096) : '',
    foundPasswordField: !!pick,
  };
}
