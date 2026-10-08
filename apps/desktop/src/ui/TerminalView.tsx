import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Plug, Plus, RefreshCw, ShieldAlert, SquareTerminal, Unplug, X } from 'lucide-react';
import { Badge, Button, Dialog, EmptyState, EnvBadge, Input, Kbd, Spinner, TypeIcon, cx } from '@passvault/ui';
import { useSnapshot } from '@passvault/app';
import type { TerminalTab } from '../desktop/controller';
import { isSshConnection, type SshConnectionItem } from '../ssh/hops';
import { useDesktop, useDesktopState } from './hooks';

const PHASE_LABEL: Record<TerminalTab['phase'], string> = {
  starting: 'Starting…',
  connecting: 'Connecting…',
  verifying_host: 'Verifying host key…',
  authenticating: 'Authenticating…',
  connected: 'Connected',
  closed: 'Closed',
  error: 'Error',
};

const ERROR_HELP: Record<string, string> = {
  host_key_mismatch: 'The server presented a different host key than the trusted one. The connection was stopped before any credentials were sent.',
  host_key_unknown: 'The host key was not trusted (cancelled or timed out), so PassVault did not connect.',
  auth_failed: 'The server rejected the credentials. Check the username, password or key in the server item.',
  connect_failed: 'The server could not be reached. Check the host, port, VPN and firewall.',
  io_error: 'The connection was lost (network error or the server stopped responding).',
  unavailable: 'The SSH agent has no keys loaded or the feature is unavailable.',
  bad_request: 'The connection settings or the SSH key could not be used (for example a wrong key passphrase).',
};

function statusDot(t: TerminalTab) {
  if (t.ended) return t.phase === 'error' ? 'bg-danger' : 'bg-fg-subtle';
  if (t.phase === 'connected') return 'bg-ok';
  return 'bg-warn animate-pulse';
}

export function TerminalView() {
  const { controller } = useDesktop();
  const tabs = useDesktopState((s) => s.tabs);
  const activeId = useDesktopState((s) => s.activeTabId);
  const [picker, setPicker] = useState(false);
  const active = tabs.find((t) => t.connId === activeId) ?? tabs[tabs.length - 1] ?? null;

  const onKeyDownCapture = (e: ReactKeyboardEvent) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 't') {
      e.preventDefault();
      e.stopPropagation();
      setPicker(true);
    } else if (k === 'w' && active) {
      e.preventDefault();
      e.stopPropagation();
      controller.closeTab(active.connId);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDownCapture={onKeyDownCapture}>
      <header className="flex items-center gap-3 border-b border-border px-4 h-14 shrink-0">
        <SquareTerminal className="size-5 text-fg-muted" aria-hidden />
        <h1 className="text-[15px] font-semibold tracking-tight">Terminal</h1>
        <span className="hidden text-xs text-fg-subtle md:inline">
          <Kbd>⌘T</Kbd> new tab · <Kbd>⌘W</Kbd> close tab
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setPicker(true)}>
          New connection
        </Button>
      </header>

      {tabs.length > 0 && (
        <div role="tablist" aria-label="Terminal sessions" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-bg-subtle px-2 pt-2 pv-scroll">
          {tabs.map((t) => {
            const selected = active?.connId === t.connId;
            return (
              <div
                key={t.connId}
                role="tab"
                aria-selected={selected}
                tabIndex={0}
                onClick={() => controller.setActiveTab(t.connId)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && controller.setActiveTab(t.connId)}
                className={cx(
                  'group relative flex min-w-44 max-w-72 cursor-pointer items-center gap-2 rounded-t-lg border border-b-0 px-3 py-1.5 text-left',
                  t.production ? 'border-t-2 border-t-prod' : 'border-t-2 border-t-transparent',
                  selected ? (t.production ? 'border-border bg-prod-soft' : 'border-border bg-surface') : t.production ? 'border-transparent bg-prod-soft/60 hover:bg-prod-soft' : 'border-transparent hover:bg-surface-3',
                )}
                title={`${t.title} — ${t.endpoint}${t.via ? ` via ${t.via}` : ''}`}
              >
                <span aria-hidden className={cx('size-2 shrink-0 rounded-full', statusDot(t))} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">{t.title}</span>
                    {t.production && (
                      <Badge tone="prod" className="h-4 px-1.5 text-[9.5px] tracking-wide">
                        PRODUCTION
                      </Badge>
                    )}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-fg-subtle">{t.endpoint}</span>
                </span>
                <button
                  type="button"
                  aria-label={`Close ${t.title}`}
                  className="rounded p-0.5 text-fg-subtle opacity-60 hover:bg-surface-3 hover:text-fg group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    controller.closeTab(t.connId);
                  }}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? <NoSessions onPick={() => setPicker(true)} /> : tabs.map((t) => <TerminalPane key={t.connId} tab={t} active={active?.connId === t.connId} />)}
      </div>

      <ConnectionPicker open={picker} onClose={() => setPicker(false)} />
    </div>
  );
}

function TerminalPane({ tab, active }: { tab: TerminalTab; active: boolean }) {
  const { controller, xterm } = useDesktop();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return xterm.attach(tab.connId, ref.current);
  }, [xterm, tab.connId]);
  useEffect(() => {
    if (active && !tab.ended) xterm.focus(tab.connId);
  }, [active, tab.ended, tab.connId, xterm]);
  const busy = !tab.ended && tab.phase !== 'connected';
  return (
    <section className={cx('absolute inset-0 flex flex-col', !active && 'hidden')} aria-label={`${tab.title} terminal`}>
      <div className={cx('flex shrink-0 items-center gap-2 border-b px-4 h-10 text-xs', tab.production ? 'border-prod/40 bg-prod-soft' : 'border-border bg-surface')}>
        {tab.production && <ShieldAlert className="size-3.5 text-prod" aria-hidden />}
        <span className="font-mono text-fg">{tab.endpoint}</span>
        {tab.via && <span className="text-fg-subtle">via {tab.via}</span>}
        <EnvBadge env={tab.environment} />
        <span className={cx('ml-1', tab.phase === 'error' ? 'text-danger' : 'text-fg-muted')}>
          {busy && <Spinner className="mr-1 align-middle" label={PHASE_LABEL[tab.phase]} />}
          {PHASE_LABEL[tab.phase]}
          {tab.phase === 'error' && tab.error?.code ? ` · ${tab.error.code}` : ''}
        </span>
        <div className="flex-1" />
        {tab.ended ? (
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => void controller.reconnect(tab.connId)}>
            Reconnect
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon={<Unplug className="size-3.5" />} onClick={() => controller.disconnect(tab.connId)}>
            Disconnect
          </Button>
        )}
      </div>
      <div className="relative min-h-0 flex-1 bg-[#0c1117] p-2">
        <div ref={ref} className="h-full w-full" />
        {tab.ended && <EndedOverlay tab={tab} />}
      </div>
    </section>
  );
}

function EndedOverlay({ tab }: { tab: TerminalTab }) {
  const { controller } = useDesktop();
  const code = tab.error?.code;
  const help = code ? ERROR_HELP[code] : undefined;
  return (
    <div className="absolute inset-x-0 bottom-0 m-3 rounded-xl border border-border bg-surface/95 px-4 py-3 text-sm shadow-[var(--shadow-pop)] backdrop-blur">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className={cx('font-semibold', tab.phase === 'error' ? 'text-danger' : 'text-fg')}>
            {tab.endReason ?? (tab.phase === 'error' ? `Connection failed${code ? ` (${code})` : ''}` : 'Session closed')}
          </div>
          {tab.error?.message && <div className="mt-0.5 break-words text-fg-muted">{tab.error.message}</div>}
          {help && <div className="mt-0.5 text-fg-muted">{help}</div>}
          {tab.exit && (
            <div className="mt-0.5 text-xs text-fg-subtle">
              Remote shell exited{tab.exit.status !== undefined ? ` with status ${tab.exit.status}` : ''}
              {tab.exit.signal ? ` (signal ${tab.exit.signal})` : ''}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {code === 'host_key_mismatch' && (
            <Button size="sm" onClick={() => controller.openItem(tab.itemId)}>
              Open server settings
            </Button>
          )}
          <Button size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />} onClick={() => void controller.reconnect(tab.connId)}>
            Reconnect
          </Button>
          <Button size="sm" onClick={() => controller.closeTab(tab.connId)}>
            Close tab
          </Button>
        </div>
      </div>
    </div>
  );
}

function useServers(): SshConnectionItem[] {
  const snap = useSnapshot();
  return useMemo(
    () =>
      snap.items
        .filter((i): i is SshConnectionItem => isSshConnection(i) && !i.payload.trashedAt && !i.payload.archived)
        .sort((a, b) => a.payload.title.localeCompare(b.payload.title)),
    [snap.items],
  );
}

function NoSessions({ onPick }: { onPick: () => void }) {
  const servers = useServers();
  const { controller } = useDesktop();
  return (
    <div className="h-full overflow-y-auto pv-scroll">
      <EmptyState
        icon={<SquareTerminal className="size-10" />}
        title="No open sessions"
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={onPick}>
            New connection
          </Button>
        }
      >
        Connect to a saved server. PassVault verifies the server’s host key, authenticates with the stored credentials and opens a remote shell here. Nothing runs on this Mac and saved commands are never executed automatically.
      </EmptyState>
      {servers.length > 0 && (
        <ul className="mx-auto mb-10 max-w-xl divide-y divide-border rounded-xl border border-border bg-surface shadow-[var(--shadow-card)]">
          {servers.slice(0, 8).map((s) => (
            <ServerRow key={s.id} item={s} onConnect={() => void controller.connect(s.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ServerRow({ item, onConnect, highlighted }: { item: SshConnectionItem; onConnect: () => void; highlighted?: boolean }) {
  const f = item.payload.fields;
  return (
    <li>
      <button type="button" onClick={onConnect} className={cx('flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-3', highlighted && 'bg-surface-3')}>
        <TypeIcon type="ssh_connection" size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.payload.title}</span>
          <span className="block truncate font-mono text-xs text-fg-subtle">
            {f.username}@{f.host}:{f.port}
          </span>
        </span>
        <EnvBadge env={item.payload.environment} />
        <Plug className="size-4 text-fg-subtle" aria-hidden />
      </button>
    </li>
  );
}

function ConnectionPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const servers = useServers();
  const { controller } = useDesktop();
  const [q, setQ] = useState('');
  useEffect(() => {
    if (open) setQ('');
  }, [open]);
  const list = servers.filter((s) => {
    const t = q.trim().toLowerCase();
    if (!t) return true;
    const f = s.payload.fields;
    return `${s.payload.title} ${f.username}@${f.host} ${s.payload.environment ?? ''} ${s.payload.tags.join(' ')}`.toLowerCase().includes(t);
  });
  const connect = (id: string) => {
    onClose();
    void controller.connect(id);
  };
  return (
    <Dialog open={open} onClose={onClose} title="New terminal connection" size="md">
      <Input
        data-autofocus
        placeholder="Search servers…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && list[0]) connect(list[0].id);
        }}
        aria-label="Search servers"
      />
      {list.length === 0 ? (
        <p className="py-6 text-center text-sm text-fg-muted">{servers.length ? 'No matching servers.' : 'No servers yet. Add a “Server” item first.'}</p>
      ) : (
        <ul className="mt-3 max-h-80 divide-y divide-border overflow-y-auto rounded-xl border border-border pv-scroll">
          {list.map((s, i) => (
            <ServerRow key={s.id} item={s} highlighted={i === 0 && !!q} onConnect={() => connect(s.id)} />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Sidebar badge: number of live sessions. */
export function TerminalBadge() {
  const n = useDesktopState((s) => s.tabs).filter((t) => !t.ended).length;
  if (!n) return null;
  return <span className="min-w-6 rounded-full bg-accent-soft px-1.5 text-center text-[11px] font-medium tabular-nums text-accent" title={`${n} open terminal session(s)`}>{n}</span>;
}
