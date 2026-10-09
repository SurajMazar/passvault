import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  Archive,
  CloudOff,
  FolderKanban,
  LayoutDashboard,
  Layers,
  Lock,
  Moon,
  RefreshCw,
  Search,
  Settings,
  Share2,
  Star,
  Sun,
  Trash2,
  UserPlus,
  Wand2,
  AlertTriangle,
  Plus,
} from 'lucide-react';
import { ITEM_TYPES, ITEM_TYPE_LABELS, type ItemType } from '@passvault/types';
import { Badge, Button, CommandPalette, IconButton, Kbd, Logo, Menu, TypeIcon, applyTheme, cx, type Command } from '@passvault/ui';
import { itemSubtitle } from '@passvault/vault-core';
import { useApp, useSnapshot, useUi, type NavId } from '../state';
import { Overview } from '../views/Overview';
import { ItemsView } from '../views/ItemsView';
import { ProjectsView } from '../views/ProjectsView';
import { SettingsView } from '../views/SettingsView';
import { ItemEditor } from '../items/ItemEditor';
import { GeneratorDialog } from '../views/Generator';
import { ShareDialog, MembersDialog } from '../sharing/ShareDialog';
import { HistoryDialog, ConflictDialog } from '../items/HistoryDialog';

function isDarkNow() {
  const t = useUi.getState().theme;
  return t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

const TYPE_NAV: Array<{ id: ItemType; label: string }> = [
  { id: 'login', label: 'Logins' },
  { id: 'ssh_connection', label: 'SSH & servers' },
  { id: 'ssh_key', label: 'SSH keys' },
  { id: 'database', label: 'Databases' },
  { id: 'api_credential', label: 'API credentials' },
  { id: 'env_file', label: 'Environment files' },
  { id: 'secure_note', label: 'Secure notes' },
];

function NavButton({ id, icon, label, count, badge }: { id: NavId; icon: ReactNode; label: string; count?: number; badge?: ReactNode }) {
  const nav = useUi((s) => s.nav);
  const go = useUi((s) => s.go);
  const active = nav === id;
  return (
    <button
      type="button"
      onClick={() => go(id)}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 h-9 text-[13.5px] transition-colors',
        active ? 'bg-surface text-fg font-medium shadow-[var(--shadow-card)] ring-1 ring-border' : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
      )}
    >
      {active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-accent" aria-hidden />}
      <span className={cx('shrink-0 [&>svg]:size-[17px]', active ? 'text-accent' : 'text-fg-subtle group-hover:text-fg-muted')}>{icon}</span>
      <span className="flex-1 truncate text-left">{label}</span>
      {badge}
      {count !== undefined && count > 0 && <span className={cx('min-w-6 rounded-full px-1.5 text-center text-[11px] tabular-nums', active ? 'bg-accent-soft text-accent' : 'text-fg-subtle')}>{count}</span>}
    </button>
  );
}

function SyncIndicator() {
  const { session } = useApp();
  const snap = useSnapshot();
  const s = snap.sync;
  const label = !snap.online
    ? 'Offline — changes are queued'
    : s.state === 'syncing'
      ? 'Syncing…'
      : s.state === 'error'
        ? `Sync error: ${s.lastError ?? ''}`
        : s.conflicts
          ? `${s.conflicts} conflict${s.conflicts > 1 ? 's' : ''} need attention`
          : s.failed
            ? `${s.failed} change${s.failed > 1 ? 's' : ''} failed`
            : s.pending
              ? `${s.pending} change${s.pending > 1 ? 's' : ''} pending`
              : s.lastSyncAt
                ? `Synced ${new Date(s.lastSyncAt).toLocaleTimeString()}`
                : 'Not synced yet';
  const tone = !snap.online || s.state === 'offline' ? 'warn' : s.state === 'error' || s.failed || s.conflicts ? 'danger' : 'ok';
  return (
    <button
      type="button"
      onClick={() => void session.syncNow().catch(() => undefined)}
      className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 h-8 text-xs text-fg-muted hover:bg-surface-3"
      title="Sync now"
      aria-label={`${label}. Sync now`}
    >
      {!snap.online || s.state === 'offline' ? <CloudOff className="size-4 text-warn" /> : <RefreshCw className={cx('size-4', s.state === 'syncing' && 'animate-spin', tone === 'danger' ? 'text-danger' : 'text-ok')} />}
      <span className="hidden lg:inline max-w-56 truncate">{label}</span>
    </button>
  );
}

export function Shell() {
  const { session, ext } = useApp();
  const snap = useSnapshot();
  const ui = useUi();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => applyTheme(ui.theme), [ui.theme]);

  // Activity resets the inactivity lock timer.
  useEffect(() => {
    const onAct = () => session.touch();
    const evs = ['keydown', 'mousedown', 'wheel', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, onAct, { passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, onAct));
  }, [session]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.set({ paletteOpen: !ui.paletteOpen });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        session.lock();
      } else if (!typing && !mod && e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (!typing && !mod && e.key.toLowerCase() === 'n' && !document.querySelector('[role=dialog]')) {
        e.preventDefault();
        const t = (ITEM_TYPES as readonly string[]).includes(ui.nav) ? (ui.nav as ItemType) : 'login';
        ui.set({ editor: { mode: 'create', type: t } });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui, session]);

  const live = snap.items.filter((i) => !i.payload.trashedAt && !i.payload.archived);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of live) c[i.payload.type] = (c[i.payload.type] ?? 0) + 1;
    return c;
  }, [live]);

  const commands: Command[] = useMemo(() => {
    const nav = (id: NavId, label: string, icon: ReactNode): Command => ({ id: `nav-${id}`, group: 'Go to', label, icon, run: () => ui.go(id) });
    const cmds: Command[] = [
      nav('overview', 'Overview', <LayoutDashboard />),
      nav('all', 'All items', <Layers />),
      ...TYPE_NAV.map((t) => nav(t.id, t.label, <TypeIcon type={t.id} size="sm" />)),
      nav('projects', 'Projects', <FolderKanban />),
      nav('favorites', 'Favorites', <Star />),
      nav('shared_with_me', 'Shared with me', <Share2 />),
      nav('shared_by_me', 'Shared by me', <UserPlus />),
      nav('trash', 'Trash', <Trash2 />),
      nav('settings', 'Security & settings', <Settings />),
      ...ITEM_TYPES.map((t) => ({ id: `new-${t}`, group: 'Create', label: `New ${ITEM_TYPE_LABELS[t].toLowerCase()}`, icon: <Plus />, run: () => ui.set({ editor: { mode: 'create', type: t } }) })),
      { id: 'gen', group: 'Tools', label: 'Password generator', icon: <Wand2 />, run: () => ui.set({ generatorOpen: true }) },
      { id: 'lock', group: 'Tools', label: 'Lock vault', hint: '⇧⌘L', icon: <Lock />, run: () => session.lock() },
      { id: 'sync', group: 'Tools', label: 'Sync now', icon: <RefreshCw />, run: () => void session.syncNow().catch(() => undefined) },
      { id: 'theme', group: 'Tools', label: 'Toggle dark mode', icon: <Moon />, run: () => ui.set({ theme: isDarkNow() ? 'light' : 'dark' }) },
      ...(ext.extraNav ?? []).map((n) => nav(`ext:${n.id}`, n.label, n.icon)),
    ];
    for (const it of live) {
      cmds.push({
        id: `item-${it.id}`,
        group: 'Items',
        label: it.payload.title,
        hint: itemSubtitle(it.payload),
        keywords: `${it.payload.tags.join(' ')} ${it.payload.folder} ${it.payload.environment ?? ''}`,
        icon: <TypeIcon type={it.payload.type} size="sm" />,
        run: () => ui.go(it.payload.type, { selectedId: it.id }),
      });
    }
    for (const p of snap.projects) cmds.push({ id: `proj-${p.id}`, group: 'Projects', label: p.payload.name, icon: <FolderKanban />, run: () => ui.go('projects', { projectId: p.id }) });
    return cmds;
  }, [live, snap.projects, ui, session, ext.extraNav]);

  const extView = ui.nav.startsWith('ext:') ? ext.extraNav?.find((n) => `ext:${n.id}` === ui.nav) : null;
  // Derive from state (not the DOM class, which is applied after render) so the toggle flips immediately.
  const isDark = ui.theme === 'dark' || (ui.theme === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-border bg-bg-subtle" aria-label="Main navigation">
        <div className="flex items-center gap-2.5 px-4 h-16">
          <Logo className="size-8" />
          <span className="text-[15px] font-semibold tracking-tight">PassVault</span>
        </div>
        <div className="px-3 pb-2">
          <Menu
            align="left"
            trigger={(p) => (
              <Button {...p} variant="primary" className="w-full" icon={<Plus className="size-4" />}>
                New item
              </Button>
            )}
            items={ITEM_TYPES.map((t) => ({ label: ITEM_TYPE_LABELS[t], icon: <TypeIcon type={t} size="sm" />, onSelect: () => ui.set({ editor: { mode: 'create', type: t } }) }))}
          />
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-5 pv-scroll">
          <div className="space-y-0.5">
            <NavButton id="overview" icon={<LayoutDashboard />} label="Overview" />
            <NavButton id="all" icon={<Layers />} label="All items" count={live.length} />
            <NavButton id="favorites" icon={<Star />} label="Favorites" count={live.filter((i) => i.favorite).length} />
          </div>
          <div className="space-y-0.5">
            <div className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-subtle/80">Types</div>
            {TYPE_NAV.map((t) => (
              <NavButton key={t.id} id={t.id} icon={<TypeIcon type={t.id} size="sm" />} label={t.label} count={counts[t.id]} />
            ))}
          </div>
          <div className="space-y-0.5">
            <div className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-subtle/80">Organize</div>
            <NavButton id="projects" icon={<FolderKanban />} label="Projects" count={snap.projects.filter((p) => !p.payload.trashedAt).length} />
            <NavButton
              id="shared_with_me"
              icon={<Share2 />}
              label="Shared with me"
              count={live.filter((i) => i.shared && !i.sharedByMe).length}
              badge={snap.sync.pendingInvitations ? <Badge tone="accent">{snap.sync.pendingInvitations} new</Badge> : undefined}
            />
            <NavButton id="shared_by_me" icon={<UserPlus />} label="Shared by me" count={live.filter((i) => i.sharedByMe).length} />
            <NavButton id="archive" icon={<Archive />} label="Archive" count={snap.items.filter((i) => i.payload.archived && !i.payload.trashedAt).length} />
            <NavButton id="trash" icon={<Trash2 />} label="Trash" count={snap.items.filter((i) => i.payload.trashedAt).length} />
          </div>
          {ext.extraNav && ext.extraNav.length > 0 && (
            <div className="space-y-0.5">
              <div className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-subtle/80">Desktop</div>
              {ext.extraNav.map((n) => (
                <NavButton key={n.id} id={`ext:${n.id}`} icon={n.icon} label={n.label} badge={n.badge?.()} />
              ))}
            </div>
          )}
        </nav>
        <div className="space-y-2 border-t border-border p-3">
          <NavButton id="settings" icon={<Settings />} label="Security & settings" badge={snap.undecryptable.length ? <AlertTriangle className="size-4 text-warn" /> : undefined} />
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg">{(snap.user?.name ?? '?').slice(0, 1).toUpperCase()}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{snap.user?.name}</span>
              <span className="block truncate text-[11px] text-fg-subtle">{snap.user?.email}</span>
            </span>
            <IconButton size="sm" label="Lock vault (⇧⌘L)" onClick={() => session.lock()}>
              <Lock className="size-4" />
            </IconButton>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-surface px-4 h-16">
          <div className="relative flex-1 max-w-2xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <input
              ref={searchRef}
              type="search"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="Search vault"
              placeholder="Search titles, usernames, hosts, tags, variable names…"
              value={ui.query}
              onChange={(e) => {
                const q = e.target.value;
                ui.set({ query: q, ...(q && (ui.nav === 'overview' || ui.nav === 'settings' || ui.nav === 'projects' || ui.nav.startsWith('ext:')) ? { nav: 'all' } : {}) });
              }}
              className="h-10 w-full rounded-xl border border-border bg-surface-2 pl-9 pr-16 text-sm placeholder:text-fg-subtle transition focus:border-accent focus:bg-surface focus:outline-none focus:ring-4 focus:ring-accent/15"
            />
            <button type="button" onClick={() => ui.set({ paletteOpen: true })} className="absolute right-2 top-1/2 -translate-y-1/2 hidden sm:flex items-center gap-0.5 rounded-md px-1 py-0.5 hover:bg-surface-3" aria-label="Open command palette">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </button>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <SyncIndicator />
            <IconButton label="Password generator" onClick={() => ui.set({ generatorOpen: true })}>
              <Wand2 className="size-4" />
            </IconButton>
            <IconButton label={isDark ? 'Light theme' : 'Dark theme'} onClick={() => ui.set({ theme: isDark ? 'light' : 'dark' })}>
              {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </IconButton>
            <Menu
              trigger={(p) => (
                <button {...p} className="ml-1 flex size-9 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent ring-1 ring-accent-line md:hidden" aria-label="Account menu">
                  {(snap.user?.name ?? '?').slice(0, 1).toUpperCase()}
                </button>
              )}
              items={[
                { label: snap.user?.email ?? '', onSelect: () => ui.go('settings', { settingsTab: 'account' }) },
                { label: 'Security & settings', icon: <Settings />, onSelect: () => ui.go('settings') },
                { label: 'Lock vault', icon: <Lock />, onSelect: () => session.lock() },
                { label: 'Sign out', onSelect: () => void session.logout() },
              ]}
            />
          </div>
        </header>
        {ext.statusBanner && <div className="px-3 pt-2">{ext.statusBanner()}</div>}
        {!snap.online && (
          <div className="border-b border-warn/30 bg-warn-soft px-4 py-1.5 text-xs text-warn" role="status">
            You are offline. Cached items are readable; edits are queued and will sync when you reconnect. Sharing and membership changes need a connection.
          </div>
        )}
        {/* small screens: compact nav */}
        <div className="md:hidden flex gap-1 overflow-x-auto border-b border-border px-2 py-1.5 bg-surface-2">
          {(['overview', 'all', 'projects', 'favorites', 'shared_with_me', 'trash', 'settings'] as NavId[]).map((n) => (
            <button key={n} onClick={() => ui.go(n)} className={cx('rounded px-2 h-7 text-xs whitespace-nowrap', ui.nav === n ? 'bg-accent-soft text-fg' : 'text-fg-muted')}>
              {n.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
        <main className="min-h-0 flex-1 overflow-hidden" id="main">
          {/* keyed by section, so switching sections fades the new one in */}
          <div key={ui.nav} className="pv-view-in h-full">
            {ui.nav === 'overview' ? <Overview /> : ui.nav === 'projects' ? <ProjectsView /> : ui.nav === 'settings' ? <SettingsView /> : extView ? extView.render() : <ItemsView />}
          </div>
        </main>
      </div>

      <CommandPalette open={ui.paletteOpen} onClose={() => ui.set({ paletteOpen: false })} commands={commands} />
      {ui.editor && <ItemEditor key={ui.editor.mode === 'edit' ? ui.editor.id : `new-${ui.editor.type}`} />}
      <GeneratorDialog open={ui.generatorOpen} onClose={() => ui.set({ generatorOpen: false })} />
      {ui.shareTarget && <ShareDialog />}
      {ui.membersVaultId && <MembersDialog />}
      {ui.historyId && <HistoryDialog />}
      {ui.conflictId && <ConflictDialog />}
    </div>
  );
}
