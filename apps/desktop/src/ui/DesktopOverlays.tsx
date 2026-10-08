import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, KeyRound, ShieldAlert, X, XCircle } from 'lucide-react';
import { Badge, Banner, Button, Dialog, Input, cx } from '@passvault/ui';
import type { ConfirmRequest, HostKeyRequest, PromptRequest } from '../desktop/controller';
import type { SignRequestEvent } from '../ipc/types';
import { useDesktop, useDesktopState } from './hooks';

/**
 * Desktop-only dialogs rendered next to the shared app: agent sign approvals,
 * host-key trust / mismatch, keyboard-interactive prompts and confirmations.
 * One dialog is shown at a time, most security-relevant first.
 */
export function DesktopOverlays() {
  const sign = useDesktopState((s) => s.signRequests);
  const hostKeys = useDesktopState((s) => s.hostKeys);
  const prompts = useDesktopState((s) => s.prompts);
  const confirms = useDesktopState((s) => s.confirms);
  return (
    <>
      {sign[0] ? (
        <SignRequestDialog key={sign[0].requestId} req={sign[0]} queued={sign.length - 1} />
      ) : hostKeys[0] ? (
        <HostKeyDialog key={hostKeys[0].id} req={hostKeys[0]} />
      ) : prompts[0] ? (
        <PromptDialog key={prompts[0].id} req={prompts[0]} />
      ) : confirms[0] ? (
        <ConfirmDialog key={confirms[0].id} req={confirms[0]} />
      ) : null}
      <Notices />
    </>
  );
}

function hostKeyFileName(keyType: string): string {
  if (keyType.includes('ed25519')) return 'ed25519';
  if (keyType.startsWith('ecdsa')) return 'ecdsa';
  if (keyType.includes('rsa')) return 'rsa';
  return 'ed25519';
}

function Mono({ children }: { children: string }) {
  return <code className="block break-all rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[12.5px] text-fg">{children}</code>;
}

function ConfirmDialog({ req }: { req: ConfirmRequest }) {
  const { controller } = useDesktop();
  const close = (ok: boolean) => controller.resolveConfirm(req.id, ok);
  return (
    <Dialog
      open
      onClose={() => close(false)}
      title={req.title}
      size="md"
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button data-autofocus variant={req.tone === 'danger' ? 'danger' : 'primary'} onClick={() => close(true)}>
            {req.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-fg-muted">
        <p>{req.body}</p>
        {req.url && <Mono>{req.url}</Mono>}
        {req.lines && (
          <div>
            <pre className="max-h-48 overflow-auto rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] text-fg whitespace-pre-wrap break-all">{req.lines.shown.join('\n')}</pre>
            {req.lines.total > req.lines.shown.length && <p className="mt-1 text-xs">…and {req.lines.total - req.lines.shown.length} more line(s)</p>}
          </div>
        )}
        {req.warning && (
          <Banner tone="warn" icon={<AlertTriangle className="size-4" />}>
            {req.warning}
          </Banner>
        )}
      </div>
    </Dialog>
  );
}

function HostKeyDialog({ req }: { req: HostKeyRequest }) {
  const { controller } = useDesktop();
  const [busy, setBusy] = useState(false);
  const ev = req.ev;
  if (req.kind === 'mismatch') {
    return (
      <Dialog
        open
        dismissable={false}
        onClose={() => void controller.decideHostKey(req.id, false)}
        title="Server identity changed — connection stopped"
        size="lg"
        footer={
          <>
            <Button
              onClick={() => {
                void controller.decideHostKey(req.id, false);
                controller.openItem(req.itemId);
              }}
            >
              Open server settings
            </Button>
            <Button data-autofocus variant="primary" onClick={() => void controller.decideHostKey(req.id, false)}>
              Close
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <Banner tone="danger" icon={<ShieldAlert className="size-4" />} title={`${ev.hostPort} presented a different host key`}>
            This can mean someone is intercepting the connection (a man-in-the-middle attack), or that the server was reinstalled or its keys were rotated. PassVault stopped before sending any credentials.
          </Banner>
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-fg-muted">Trusted fingerprint{(ev.trusted?.length ?? 0) > 1 ? 's' : ''} ({req.itemTitle})</div>
            {(ev.trusted ?? []).map((f) => (
              <Mono key={f}>{f}</Mono>
            ))}
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-fg-muted">Presented now ({ev.keyType})</div>
            <Mono>{ev.fingerprint}</Mono>
          </div>
          <p className="text-fg-muted">
            Ask the server administrator whether the host key changed and compare the new fingerprint (e.g. <code className="font-mono text-xs">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on the server). Only if it is legitimate, open the server settings and remove the old trusted key; the next connection will then ask you to verify the new one. PassVault never replaces a trusted key automatically.
          </p>
        </div>
      </Dialog>
    );
  }
  const decide = async (trust: boolean) => {
    setBusy(true);
    await controller.decideHostKey(req.id, trust);
  };
  return (
    <Dialog
      open
      dismissable={false}
      onClose={() => void decide(false)}
      title="Verify the server’s identity"
      description={req.hop === 'jump' ? `Jump host for this connection · ${req.itemTitle}` : req.itemTitle}
      size="lg"
      footer={
        <>
          <Button disabled={busy} onClick={() => void decide(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void decide(true)}>
            Trust and connect
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-fg-muted">
          This is the first connection to <strong className="text-fg">{ev.hostPort}</strong> from PassVault. Before trusting it, confirm the fingerprint matches the server’s real host key.
        </p>
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
          <dt className="text-fg-subtle">Host</dt>
          <dd className="font-mono text-[13px]">{ev.hostPort}</dd>
          <dt className="text-fg-subtle">Key type</dt>
          <dd className="font-mono text-[13px]">{ev.keyType}</dd>
          <dt className="text-fg-subtle">Fingerprint</dt>
          <dd>
            <Mono>{ev.fingerprint}</Mono>
          </dd>
        </dl>
        <div className="rounded-xl border border-border bg-surface-2 px-3.5 py-3 text-fg-muted">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-fg">
            <KeyRound className="size-4" /> How to verify
          </div>
          Ask the server administrator for the host key fingerprint, or run{' '}
          <code className="font-mono text-xs text-fg">ssh-keygen -lf /etc/ssh/ssh_host_{hostKeyFileName(ev.keyType)}_key.pub</code> on the server through a channel you already trust (console, cloud provider’s serial log) and compare it character by character.
        </div>
        {!('canSave' in req) || req.canSave ? (
          <p className="text-xs text-fg-subtle">Trusting saves this key to the server item ({req.itemTitle}) so future connections are verified automatically.</p>
        ) : (
          <Banner tone="warn">You have view-only access to “{req.itemTitle}”. The key can be trusted for this session, but it cannot be saved to the item.</Banner>
        )}
      </div>
    </Dialog>
  );
}

function PromptDialog({ req }: { req: PromptRequest }) {
  const { controller } = useDesktop();
  const [answers, setAnswers] = useState<string[]>(() => req.questions.map(() => ''));
  const submit = () => void controller.answerPrompt(req.id, answers);
  useEffect(() => () => setAnswers([]), []);
  return (
    <Dialog
      open
      dismissable={false}
      onClose={() => void controller.answerPrompt(req.id, null)}
      title={req.name ? `Server prompt: ${req.name.slice(0, 120)}` : 'The server is asking for input'}
      description={`${req.itemTitle}${req.hop === 'jump' ? ' (jump host)' : ''} · text below comes from the server`}
      size="md"
      footer={
        <>
          <Button onClick={() => void controller.answerPrompt(req.id, null)}>Cancel</Button>
          <Button variant="primary" type="submit" form={`pf-${req.id}`}>
            Submit
          </Button>
        </>
      }
    >
      <form
        id={`pf-${req.id}`}
        className="space-y-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {req.instruction && <p className="whitespace-pre-wrap break-words text-fg-muted">{req.instruction.slice(0, 2000)}</p>}
        {req.questions.length === 0 && <p className="text-fg-muted">No input requested. Submit to continue.</p>}
        {req.questions.map((q, i) => (
          <label key={i} className="block space-y-1.5">
            <span className="block whitespace-pre-wrap break-words font-medium">{q.text.slice(0, 500) || `Question ${i + 1}`}</span>
            <div className="flex gap-2">
              <Input
                data-autofocus={i === 0 ? true : undefined}
                type={q.echo ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                value={answers[i] ?? ''}
                onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {req.hasStoredPassword && !q.echo && (
                <Button
                  size="md"
                  onClick={() => {
                    const pw = controller.storedPasswordFor(req.id);
                    setAnswers((a) => a.map((x, j) => (j === i ? pw : x)));
                  }}
                >
                  Fill stored password
                </Button>
              )}
            </div>
          </label>
        ))}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function SignRequestDialog({ req, queued }: { req: SignRequestEvent; queued: number }) {
  const { controller } = useDesktop();
  const decide = (d: 'deny' | 'once' | 'timed', minutes?: number) => void controller.decideSign(req.requestId, d, minutes);
  const proc = req.client.processName || 'Unknown process';
  return (
    <Dialog
      open
      dismissable={false}
      onClose={() => decide('deny')}
      title="Allow SSH key use?"
      description={queued > 0 ? `${queued} more request(s) waiting` : 'A program asked the PassVault SSH agent to sign with one of your keys.'}
      size="md"
      footer={
        <>
          <Button variant="danger" data-autofocus onClick={() => decide('deny')}>
            Deny
          </Button>
          <Button onClick={() => decide('timed', 15)}>Allow 15 min</Button>
          <Button onClick={() => decide('timed', 5)}>Allow 5 min</Button>
          <Button variant="primary" onClick={() => decide('once')}>
            Allow once
          </Button>
        </>
      }
    >
      <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-2.5 text-sm">
        <dt className="text-fg-subtle">Key</dt>
        <dd>
          <div className="font-medium">{req.keyName}</div>
          <div className="font-mono text-xs text-fg-subtle break-all">{req.fingerprint}</div>
        </dd>
        <dt className="text-fg-subtle">Requested by</dt>
        <dd>
          <div className="font-medium">
            {proc} {req.client.pid ? <span className="font-normal text-fg-subtle">(pid {req.client.pid})</span> : null}
          </div>
          {req.client.processPath && <div className="font-mono text-xs text-fg-subtle break-all">{req.client.processPath}</div>}
          <div className="text-xs text-fg-subtle">Reported by macOS; not authenticated.</div>
        </dd>
        <dt className="text-fg-subtle">Destination</dt>
        <dd>
          {req.destination.verified && req.destination.hostKeyFingerprint ? (
            <>
              <Badge tone="ok">Verified host key</Badge>
              <div className="mt-1 font-mono text-xs break-all">{req.destination.hostKeyFingerprint}</div>
              <div className="text-xs text-fg-subtle">{req.destination.note}</div>
            </>
          ) : (
            <div className="text-fg-muted">{req.destination.note || 'The SSH agent protocol does not reliably identify the destination.'}</div>
          )}
        </dd>
        {req.forwarded && (
          <>
            <dt className="text-fg-subtle">Forwarded</dt>
            <dd>
              <Badge tone="danger">Request came through agent forwarding</Badge>
            </dd>
          </>
        )}
      </dl>
      <p className="mt-4 text-xs text-fg-subtle">“Allow for N minutes” applies to this key only and ends when the vault locks.</p>
    </Dialog>
  );
}

function Notices() {
  const notices = useDesktopState((s) => s.notices);
  const { controller } = useDesktop();
  if (!notices.length) return null;
  const icon = { info: Info, success: CheckCircle2, error: XCircle, warn: AlertTriangle };
  return (
    <div aria-live="polite" className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {notices.map((n) => {
        const I = icon[n.tone];
        return (
          <div key={n.id} role={n.tone === 'error' ? 'alert' : 'status'} className="pv-animate-in flex items-start gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-3 text-sm shadow-[var(--shadow-pop)]">
            <I className={cx('mt-0.5 size-4 shrink-0', n.tone === 'success' && 'text-ok', n.tone === 'error' && 'text-danger', n.tone === 'warn' && 'text-warn', n.tone === 'info' && 'text-accent')} />
            <div className="flex-1">{n.message}</div>
            <button className="text-fg-subtle hover:text-fg" aria-label="Dismiss" onClick={() => controller.dismissNotice(n.id)}>
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
