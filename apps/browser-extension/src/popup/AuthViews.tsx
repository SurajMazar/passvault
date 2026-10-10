import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { ExternalLink, Fingerprint, Lock, ShieldCheck } from 'lucide-react';
import { Banner, Button, Checkbox, Field, Input, Logo, SecretInput } from '@passvault/ui';
import type { PopupState } from '../shared/protocol';
import { call, copyToClipboard, errorText } from './rpc';
import { ServerSwitch } from './ServerSwitch';

export function openDashboard(url: string, path = '') {
  void chrome.tabs.create({ url: `${url.replace(/\/+$/, '')}${path}` });
  window.close();
}

function Shell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-y-auto pv-scroll px-5 py-6">
      <div className="mb-5 flex flex-col items-center gap-2 text-center">
        <Logo className="size-10" />
        <h1 className="text-base font-semibold">{title}</h1>
        {subtitle && <p className="text-xs text-fg-muted">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function SignIn({ state }: { state: PopupState }) {
  const [email, setEmail] = useState(state.email ?? '');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await call({ type: 'auth.login', email, password });
      setPassword('');
    });
  };
  return (
    <Shell title="Sign in to PassVault" subtitle="Your vault is decrypted only on this device.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />}</Field>
        <Field label="Master password">{(id) => <SecretInput id={id} value={password} onChange={setPassword} autoComplete="current-password" />}</Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!email || !password}>
          Sign in
        </Button>
      </form>
      <div className="mt-6 text-center text-xs text-fg-muted">
        New to PassVault?{' '}
        <button className="text-accent hover:underline" onClick={() => openDashboard(state.webUrl)}>
          Create an account in the dashboard <ExternalLink className="inline size-3" />
        </button>
      </div>
      {state.server && (
        <div className="mt-5">
          <ServerSwitch key={state.server.url} state={state} />
        </div>
      )}
    </Shell>
  );
}

export function MfaVerify({ state }: { state: PopupState }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const { busy, error, run } = useSubmit();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() =>
      call(
        useRecovery
          ? { type: 'auth.mfaVerify', recoveryCode: code.trim(), trustDevice: trust }
          : { type: 'auth.mfaVerify', code: code.replace(/\s/g, ''), trustDevice: trust },
      ),
    );
  };
  return (
    <Shell title="Two-step verification" subtitle={state.email}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label={useRecovery ? 'Recovery code' : 'Authenticator code'}>
          {(id) => (
            <Input
              id={id}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              placeholder={useRecovery ? 'xxxx-xxxx' : '123456'}
              autoFocus
            />
          )}
        </Field>
        <Checkbox checked={trust} onChange={setTrust} label="Trust this browser for 30 days" />
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!code}>
          Verify
        </Button>
        <div className="flex justify-between text-xs">
          <button type="button" className="text-accent hover:underline" onClick={() => setUseRecovery((v) => !v)}>
            {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
          </button>
          <button type="button" className="text-fg-muted hover:underline" onClick={() => void call({ type: 'auth.cancel' })}>
            Cancel
          </button>
        </div>
      </form>
    </Shell>
  );
}

/** MFA enrollment in the popup (QR code + manual secret), with a dashboard fallback. */
export function MfaEnroll({ state }: { state: PopupState }) {
  const [code, setCode] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const { busy, error, run, setError } = useSubmit();
  const secret = state.mfaEnroll?.secret;
  const uri = state.mfaEnroll?.otpauthUri;
  useEffect(() => {
    if (!secret) void call({ type: 'auth.mfaEnrollStart' }).catch((e) => setError(errorText(e)));
  }, [secret, setError]);
  useEffect(() => {
    if (uri) void QRCode.toDataURL(uri, { margin: 1, width: 168 }).then(setQr);
  }, [uri]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => call({ type: 'auth.mfaEnrollConfirm', code: code.replace(/\s/g, '') }));
  };
  return (
    <Shell title="Set up two-step verification" subtitle="Your account requires an authenticator app.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col items-center gap-2">
          {qr ? <img src={qr} alt="Authenticator QR code" className="size-[168px] rounded bg-white p-1" /> : <div className="size-[168px] animate-pulse rounded bg-bg-subtle" />}
          {secret && (
            <code className="break-all text-center font-mono text-[11px] text-fg-muted" aria-label="Setup key">
              {secret}
            </code>
          )}
        </div>
        <Field label="6-digit code from the app">
          {(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" />}
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={code.replace(/\s/g, '').length !== 6}>
          Confirm
        </Button>
        <div className="flex justify-between text-xs">
          <button type="button" className="text-accent hover:underline" onClick={() => openDashboard(state.webUrl)}>
            Finish in the dashboard instead
          </button>
          <button type="button" className="text-fg-muted hover:underline" onClick={() => void call({ type: 'auth.cancel' })}>
            Cancel
          </button>
        </div>
        <p className="text-[11px] text-fg-subtle">Keep this popup open while you scan the code. If it closes, sign in again.</p>
      </form>
    </Shell>
  );
}

export function RecoveryCodes({ state }: { state: PopupState }) {
  const codes = state.recoveryCodes ?? [];
  const [saved, setSaved] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Shell title="Save your recovery codes" subtitle="Each code signs you in once if you lose your authenticator.">
      <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border bg-surface p-3 font-mono text-xs">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="mt-3 flex flex-col gap-3">
        <Button
          onClick={async () => {
            setMsg(await copyToClipboard(codes.join('\n'), true));
          }}
        >
          Copy codes
        </Button>
        {msg && <p className="text-xs text-fg-muted">{msg}</p>}
        <Checkbox checked={saved} onChange={setSaved} label="I saved these codes somewhere safe" />
        <Button variant="primary" disabled={!saved} icon={<ShieldCheck className="size-4" />} onClick={() => void call({ type: 'auth.ackRecoveryCodes' })}>
          Continue
        </Button>
      </div>
    </Shell>
  );
}

/** Touch ID is offered once per popup opening; after a cancel the button stays. */
let touchIdTried = false;

export function Unlock({ state }: { state: PopupState }) {
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();
  const touchId = () =>
    void run(async () => {
      await call({ type: 'auth.unlockBiometric' });
    });
  // Ask when the popup opens instead of trusting the flag computed when the vault locked:
  // the background often cannot reach the Touch ID host at that moment (a restarted worker,
  // no popup to relay through), and the stale "unavailable" would hide Touch ID until the
  // next lock.
  const [bio, setBio] = useState(!!state.biometricAvailable);
  useEffect(() => {
    if (state.biometricAvailable) return setBio(true);
    let live = true;
    void call({ type: 'touchid.status' })
      .then((s) => live && setBio(s.enabled && s.available))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [state.biometricAvailable]);
  useEffect(() => {
    if (bio && !touchIdTried) {
      touchIdTried = true;
      // Automatic prompt: cancelling it ("Use Master Password") is not an error.
      void call({ type: 'auth.unlockBiometric' }).catch(() => undefined);
    }
  }, [bio]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await call({ type: 'auth.unlock', password });
      setPassword('');
    });
  };
  return (
    <Shell title="PassVault is locked" subtitle={state.email}>
      {state.passkey && (
        <div className="mb-3">
          <Banner tone="neutral">
            Unlock to {state.passkey.kind === 'create' ? 'save a passkey for' : 'sign in with a passkey to'} {state.passkey.host}.
          </Banner>
        </div>
      )}
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Master password">{(id) => <SecretInput id={id} value={password} onChange={setPassword} autoComplete="current-password" />}</Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!password} icon={<Lock className="size-4" />}>
          Unlock
        </Button>
        {bio && (
          <Button type="button" size="lg" disabled={busy} onClick={touchId} icon={<Fingerprint className="size-4" />}>
            Unlock with Touch ID
          </Button>
        )}
      </form>
      {!state.hasSession && (
        <div className="mt-3">
          <Banner tone="warn">You are signed out of the server. Unlocking shows your offline copy; sign in again to sync.</Banner>
        </div>
      )}
      <div className="mt-6 flex justify-center gap-4 text-xs">
        <button className="text-fg-muted hover:underline" onClick={() => void call({ type: 'auth.logout' })}>
          Sign out
        </button>
        <button className="text-accent hover:underline" onClick={() => openDashboard(state.webUrl)}>
          Open dashboard
        </button>
      </div>
      {state.server && (
        <div className="mt-5">
          <ServerSwitch key={state.server.url} state={state} />
        </div>
      )}
    </Shell>
  );
}
