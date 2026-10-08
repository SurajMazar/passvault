import { useEffect, useState, useSyncExternalStore } from 'react';
import { Keyboard, PanelTopOpen } from 'lucide-react';
import { Banner, Button, Kbd, Switch } from '@passvault/ui';
import type { MenuBar } from '../shell/menu-bar';
import { AvatarPicker } from './BuddyView';
import { DEFAULT_SHORTCUT, formatShortcut, fromKeyEvent, shortcutProblem, type Shortcut } from '../shell/shortcut';

export interface LoginItemApi {
  status(): Promise<{ enabled: boolean; stale: boolean }>;
  set(enabled: boolean): Promise<{ enabled: boolean; stale: boolean }>;
}

/** Settings → Menu bar & buddy. */
export function MenuBarSettings({ menuBar, loginItem, capabilities }: { menuBar: MenuBar; loginItem: LoginItemApi; capabilities: { hotkey: boolean; loginItem: boolean } }) {
  useSyncExternalStore(
    (cb) => menuBar.subscribe(cb),
    () => JSON.stringify(menuBar.settings) + (menuBar.hotKeyError ?? '') + '|' + (menuBar.trayError ?? ''),
  );
  const s = menuBar.settings;
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState<Shortcut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<{ enabled: boolean; stale: boolean } | null>(null);

  useEffect(() => {
    if (capabilities.loginItem) void loginItem.status().then(setLogin, () => setLogin(null));
  }, [loginItem, capabilities.loginItem]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        setPending(null);
        return;
      }
      const sc = fromKeyEvent(e);
      if (!sc) return;
      const problem = shortcutProblem(sc);
      setPending(sc);
      if (problem) {
        setError(problem);
        return;
      }
      setRecording(false);
      setError(null);
      menuBar.update({ shortcut: sc }).then(
        () => setPending(null),
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      );
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, menuBar]);

  const run = (f: () => Promise<unknown>) => () => {
    setError(null);
    f().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]" aria-labelledby="menubar-h">
      <h2 id="menubar-h" className="text-sm font-semibold">
        Menu bar &amp; buddy
      </h2>
      <p className="mt-1 mb-4 text-sm text-fg-muted">
        PassVault lives in the menu bar. The buddy is a small panel you can drag anywhere to find, copy and save credentials without
        opening the full app. It never shows passwords or other secret values in notifications.
      </p>

      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<PanelTopOpen className="size-4" />} onClick={() => void menuBar.showBuddy()}>
            Show the buddy
          </Button>
          <Button variant="ghost" onClick={run(() => menuBar.resetBuddyPosition())}>
            Reset its position
          </Button>
        </div>

        <div>
          <div className="text-[13px] font-medium">Global shortcut</div>
          <p className="text-xs text-fg-subtle">Shows or hides the buddy from any app.</p>
          {capabilities.hotkey ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Kbd>{recording ? (pending ? formatShortcut(pending) : 'Press keys…') : s.shortcut ? formatShortcut(s.shortcut) : 'Off'}</Kbd>
              <Button size="sm" icon={<Keyboard className="size-3.5" />} onClick={() => {
                setError(null);
                setPending(null);
                setRecording((r) => !r);
              }}>
                {recording ? 'Cancel' : 'Change'}
              </Button>
              {s.shortcut && !recording && (
                <Button size="sm" variant="ghost" onClick={run(() => menuBar.update({ shortcut: null }))}>
                  Turn off
                </Button>
              )}
              {!s.shortcut && !recording && (
                <Button size="sm" variant="ghost" onClick={run(() => menuBar.update({ shortcut: DEFAULT_SHORTCUT }))}>
                  Use {formatShortcut(DEFAULT_SHORTCUT)}
                </Button>
              )}
            </div>
          ) : (
            <p className="mt-2 text-xs text-fg-muted">Not available while the desktop helper is not running. Use the menu-bar icon instead.</p>
          )}
          {menuBar.hotKeyError && !error && <Banner tone="warn">{menuBar.hotKeyError} — pick another combination.</Banner>}
          {menuBar.trayError && <Banner tone="warn">The menu-bar icon could not be added ({menuBar.trayError}). Quit and reopen PassVault.</Banner>}
        </div>

        <AvatarPicker value={s.avatar} state={menuBar.state} onChange={(a) => menuBar.update({ avatar: a })} />

        <Switch
          checked={s.bubbleOnClose}
          onChange={(v) => run(() => menuBar.update({ bubbleOnClose: v }))()}
          label="Keep the buddy’s bubble on screen"
          description="Minimizing the buddy or closing the window leaves its avatar floating on screen; click it to open, drag it anywhere."
        />

        <Switch
          checked={s.keepInMenuBar}
          onChange={(v) => run(() => menuBar.update({ keepInMenuBar: v }))()}
          label="Keep PassVault in the menu bar when the window is closed"
          description="Closing the window hides it; quit with ⌘Q or from the menu-bar menu. Auto-lock keeps running."
        />

        {capabilities.loginItem && (
          <Switch
            checked={!!login?.enabled}
            disabled={!login}
            onChange={(v) => run(async () => setLogin(await loginItem.set(v)))()}
            label="Open at login"
            description={login?.stale ? 'This points at another copy of PassVault — turn it off and on again to use this one.' : 'Starts PassVault in the menu bar when you log in (the vault stays locked).'}
          />
        )}

        <Switch
          checked={s.quiet}
          onChange={(v) => run(() => menuBar.update({ quiet: v }))()}
          label="Quiet mode"
          description="No automatic save or fill suggestions from the buddy; it opens only when you ask."
        />

        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </section>
  );
}
