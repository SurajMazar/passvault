import { useEffect, useState } from 'react';
import { Banner, Button, Switch, useToast } from '@passvault/ui';
import type { AutoSaveStatus } from '../shared/protocol';
import { call, errorText } from './rpc';

const ORIGINS = ['https://*/*', 'http://*/*'];

/**
 * Website integration (opt-in): "Suggestions in login fields" and "Offer to
 * save passwords". Both need Chrome's optional "read and change data on all
 * websites" permission, requested when the first one is turned on and given
 * back when both are off.
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

  const toggle = async (feature: 'inline' | 'save', on: boolean) => {
    setBusy(true);
    try {
      if (on && !status?.permission) {
        // Must run directly in the click handler (user gesture) inside the popup.
        const granted = await chrome.permissions.request({ origins: ORIGINS });
        if (!granted) {
          toast('Permission not granted — PassVault cannot work in web pages.', 'warn');
          return;
        }
      }
      let next = feature === 'inline' ? await call({ type: 'inline.set', enabled: on }) : await call({ type: 'autosave.set', enabled: on });
      // When the second feature was off before the permission was granted, keep it off unless chosen.
      if (on && !status?.permission) {
        next = feature === 'inline' ? await call({ type: 'autosave.set', enabled: false }) : await call({ type: 'inline.set', enabled: false });
      }
      if (!next.enabled && !next.inline && !next.passkeys) {
        await chrome.permissions.remove({ origins: ORIGINS }).catch(() => false);
        next = await call({ type: 'autosave.status' });
      }
      setStatus(next);
      if (on) toast(feature === 'inline' ? 'Click a login field on a website to see your saved logins.' : 'PassVault will offer to save passwords after you sign in to sites.', 'success');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const togglePasskeys = async (on: boolean) => {
    setBusy(true);
    try {
      const hadPermission = !!status?.permission;
      if (on && !hadPermission) {
        // Must run directly in the click handler (user gesture) inside the popup.
        if (!(await chrome.permissions.request({ origins: ORIGINS }))) {
          toast('Permission not granted — PassVault cannot handle passkeys on websites.', 'warn');
          return;
        }
      }
      let next = await call({ type: 'passkeys.set', enabled: on });
      // Granting the permission for passkeys alone does not switch the other features on.
      if (on && !hadPermission && next.inline) next = await call({ type: 'inline.set', enabled: false });
      if (!next.enabled && !next.inline && !next.passkeys) {
        await chrome.permissions.remove({ origins: ORIGINS }).catch(() => false);
        next = await call({ type: 'autosave.status' });
      }
      setStatus(next);
      if (on) toast('PassVault will offer to save passkeys and sign you in with them.', 'success');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <Switch
        checked={!!status?.inline}
        disabled={busy || !status}
        onChange={(v) => void toggle('inline', v)}
        label="Suggestions in login fields"
        description="Click a username or password field to pick one of your logins for that site and fill it."
      />
      <Switch
        checked={!!status?.enabled}
        disabled={busy || !status}
        onChange={(v) => void toggle('save', v)}
        label="Offer to save passwords"
        description="After you sign in to a website, ask whether to save or update the login."
      />
      <Switch
        checked={!!status?.passkeys}
        disabled={busy || !status}
        onChange={(v) => void togglePasskeys(v)}
        label="Save and use passkeys"
        description="When a site creates or asks for a passkey, PassVault offers to keep it and sign you in with it. You approve each time; “Use another device” hands it back to Chrome."
      />
      <Banner tone="neutral">
        These need Chrome’s permission to read pages on all sites. Suggestions show only titles and usernames; a password is filled only
        into the site it is saved for, after your click. Captured passwords stay inside the extension, are never shown to the page, and are
        discarded after 3 minutes or when the vault locks. PassVault’s own pages are excluded: your master password is never offered for
        saving. Reload open tabs after turning these on.
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
