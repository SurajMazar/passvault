/**
 * PassVault background service worker (MV3, ES module).
 *
 * Owns the VaultSession and every privileged operation. All listeners are
 * registered synchronously at top level so Chrome can wake the worker for
 * them after suspension; they delegate to the runtime of the selected server.
 */
import { VaultSession } from '@passvault/vault-core';
import { normalizeServerUrl, probeServer } from '@passvault/vault-core/servers';
import { PRODUCTION_API_URL, PRODUCTION_WEB_URL } from '../shared/config';
import { OFFSCREEN_TARGET, POPUP_PORT, type PortMessageToPopup } from '../shared/protocol';
import type { ChromeLike } from './chrome-api';
import { BackgroundController, ControllerError } from './controller';
import { createLogger } from './log';
import { createExtensionPlatform, tokenKey } from './platform';
import { checkSender } from './sender';
import { SavePromptManager } from './save-prompt';
import { SELECTED_SERVER_KEY, defaultServer, loadSelectedServer, migrateLegacyStorage, serverPresets, serverScope, webUrlFor } from './servers';

const c = chrome as unknown as ChromeLike;
// Diagnostics: fixed event names and codes only. Never message payloads.
const log = createLogger();
const PRESETS = serverPresets(PRODUCTION_API_URL);
const DEFAULT_SERVER = defaultServer(PRODUCTION_API_URL);

interface Runtime {
  server: string;
  session: VaultSession;
  controller: BackgroundController;
  savePrompt: SavePromptManager;
}

/** Everything bound to one server. Switching servers replaces the whole runtime. */
function boot(server: string): Runtime {
  const scope = serverScope(server);
  const webUrl = webUrlFor(server, PRODUCTION_API_URL, PRODUCTION_WEB_URL);
  const platform = createExtensionPlatform(c, { apiBaseUrl: server, webAppUrl: webUrl, scope });
  const session = new VaultSession(platform);
  // Never offer to save passwords typed into PassVault's own pages.
  const savePrompt = new SavePromptManager(c, session, [...new Set([new URL(webUrl).origin, server])]);
  const controller = new BackgroundController({
    chrome: c,
    session,
    webUrl,
    log,
    savePrompt,
    tokenKey: tokenKey(scope),
    server: { url: server, presets: PRESETS, switchTo: switchServer },
  });
  void savePrompt.syncRegistration().catch(() => log('autosave registration failed'));
  controller.ready.catch(() => log('startup failed'));
  return { server, session, controller, savePrompt };
}

let current: Promise<Runtime> = (async () => {
  await migrateLegacyStorage(c.storage.local, DEFAULT_SERVER).catch(() => log('storage migration failed'));
  return boot(await loadSelectedServer(c.storage.local, DEFAULT_SERVER));
})();

/** Open popup ports and their state subscriptions (re-attached on a server switch). */
const ports = new Map<chrome.runtime.Port, () => void>();

function attach(port: chrome.runtime.Port, rt: Runtime): () => void {
  const send = (state: PortMessageToPopup['state']) => {
    try {
      port.postMessage({ type: 'state', state } satisfies PortMessageToPopup);
    } catch {
      /* popup closed */
    }
  };
  const off = rt.controller.onState(send);
  void rt.controller.ready.then(() => send(rt.controller.popupState()));
  return off;
}

let switching: Promise<string> | null = null;

/**
 * Lock the current server's vault and start over on another server. The
 * previous server keeps its (locked) sign-in and encrypted cache, so switching
 * back only needs the master password.
 */
async function switchServer(url: string, force: boolean): Promise<string> {
  const origin = normalizeServerUrl(url);
  if (switching) throw new ControllerError('bad_state', 'A server switch is already in progress.');
  const run = async () => {
    const rt = await current;
    if (origin === rt.server) return origin;
    const granted = (await c.permissions?.contains({ origins: [`${origin}/*`] })) ?? false;
    if (!granted) throw new ControllerError('refused', `PassVault is not allowed to connect to ${new URL(origin).host}. Allow access when Chrome asks.`);
    if (!force) {
      const probe = await probeServer(origin);
      if (!probe.ok) throw new ControllerError('network', probe.message);
    }
    log('server switch');
    await rt.controller.lock('server switch');
    await rt.savePrompt.clearAll();
    await c.storage.local.set({ [SELECTED_SERVER_KEY]: origin });
    const next = boot(origin);
    current = Promise.resolve(next);
    await next.controller.ready.catch(() => undefined);
    for (const [port, off] of ports) {
      off();
      ports.set(port, attach(port, next));
    }
    return origin;
  };
  switching = run();
  try {
    return await switching;
  } finally {
    switching = null;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Messages addressed to the offscreen document are not for us.
  if (message && typeof message === 'object' && (message as { target?: unknown }).target === OFFSCREEN_TARGET) return false;
  void current.then((rt): Promise<unknown> =>
    // Messages from web-page tabs can only be the opt-in save-prompt content script;
    // they are handled (and validated) separately and never reach privileged handlers.
    sender.tab ? rt.savePrompt.handle(message, sender).catch(() => null) : rt.controller.handleMessage(message, sender),
  ).then(sendResponse, () => sendResponse(null));
  return true; // async response
});

// Popup state channel: pushes auth/sync state, and its keepalive pings keep the
// worker alive while the popup is open (e.g. during an MFA step).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== POPUP_PORT || !checkSender(c, port.sender, true).ok) {
    port.disconnect();
    return;
  }
  let closed = false;
  port.onDisconnect.addListener(() => {
    closed = true;
    ports.get(port)?.();
    ports.delete(port);
  });
  port.onMessage.addListener(() => {
    /* keepalive only; not counted as user activity */
  });
  void current.then((rt) => {
    if (!closed) ports.set(port, attach(port, rt));
  });
});

chrome.tabs.onRemoved.addListener((tabId) => void current.then((rt) => rt.savePrompt.onTabRemoved(tabId)));
// If the user revokes the optional all-sites permission in chrome://extensions, stop prompting.
chrome.permissions.onRemoved.addListener(() => void current.then((rt) => rt.savePrompt.syncRegistration()).catch(() => undefined));

chrome.alarms.onAlarm.addListener((alarm) => {
  void current.then((rt) => rt.controller.onAlarm(alarm));
});

self.addEventListener('online', () => void current.then((rt) => rt.session.setOnline(true)));
self.addEventListener('offline', () => void current.then((rt) => rt.session.setOnline(false)));
