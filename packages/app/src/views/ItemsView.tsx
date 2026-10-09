import { useMemo, useRef, useState } from 'react';
import { ArrowDownAZ, Clock3, Inbox, Plus, Star, Trash2, X, Archive, FolderInput, Tag, AlertTriangle, CloudUpload } from 'lucide-react';
import { ITEM_TYPES, ITEM_TYPE_LABELS, type ItemType } from '@passvault/types';
import { Badge, Banner, Button, EmptyState, EnvBadge, IconButton, Input, Menu, Select, TypeIcon, cx, useConfirm, useToast } from '@passvault/ui';
import { filterItems, itemSubtitle, type DecryptedItem, type ItemFilter, itemIdentifier } from '@passvault/vault-core';
import { useApp, useSnapshot, useUi, errorMessage } from '../state';
import { ItemDetail } from '../items/ItemDetail';
import { Invitations } from '../sharing/Invitations';

const TITLES: Record<string, string> = {
  all: 'All items',
  favorites: 'Favorites',
  shared_with_me: 'Shared with me',
  shared_by_me: 'Shared by me',
  archive: 'Archive',
  trash: 'Trash',
  ...Object.fromEntries(ITEM_TYPES.map((t) => [t, ITEM_TYPE_LABELS[t] + 's'])),
  ssh_connection: 'SSH & servers',
  env_file: 'Environment files',
};

export function ItemsView() {
  const { session } = useApp();
  const snap = useSnapshot();
  const ui = useUi();
  const toast = useToast();
  const confirm = useConfirm();
  const textCache = useRef(new Map<string, string>());
  const [bulkTag, setBulkTag] = useState('');

  const isType = (ITEM_TYPES as readonly string[]).includes(ui.nav);
  const filter: ItemFilter = {
    query: ui.query,
    types: isType ? [ui.nav as ItemType] : undefined,
    status: ui.nav === 'trash' ? 'trash' : ui.nav === 'archive' ? 'archived' : 'active',
    favoritesOnly: ui.nav === 'favorites',
    shared: ui.nav === 'shared_with_me' ? 'with_me' : ui.nav === 'shared_by_me' ? 'by_me' : null,
    tags: ui.tagFilter ? [ui.tagFilter] : undefined,
    environment: ui.envFilter,
    folder: ui.folderFilter,
    sort: ui.sort,
  };
  const items = useMemo(() => filterItems(snap.items, filter, textCache.current), [snap.items, JSON.stringify(filter)]); // eslint-disable-line react-hooks/exhaustive-deps
  const scoped = useMemo(() => filterItems(snap.items, { ...filter, query: '', tags: undefined, environment: null, folder: null }), [snap.items, ui.nav]); // eslint-disable-line react-hooks/exhaustive-deps
  const allTags = useMemo(() => [...new Set(scoped.flatMap((i) => i.payload.tags))].sort(), [scoped]);
  const allEnvs = useMemo(() => [...new Set(scoped.map((i) => i.payload.environment).filter(Boolean) as string[])].sort(), [scoped]);
  const allFolders = useMemo(() => [...new Set(scoped.map((i) => i.payload.folder).filter(Boolean))].sort(), [scoped]);
  const selected = snap.items.find((i) => i.id === ui.selectedId) ?? null;
  const createType: ItemType = isType ? (ui.nav as ItemType) : 'login';
  const bulk = ui.selectedIds.filter((id) => items.some((i) => i.id === id));

  const runBulk = async (label: string, fn: (p: DecryptedItem['payload']) => void) => {
    const r = await session.bulkUpdate(bulk, fn);
    toast(r.failed.length ? `${label}: ${r.ok} updated, ${r.failed.length} failed (${r.failed[0]!.error})` : `${label}: ${r.ok} updated`, r.failed.length ? 'warn' : 'success');
    ui.set({ selectedIds: [] });
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const idx = items.findIndex((i) => i.id === ui.selectedId);
    const next = items[Math.max(0, Math.min(items.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      ui.set({ selectedId: next.id });
      document.getElementById(`row-${next.id}`)?.focus();
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <section className={cx('flex min-w-0 flex-col border-r border-border bg-surface', selected ? 'hidden lg:flex w-[21rem] xl:w-[25rem] shrink-0' : 'flex-1 lg:w-[21rem] xl:w-[25rem] lg:flex-none lg:shrink-0')} aria-label="Item list">
        <div className="flex items-center gap-2 px-4 h-14 border-b border-border">
          <h1 className="flex-1 truncate text-[15px] font-semibold tracking-tight">
            {TITLES[ui.nav] ?? 'Items'} <span className="ml-1 text-sm font-normal text-fg-subtle">{items.length}</span>
          </h1>
          <IconButton label={ui.sort === 'title' ? 'Sorted by title — sort by last modified' : 'Sorted by last modified — sort by title'} onClick={() => ui.set({ sort: ui.sort === 'title' ? 'updated' : 'title' })}>
            {ui.sort === 'title' ? <ArrowDownAZ className="size-4" /> : <Clock3 className="size-4" />}
          </IconButton>
          {ui.nav === 'trash' ? (
            <Button
              size="sm"
              variant="danger"
              disabled={!items.length}
              onClick={async () => {
                if (await confirm({ title: 'Empty trash?', body: `${items.length} item(s) will be permanently deleted on all your devices. This cannot be undone.`, confirmLabel: 'Delete permanently' })) {
                  const n = await session.emptyTrash();
                  toast(`${n} item(s) permanently deleted`, 'success');
                }
              }}
            >
              Empty trash
            </Button>
          ) : (
            <Menu
              trigger={(p) => (
                <Button {...p} size="sm" variant="primary" icon={<Plus className="size-4" />}>
                  New
                </Button>
              )}
              items={[createType, ...ITEM_TYPES.filter((t) => t !== createType)].map((t) => ({
                label: ITEM_TYPE_LABELS[t],
                icon: <TypeIcon type={t} size="sm" />,
                onSelect: () => ui.set({ editor: { mode: 'create', type: t } }),
              }))}
            />
          )}
        </div>
        {(allTags.length > 0 || allEnvs.length > 0 || allFolders.length > 0) && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            {allFolders.length > 0 && (
              <Select aria-label="Filter by category" className="!h-7 !w-auto text-xs" value={ui.folderFilter ?? ''} onChange={(e) => ui.set({ folderFilter: e.target.value || null })}>
                <option value="">All categories</option>
                {allFolders.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </Select>
            )}
            {allEnvs.length > 0 && (
              <Select aria-label="Filter by environment" className="!h-7 !w-auto text-xs" value={ui.envFilter ?? ''} onChange={(e) => ui.set({ envFilter: e.target.value || null })}>
                <option value="">All environments</option>
                {allEnvs.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </Select>
            )}
            {allTags.length > 0 && (
              <Select aria-label="Filter by tag" className="!h-7 !w-auto text-xs" value={ui.tagFilter ?? ''} onChange={(e) => ui.set({ tagFilter: e.target.value || null })}>
                <option value="">All tags</option>
                {allTags.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </Select>
            )}
          </div>
        )}
        {bulk.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-accent-soft px-3 py-2 text-xs">
            <span className="font-medium">{bulk.length} selected</span>
            {ui.nav === 'trash' ? (
              <Button size="sm" onClick={() => runBulk('Restored', (p) => void (p.trashedAt = null))}>
                Restore
              </Button>
            ) : (
              <>
                <Button size="sm" icon={<Star className="size-3.5" />} onClick={() => runBulk('Favorited', (p) => void (p.favorite = true))}>
                  Favorite
                </Button>
                <Button size="sm" icon={<Archive className="size-3.5" />} onClick={() => runBulk('Archived', (p) => void (p.archived = ui.nav !== 'archive'))}>
                  {ui.nav === 'archive' ? 'Unarchive' : 'Archive'}
                </Button>
                <Button size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => runBulk('Moved to trash', (p) => void (p.trashedAt = new Date().toISOString()))}>
                  Trash
                </Button>
                <Menu
                  trigger={(p) => (
                    <Button {...p} size="sm" icon={<FolderInput className="size-3.5" />}>
                      Project
                    </Button>
                  )}
                  items={[
                    { label: 'No project', onSelect: () => runBulk('Moved', (p) => void (p.projectId = null)) },
                    ...snap.projects.filter((p) => p.vaultId === session.personalVaultId).map((pr) => ({ label: pr.payload.name, onSelect: () => runBulk('Moved', (p) => void (p.projectId = pr.id)) })),
                  ]}
                />
                <form
                  className="flex items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const t = bulkTag.trim();
                    if (t) void runBulk(`Tagged "${t}"`, (p) => void (p.tags = [...new Set([...p.tags, t])]));
                    setBulkTag('');
                  }}
                >
                  <Input aria-label="Add tag to selected" placeholder="Add tag" className="!h-7 !w-24 text-xs" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} />
                  <IconButton size="sm" label="Add tag" type="submit">
                    <Tag className="size-3.5" />
                  </IconButton>
                </form>
              </>
            )}
            <IconButton size="sm" label="Clear selection" onClick={() => ui.set({ selectedIds: [] })}>
              <X className="size-3.5" />
            </IconButton>
          </div>
        )}
        {ui.nav === 'shared_with_me' && (
          <div className="border-b border-border p-3">
            <Invitations />
          </div>
        )}
        <div role="listbox" aria-label="Items" tabIndex={-1} onKeyDown={onListKey} className="flex-1 overflow-y-auto py-1.5 pv-scroll">
          {items.length === 0 ? (
            <EmptyState icon={<Inbox className="size-8" />} title={ui.query ? 'No matches' : ui.nav === 'trash' ? 'Trash is empty' : 'Nothing here yet'}>
              {ui.query ? 'Search covers titles, usernames, hosts, tags, and variable names — never secret values.' : ui.nav === 'trash' ? 'Items you delete stay here until you empty the trash.' : 'Create an item to get started.'}
            </EmptyState>
          ) : (
            items.map((it, idx) => (
              <div
                key={it.id}
                id={`row-${it.id}`}
                style={{ ['--i' as string]: idx }}
                role="option"
                aria-selected={it.id === ui.selectedId}
                tabIndex={it.id === ui.selectedId || (!ui.selectedId && it === items[0]) ? 0 : -1}
                onClick={() => ui.set({ selectedId: it.id })}
                onKeyDown={(e) => e.key === 'Enter' && ui.set({ selectedId: it.id })}
                className={cx(
                  'pv-row-in group relative mx-2 my-0.5 flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 outline-none transition-colors',
                  it.id === ui.selectedId ? 'bg-accent-soft ring-1 ring-accent-line' : 'hover:bg-surface-2 focus-visible:bg-surface-2',
                )}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${it.payload.title}`}
                  className="size-4 accent-[var(--pv-accent)] opacity-40 group-hover:opacity-100 checked:opacity-100"
                  checked={ui.selectedIds.includes(it.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => ui.set({ selectedIds: e.target.checked ? [...ui.selectedIds, it.id] : ui.selectedIds.filter((x) => x !== it.id) })}
                  disabled={it.role === 'viewer'}
                />
                <TypeIcon type={it.payload.type} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[14px] font-medium">{it.payload.title}</span>
                    {itemIdentifier(it.payload) && (
                      <span className="max-w-[40%] shrink-0 truncate rounded-md bg-surface-3 px-1.5 py-px text-[11px] text-fg-muted">{itemIdentifier(it.payload)}</span>
                    )}
                    {it.favorite && <Star className="size-3 shrink-0 fill-warn text-warn" aria-label="Favorite" />}
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                    <EnvBadge env={it.payload.environment} />
                    <span className="truncate text-[12.5px] text-fg-subtle">{itemSubtitle(it.payload)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <div className="flex gap-1">
                    {it.shared && <Badge tone="accent">{it.sharedByMe ? 'Shared' : it.role}</Badge>}
                    {it.pending && <CloudUpload className="size-3.5 text-fg-subtle" aria-label="Pending sync" />}
                    {(it.conflict || it.failed) && <AlertTriangle className="size-3.5 text-danger" aria-label="Sync problem" />}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="border-t border-border px-4 py-2 text-[11px] text-fg-subtle">↑↓ to move · / to search · N for new</div>
      </section>
      <section className={cx('min-w-0 flex-1 overflow-y-auto bg-bg pv-scroll', !selected && 'hidden lg:block')} aria-label="Item details">
        {selected ? (
          <div key={selected.id} className="pv-view-in">
            <ItemDetail item={selected} onClose={() => ui.set({ selectedId: null })} />
          </div>
        ) : (
          <EmptyState title="Select an item" icon={<TypeIcon type={createType} size="lg" />}>
            Use ↑ ↓ to move through the list, <kbd>/</kbd> to search, <kbd>N</kbd> to create, and ⌘K for everything else.
          </EmptyState>
        )}
        {snap.undecryptable.length > 0 && ui.nav === 'all' && (
          <div className="p-4">
            <Banner tone="warn" title={`${snap.undecryptable.length} item(s) could not be decrypted`}>
              {snap.undecryptable[0]!.reason}
            </Banner>
          </div>
        )}
      </section>
    </div>
  );
}

export { errorMessage };
