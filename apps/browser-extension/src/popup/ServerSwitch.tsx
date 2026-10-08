import { useState } from 'react';
import { Laptop, Server } from 'lucide-react';
import { Button, ServerConnection, type ServerCheckView, type ServerConnectionProps } from '@passvault/ui';
import { describeCheck, isLoopbackServer, normalizeServerUrl, serverOrigin } from '@passvault/vault-core/servers';
import type { PopupState, ServerInfo } from '../shared/protocol';
import { call } from './rpc';

/** Chrome host access for a server; must start inside the click handler (user gesture). */
const requestAccess = (base: string) => chrome.permissions.request({ origins: [`${serverOrigin(base)}/*`] });

function connectionStatus(state: PopupState): ServerConnectionProps['status'] {
  if (state.phase === 'signed_out') return { label: 'Signed out', tone: 'neutral' };
  if (state.phase === 'locked') return { label: 'Locked', tone: 'neutral' };
  if (state.phase !== 'unlocked') return { label: 'Signing in', tone: 'neutral' };
  if (!state.online) return { label: 'Offline', tone: 'warn' };
  if (state.sync.lastError) return { label: 'Connection error', tone: 'danger' };
  if (state.sync.state === 'syncing') return { label: 'Syncing', tone: 'neutral' };
  return { label: 'Ready', tone: 'ok' };
}

/** Props for the shared Server connection panel, backed by the background's ServerManager (no React hooks). */
function serverProps(server: ServerInfo, state: PopupState): ServerConnectionProps {
  const normalize = (url: string) => normalizeServerUrl(url, { allowLocalHttp: server.localDev });
  return {
    profiles: server.profiles,
    localDev: server.localDev,
    unlocked: state.phase === 'unlocked',
    status: connectionStatus(state),
    normalize,
    test: (url) => {
      const base = normalize(url);
      return requestAccess(base).then(async (granted): Promise<ServerCheckView> => {
        if (!granted) return { ok: false, title: 'Permission needed', detail: `Chrome did not allow PassVault to connect to ${new URL(base).host}. Nothing was sent.` };
        return describeCheck(await call({ type: 'server.check', url: base }));
      });
    },
    save: async (url) => {
      await call({ type: 'server.set', url: normalize(url) });
    },
    switchTo: (id) => {
      const p = server.profiles.find((x) => x.id === id);
      const access = p ? requestAccess(p.url) : Promise.resolve(false);
      return access.then(async (granted) => {
        if (!granted) throw new Error('Chrome did not allow PassVault to connect to that server.');
        await call({ type: 'server.switch', id });
      });
    },
    rename: async (id, name) => {
      await call({ type: 'server.rename', id, name });
    },
    remove: async (id) => {
      await call({ type: 'server.remove', id });
    },
    setLocalDev: async (on) => {
      await call({ type: 'server.localDev', on });
    },
    compact: true,
  };
}

/** Settings → Server connection. */
export function ServerSettings({ state }: { state: PopupState }) {
  if (!state.server) return null;
  return (
    <section className="flex flex-col gap-3 px-4 py-4" aria-labelledby="server-connection-h">
      <div>
        <h2 id="server-connection-h" className="text-sm font-semibold">
          Server connection
        </h2>
        <p className="mt-0.5 text-xs text-fg-muted">Each server keeps its own sign-in and encrypted data in this browser. Changing the server locks the vault.</p>
      </div>
      <ServerConnection key={state.server.url} {...serverProps(state.server, state)} />
    </section>
  );
}

/** "Server · host  Change" row for the sign-in and lock screens; expands into the same panel. */
export function ServerSwitch({ state }: { state: PopupState }) {
  const [open, setOpen] = useState(false);
  const server = state.server!;
  const props = serverProps(server, state);
  const current = server.profiles.find((p) => p.active);
  const Icon = isLoopbackServer(server.url) ? Laptop : Server;
  if (open) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
        <ServerConnection {...props} />
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
      <Icon className="size-4 shrink-0 text-fg-subtle" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-fg-subtle">Server · {current?.name ?? 'PassVault'}</span>
        <span className="block truncate font-medium text-fg" title={server.url}>
          {server.url}
        </span>
      </span>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Change
      </Button>
    </div>
  );
}
