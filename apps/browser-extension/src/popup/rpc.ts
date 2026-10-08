import { useEffect, useState } from 'react';
import { POPUP_PORT, TOUCH_ID_HOST } from '../shared/constants';
import type { ErrorCode, PopupState, PortMessageToBackground, PortMessageToPopup, RequestOf, RequestType, ResponseMap, Result } from '../shared/protocol';

export class RpcError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Send one typed request to the background and unwrap the result. */
export async function call<T extends RequestType>(req: RequestOf<T>): Promise<ResponseMap[T]> {
  const res = (await chrome.runtime.sendMessage(req)) as Result<ResponseMap[T]> | undefined;
  if (!res) throw new RpcError('internal', 'PassVault background is not responding. Try again.');
  if (!res.ok) throw new RpcError(res.error.code, res.error.message);
  return res.data;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/**
 * Live auth/sync state pushed by the background over a port. The port's
 * keepalive pings keep the service worker alive while the popup is open.
 */
export function usePopupState(): { state: PopupState | null; error: string | null } {
  const [state, setState] = useState<PopupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let failures = 0;
    const connect = () => {
      if (closed) return;
      if (++failures > 5) return; // the background keeps refusing us (e.g. popup opened in a tab)
      port = chrome.runtime.connect({ name: POPUP_PORT });
      port.onMessage.addListener((m: PortMessageToPopup) => {
        if (m?.type === 'state') {
          failures = 0;
          setState(m.state);
        } else if (m?.type === 'native') {
          void relayNative(port, m.id, m.message);
        }
      });
      // If the worker restarts, reconnect (it resumes from chrome.storage.session if unlocked).
      port.onDisconnect.addListener(() => {
        port = null;
        setTimeout(connect, 250);
      });
    };
    connect();
    timer = setInterval(() => {
      try {
        port?.postMessage({ type: 'keepalive' });
      } catch {
        /* reconnect handles it */
      }
    }, 20_000);
    void call({ type: 'state.get' })
      .then(setState)
      .catch((e) => {
        if (e instanceof RpcError && e.code === 'forbidden') {
          closed = true;
          port?.disconnect();
          setError('Open PassVault from the browser toolbar button.');
        }
      });
    return () => {
      closed = true;
      if (timer) clearInterval(timer);
      port?.disconnect();
    };
  }, []);
  return { state, error };
}

/**
 * Touch ID host call for a worker that started before the "nativeMessaging" permission
 * was granted (background/touch-id.ts). Only PassVault's own host can be reached.
 */
async function relayNative(port: chrome.runtime.Port | null, id: number, message: Record<string, unknown>) {
  const reply = (r: PortMessageToBackground) => {
    try {
      port?.postMessage(r);
    } catch {
      /* popup closing */
    }
  };
  const send = (chrome.runtime as { sendNativeMessage?: (app: string, msg: object) => Promise<unknown> }).sendNativeMessage;
  if (!send) return reply({ type: 'native.reply', id, ok: false, error: 'Reopen PassVault to finish turning on Touch ID.' });
  try {
    reply({ type: 'native.reply', id, ok: true, reply: await send.call(chrome.runtime, TOUCH_ID_HOST, message) });
  } catch (e) {
    reply({ type: 'native.reply', id, ok: false, error: e instanceof Error ? e.message : 'Touch ID host not reachable' });
  }
}

/** Copy from the popup (it has the user gesture); secrets get a background-scheduled clear. */
export async function copyToClipboard(value: string, secret: boolean): Promise<string | null> {
  await navigator.clipboard.writeText(value);
  if (!secret) return null;
  try {
    const r = await call({ type: 'clipboard.scheduleClear' });
    return r.scheduled ? `Copied. Clipboard clears in ${r.seconds}s.` : 'Copied.';
  } catch {
    return 'Copied.';
  }
}

export async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}
