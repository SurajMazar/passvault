import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, CloudOff, Copy, ExternalLink, KeyRound, Lock, LogIn, Plus, RefreshCw, Search, ShieldAlert, User } from 'lucide-react';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  EnvBadge,
  FieldRow,
  IconButton,
  Input,
  Logo,
  Spinner,
  Tabs,
  TypeIcon,
  cx,
  useConfirm,
  useToast,
} from '@passvault/ui';
import type { CardSummary, ItemDetail, ItemSummary, LoginMatch, MatchesResponse, PopupState } from '../shared/protocol';
import { openDashboard } from './AuthViews';
import { AutoSaveSettings } from './AutoSaveSettings';
import { ServerSettings } from './ServerSwitch';
import { Generator } from './Generator';
import { activeTabId, call, copyToClipboard, errorText } from './rpc';
import { SaveLogin } from './SaveLogin';
import { isMac, touchIdContinuing, TouchIdSettings } from './TouchIdSettings';

type Route = { view: 'list' } | { view: 'detail'; id: string } | { view: 'save' };

export function VaultView({ state }: { state: PopupState }) {
  // Back on Settings after the popup reloaded itself to finish turning on Touch ID.
  const [tab, setTab] = useState<'vault' | 'cards' | 'generator' | 'settings'>(() => (touchIdContinuing() ? 'settings' : 'vault'));
  const [route, setRoute] = useState<Route>({ view: 'list' });
  const [tabId, setTabId] = useState<number | null>(null);
  useEffect(() => {
    void activeTabId().then(setTabId);
    void call({ type: 'vault.sync' }).catch(() => undefined);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Header state={state} />
      {route.view === 'list' && (
        <div className="px-3 pt-1">
          <Tabs
            label="Sections"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'vault', label: 'Vault' },
              { id: 'cards', label: 'Cards' },
              { id: 'generator', label: 'Generator' },
              { id: 'settings', label: 'Settings' },
            ]}
          />
        </div>
      )}
      <div className="flex-1 overflow-y-auto pv-scroll">
        {tab === 'cards' && route.view === 'list' ? (
          <CardList tabId={tabId} dataVersion={state.dataVersion} />
        ) : tab === 'generator' && route.view === 'list' ? (
          <Generator />
        ) : tab === 'settings' && route.view === 'list' ? (
          <>
            {isMac() && (
              <>
                <TouchIdSettings />
                <div className="border-t border-border" />
              </>
            )}
            <ServerSettings state={state} />
            <div className="border-t border-border" />
            <AutoSaveSettings />
          </>
        ) : route.view === 'detail' ? (
          <Detail id={route.id} tabId={tabId} dataVersion={state.dataVersion} onBack={() => setRoute({ view: 'list' })} />
        ) : route.view === 'save' && tabId !== null ? (
          <SaveLogin tabId={tabId} onDone={() => setRoute({ view: 'list' })} />
        ) : (
          <ItemList state={state} tabId={tabId} onOpen={(id) => setRoute({ view: 'detail', id })} onSave={() => setRoute({ view: 'save' })} />
        )}
      </div>
    </div>
  );
}

function Header({ state }: { state: PopupState }) {
  const toast = useToast();
  const syncing = state.sync.state === 'syncing';
  const offline = !state.online || !state.hasSession;
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <Logo className="size-6" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold leading-tight">PassVault</div>
        <div className="truncate text-[11px] text-fg-subtle">{state.email}</div>
      </div>
      {offline ? (
        <Badge tone="warn" title={state.hasSession ? 'Offline: showing your encrypted local copy' : 'Signed out of the server: showing your offline copy'}>
          <CloudOff className="size-3" /> Offline
        </Badge>
      ) : state.sync.pending > 0 ? (
        <Badge title="Changes waiting to sync">{state.sync.pending} pending</Badge>
      ) : state.sync.conflicts > 0 || state.sync.failed > 0 ? (
        <Badge tone="danger" title="Resolve in the dashboard">
          Sync issue
        </Badge>
      ) : null}
      <IconButton label="Sync now" size="sm" onClick={() => void call({ type: 'vault.sync' }).catch((e) => toast(errorText(e), 'error'))}>
        <RefreshCw className={cx('size-4', syncing && 'animate-spin')} />
      </IconButton>
      <IconButton label="Open dashboard" size="sm" onClick={() => openDashboard(state.webUrl)}>
        <ExternalLink className="size-4" />
      </IconButton>
      <IconButton
        label="Lock"
        size="sm"
        // Close right away: the locked screen would otherwise offer Touch ID at once. Reopening asks.
        onClick={() => void call({ type: 'auth.lock' }).finally(() => window.close())}
      >
        <Lock className="size-4" />
      </IconButton>
    </header>
  );
}

/** Shared fill action: background re-checks everything; insecure pages need explicit confirmation. */
function useFill(tabId: number | null) {
  const toast = useToast();
  const confirm = useConfirm();
  return useCallback(
    async (itemId: string) => {
      if (tabId === null) return;
      try {
        let r = await call({
          type: 'autofill.fill',
          tabId,
          itemId,
          confirmInsecure: false,
        });
        if (r.status === 'needs_confirmation') {
          const ok = await confirm({
            title: 'Fill on an insecure page?',
            body: (
              <p>
                <strong className="text-fg">{r.origin}</strong> does not use HTTPS. Anyone on the network could read what you submit. Only continue if you trust
                this network and site.
              </p>
            ),
            confirmLabel: 'Fill anyway',
            tone: 'danger',
          });
          if (!ok) return;
          r = await call({
            type: 'autofill.fill',
            tabId,
            itemId,
            confirmInsecure: true,
          });
        }
        if (r.status === 'filled') {
          window.close();
          return;
        }
        if (r.status === 'refused') toast(r.message, 'warn');
      } catch (e) {
        toast(errorText(e), 'error');
      }
    },
    [tabId, toast, confirm],
  );
}

function useCopy() {
  const toast = useToast();
  return useCallback(
    async (value: string, secret: boolean) => {
      try {
        const msg = await copyToClipboard(value, secret);
        if (msg) toast(msg, 'success');
      } catch {
        toast('Could not copy to the clipboard.', 'error');
      }
    },
    [toast],
  );
}

function ItemList({ state, tabId, onOpen, onSave }: { state: PopupState; tabId: number | null; onOpen: (id: string) => void; onSave: () => void }) {
  // Two searches: logins for this site (filtered here) and logins for other websites (background).
  const [siteQuery, setSiteQuery] = useState('');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<MatchesResponse | null>(null);
  const [items, setItems] = useState<ItemSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fill = useFill(tabId);
  const copy = useCopy();

  useEffect(() => {
    if (tabId === null) return;
    void call({ type: 'vault.matches', tabId })
      .then(setMatches)
      .catch((e) => setError(errorText(e)));
  }, [tabId, state.dataVersion]);

  useEffect(() => {
    const t = setTimeout(
      () =>
        void call({ type: 'vault.list', query, limit: 100 })
          .then((r) => {
            setItems(r.items);
            setTotal(r.total);
          })
          .catch((e) => setError(errorText(e))),
      query ? 120 : 0,
    );
    return () => clearTimeout(t);
  }, [query, state.dataVersion]);

  const copySecret = async (id: string, field: 'username' | 'password') => {
    try {
      const { value } = await call({ type: 'item.secret', id, field });
      await copy(value, field === 'password');
    } catch (e) {
      setError(errorText(e));
    }
  };

  const matchIds = useMemo(() => new Set(matches?.matches.map((m) => m.id)), [matches]);
  const others = (items ?? []).filter((i) => !matchIds.has(i.id));
  const sq = siteQuery.trim().toLowerCase();
  const siteMatches = (matches?.matches ?? []).filter((m) => !sq || [m.title, m.username, m.identifier, m.subtitle].some((x) => x.toLowerCase().includes(sq)));

  return (
    <div className="flex flex-col gap-3 p-3">
      {error && <Banner tone="danger">{error}</Banner>}

      <section aria-labelledby="pv-site">
        <div className="mb-1.5 flex items-center justify-between">
          <h2 id="pv-site" className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
            On this site{matches?.tab.host ? ` · ${matches.tab.host}` : ''}
          </h2>
          {matches?.tab.eligible && (
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={onSave}>
              Save login
            </Button>
          )}
        </div>
        {!matches ? (
          <Spinner />
        ) : !matches.tab.eligible ? (
          <p className="text-xs text-fg-muted">{matches.tab.reason}</p>
        ) : matches.matches.length === 0 ? (
          <p className="text-xs text-fg-muted">No saved logins for this site.</p>
        ) : (
          <>
            {matches.matches.length > 1 && <SearchBox value={siteQuery} onChange={setSiteQuery} placeholder="Search this site’s logins…" autoFocus />}
            {siteMatches.length === 0 && <p className="text-xs text-fg-muted">No login for this site matches “{siteQuery}”.</p>}
            <ul className="flex flex-col gap-1.5">
              {siteMatches.map((m) => (
                <MatchRow key={m.id} m={m} onOpen={() => onOpen(m.id)} onFill={() => void fill(m.id)} onCopy={(f) => void copySecret(m.id, f)} />
              ))}
            </ul>
          </>
        )}
        {matches?.tab.insecure && matches.tab.eligible && (
          <p className="mt-1.5 flex items-center gap-1 text-[11px] text-warn">
            <ShieldAlert className="size-3" /> This page is not using HTTPS.
          </p>
        )}
      </section>

      <section aria-labelledby="pv-all">
        <h2 id="pv-all" className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          Other websites
          {items ? ` (${others.length}${total > others.length + matchIds.size ? '+' : ''})` : ''}
        </h2>
        <SearchBox value={query} onChange={setQuery} placeholder="Search other websites…" autoFocus={!matches?.matches.length} />
        {!items ? (
          <Spinner />
        ) : others.length === 0 ? (
          <EmptyState title={query ? 'No matching logins' : 'No other logins yet'}>
            {query ? 'Search covers titles, identifiers, usernames, websites and tags.' : 'Save a login from a page, or add one in the dashboard.'}
          </EmptyState>
        ) : (
          <ul className="flex flex-col">
            {others.map((it) => (
              <li key={it.id}>
                <button className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-bg-subtle" onClick={() => onOpen(it.id)}>
                  <TypeIcon type={it.type} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span title={it.title} className="truncate text-sm">
                        {it.title}
                      </span>
                      <IdentifierTag text={it.identifier} />
                    </span>
                    <span className="block truncate text-[11px] text-fg-subtle">{it.subtitle}</span>
                  </span>
                  <EnvBadge env={it.environment} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function MatchRow({ m, onOpen, onFill, onCopy }: { m: LoginMatch; onOpen: () => void; onFill: () => void; onCopy: (f: 'username' | 'password') => void }) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5">
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onOpen}>
        <TypeIcon type="login" size="sm" />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span title={m.title} className="truncate text-sm font-medium">
              {m.title}
            </span>
            <IdentifierTag text={m.identifier} />
          </span>
          <span className="block truncate text-[11px] text-fg-subtle">
            {m.username || 'no username'}
            {m.insecure && <span className="ml-1 text-warn">· http</span>}
          </span>
        </span>
      </button>
      <IconButton label="Copy username" size="sm" disabled={!m.username} onClick={() => onCopy('username')}>
        <User className="size-4" />
      </IconButton>
      <IconButton label="Copy password" size="sm" disabled={!m.hasPassword} onClick={() => onCopy('password')}>
        <KeyRound className="size-4" />
      </IconButton>
      <Button size="sm" variant="primary" icon={<LogIn className="size-3.5" />} disabled={!m.hasPassword} onClick={onFill}>
        Fill
      </Button>
    </li>
  );
}

function Detail({ id, tabId, dataVersion, onBack }: { id: string; tabId: number | null; dataVersion: number; onBack: () => void }) {
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fill = useFill(tabId);
  const copy = useCopy();
  useEffect(() => {
    void call({ type: 'item.get', id })
      .then(setItem)
      .catch((e) => setError(errorText(e)));
  }, [id, dataVersion]);
  // Drop decrypted detail from popup memory when leaving the view.
  useEffect(() => () => setItem(null), []);
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <IconButton label="Back" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </IconButton>
        {item && <TypeIcon type={item.type} size="sm" />}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{item?.title ?? ''}</h2>
        {item && <EnvBadge env={item.environment} />}
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      {!item && !error && <Spinner />}
      {item && (
        <>
          <div className="rounded-lg border border-border bg-surface px-3">
            {item.fields.map((f) => (
              <FieldRow key={f.key} label={f.label} value={f.value} secret={f.secret} mono={f.mono} multiline={f.multiline} onCopy={(v) => copy(v, f.secret)} />
            ))}
            {item.urls.map((u, i) => (
              <FieldRow
                key={`url${i}`}
                label={i === 0 ? 'Website' : `Website ${i + 1}`}
                value={u.url}
                mono
                onCopy={(v) => copy(v, false)}
                extra={<span className="ml-1 text-[11px] text-fg-subtle">({u.match.replace('_', ' ')})</span>}
              />
            ))}
            {item.folder && <FieldRow label="Folder" value={item.folder} />}
            {item.tags.length > 0 && <FieldRow label="Tags" value={item.tags.join(', ')} />}
            {item.notes && <FieldRow label="Notes" value={item.notes} multiline secret onCopy={(v) => copy(v, true)} />}
          </div>
          {item.fillable ? (
            <Button variant="primary" icon={<LogIn className="size-4" />} onClick={() => void fill(item.id)} disabled={tabId === null}>
              Fill on this page
            </Button>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-fg-muted">
              <Copy className="size-3.5" /> {typeHint(item)}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function typeHint(item: ItemDetail): ReactNode {
  return `${item.type === 'secure_note' ? 'Notes' : 'Developer secrets'} are never inserted into web pages. Use the copy buttons.`;
}

/** The item's short identifier as a small tag next to its title. */
function IdentifierTag({ text }: { text: string }) {
  if (!text) return null;
  return (
    <span title={text} className="max-w-[45%] shrink-0 truncate rounded bg-surface-3 px-1.5 py-px text-[10px] text-fg-muted">
      {text}
    </span>
  );
}

function SearchBox({ value, onChange, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean }) {
  return (
    <label className="relative mb-1.5 block">
      <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-fg-subtle" aria-hidden />
      <Input
        className="pl-8"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        aria-label={placeholder.replace('…', '')}
      />
    </label>
  );
}

/** Payment cards: fill the checkout form on this tab, or copy a part of the card. */
function CardList({ tabId, dataVersion }: { tabId: number | null; dataVersion: number }) {
  const toast = useToast();
  const copy = useCopy();
  const [cards, setCards] = useState<CardSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void call({ type: 'cards.list' })
      .then((r) => setCards(r.cards))
      .catch((e) => setError(errorText(e)));
  }, [dataVersion]);
  const q = query.trim().toLowerCase();
  const shown = (cards ?? []).filter((c) => !q || [c.title, c.identifier, c.brand, c.last4].some((x) => x.toLowerCase().includes(q)));
  const copyPart = async (id: string, field: 'number' | 'expiry' | 'cvv' | 'cardholder') => {
    try {
      const { value } = await call({ type: 'card.secret', id, field });
      if (!value) return toast('That part of the card is empty.', 'warn');
      await copy(value, field === 'number' || field === 'cvv');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  const fillCard = async (id: string) => {
    if (tabId === null) return;
    try {
      const r = await call({ type: 'card.fill', tabId, itemId: id });
      if (r.status === 'filled') {
        toast(r.filled.length ? `Filled the ${r.filled.join(', ')}.` : 'Found the form, but nothing could be filled.', r.filled.length ? 'success' : 'warn');
        if (r.filled.length) window.close();
      } else toast(r.message, 'warn');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <div className="flex flex-col gap-3 p-3">
      {error && <Banner tone="danger">{error}</Banner>}
      {(cards?.length ?? 0) > 2 && <SearchBox value={query} onChange={setQuery} placeholder="Search cards…" autoFocus />}
      {!cards ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <EmptyState title={q ? 'No matching cards' : 'No cards yet'}>
          {q ? 'Search covers names, identifiers, brands and the last four digits.' : 'Add a payment card in PassVault (dashboard or Mac app).'}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shown.map((c) => (
            <li key={c.id} className="rounded-lg border border-border bg-surface px-2.5 py-2">
              <div className="flex items-center gap-2">
                <TypeIcon type="payment_card" size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span title={c.title} className="truncate text-sm font-medium">
                      {c.title}
                    </span>
                    <IdentifierTag text={c.identifier} />
                  </span>
                  <span className="block truncate text-[11px] text-fg-subtle">
                    {c.brand} •••• {c.last4}
                    {c.expiry && (
                      <span className={c.expired ? 'ml-1 text-danger' : 'ml-1'}>
                        · {c.expired ? 'expired' : 'exp'} {c.expiry}
                      </span>
                    )}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<LogIn className="size-3.5" />}
                  disabled={tabId === null || c.expired}
                  onClick={() => void fillCard(c.id)}
                >
                  Fill
                </Button>
              </div>
              <div className="mt-1.5 flex gap-1 pl-7">
                <Button size="sm" variant="ghost" icon={<Copy className="size-3" />} onClick={() => void copyPart(c.id, 'number')}>
                  Number
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void copyPart(c.id, 'expiry')}>
                  Expiry
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void copyPart(c.id, 'cvv')}>
                  CVV
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void copyPart(c.id, 'cardholder')}>
                  Name
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-fg-subtle">
        Fill works on secure (https) checkout pages. Payment forms embedded from another site can’t be reached — use the copy buttons there.
      </p>
    </div>
  );
}
