import { useEffect, useState } from 'react';
import { Banner, Switch, useToast } from '@passvault/ui';
import type { TouchIdStatus } from '../shared/protocol';
import { call, errorText } from './rpc';

export const isMac = () => /Mac/i.test(navigator.userAgent);

/**
 * Unlock with Touch ID (macOS). The fingerprint check is done by PassVault for
 * Mac (its Touch ID host, registered from the app's settings); the extension
 * needs Chrome's optional "communicate with cooperating native applications"
 * permission, requested here when the switch is turned on. The master password
 * keeps working either way.
 */
export function TouchIdSettings() {
  const toast = useToast();
  const [status, setStatus] = useState<TouchIdStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call({ type: 'touchid.status' })
      .then(setStatus)
      .catch(() => setStatus({ available: false, enabled: false }));
  }, []);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) {
        // Must run directly in the click handler (user gesture) inside the popup.
        const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
        if (!granted) {
          toast('Permission not granted — Touch ID stays off.', 'warn');
          return;
        }
      }
      const next = await call({ type: 'touchid.set', enabled: on });
      if (!on) await chrome.permissions.remove({ permissions: ['nativeMessaging'] }).catch(() => false);
      setStatus(next);
      if (on) toast('Touch ID is on. Next time the vault locks, unlock with your fingerprint.', 'success');
    } catch (e) {
      toast(errorText(e), 'error');
      setStatus(await call({ type: 'touchid.status' }).catch(() => status));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 p-4">
      <Switch
        checked={!!status?.enabled}
        disabled={busy || !status}
        onChange={(v) => void toggle(v)}
        label="Unlock with Touch ID"
        description="Use your fingerprint instead of typing the master password. Needs PassVault for Mac with “Touch ID in the browser extension” turned on."
      />
      {status?.enabled && !status.available && status.reason && <Banner tone="warn">{status.reason}</Banner>}
    </div>
  );
}
