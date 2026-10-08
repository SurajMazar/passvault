/**
 * Offscreen document (reason: CLIPBOARD). Its only job is to clear the
 * clipboard when the background's clear-timer alarm fires, because a service
 * worker has no clipboard access and the popup is usually closed by then.
 * It never receives secrets.
 */
import { OFFSCREEN_TARGET } from '../shared/constants';

function clearClipboard(): boolean {
  // execCommand('copy') works without focus in an offscreen document (clipboardWrite permission);
  // intercepting the copy event lets us write an empty string.
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', '');
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  try {
    const ta = document.createElement('textarea');
    ta.value = ' ';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } finally {
    document.removeEventListener('copy', onCopy);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const m = message as { target?: unknown; type?: unknown } | null;
  if (!m || m.target !== OFFSCREEN_TARGET || m.type !== 'clipboard.clear') return false;
  sendResponse({ ok: clearClipboard() });
  return false;
});
