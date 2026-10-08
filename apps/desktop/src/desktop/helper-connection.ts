import { HELPER_EXTENSION_ID } from '../ipc/types';
import type { HelperClient } from '../ipc/helper-client';
import type { NeutralinoLike } from '../neutralino';

/**
 * Tracks whether the pv-helper extension is connected to Neutralino and keeps
 * a helper session alive:
 *  - startup: `extensions.getStats` → `hello` (or wait for `extClientConnect`)
 *  - `extClientConnect` after a crash/restart → new `hello` (old resources are gone)
 *  - `extClientDisconnect` → unavailable (pending requests fail fast)
 *  - `invalid_session` → re-`hello`
 *  - periodic `ping` liveness check
 *
 * Neutralino starts extensions only at app launch and the native allow list
 * does not include process spawning, so a helper that exited cannot be
 * relaunched from the UI; "Retry" re-runs hello and the banner tells the user
 * to restart PassVault.
 */
export class HelperConnection {
  private connected = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private helloInFlight: Promise<void> | null = null;

  constructor(
    private readonly nl: NeutralinoLike,
    private readonly helper: HelperClient,
    private readonly opts: { startupTimeoutMs?: number; pingIntervalMs?: number } = {},
  ) {}

  isConnected = () => this.connected;

  async start() {
    void this.nl.events.on('extClientConnect', (e) => {
      if (e.detail === HELPER_EXTENSION_ID) {
        this.connected = true;
        void this.hello();
      }
    });
    void this.nl.events.on('extClientDisconnect', (e) => {
      if (e.detail === HELPER_EXTENSION_ID) {
        this.connected = false;
        this.helper.markUnavailable('The desktop helper stopped. Quit and reopen PassVault to restart it.');
      }
    });
    this.helper.onSessionReset((r) => {
      if (r === 'invalid_session' && this.connected) void this.hello();
    });
    try {
      const stats = await this.nl.extensions.getStats();
      if (!stats.loaded.includes(HELPER_EXTENSION_ID)) {
        this.helper.markUnavailable('The desktop helper is not configured in this build.');
        return;
      }
      if (stats.connected.includes(HELPER_EXTENSION_ID)) {
        this.connected = true;
        await this.hello();
      }
    } catch {
      /* fall through to the startup timeout */
    }
    if (!this.helper.isReady) {
      this.startTimer = setTimeout(() => {
        if (!this.helper.isReady && !this.helloInFlight) this.helper.markUnavailable('The desktop helper did not start. Quit and reopen PassVault.');
      }, this.opts.startupTimeoutMs ?? 10_000);
    }
    this.pingTimer = setInterval(() => void this.ping(), this.opts.pingIntervalMs ?? 30_000);
  }

  stop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
  }

  hello(): Promise<void> {
    if (this.helloInFlight) return this.helloInFlight;
    this.helloInFlight = this.helper
      .hello()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.helloInFlight = null;
      });
    return this.helloInFlight;
  }

  /** "Retry" from the status banner. */
  async retry() {
    try {
      const stats = await this.nl.extensions.getStats();
      this.connected = stats.connected.includes(HELPER_EXTENSION_ID);
    } catch {
      /* keep last known */
    }
    if (!this.connected) {
      this.helper.markUnavailable('The desktop helper is not running. Quit and reopen PassVault to restart it.');
      return;
    }
    await this.hello();
  }

  private async ping() {
    if (!this.helper.isReady) return;
    try {
      await this.helper.request('ping', {}, { timeoutMs: 10_000 });
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? (e as { code: string }).code : '';
      if (code === 'timeout') this.helper.markUnavailable('The desktop helper is not responding.');
    }
  }
}
