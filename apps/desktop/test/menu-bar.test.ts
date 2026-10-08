import { describe, expect, it, vi } from 'vitest';
import { BUBBLE_SIZE, BUDDY_SIZE, MenuBar } from '../src/shell/menu-bar';
import { NativeShell } from '../src/shell/native-shell';
import { DEFAULT_SHORTCUT, formatShortcut, fromKeyEvent, helperParams, macKeyCode, parseShortcut, shortcutProblem } from '../src/shell/shortcut';
import type { NeutralinoLike } from '../src/neutralino';

function memKv() {
  const m = new Map<string, string>();
  return { m, get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), remove: async (k: string) => void m.delete(k) };
}

function fakeNl() {
  const calls: string[] = [];
  const state = { size: { width: 1240, height: 820 }, pos: { x: 100, y: 80 }, visible: true, onTop: false };
  const tray: unknown[] = [];
  const window = {
    show: async () => void (calls.push('show'), (state.visible = true)),
    focus: async () => void calls.push('focus'),
    unminimize: async () => void calls.push('unminimize'),
    setMainMenu: async () => undefined,
    hide: async () => void (calls.push('hide'), (state.visible = false)),
    isVisible: async () => state.visible,
    getSize: async () => ({ ...state.size }),
    setSize: async (o: { width?: number; height?: number }) => void (calls.push(`setSize ${o.width}x${o.height}`), (state.size = { width: o.width ?? state.size.width, height: o.height ?? state.size.height })),
    getPosition: async () => ({ ...state.pos }),
    move: async (x: number, y: number) => void (calls.push(`move ${x},${y}`), (state.pos = { x, y })),
    setAlwaysOnTop: async (v: boolean) => void (calls.push(`onTop ${v}`), (state.onTop = v)),
    beginDrag: async () => undefined,
  };
  const handlers = new Map<string, (e: CustomEvent) => void>();
  const nl = {
    window,
    os: { setTray: async (o: { menuItems: unknown[] }) => void tray.push(o.menuItems), showOpenDialog: async () => [], showSaveDialog: async () => '' },
    events: { on: async (ev: string, h: (e: CustomEvent) => void) => void handlers.set(ev, h), off: async () => undefined },
    app: { exit: vi.fn(async () => undefined) },
  } as unknown as NeutralinoLike;
  return { nl, calls, state, tray, handlers };
}

const SCREEN = { left: 0, top: 25, width: 1512, height: 920 };

async function setup(stored?: unknown) {
  const kv = memKv();
  if (stored) kv.m.set('pvg_menubar', JSON.stringify(stored));
  const f = fakeNl();
  const hot: Array<unknown> = [];
  const mb = new MenuBar({ nl: f.nl, kv, setHotKey: async (s) => void hot.push(s), screen: () => SCREEN });
  await mb.load();
  return { ...f, kv, mb, hot };
}

describe('global shortcut model', () => {
  it('maps keys to macOS key codes and formats them in macOS order', () => {
    expect(macKeyCode('KeyP')).toBe(0x23);
    expect(macKeyCode('Space')).toBe(0x31);
    expect(macKeyCode('F19')).toBe(0x50);
    expect(macKeyCode('Unknown')).toBeNull();
    expect(formatShortcut(DEFAULT_SHORTCUT)).toBe('⌃⌥P');
    expect(formatShortcut({ code: 'Space', cmd: true, shift: true, option: false, control: false })).toBe('⇧⌘Space');
    expect(helperParams(DEFAULT_SHORTCUT)).toEqual({ keyCode: 0x23, cmd: false, shift: false, option: true, control: true });
  });

  it('refuses combinations that would hijack normal keys or app shortcuts', () => {
    expect(shortcutProblem({ code: 'KeyP', cmd: false, shift: true, option: false, control: false })).toMatch(/⌘, ⌃ or ⌥/);
    expect(shortcutProblem({ code: 'KeyC', cmd: true, shift: false, option: false, control: false })).toMatch(/other apps/);
    expect(shortcutProblem({ code: 'KeyC', cmd: true, shift: true, option: false, control: false })).toBeNull();
    expect(shortcutProblem({ code: 'Enter', cmd: true, shift: true, option: false, control: false })).toMatch(/letter/);
  });

  it('records from key events and ignores lone modifiers', () => {
    expect(fromKeyEvent({ code: 'MetaLeft', metaKey: true, shiftKey: false, altKey: false, ctrlKey: false })).toBeNull();
    expect(fromKeyEvent({ code: 'KeyK', metaKey: true, shiftKey: true, altKey: false, ctrlKey: false })).toEqual({ code: 'KeyK', cmd: true, shift: true, option: false, control: false });
    expect(parseShortcut('{"code":"KeyC","cmd":true}')).toBeNull(); // invalid stored value
    expect(parseShortcut('not json')).toBeNull();
  });
});

describe('menu-bar buddy window', () => {
  it('turns the window into a small always-on-top buddy and back, restoring size and position', async () => {
    const { mb, calls, state } = await setup();
    await mb.showBuddy();
    expect(mb.mode).toBe('buddy');
    expect(state.size).toEqual(BUDDY_SIZE);
    expect(state.onTop).toBe(true);
    expect(state.pos).toEqual({ x: SCREEN.width - BUDDY_SIZE.width - 24, y: SCREEN.top + 24 }); // top right by default
    await mb.showFull();
    expect(mb.mode).toBe('full');
    expect(state.onTop).toBe(false);
    expect(state.size).toEqual({ width: 1240, height: 820 });
    expect(state.pos).toEqual({ x: 100, y: 80 });
    expect(calls.filter((c) => c === 'focus').length).toBe(2);
  });

  it('remembers where the buddy was dragged and keeps it on screen', async () => {
    const { mb, state, kv } = await setup();
    await mb.showBuddy();
    state.pos = { x: 300, y: 200 }; // the user dragged it
    await mb.hide();
    expect(JSON.parse(kv.m.get('pvg_menubar')!).buddyPos).toEqual({ x: 300, y: 200 });
    await mb.showBuddy();
    expect(state.pos).toEqual({ x: 300, y: 200 });
    // a position from a display that is gone is pulled back on screen
    const again = await setup({ buddyPos: { x: 5000, y: -300 } });
    await again.mb.showBuddy();
    expect(again.state.pos.x).toBe(SCREEN.width - BUDDY_SIZE.width);
    expect(again.state.pos.y).toBe(SCREEN.top);
    await again.mb.resetBuddyPosition();
    expect(again.state.pos).toEqual({ x: SCREEN.width - BUDDY_SIZE.width - 24, y: SCREEN.top + 24 });
  });

  it('the shortcut opens the buddy and minimizes it to its bubble (or the menu bar)', async () => {
    const { mb, state } = await setup();
    await mb.toggleBuddy();
    expect(mb.mode).toBe('buddy');
    await mb.toggleBuddy();
    expect(mb.mode).toBe('bubble');
    expect(state.size).toEqual(BUBBLE_SIZE);
    expect(state.onTop).toBe(true);
    await mb.toggleBuddy();
    expect(mb.mode).toBe('buddy');
    await mb.update({ bubbleOnClose: false });
    await mb.toggleBuddy();
    expect(mb.mode).toBe('hidden');
    expect(state.visible).toBe(false);
  });

  it('the bubble and the panel grow from each other; only they float on top', async () => {
    const { mb, state } = await setup();
    await mb.showBubble();
    state.pos = { x: 900, y: 300 }; // dragged
    await mb.showBuddy(); // expands from the bubble: its top-right corner stays put
    expect(state.pos).toEqual({ x: 900 + BUBBLE_SIZE.width - BUDDY_SIZE.width, y: 300 });
    expect(state.onTop).toBe(true);
    await mb.showFull();
    expect(state.onTop).toBe(false);
    expect(mb.mode).toBe('full');
  });

  it('settings persist; a refused shortcut is reverted with the reason', async () => {
    const kv = memKv();
    const f = fakeNl();
    let refuse = false;
    const mb = new MenuBar({
      nl: f.nl,
      kv,
      setHotKey: async () => {
        if (refuse) throw new Error('that shortcut is already used by another application');
      },
      screen: () => SCREEN,
    });
    await mb.load();
    expect(mb.settings).toMatchObject({ keepInMenuBar: true, quiet: false, shortcut: DEFAULT_SHORTCUT });
    const sc = { code: 'KeyK', cmd: true, shift: true, option: false, control: false };
    await mb.update({ shortcut: sc, quiet: true });
    expect(JSON.parse(kv.m.get('pvg_menubar')!)).toMatchObject({ shortcut: sc, quiet: true });
    refuse = true;
    await expect(mb.update({ shortcut: DEFAULT_SHORTCUT })).rejects.toThrow(/another application/);
    expect(mb.settings.shortcut).toEqual(sc);
    expect(mb.hotKeyError).toMatch(/another application/);
  });

  it('the menu-bar menu is short and plain, shows the vault state and disables Lock while locked', async () => {
    const { mb, tray } = await setup();
    mb.setVaultState('locked');
    await mb.renderTray();
    const items = tray.at(-1) as Array<{ id: string; text: string; isDisabled?: boolean }>;
    expect(items.map((i) => i.text)).toEqual(['PassVault: Locked', '-', 'Show Buddy', 'Open PassVault', '-', 'Lock Vault', 'Settings…', '-', 'Quit PassVault']);
    expect(items[0]).toMatchObject({ isDisabled: true });
    expect(items.find((i) => i.id === 'lock')?.isDisabled).toBe(true);
    // no symbols or dashes that make macOS mis-size the menu
    for (const i of items) expect(i.text).toMatch(/^[\w :.…-]+$/);
    mb.setVaultState('ready');
    await mb.renderTray();
    const after = tray.at(-1) as typeof items;
    expect(after[0]!.text).toBe('PassVault: Ready');
    expect(after.find((i) => i.id === 'lock')?.isDisabled).toBe(false);
  });
});

describe('closing the window', () => {
  it('keeps PassVault in the menu bar, or quits (locking) when that is turned off', async () => {
    const { mb, nl, handlers, state } = await setup();
    const lock = vi.fn();
    const shell = new NativeShell(nl, mb, { lockVault: lock, beforeExit: async () => undefined, openLink: () => undefined, quickSave: () => undefined, generate: () => undefined, openSettings: () => undefined });
    await shell.install();
    handlers.get('windowClose')!(new CustomEvent('windowClose'));
    await vi.waitFor(() => expect(mb.mode).toBe('bubble')); // the buddy stays on screen as its bubble
    expect(lock).not.toHaveBeenCalled();
    await mb.update({ bubbleOnClose: false });
    handlers.get('windowClose')!(new CustomEvent('windowClose'));
    await vi.waitFor(() => expect(mb.mode).toBe('hidden'));
    expect(state.visible).toBe(false);
    expect(lock).not.toHaveBeenCalled();
    await mb.update({ keepInMenuBar: false });
    handlers.get('windowClose')!(new CustomEvent('windowClose'));
    await vi.waitFor(() => expect(nl.app.exit).toHaveBeenCalled());
    expect(lock).toHaveBeenCalled();
  });
});

describe('buddy ↔ bubble morph', () => {
  async function animated() {
    const kv = memKv();
    const f = fakeNl();
    const log: string[] = [];
    const mb = new MenuBar({
      nl: f.nl,
      kv,
      setHotKey: async () => undefined,
      screen: () => SCREEN,
      motion: { enabled: () => true, wait: async (ms) => void log.push(`wait ${ms} morph=${mb.morph}`) },
    });
    await mb.load();
    return { ...f, mb, log };
  }

  it('closes the card onto the bubble before the window shrinks', async () => {
    const { mb, calls, log } = await animated();
    await mb.showBuddy();
    calls.length = 0;
    await mb.showBubble();
    expect(log.at(-1)).toBe('wait 240 morph=collapsing');
    expect(calls[0]).toBe('onTop true'); // the window changes only after the morph
    expect(calls).toContain(`setSize ${BUBBLE_SIZE.width}x${BUBBLE_SIZE.height}`);
    expect(mb.mode).toBe('bubble');
    expect(mb.morph).toBeNull();
  });

  it('grows the window first, then opens the card from the bubble', async () => {
    const { mb, log } = await animated();
    await mb.showBubble();
    log.length = 0;
    await mb.showBuddy();
    expect(log).toEqual(['wait 16 morph=expanding-start', 'wait 16 morph=expanding-start', 'wait 240 morph=expanding']);
    expect(mb.mode).toBe('buddy');
    expect(mb.morph).toBeNull();
  });

  it('does not animate without motion (reduced motion or tests)', async () => {
    const { mb } = await setup();
    await mb.showBuddy();
    await mb.showBubble();
    expect(mb.morph).toBeNull();
  });
});
