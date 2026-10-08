import type { Locator, Page } from 'playwright';
import { MemoryStore } from '@passvault/sync';
import { VaultSession, type Platform } from '@passvault/vault-core';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mailCode(mailpit: string, email: string, after: number, re = /\b(\d{6})\b/): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const r = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const j = (await r.json()) as { messages: Array<{ ID: string; Created: string }> };
    const msg = j.messages.find((m) => Date.parse(m.Created) >= after - 1000);
    if (msg) {
      const m = (await (await fetch(`${mailpit}/api/v1/message/${msg.ID}`)).json()) as { Text: string };
      const found = re.exec(m.Text)?.[1];
      if (found) return found;
    }
    await sleep(250);
  }
  throw new Error(`no email for ${email}`);
}

/** Bottom-centre chapter caption rendered inside the page. */
export async function caption(page: Page, title: string, sub = '') {
  await page.evaluate(
    ([t, s]) => {
      let el = document.getElementById('pv-caption');
      if (!el) {
        el = document.createElement('div');
        el.id = 'pv-caption';
        el.setAttribute('aria-hidden', 'true');
        Object.assign(el.style, {
          position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: '2147483647',
          padding: '10px 20px', borderRadius: '14px', background: 'rgba(8,21,26,0.9)', color: '#fff',
          font: '500 16px/1.35 Inter Variable, system-ui, sans-serif', boxShadow: '0 12px 32px rgba(0,0,0,.35)',
          border: '1px solid rgba(127,240,222,.35)', textAlign: 'center', maxWidth: '78vw', pointerEvents: 'none',
        } as CSSStyleDeclaration);
        document.body.appendChild(el);
      }
      el.textContent = '';
      const h = document.createElement('div');
      h.textContent = t ?? '';
      h.style.fontWeight = '650';
      el.appendChild(h);
      if (s) {
        const p = document.createElement('div');
        p.textContent = s;
        Object.assign(p.style, { fontSize: '13.5px', opacity: '.75', marginTop: '2px' });
        el.appendChild(p);
      }
    },
    [title, sub],
  );
}

export async function titleCard(page: Page, heading: string, sub: string) {
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(120% 80% at 0% 0%, rgba(43,195,174,.35), transparent 60%),radial-gradient(90% 70% at 100% 100%, rgba(11,127,114,.45), transparent 60%),linear-gradient(160deg,#0b1f22,#060d12);
    color:#fff;font-family:Inter,system-ui,-apple-system,sans-serif">
    <div style="text-align:center;max-width:900px">
      <svg viewBox="0 0 32 32" width="84" height="84"><rect x="2" y="2" width="28" height="28" rx="8" fill="#2bc3ae"/><circle cx="16" cy="16" r="8.5" fill="none" stroke="#03201b" stroke-width="2.4"/><circle cx="16" cy="14.2" r="2.4" fill="#03201b"/><rect x="14.9" y="15" width="2.2" height="5.4" rx="1.1" fill="#03201b"/></svg>
      <h1 style="font-size:56px;margin:24px 0 10px;letter-spacing:-.02em">${heading}</h1>
      <p style="font-size:22px;opacity:.78;margin:0;line-height:1.4">${sub}</p>
    </div></body></html>`);
}

export async function type(loc: Locator, text: string, delay = 25) {
  await loc.click();
  await loc.pressSequentially(text, { delay });
}

export function headlessSession(apiUrl: string, webUrl: string): VaultSession {
  const prefs = new Map<string, string>();
  let token: string | null = null;
  const stores = new Map<string, MemoryStore>();
  const platform: Platform = {
    clientType: 'cli',
    deviceName: 'bob-laptop',
    apiBaseUrl: apiUrl,
    webAppUrl: webUrl,
    tokens: { get: async () => token, set: async (t) => void (token = t), clear: async () => void (token = null) },
    prefs: { get: async (k) => prefs.get(k) ?? null, set: async (k, v) => void prefs.set(k, v), remove: async (k) => void prefs.delete(k) },
    createCacheStore: (s) => (stores.get(s) ?? stores.set(s, new MemoryStore()).get(s))!,
    clipboard: { copySecret: async () => undefined, copyText: async () => undefined },
    files: { pickTextFile: async () => null, saveTextFile: async () => ({ saved: false }) },
    openExternal: async () => undefined,
  };
  return new VaultSession(platform);
}
