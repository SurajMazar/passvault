/**
 * The subset of the `chrome.*` API the background uses. Declared as an
 * interface so the controller can be unit-tested with a small in-memory fake.
 */
export interface StorageAreaLike {
  /** `null` returns every key (used once, for the legacy-storage migration). */
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface TabLike {
  id?: number;
  url?: string;
  title?: string;
}

export interface InjectionResultLike {
  frameId: number;
  result?: unknown;
}

export interface SenderLike {
  id?: string;
  url?: string;
  origin?: string;
  tab?: unknown;
  frameId?: number;
}

export interface ChromeLike {
  /** toolbar popup (inline menu: "Unlock" opens it when Chrome allows) */
  action?: { openPopup?(): Promise<void>; setBadgeText?(d: { text: string }): Promise<void> };
  runtime: {
    id: string;
    getURL(path: string): string;
    getManifest(): { version: string };
    sendMessage(message: unknown): Promise<unknown>;
    /** Touch ID host (optional "nativeMessaging" permission) */
    sendNativeMessage?(application: string, message: object): Promise<unknown>;
  };
  storage: {
    local: StorageAreaLike;
    session: StorageAreaLike & { setAccessLevel?(o: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }): Promise<void> };
  };
  alarms: {
    create(name: string, info: { delayInMinutes?: number; when?: number }): Promise<void> | void;
    clear(name: string): Promise<boolean>;
    get(name: string): Promise<{ name: string; scheduledTime: number } | undefined>;
  };
  tabs: {
    get(tabId: number): Promise<TabLike>;
    create(props: { url: string }): Promise<unknown>;
  };
  scripting: {
    registerContentScripts?(
      scripts: Array<{ id: string; matches: string[]; js: string[]; runAt?: 'document_idle' | 'document_end' | 'document_start'; allFrames?: boolean; persistAcrossSessions?: boolean; world?: 'ISOLATED' | 'MAIN' }>,
    ): Promise<void>;
    unregisterContentScripts?(filter: { ids: string[] }): Promise<void>;
    getRegisteredContentScripts?(filter: { ids: string[] }): Promise<Array<{ id: string }>>;
    executeScript(injection: {
      target: { tabId: number; frameIds?: number[] };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      func: (...args: any[]) => unknown;
      args?: unknown[];
    }): Promise<InjectionResultLike[]>;
  };
  permissions?: {
    contains(p: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    request?(p: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    remove?(p: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  };
  offscreen?: {
    createDocument(params: { url: string; reasons: string[]; justification: string }): Promise<void>;
    closeDocument(): Promise<void>;
    hasDocument?(): Promise<boolean>;
  };
}
