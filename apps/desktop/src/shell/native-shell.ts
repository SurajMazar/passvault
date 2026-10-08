import type { NeutralinoLike } from '../neutralino';
import type { MenuBar } from './menu-bar';
import { nativeBridge } from './native-bridge';

/**
 * macOS shell integration: main menu (needed for ⌘C/⌘V/⌘A in a WKWebView),
 * the menu-bar (tray) menu, and the window-close / quit flow.
 *
 * `exitProcessOnClose` is false in neutralino.config.json, so closing the
 * window raises `windowClose`. With "Keep PassVault in the menu bar" (the
 * default) the window is hidden and PassVault stays available from the menu
 * bar and the global shortcut; the vault keeps its normal auto-lock. Quit (⌘Q
 * or the menu) locks (wiping keys in this process), clears our clipboard
 * secret if it is still there, and exits. Nothing secret is sent on exit.
 */

export interface ShellDeps {
  lockVault(): void;
  beforeExit(): Promise<unknown>;
  openLink(url: string): void;
  /** quick actions from the menu bar */
  quickSave(): void;
  generate(): void;
  openSettings(): void;
}

const MENU_CB = 'menuCallback:';

export const MAIN_MENU = [
  {
    id: 'app',
    text: 'PassVault',
    menuItems: [
      { id: 'buddy', text: 'Show Buddy', action: MENU_CB, shortcut: 'b' },
      { id: 'lock', text: 'Lock Vault', action: MENU_CB, shortcut: 'L' },
      { text: '-' },
      { id: 'hide', text: 'Hide PassVault', action: 'hide:', shortcut: 'h' },
      { id: 'hideOthers', text: 'Hide Others', action: 'hideOtherApplications:' },
      { id: 'showAll', text: 'Show All', action: 'unhideAllApplications:' },
      { text: '-' },
      { id: 'quit', text: 'Quit PassVault', action: MENU_CB, shortcut: 'q' },
    ],
  },
  {
    id: 'edit',
    text: 'Edit',
    menuItems: [
      { id: 'undo', text: 'Undo', action: 'undo:', shortcut: 'z' },
      { id: 'redo', text: 'Redo', action: 'redo:', shortcut: 'Z' },
      { text: '-' },
      { id: 'cut', text: 'Cut', action: 'cut:', shortcut: 'x' },
      { id: 'copy', text: 'Copy', action: 'copy:', shortcut: 'c' },
      { id: 'paste', text: 'Paste', action: 'paste:', shortcut: 'v' },
      { id: 'selectAll', text: 'Select All', action: 'selectAll:', shortcut: 'a' },
    ],
  },
  {
    id: 'window',
    text: 'Window',
    menuItems: [
      { id: 'minimize', text: 'Minimize', action: 'performMiniaturize:', shortcut: 'm' },
      { id: 'zoom', text: 'Zoom', action: 'performZoom:' },
      { id: 'fullscreen', text: 'Enter Full Screen', action: 'toggleFullScreen:' },
    ],
  },
];

export class NativeShell {
  private quitting = false;

  constructor(
    private readonly nl: NeutralinoLike,
    private readonly menuBar: MenuBar,
    private readonly deps: ShellDeps,
  ) {}

  async install() {
    await this.nl.window.setMainMenu(MAIN_MENU).catch(() => undefined);
    void this.nl.events.on('trayMenuItemClicked', (e) => this.onMenu((e.detail as { id?: string })?.id));
    // menu-bar item created by the shell's native bridge (scripts/pvwindow.m)
    globalThis.addEventListener?.('pv-tray', (e) => {
      const id = (e as CustomEvent<unknown>).detail;
      if (typeof id === 'string') this.onMenu(id);
    });
    void this.nl.events.on('mainMenuItemClicked', (e) => this.onMenu((e.detail as { id?: string })?.id));
    void this.nl.events.on('windowClose', () => void this.onWindowClose());
    // window.newWindowPolicy = "custom": target=_blank / window.open requests come here.
    void this.nl.events.on('newWindowRequest', (e) => {
      const d = e.detail as { url?: string } | string;
      const url = typeof d === 'string' ? d : d?.url;
      if (url) this.deps.openLink(url);
    });
    // last: it may wait briefly for the native bridge
    await this.menuBar.renderTray();
  }

  onMenu(id: string | undefined) {
    switch (id) {
      case 'buddy':
        void this.menuBar.showBuddy();
        break;
      case 'bubble':
        void this.menuBar.showBubble();
        break;
      case 'open':
        void this.menuBar.showFull();
        break;
      case 'save':
        void this.menuBar.showBuddy().then(() => this.deps.quickSave());
        break;
      case 'generate':
        void this.menuBar.showBuddy().then(() => this.deps.generate());
        break;
      case 'settings':
        void this.menuBar.showFull().then(() => this.deps.openSettings());
        break;
      case 'quiet':
        void this.menuBar.update({ quiet: !this.menuBar.settings.quiet });
        break;
      case 'lock':
        this.deps.lockVault();
        break;
      case 'quit':
        void this.quit();
        break;
    }
  }

  async onWindowClose() {
    if (!this.menuBar.settings.keepInMenuBar || this.quitting) return this.quit();
    // The buddy stays on screen as its bubble, or PassVault waits in the menu bar.
    await (this.menuBar.settings.bubbleOnClose ? this.menuBar.showBubble() : this.menuBar.hide());
  }

  async bringToFront() {
    await this.menuBar.showFull();
  }

  async quit() {
    if (this.quitting) return;
    this.quitting = true;
    try {
      this.deps.lockVault();
      await Promise.race([this.deps.beforeExit(), new Promise((r) => setTimeout(r, 800))]);
    } finally {
      // Neutralino's app.exit tears its menu-bar item down off the main thread, which current
      // macOS aborts on. The shell's native bridge (scripts/pvwindow.m) quits the macOS way instead.
      const bridge = nativeBridge();
      if (bridge) {
        bridge.postMessage({ cmd: 'quit' });
        await new Promise((r) => setTimeout(r, 1500)); // normally never returns: the app terminates
      }
      await this.nl.app.exit(0);
    }
  }
}
