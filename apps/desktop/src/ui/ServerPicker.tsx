import { useState } from 'react';
import { Check, Globe, Laptop, Server } from 'lucide-react';
import { Banner, Button, Dialog, cx, useConfirm } from '@passvault/ui';
import { InvalidServerUrlError, SERVER_PRESETS, describeServer, normalizeServerUrl, probeServer, type ServerOption } from '../platform/servers';

const ICON: Record<ServerOption['id'], typeof Globe> = { production: Globe, local: Laptop };

export interface ServerPickerProps {
  current: string;
  /** whether a vault is currently unlocked (switching will lock it) */
  isUnlocked: () => boolean;
  onSwitch: (url: string) => Promise<void>;
}

/** Compact "Server: …  Change" row for the sign-in and lock screens. */
export function ServerPickerRow(props: ServerPickerProps) {
  const [open, setOpen] = useState(false);
  const s = describeServer(props.current);
  const I = ICON[s.id];
  return (
    <>
      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm">
        <I className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-fg-subtle">Server · {s.id === 'production' ? 'Production' : 'Local development'}</span>
          <span className="block truncate font-medium" title={s.url}>{s.description}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Change
        </Button>
      </div>
      {open && <ServerDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Settings → Server section. */
export function ServerSettings(props: ServerPickerProps) {
  const [open, setOpen] = useState(false);
  const s = describeServer(props.current);
  return (
    <section className="rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
      <h2 className="text-sm font-semibold">Server</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Connected to <strong className="text-fg">{s.url}</strong>. Each server has its own sign-in, keys and encrypted cache on this Mac; switching never mixes them.
      </p>
      <Button className="mt-3" icon={<Server className="size-4" />} onClick={() => setOpen(true)}>
        Switch server…
      </Button>
      {open && <ServerDialog {...props} onClose={() => setOpen(false)} />}
    </section>
  );
}

function ServerDialog({ current, isUnlocked, onSwitch, onClose }: ServerPickerProps & { onClose: () => void }) {
  const confirm = useConfirm();
  const cur = describeServer(current);
  const [choice, setChoice] = useState<ServerOption['id']>(cur.id);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  const target = (): string => SERVER_PRESETS.find((p) => p.id === choice)!.url;

  const test = async () => {
    setStatus(null);
    try {
      const r = await probeServer(target());
      setStatus(r.ok ? { tone: 'ok', text: `Reachable — PassVault server ${r.version}` } : { tone: 'danger', text: r.message });
      return r.ok;
    } catch (e) {
      setStatus({ tone: 'danger', text: e instanceof InvalidServerUrlError ? e.message : String(e) });
      return false;
    }
  };

  const apply = async () => {
    let url: string;
    try {
      url = target();
    } catch (e) {
      setStatus({ tone: 'danger', text: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (url === normalizeServerUrl(current)) return onClose();
    setBusy(true);
    try {
      const reachable = await test();
      if (!reachable) {
        const go = await confirm({ title: 'Server not reachable', body: 'Switch anyway? You can still unlock data cached from this server while offline.', confirmLabel: 'Switch anyway', tone: 'primary' });
        if (!go) return;
      }
      if (isUnlocked()) {
        const go = await confirm({
          title: 'Lock and switch server?',
          body: 'Your vault will be locked and terminal sessions closed. Data from the current server stays encrypted on this Mac and is available again when you switch back.',
          confirmLabel: 'Lock and switch',
          tone: 'primary',
        });
        if (!go) return;
      }
      await onSwitch(url);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const options: ServerOption[] = SERVER_PRESETS;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Choose a server"
      description="PassVault encrypts everything on this Mac before it is sent, whichever server you use."
      footer={
        <>
          <Button onClick={() => void test()} disabled={busy}>
            Test connection
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void apply()}>
            Use this server
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="Server" className="space-y-2">
        {options.map((o) => {
          const I = ICON[o.id];
          const selected = choice === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setChoice(o.id);
                setStatus(null);
              }}
              className={cx(
                'flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors',
                selected ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2',
              )}
            >
              <I className={cx('size-5 shrink-0', selected ? 'text-accent' : 'text-fg-subtle')} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{o.label}</span>
                <span className="block truncate text-xs text-fg-subtle">{o.description}</span>
              </span>
              {selected && <Check className="size-4 text-accent" aria-hidden />}
            </button>
          );
        })}
      </div>
      {status && (
        <div className="mt-3">
          <Banner tone={status.tone}>{status.text}</Banner>
        </div>
      )}
      <p className="mt-3 text-xs text-fg-subtle">The server must list this app’s origin (http://localhost:47391) in its CORS_ORIGINS setting.</p>
    </Dialog>
  );
}
