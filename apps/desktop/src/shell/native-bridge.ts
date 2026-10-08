/**
 * The shell's native bridge (scripts/pvwindow.m): a WKScriptMessageHandler
 * named `pvNative`, accepted only from this page. It is registered a moment
 * after the page loads, so callers that run at startup may wait for it.
 * Absent outside the packaged macOS app (tests, a plain browser).
 */
export interface NativeBridge {
  postMessage(message: unknown): void;
}

export function nativeBridge(): NativeBridge | null {
  const g = globalThis as unknown as { webkit?: { messageHandlers?: { pvNative?: NativeBridge } } };
  return g.webkit?.messageHandlers?.pvNative ?? null;
}

export async function waitForNativeBridge(timeoutMs: number): Promise<NativeBridge | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const b = nativeBridge();
    if (b || Date.now() >= deadline) return b;
    await new Promise((r) => setTimeout(r, 100));
  }
}
