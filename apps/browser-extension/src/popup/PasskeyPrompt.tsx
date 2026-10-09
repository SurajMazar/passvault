import { useState } from 'react';
import { KeyRound, Smartphone } from 'lucide-react';
import { Banner, Button, Logo } from '@passvault/ui';
import type { PopupState } from '../shared/protocol';
import { call, errorText } from './rpc';

/**
 * A site asked to create or use a passkey. The decision is made here, in PassVault's
 * own popup — the page cannot click it. "Use another device" hands the request back to
 * Chrome (phone, security key, Google Password Manager).
 */
export function PasskeyPrompt({ state }: { state: PopupState }) {
  const req = state.passkey!;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (action: 'approve' | 'fallback' | 'cancel', credentialId?: string) => {
    setBusy(credentialId ?? action);
    setError(null);
    try {
      const r = await call({ type: 'passkey.decide', id: req.id, action, ...(credentialId ? { credentialId } : {}) });
      if (!r.ok) return setError(r.message ?? 'Something went wrong.');
      window.close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pv-view-in flex h-full flex-col gap-4 p-5">
      <div className="flex items-center gap-3">
        <Logo />
        <div className="min-w-0">
          <h1 className="text-base font-semibold">{req.kind === 'create' ? 'Save a passkey' : 'Sign in with a passkey'}</h1>
          <p className="truncate text-xs text-fg-subtle" title={req.host}>
            {req.host}
          </p>
        </div>
      </div>

      {req.kind === 'create' ? (
        <>
          <p className="text-sm text-fg-muted">
            <strong className="text-fg">{req.rpName}</strong> wants to create a passkey
            {req.userName ? (
              <>
                {' '}
                for <strong className="text-fg">{req.userName}</strong>
              </>
            ) : null}
            . PassVault keeps it end-to-end encrypted and syncs it to your other devices.
          </p>
          <p className="text-xs text-fg-subtle">{req.intoTitle ? `It will be added to your login “${req.intoTitle}”.` : 'A new login for this site will hold it.'}</p>
          <Button variant="primary" size="lg" icon={<KeyRound className="size-4" />} loading={busy === 'approve'} disabled={!!busy} onClick={() => void decide('approve')}>
            Save passkey in PassVault
          </Button>
        </>
      ) : req.candidates.length === 0 ? (
        <p className="text-sm text-fg-muted">PassVault has no passkey for {req.rpId}.</p>
      ) : (
        <>
          <p className="text-sm text-fg-muted">Choose the account to sign in to {req.rpId}:</p>
          <ul className="flex flex-col gap-1.5">
            {req.candidates.map((c) => (
              <li key={c.credentialId}>
                <button
                  className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-left transition-colors hover:bg-surface-3 disabled:opacity-60"
                  disabled={!!busy}
                  onClick={() => void decide('approve', c.credentialId)}
                >
                  <KeyRound className="size-4 shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" title={c.userName}>
                      {c.userName || '(no username)'}
                    </span>
                    <span className="block truncate text-[11px] text-fg-subtle" title={c.title}>
                      {c.title}
                    </span>
                  </span>
                  {busy === c.credentialId && <span className="text-xs text-fg-subtle">Signing…</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {error && <Banner tone="danger">{error}</Banner>}

      <div className="mt-auto flex flex-col gap-1.5">
        <Button icon={<Smartphone className="size-4" />} disabled={!!busy} onClick={() => void decide('fallback')}>
          Use another device or passkey
        </Button>
        <Button variant="ghost" disabled={!!busy} onClick={() => void decide('cancel')}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
