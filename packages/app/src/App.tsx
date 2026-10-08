import { useEffect, useMemo, useState } from 'react';
import { ConfirmProvider, Logo, Spinner, ToastProvider, applyTheme } from '@passvault/ui';
import { VaultSession, type Platform } from '@passvault/vault-core';
import { AppContext, useSnapshot, useUi, type AppExtensions } from './state';
import { LockedScreen, MfaEnroll, MfaVerify, RecoveryCodes, SignedOut, type AuthRoute } from './auth/AuthScreens';
import { Shell } from './shell/Shell';

function Gate({ initialRoute }: { initialRoute?: AuthRoute }) {
  const snap = useSnapshot();
  switch (snap.auth.phase) {
    case 'initializing':
      return (
        <div className="flex h-full items-center justify-center gap-3">
          <Logo className="size-8" />
          <Spinner label="Starting PassVault" />
        </div>
      );
    case 'signed_out':
      return <SignedOut initial={initialRoute} />;
    case 'mfa_enroll':
      return <MfaEnroll />;
    case 'mfa_verify':
      return <MfaVerify />;
    case 'recovery_codes':
      return <RecoveryCodes />;
    case 'locked':
      return <LockedScreen />;
    case 'unlocked':
      return <Shell />;
  }
}

export interface PassVaultAppProps {
  platform: Platform;
  extensions?: AppExtensions;
  platformName?: 'web' | 'desktop' | 'extension';
  initialRoute?: AuthRoute;
  /** receives the session once created (desktop uses it for lock hooks) */
  onSession?: (s: VaultSession) => void;
}

export function PassVaultApp({ platform, extensions, platformName = 'web', initialRoute, onSession }: PassVaultAppProps) {
  const session = useMemo(() => new VaultSession(platform), [platform]);
  const theme = useUi((s) => s.theme);
  const [, force] = useState(0);
  useEffect(() => {
    const saved = (typeof localStorage !== 'undefined' && localStorage.getItem('pv-theme')) as 'light' | 'dark' | 'system' | null;
    if (saved) useUi.getState().set({ theme: saved });
    onSession?.(session);
    void session.init().then(() => force((n) => n + 1));
    const on = () => session.setOnline(true);
    const off = () => session.setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) session.setOnline(false);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => applyTheme(useUi.getState().theme);
    mq.addEventListener('change', onScheme);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      mq.removeEventListener('change', onScheme);
    };
  }, [session, onSession]);
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem('pv-theme', theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  return (
    <AppContext.Provider value={{ session, ext: extensions ?? {}, platformName }}>
      <ToastProvider>
        <ConfirmProvider>
          <Gate initialRoute={initialRoute} />
        </ConfirmProvider>
      </ToastProvider>
    </AppContext.Provider>
  );
}
