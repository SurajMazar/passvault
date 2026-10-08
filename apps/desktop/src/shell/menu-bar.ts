import type { KeyValueBackend } from '@passvault/sync';
import { waitForNativeBridge } from './native-bridge';
import type { NeutralinoLike } from '../neutralino';
import { DEFAULT_SHORTCUT, parseShortcut, type Shortcut } from './shortcut';
import { DEFAULT_AVATAR, parseAvatar, type AvatarChoice } from './avatar-choice';

/**
 * PassVault as a menu-bar companion.
 *
 * One window, four presentations (the vault session is shared, so the buddy
 * never needs a second unlock):
 *   - full:   the regular app window;
 *   - buddy:  the expanded buddy — a small always-on-top panel;
 *   - bubble: the minimized buddy — just its avatar, floating on screen;
 *   - hidden: only the menu-bar icon.
 * Both buddy forms float above every app with their own chrome (no title
 * bar, transparent window — scripts/pvwindow.m does that natively when the
 * window is set always-on-top), can be dragged anywhere, and remember where
 * they were left.
 *
 * Settings here are device-wide (not per server or account): keep in menu
 * bar, global shortcut, quiet mode, buddy position.
 */

export type WindowMode = 'full' | 'buddy' | 'bubble' | 'hidden';
export type VaultState = 'locked' | 'ready' | 'awaiting_approval' | 'offline' | 'syncing' | 'connection_error' | 'signed_out';

export const STATE_LABEL: Record<VaultState, string> = {
  locked: 'Locked',
  ready: 'Ready',
  awaiting_approval: 'Awaiting approval',
  offline: 'Offline',
  syncing: 'Syncing',
  connection_error: 'Connection error',
  signed_out: 'Signed out',
};

type Pos = { x: number; y: number };

export interface MenuBarSettings {
  keepInMenuBar: boolean;
  /** closing the window (or minimizing the buddy) leaves the avatar bubble on screen */
  bubbleOnClose: boolean;
  shortcut: Shortcut | null;
  quiet: boolean;
  avatar: AvatarChoice;
  buddyPos: Pos | null;
  bubblePos: Pos | null;
}

export const BUDDY_SIZE = { width: 380, height: 580 };
export const BUBBLE_SIZE = { width: 96, height: 96 };
const FULL_MIN = { minWidth: 980, minHeight: 640 };
const SETTINGS_KEY = 'pvg_menubar';
const TRAY_ERROR_KEY = 'pvg_trayerror';

function describeNlError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; message?: unknown };
    return [o.code, o.message].filter((x) => typeof x === 'string' && x).join(': ') || JSON.stringify(e).slice(0, 200);
  }
  return String(e);
}

type Geometry = { width: number; height: number; x: number; y: number };

export interface MenuBarDeps {
  nl: Pick<NeutralinoLike, 'window' | 'os'>;
  kv: KeyValueBackend;
  /** registers (or clears, with null) the global shortcut in the helper */
  setHotKey: (s: Shortcut | null) => Promise<void>;
  /** screen work area in points (window.screen.avail*) */
  screen: () => { left: number; top: number; width: number; height: number };
  /** buddy ↔ bubble morph (UI side: BuddyLayer + .pv-morph in desktop.css); absent = no animation */
  motion?: { enabled(): boolean; wait(ms: number): Promise<void> };
}

/**
 * The buddy ↔ bubble morph, drawn by the page while the window keeps its size:
 *  - collapsing: the card closes like an iris onto the bubble's circle in its top-right
 *    corner (where the bubble lands) while the avatar fades in; then the window snaps
 *    to the bubble.
 *  - expanding-start → expanding: the reverse, after the window has grown (it is
 *    transparent around the circle, so nothing else shows).
 */
export type Morph = 'collapsing' | 'expanding-start' | 'expanding' | null;
export const MORPH_MS = 240;

export class MenuBar {
  private _mode: WindowMode = 'full';
  private _state: VaultState = 'signed_out';
  private _settings: MenuBarSettings = { keepInMenuBar: true, bubbleOnClose: true, shortcut: DEFAULT_SHORTCUT, quiet: false, avatar: DEFAULT_AVATAR, buddyPos: null, bubblePos: null };
  private fullGeometry: Geometry | null = null;
  private listeners = new Set<() => void>();
  private shortcutError: string | null = null;
  private _trayError: string | null = null;
  private _morph: Morph = null;
  private trayRendered = false;
  private switching: Promise<void> = Promise.resolve();

  constructor(private readonly d: MenuBarDeps) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse((await this.d.kv.get(SETTINGS_KEY)) ?? 'null') as Partial<MenuBarSettings & { shortcut: unknown }> | null;
      const pos = (p: unknown): Pos | null => {
        const v = p as Partial<Pos> | null;
        return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: Math.round(v.x!), y: Math.round(v.y!) } : null;
      };
      if (raw && typeof raw === 'object') {
        this._settings = {
          keepInMenuBar: raw.keepInMenuBar !== false,
          bubbleOnClose: raw.bubbleOnClose !== false,
          quiet: raw.quiet === true,
          shortcut: raw.shortcut === null ? null : (parseShortcut(JSON.stringify(raw.shortcut ?? null)) ?? DEFAULT_SHORTCUT),
          avatar: parseAvatar(raw.avatar),
          buddyPos: pos(raw.buddyPos),
          bubblePos: pos(raw.bubblePos),
        };
      }
    } catch {
      /* corrupt: defaults */
    }
  }

  get morph(): Morph {
    return this._morph;
  }

  private setMorph(m: Morph) {
    this._morph = m;
    this.changed();
  }

  private get animate() {
    const m = this.d.motion;
    return m && m.enabled() ? m : null;
  }

  get mode(): WindowMode {
    return this._mode;
  }
  get state(): VaultState {
    return this._state;
  }
  get settings(): MenuBarSettings {
    return this._settings;
  }
  /** why the shortcut could not be registered (taken by another app), if so */
  get hotKeyError(): string | null {
    return this.shortcutError;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed() {
    for (const l of this.listeners) l();
  }

  private async save() {
    await this.d.kv.set(SETTINGS_KEY, JSON.stringify(this._settings));
    this.changed();
  }

  async update(patch: Partial<Omit<MenuBarSettings, 'buddyPos' | 'bubblePos'>>): Promise<void> {
    if (patch.avatar) patch = { ...patch, avatar: parseAvatar(patch.avatar) };
    const prevShortcut = this._settings.shortcut;
    this._settings = { ...this._settings, ...patch };
    if ('shortcut' in patch) {
      try {
        await this.registerHotKey();
      } catch (e) {
        this._settings = { ...this._settings, shortcut: prevShortcut };
        await this.registerHotKey().catch(() => undefined);
        throw e;
      }
    }
    await this.save();
    await this.renderTray();
  }

  /** (Re)registers the shortcut, e.g. after the helper (re)started. */
  async registerHotKey(): Promise<void> {
    try {
      await this.d.setHotKey(this._settings.shortcut);
      this.shortcutError = null;
    } catch (e) {
      this.shortcutError = e instanceof Error ? e.message : String(e);
      this.changed();
      throw e;
    }
    this.changed();
  }

  setVaultState(s: VaultState) {
    if (s === this._state) return;
    this._state = s;
    this.changed();
    void this.renderTray();
  }

  // ------------------------------------------------------------- window presentation

  private serial(f: () => Promise<void>): Promise<void> {
    this.switching = this.switching.then(f, f);
    return this.switching;
  }

  private async rememberFull() {
    if (this._mode !== 'full') return;
    try {
      const [size, pos] = await Promise.all([this.d.nl.window.getSize(), this.d.nl.window.getPosition()]);
      this.fullGeometry = { width: size.width ?? 1240, height: size.height ?? 820, x: pos.x, y: pos.y };
    } catch {
      /* keep the last known geometry */
    }
  }

  /** Remember where the user dragged the buddy or its bubble. */
  async rememberBuddy() {
    if (this._mode !== 'buddy' && this._mode !== 'bubble') return;
    try {
      const p = await this.d.nl.window.getPosition();
      const pos = { x: Math.round(p.x), y: Math.round(p.y) };
      this._settings = this._mode === 'buddy' ? { ...this._settings, buddyPos: pos } : { ...this._settings, bubblePos: pos };
      await this.save();
    } catch {
      /* ignore */
    }
  }

  /** Keep a window of `size` on screen (displays may have changed since). */
  private clamp(p: Pos, size: { width: number; height: number }): Pos {
    const s = this.d.screen();
    return {
      x: Math.round(Math.min(Math.max(p.x, s.left), s.left + s.width - size.width)),
      y: Math.round(Math.min(Math.max(p.y, s.top), s.top + s.height - size.height)),
    };
  }

  private buddyPosition(from?: Pos): Pos {
    const s = this.d.screen();
    // Expanding from the bubble: grow from where the bubble sits (its top-right corner stays put).
    if (from) return this.clamp({ x: from.x + BUBBLE_SIZE.width - BUDDY_SIZE.width, y: from.y }, BUDDY_SIZE);
    return this.clamp(this._settings.buddyPos ?? { x: s.left + s.width - BUDDY_SIZE.width - 24, y: s.top + 24 }, BUDDY_SIZE);
  }

  private bubblePosition(from?: Pos): Pos {
    const s = this.d.screen();
    if (from) return this.clamp({ x: from.x + BUDDY_SIZE.width - BUBBLE_SIZE.width, y: from.y }, BUBBLE_SIZE);
    return this.clamp(this._settings.bubblePos ?? { x: s.left + s.width - BUBBLE_SIZE.width - 24, y: s.top + 24 }, BUBBLE_SIZE);
  }

  /** Expanded buddy (panel). */
  showBuddy(): Promise<void> {
    return this.serial(async () => {
      const w = this.d.nl.window;
      let from: Pos | undefined;
      if (this._mode === 'bubble') {
        await this.rememberBuddy();
        from = this._settings.bubblePos ?? undefined;
      } else await this.rememberFull();
      const pos = this.buddyPosition(from);
      const anim = this._mode === 'bubble' ? this.animate : null;
      if (anim) {
        // The card mounts closed onto the bubble's circle; the window grows around it.
        this._mode = 'buddy';
        this.setMorph('expanding-start');
        await anim.wait(16);
      }
      // Float first: that switches to the buddy's chrome (no title bar), so the size below is the whole window.
      await w.setAlwaysOnTop(true);
      await w.setSize({ ...BUDDY_SIZE, minWidth: 320, minHeight: 420, resizable: false });
      await w.move(pos.x, pos.y);
      await w.show();
      await w.unminimize().catch(() => undefined);
      await w.focus();
      this._mode = 'buddy';
      if (anim) {
        await anim.wait(16);
        this.setMorph('expanding');
        await anim.wait(MORPH_MS);
        this._morph = null;
      }
      this.changed();
    });
  }

  /** Minimized buddy: just the avatar, floating on screen. */
  showBubble(): Promise<void> {
    return this.serial(async () => {
      const w = this.d.nl.window;
      let from: Pos | undefined;
      if (this._mode === 'buddy') {
        await this.rememberBuddy();
        from = this._settings.bubblePos ? undefined : (this._settings.buddyPos ?? undefined);
      } else await this.rememberFull();
      const pos = this.bubblePosition(from);
      const anim = this._mode === 'buddy' ? this.animate : null;
      if (anim) {
        this.setMorph('collapsing');
        await anim.wait(MORPH_MS);
      }
      await w.setAlwaysOnTop(true); // chrome first (see showBuddy)
      await w.setSize({ ...BUBBLE_SIZE, minWidth: BUBBLE_SIZE.width, minHeight: BUBBLE_SIZE.height, resizable: false });
      await w.move(pos.x, pos.y);
      await w.show();
      this._mode = 'bubble';
      this._morph = null;
      this.changed();
    });
  }

  /** Minimize the buddy: to the bubble, or to the menu bar when the bubble is turned off. */
  minimizeBuddy(): Promise<void> {
    return this._settings.bubbleOnClose ? this.showBubble() : this.hide();
  }

  showFull(): Promise<void> {
    return this.serial(async () => {
      const w = this.d.nl.window;
      if (this._mode === 'buddy' || this._mode === 'bubble') await this.rememberBuddy();
      await w.setAlwaysOnTop(false);
      const g = this.fullGeometry;
      await w.setSize({ width: g?.width ?? 1240, height: g?.height ?? 820, ...FULL_MIN, resizable: true });
      if (g) await w.move(g.x, g.y);
      await w.show();
      await w.unminimize().catch(() => undefined);
      await w.focus();
      this._mode = 'full';
      this.changed();
    });
  }

  hide(): Promise<void> {
    return this.serial(async () => {
      if (this._mode === 'buddy' || this._mode === 'bubble') await this.rememberBuddy();
      else await this.rememberFull();
      await this.d.nl.window.hide();
      this._mode = 'hidden';
      this.changed();
    });
  }

  /** Global shortcut: open the buddy, or minimize it when it is already open. */
  async toggleBuddy(): Promise<void> {
    if (this._mode === 'buddy' && (await this.d.nl.window.isVisible().catch(() => true))) return this.minimizeBuddy();
    return this.showBuddy();
  }

  async resetBuddyPosition(): Promise<void> {
    this._settings = { ...this._settings, buddyPos: null, bubblePos: null };
    await this.save();
    if (this._mode === 'buddy' || this._mode === 'bubble') {
      const p = this._mode === 'buddy' ? this.buddyPosition() : this.bubblePosition();
      await this.d.nl.window.move(p.x, p.y);
    }
  }

  /**
   * Lets the user drag the buddy (or its bubble) by `el`. Moving the pointer a
   * few pixels hands over to the native window drag; a press without moving is
   * a click (`onClick`, e.g. expand the bubble). The position is remembered.
   */
  makeDraggable(el: HTMLElement, opts: { exclude?: HTMLElement[]; onClick?: () => void } = {}): () => void {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || opts.exclude?.some((x) => x.contains(e.target as Node))) return;
      const start = { x: e.screenX, y: e.screenY };
      let dragging = false;
      const move = (m: PointerEvent) => {
        if (dragging || Math.hypot(m.screenX - start.x, m.screenY - start.y) < 4) return;
        dragging = true;
        cleanup();
        void this.d.nl.window
          .beginDrag(m.screenX, m.screenY)
          .catch(() => undefined)
          .then(() => setTimeout(() => void this.rememberBuddy(), 300));
      };
      const up = () => {
        cleanup();
        if (!dragging) opts.onClick?.();
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    el.addEventListener('pointerdown', onDown);
    return () => el.removeEventListener('pointerdown', onDown);
  }

  // ------------------------------------------------------------- menu-bar menu

  /**
   * The menu-bar menu: short plain titles only. macOS sizes this native menu
   * from its titles; symbols such as ⌃⌥ or long labels made it draw the
   * highlight and text past the menu's edge.
   */
  trayMenu() {
    const locked = this._state === 'locked' || this._state === 'signed_out';
    return [
      { id: 'status', text: `PassVault: ${STATE_LABEL[this._state]}`, isDisabled: true },
      { id: 'sep1', text: '-' },
      { id: 'buddy', text: 'Show Buddy' },
      { id: 'open', text: 'Open PassVault' },
      { id: 'sep2', text: '-' },
      { id: 'lock', text: 'Lock Vault', isDisabled: locked },
      { id: 'settings', text: 'Settings…' },
      { id: 'sep3', text: '-' },
      { id: 'quit', text: 'Quit PassVault' },
    ];
  }

  /** Why the menu-bar icon could not be shown (null when it is). */
  get trayError(): string | null {
    return this._trayError;
  }

  async renderTray(): Promise<void> {
    let error: string | null = null;
    // The shell creates the item natively, on the main thread. Neutralino's own os.setTray works off
    // the main thread and silently shows nothing on current macOS; it is only the fallback.
    const bridge = await waitForNativeBridge(this.trayRendered ? 0 : 3000);
    this.trayRendered = true;
    try {
      if (bridge) bridge.postMessage({ cmd: 'tray', items: this.trayMenu() });
      else await this.d.nl.os.setTray({ icon: '/resources/icons/trayIcon.png', menuItems: this.trayMenu(), useTemplateIcon: true } as never);
    } catch (e) {
      error = describeNlError(e);
    }
    if (error === this._trayError) return;
    this._trayError = error;
    // kept for diagnosis (Settings shows it too); never contains vault data
    await (error ? this.d.kv.set(TRAY_ERROR_KEY, error) : this.d.kv.remove(TRAY_ERROR_KEY)).catch(() => undefined);
    this.changed();
  }
}
