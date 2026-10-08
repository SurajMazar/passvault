import { StrictMode, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import * as NL from '@neutralinojs/lib';
import '@xterm/xterm/css/xterm.css';
import './desktop.css';
import { PassVaultApp, useUi } from '@passvault/app';
import { serverLabel, type SessionSnapshot, type VaultSession } from '@passvault/vault-core';
import { HelperClient } from './ipc/helper-client';
import { helperTransport, type NeutralinoLike } from './neutralino';
import { DesktopController } from './desktop/controller';
import { HelperConnection } from './desktop/helper-connection';
import { DesktopClipboard } from './platform/clipboard';
import { createDesktopPlatform, sessionTokenAccount } from './platform/desktop-platform';
import { DesktopServers, PRODUCTION_URL, serverScope, webAppUrlFor } from './platform/servers';
import { neutralinoKV } from './platform/storage';
import { ServerPickerRow, ServerSettings } from './ui/ServerPicker';
import { openExternalConfirmed } from './platform/links';
import { NativeShell } from './shell/native-shell';
import { MenuBar, type VaultState } from './shell/menu-bar';
import { helperParams } from './shell/shortcut';
import { BuddyBubble, BuddyNav, BuddyView } from './ui/BuddyView';
import { MenuBarSettings } from './ui/MenuBarSettings';
import { BrowserTouchIdSettings, EXTENSION_ORIGINS, type BrowserTouchIdDeps } from './ui/BrowserTouchIdSettings';
import { XtermHost } from './terminal/xterm-host';
import { createExtensions } from './extensions';
import { DesktopOverlays } from './ui/DesktopOverlays';
import { DesktopContext, type DesktopContextValue } from './ui/hooks';

declare const __APP_VERSION__: string;

/** Build-time default server; the user can change it any time (Settings → Server connection or the sign-in screen). */
const defaultServer = import.meta.env.VITE_API_URL || 'http://localhost:3000';
/** http://localhost servers are allowed by default only in development builds (or builds without a production server). */
const localDevDefault = import.meta.env.DEV || !PRODUCTION_URL;

NL.init();
const nl = NL as unknown as NeutralinoLike;

// Dropped files must never navigate the webview away from the bundled UI.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
// No page context menu (its "Reload" would break the one-time Neutralino token);
// text fields, selections and the terminal keep theirs (Copy/Paste).
window.addEventListener('contextmenu', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (t?.closest('input, textarea, [contenteditable="true"], .xterm') || window.getSelection()?.toString()) return;
  e.preventDefault();
});

let session: VaultSession | null = null;
let connection: HelperConnection;
const helper = new HelperClient(
  helperTransport(nl, () => connection?.isConnected() ?? false),
  { clientVersion: __APP_VERSION__ },
);
connection = new HelperConnection(nl, helper);
const clipboard = new DesktopClipboard(nl.clipboard);

const kv = neutralinoKV(nl);
const menuBar = new MenuBar({
  nl,
  kv,
  motion: {
    enabled: () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  },
  setHotKey: async (sc) => {
    if (!helper.isReady) return; // registered when the helper (re)connects
    if (sc) await helper.request('hotkey.set', helperParams(sc));
    else await helper.request('hotkey.clear', {});
  },
  screen: () => {
    const sc = window.screen as Screen & { availLeft?: number; availTop?: number };
    return { left: sc.availLeft ?? 0, top: sc.availTop ?? 0, width: sc.availWidth, height: sc.availHeight };
  },
});
const buddyNav = new BuddyNav();
const controller = new DesktopController(
  helper,
  {
    goToTerminal: () => useUi.getState().go('ext:terminal'),
    openItem: (itemId) => {
      const item = session?.getSnapshot().items.find((i) => i.id === itemId);
      if (item) useUi.getState().go(item.payload.type, { selectedId: item.id });
    },
    bringToFront: () => void menuBar.showFull(),
  },
  { onLocked: () => void clipboard.clearIfUnchanged() },
);

const confirmLink = (o: { title: string; body: string; url: string; confirmLabel: string }) => controller.confirm(o);
const openLink = (url: string) => {
  openExternalConfirmed(url, { confirm: confirmLink, open: (u) => helper.request('link.open', { url: u }) }).catch((e) => controller.notify(e instanceof Error ? e.message : String(e), 'error'));
};

const xterm = new XtermHost(controller, {
  openLink,
  confirmPaste: (a) =>
    controller.confirm({
      title: a.multiline ? `Paste ${a.lineCount} line${a.lineCount === 1 ? '' : 's'} into the terminal?` : 'Paste text with control characters?',
      body: a.multiline ? 'Line breaks in pasted text run commands on the server immediately. Check the text before pasting.' : 'The text contains control characters that terminals can interpret as commands.',
      lines: { shown: a.preview, total: a.lineCount },
      ...(a.hasControlChars ? { warning: 'Control characters will be removed before pasting.' } : {}),
      confirmLabel: 'Paste',
    }),
});
controller.setTerminalHost(xterm);

const shell = new NativeShell(nl, menuBar, {
  lockVault: () => session?.lock(),
  beforeExit: () => clipboard.clearIfUnchanged(),
  openLink,
  quickSave: () => buddyNav.open('save'),
  generate: () => buddyNav.open('generate'),
  openSettings: () => useUi.getState().go('settings'),
});

const browserTouchId: BrowserTouchIdDeps = {
  status: () => helper.request('touchid.browsers.status', {}),
  set: (enabled) => helper.request('touchid.browsers.set', enabled ? { enabled, origins: EXTENSION_ORIGINS } : { enabled }),
  biometrics: () => helper.request('biometric.status', {}),
};

// Global shortcut: (re)registered with every helper session; a press toggles the buddy.
helper.onStatus((st) => {
  if (st.state === 'ready') void menuBar.registerHotKey().catch(() => undefined);
});
helper.on('hotkey.pressed', () => void menuBar.toggleBuddy());

/** Vault state for the menu bar and the buddy. */
function vaultState(s: SessionSnapshot): VaultState {
  if (s.auth.phase === 'locked') return 'locked';
  if (s.auth.phase !== 'unlocked') return 'signed_out';
  if (controller.pendingApprovals() > 0) return 'awaiting_approval';
  if (!s.online) return 'offline';
  if (s.sync.lastError) return 'connection_error';
  if (s.sync.state === 'syncing') return 'syncing';
  return 'ready';
}
const makePlatform = (server: string) =>
  createDesktopPlatform({
    nl,
    helper,
    apiBaseUrl: server,
    webAppUrl: webAppUrlFor(server),
    deviceName: 'PassVault on macOS',
    clipboard,
    confirmLink,
    serverScope: serverScope(server),
  });

const baseExtensions = createExtensions(controller, helper);

const ctx: DesktopContextValue = {
  controller,
  connection,
  xterm,
  versions: { neutralino: window.NL_VERSION ?? 'unknown', client: window.NL_CVERSION ?? 'unknown', app: __APP_VERSION__ },
  copyText: (t) => clipboard.copyText(t),
};

let unwatchSession: (() => void) | null = null;
const sessionListeners = new Set<() => void>();
const onSession = (s: VaultSession) => {
  session = s;
  controller.attachSession(s);
  unwatchSession?.();
  unwatchSession = s.subscribe((snap) => menuBar.setVaultState(vaultState(snap)));
  menuBar.setVaultState(vaultState(s.getSnapshot()));
  for (const l of sessionListeners) l();
};
controller.onApprovalsChanged(() => session && menuBar.setVaultState(vaultState(session.getSnapshot())));

/** The buddy uses the app's current session (same unlock), rendered when the window is in buddy mode. */
function BuddyLayer({ server }: { server: string }) {
  const mode = useSyncExternalStore(
    (cb) => menuBar.subscribe(cb),
    () => menuBar.mode,
  );
  const morph = useSyncExternalStore(
    (cb) => menuBar.subscribe(cb),
    () => menuBar.morph,
  );
  const s = useSyncExternalStore(
    (cb) => {
      sessionListeners.add(cb);
      return () => sessionListeners.delete(cb);
    },
    () => session,
  );
  useEffect(() => {
    document.documentElement.dataset.pvWindow = mode;
  }, [mode]);
  if (mode === 'bubble') {
    return (
      <div className="fixed inset-0 z-[55]">
        <BuddyBubble menuBar={menuBar} />
      </div>
    );
  }
  if (mode !== 'buddy' || !s) return null;
  return (
    <div className={`fixed inset-0 z-[55] pv-morph${morph ? ` pv-morph-${morph}` : ''}`}>
      {morph && (
        <div className="pv-morph-avatar">
          <BuddyBubble menuBar={menuBar} preview />
        </div>
      )}
      <BuddyView
        session={s}
        menuBar={menuBar}
        nav={buddyNav}
        serverLabel={serverLabel(server)}
        actions={{
          copySecret: (t, secs) => clipboard.copySecret(t, secs),
          copyText: (t) => clipboard.copyText(t),
          openInApp: (itemId) => {
            void menuBar.showFull().then(() => {
              const item = itemId ? s.getSnapshot().items.find((i) => i.id === itemId) : undefined;
              if (item) useUi.getState().go(item.payload.type, { selectedId: item.id });
            });
          },
          connect: async (itemId) => {
            await menuBar.showFull();
            await controller.connect(itemId);
          },
          biometricsAvailable: () => s.biometricsEnabled(),
          openSettings: () => void menuBar.showFull().then(() => useUi.getState().go('settings')),
        }}
      />
    </div>
  );
}

/** Set by Root: shows the app for another server. */
let showServer: (url: string) => void = () => undefined;

/**
 * A server change ends the current session for good — vault locked (terminals
 * and agent keys cleared by the lock hooks), half-finished sign-in dropped,
 * in-flight requests cancelled — then the app remounts with a fresh session
 * bound to the new server's own storage.
 */
async function activateServer(url: string): Promise<void> {
  session?.dispose();
  session = null;
  showServer(url);
}

/** Renders the app for the connected server; a server change remounts it with a fresh session. */
function Root({ servers }: { servers: DesktopServers }) {
  const [server, setServer] = useState(servers.activeUrl);
  useEffect(() => {
    showServer = setServer;
    return () => {
      showServer = () => undefined;
    };
  }, []);
  const platform = useMemo(() => makePlatform(server), [server]);
  const extensions = useMemo(
    () => ({
      ...baseExtensions,
      authFooter: () => <ServerPickerRow servers={servers} />,
      settingsSections: [
        ...(baseExtensions.settingsSections ?? []),
        { id: 'server', label: 'Server connection', render: () => <ServerSettings servers={servers} /> },
        { id: 'browser-touchid', label: 'Browser extension', render: () => <BrowserTouchIdSettings deps={browserTouchId} /> },
        {
          id: 'menubar',
          label: 'Menu bar & buddy',
          render: () => (
            <MenuBarSettings
              menuBar={menuBar}
              loginItem={{ status: () => helper.request('login.status', {}), set: (enabled) => helper.request('login.set', { enabled }) }}
              capabilities={{ hotkey: !!helper.status.hello?.capabilities.hotkey, loginItem: !!helper.status.hello?.capabilities.loginItem }}
            />
          ),
        },
      ],
    }),
    [servers],
  );
  const mode = useSyncExternalStore(
    (cb) => menuBar.subscribe(cb),
    () => menuBar.mode,
  );
  return (
    <>
      {/* Kept mounted (state, terminals) but not drawn while the buddy or its bubble is shown. */}
      <div style={{ display: mode === 'buddy' || mode === 'bubble' ? 'none' : 'contents' }}>
        <PassVaultApp key={server} platform={platform} platformName="desktop" extensions={extensions} onSession={onSession} />
      </div>
      <BuddyLayer server={server} />
    </>
  );
}

async function boot() {
  await menuBar.load();
  // Opened at login (LaunchAgent passes --background): start in the menu bar only.
  if (String(window.NL_MODE) === 'window' && (window.NL_ARGS ?? []).includes('--background')) void menuBar.hide();
  const servers = await DesktopServers.load(
    {
      kv,
      listKeys: () => nl.storage.getKeys(),
      deleteToken: async (scope) => void (await helper.request('keychain.delete', { account: sessionTokenAccount(scope) })),
      inspectTls: (url) => helper.request<{ ok: boolean; reason?: string; message: string }>('net.inspectTls', { url }),
      appOrigin: window.location.origin,
      activate: activateServer,
    },
    defaultServer,
    localDevDefault,
  );
  if (import.meta.env.MODE === 'development' && new URLSearchParams(window.location.search).has('preview')) {
    const { setupPreviewAccount } = await import('./dev-preview');
    await setupPreviewAccount(makePlatform(servers.activeUrl));
    (window as unknown as { __pvDev: unknown }).__pvDev = { controller, helper, getSession: () => session, servers };
  }
  render(servers);
}

void connection.start();
// Menu bar, tray and window events exist only in window mode (the verification
// harness also runs the same bundle in Neutralino's window-less cloud mode).
if (String(window.NL_MODE) === 'window') void shell.install();

const render = (servers: DesktopServers) =>
  createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesktopContext.Provider value={ctx}>
      <Root servers={servers} />
      <DesktopOverlays />
    </DesktopContext.Provider>
  </StrictMode>,
);
void boot();
