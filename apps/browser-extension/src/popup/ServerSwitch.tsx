import { useState, type FormEvent } from 'react';
import { Globe, Laptop, Server } from 'lucide-react';
import { Banner, Button, Field, Input, cx } from '@passvault/ui';
import { isLoopbackServer, normalizeServerUrl } from '@passvault/vault-core/servers';
import type { ServerInfo } from '../shared/protocol';
import { RpcError, call, errorText } from './rpc';

function describe(server: ServerInfo) {
  const preset = server.presets.find((p) => p.url === server.url);
  const kind = preset?.label ?? (isLoopbackServer(server.url) ? 'Local server' : 'Self-hosted server');
  return { kind, host: new URL(server.url).host, Icon: isLoopbackServer(server.url) ? Laptop : preset ? Globe : Server };
}

/**
 * "Server · host  Change" row for the sign-in and lock screens. The address is
 * editable; the built-in servers are one-click shortcuts. Host access for the
 * chosen server is requested from Chrome (it shows its own permission prompt).
 */
export function ServerSwitch({ server }: { server: ServerInfo }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(server.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const d = describe(server);

  const connect = (force: boolean) => {
    setError(null);
    setUnreachable(false);
    let origin: string;
    try {
      origin = normalizeServerUrl(url);
    } catch (e) {
      setError(errorText(e));
      return;
    }
    if (origin === server.url) {
      setOpen(false);
      return;
    }
    setBusy(true);
    // Must run directly in the click handler: Chrome only shows permission prompts for a user gesture.
    void chrome.permissions
      .request({ origins: [`${origin}/*`] })
      .then(async (granted) => {
        if (!granted) throw new Error(`PassVault needs permission to connect to ${new URL(origin).host}.`);
        await call({ type: 'server.set', url: origin, force });
        setOpen(false);
      })
      .catch((e) => {
        setError(errorText(e));
        setUnreachable(e instanceof RpcError && e.code === 'network');
      })
      .finally(() => setBusy(false));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect(false);
  };

  if (!open) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
        <d.Icon className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-fg-subtle">Server · {d.kind}</span>
          <span className="block truncate font-medium text-fg" title={server.url}>
            {d.host}
          </span>
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setUrl(server.url);
            setOpen(true);
          }}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-3" aria-label="Choose a server">
      <Field label="Server address" hint="https://, or http://localhost for local development">
        {(id, describedBy) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
              setUnreachable(false);
            }}
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="https://vault.example.com"
            autoFocus
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Built-in servers">
        {server.presets.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              setUrl(p.url);
              setError(null);
              setUnreachable(false);
            }}
            className={cx(
              'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
              url.trim() === p.url ? 'border-accent bg-accent-soft text-fg' : 'border-border text-fg-muted hover:bg-surface-2',
            )}
          >
            {p.label} · {new URL(p.url).host}
          </button>
        ))}
      </div>
      {error && <Banner tone={unreachable ? 'warn' : 'danger'}>{error}</Banner>}
      <p className="text-[11px] text-fg-subtle">Each server keeps its own sign-in and encrypted data in this browser. Switching locks the vault.</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
        {unreachable ? (
          <Button size="sm" type="button" variant="primary" loading={busy} onClick={() => connect(true)}>
            Switch anyway
          </Button>
        ) : (
          <Button size="sm" type="submit" variant="primary" loading={busy} disabled={!url.trim()}>
            Connect
          </Button>
        )}
      </div>
    </form>
  );
}
