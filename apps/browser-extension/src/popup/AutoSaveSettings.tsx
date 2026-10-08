import { useEffect, useState } from 'react';
import { Banner, Button, Switch, useToast } from '@passvault/ui';
import type { AutoSaveStatus } from '../shared/protocol';
import { call, errorText } from './rpc';

const ORIGINS = ['https://*/*', 'http://*/*'];

/**
 * "Offer to save passwords" (opt-in). Turning it on asks Chrome for the
 * optional "read and change data on all websites" permission — required to
 * notice login form submissions. Turning it off also gives the permission back.
 */
export function AutoSaveSettings() {
  const toast = useToast();
  const [status, setStatus] = useState<AutoSaveStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call({ type: 'autosave.status' })
      .then(setStatus)
      .catch((e) => toast(errorText(e), 'error'));
  }, [toast]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        // Must run directly in the click handler (user gesture) inside the popup.
        const granted = await chrome.permissions.request({ origins: ORIGINS });
        if (!granted) {
          toast('Permission not granted — PassVault will not offer to save.', 'warn');
          return;
        }
        setStatus(await call({ type: 'autosave.set', enabled: true }));
        toast('PassVault will offer to save passwords after you sign in to sites.', 'success');
      } else {
        setStatus(await call({ type: 'autosave.set', enabled: false }));
        await chrome.permissions.remove({ origins: ORIGINS }).catch(() => false);
        setStatus(await call({ type: 'autosave.status' }));
      }
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <Switch
        checked={!!status?.enabled}
        disabled={busy || !status}
        onChange={(v) => void toggle(v)}
        label="Offer to save passwords"
        description="After you sign in to a website, ask whether to save or update the login."
      />
      <Banner tone="neutral">
        This needs Chrome’s permission to read pages on all sites so PassVault can notice when you submit a login form. Captured
        passwords stay inside the extension, are never shown to the page, and are discarded after 3 minutes or when the vault locks.
        Nothing is saved without your click.
      </Banner>
      {status && status.neverCount > 0 && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-fg-muted">
            {status.neverCount} site{status.neverCount === 1 ? '' : 's'} set to “Never”
          </span>
          <Button size="sm" onClick={() => void call({ type: 'autosave.clearNever' }).then(setStatus).catch((e) => toast(errorText(e), 'error'))}>
            Reset
          </Button>
        </div>
      )}
    </div>
  );
}
