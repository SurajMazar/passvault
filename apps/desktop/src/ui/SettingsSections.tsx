import { useEffect, useMemo, useState } from 'react';
import { Copy, KeyRound, Play, RefreshCw, Square } from 'lucide-react';
import { Badge, Banner, Button, Card, EmptyState, TypeIcon, useToast } from '@passvault/ui';
import { errorMessage, useCopy, useSnapshot } from '@passvault/app';
import { describeHelperError } from '../ipc/helper-client';
import { isSshKey, type SshKeyItem } from '../ssh/hops';
import { useDesktop, useDesktopState } from './hooks';

/** `export SSH_AUTH_SOCK='…'` with POSIX single-quote escaping (the path contains a space). */
export function exportCommand(socketPath: string): string {
  return `export SSH_AUTH_SOCK='${socketPath.replace(/'/g, `'\\''`)}'`;
}

export function AgentSettings() {
  const { controller } = useDesktop();
  const agent = useDesktopState((s) => s.agent);
  const helper = useDesktopState((s) => s.helper);
  const snap = useSnapshot();
  const copy = useCopy();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void controller.refreshAgent();
  }, [controller]);
  const keyItems = useMemo(() => snap.items.filter((i): i is SshKeyItem => isSshKey(i) && !!i.payload.fields.privateKey && !i.payload.trashedAt), [snap.items]);
  const loaded = agent?.keys ?? [];
  const run = async (id: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(id);
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (e) {
      toast(describeHelperError(e) || errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  if (helper.state !== 'ready') {
    return (
      <Card title="SSH agent">
        <Banner tone="warn">The desktop helper is not running, so the SSH agent is unavailable.</Banner>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <Card
        title="SSH agent"
        actions={
          agent?.running ? (
            <Button size="sm" icon={<Square className="size-3.5" />} loading={busy === 'stop'} onClick={() => void run('stop', () => controller.stopAgent(), 'SSH agent stopped')}>
              Stop agent
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} loading={busy === 'start'} onClick={() => void run('start', () => controller.startAgent(), 'SSH agent started')}>
              Start agent
            </Button>
          )
        }
      >
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {agent?.running ? <Badge tone="ok">Running</Badge> : <Badge>Stopped</Badge>}
            {agent?.running && (agent.locked ? <Badge tone="warn">Locked — no keys</Badge> : <Badge tone="accent">{loaded.length} key(s) loaded</Badge>)}
          </div>
          {agent?.socketPath && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-fg-muted">Socket</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[12px]">{exportCommand(agent.socketPath)}</code>
                <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => void copy(exportCommand(agent.socketPath), false)}>
                  Copy
                </Button>
              </div>
              <p className="text-xs text-fg-subtle">Run this in a shell (or add it to your shell profile) so ssh, git and other tools use the PassVault agent.</p>
            </div>
          )}
          <ul className="list-disc space-y-1 pl-5 text-fg-muted">
            <li>Keys are held only in the helper’s memory and only while the vault is unlocked. Locking the vault removes them.</li>
            <li>Every signature asks for your approval (you can allow a key for 5 or 15 minutes).</li>
            <li>Agent forwarding is refused: requests that arrive through a forwarded agent are denied without asking.</li>
            <li>The agent cannot reliably tell which server a signature is for. It shows a verified host-key fingerprint only when OpenSSH sends a verifiable session binding; the requesting process name comes from macOS and is not authenticated.</li>
            <li>Locking the vault or removing a key does not end SSH sessions that already authenticated.</li>
          </ul>
        </div>
      </Card>

      <Card title="Keys">
        {keyItems.length === 0 ? (
          <EmptyState icon={<KeyRound className="size-8" />} title="No SSH keys in your vault">
            Add an “SSH key” item with a private key to use it with the agent.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {keyItems.map((k) => {
              const inAgent = loaded.find((l) => l.keyId === k.id);
              return (
                <li key={k.id} className="flex items-center gap-3 py-2.5">
                  <TypeIcon type="ssh_key" size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{k.payload.title}</div>
                    <div className="truncate font-mono text-xs text-fg-subtle">{inAgent?.fingerprint ?? k.payload.fields.fingerprint}</div>
                  </div>
                  {inAgent ? (
                    <Button size="sm" loading={busy === k.id} onClick={() => void run(k.id, () => controller.removeKeyFromAgent(k.id), 'Removed from the SSH agent')}>
                      Remove from agent
                    </Button>
                  ) : (
                    <Button size="sm" variant="primary" loading={busy === k.id} onClick={() => void run(k.id, () => controller.addKeyToAgent(k.id))}>
                      Add to agent
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {loaded.filter((l) => !keyItems.some((k) => k.id === l.keyId)).length > 0 && (
          <p className="mt-3 text-xs text-fg-subtle">Some loaded keys are no longer in your vault view; stop the agent or lock the vault to remove them.</p>
        )}
      </Card>
    </div>
  );
}

function Cap({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div>
        <div className="text-sm">{label}</div>
        {detail && <div className="text-xs text-fg-subtle">{detail}</div>}
      </div>
      {ok ? <Badge tone="ok">Available</Badge> : <Badge tone="warn">Unavailable</Badge>}
    </div>
  );
}

export function HelperSettings() {
  const { connection, versions } = useDesktop();
  const helper = useDesktopState((s) => s.helper);
  const [busy, setBusy] = useState(false);
  const caps = helper.hello?.capabilities;
  return (
    <div className="space-y-4">
      <Card
        title="Desktop helper"
        actions={
          <Button
            size="sm"
            icon={<RefreshCw className="size-3.5" />}
            loading={busy}
            onClick={() => {
              setBusy(true);
              void connection.retry().finally(() => setBusy(false));
            }}
          >
            Reconnect
          </Button>
        }
      >
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            {helper.state === 'ready' ? <Badge tone="ok">Connected</Badge> : helper.state === 'starting' ? <Badge>Starting</Badge> : <Badge tone="danger">Not running</Badge>}
            {helper.reason && helper.state !== 'ready' && <span className="text-fg-muted">{helper.reason}</span>}
          </div>
          <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-[13px]">
            <dt className="text-fg-subtle">PassVault</dt>
            <dd className="font-mono">{versions.app}</dd>
            <dt className="text-fg-subtle">Helper (pv-helper)</dt>
            <dd className="font-mono">{helper.hello?.helperVersion ?? '—'}</dd>
            <dt className="text-fg-subtle">Neutralinojs</dt>
            <dd className="font-mono">
              {versions.neutralino} (client {versions.client})
            </dd>
          </dl>
          {caps && (
            <div className="divide-y divide-border border-t border-border">
              <Cap label="Keychain (session token)" ok={caps.keychain} />
              <Cap label="Touch ID unlock" ok={caps.biometrics.available} detail={caps.biometrics.available ? undefined : caps.biometrics.reason} />
              <Cap label="SSH agent" ok={caps.agent} />
              <Cap label="Terminal (SSH sessions, Terminal.app / iTerm)" ok={caps.terminal} />
              <Cap label="Lock on screen lock and sleep" ok={caps.systemEvents} />
            </div>
          )}
          <p className="text-xs text-fg-subtle">
            Locking the vault disconnects sessions opened in PassVault’s terminal and empties the SSH agent. Sessions opened in Terminal.app or iTerm are separate processes and keep running.
          </p>
        </div>
      </Card>
    </div>
  );
}
