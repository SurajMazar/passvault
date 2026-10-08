import { StrictMode, useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as NL from '@neutralinojs/lib';
import '@xterm/xterm/css/xterm.css';
import './desktop.css';
import { PassVaultApp, useUi } from '@passvault/app';
import type { VaultSession } from '@passvault/vault-core';
import { HelperClient } from './ipc/helper-client';
import { helperTransport, type NeutralinoLike } from './neutralino';
import { DesktopController } from './desktop/controller';
import { HelperConnection } from './desktop/helper-connection';
import { DesktopClipboard } from './platform/clipboard';
import { createDesktopPlatform } from './platform/desktop-platform';
import { loadSelectedServer, saveSelectedServer, serverScope, webAppUrlFor } from './platform/servers';
import { neutralinoKV } from './platform/storage';
import { ServerPickerRow, ServerSettings } from './ui/ServerPicker';
import { openExternalConfirmed } from './platform/links';
import { NativeShell } from './shell/native-shell';
import { XtermHost } from './terminal/xterm-host';
import { createExtensions } from './extensions';
import { DesktopOverlays } from './ui/DesktopOverlays';
import { DesktopContext, type DesktopContextValue } from './ui/hooks';

declare const __APP_VERSION__: string;

/** Build-time default server; the user can switch (Settings → Server or the sign-in screen). */
const defaultServer = import.meta.env.VITE_API_URL || 'http://localhost:3000';

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

let shell: NativeShell;
const controller = new DesktopController(
  helper,
  {
    goToTerminal: () => useUi.getState().go('ext:terminal'),
    openItem: (itemId) => {
      const item = session?.getSnapshot().items.find((i) => i.id === itemId);
      if (item) useUi.getState().go(item.payload.type, { selectedId: item.id });
    },
    bringToFront: () => void shell?.bringToFront(),
  },
  { onLocked: () => void clipboard.clearIfUnchanged() },
);

const confirmLink = (o: { title: string; body: string; url: string; confirmLabel: string }) => controller.confirm(o);
const openLink = (url: string) => {
  openExternalConfirmed(url, { confirm: confirmLink, open: (u) => nl.os.open(u) }).catch((e) => controller.notify(e instanceof Error ? e.message : String(e), 'error'));
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

shell = new NativeShell(nl, {
  lockVault: () => session?.lock(),
  beforeExit: () => clipboard.clearIfUnchanged(),
  openLink,
});

const kv = neutralinoKV(nl);
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

const onSession = (s: VaultSession) => {
  session = s;
  controller.attachSession(s);
};

/** Owns the selected server; switching locks the current vault and remounts the app with a fresh session. */
function Root({ initialServer }: { initialServer: string }) {
  const [server, setServer] = useState(initialServer);
  const platform = useMemo(() => makePlatform(server), [server]);
  const switchServer = useCallback(async (url: string) => {
    const origin = await saveSelectedServer(kv, url);
    session?.lock(); // wipes keys, disconnects terminals, clears agent keys
    session = null;
    setServer(origin);
  }, []);
  const picker = useMemo(() => ({ current: server, isUnlocked: () => !!session?.isUnlocked, onSwitch: switchServer }), [server, switchServer]);
  const extensions = useMemo(
    () => ({
      ...baseExtensions,
      authFooter: () => <ServerPickerRow {...picker} />,
      settingsSections: [...(baseExtensions.settingsSections ?? []), { id: 'server', label: 'Server', render: () => <ServerSettings {...picker} /> }],
    }),
    [picker],
  );
  return <PassVaultApp key={server} platform={platform} platformName="desktop" extensions={extensions} onSession={onSession} />;
}

async function boot() {
  const initialServer = await loadSelectedServer(kv, defaultServer);
  if (import.meta.env.MODE === 'development' && new URLSearchParams(window.location.search).has('preview')) {
    const { setupPreviewAccount } = await import('./dev-preview');
    await setupPreviewAccount(makePlatform(initialServer));
    (window as unknown as { __pvDev: unknown }).__pvDev = { controller, helper, getSession: () => session };
  }
  render(initialServer);
}

void connection.start();
// Menu bar, tray and window events exist only in window mode (the verification
// harness also runs the same bundle in Neutralino's window-less cloud mode).
if (String(window.NL_MODE) === 'window') void shell.install();

const render = (initialServer: string) =>
  createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesktopContext.Provider value={ctx}>
      <Root initialServer={initialServer} />
      <DesktopOverlays />
    </DesktopContext.Provider>
  </StrictMode>,
);
void boot();
