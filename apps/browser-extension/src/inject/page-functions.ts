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
  /** extra fields (e.g. "Account ID") filled from the login's custom fields */
  filledExtras?: number;
}

/** A field beside username and password, e.g. AWS's "Account ID or alias". */
export interface PageExtraField {
  label: string;
  value: string;
}

export interface PageCaptureResult {
  code: 'ok' | 'not_top_frame';
  origin: string;
  url: string;
  title: string;
  username: string;
  password: string;
  foundPasswordField: boolean;
  /** other filled text fields of the same form (saved as custom fields) */
  extras: PageExtraField[];
}

/**
 * Fill a username/password into the current page.
 * TOCTOU guard: does nothing unless `location.origin === expectedOrigin`.
 */
export function pvFillCredentials(expectedOrigin: string, username: string, password: string, extras: PageExtraField[] = []): PageFillResult {
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
  // Username: marked as such, else named user/email/login, else (last resort) "account".
  const hint = (i: HTMLInputElement) => `${i.name} ${i.id} ${i.getAttribute('autocomplete') || ''}`;
  const userField =
    before.find((i) => (i.getAttribute('autocomplete') || '').split(/\s+/).includes('username')) ??
    before.filter((i) => /user|e-?mail|login|identifier/i.test(hint(i)) && !/account|alias|tenant|org/i.test(hint(i))).pop() ??
    before.filter((i) => /account|user|e-?mail|login|identifier/i.test(hint(i))).pop() ??
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
  // Extra fields of this form, matched to the login's custom fields by label/name.
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const labelOf = (i: HTMLInputElement) => {
    const forLabel = i.id ? Array.from(document.querySelectorAll('label')).find((l) => l.htmlFor === i.id)?.textContent : '';
    return norm(`${forLabel || ''} ${i.closest('label')?.textContent || ''} ${i.getAttribute('aria-label') || ''} ${i.placeholder || ''} ${i.name} ${i.id}`);
  };
  let filledExtras = 0;
  const others = scope.filter((i) => i !== pick && i !== userField && i.type !== 'password' && [...textTypes, 'number', 'url'].includes(i.type));
  for (const x of extras.slice(0, 10)) {
    const want = norm(x.label);
    if (want.length < 2 || !x.value) continue;
    const target = others.find((i) => labelOf(i).includes(want) || (want.includes(norm(i.name || i.id)) && norm(i.name || i.id).length >= 3));
    if (!target) continue;
    setValue(target, x.value);
    others.splice(others.indexOf(target), 1);
    filledExtras++;
  }
  setValue(pick, password);
  pick.blur();
  return { code: 'filled', filledUsername, filledExtras };
}

/**
 * Read what the user typed into the login form of the top document, for the
 * "Save login from this page" flow. Never descends into iframes.
 */
export function pvCaptureCredentials(): PageCaptureResult {
  const empty = { origin: '', url: '', title: '', username: '', password: '', foundPasswordField: false, extras: [] };
  if (window.top !== window) return { code: 'not_top_frame', ...empty };

  const inputs = Array.from(document.querySelectorAll('input')).filter((i) => i.type !== 'hidden' && !i.disabled);
  const passwords = inputs.filter((i) => i.type === 'password');
  const pick = passwords.find((p) => p.value) ?? passwords[0] ?? null;
  let username = '';
  const extras: PageExtraField[] = [];
  if (pick) {
    const scope = pick.form ? inputs.filter((i) => i.form === pick.form) : inputs;
    const textTypes = ['text', 'email', 'tel', ''];
    const before = scope.filter(
      (i) => textTypes.includes(i.type) && i.value && i.compareDocumentPosition(pick) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const hint = (i: HTMLInputElement) => `${i.name} ${i.id} ${i.getAttribute('autocomplete') || ''}`;
    const u =
      before.find((i) => (i.getAttribute('autocomplete') || '').split(/\s+/).includes('username')) ??
      before.filter((i) => /user|e-?mail|login|identifier/i.test(hint(i)) && !/account|alias|tenant|org/i.test(hint(i))).pop() ??
      before.filter((i) => /account|user|e-?mail|login|identifier/i.test(hint(i))).pop() ??
      before.pop();
    username = u ? u.value.trim() : '';
    // Other filled text fields of the form (e.g. an account ID): kept as custom fields.
    const labelOf = (i: HTMLInputElement) => {
      const forLabel = i.id ? Array.from(document.querySelectorAll('label')).find((l) => l.htmlFor === i.id)?.textContent : '';
      const raw = forLabel || i.closest('label')?.textContent || i.getAttribute('aria-label') || i.placeholder || i.name || i.id || '';
      return raw.replace(/\s+/g, ' ').trim().slice(0, 100);
    };
    for (const i of before) {
      if (i === u || !i.value.trim() || extras.length >= 5) continue;
      const label = labelOf(i);
      if (label) extras.push({ label, value: i.value.trim().slice(0, 500) });
    }
  }
  return {
    code: 'ok',
    origin: location.origin,
    url: location.href,
    title: (document.title || '').slice(0, 200),
    username: username.slice(0, 500),
    password: pick ? pick.value.slice(0, 4096) : '',
    foundPasswordField: !!pick,
    extras,
  };
}

export interface PageCardFillResult {
  code: 'filled' | 'origin_mismatch' | 'no_card_field' | 'not_top_frame';
  /** which parts were filled: name, number, expiry, cvv */
  filled: string[];
}

/**
 * Fill ONE payment card into the checkout form of the top document, after the
 * user clicked Fill in the popup. Uses the standard autocomplete tokens
 * (cc-name, cc-number, cc-exp, cc-exp-month, cc-exp-year, cc-csc) and falls back
 * to field names/labels. Card fields inside cross-origin iframes (hosted payment
 * forms) are not reachable; the popup offers copy buttons for those.
 * TOCTOU guard: does nothing unless `location.origin === expectedOrigin`.
 */
export function pvFillCard(expectedOrigin: string, card: { name: string; number: string; expMonth: string; expYear: string; cvv: string }): PageCardFillResult {
  if (window.top !== window) return { code: 'not_top_frame', filled: [] };
  if (location.origin !== expectedOrigin) return { code: 'origin_mismatch', filled: [] };

  const usable = (el: HTMLInputElement | HTMLSelectElement): boolean => {
    if (el.disabled || (el instanceof HTMLInputElement && (el.readOnly || el.type === 'hidden')) || el.hidden) return false;
    for (let n: Element | null = el; n; n = n.parentElement) {
      if ((n as HTMLElement).hidden) return false;
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 && r.right + window.scrollX > 0 && r.bottom + window.scrollY > 0;
  };
  const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')).filter(usable);
  const ac = (el: Element) => (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  const label = (el: HTMLInputElement | HTMLSelectElement) => {
    const byFor = el.id ? Array.from(document.querySelectorAll('label')).find((l) => l.htmlFor === el.id)?.textContent : '';
    return `${el.name} ${el.id} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${byFor || ''} ${el.closest('label')?.textContent || ''}`.toLowerCase();
  };
  const find = (token: string, re: RegExp | null) =>
    fields.find((el) => ac(el).includes(token)) ??
    (re ? fields.find((el) => !ac(el).some((t) => t.startsWith('cc-') && t !== token) && re.test(label(el))) : undefined);

  const numberEl = find('cc-number', /card.?(number|no\b|num)|cc.?num|\bpan\b|kartennummer|numero.?de.?tarjeta/);
  if (!numberEl) return { code: 'no_card_field', filled: [] };
  const nameEl = find('cc-name', /name.?on.?card|card.?holder|cardholder|holder.?name/);
  const expEl = find('cc-exp', /\bexp(iry|iration)?\b(?!.*(month|year))|mm.?\/.?yy|valid.?thru/);
  const monthEl = find('cc-exp-month', /exp.*month|\bmm\b|month/);
  const yearEl = find('cc-exp-year', /exp.*year|\byy(yy)?\b|year/);
  const cvvEl = find('cc-csc', /cvv|cvc|csc|security.?code|card.?code|\bcid\b/);

  const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
    el.focus({ preventScroll: true });
    if (el instanceof HTMLSelectElement) {
      const want = value.replace(/^0/, '');
      const opt = Array.from(el.options).find(
        (o) =>
          o.value === value ||
          o.value.replace(/^0/, '') === want ||
          o.text.trim() === value ||
          o.text.trim().replace(/^0/, '') === want ||
          o.value === value.slice(-2),
      );
      if (!opt) return false;
      el.value = opt.value;
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    return true;
  };

  const filled: string[] = [];
  if (setValue(numberEl, card.number)) filled.push('number');
  if (nameEl && card.name && setValue(nameEl, card.name)) filled.push('name');
  if (card.expMonth && card.expYear) {
    if (expEl && expEl !== monthEl) {
      const hint = `${expEl.getAttribute('placeholder') || ''} ${expEl instanceof HTMLInputElement ? expEl.maxLength : ''}`;
      const fourDigitYear = /yyyy/i.test(hint) || (expEl instanceof HTMLInputElement && expEl.maxLength >= 7);
      const sep = /\s\/\s/.test(expEl.getAttribute('placeholder') || '') ? ' / ' : '/';
      if (setValue(expEl, `${card.expMonth}${sep}${fourDigitYear ? card.expYear : card.expYear.slice(-2)}`)) filled.push('expiry');
    } else {
      const m = monthEl && setValue(monthEl, card.expMonth);
      const yHint = yearEl ? `${yearEl.getAttribute('placeholder') || ''} ${yearEl instanceof HTMLInputElement ? yearEl.maxLength : ''}` : '';
      const y =
        yearEl &&
        setValue(yearEl, yearEl instanceof HTMLInputElement && (/\byy\b/i.test(yHint) || yearEl.maxLength === 2) ? card.expYear.slice(-2) : card.expYear);
      if (m || y) filled.push('expiry');
    }
  }
  if (cvvEl && card.cvv && setValue(cvvEl, card.cvv)) filled.push('cvv');
  return { code: 'filled', filled };
}
