/**
 * PassVault page content script: "offer to save" and inline suggestions in
 * login fields.
 *
 * Registered with chrome.scripting.registerContentScripts only while the user
 * has granted the optional all-sites host permission and has "Offer to save
 * passwords" or "Suggestions in login fields" on. It runs in the extension's
 * isolated world, top frame only.
 *
 * What it does:
 *   1. When a login form is submitted (submit event, or Enter / click on a
 *      submit-like button next to a filled password field), it reads the
 *      username and password the user typed and hands them to the background
 *      worker ONCE. The background keeps them in memory with a short expiry.
 *   2. It asks the background whether a prompt should be shown on this page
 *      (also after a post-login redirect on the same site) and renders a small
 *      bar inside a CLOSED shadow root: Save / Update · Not now · Never.
 *
 * It never receives vault data: the background replies only with the action
 * ("save" | "update"), the host, and an existing item's title. Button clicks
 * are honoured only when `event.isTrusted` (real user input).
 *
 * No imports: this file is bundled as a standalone classic script.
 */

type PromptInfo = { show: true; action: 'save' | 'update'; host: string; itemTitle?: string; locked: boolean } | { show: false };
type DecideResult = { ok: true; message: string } | { ok: false; code: string; message: string };

(() => {
  const g = globalThis as unknown as { __pvSavePrompt?: boolean };
  if (window.top !== window || g.__pvSavePrompt) return;
  g.__pvSavePrompt = true;

  const send = <T>(message: unknown): Promise<T | null> =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (r: unknown) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve((r as T) ?? null);
        });
      } catch {
        resolve(null); // extension reloaded / context invalidated
      }
    });

  // ------------------------------------------------------------ capture

  const TEXTISH = new Set(['text', 'email', 'tel', '']);
  const USERISH = /user|e-?mail|login|identifier/i;
  let lastSent = '';

  function visible(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  }

  function findCredentials(root: ParentNode): { username: string; password: string; extras: Array<{ label: string; value: string }> } | null {
    const inputs = Array.from(root.querySelectorAll('input')).filter((i) => i.type !== 'hidden' && !i.disabled);
    const pw = inputs.find((i) => i.type === 'password' && i.value && visible(i));
    if (!pw) return null;
    // Sign-up / change-password forms often have several password fields; use the last filled one (the new password).
    const filledPw = inputs.filter((i) => i.type === 'password' && i.value);
    const password = (filledPw[filledPw.length - 1] ?? pw).value;
    const scope = pw.form ? inputs.filter((i) => i.form === pw.form) : inputs;
    const before = scope.filter((i) => TEXTISH.has(i.type) && i.value && i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    // Username: marked as such, else named user/email/login, else (last resort) "account".
    const hint = (i: HTMLInputElement) => `${i.name} ${i.id} ${i.getAttribute('autocomplete') || ''}`;
    const u =
      before.find((i) => (i.getAttribute('autocomplete') || '').split(/\s+/).includes('username')) ??
      before.filter((i) => USERISH.test(hint(i)) && !/account|alias|tenant|org/i.test(hint(i))).pop() ??
      before.filter((i) => /account/i.test(hint(i)) || USERISH.test(hint(i))).pop() ??
      before.pop();
    // Other filled fields of the form (e.g. an AWS account ID) become custom fields of the login.
    const labelOf = (i: HTMLInputElement) => {
      const forLabel = i.id ? Array.from(document.querySelectorAll('label')).find((l) => l.htmlFor === i.id)?.textContent : '';
      const raw = forLabel || i.closest('label')?.textContent || i.getAttribute('aria-label') || i.placeholder || i.name || i.id || '';
      return raw.replace(/\s+/g, ' ').trim().slice(0, 100);
    };
    const extras: Array<{ label: string; value: string }> = [];
    for (const i of before) {
      if (i === u || !i.value.trim() || extras.length >= 5) continue;
      const label = labelOf(i);
      if (label) extras.push({ label, value: i.value.trim().slice(0, 500) });
    }
    return { username: (u?.value || '').trim().slice(0, 500), password: password.slice(0, 4096), extras };
  }

  function submitted(root: ParentNode) {
    const c = findCredentials(root);
    if (!c || !c.password) return;
    const key = `${c.username}\u0000${c.password}`;
    if (key === lastSent) return; // submit + click often both fire
    lastSent = key;
    void send<PromptInfo>({ type: 'savePrompt.submitted', username: c.username, password: c.password, extras: c.extras }).then((info) => {
      if (info && info.show) render(info);
    });
  }

  document.addEventListener(
    'submit',
    (e) => {
      if (!e.isTrusted) return;
      submitted(e.target instanceof HTMLFormElement ? e.target : document);
    },
    true,
  );
  // Many sites log in via JS without a real form submit.
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      const t = e.target instanceof Element ? e.target.closest('button, input[type=submit], input[type=button], [role=button]') : null;
      if (!t) return;
      const label = `${t.textContent || ''} ${(t as HTMLInputElement).value || ''} ${t.getAttribute('aria-label') || ''}`.toLowerCase();
      const submitLike = (t as HTMLButtonElement).type === 'submit' || /log ?in|sign ?in|continue|next|submit|save|register|sign ?up/.test(label);
      if (submitLike) submitted((t as HTMLButtonElement).form ?? document);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.key !== 'Enter') return;
      const t = e.target;
      if (t instanceof HTMLInputElement && (t.type === 'password' || TEXTISH.has(t.type))) submitted(t.form ?? document);
    },
    true,
  );

  // ------------------------------------------------------------ prompt UI

  let host: HTMLElement | null = null;

  function close() {
    host?.remove();
    host = null;
  }

  function render(info: Extract<PromptInfo, { show: true }>) {
    close();
    host = document.createElement('passvault-save-prompt');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .bar { position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 340px; box-sizing: border-box;
        font: 14px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #e8edf3;
        background: #11171f; border: 1px solid #2e3945; border-radius: 14px; padding: 14px 16px;
        box-shadow: 0 16px 40px -8px rgba(0,0,0,.55); }
      .top { display: flex; align-items: center; gap: 10px; }
      .logo { width: 26px; height: 26px; flex: none; }
      .title { font-weight: 600; }
      .sub { color: #a6b0bd; font-size: 12.5px; margin-top: 2px; overflow-wrap: anywhere; }
      .row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
      button { all: unset; cursor: pointer; border-radius: 8px; padding: 7px 12px; font-size: 13px; font-weight: 500; }
      button:focus-visible { outline: 2px solid #4fd3c0; outline-offset: 2px; }
      .primary { background: #2bc3ae; color: #03201b; }
      .ghost { color: #a6b0bd; }
      .ghost:hover { color: #e8edf3; background: #1a222d; }
      .x { margin-left: auto; color: #7d8896; padding: 2px 6px; }
      .msg { margin-top: 10px; font-size: 12.5px; }
      .note { display: none; margin-top: 10px; }
      .note.open { display: block; }
      textarea { all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 56px; max-height: 160px; overflow: auto;
        white-space: pre-wrap; padding: 8px 10px; border-radius: 8px; border: 1px solid #2e3945; background: #0b1117;
        color: #e8edf3; font: 13px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      textarea:focus-visible { outline: 2px solid #4fd3c0; outline-offset: 1px; }
      .hint { color: #7d8896; font-size: 11.5px; margin-top: 4px; }
      .ok { color: #4ad295; } .err { color: #ff8266; }
    `;
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'PassVault');
    const update = info.action === 'update';
    bar.innerHTML = `
      <div class="top">
        <svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="2" width="28" height="28" rx="8" fill="#2bc3ae"/><circle cx="16" cy="16" r="8.5" fill="none" stroke="#03201b" stroke-width="2.4"/><circle cx="16" cy="14.2" r="2.4" fill="#03201b"/><rect x="14.9" y="15" width="2.2" height="5.4" rx="1.1" fill="#03201b"/></svg>
        <div><div class="title"></div><div class="sub"></div></div>
        <button class="x" data-d="dismiss" aria-label="Close">✕</button>
      </div>
      <div class="note">
        <textarea maxlength="2000" aria-label="Note (optional)" placeholder="Note (optional)"></textarea>
        <div class="hint"></div>
      </div>
      <div class="row">
        <button class="primary" data-d="${update ? 'update' : 'save'}"></button>
        <button class="ghost" data-a="note">Add note</button>
        <button class="ghost" data-d="dismiss">Not now</button>
        <button class="ghost" data-d="never">Never for this site</button>
      </div>
      <div class="msg" aria-live="polite"></div>`;
    // Page-derived text is set with textContent only (never HTML).
    (bar.querySelector('.title') as HTMLElement).textContent = update ? 'Update saved password?' : 'Save password to PassVault?';
    (bar.querySelector('.sub') as HTMLElement).textContent = update ? `${info.itemTitle ?? info.host} · ${info.host}` : info.host + (info.locked ? ' · unlock PassVault to save' : '');
    (bar.querySelector('.primary') as HTMLElement).textContent = update ? 'Update' : 'Save';
    (bar.querySelector('.hint') as HTMLElement).textContent = update ? 'Added to the existing notes.' : 'Saved with this login.';
    const msg = bar.querySelector('.msg') as HTMLElement;
    const noteBox = bar.querySelector('.note') as HTMLElement;
    const noteInput = bar.querySelector('textarea') as HTMLTextAreaElement;
    // Keep site keyboard shortcuts (bubble-phase handlers) from reacting while typing. This does NOT hide the
    // note from the page: a page can observe keystrokes in the capture phase (documented in EXTENSION.md).
    for (const t of ['keydown', 'keyup', 'keypress', 'input']) noteInput.addEventListener(t, (e) => e.stopPropagation());
    bar.addEventListener('click', (e) => {
      if (!e.isTrusted) return; // ignore scripted clicks from the page
      const b = (e.target as Element).closest('button');
      if (b?.getAttribute('data-a') === 'note') {
        noteBox.classList.add('open');
        b.remove();
        noteInput.focus({ preventScroll: true });
        return;
      }
      const decision = b?.getAttribute('data-d');
      if (!decision) return;
      const note = decision === 'save' || decision === 'update' ? noteInput.value.trim().slice(0, 2000) : '';
      void send<DecideResult>({ type: 'savePrompt.decide', decision, ...(note ? { note } : {}) }).then((r) => {
        if (decision === 'dismiss' || decision === 'never') return close();
        if (!r) {
          msg.className = 'msg err';
          msg.textContent = 'PassVault is not available.';
          return;
        }
        msg.className = r.ok ? 'msg ok' : 'msg err';
        msg.textContent = r.message;
        if (r.ok) setTimeout(close, 1800);
      });
    });
    shadow.append(style, bar);
    document.documentElement.appendChild(host);
    setTimeout(() => (shadow.querySelector('.primary') as HTMLElement | null)?.focus({ preventScroll: true }), 50);
  }

  // ------------------------------------------------------------ inline suggestions (login fields)
  //
  // Clicking into a login field shows the logins saved for this site (title and
  // username only — the background never sends passwords here). Choosing one asks
  // the background to fill through the popup's policy-checked fill path. Only
  // trusted (user) input opens the menu or picks an entry.

  type Suggestion = { id: string; title: string; username: string; insecure: boolean };
  type SuggestResult = { show: false } | { show: true; locked: boolean; items: Suggestion[] };
  type InlineResult = { ok: true } | { ok: false; message: string };

  let menuHost: HTMLElement | null = null;
  let menuField: HTMLInputElement | null = null;
  let menuButtons: HTMLButtonElement[] = [];
  let menuMsg: HTMLElement | null = null;
  let activeIndex = -1;
  let requestSeq = 0;

  function isLoginField(el: EventTarget | null): el is HTMLInputElement {
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly || !visible(el)) return false;
    if (el.type === 'password') return true;
    if (!TEXTISH.has(el.type)) return false;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac.split(/\s+/).includes('username')) return true;
    const scope: ParentNode = el.form ?? document;
    const hasPassword = Array.from(scope.querySelectorAll('input')).some((i) => i.type === 'password' && visible(i));
    return hasPassword || (USERISH.test(`${el.name} ${el.id} ${ac}`) && el.type === 'email');
  }

  function closeMenu() {
    menuHost?.remove();
    menuHost = null;
    menuField = null;
    menuButtons = [];
    menuMsg = null;
    activeIndex = -1;
  }

  function position() {
    if (!menuHost || !menuField) return;
    if (!menuField.isConnected || !visible(menuField)) return closeMenu();
    const r = menuField.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 260), window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    menuHost.style.cssText = `all: initial; position: fixed; z-index: 2147483647; top: ${Math.round(r.bottom + 4)}px; left: ${Math.round(left)}px; width: ${Math.round(width)}px;`;
  }

  function setActive(i: number) {
    if (!menuButtons.length) return;
    activeIndex = (i + menuButtons.length) % menuButtons.length;
    menuButtons.forEach((b, j) => b.classList.toggle('active', j === activeIndex));
  }

  function choose(btn: HTMLButtonElement) {
    const id = btn.dataset.id;
    if (btn.dataset.unlock) {
      void send<InlineResult>({ type: 'inline.unlock' }).then((r) => {
        if (r && !r.ok && menuMsg) menuMsg.textContent = r.message;
        else closeMenu();
      });
      return;
    }
    if (!id) return;
    void send<InlineResult>({ type: 'inline.fill', itemId: id }).then((r) => {
      if (r && r.ok) return closeMenu();
      if (menuMsg) menuMsg.textContent = r && !r.ok ? r.message : 'PassVault could not fill this page.';
    });
  }

  function renderMenu(field: HTMLInputElement, res: Extract<SuggestResult, { show: true }>) {
    closeMenu();
    menuField = field;
    menuHost = document.createElement('passvault-inline-menu');
    const shadow = menuHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .menu { box-sizing: border-box; width: 100%; font: 13px/1.35 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #e8edf3; background: #11171f; border: 1px solid #2e3945; border-radius: 12px; padding: 6px;
        box-shadow: 0 14px 34px -8px rgba(0,0,0,.55); }
      .head { display: flex; align-items: center; gap: 6px; padding: 4px 6px 6px; color: #7d8896; font-size: 11.5px; }
      .logo { width: 14px; height: 14px; }
      button { all: unset; box-sizing: border-box; display: block; width: 100%; cursor: pointer; border-radius: 8px; padding: 7px 8px; }
      button:hover, button.active { background: #1a222d; }
      button:focus-visible { outline: 2px solid #4fd3c0; outline-offset: -2px; }
      .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .u { color: #a6b0bd; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .warn { color: #f2b45a; }
      .unlock { color: #2bc3ae; font-weight: 600; }
      .msg { color: #ff8266; font-size: 12px; padding: 4px 8px 2px; }
      .msg:empty { display: none; }
    `;
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'PassVault logins for this site');
    menu.innerHTML = `<div class="head"><svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="2" width="28" height="28" rx="8" fill="#2bc3ae"/><circle cx="16" cy="16" r="8.5" fill="none" stroke="#03201b" stroke-width="2.4"/><circle cx="16" cy="14.2" r="2.4" fill="#03201b"/><rect x="14.9" y="15" width="2.2" height="5.4" rx="1.1" fill="#03201b"/></svg><span>PassVault</span></div>`;
    if (res.locked) {
      const b = document.createElement('button');
      b.dataset.unlock = '1';
      b.setAttribute('role', 'option');
      const t = document.createElement('div');
      t.className = 't unlock';
      t.textContent = 'Unlock PassVault to fill';
      const u = document.createElement('div');
      u.className = 'u';
      u.textContent = 'Your saved logins for this site appear here once unlocked.';
      b.append(t, u);
      menu.append(b);
    } else {
      for (const it of res.items) {
        const b = document.createElement('button');
        b.dataset.id = it.id;
        b.setAttribute('role', 'option');
        // Item text is set with textContent only (never HTML).
        const t = document.createElement('div');
        t.className = 't';
        t.textContent = it.title || it.username || 'Login';
        const u = document.createElement('div');
        u.className = 'u';
        u.textContent = it.username || '(no username)';
        if (it.insecure) {
          const w = document.createElement('span');
          w.className = 'warn';
          w.textContent = ' · not secure (http)';
          u.append(w);
        }
        b.append(t, u);
        menu.append(b);
      }
    }
    menuMsg = document.createElement('div');
    menuMsg.className = 'msg';
    menuMsg.setAttribute('aria-live', 'polite');
    menu.append(menuMsg);
    menuButtons = Array.from(menu.querySelectorAll('button'));
    // Keep focus in the page's field while the menu is used with the mouse.
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => {
      if (!e.isTrusted) return; // ignore scripted clicks from the page
      const b = (e.target as Element).closest('button');
      if (b) choose(b as HTMLButtonElement);
    });
    shadow.append(style, menu);
    document.documentElement.appendChild(menuHost);
    position();
  }

  function openMenu(field: HTMLInputElement) {
    if (menuField === field && menuHost) return;
    const seq = ++requestSeq;
    void send<SuggestResult>({ type: 'inline.suggest' }).then((res) => {
      if (seq !== requestSeq || document.activeElement !== field) return;
      if (res && res.show) renderMenu(field, res);
      else closeMenu();
    });
  }

  document.addEventListener(
    'focusin',
    (e) => {
      if (e.isTrusted && isLoginField(e.target)) openMenu(e.target);
    },
    true,
  );
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!e.isTrusted) return;
      if (menuHost && e.composedPath().includes(menuHost)) return;
      if (isLoginField(e.target)) openMenu(e.target);
      else if (e.target !== menuField) closeMenu();
    },
    true,
  );
  document.addEventListener(
    'focusout',
    (e) => {
      if (e.target === menuField) setTimeout(() => document.activeElement !== menuField && closeMenu(), 150);
    },
    true,
  );
  document.addEventListener(
    'input',
    (e) => {
      if (e.isTrusted && e.target === menuField) closeMenu(); // the user is typing their own value
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || !menuHost || e.target !== menuField) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(activeIndex + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter' && activeIndex >= 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        choose(menuButtons[activeIndex]!);
      } else if (e.key === 'Escape') {
        closeMenu();
      }
    },
    true,
  );
  window.addEventListener('scroll', position, true);
  window.addEventListener('resize', position);

  // After a post-login navigation, the background may still hold a pending prompt for this site.
  void send<PromptInfo>({ type: 'savePrompt.pending' }).then((info) => {
    if (info && info.show) render(info);
  });
})();

export {};
