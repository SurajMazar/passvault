import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { Copy, Dices, Eye, EyeOff, Fingerprint, KeyRound, Lock, Maximize2, Minus, Plug, Send, Server, StickyNote, Terminal, Upload, X } from 'lucide-react';
import { generatePassphrase, generatePassword } from '@passvault/crypto';
import { ITEM_TYPE_LABELS, type ItemPayload } from '@passvault/types';
import { Badge, Banner, Button, Field, Input, TextArea, cx } from '@passvault/ui';
import { computeInsights, filterItems, matchLogin, newItem, type DecryptedItem, type SessionSnapshot, type VaultSession } from '@passvault/vault-core';
import type { MenuBar } from '../shell/menu-bar';
import { formatShortcut } from '../shell/shortcut';
import { AVATARS, Avatar, GREETING, RING, avatarFromFile, type AvatarChoice, type Reaction } from './avatars';
import { HELP_LINES, findTargets, parseIntent, resolveOne } from './assistant';

export type BuddyPanel = 'find' | 'save' | 'generate' | 'avatar';

export interface BuddyActions {
  copySecret(text: string, clearAfterSeconds: number): Promise<unknown>;
  copyText(text: string): Promise<unknown>;
  /** open an item (or the vault) in the full window */
  openInApp(itemId?: string): void;
  /** app-managed SSH session for a saved server (opens the terminal in the full window) */
  connect(itemId: string): Promise<unknown>;
  biometricsAvailable(): Promise<boolean>;
  openSettings(): void;
}

/** Which panel the menu bar or a shortcut asked for (Save a credential…, Generate password…). */
export class BuddyNav {
  private panel: BuddyPanel = 'find';
  private seq = 0;
  private listeners = new Set<() => void>();
  get current() {
    return { panel: this.panel, seq: this.seq };
  }
  open(p: BuddyPanel) {
    this.panel = p;
    this.seq++;
    for (const l of this.listeners) l();
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

const subtitle = (it: DecryptedItem): string => {
  const p = it.payload;
  switch (p.type) {
    case 'login':
      return p.fields.username || p.fields.urls[0]?.url || 'Login';
    case 'ssh_connection':
      return `${p.fields.username ? `${p.fields.username}@` : ''}${p.fields.host}${p.fields.port && p.fields.port !== 22 ? `:${p.fields.port}` : ''}`;
    case 'env_file':
      return [p.fields.filename || '.env', p.environment].filter(Boolean).join(' · ');
    default:
      return ITEM_TYPE_LABELS[p.type];
  }
};

const ICON: Partial<Record<ItemPayload['type'], typeof KeyRound>> = { login: KeyRound, ssh_connection: Server, ssh_key: Terminal, env_file: Terminal, secure_note: StickyNote };

function useSnapshot(session: VaultSession): SessionSnapshot {
  return useSyncExternalStore(
    (cb) => session.subscribe(() => cb()),
    () => session.getSnapshot(),
  );
}

/**
 * The menu-bar buddy: a small always-on-top panel (see shell/menu-bar.ts)
 * sharing the app's vault session. It never shows a secret value; copies go
 * through the desktop clipboard with auto-clear.
 */
type Say = { text: string; tone?: 'ok' | 'warn' | 'error'; choices?: Array<{ label: string; sub?: string; run: () => void }> };
type View = { kind: 'home' } | { kind: 'results'; query: string } | { kind: 'save'; site: string; seq: number } | { kind: 'generate'; length: number; passphrase: boolean; seq: number } | { kind: 'avatar' };

const PASSWORD_TYPES: Array<ItemPayload['type']> = ['login', 'ssh_connection', 'database', 'api_credential'];

function secretOf(it: DecryptedItem, field: 'password' | 'username'): string {
  const p = it.payload as ItemPayload & { fields: Record<string, unknown> };
  const v = field === 'username' ? p.fields.username : (p.fields.password ?? p.fields.secret ?? p.fields.apiKey);
  return typeof v === 'string' ? v : '';
}

/**
 * The menu-bar buddy as an assistant: an animated character with a speech
 * bubble, an "Ask me…" box that understands short commands (assistant.ts —
 * local, no AI service), suggestion chips, and quick Find / Save / Generate.
 * It shares the app's vault session; replies never contain secret values.
 */
export function BuddyView({ session, menuBar, nav, actions, serverLabel }: { session: VaultSession; menuBar: MenuBar; nav: BuddyNav; actions: BuddyActions; serverLabel: string }) {
  const snap = useSnapshot(session);
  useSyncExternalStore(
    (cb) => menuBar.subscribe(cb),
    () => menuBar.state + String(menuBar.settings.quiet) + JSON.stringify(menuBar.settings.avatar).length,
  );
  const navSeq = useSyncExternalStore(
    (cb) => nav.subscribe(cb),
    () => nav.current.seq,
  );
  const [view, setView] = useState<View>({ kind: 'home' });
  const [say, setSay] = useState<Say>({ text: GREETING[menuBar.state] });
  const [sayKey, setSayKey] = useState(0);
  const [reaction, setReaction] = useState<{ r: Reaction; k: number }>({ r: null, k: 0 });
  const [ask, setAsk] = useState('');
  const state = menuBar.state;
  const phase = snap.auth.phase;
  const quiet = menuBar.settings.quiet;
  const secs = snap.settings.clipboardClearSeconds;

  const speak = (next: Say, r: Reaction = null) => {
    setSay(next);
    setSayKey((k) => k + 1);
    if (r) setReaction((x) => ({ r, k: x.k + 1 }));
  };

  // Menu-bar requests ("Save a credential…", "Generate password…").
  useEffect(() => {
    if (!navSeq) return;
    const p = nav.current.panel;
    if (p === 'save') setView({ kind: 'save', site: '', seq: navSeq });
    else if (p === 'generate') setView({ kind: 'generate', length: 20, passphrase: false, seq: navSeq });
  }, [navSeq, nav]);

  // Greeting, and a proactive nudge after unlocking (not in quiet mode).
  const unlocked = phase === 'unlocked';
  useEffect(() => {
    if (!unlocked) {
      setSay({ text: GREETING[state] });
      return;
    }
    if (quiet) return setSay({ text: 'Ready when you are.' });
    const ins = computeInsights(snap.items);
    const attention = ins.weak.length + ins.reused.reduce((n, r) => n + r.ids.length, 0);
    setSay(
      attention > 0
        ? { text: `Welcome back! ${attention} saved password${attention === 1 ? '' : 's'} could be stronger or unique. Ask me for a new one any time.`, tone: 'warn' }
        : { text: `Welcome back! ${snap.items.filter((i) => !i.payload.trashedAt).length} items, all looking healthy. What do you need?` },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, quiet]);
  useEffect(() => {
    if (unlocked) return;
    setSay({ text: GREETING[state] });
  }, [state, unlocked]);

  const copy = (it: DecryptedItem, field: 'password' | 'username') => {
    const v = secretOf(it, field);
    if (!v) return speak({ text: `“${it.payload.title}” has no ${field} saved.`, tone: 'warn' }, 'shake');
    const done = () => speak({ text: field === 'password' ? `Copied the password for “${it.payload.title}”${secs > 0 ? ` — I’ll clear the clipboard in ${secs}s` : ''}.` : `Copied the username for “${it.payload.title}”.`, tone: 'ok' }, 'hop');
    void (field === 'password' ? actions.copySecret(v, secs) : actions.copyText(v)).then(done, () => speak({ text: 'I couldn’t use the clipboard.', tone: 'error' }, 'shake'));
  };
  const choose = (items: DecryptedItem[], question: string, run: (it: DecryptedItem) => void) =>
    speak({ text: question, choices: items.slice(0, 5).map((it) => ({ label: it.payload.title || 'Untitled', sub: subtitle(it), run: () => run(it) })) });

  const handle = (raw: string) => {
    const intent = parseIntent(raw);
    setAsk('');
    switch (intent.kind) {
      case 'help':
        setView({ kind: 'home' });
        return speak({ text: `Try: ${HELP_LINES.join(' · ')}` });
      case 'lock':
        session.lock();
        return;
      case 'settings':
        actions.openSettings();
        return;
      case 'generate':
        setView({ kind: 'generate', length: intent.length, passphrase: intent.passphrase, seq: Date.now() });
        return speak({ text: intent.passphrase ? `Here’s a ${intent.length}-word passphrase. Copy it, or save it with a login.` : `Here’s a fresh ${intent.length}-character password. Copy it, or save it with a login.`, tone: 'ok' }, 'hop');
      case 'save':
        setView({ kind: 'save', site: intent.site, seq: Date.now() });
        return speak({ text: intent.site ? `Let’s save your login for ${intent.site}. Check the details, then Save.` : 'Let’s save a login. Fill in what you have — the password stays hidden.' });
      case 'copy': {
        const found = findTargets(snap.items, intent.query, intent.field === 'password' ? PASSWORD_TYPES : ['login', 'database', 'ssh_connection']);
        if (!found.length) return speak({ text: `I couldn’t find “${intent.query}”. Want to save it? Say “save login for ${intent.query}”.`, tone: 'warn' }, 'shake');
        const one = resolveOne(found);
        if (one) return copy(one, intent.field);
        return choose(found, `Which “${intent.query}”? I’ll copy its ${intent.field}.`, (it) => copy(it, intent.field));
      }
      case 'connect': {
        const found = findTargets(snap.items, intent.query, ['ssh_connection']);
        if (!found.length) return speak({ text: `No saved server matches “${intent.query}”.`, tone: 'warn' }, 'shake');
        const go = (it: DecryptedItem) => {
          speak({ text: `Connecting to “${it.payload.title}” — I’ll ask before using any credential.`, tone: 'ok' }, 'hop');
          void actions.connect(it.id).catch((e: unknown) => speak({ text: e instanceof Error ? e.message : 'Could not connect.', tone: 'error' }, 'shake'));
        };
        const one = resolveOne(found);
        return one ? go(one) : choose(found, `Which server for “${intent.query}”?`, go);
      }
      case 'open': {
        const found = findTargets(snap.items, intent.query);
        const one = resolveOne(found);
        if (one) return actions.openInApp(one.id);
        setView({ kind: 'results', query: intent.query });
        return speak({ text: found.length ? `I found ${found.length} matches for “${intent.query}”.` : `Nothing matches “${intent.query}”.` }, found.length ? null : 'shake');
      }
      case 'search': {
        setView({ kind: 'results', query: intent.query });
        const n = findTargets(snap.items, intent.query).length;
        return speak({ text: n ? `Here’s what I found for “${intent.query}”.` : `Nothing matches “${intent.query}”. Try “help”.` }, n ? null : 'shake');
      }
    }
  };

  const header = useRef<HTMLDivElement>(null);
  const headerButtons = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!header.current) return;
    return menuBar.makeDraggable(header.current, { exclude: headerButtons.current ? [headerButtons.current] : [] });
  }, [menuBar]);

  const shortcut = menuBar.settings.shortcut;
  const chips: Array<[string, () => void]> = unlocked
    ? [
        ['Find', () => setView({ kind: 'results', query: '' })],
        ['Save a login', () => handle('save')],
        ['New password', () => handle('new password')],
        ['Lock', () => handle('lock')],
      ]
    : [];

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border-strong bg-bg text-fg" data-testid="buddy">
      <div ref={header} className="flex cursor-grab items-center gap-2 px-3 pt-2 pb-1 select-none active:cursor-grabbing" title="Drag to move">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold">
            PassVault
            {quiet && <Badge>Quiet</Badge>}
          </div>
          <div className="truncate text-[10.5px] text-fg-subtle" title={serverLabel}>
            {serverLabel}
          </div>
        </div>
        <div ref={headerButtons} className="flex items-center gap-0.5">
          <Button size="sm" variant="ghost" aria-label="Minimize the buddy" title={menuBar.settings.bubbleOnClose ? 'Minimize to the bubble' : 'Minimize to the menu bar'} onClick={() => void menuBar.minimizeBuddy()}>
            <Minus className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Open the full app" title="Open the full app" onClick={() => actions.openInApp()}>
            <Maximize2 className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Hide (stays in the menu bar)" title={`Hide to the menu bar${shortcut ? ` · ${formatShortcut(shortcut)} brings it back` : ''}`} onClick={() => void menuBar.hide()}>
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* The character and what it says */}
      <div className="flex items-end gap-2.5 px-3 pb-2">
        <button
          className="shrink-0 rounded-full p-0.5"
          style={{ boxShadow: `0 0 0 2px ${RING[state]}` }}
          aria-label="Change the buddy’s avatar"
          title="Change avatar"
          onClick={() => setView(view.kind === 'avatar' ? { kind: 'home' } : { kind: 'avatar' })}
        >
          <Avatar choice={menuBar.settings.avatar} state={state} size={56} reaction={reaction.r} reactionKey={reaction.k} />
        </button>
        <div key={sayKey} className={cx('pv-say relative mb-1 min-w-0 flex-1 rounded-2xl rounded-bl-sm border px-3 py-2 text-[13px] leading-snug', say.tone === 'error' ? 'border-danger/40 bg-danger-soft' : say.tone === 'warn' ? 'border-warn/40 bg-warn-soft' : say.tone === 'ok' ? 'border-ok/30 bg-ok-soft' : 'border-border bg-surface-2')} role="status" aria-live="polite">
          {say.text}
          {say.choices && (
            <div className="mt-2 flex flex-col gap-1">
              {say.choices.map((c) => (
                <button key={c.label + (c.sub ?? '')} onClick={c.run} className="rounded-lg border border-border bg-bg px-2 py-1 text-left hover:bg-surface-3">
                  <div className="truncate text-xs font-medium">{c.label}</div>
                  {c.sub && <div className="truncate text-[11px] text-fg-subtle">{c.sub}</div>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
        {view.kind === 'avatar' ? (
          <div className="p-3">
            <AvatarPicker value={menuBar.settings.avatar} state={state} onChange={(a) => menuBar.update({ avatar: a }).then(() => speak({ text: 'New look! How do I seem?', tone: 'ok' }, 'hop'))} />
            <Button className="mt-3 w-full" onClick={() => setView({ kind: 'home' })}>
              Done
            </Button>
          </div>
        ) : phase === 'locked' ? (
          <Unlock session={session} actions={actions} onFail={() => speak({ text: 'That’s not it — try again?', tone: 'error' }, 'shake')} />
        ) : !unlocked ? (
          <div className="flex flex-col gap-3 p-4 text-sm">
            <p className="text-fg-muted">Sign in to {serverLabel} in the full app first — I use the same session.</p>
            <Button variant="primary" onClick={() => actions.openInApp()}>
              Open PassVault
            </Button>
          </div>
        ) : view.kind === 'save' ? (
          <QuickSave key={`save-${view.seq}`} session={session} snap={snap} initialSite={view.site} flash={(m) => speak({ text: m, tone: 'ok' }, 'hop')} onDone={() => setView({ kind: 'home' })} />
        ) : view.kind === 'generate' ? (
          <Generate key={`gen-${view.seq}`} actions={actions} snap={snap} initialLength={view.length} passphrase={view.passphrase} flash={(m) => speak({ text: m, tone: 'ok' }, 'hop')} onUse={(pw) => {
            pendingPassword = pw;
            setView({ kind: 'save', site: '', seq: Date.now() });
            speak({ text: 'Great pick. Where is this password for?' });
          }} />
        ) : view.kind === 'results' ? (
          <Find snap={snap} actions={actions} initialQuery={view.query} flash={(m) => speak({ text: m, tone: 'ok' }, 'hop')} />
        ) : (
          <div className="flex flex-col gap-2 p-3">
            <p className="text-[11px] text-fg-subtle">Try “copy github password”, “new password 24”, “ssh prod” or “save login for netflix”.</p>
          </div>
        )}
      </div>

      {unlocked && view.kind !== 'avatar' && (
        <div className="border-t border-border px-3 pt-2 pb-2.5">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {chips.map(([label, run]) => (
              <button key={label} onClick={run} className="rounded-full border border-border px-2.5 py-1 text-[11px] text-fg-muted hover:bg-surface-2 hover:text-fg">
                {label}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (ask.trim()) handle(ask);
            }}
            className="flex gap-1.5"
          >
            <Input autoFocus value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Ask me… e.g. copy github password" aria-label="Ask the buddy" />
            <Button type="submit" variant="primary" disabled={!ask.trim()} aria-label="Ask">
              <Send className="size-4" />
            </Button>
          </form>
        </div>
      )}
      {!unlocked && (
        <div className="border-t border-border px-3 py-2 text-[11px] text-fg-subtle">{shortcut ? `${formatShortcut(shortcut)} shows or hides me` : 'I live in the menu bar'}</div>
      )}
    </div>
  );
}

/** Built-in characters and "your own picture" (re-encoded locally; never uploaded). */
export function AvatarPicker({ value, state, onChange }: { value: AvatarChoice; state: Parameters<typeof Avatar>[0]['state']; onChange: (a: AvatarChoice) => Promise<unknown> }) {
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = (a: AvatarChoice) => {
    setError(null);
    onChange(a).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-fg-muted">Choose your buddy</div>
      <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Avatar">
        {AVATARS.map((a) => {
          const selected = value.kind === 'builtin' && value.id === a.id;
          return (
            <button
              key={a.id}
              role="radio"
              aria-checked={selected}
              aria-label={a.name}
              title={a.name}
              onClick={() => pick({ kind: 'builtin', id: a.id })}
              className={cx('flex flex-col items-center gap-1 rounded-xl border p-2 text-[11px]', selected ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2')}
            >
              <Avatar choice={{ kind: 'builtin', id: a.id }} state={state} size={40} />
              {a.name}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        {value.kind === 'custom' && <Avatar choice={value} state={state} size={40} />}
        <Button size="sm" icon={<Upload className="size-3.5" />} onClick={() => file.current?.click()}>
          {value.kind === 'custom' ? 'Change picture' : 'Use my own picture'}
        </Button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void avatarFromFile(f).then((dataUrl) => pick({ kind: 'custom', dataUrl }), (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
          }}
        />
      </div>
      <p className="text-[11px] text-fg-subtle">Your picture is resized on this Mac and stored only here.</p>
      {error && <Banner tone="danger">{error}</Banner>}
    </div>
  );
}

/** Minimized buddy: the avatar alone, with a ring in the vault-state colour. Click to open; drag to move. */
/** `preview`: drawn over the card while it morphs (not interactive, not draggable). */
export function BuddyBubble({ menuBar, preview = false }: { menuBar: MenuBar; preview?: boolean }) {
  useSyncExternalStore(
    (cb) => menuBar.subscribe(cb),
    () => menuBar.state + JSON.stringify(menuBar.settings.avatar).length,
  );
  const el = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!el.current || preview) return;
    return menuBar.makeDraggable(el.current, { onClick: () => void menuBar.showBuddy() });
  }, [menuBar, preview]);
  const state = menuBar.state;
  return (
    <div className="flex h-full items-center justify-center" data-testid={preview ? undefined : 'buddy-bubble'} aria-hidden={preview || undefined}>
      <button
        ref={el}
        tabIndex={preview ? -1 : undefined}
        aria-label={`PassVault buddy — ${GREETING[state]} Click to open, drag to move.`}
        title={`${GREETING[state]}\nClick to open · drag to move`}
        className={cx('pv-bubble grid size-[78px] cursor-pointer place-items-center overflow-hidden rounded-full', state === 'awaiting_approval' && 'pv-bubble-alert')}
        style={{ background: 'radial-gradient(circle at 50% 38%, #2a3644, #151c25 70%)', boxShadow: `0 0 0 3px ${RING[state]}, 0 3px 8px rgba(0,0,0,.45)` }}
      >
        <Avatar choice={menuBar.settings.avatar} state={state} size={70} />
      </button>
    </div>
  );
}

/** Password handed from Generate to Save (kept only in memory, never rendered). */
let pendingPassword: string | null = null;

function Unlock({ session, actions, onFail }: { session: VaultSession; actions: BuddyActions; onFail?: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bio, setBio] = useState(false);
  useEffect(() => {
    void actions.biometricsAvailable().then(setBio, () => setBio(false));
  }, [actions]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await session.unlock(pw);
      setPw('');
    } catch {
      setError('That master password is not correct.');
      onFail?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <Lock className="size-4" aria-hidden /> Unlock to use your saved credentials.
      </div>
      <Field label="Master password">
        {(id) => <Input id={id} type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />}
      </Field>
      {error && <Banner tone="danger">{error}</Banner>}
      <Button type="submit" variant="primary" loading={busy} disabled={!pw}>
        Unlock
      </Button>
      {bio && (
        <Button
          type="button"
          icon={<Fingerprint className="size-4" />}
          onClick={() => void session.unlockWithBiometrics().catch(() => setError('Touch ID did not unlock the vault.'))}
        >
          Unlock with Touch ID
        </Button>
      )}
    </form>
  );
}

function Find({ snap, actions, flash, initialQuery = '' }: { snap: SessionSnapshot; actions: BuddyActions; flash: (m: string) => void; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const results = useMemo(() => filterItems(snap.items, { query: q, status: 'active' }).slice(0, 40), [snap.items, q]);
  const secs = snap.settings.clipboardClearSeconds;
  const copySecret = (label: string, value: string) =>
    void actions.copySecret(value, secs).then(() => flash(`${label} copied${secs > 0 ? ` — clipboard clears in ${secs}s` : ''}`));
  const copyText = (label: string, value: string) => void actions.copyText(value).then(() => flash(`${label} copied`));
  return (
    <div className="flex flex-col gap-2 p-3">
      <Input placeholder="Search logins, servers, env files, notes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
      {results.length === 0 && <p className="px-1 py-4 text-center text-xs text-fg-subtle">{q ? 'Nothing matches.' : 'Your vault is empty.'}</p>}
      <ul className="flex flex-col gap-1">
        {results.map((it) => {
          const p = it.payload;
          const I = ICON[p.type] ?? KeyRound;
          const acts: ReactNode[] = [];
          if (p.type === 'login') {
            if (p.fields.username) acts.push(<Act key="u" label="Copy username" onClick={() => copyText('Username', p.fields.username)} icon={<Copy className="size-3" />} text="User" />);
            if (p.fields.password) acts.push(<Act key="p" label="Copy password" onClick={() => copySecret('Password', p.fields.password)} icon={<KeyRound className="size-3" />} text="Password" />);
          } else if (p.type === 'ssh_connection') {
            acts.push(<Act key="c" label={`Connect to ${p.fields.host}`} onClick={() => void actions.connect(it.id).catch((e: unknown) => flash(e instanceof Error ? e.message : 'Could not connect'))} icon={<Plug className="size-3" />} text="Connect" />);
            if (p.fields.password) acts.push(<Act key="p" label="Copy password" onClick={() => copySecret('Password', p.fields.password!)} icon={<KeyRound className="size-3" />} text="Password" />);
          } else if (p.type === 'env_file') {
            if (p.fields.content) acts.push(<Act key="e" label="Copy the file contents" onClick={() => copySecret('Variables', p.fields.content)} icon={<Copy className="size-3" />} text=".env" />);
          } else if (p.type === 'secure_note') {
            const body = p.fields.content ?? '';
            if (body) acts.push(<Act key="n" label="Copy note" onClick={() => copySecret('Note', body)} icon={<Copy className="size-3" />} text="Copy" />);
          }
          return (
            <li key={it.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-2">
              <I className="size-4 shrink-0 text-fg-subtle" aria-hidden />
              <button className="min-w-0 flex-1 text-left" onClick={() => actions.openInApp(it.id)} title="Open in PassVault">
                <div className="truncate text-sm font-medium">{p.title || 'Untitled'}</div>
                <div className="truncate text-xs text-fg-subtle">{subtitle(it)}</div>
              </button>
              <div className="flex shrink-0 gap-1">{acts}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Act({ label, onClick, icon, text }: { label: string; onClick: () => void; icon: ReactNode; text: string }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className="flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] text-fg-muted hover:bg-surface-3 hover:text-fg">
      {icon}
      {text}
    </button>
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).host;
  } catch {
    return null;
  }
}

/**
 * Quick "Save credential": review title, username, website or server,
 * category, tags and notes before saving; the password is masked by default.
 * If a login for the same site and username exists, the user chooses between
 * updating it, choosing another existing item, or saving a new one.
 */
function QuickSave({ session, snap, flash, onDone, initialSite = '' }: { session: VaultSession; snap: SessionSnapshot; flash: (m: string) => void; onDone: () => void; initialSite?: string }) {
  const [title, setTitle] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState(() => {
    const p = pendingPassword ?? '';
    pendingPassword = null;
    return p;
  });
  const [show, setShow] = useState(false);
  const [site, setSite] = useState(initialSite);
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  const [target, setTarget] = useState<'new' | string>('new');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const url = site.trim() ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(site.trim()) ? site.trim() : `https://${site.trim()}`) : '';
  const logins = snap.items.filter((i) => i.payload.type === 'login' && !i.payload.trashedAt && i.role !== 'viewer');
  const matches = url ? logins.filter((i) => i.payload.type === 'login' && !!matchLogin(i.payload.fields.urls, url) && i.payload.fields.username.trim().toLowerCase() === username.trim().toLowerCase()) : [];
  useEffect(() => {
    setTarget(matches[0]?.id ?? 'new');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, username]);
  const folders = [...new Set(snap.items.map((i) => i.payload.folder).filter(Boolean))].sort();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!password) return setError('Enter the password to save.');
    if (url && !hostOf(url)) return setError('Enter a website address like example.com, or leave it empty.');
    setBusy(true);
    try {
      const tagList = tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20);
      if (target !== 'new') {
        await session.updateItem(target, (p) => {
          if (p.type !== 'login') return;
          p.fields.password = password;
          if (username) p.fields.username = username;
          if (notes.trim()) p.notes = p.notes ? `${p.notes}\n\n${notes.trim()}` : notes.trim();
          if (category) p.folder = category;
          if (tagList.length) p.tags = [...new Set([...p.tags, ...tagList])];
        });
        flash('Login updated');
      } else {
        await session.saveItem(
          newItem('login', {
            title: title.trim() || hostOf(url) || username || 'Login',
            folder: category.trim(),
            tags: tagList,
            notes: notes.trim(),
            fields: { username: username.trim(), password, urls: url ? [{ url, match: 'host' }] : [] },
          }),
        );
        flash('Saved to PassVault');
      }
      setPassword('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2.5 p-3" aria-label="Save a credential">
      <Field label="Website or server">{(id) => <Input id={id} placeholder="example.com" value={site} onChange={(e) => setSite(e.target.value)} autoFocus />}</Field>
      <Field label="Username">{(id) => <Input id={id} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
      <Field label="Password">
        {(id) => (
          <div className="flex gap-1.5">
            <Input id={id} type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <Button type="button" variant="ghost" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((v) => !v)}>
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
            <Button type="button" variant="ghost" aria-label="Generate a password" title="Generate" onClick={() => setPassword(generatePassword({ length: 20 }))}>
              <Dices className="size-4" />
            </Button>
          </div>
        )}
      </Field>
      {matches.length > 0 && (
        <Field label="Saved login for this site">
          {(id) => (
            <select id={id} className="pv-select h-9 cursor-pointer appearance-none rounded-lg border border-border bg-surface pl-2 pr-9 text-sm" value={target} onChange={(e) => setTarget(e.target.value)}>
              {matches.map((m) => (
                <option key={m.id} value={m.id}>
                  Update “{m.payload.title}”
                </option>
              ))}
              <option value="new">Save as a new item</option>
            </select>
          )}
        </Field>
      )}
      {target === 'new' && <Field label="Title (optional)">{(id) => <Input id={id} placeholder={hostOf(url) ?? 'Login'} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Category">
          {(id) => (
            <>
              <Input id={id} list="buddy-folders" value={category} onChange={(e) => setCategory(e.target.value)} />
              <datalist id="buddy-folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Tags">{(id) => <Input id={id} placeholder="work, admin" value={tags} onChange={(e) => setTags(e.target.value)} />}</Field>
      </div>
      <Field label="Notes">{(id) => <TextArea id={id} rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          {target === 'new' ? 'Save' : 'Update'}
        </Button>
      </div>
    </form>
  );
}

function Generate({ actions, snap, flash, onUse, initialLength = 20, passphrase = false }: { actions: BuddyActions; snap: SessionSnapshot; flash: (m: string) => void; onUse: (pw: string) => void; initialLength?: number; passphrase?: boolean }) {
  const make = (n: number) => (passphrase ? generatePassphrase({ words: n }) : generatePassword({ length: n }));
  const [length, setLength] = useState(initialLength);
  const [value, setValue] = useState(() => make(initialLength));
  const [show, setShow] = useState(false);
  const regen = (n = length) => setValue(make(n));
  const secs = snap.settings.clipboardClearSeconds;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm">
        <span className="min-w-0 flex-1 truncate" data-testid="generated">
          {show ? value : '•'.repeat(Math.min(value.length, 24))}
        </span>
        <button aria-label={show ? 'Hide' : 'Show'} onClick={() => setShow((v) => !v)} className="text-fg-subtle hover:text-fg">
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      <label className="flex items-center gap-3 text-xs text-fg-muted">
        {passphrase ? `Words ${length}` : `Length ${length}`}
        <input type="range" min={passphrase ? 3 : 12} max={passphrase ? 12 : 64} value={length} onChange={(e) => {
          const n = Number(e.target.value);
          setLength(n);
          regen(n);
        }} className="flex-1" />
      </label>
      <div className="flex gap-2">
        <Button className="flex-1" icon={<Dices className="size-4" />} onClick={() => regen()}>
          New
        </Button>
        <Button className="flex-1" icon={<Copy className="size-4" />} onClick={() => void actions.copySecret(value, secs).then(() => flash(`Password copied${secs > 0 ? ` — clipboard clears in ${secs}s` : ''}`))}>
          Copy
        </Button>
      </div>
      <Button variant="primary" onClick={() => onUse(value)}>
        Save with this password…
      </Button>
    </div>
  );
}
