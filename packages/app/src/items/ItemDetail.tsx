import type { ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Copy,
  Download,
  ExternalLink,
  History,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Share2,
  ShieldAlert,
  Star,
  Trash2,
  Users,
  AlertTriangle,
} from 'lucide-react';
import { ITEM_TYPE_LABELS, URL_MATCH_LABELS, isProductionEnvironment, type ItemPayload } from '@passvault/types';
import { Badge, Banner, Button, Card, EnvBadge, FieldRow, IconButton, Menu, TypeIcon, cx, useConfirm, useToast } from '@passvault/ui';
import { safeHost, type DecryptedItem } from '@passvault/vault-core';
import { useApp, useSnapshot, useUi, errorMessage } from '../state';
import { EnvFileView } from '../env/EnvFileView';

export function useCopy() {
  const { session } = useApp();
  const snap = useSnapshot();
  const toast = useToast();
  return async (value: string, secret = true) => {
    try {
      if (secret) await session.platformRef.clipboard.copySecret(value, snap.settings.clipboardClearSeconds);
      else await session.platformRef.clipboard.copyText(value);
      toast(secret && snap.settings.clipboardClearSeconds ? `Copied — clipboard clears in ${snap.settings.clipboardClearSeconds}s` : 'Copied', 'success');
    } catch (e) {
      toast(`Copy failed: ${errorMessage(e)}`, 'error');
    }
  };
}

function Fields({ item }: { item: DecryptedItem }) {
  const copy = useCopy();
  const snap = useSnapshot();
  const ui = useUi();
  const p = item.payload;
  const ref = (id: string | undefined) => {
    if (!id) return null;
    const t = snap.items.find((i) => i.id === id);
    return t ? (
      <button className="text-accent hover:underline" onClick={() => ui.go(t.payload.type, { selectedId: t.id })}>
        {t.payload.title}
      </button>
    ) : (
      <span className="text-fg-subtle">Missing or not shared with you</span>
    );
  };
  const rows: ReactNode[] = [];
  switch (p.type) {
    case 'login':
      rows.push(
        <FieldRow key="u" label="Username" value={p.fields.username} onCopy={(v) => copy(v, false)} />,
        <FieldRow key="p" label="Password" value={p.fields.password} secret onCopy={(v) => copy(v)} />,
        ...p.fields.urls.map((u, i) => (
          <FieldRow
            key={`url${i}`}
            label={i === 0 ? 'Website' : `Website ${i + 1}`}
            value={u.url}
            onCopy={(v) => copy(v, false)}
            extra={
              <div className="mt-0.5 text-xs text-fg-subtle">
                Match: {URL_MATCH_LABELS[u.match]}
                {/^http:\/\//i.test(u.url) && <span className="ml-2 text-warn">Not HTTPS</span>}
              </div>
            }
          />
        )),
      );
      if (p.fields.passwordUpdatedAt) rows.push(<FieldRow key="pu" label="Password changed" value={new Date(p.fields.passwordUpdatedAt).toLocaleDateString()} />);
      break;
    case 'ssh_connection':
      rows.push(
        <FieldRow key="h" label="Host" value={p.fields.host} mono onCopy={(v) => copy(v, false)} />,
        <FieldRow key="po" label="Port" value={String(p.fields.port)} mono />,
        <FieldRow key="u" label="Username" value={p.fields.username} mono onCopy={(v) => copy(v, false)} />,
        <FieldRow key="a" label="Authentication" value={{ password: 'Password', key: 'SSH key', agent: 'SSH agent', keyboard_interactive: 'Interactive prompts' }[p.fields.authMethod]} />,
        <FieldRow key="pw" label="Password" value={p.fields.password} secret onCopy={(v) => copy(v)} />,
        <FieldRow key="k" label="SSH key" value={p.fields.sshKeyItemId ? ' ' : ''} extra={ref(p.fields.sshKeyItemId)} />,
        <FieldRow key="j" label="Jump host" value={p.fields.jumpHostItemId ? ' ' : ''} extra={ref(p.fields.jumpHostItemId)} />,
        <FieldRow key="cmd" label="SSH command" value={`ssh ${p.fields.port !== 22 ? `-p ${p.fields.port} ` : ''}${p.fields.username}@${p.fields.host}`} mono onCopy={(v) => copy(v, false)} />,
      );
      break;
    case 'ssh_key':
      rows.push(
        <FieldRow key="alg" label="Algorithm" value={p.fields.algorithm} />,
        <FieldRow key="fp" label="Fingerprint" value={p.fields.fingerprint} mono onCopy={(v) => copy(v, false)} />,
        <FieldRow key="pub" label="Public key" value={p.fields.publicKey} mono onCopy={(v) => copy(v, false)} />,
        <FieldRow key="priv" label="Private key" value={p.fields.privateKey} secret multiline onCopy={(v) => copy(v)} />,
        <FieldRow key="pass" label="Passphrase" value={p.fields.passphrase} secret onCopy={(v) => copy(v)} />,
        <FieldRow key="c" label="Comment" value={p.fields.comment} />,
      );
      break;
    case 'database':
      rows.push(
        <FieldRow key="e" label="Engine" value={p.fields.engine} />,
        <FieldRow key="h" label="Host" value={p.fields.host} mono onCopy={(v) => copy(v, false)} />,
        <FieldRow key="po" label="Port" value={p.fields.port ? String(p.fields.port) : ''} mono />,
        <FieldRow key="d" label="Database" value={p.fields.database} mono onCopy={(v) => copy(v, false)} />,
        <FieldRow key="u" label="Username" value={p.fields.username} mono onCopy={(v) => copy(v, false)} />,
        <FieldRow key="p" label="Password" value={p.fields.password} secret onCopy={(v) => copy(v)} />,
        <FieldRow key="t" label="TLS" value={p.fields.tlsMode} extra={p.fields.tlsMode === 'disable' ? <span className="ml-2 text-xs text-warn">Unencrypted connection</span> : null} />,
        <FieldRow key="ca" label="CA certificate" value={p.fields.caCertificate} mono multiline />,
        <FieldRow key="cs" label="Connection string" value={p.fields.connectionString} secret onCopy={(v) => copy(v)} />,
      );
      break;
    case 'api_credential': {
      const exp = p.fields.expiresAt ? Date.parse(`${p.fields.expiresAt}T00:00:00Z`) : null;
      rows.push(
        <FieldRow key="s" label="Service" value={p.fields.service} />,
        <FieldRow key="e" label="Endpoint" value={p.fields.endpoint} mono onCopy={(v) => copy(v, false)} />,
        <FieldRow key="t" label="Token" value={p.fields.token} secret onCopy={(v) => copy(v)} />,
        <FieldRow key="k" label="API key" value={p.fields.apiKey} secret onCopy={(v) => copy(v)} />,
        <FieldRow key="ci" label="Client ID" value={p.fields.clientId} mono onCopy={(v) => copy(v, false)} />,
        <FieldRow key="cs" label="Client secret" value={p.fields.clientSecret} secret onCopy={(v) => copy(v)} />,
        <FieldRow key="u" label="Username" value={p.fields.username} onCopy={(v) => copy(v, false)} />,
        <FieldRow key="p" label="Password" value={p.fields.password} secret onCopy={(v) => copy(v)} />,
        <FieldRow
          key="x"
          label="Expires"
          value={p.fields.expiresAt}
          extra={exp !== null ? exp < Date.now() ? <Badge tone="danger" className="ml-2">Expired</Badge> : exp - Date.now() < 30 * 86400_000 ? <Badge tone="warn" className="ml-2">Expires soon</Badge> : null : null}
        />,
      );
      break;
    }
    case 'secure_note':
      rows.push(<FieldRow key="n" label="Note" value={p.fields.content} secret multiline onCopy={(v) => copy(v)} />);
      break;
    case 'env_file':
      break;
  }
  for (const cf of p.customFields) {
    rows.push(<FieldRow key={cf.id} label={cf.label || 'Field'} value={cf.type === 'boolean' ? (cf.value === 'true' ? 'Yes' : 'No') : cf.value} secret={cf.type === 'secret'} multiline={cf.type === 'multiline'} mono={cf.type === 'secret'} onCopy={(v) => copy(v, cf.type === 'secret')} />);
  }
  return <div>{rows}</div>;
}

export function ItemDetail({ item, onClose }: { item: DecryptedItem; onClose: () => void }) {
  const { session, ext } = useApp();
  const snap = useSnapshot();
  const ui = useUi();
  const toast = useToast();
  const confirm = useConfirm();
  const p: ItemPayload = item.payload;
  const readOnly = item.role === 'viewer';
  const project = p.projectId ? snap.projects.find((x) => x.id === p.projectId) : null;
  const act = (fn: () => Promise<unknown>, ok?: string) => async () => {
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const platformActions = ext.itemActions?.(item, session) ?? [];
  const exportPlain = async () => {
    const ok = await confirm({
      title: 'Export plaintext?',
      body: (
        <>
          The exported file will contain <strong>unencrypted secrets</strong>. Anyone with access to the file can read them. It will not be added to source control automatically; deleting it later does not guarantee secure erasure on modern storage.
        </>
      ),
      confirmLabel: 'Choose location…',
      typeToConfirm: isProductionEnvironment(p.environment) ? 'EXPORT' : undefined,
    });
    if (!ok) return;
    const text = p.type === 'env_file' ? p.fields.content : p.type === 'ssh_key' ? p.fields.privateKey : session.exportPlaintext([item.id]);
    const name = p.type === 'env_file' ? p.fields.filename : p.type === 'ssh_key' ? `${p.title.replace(/[^\w.-]+/g, '_')}` : `${p.title.replace(/[^\w.-]+/g, '_')}.json`;
    const r = await session.platformRef.files.saveTextFile({ suggestedName: name, text });
    if (r.saved) toast(r.ownerOnly ? `Saved ${r.location ?? ''} (owner-only permissions)` : `Saved ${r.location ?? 'file'}`, 'success');
  };

  return (
    <article className="pv-animate-in mx-auto max-w-3xl p-4 sm:p-8 space-y-5" aria-labelledby="item-title">
      <div className="flex items-start gap-3">
        <IconButton label="Back to list" className="lg:hidden" onClick={onClose}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <TypeIcon type={p.type} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 id="item-title" className="text-xl font-semibold tracking-tight break-words">
            {p.title}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
            <span>{ITEM_TYPE_LABELS[p.type]}</span>
            <EnvBadge env={p.environment} />
            {project && (
              <button className="hover:underline" onClick={() => ui.go('projects', { projectId: project.id })}>
                · {project.payload.name}
              </button>
            )}
            {p.folder && <span>· {p.folder}</span>}
            {item.shared && <Badge tone="accent">{item.sharedByMe ? 'Shared by you' : `Shared with you · ${item.role}`}</Badge>}
            {p.archived && <Badge>Archived</Badge>}
            {p.trashedAt && <Badge tone="danger">In trash</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {platformActions
            .filter((a) => a.primary)
            .map((a) => (
              <Button key={a.id} variant="primary" size="sm" icon={a.icon} onClick={a.onSelect}>
                {a.label}
              </Button>
            ))}
          <IconButton label={item.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={act(() => session.toggleFavorite(item.id))} disabled={readOnly && !item.shared}>
            <Star className={cx('size-4', item.favorite && 'fill-warn text-warn')} />
          </IconButton>
          {!p.trashedAt && !readOnly && (
            <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => ui.set({ editor: { mode: 'edit', id: item.id } })}>
              Edit
            </Button>
          )}
          <Menu
            trigger={(t) => (
              <IconButton {...t} label="More actions">
                <MoreHorizontal className="size-4" />
              </IconButton>
            )}
            items={[
              ...platformActions.filter((a) => !a.primary).map((a) => ({ label: a.label, icon: a.icon, onSelect: a.onSelect })),
              { label: 'Duplicate', icon: <Copy />, onSelect: act(() => session.duplicateItem(item.id), 'Duplicated'), hidden: !!p.trashedAt },
              { label: 'Share…', icon: <Share2 />, onSelect: () => ui.set({ shareTarget: { kind: 'items', itemIds: [item.id] } }), hidden: !!p.trashedAt || (item.shared && !item.sharedByMe && !snap.vaults.find((v) => v.vaultId === item.vaultId)?.allowResharing) },
              { label: 'Manage access…', icon: <Users />, onSelect: () => ui.set({ membersVaultId: item.vaultId }), hidden: !item.shared },
              { label: 'Version history', icon: <History />, onSelect: () => ui.set({ historyId: item.id }) },
              { label: p.type === 'env_file' ? 'Export file…' : p.type === 'ssh_key' ? 'Export private key…' : 'Export as plaintext…', icon: <Download />, onSelect: () => void exportPlain() },
              { label: p.archived ? 'Unarchive' : 'Archive', icon: p.archived ? <ArchiveRestore /> : <Archive />, onSelect: act(() => session.setArchived(item.id, !p.archived)), hidden: readOnly || !!p.trashedAt },
              { label: 'Move to trash', icon: <Trash2 />, danger: true, onSelect: act(() => session.moveToTrash(item.id), 'Moved to trash'), hidden: readOnly || !!p.trashedAt },
              { label: 'Restore', icon: <RotateCcw />, onSelect: act(() => session.restoreFromTrash(item.id), 'Restored'), hidden: readOnly || !p.trashedAt },
              {
                label: 'Delete permanently…',
                icon: <Trash2 />,
                danger: true,
                hidden: readOnly || !p.trashedAt,
                onSelect: async () => {
                  if (await confirm({ title: `Permanently delete “${p.title}”?`, body: item.shared ? 'This removes it for everyone it is shared with. It cannot be undone.' : 'This removes it from all your devices and cannot be undone.', confirmLabel: 'Delete permanently' })) {
                    await act(() => session.deletePermanently(item.id), 'Deleted')();
                    onClose();
                  }
                },
              },
            ]}
          />
        </div>
      </div>

      {item.conflict && (
        <Banner tone="danger" icon={<AlertTriangle className="size-4" />} title="This item changed on another device" action={<Button size="sm" onClick={() => ui.set({ conflictId: item.id })}>Resolve…</Button>}>
          Your edit was not applied because someone saved a newer version. Nothing was overwritten.
        </Banner>
      )}
      {item.failed && (
        <Banner
          tone="danger"
          title="A change could not be saved"
          action={
            <div className="flex gap-1">
              <Button size="sm" onClick={act(() => session.retryFailed(item.id))}>
                Retry
              </Button>
              <Button size="sm" variant="ghost" onClick={act(() => session.discardFailed(item.id))}>
                Discard
              </Button>
            </div>
          }
        >
          {item.failed.error}
        </Banner>
      )}
      {readOnly && <Banner tone="neutral">You have view-only access. Viewing still lets you copy secrets.</Banner>}
      {p.type === 'ssh_key' && item.shared && <Banner tone="warn" icon={<ShieldAlert className="size-4" />}>This private key is shared. Anyone with access can copy it and keep using it after access is revoked.</Banner>}

      {p.description && <p className="text-sm text-fg-muted whitespace-pre-wrap">{p.description}</p>}

      {p.type === 'env_file' ? (
        <EnvFileView item={item as DecryptedItem & { payload: ItemPayload<'env_file'> }} />
      ) : (
        <Card>
          <Fields item={item} />
        </Card>
      )}

      {p.type === 'login' && p.fields.urls[0] && (
        <div className="flex gap-2">
          <Button size="sm" icon={<ExternalLink className="size-3.5" />} onClick={() => void session.platformRef.openExternal(p.fields.urls[0]!.url.includes('://') ? p.fields.urls[0]!.url : `https://${p.fields.urls[0]!.url}`)}>
            Open {safeHost(p.fields.urls[0].url)}
          </Button>
        </div>
      )}

      {p.type === 'ssh_connection' && (
        <Card title="Trusted host keys">
          {p.fields.hostKeys.length === 0 ? (
            <p className="text-sm text-fg-muted">No host key trusted yet. The first connection from the desktop app will show the server’s fingerprint for you to verify.</p>
          ) : (
            <ul className="space-y-2">
              {p.fields.hostKeys.map((k) => (
                <li key={`${k.hostPort} ${k.fingerprint}`} className="flex items-start gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs break-all">{k.fingerprint}</div>
                    <div className="text-xs text-fg-subtle">
                      {k.keyType} · {k.hostPort} · trusted {new Date(k.trustedAt).toLocaleString()}
                    </div>
                  </div>
                  {!readOnly && !p.trashedAt && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const ok = await confirm({
                          title: 'Remove this trusted host key?',
                          body: `Only remove it if you confirmed with the server administrator that ${k.hostPort} legitimately changed its host key. The next connection will show the new fingerprint for you to verify.`,
                          confirmLabel: 'Remove key',
                        });
                        if (!ok) return;
                        await act(
                          () =>
                            session.updateItem(item.id, (np) => {
                              if (np.type === 'ssh_connection') np.fields.hostKeys = np.fields.hostKeys.filter((x) => !(x.fingerprint === k.fingerprint && x.hostPort === k.hostPort && x.publicKey === k.publicKey));
                            }),
                          'Trusted host key removed',
                        )();
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {p.notes && (
        <Card title="Notes">
          <p className="whitespace-pre-wrap break-words text-sm">{p.notes}</p>
        </Card>
      )}

      {p.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {p.tags.map((t) => (
            <button key={t} onClick={() => ui.go('all', { tagFilter: t })}>
              <Badge>#{t}</Badge>
            </button>
          ))}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-fg-subtle">
        <dt>Created</dt>
        <dd>{new Date(item.createdAt).toLocaleString()}</dd>
        <dt>Last modified</dt>
        <dd>
          {new Date(item.updatedAt).toLocaleString()}
          {item.pending && ' · waiting to sync'}
        </dd>
        <dt>Revision</dt>
        <dd>{item.revision || 'not yet synced'}</dd>
      </dl>
    </article>
  );
}
