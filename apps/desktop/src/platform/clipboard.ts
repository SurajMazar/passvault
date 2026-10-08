import type { ClipboardAdapter } from '@passvault/vault-core';

export interface ClipboardBackend {
  readText(): Promise<string>;
  writeText(text: string): Promise<unknown>;
}

/**
 * Clipboard with auto-clear. After `clearAfterSeconds` the clipboard is read
 * back and cleared only if it still contains the copied secret, so anything
 * the user copied afterwards is never touched. A newer copy cancels the
 * pending clear of an older one.
 */
export class DesktopClipboard implements ClipboardAdapter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSecret: string | null = null;

  constructor(private readonly backend: ClipboardBackend) {}

  async copyText(text: string) {
    this.cancel();
    await this.backend.writeText(text);
  }

  async copySecret(text: string, clearAfterSeconds: number) {
    this.cancel();
    await this.backend.writeText(text);
    this.lastSecret = text;
    if (clearAfterSeconds > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.clearIfUnchanged();
      }, clearAfterSeconds * 1000);
    }
  }

  /** Clears the clipboard now if it still holds the last copied secret (e.g. on lock/quit). */
  async clearIfUnchanged(): Promise<boolean> {
    const secret = this.lastSecret;
    if (secret === null) return false;
    try {
      const current = await this.backend.readText();
      if (current !== secret) {
        this.lastSecret = null;
        return false;
      }
      await this.backend.writeText('');
      this.lastSecret = null;
      return true;
    } catch {
      return false;
    }
  }

  private cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastSecret = null;
  }
}
