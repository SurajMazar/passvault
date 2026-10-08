/**
 * PassVault background service worker (MV3, ES module).
 *
 * Owns the VaultSession and every privileged operation. All listeners are
 * registered synchronously at top level so Chrome can wake the worker for
 * them after suspension; they delegate to the runtime of the selected server.
 */
import { VaultSession } from '@passvault/vault-core';
import { PRODUCTION_API_URL, PRODUCTION_WEB_URL } from '../shared/config';
import { OFFSCREEN_TARGET, POPUP_PORT, type PortMessageToBackground, type PortMessageToPopup } from '../shared/protocol';
import type { ChromeLike } from './chrome-api';
import { BackgroundController } from './controller';
import { createLogger } from './log';
import { createExtensionPlatform, tokenKey } from './platform';
import { checkSender } from './sender';
import { SavePromptManager } from './save-prompt';
import { InlineMenuManager, isInlineMessage } from './inline-menu';
import { ServerManager, defaultServer, loadProfiles, migrateLegacyStorage, serverScope, webUrlFor } from './servers';

const c = chrome as unknown as ChromeLike;
// Diagnostics: fixed event names and codes only. Never message payloads.
const log = createLogger();
const DEFAULT_SERVER = defaultServer(PRODUCTION_API_URL);

interface Runtime {
  server: string;
  session: VaultSession;
  controller: BackgroundController;
  savePrompt: SavePromptManager;
  inline: InlineMenuManager;
}

/** Everything bound to one server. Changing servers replaces the whole runtime. */
function boot(server: string, servers: ServerManager): Runtime {
  const scope = serverScope(server);
  const webUrl = webUrlFor(server, PRODUCTION_API_URL, PRODUCTION_WEB_URL);
  const platform = createExtensionPlatform(c, { apiBaseUrl: server, webAppUrl: webUrl, scope, nativeRelay: relayFromPopup });
  const session = new VaultSession(platform);
  // Never offer to save passwords typed into PassVault's own pages.
  const own = [...new Set([new URL(webUrl).origin, new URL(server).origin])];
  const savePrompt = new SavePromptManager(c, session, own);
  const controller = new BackgroundController({
    chrome: c,
    session,
    webUrl,
    log,
    savePrompt,
    tokenKey: tokenKey(scope),
    server: servers,
    touchIdStatus: () => platform.biometrics?.status() ?? Promise.resolve({ available: false }),
  });
  const inline = new InlineMenuManager(c, session, own, { matches: (tabId) => controller.matches(tabId), fill: (tabId, id, insecure) => controller.fill(tabId, id, insecure) });
  void savePrompt.syncRegistration().catch(() => log('autosave registration failed'));
  controller.ready.catch(() => log('startup failed'));
  return { server, session, controller, savePrompt, inline };
}

/**
 * Lock the current server's vault, cancel everything still in flight for it
 * (requests, a half-finished sign-in, pending save prompts) and start over on
 * another server. The previous server keeps its locked sign-in and encrypted
 * cache under its own namespace; nothing is copied between servers.
 */
async function activate(url: string, servers: ServerManager): Promise<void> {
  const rt = await current;
  log('server switch');
  await rt.controller.lock('server switch');
  rt.session.dispose();
  await rt.savePrompt.clearAll();
  const next = boot(url, servers);
  current = Promise.resolve(next);
  await next.controller.ready.catch(() => undefined);
  for (const [port, off] of ports) {
    off();
    ports.set(port, attach(port, next));
  }
}

let current: Promise<Runtime> = (async () => {
  await migrateLegacyStorage(c.storage.local, DEFAULT_SERVER).catch(() => log('storage migration failed'));
  // No production server in this build (local development build): local servers are allowed by default.
  const state = await loadProfiles(c.storage.local, { productionUrl: PRODUCTION_API_URL, localDevDefault: !PRODUCTION_API_URL || import.meta.env.DEV });
  const servers: ServerManager = new ServerManager(c, state, {
    activate: (url) => activate(url, servers),
    changed: () => void current.then((rt) => rt.controller.pushState()),
  });
  await servers.refresh();
  return boot(servers.activeUrl, servers);
})();

/** Open popup ports and their state subscriptions (re-attached on a server switch). */
const ports = new Map<chrome.runtime.Port, () => void>();

/** Touch ID host calls made by the open popup on the worker's behalf (background/touch-id.ts). */
const nativeCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nativeSeq = 0;
function relayFromPopup(message: Record<string, unknown>): Promise<unknown> {
  const port = [...ports.keys()].at(-1);
  if (!port) return Promise.reject(new Error('Open the PassVault popup to use Touch ID.'));
  const id = ++nativeSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativeCalls.delete(id);
      reject(new Error('Touch ID timed out'));
    }, 120_000);
    nativeCalls.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    try {
      port.postMessage({ type: 'native', id, message } satisfies PortMessageToPopup);
    } catch {
      nativeCalls.delete(id);
      clearTimeout(timer);
      reject(new Error('Open the PassVault popup to use Touch ID.'));
    }
  });
}

function attach(port: chrome.runtime.Port, rt: Runtime): () => void {
  const send = (state: Extract<PortMessageToPopup, { type: 'state' }>['state']) => {
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

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Messages addressed to the offscreen document are not for us.
  if (message && typeof message === 'object' && (message as { target?: unknown }).target === OFFSCREEN_TARGET) return false;
  void current.then((rt): Promise<unknown> =>
    // Messages from web-page tabs can only be the opt-in save-prompt content script;
    // they are handled (and validated) separately and never reach privileged handlers.
    sender.tab
      ? (isInlineMessage(message) ? rt.inline.handle(message, sender) : rt.savePrompt.handle(message, sender)).catch(() => null)
      : rt.controller.handleMessage(message, sender),
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
  port.onMessage.addListener((m: PortMessageToBackground) => {
    // keepalives are not counted as user activity; replies finish relayed Touch ID calls
    if (m?.type !== 'native.reply' || typeof m.id !== 'number') return;
    const pending = nativeCalls.get(m.id);
    if (!pending) return;
    nativeCalls.delete(m.id);
    if (m.ok) pending.resolve(m.reply);
    else pending.reject(new Error(m.error || 'Touch ID failed'));
  });
  void current.then((rt) => {
    if (!closed) ports.set(port, attach(port, rt));
  });
});

chrome.tabs.onRemoved.addListener((tabId) => void current.then((rt) => rt.savePrompt.onTabRemoved(tabId)));
// If the user revokes the optional all-sites permission in chrome://extensions, stop prompting.
chrome.permissions.onRemoved.addListener(() => void current.then((rt) => rt.savePrompt.syncRegistration()).catch(() => undefined));
// Granting all-sites access turns on inline suggestions (on by default) without a restart.
chrome.permissions.onAdded.addListener(() => void current.then((rt) => rt.savePrompt.syncRegistration()).catch(() => undefined));

chrome.alarms.onAlarm.addListener((alarm) => {
  void current.then((rt) => rt.controller.onAlarm(alarm));
});

self.addEventListener('online', () => void current.then((rt) => rt.session.setOnline(true)));
self.addEventListener('offline', () => void current.then((rt) => rt.session.setOnline(false)));
