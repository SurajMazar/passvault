/**
 * PassVault background service worker (MV3, ES module).
 *
 * Owns the VaultSession and every privileged operation. All listeners are
 * registered synchronously at top level so Chrome can wake the worker for
 * them after suspension.
 */
import { VaultSession } from '@passvault/vault-core';
import { API_URL, WEB_URL } from '../shared/config';
import { OFFSCREEN_TARGET, POPUP_PORT, type PortMessageToPopup } from '../shared/protocol';
import type { ChromeLike } from './chrome-api';
import { BackgroundController } from './controller';
import { createLogger } from './log';
import { createExtensionPlatform } from './platform';
import { checkSender } from './sender';
import { SavePromptManager } from './save-prompt';

const c = chrome as unknown as ChromeLike;
const platform = createExtensionPlatform(c, { apiBaseUrl: API_URL, webAppUrl: WEB_URL });
const session = new VaultSession(platform);

// Diagnostics: fixed event names and codes only. Never message payloads.
const log = createLogger();

const savePrompt = new SavePromptManager(c, session, [new URL(WEB_URL).origin, new URL(API_URL).origin]);
const controller = new BackgroundController({ chrome: c, session, webUrl: WEB_URL, log, savePrompt });
void savePrompt.syncRegistration().catch(() => log('autosave registration failed'));
controller.ready.catch(() => log('startup failed'));

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Messages addressed to the offscreen document are not for us.
  if (message && typeof message === 'object' && (message as { target?: unknown }).target === OFFSCREEN_TARGET) return false;
  // Messages from web-page tabs can only be the opt-in save-prompt content script;
  // they are handled (and validated) separately and never reach privileged handlers.
  if (sender.tab) {
    void savePrompt.handle(message, sender).then(sendResponse, () => sendResponse(null));
    return true;
  }
  void controller.handleMessage(message, sender).then(sendResponse);
  return true; // async response
});

// Popup state channel: pushes auth/sync state, and its keepalive pings keep the
// worker alive while the popup is open (e.g. during an MFA step).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== POPUP_PORT || !checkSender(c, port.sender, true).ok) {
    port.disconnect();
    return;
  }
  const send = (state: PortMessageToPopup['state']) => {
    try {
      port.postMessage({ type: 'state', state } satisfies PortMessageToPopup);
    } catch {
      /* popup closed */
    }
  };
  const off = controller.onState(send);
  port.onDisconnect.addListener(off);
  port.onMessage.addListener(() => {
    /* keepalive only; not counted as user activity */
  });
  void controller.ready.then(() => send(controller.popupState()));
});

chrome.tabs.onRemoved.addListener((tabId) => savePrompt.onTabRemoved(tabId));
// If the user revokes the optional all-sites permission in chrome://extensions, stop prompting.
chrome.permissions.onRemoved.addListener(() => void savePrompt.syncRegistration().catch(() => undefined));

chrome.alarms.onAlarm.addListener((alarm) => {
  void controller.onAlarm(alarm);
});

self.addEventListener('online', () => session.setOnline(true));
self.addEventListener('offline', () => session.setOnline(false));
