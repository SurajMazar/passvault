import { useEffect, useState } from 'react';
import { Banner, Switch, useToast } from '@passvault/ui';
import type { TouchIdStatus } from '../shared/protocol';
import { call, errorText } from './rpc';

export const isMac = () => /Mac/i.test(navigator.userAgent);

/**
 * Chrome adds runtime.sendNativeMessage to a page only if the permission existed when the
 * page started, so right after the user allows it the popup reloads itself and finishes
 * turning Touch ID on from there (the worker may relay its host calls through it).
 */
const CONTINUE_KEY = 'pv-touchid-continue';
const hasNative = () => typeof (chrome.runtime as { sendNativeMessage?: unknown }).sendNativeMessage === 'function';
export function touchIdContinuing(): boolean {
  try {
    return sessionStorage.getItem(CONTINUE_KEY) === '1';
  } catch {
    return false;
  }
}

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
    if (touchIdContinuing()) {
      try {
        sessionStorage.removeItem(CONTINUE_KEY);
      } catch {
        /* ignore */
      }
      void toggle(true, true);
      return;
    }
    void call({ type: 'touchid.status' })
      .then(setStatus)
      .catch(() => setStatus({ available: false, enabled: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (on: boolean, continued = false) => {
    setBusy(true);
    try {
      if (on && !continued) {
        // Must run directly in the click handler (user gesture) inside the popup.
        const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
        if (!granted) {
          toast('Permission not granted — Touch ID stays off.', 'warn');
          return;
        }
        if (!hasNative()) {
          try {
            sessionStorage.setItem(CONTINUE_KEY, '1');
          } catch {
            /* ignore */
          }
          location.reload();
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
        description="Use your fingerprint instead of typing the master password. Needs PassVault for Mac, with Settings → Browser extension → “Let the PassVault extension use Touch ID” turned on."
      />
      {status?.enabled && !status.available && status.reason && <Banner tone="warn">{status.reason}</Banner>}
    </div>
  );
}
