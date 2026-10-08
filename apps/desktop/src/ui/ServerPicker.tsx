import { useState, useSyncExternalStore } from 'react';
import { Laptop, Server } from 'lucide-react';
import { useSnapshot } from '@passvault/app';
import { Button, Dialog, ServerConnection, type ServerConnectionProps } from '@passvault/ui';
import { describeCheck, isLoopbackServer } from '@passvault/vault-core';
import type { DesktopServers } from '../platform/servers';

function useServers(servers: DesktopServers) {
  useSyncExternalStore(
    (cb) => servers.subscribe(cb),
    () => servers.profiles,
  );
  return servers;
}

function useStatus(): ServerConnectionProps['status'] {
  const s = useSnapshot();
  switch (s.auth.phase) {
    case 'signed_out':
      return { label: 'Signed out', tone: 'neutral' };
    case 'locked':
      return { label: 'Locked', tone: 'neutral' };
    case 'unlocked':
      if (!s.online) return { label: 'Offline', tone: 'warn' };
      if (s.sync.lastError) return { label: 'Connection error', tone: 'danger' };
      if (s.sync.state === 'syncing') return { label: 'Syncing', tone: 'neutral' };
      return { label: 'Ready', tone: 'ok' };
    default:
      return { label: 'Signing in', tone: 'neutral' };
  }
}

function useConnectionProps(servers: DesktopServers): ServerConnectionProps {
  const s = useServers(servers);
  const snap = useSnapshot();
  return {
    profiles: s.profiles,
    localDev: s.localDev,
    unlocked: snap.auth.phase === 'unlocked',
    status: useStatus(),
    normalize: (url) => s.normalize(url),
    test: async (url) => describeCheck(await s.check(url)),
    save: async (url) => void (await s.connect(url)),
    switchTo: async (id) => void (await s.switchTo(id)),
    rename: (id, name) => s.rename(id, name),
    remove: (id) => s.remove(id),
    setLocalDev: (on) => s.setLocalDev(on),
  };
}

/** Settings → Server connection. */
export function ServerSettings({ servers }: { servers: DesktopServers }) {
  const props = useConnectionProps(servers);
  return (
    <section className="rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]" aria-labelledby="server-connection-h">
      <h2 id="server-connection-h" className="text-sm font-semibold">
        Server connection
      </h2>
      <p className="mt-1 mb-4 text-sm text-fg-muted">
        PassVault encrypts everything on this Mac before it is sent, whichever server you use. Each server has its own sign-in, keys and encrypted cache here; changing the server locks the vault and never copies data between servers.
      </p>
      <ServerConnection key={servers.activeUrl} {...props} />
    </section>
  );
}

/** Compact "Server: …  Change" row for the sign-in and lock screens. */
export function ServerPickerRow({ servers }: { servers: DesktopServers }) {
  const [open, setOpen] = useState(false);
  const props = useConnectionProps(servers);
  const current = props.profiles.find((p) => p.active);
  const Icon = isLoopbackServer(servers.activeUrl) ? Laptop : Server;
  return (
    <>
      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-sm">
        <Icon className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-fg-subtle">Server · {current?.name ?? 'PassVault'}</span>
          <span className="block truncate font-medium" title={servers.activeUrl}>
            {servers.activeUrl}
          </span>
        </span>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Change
        </Button>
      </div>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title="Server connection" description="Connect to a PassVault server. Nothing is sent until the server passes the compatibility check.">
          <ServerConnection key={servers.activeUrl} {...props} />
        </Dialog>
      )}
    </>
  );
}
