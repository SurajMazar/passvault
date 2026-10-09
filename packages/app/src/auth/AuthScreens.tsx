import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { AlertTriangle, Fingerprint, Info, KeyRound, Lock, LogOut, MailCheck, ShieldCheck } from 'lucide-react';
import { Banner, Button, Checkbox, Field, Input, Logo, SecretInput, StrengthMeter, useConfirm } from '@passvault/ui';
import { passwordStrength, completeVaultRecovery, resetAccount, startRecovery, verifyRecovery } from '@passvault/vault-core';
import { useApp, useSnapshot, errorMessage } from '../state';

const TRUST_POINTS = [
  { icon: Lock, title: 'Encrypted on your device', body: 'Items are encrypted before they leave this device. The server only stores ciphertext.' },
  { icon: KeyRound, title: 'Built for developers', body: 'Logins, SSH servers and keys, databases, API tokens, and .env files in one vault.' },
  { icon: ShieldCheck, title: 'Two-step sign-in', body: 'An authenticator app is required, so a stolen password alone is not enough.' },
];

function BrandPanel() {
  return (
    <aside className="pv-brand-panel relative hidden overflow-hidden text-white lg:flex lg:w-[44%] lg:flex-col lg:justify-between lg:p-12">
      <div className="pv-grid-bg pointer-events-none absolute inset-0" aria-hidden />
      <div className="relative flex items-center gap-3">
        <Logo className="size-10" />
        <span className="text-xl font-semibold tracking-tight">PassVault</span>
      </div>
      <div className="relative max-w-md">
        <h2 className="text-[32px] font-semibold leading-tight tracking-tight">Every secret your team relies on, locked with a key only you hold.</h2>
        <ul className="mt-10 space-y-6">
          {TRUST_POINTS.map(({ icon: I, title, body }) => (
            <li key={title} className="flex gap-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15">
                <I className="size-5 text-[#7ff0de]" />
              </span>
              <span>
                <span className="block font-medium">{title}</span>
                <span className="mt-0.5 block text-sm leading-relaxed text-white/65">{body}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="relative text-xs text-white/45">Zero-knowledge: PassVault cannot read your vault or reset your master password.</p>
    </aside>
  );
}

function AuthFrame({ children, title, subtitle, footer, showServer }: { children: ReactNode; title: string; subtitle?: ReactNode; footer?: ReactNode; showServer?: boolean }) {
  const { ext } = useApp();
  const server = showServer ? ext.authFooter?.() : null;
  return (
    <div className="flex min-h-full bg-bg">
      <BrandPanel />
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="pv-animate-in w-full max-w-[400px]">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <Logo className="size-9" />
            <span className="text-lg font-semibold tracking-tight">PassVault</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-sm leading-relaxed text-fg-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 border-t border-border pt-6 text-sm text-fg-muted">{footer}</div>}
          {server && <div className="mt-6">{server}</div>}
        </div>
      </main>
    </div>
  );
}

/** Plain-language explanation of the master password, collapsed by default. */
function MasterPasswordExplainer({ register }: { register?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button type="button" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Info className="size-3.5" /> What is a master password?
      </button>
      {open && (
        <div className="pv-animate-in mt-2 rounded-lg border border-border bg-surface-2 p-3 leading-relaxed text-fg-muted">
          It’s the one password that unlocks your PassVault. Your vault is encrypted on this device with a key made from it, so PassVault never sees it and{' '}
          <strong className="text-fg">cannot reset it for you</strong>.
          {register ? ' Choose something long you’ll remember — a few random words work well. You’ll also get a recovery key in case you forget it.' : ' If you forgot it, use your recovery key via “Forgot master password?”.'}
        </div>
      )}
    </div>
  );
}

export type AuthRoute = { kind: 'signin' } | { kind: 'register'; email?: string; code?: string } | { kind: 'recover'; token?: string };

export function SignedOut({ initial }: { initial?: AuthRoute }) {
  const [route, setRoute] = useState<AuthRoute>(initial ?? { kind: 'signin' });
  if (route.kind === 'recover') return <Recovery token={route.token} onDone={() => setRoute({ kind: 'signin' })} />;
  if (route.kind === 'register')
    return (
      <AuthFrame
        showServer
        title="Create your vault"
        subtitle="We verify your email first, then your encryption keys are generated on this device."
        footer={
          <>
            Already have an account?{' '}
            <button className="font-medium text-accent hover:underline" onClick={() => setRoute({ kind: 'signin' })}>
              Sign in
            </button>
          </>
        }
      >
        <Register initialEmail={route.email} initialCode={route.code} />
      </AuthFrame>
    );
  return (
    <AuthFrame
      showServer
      title="Welcome back"
      subtitle="Sign in to unlock your vault."
      footer={
        <span>
          New to PassVault?{' '}
          <button className="font-medium text-accent hover:underline" onClick={() => setRoute({ kind: 'register' })}>
            Create an account
          </button>
        </span>
      }
    >
      <SignIn onNav={setRoute} />
    </AuthFrame>
  );
}

function SignIn({ onNav }: { onNav: (r: AuthRoute) => void }) {
  const { session } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await session.login(email, password);
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(
        code === 'invalid_credentials'
            ? 'That email and master password don’t match.'
            : code === 'network_error'
              ? 'Can’t reach the PassVault server. Check your connection and try again.'
              : errorMessage(err),
      );
    } finally {
      setPassword('');
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="Email">{(id) => <Input id={id} className="!h-11 text-[15px]" type="email" autoComplete="username" placeholder="you@company.com" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <label htmlFor="pv-signin-pw" className="text-[13px] font-medium">
            Master password
          </label>
          <button type="button" className="text-xs text-fg-subtle hover:text-fg hover:underline" onClick={() => onNav({ kind: 'recover' })}>
            Forgot master password?
          </button>
        </div>
        <SecretInput id="pv-signin-pw" size="lg" value={password} onChange={setPassword} autoComplete="current-password" />
        <MasterPasswordExplainer />
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!email || !password}>
        {busy ? 'Unlocking…' : 'Sign in'}
      </Button>
      <p className="text-center text-xs text-fg-subtle">Lost your authenticator? Sign in, then choose “Use a recovery code”.</p>
    </form>
  );
}

function Steps({ step }: { step: number }) {
  const labels = ['Email', 'Verify', 'Details', 'Recovery key'];
  return (
    <ol className="mb-7 flex items-center gap-2" aria-label="Registration progress">
      {labels.map((l, i) => (
        <li key={l} className="flex flex-1 flex-col gap-1.5" aria-current={i === step ? 'step' : undefined}>
          <span className={`h-1 rounded-full ${i <= step ? 'bg-accent' : 'bg-border'}`} />
          <span className={`text-[11px] font-medium ${i === step ? 'text-fg' : 'text-fg-subtle'}`}>{l}</span>
        </li>
      ))}
    </ol>
  );
}

function Register({ initialEmail, initialCode }: { initialEmail?: string; initialCode?: string }) {
  const { session } = useApp();
  const [step, setStep] = useState<0 | 1 | 2 | 3>(initialEmail && initialCode ? 1 : 0);
  const [email, setEmail] = useState(initialEmail ?? '');
  const [code, setCode] = useState(initialCode ?? '');
  const [token, setToken] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [retype, setRetype] = useState('');
  const strength = useMemo(() => (password ? passwordStrength(password, [email, name]) : null), [password, email, name]);
  const tooWeak = !strength || strength.score < 3 || password.length < 12;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const c = (err as { code?: string }).code;
      setError(
        c === 'invalid_code'
          ? 'That code is wrong or has expired. Check the latest email or request a new code.'
          : c === 'rate_limited'
            ? 'Too many attempts. Wait a few minutes and try again.'
            : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  if (step === 0)
    return (
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await session.startRegistration(email);
            setInfo(null);
            setStep(1);
          });
        }}
      >
        <Steps step={0} />
        <Field label="Email" hint="We’ll send a 6-digit code to confirm it’s yours before anything is created.">
          {(id, d) => <Input id={id} aria-describedby={d} className="!h-11 text-[15px]" type="email" required autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!email}>
          Send verification code
        </Button>
      </form>
    );

  if (step === 1)
    return (
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            setToken(await session.verifyRegistration(email, code));
            setStep(2);
          });
        }}
      >
        <Steps step={1} />
        <Banner tone="accent" icon={<MailCheck className="size-4" />}>
          If <strong className="text-fg">{email}</strong> can be registered, a 6-digit code is on its way. It expires in 15 minutes.
        </Banner>
        <Field label="Verification code">
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="!h-12 text-center font-mono text-xl tracking-[0.5em]"
            />
          )}
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        {info && <Banner tone="neutral">{info}</Banner>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={code.length !== 6}>
          Verify email
        </Button>
        <div className="flex justify-between text-xs">
          <button
            type="button"
            className="text-fg-subtle hover:text-fg hover:underline"
            onClick={() => {
              setStep(0);
              setCode('');
              setError(null);
            }}
          >
            Use a different email
          </button>
          <button
            type="button"
            className="font-medium text-accent hover:underline"
            onClick={() =>
              void run(async () => {
                await session.startRegistration(email);
                setCode('');
                setInfo('A new code was sent. Earlier codes no longer work.');
              })
            }
          >
            Resend code
          </button>
        </div>
      </form>
    );

  if (step === 2)
    return (
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (password !== confirm) return setError('The two passwords don’t match.');
          void run(async () => {
            const r = await session.register(token!, email, name, password);
            setRecoveryKey(r.recoveryKey);
            setStep(3);
          });
        }}
      >
        <Steps step={2} />
        <div className="flex items-center gap-2 rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">
          <ShieldCheck className="size-4" /> {email} verified
        </div>
        <Field label="Your name">{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}</Field>
        <div className="space-y-2">
          <Field label="Master password" hint="At least 12 characters. A few random words are strong and easy to remember.">
            {(id, d) => <SecretInput id={id} describedBy={d} value={password} onChange={setPassword} autoComplete="new-password" />}
          </Field>
          {strength && <StrengthMeter score={strength.score} label={strength.label} />}
          {strength?.warning && <p className="text-xs text-warn">{strength.warning}</p>}
          <MasterPasswordExplainer register />
        </div>
        <Field label="Confirm master password" error={confirm && confirm !== password ? 'Doesn’t match yet' : null}>
          {(id) => <SecretInput id={id} value={confirm} onChange={setConfirm} autoComplete="new-password" />}
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={tooWeak || !name || password !== confirm}>
          {busy ? 'Generating your keys…' : 'Create account'}
        </Button>
      </form>
    );

  const lastGroup = recoveryKey!.split('-').pop()!;
  return (
    <div className="space-y-5">
      <Steps step={3} />
      <Banner tone="warn" icon={<AlertTriangle className="size-4" />} title="Save your recovery key — it’s shown only once">
        If you ever forget your master password, this key is the only way back into your vault. PassVault can’t recover it for you.
      </Banner>
      <div className="rounded-xl border border-dashed border-accent-line bg-accent-soft p-4 text-center font-mono text-[15px] leading-relaxed tracking-wide break-all select-all" aria-label="Recovery key">
        {recoveryKey}
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => session.platformRef.clipboard.copySecret(recoveryKey!, 60)}>
          Copy
        </Button>
        <Button size="sm" onClick={() => window.print()}>
          Print
        </Button>
      </div>
      <Field label={`Type the last group of the key to confirm you saved it`}>
        {(id) => <Input id={id} value={retype} onChange={(e) => setRetype(e.target.value.toUpperCase())} autoComplete="off" className="font-mono" placeholder={'•'.repeat(lastGroup.length)} />}
      </Field>
      <Checkbox checked={saved} onChange={setSaved} label="I stored the recovery key somewhere safe, offline" />
      {error && <Banner tone="danger">{error}</Banner>}
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        loading={busy}
        disabled={!saved || retype !== lastGroup}
        onClick={() =>
          void run(async () => {
            // Sign straight in; the server then requires authenticator setup.
            await session.login(email, password);
          })
        }
      >
        Continue to two-step setup
      </Button>
    </div>
  );
}

export function MfaEnroll() {
  const { session } = useApp();
  const snap = useSnapshot();
  const a = snap.auth.phase === 'mfa_enroll' ? snap.auth : null;
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  // Start enrollment exactly once: a second request would replace the pending
  // secret on the server and could leave the QR code showing a stale one
  // (React StrictMode runs effects twice in development).
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || !a || a.secret) return;
    startedRef.current = true;
    void session.startMfaEnrollment().catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (a?.otpauthUri) void QRCode.toDataURL(a.otpauthUri, { margin: 1, width: 200 }).then(setQr);
  }, [a?.otpauthUri]);
  if (!a) return null;
  return (
    <AuthFrame title="Set up two-step verification" subtitle="An authenticator app is required to protect account access. Scan the code, then enter the 6-digit code it shows.">
      <div className="space-y-4">
        <div className="flex justify-center rounded-lg border border-border bg-white p-3">{qr ? <img src={qr} alt="Authenticator QR code" width={200} height={200} /> : <div className="size-[200px]" />}</div>
        <button type="button" className="text-xs text-accent hover:underline" onClick={() => setShowSecret((s) => !s)}>
          {showSecret ? 'Hide setup key' : "Can't scan? Show setup key"}
        </button>
        {showSecret && a.secret && <div className="rounded border border-border bg-surface-2 p-2 font-mono text-xs break-all select-all">{a.secret}</div>}
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await session.confirmMfaEnrollment(code);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="6-digit code">{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="font-mono tracking-widest" />}</Field>
          {error && <Banner tone="danger">{error}</Banner>}
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={code.length !== 6}>
            Verify and continue
          </Button>
          <Button className="w-full" variant="ghost" onClick={() => session.cancelLogin()}>
            Cancel
          </Button>
        </form>
      </div>
    </AuthFrame>
  );
}

export function RecoveryCodes() {
  const { session } = useApp();
  const snap = useSnapshot();
  const [saved, setSaved] = useState(false);
  if (snap.auth.phase !== 'recovery_codes') return null;
  const codes = snap.auth.codes;
  return (
    <AuthFrame title="Save your two-step recovery codes" subtitle="Each code can be used once to sign in if you lose your authenticator. They do not decrypt your vault.">
      <div className="space-y-4">
        <ol className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface-2 p-3 font-mono text-sm">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => session.platformRef.clipboard.copySecret(codes.join('\n'), 60)}>
            Copy
          </Button>
          <Button size="sm" onClick={() => window.print()}>
            Print
          </Button>
        </div>
        <Checkbox checked={saved} onChange={setSaved} label="I saved these codes somewhere safe" />
        <Button variant="primary" className="w-full" disabled={!saved} onClick={() => session.acknowledgeRecoveryCodes()}>
          Open my vault
        </Button>
      </div>
    </AuthFrame>
  );
}

export function MfaVerify() {
  const { session } = useApp();
  const [mode, setMode] = useState<'code' | 'recovery'>('code');
  const [value, setValue] = useState('');
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  return (
    <AuthFrame title="Two-step verification" subtitle={mode === 'code' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter one of your one-time recovery codes.'}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await session.verifyMfa(mode === 'code' ? { code: value, trustDevice: trust } : { recoveryCode: value, trustDevice: trust });
            if (r.remainingRecoveryCodes !== undefined) setRemaining(r.remainingRecoveryCodes);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={mode === 'code' ? 'Authentication code' : 'Recovery code'}>
          {(id) => (
            <Input
              id={id}
              data-autofocus
              autoComplete="one-time-code"
              value={value}
              onChange={(e) => setValue(mode === 'code' ? e.target.value.replace(/\D/g, '').slice(0, 6) : e.target.value.toUpperCase())}
              className="font-mono tracking-widest"
            />
          )}
        </Field>
        <Checkbox checked={trust} onChange={setTrust} label="Trust this device for 30 days" />
        {error && <Banner tone="danger">{error}</Banner>}
        {remaining !== null && <Banner tone="warn">{remaining} recovery codes left. Set up your authenticator again in Settings.</Banner>}
        <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!value}>
          Verify
        </Button>
        <div className="flex justify-between text-xs">
          <button type="button" className="text-accent hover:underline" onClick={() => (setMode(mode === 'code' ? 'recovery' : 'code'), setValue(''))}>
            {mode === 'code' ? 'Use a recovery code' : 'Use authenticator code'}
          </button>
          <button type="button" className="text-fg-muted hover:underline" onClick={() => session.cancelLogin()}>
            Cancel
          </button>
        </div>
      </form>
    </AuthFrame>
  );
}

export function LockedScreen() {
  const { session } = useApp();
  const snap = useSnapshot();
  const confirm = useConfirm();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (snap.auth.phase !== 'locked') return null;
  const a = snap.auth;
  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (a.hasSession || !snap.online) {
        await session.unlock(password);
      } else {
        try {
          await session.login(a.email, password);
        } catch (err) {
          // Server unreachable: open the encrypted cache locally (read + queued edits).
          if ((err as { code?: string }).code === 'network_error' || (err as { code?: string }).code === 'offline') await session.unlock(password);
          else throw err;
        }
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPassword('');
      setBusy(false);
    }
  };
  return (
    <AuthFrame
      showServer
      title="Vault locked"
      subtitle={
        <>
          {a.name} · {a.email}
          {!a.hasSession && <span className="block mt-1 text-warn">{snap.online ? 'Your session ended; unlocking will sign you in again.' : 'Offline: you can read your cached vault. Changes sync when you reconnect and sign in.'}</span>}
        </>
      }
    >
      <form onSubmit={unlock} className="space-y-4">
        <Field label="Master password">{(id) => <SecretInput id={id} value={password} onChange={setPassword} autoComplete="current-password" />}</Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!password} icon={<Lock className="size-4" />}>
          Unlock
        </Button>
        {a.biometricAvailable && (
          <Button
            className="w-full"
            icon={<Fingerprint className="size-4" />}
            onClick={async () => {
              setError(null);
              try {
                await session.unlockWithBiometrics();
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            Unlock with {session.platformRef.biometrics?.label ?? 'Touch ID'}
          </Button>
        )}
        <Button
          variant="ghost"
          className="w-full"
          icon={<LogOut className="size-4" />}
          onClick={async () => {
            if (await confirm({ title: 'Sign out?', body: 'This removes the encrypted vault cache from this device. Unsynced changes will be lost.', confirmLabel: 'Sign out' })) await session.logout();
          }}
        >
          Sign out
        </Button>
      </form>
    </AuthFrame>
  );
}

function Recovery({ token: initialToken, onDone }: { token?: string; onDone: () => void }) {
  const { session } = useApp();
  const confirm = useConfirm();
  const [step, setStep] = useState<'start' | 'sent' | 'verify' | 'choose' | 'vault' | 'reset' | 'done'>(initialToken ? 'verify' : 'start');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState(initialToken ?? '');
  const [code, setCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [verified, setVerified] = useState<Awaited<ReturnType<typeof verifyRecovery>> | null>(null);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const strength = pw ? passwordStrength(pw) : null;
  const pwOk = !!strength && strength.score >= 3 && pw.length >= 12 && pw === pw2;
  return (
    <AuthFrame title="Account recovery" subtitle="Recovering account access never bypasses vault encryption.">
      <div className="space-y-4">
        {step === 'start' && (
          <>
            <ul className="text-sm text-fg-muted list-disc pl-5 space-y-1">
              <li>
                <strong className="text-fg">Lost your authenticator?</strong> Sign in normally and choose “Use a recovery code”.
              </li>
              <li>
                <strong className="text-fg">Forgot your master password?</strong> You need your vault recovery key plus email and two-step verification.
              </li>
              <li>
                <strong className="text-fg">Lost both password and recovery key?</strong> You can reset the account, which <em>permanently deletes</em> your vault data.
              </li>
            </ul>
            <Field label="Email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <Button variant="primary" className="w-full" loading={busy} disabled={!email} onClick={() => run(async () => (await startRecovery(session.api, email), setStep('sent')))}>
              Email me a recovery link
            </Button>
          </>
        )}
        {step === 'sent' && (
          <>
            <Banner tone="accent">If an account exists for {email}, we sent a recovery link. It expires in 30 minutes and contains no secrets.</Banner>
            <Button className="w-full" onClick={() => setStep('verify')}>
              I have the link code
            </Button>
          </>
        )}
        {step === 'verify' && (
          <>
            <Field label="Recovery link code">{(id) => <Input id={id} value={token} onChange={(e) => setToken(e.target.value)} className="font-mono" />}</Field>
            <Field label={useRecoveryCode ? 'Two-step recovery code' : 'Authenticator code'}>
              {(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono" autoComplete="one-time-code" />}
            </Field>
            <Checkbox checked={useRecoveryCode} onChange={setUseRecoveryCode} label="Use a two-step recovery code instead" />
            <Button
              variant="primary"
              className="w-full"
              loading={busy}
              disabled={!token || !code}
              onClick={() =>
                run(async () => {
                  setVerified(await verifyRecovery(session.api, token.trim(), useRecoveryCode ? { recoveryCode: code } : { code }));
                  setStep('choose');
                })
              }
            >
              Continue
            </Button>
          </>
        )}
        {step === 'choose' && (
          <div className="grid gap-3">
            <Button variant="primary" icon={<KeyRound className="size-4" />} onClick={() => setStep('vault')}>
              I have my vault recovery key
            </Button>
            <Button variant="danger" onClick={() => setStep('reset')}>
              I lost my recovery key — reset account
            </Button>
          </div>
        )}
        {(step === 'vault' || step === 'reset') && (
          <>
            {step === 'vault' ? (
              <Field label="Vault recovery key" hint="Decrypted on this device only.">
                {(id, d) => <Input id={id} aria-describedby={d} value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} className="font-mono" autoComplete="off" spellCheck={false} />}
              </Field>
            ) : (
              <Banner tone="danger" icon={<AlertTriangle className="size-4" />} title="All vault data will be permanently deleted">
                Without your master password or recovery key, nobody — including PassVault — can decrypt your vault. Resetting deletes your items and removes you from shared vaults, then creates a new empty vault.
              </Banner>
            )}
            <Field label="New master password">{(id) => <SecretInput id={id} value={pw} onChange={setPw} autoComplete="new-password" />}</Field>
            {strength && <StrengthMeter score={strength.score} label={strength.label} />}
            <Field label="Confirm new master password">{(id) => <SecretInput id={id} value={pw2} onChange={setPw2} autoComplete="new-password" />}</Field>
            <Button
              variant={step === 'reset' ? 'danger' : 'primary'}
              className="w-full"
              loading={busy}
              disabled={!pwOk || (step === 'vault' && !recoveryKey)}
              onClick={() =>
                run(async () => {
                  if (step === 'vault') {
                    const r = await completeVaultRecovery(session.api, verified!, recoveryKey, pw);
                    setNewKey(r.newRecoveryKey);
                  } else {
                    const ok = await confirm({ title: 'Permanently delete vault data?', body: 'This cannot be undone.', confirmLabel: 'Delete and reset', typeToConfirm: 'DELETE MY VAULT DATA' });
                    if (!ok) return;
                    const r = await resetAccount(session.api, verified!.recoveryToken, pw);
                    setNewKey(r.recoveryKey);
                  }
                  setStep('done');
                })
              }
            >
              {step === 'vault' ? 'Recover vault' : 'Reset account'}
            </Button>
          </>
        )}
        {step === 'done' && newKey && (
          <>
            <Banner tone="ok">Done. All sessions were signed out. Save your new recovery key — the old one no longer works.</Banner>
            <div className="rounded-lg border border-border-strong bg-surface-2 p-3 font-mono text-sm break-all select-all">{newKey}</div>
            <Button variant="primary" className="w-full" onClick={onDone}>
              Sign in
            </Button>
          </>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
        {step !== 'done' && (
          <button type="button" className="text-xs text-accent hover:underline" onClick={onDone}>
            Back to sign in
          </button>
        )}
      </div>
    </AuthFrame>
  );
}
