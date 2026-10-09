/**
 * Isolated-world bridge for passkey-main.ts (same tab, top frame): forwards the page
 * script's passkey requests to PassVault's background and posts the answer back.
 * The background takes the requesting origin from the browser (sender.url), never
 * from the message. Self-contained: no imports.
 */
(() => {
  if (window.top !== window) return;
  const REQ = 'pv-passkey-req';
  const RES = 'pv-passkey-res';
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; id?: string; kind?: string; options?: unknown } | null;
    if (e.source !== window || !d || d.type !== REQ || typeof d.id !== 'string' || d.id.length > 100) return;
    if (d.kind !== 'create' && d.kind !== 'get' && d.kind !== 'abort') return;
    let reply: (result: unknown) => void = (result) => window.postMessage({ type: RES, id: d.id, result }, location.origin);
    if (d.kind === 'abort') reply = () => undefined;
    try {
      chrome.runtime.sendMessage({ type: 'passkey.request', requestId: d.id, kind: d.kind, options: d.options ?? null }, (result: unknown) => {
        if (chrome.runtime.lastError || !result || typeof result !== 'object') return reply({ fallback: true });
        reply(result);
      });
    } catch {
      reply({ fallback: true }); // extension reloaded
    }
  });
})();
