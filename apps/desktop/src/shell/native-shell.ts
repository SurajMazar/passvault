import type { NeutralinoLike } from '../neutralino';

/**
 * macOS shell integration: main menu (needed for ⌘C/⌘V/⌘A in a WKWebView),
 * menu-bar (tray) menu, and the window-close / quit flow.
 *
 * `exitProcessOnClose` is false in neutralino.config.json, so closing the
 * window raises `windowClose` for both this UI and the helper extension. We
 * lock (wiping keys in this process), clear our clipboard secret if it is
 * still there, and exit. The helper cleans up on its own `windowClose` /
 * socket close. Nothing secret is sent on exit.
 */

export interface ShellDeps {
  lockVault(): void;
  beforeExit(): Promise<unknown>;
  openLink(url: string): void;
}

const MENU_CB = 'menuCallback:';

export const MAIN_MENU = [
  {
    id: 'app',
    text: 'PassVault',
    menuItems: [
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

export const TRAY_MENU = [
  { id: 'open', text: 'Open PassVault' },
  { id: 'lock', text: 'Lock vault' },
  { id: 'sep', text: '-' },
  { id: 'quit', text: 'Quit PassVault' },
];

export class NativeShell {
  private quitting = false;

  constructor(
    private readonly nl: NeutralinoLike,
    private readonly deps: ShellDeps,
  ) {}

  async install() {
    await this.nl.window.setMainMenu(MAIN_MENU).catch(() => undefined);
    await this.nl.os.setTray({ icon: '/resources/icons/trayIcon.png', menuItems: TRAY_MENU, useTemplateIcon: true } as never).catch(() => undefined);
    void this.nl.events.on('trayMenuItemClicked', (e) => this.onMenu((e.detail as { id?: string })?.id));
    void this.nl.events.on('mainMenuItemClicked', (e) => this.onMenu((e.detail as { id?: string })?.id));
    void this.nl.events.on('windowClose', () => void this.quit());
    // window.newWindowPolicy = "custom": target=_blank / window.open requests come here.
    void this.nl.events.on('newWindowRequest', (e) => {
      const d = e.detail as { url?: string } | string;
      const url = typeof d === 'string' ? d : d?.url;
      if (url) this.deps.openLink(url);
    });
  }

  onMenu(id: string | undefined) {
    switch (id) {
      case 'open':
        void this.bringToFront();
        break;
      case 'lock':
        this.deps.lockVault();
        break;
      case 'quit':
        void this.quit();
        break;
    }
  }

  async bringToFront() {
    await this.nl.window.show().catch(() => undefined);
    await this.nl.window.unminimize().catch(() => undefined);
    await this.nl.window.focus().catch(() => undefined);
  }

  async quit() {
    if (this.quitting) return;
    this.quitting = true;
    try {
      this.deps.lockVault();
      await Promise.race([this.deps.beforeExit(), new Promise((r) => setTimeout(r, 800))]);
    } finally {
      await this.nl.app.exit(0);
    }
  }
}
