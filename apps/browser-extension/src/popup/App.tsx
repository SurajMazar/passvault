import { Banner, Spinner } from '@passvault/ui';
import { MfaEnroll, MfaVerify, RecoveryCodes, SignIn, Unlock } from './AuthViews';
import { usePopupState } from './rpc';
import { VaultView } from './VaultView';

export function App() {
  const { state, error } = usePopupState();
  if (error) {
    return (
      <div className="p-4">
        <Banner tone="warn">{error}</Banner>
      </div>
    );
  }
  if (!state || state.phase === 'initializing') {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Starting PassVault" />
      </div>
    );
  }
  switch (state.phase) {
    case 'signed_out':
      return <SignIn state={state} />;
    case 'mfa_verify':
      return <MfaVerify state={state} />;
    case 'mfa_enroll':
      return <MfaEnroll state={state} />;
    case 'recovery_codes':
      return <RecoveryCodes state={state} />;
    case 'locked':
      return <Unlock state={state} />;
    case 'unlocked':
      return <VaultView state={state} />;
  }
}
