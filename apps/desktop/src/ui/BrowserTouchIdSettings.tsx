import { useEffect, useState } from 'react';
import { Banner, Card, Switch, useToast } from '@passvault/ui';
import { errorMessage } from '@passvault/app';
import { describeHelperError } from '../ipc/helper-client';

/**
 * PassVault browser extension IDs allowed to use Touch ID through this Mac: the
 * Chrome Web Store listing, the release zip's fixed ID (manifest key,
 * apps/browser-extension/vite.config.ts), plus any listed at build time
 * (VITE_PV_EXTENSION_IDS).
 */
export const EXTENSION_ORIGINS = [
  'phalmlfcnogoddjelcilkcpepjbcecmf', // Chrome Web Store
  'hpnpkdckiinjkfjolbfkhbekeknhmdff', // release zip
  ...String(import.meta.env.VITE_PV_EXTENSION_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-p]{32}$/.test(s)),
]
  .filter((id, i, all) => all.indexOf(id) === i)
  .map((id) => `chrome-extension://${id}/`);

export interface BrowserTouchIdDeps {
  status(): Promise<{ registered: boolean }>;
  set(enabled: boolean): Promise<{ registered: boolean; browsers?: string[] }>;
  biometrics(): Promise<{ available: boolean; reason?: string }>;
}

/** Settings → Touch ID in the browser extension. */
export function BrowserTouchIdSettings({ deps }: { deps: BrowserTouchIdDeps }) {
  const toast = useToast();
  const [on, setOn] = useState<boolean | null>(null);
  const [bio, setBio] = useState<{ available: boolean; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void deps
      .status()
      .then((s) => setOn(s.registered))
      .catch(() => setOn(false));
    void deps
      .biometrics()
      .then(setBio)
      .catch(() => setBio({ available: false }));
  }, [deps]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const r = await deps.set(next);
      setOn(r.registered);
      if (next && !r.registered) toast('No supported browser (Chrome, Brave, Edge, Chromium, Vivaldi, Arc) was found on this Mac.', 'warn');
      else if (next) toast(`Ready in ${r.browsers?.join(', ') || 'your browser'}. In the extension, open Settings and turn on “Unlock with Touch ID”.`, 'success');
    } catch (e) {
      toast(describeHelperError(e) || errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Touch ID in the browser extension">
      <div className="space-y-3">
        <Switch
          checked={!!on}
          disabled={busy || on === null}
          onChange={(v) => void toggle(v)}
          label="Let the PassVault extension use Touch ID"
          description="Registers PassVault’s Touch ID service with Chrome-based browsers on this Mac. The extension then unlocks with your fingerprint; its key is sealed by this Mac’s Secure Enclave and stays separate from the app’s. Your master password always works too."
        />
        {bio && !bio.available && <Banner tone="warn">Touch ID is not available: {bio.reason ?? 'unknown reason'}.</Banner>}
      </div>
    </Card>
  );
}
