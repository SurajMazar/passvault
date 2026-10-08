// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The content script runs in pages. jsdom-dispatched events are untrusted
 * (`isTrusted === false`), which lets us prove the script ignores page-forged
 * submits and clicks. Positive capture is covered by the background tests.
 */
const sent: Array<{ type: string; [k: string]: unknown }> = [];
let shadowRoot: ShadowRoot | null = null;

beforeAll(async () => {
  document.body.innerHTML = `
    <form id="f"><input name="email" type="email" value="ann@example.com"><input type="password" value="Hunter2-secret!"><button type="submit">Sign in</button></form>`;
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    shadowRoot = attach.call(this, init);
    return shadowRoot;
  });
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (m: { type: string }, cb: (r: unknown) => void) => {
        sent.push(m);
        // Page-controlled host string containing markup must be rendered as text.
        if (m.type === 'savePrompt.pending') cb({ show: true, action: 'save', host: '<img src=x onerror="window.__pwned=1">evil.test', locked: false });
        else cb(null);
      },
    },
  };
  await import('../src/content/save-prompt');
  await new Promise((r) => setTimeout(r, 80));
});

describe('save-prompt content script', () => {
  it('renders the prompt in a closed shadow root with page text as plain text', () => {
    const host = document.querySelector('passvault-save-prompt');
    expect(host).not.toBeNull();
    expect(host!.shadowRoot).toBeNull(); // closed: the page cannot reach into it
    expect(shadowRoot!.querySelector('img')).toBeNull();
    expect(shadowRoot!.textContent).toContain('<img src=x onerror=');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('ignores page-forged (untrusted) submits, clicks and Enter presses', () => {
    const form = document.getElementById('f') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    form.querySelector('input[type=password]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(sent.filter((m) => m.type === 'savePrompt.submitted')).toHaveLength(0);
  });

  it('ignores scripted clicks on its own Save button', () => {
    const save = shadowRoot!.querySelector('button.primary') as HTMLButtonElement;
    save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sent.filter((m) => m.type === 'savePrompt.decide')).toHaveLength(0);
  });

  it('never runs twice in the same page', async () => {
    const before = document.querySelectorAll('passvault-save-prompt').length;
    vi.resetModules();
    await import('../src/content/save-prompt');
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelectorAll('passvault-save-prompt').length).toBe(before);
  });
});
