import type { CacheStore } from '@passvault/sync';
import type { ClientType } from '@passvault/types';

/**
 * Platform capabilities. Each client (web, extension, desktop) provides an
 * implementation; native-only capabilities are optional and feature-detected
 * so no native code is bundled into the web client.
 */
export interface TokenStorage {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** Small non-secret preferences (device id, last email, UI prefs). */
export interface PrefsStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ClipboardAdapter {
  /** Copies text and clears it after `clearAfterSeconds` if the clipboard still holds it (best effort). */
  copySecret(text: string, clearAfterSeconds: number): Promise<void>;
  copyText(text: string): Promise<void>;
}

export interface FileAdapter {
  /** Let the user choose a file to import; returns its text or null if cancelled. */
  pickTextFile(opts: { title: string; maxBytes: number; extensions?: string[] }): Promise<{ name: string; text: string } | null>;
  /**
   * Save plaintext the user explicitly chose to export. Implementations must
   * ask for the destination, confirm overwrite, and (on macOS desktop) write
   * owner-only (0600) permissions.
   */
  saveTextFile(opts: { suggestedName: string; text: string }): Promise<{ saved: boolean; location?: string; ownerOnly?: boolean }>;
}

export interface BiometricUnlockAdapter {
  /** What the user calls it here: "Touch ID" (default), "Windows Hello", … */
  label?: string;
  /** One sentence on where the unlock key lives (Settings). */
  description?: string;
  status(): Promise<{ available: boolean; reason?: string }>;
  /** Store a device unlock key protected by biometrics. */
  storeKey(accountId: string, key: Uint8Array): Promise<void>;
  /** Retrieve it; triggers the OS biometric prompt. */
  retrieveKey(accountId: string, reason: string): Promise<Uint8Array>;
  removeKey(accountId: string): Promise<void>;
}

export interface Platform {
  clientType: ClientType;
  deviceName: string;
  apiBaseUrl: string;
  webAppUrl: string;
  tokens: TokenStorage;
  prefs: PrefsStorage;
  createCacheStore(accountScope: string): CacheStore;
  clipboard: ClipboardAdapter;
  files: FileAdapter;
  biometrics?: BiometricUnlockAdapter;
  openExternal(url: string): Promise<void>;
  /** Optional fetch override (tests, or platforms routing HTTP differently). */
  fetchImpl?: typeof fetch;
}

export class BrowserClipboard implements ClipboardAdapter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  async copyText(text: string) {
    await navigator.clipboard.writeText(text);
  }
  async copySecret(text: string, clearAfterSeconds: number) {
    await navigator.clipboard.writeText(text);
    if (this.timer) clearTimeout(this.timer);
    if (clearAfterSeconds > 0) {
      this.timer = setTimeout(async () => {
        try {
          // Only clear if the clipboard still contains our secret (needs read permission; otherwise skip).
          const current = await navigator.clipboard.readText();
          if (current === text) await navigator.clipboard.writeText('');
        } catch {
          /* no read permission or document not focused: leave clipboard untouched */
        }
      }, clearAfterSeconds * 1000);
    }
  }
}
