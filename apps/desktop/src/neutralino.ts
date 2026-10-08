import { HELPER_EXTENSION_ID, EVENT_EVENT, REQUEST_EVENT, RESPONSE_EVENT, type RequestEnvelope } from './ipc/types';
import type { HelperTransport } from './ipc/helper-client';

/**
 * The subset of the Neutralinojs client API the desktop app uses. Every
 * method here must be covered by `nativeAllowList` in neutralino.config.json
 * (events.on/off are client-side only). Tests pass a fake implementation.
 */
export interface NeutralinoLike {
  events: {
    on(event: string, handler: (e: CustomEvent) => void): Promise<unknown>;
    off(event: string, handler: (e: CustomEvent) => void): Promise<unknown>;
  };
  extensions: {
    dispatch(extensionId: string, event: string, data?: unknown): Promise<unknown>;
    getStats(): Promise<{ loaded: string[]; connected: string[] }>;
  };
  app: { exit(code?: number): Promise<unknown> };
  window: {
    show(): Promise<unknown>;
    focus(): Promise<unknown>;
    unminimize(): Promise<unknown>;
    setMainMenu(menu: unknown): Promise<unknown>;
  };
  os: {
    showOpenDialog(title?: string, options?: { filters?: Array<{ name: string; extensions: string[] }>; multiSelections?: boolean; defaultPath?: string }): Promise<string[]>;
    showSaveDialog(title?: string, options?: { filters?: Array<{ name: string; extensions: string[] }>; defaultPath?: string; forceOverwrite?: boolean }): Promise<string>;
    setTray(options: { icon: string; menuItems: Array<{ id?: string; text: string; isDisabled?: boolean; isChecked?: boolean }> }): Promise<unknown>;
  };
  storage: {
    getData(key: string): Promise<string>;
    setData(key: string, data: string | null): Promise<unknown>;
    removeData(key: string): Promise<unknown>;
    getKeys(): Promise<string[]>;
  };
  clipboard: {
    readText(): Promise<string>;
    writeText(text: string): Promise<unknown>;
  };
}

export function helperTransport(nl: NeutralinoLike, isConnected: () => boolean): HelperTransport {
  return {
    async send(req: RequestEnvelope) {
      // Neutralino's client queues dispatches to extensions that are not
      // connected; fail fast instead so secrets are never queued indefinitely.
      if (!isConnected()) throw new Error('helper extension is not connected');
      await nl.extensions.dispatch(HELPER_EXTENSION_ID, REQUEST_EVENT, req);
    },
    subscribe(onResponse, onEvent) {
      const r = (e: CustomEvent) => onResponse(e.detail);
      const v = (e: CustomEvent) => onEvent(e.detail);
      void nl.events.on(RESPONSE_EVENT, r);
      void nl.events.on(EVENT_EVENT, v);
      return () => {
        void nl.events.off(RESPONSE_EVENT, r);
        void nl.events.off(EVENT_EVENT, v);
      };
    },
  };
}

/** Neutralino error objects look like `{ code: 'NE_…', message }`. */
export function nlErrorCode(e: unknown): string | null {
  return e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : null;
}
