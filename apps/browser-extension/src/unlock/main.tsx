import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Banner, Button, Logo, Spinner, applyTheme } from '@passvault/ui';
import { Check, Fingerprint } from 'lucide-react';
import type { Ceremony } from '../background/passkey-unlock';
import './unlock.css';

/**
 * PassVault's passkey window (background/passkey-unlock.ts): creates the unlock passkey
 * or asks it for its PRF secret, hands the result to the background and closes. The
 * relying party is the extension's own origin. Nothing is stored here.
 */

applyTheme('system');
const id = location.hash.slice(1);
type Params = Ceremony & { rpName: string };

const b64u = (b: ArrayBuffer | Uint8Array) => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const send = (m: Record<string, unknown>) => chrome.runtime.sendMessage({ ...m, id });

class NoPrf extends Error {}
type PrfOutput = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

/** The PRF secret of passkey `credentialId` for `salt`, after user verification. */
async function prfFrom(credentialId: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>) {
  const a = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: 120_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const first = (a?.getClientExtensionResults() as PrfOutput | undefined)?.prf?.results?.first;
  if (!a || !first) throw new NoPrf();
  return { credentialId: b64u(a.rawId), prf: b64u(first) };
}

async function enroll(p: Extract<Params, { kind: 'enroll' }>) {
  const salt = unb64u(p.salt);
  const c = (await navigator.credentials.create({
    publicKey: {
      rp: { name: p.rpName },
      user: { id: random(16), name: p.userName, displayName: 'PassVault unlock' },
      challenge: random(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' },
      // Prefer this computer's own authenticator (Touch ID, Windows Hello); a phone still works.
      hints: ['client-device'],
      timeout: 120_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    } as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!c) throw new Error('No passkey was created.');
  const prf = (c.getClientExtensionResults() as PrfOutput).prf;
  if (prf?.enabled === false) throw new NoPrf();
  // Some authenticators return the secret at creation; others only on first use (a second prompt).
  if (prf?.results?.first) return { credentialId: b64u(c.rawId), prf: b64u(prf.results.first) };
  return prfFrom(new Uint8Array(c.rawId), salt);
}

function explain(e: unknown): string {
  if (e instanceof NoPrf)
    return 'This passkey provider cannot be used to unlock PassVault (it does not support the PRF extension). Try another one, e.g. Google Password Manager, iCloud Keychain (macOS 15 or later) or Windows Hello.';
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'The passkey request was cancelled, timed out or did not match.';
  if (name === 'InvalidStateError') return 'This passkey already exists on that device. Try again or choose another device.';
  if (name === 'SecurityError') return 'This browser does not allow passkeys here.';
  return e instanceof Error ? e.message : String(e);
}

let started = false;

function UnlockPage() {
  const [params, setParams] = useState<Params | null>(null);
  const [phase, setPhase] = useState<'loading' | 'asking' | 'done' | 'error' | 'gone'>('loading');
  const [error, setError] = useState('');

  const ceremony = async (p: Params) => {
    setPhase('asking');
    setError('');
    try {
      if (!window.PublicKeyCredential) throw new Error('This browser does not support passkeys.');
      const r = p.kind === 'enroll' ? await enroll(p) : await prfFrom(unb64u(p.credentialId), unb64u(p.salt));
      await send({ type: 'passkeyUnlock.done', ...r });
      setPhase('done'); // PassVault closes this window in a moment
    } catch (e) {
      setError(explain(e));
      setPhase('error');
    }
  };

  useEffect(() => {
    void send({ type: 'passkeyUnlock.get' })
      .then((p) => {
        if (!p || typeof p !== 'object' || !('kind' in p)) return setPhase('gone');
        setParams(p as Params);
        if (!started) {
          started = true;
          void ceremony(p as Params);
        }
      })
      .catch(() => setPhase('gone'));
  }, []);

  const giveUp = async (usePassword: boolean) => {
    await send({ type: 'passkeyUnlock.fail', message: error || 'Cancelled', usePassword }).catch(() => undefined);
    window.close();
  };

  const enrolling = params?.kind === 'enroll';
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 py-8 text-center">
      <Logo className="size-11" />
      <h1 className="text-base font-semibold">{enrolling ? 'Turn on passkey unlock' : 'Unlock PassVault'}</h1>
      {phase === 'loading' && <Spinner label="Starting" />}
      {phase === 'asking' && (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Fingerprint className="size-4 shrink-0" aria-hidden />
          {enrolling ? 'Create the passkey with Touch ID, Windows Hello or your phone.' : 'Confirm with your passkey.'}
        </p>
      )}
      {phase === 'done' && (
        <p className="flex items-center gap-2 text-sm text-ok" role="status">
          <Check className="size-4" aria-hidden /> {enrolling ? 'Passkey unlock is on.' : 'Unlocked.'}
        </p>
      )}
      {phase === 'gone' && <Banner tone="neutral">This request has ended. You can close this window.</Banner>}
      {phase === 'error' && (
        <>
          <Banner tone="warn">{error}</Banner>
          <div className="flex w-full flex-col gap-2">
            <Button variant="primary" onClick={() => params && void ceremony(params)} icon={<Fingerprint className="size-4" />}>
              Try again
            </Button>
            <Button onClick={() => void giveUp(!enrolling)}>{enrolling ? 'Cancel' : 'Use master password'}</Button>
          </div>
        </>
      )}
      {phase === 'asking' && (
        <button className="text-xs text-fg-muted hover:underline" onClick={() => void giveUp(!enrolling)}>
          {enrolling ? 'Cancel' : 'Use master password instead'}
        </button>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UnlockPage />
  </StrictMode>,
);
