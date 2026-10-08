import { useState, type FormEvent, type ReactNode } from 'react';
import { CheckCircle2, Laptop, Pencil, Server, Trash2, XCircle } from 'lucide-react';
import { Badge, Banner, Button, Field, Input, Switch, cx } from './primitives';

/** A saved server as the client shows it (the active one included). */
export interface ServerProfileView {
  id: string;
  name: string;
  url: string;
  /** account last used on this server (from that server's own storage), if any */
  account: string | null;
  active: boolean;
  lastCheck: { ok: boolean; at: number; version?: string; message?: string } | null;
}

/** Result of a connection test, already worded for people. */
export interface ServerCheckView {
  ok: boolean;
  title: string;
  detail?: string;
  degraded?: boolean;
  registration?: 'open' | 'closed';
}

export interface ServerConnectionProps {
  profiles: ServerProfileView[];
  /** explicit local-development setting (http:// for loopback addresses) */
  localDev: boolean;
  /** whether a vault is unlocked right now (switching locks it) */
  unlocked: boolean;
  /** live state of the current connection, e.g. Ready / Locked / Offline */
  status?: { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' };
  /** canonical form of an address; throws an Error with a readable message */
  normalize: (url: string) => string;
  /**
   * Tests an address without sending credentials. Called directly from the
   * click handler (before any await), so a client can show a permission prompt.
   */
  test: (url: string) => Promise<ServerCheckView>;
  /** Connects to a new address (kept as a saved server). Locks the vault; requires signing in there. */
  save: (url: string) => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  /** Forgets a saved server and its local data on this device. */
  remove: (id: string) => Promise<void>;
  setLocalDev?: (on: boolean) => Promise<void>;
  compact?: boolean;
}

type Pending = { kind: 'url'; url: string; check: ServerCheckView } | { kind: 'profile'; profile: ServerProfileView };

const label = (url: string) => {
  const u = new URL(url);
  return u.host + (u.pathname === '/' ? '' : u.pathname);
};
const isLocal = (url: string) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Settings → Server connection: shows the connected server, lets the user
 * change its address at any time (Test connection / Save changes / Cancel) and
 * switch between saved servers. A failed check never changes anything; a
 * successful change locks the vault and starts a separate connection.
 */
export function ServerConnection(props: ServerConnectionProps) {
  const current = props.profiles.find((p) => p.active) ?? props.profiles[0]!;
  const [url, setUrl] = useState(current.url);
  const [busy, setBusy] = useState<null | 'test' | 'save' | 'switch'>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; check: ServerCheckView } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const others = props.profiles.filter((p) => !p.active);
  const sm = props.compact;

  const reset = () => {
    setUrl(current.url);
    setError(null);
    setResult(null);
    setPending(null);
  };

  const normalized = (): string | null => {
    try {
      return props.normalize(url);
    } catch (e) {
      setError(message(e));
      setResult(null);
      return null;
    }
  };
  const unchanged = (() => {
    try {
      return props.normalize(url) === current.url;
    } catch {
      return url.trim() === current.url;
    }
  })();

  const runTest = (target: string) => {
    setError(null);
    setPending(null);
    setBusy('test');
    const p = props.test(target); // synchronous start (permission prompts need the click)
    return p
      .then((check) => {
        setResult({ url: target, check });
        return check;
      })
      .catch((e: unknown) => {
        const check: ServerCheckView = { ok: false, title: 'Connection test failed', detail: message(e) };
        setResult({ url: target, check });
        return check;
      })
      .finally(() => setBusy(null));
  };

  const onTest = () => {
    const target = normalized();
    if (target) void runTest(target);
  };

  const onSave = (e?: FormEvent) => {
    e?.preventDefault();
    const target = normalized();
    if (!target) return;
    if (target === current.url) return reset();
    void runTest(target).then((check) => {
      if (!check.ok) return; // nothing changes; the error is shown
      if (props.unlocked) setPending({ kind: 'url', url: target, check });
      else void apply({ kind: 'url', url: target, check });
    });
  };

  const apply = async (p: Pending) => {
    setBusy(p.kind === 'url' ? 'save' : 'switch');
    setError(null);
    try {
      if (p.kind === 'url') await props.save(p.url);
      else await props.switchTo(p.profile.id);
      setPending(null);
      setResult(null);
    } catch (e) {
      setError(`${message(e)} You are still connected to ${label(current.url)}.`);
    } finally {
      setBusy(null);
    }
  };

  const askSwitch = (profile: ServerProfileView) => {
    setError(null);
    setResult(null);
    if (props.unlocked) setPending({ kind: 'profile', profile });
    else void apply({ kind: 'profile', profile });
  };

  const tone = props.status?.tone ?? 'neutral';
  return (
    <div className={cx('flex flex-col', sm ? 'gap-3' : 'gap-4')}>
      {/* Connected server */}
      <div className="flex items-start gap-3 rounded-xl border border-border bg-surface-2 px-3.5 py-3">
        {isLocal(current.url) ? <Laptop className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden /> : <Server className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-fg-subtle">Connected to</span>
            {props.status && <Badge tone={tone === 'neutral' ? 'neutral' : tone}>{props.status.label}</Badge>}
          </div>
          <div className="truncate font-medium" title={current.url}>
            {current.name}
          </div>
          <div className="truncate font-mono text-xs text-fg-muted" data-testid="current-server-url">
            {current.url}
          </div>
          <div className="mt-0.5 text-xs text-fg-subtle">{current.account ? <>Account · {current.account}</> : 'Not signed in on this server yet'}</div>
        </div>
      </div>

      {/* Editable address */}
      <form onSubmit={onSave} className="flex flex-col gap-2.5" aria-label="Server address">
        <Field label="Server URL" hint={props.localDev ? 'https:// address of a PassVault server (a path such as /passvault is fine), or http://localhost for local development.' : 'https:// address of a PassVault server. A path such as https://example.com/passvault is fine.'}>
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
                setResult(null);
                setPending(null);
              }}
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="https://vault.example.com"
              disabled={!!busy}
            />
          )}
        </Field>

        <div aria-live="polite" className="flex flex-col gap-2">
          {error && <Banner tone="danger">{error}</Banner>}
          {result && !pending && <CheckBanner check={result.check} url={result.url} keepNote={!result.check.ok && result.url !== current.url ? `Nothing was changed — you are still connected to ${label(current.url)}.` : undefined} />}
        </div>

        {pending ? (
          <Confirm
            busy={!!busy}
            onCancel={() => setPending(null)}
            onConfirm={() => void apply(pending)}
            title={`Switch to ${pending.kind === 'url' ? label(pending.url) : pending.profile.name}?`}
          >
            Your vault will be locked and you will sign in to the other server. Nothing is copied or uploaded between servers; data from {current.name} stays encrypted on this device so you can switch back.
          </Confirm>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" type="button" onClick={onTest} loading={busy === 'test'} disabled={!!busy || !url.trim()}>
              Test connection
            </Button>
            <Button size="sm" type="button" onClick={reset} disabled={!!busy || (unchanged && !result && !error)}>
              Cancel
            </Button>
            <Button size="sm" type="submit" variant="primary" loading={busy === 'save'} disabled={!!busy || unchanged || !url.trim()}>
              Save changes
            </Button>
          </div>
        )}
      </form>

      {/* Saved servers */}
      {others.length > 0 && (
        <section aria-label="Saved servers" className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Saved servers</h3>
          <ul className="flex flex-col gap-1.5">
            {others.map((p) => (
              <SavedServer key={p.id} profile={p} compact={!!sm} disabled={!!busy || !!pending} onSwitch={() => askSwitch(p)} onRename={(n) => props.rename(p.id, n)} onRemove={() => props.remove(p.id)} localDev={props.localDev} />
            ))}
          </ul>
        </section>
      )}

      {props.setLocalDev && (
        <Switch
          checked={props.localDev}
          disabled={!!busy}
          onChange={(v) => void props.setLocalDev!(v).catch((e: unknown) => setError(message(e)))}
          label="Local development servers"
          description="Allow plain http:// for servers on this computer (localhost only). Leave off unless you develop PassVault."
        />
      )}
    </div>
  );
}

function CheckBanner({ check, url, keepNote }: { check: ServerCheckView; url: string; keepNote?: string | undefined }) {
  if (check.ok) {
    return (
      <Banner tone={check.degraded ? 'warn' : 'ok'} icon={<CheckCircle2 className="size-4" />} title={check.title}>
        {check.detail}
        {check.registration === 'closed' && <span className="block">This server does not accept new accounts — sign in with an existing one.</span>}
        <span className="block font-mono text-xs">{url}</span>
      </Banner>
    );
  }
  return (
    <Banner tone="danger" icon={<XCircle className="size-4" />} title={check.title}>
      {check.detail}
      {keepNote && <span className="block">{keepNote}</span>}
    </Banner>
  );
}

function Confirm({ title, children, busy, onCancel, onConfirm }: { title: string; children: ReactNode; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div role="alertdialog" aria-label={title} className="flex flex-col gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3.5 py-3 text-sm">
      <div className="font-semibold text-fg">{title}</div>
      <p className="text-fg-muted">{children}</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" type="button" variant="primary" loading={busy} onClick={onConfirm} autoFocus>
          Lock and switch
        </Button>
      </div>
    </div>
  );
}

function SavedServer(props: { profile: ServerProfileView; compact: boolean; disabled: boolean; localDev: boolean; onSwitch: () => void; onRename: (name: string) => Promise<void>; onRemove: () => Promise<void> }) {
  const { profile: p } = props;
  const [mode, setMode] = useState<'view' | 'rename' | 'remove'>('view');
  const [name, setName] = useState(p.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = isLocal(p.url) && !props.localDev;

  const run = (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    f()
      .then(() => setMode('view'))
      .catch((e: unknown) => setError(message(e)))
      .finally(() => setBusy(false));
  };

  return (
    <li className="rounded-lg border border-border px-3 py-2 text-sm">
      {mode === 'rename' ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => props.onRename(name));
          }}
        >
          <Input aria-label={`Name for ${p.url}`} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus />
          <Button size="sm" type="submit" variant="primary" loading={busy}>
            Save
          </Button>
          <Button size="sm" type="button" onClick={() => setMode('view')} disabled={busy}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className={cx('flex gap-2', props.compact ? 'flex-col' : 'items-center')}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium">{p.name}</span>
              {p.lastCheck && <Badge tone={p.lastCheck.ok ? 'ok' : 'warn'} title={p.lastCheck.message}>{p.lastCheck.ok ? 'Reachable' : 'Unreachable'}</Badge>}
            </div>
            <div className="truncate font-mono text-xs text-fg-muted" title={p.url}>
              {p.url}
            </div>
            {p.account && <div className="truncate text-xs text-fg-subtle">{p.account}</div>}
          </div>
          {mode === 'view' && (
            <div className="flex shrink-0 items-center justify-end gap-1">
              <Button size="sm" variant="ghost" aria-label={`Rename ${p.name}`} onClick={() => setMode('rename')} disabled={props.disabled}>
                <Pencil className="size-3.5" aria-hidden />
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Remove ${p.name}`} onClick={() => setMode('remove')} disabled={props.disabled}>
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
              <Button size="sm" onClick={props.onSwitch} disabled={props.disabled || blocked} title={blocked ? 'Turn on local development servers to use this server' : undefined}>
                Switch
              </Button>
            </div>
          )}
        </div>
      )}
      {mode === 'remove' && (
        <div className="mt-2 flex flex-col gap-2 rounded-lg bg-danger-soft px-3 py-2">
          <p className="text-xs text-fg-muted">Forget this server? Its sign-in and encrypted copy on this device are deleted. Nothing on the server is changed.</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setMode('view')} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" loading={busy} onClick={() => run(props.onRemove)}>
              Remove
            </Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
}
