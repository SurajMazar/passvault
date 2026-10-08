/**
 * PassVault "offer to save" content script (opt-in).
 *
 * Registered with chrome.scripting.registerContentScripts only while the user
 * has enabled "Offer to save passwords" AND granted the optional host
 * permission. It runs in the extension's isolated world, top frame only.
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
  const USERISH = /user|email|login|account|identifier|e-mail/i;
  let lastSent = '';

  function visible(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  }

  function findCredentials(root: ParentNode): { username: string; password: string } | null {
    const inputs = Array.from(root.querySelectorAll('input')).filter((i) => i.type !== 'hidden' && !i.disabled);
    const pw = inputs.find((i) => i.type === 'password' && i.value && visible(i));
    if (!pw) return null;
    // Sign-up / change-password forms often have several password fields; use the last filled one (the new password).
    const filledPw = inputs.filter((i) => i.type === 'password' && i.value);
    const password = (filledPw[filledPw.length - 1] ?? pw).value;
    const scope = pw.form ? inputs.filter((i) => i.form === pw.form) : inputs;
    const before = scope.filter((i) => TEXTISH.has(i.type) && i.value && i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    const u =
      before.find((i) => (i.getAttribute('autocomplete') || '').split(/\s+/).includes('username')) ??
      before.filter((i) => USERISH.test(`${i.name} ${i.id} ${i.getAttribute('autocomplete') || ''}`)).pop() ??
      before.pop();
    return { username: (u?.value || '').trim().slice(0, 500), password: password.slice(0, 4096) };
  }

  function submitted(root: ParentNode) {
    const c = findCredentials(root);
    if (!c || !c.password) return;
    const key = `${c.username}\u0000${c.password}`;
    if (key === lastSent) return; // submit + click often both fire
    lastSent = key;
    void send<PromptInfo>({ type: 'savePrompt.submitted', username: c.username, password: c.password }).then((info) => {
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
      <div class="row">
        <button class="primary" data-d="${update ? 'update' : 'save'}"></button>
        <button class="ghost" data-d="dismiss">Not now</button>
        <button class="ghost" data-d="never">Never for this site</button>
      </div>
      <div class="msg" aria-live="polite"></div>`;
    // Page-derived text is set with textContent only (never HTML).
    (bar.querySelector('.title') as HTMLElement).textContent = update ? 'Update saved password?' : 'Save password to PassVault?';
    (bar.querySelector('.sub') as HTMLElement).textContent = update ? `${info.itemTitle ?? info.host} · ${info.host}` : info.host + (info.locked ? ' · unlock PassVault to save' : '');
    (bar.querySelector('.primary') as HTMLElement).textContent = update ? 'Update' : 'Save';
    const msg = bar.querySelector('.msg') as HTMLElement;
    bar.addEventListener('click', (e) => {
      if (!e.isTrusted) return; // ignore scripted clicks from the page
      const b = (e.target as Element).closest('button');
      const decision = b?.getAttribute('data-d');
      if (!decision) return;
      void send<DecideResult>({ type: 'savePrompt.decide', decision }).then((r) => {
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

  // After a post-login navigation, the background may still hold a pending prompt for this site.
  void send<PromptInfo>({ type: 'savePrompt.pending' }).then((info) => {
    if (info && info.show) render(info);
  });
})();

export {};
