import { useEffect, useState } from 'react';
import { Banner, Switch, useToast } from '@passvault/ui';
import type { PasskeyUnlockStatus } from '../shared/protocol';
import { call, errorText } from './rpc';

/**
 * Unlock with a passkey (Touch ID, Windows Hello or a phone) instead of the master
 * password. Turning it on opens PassVault's passkey window, which creates the passkey;
 * the toolbar popup closes meanwhile and comes back when it is done. The master password
 * keeps working either way.
 */
export function PasskeyUnlockSettings() {
  const toast = useToast();
  const [status, setStatus] = useState<PasskeyUnlockStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call({ type: 'passkeyUnlock.status' })
      .then(setStatus)
      .catch(() => setStatus({ available: false, enabled: false }));
  }, []);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      const next = await call({ type: 'passkeyUnlock.set', enabled: on });
      setStatus(next);
      if (!on) toast('Passkey unlock is off. The “PassVault unlock” passkey stays in your password manager; you can delete it there.', 'success');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 p-4">
      <Switch
        checked={!!status?.enabled}
        disabled={busy || !status || (!status.available && !status.enabled)}
        onChange={(v) => void toggle(v)}
        label="Unlock with a passkey"
        description="Use Touch ID, Windows Hello or your phone instead of typing the master password. PassVault saves a passkey named “PassVault unlock” in your password manager; it only unlocks PassVault in this browser."
      />
      {status?.touchIdReplaced && !status.enabled && (
        <Banner tone="neutral">Touch ID through PassVault for Mac is replaced by passkey unlock, which needs no app. Turn it on here.</Banner>
      )}
      {!status?.available && status?.reason && <Banner tone="warn">Passkey unlock is not available: {status.reason}.</Banner>}
    </div>
  );
}
