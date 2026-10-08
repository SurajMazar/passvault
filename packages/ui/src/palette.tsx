import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { Kbd, cx } from './primitives';

export interface Command {
  id: string;
  label: string;
  group: string;
  hint?: string;
  icon?: ReactNode;
  keywords?: string;
  run: () => void;
}

/** Global command palette (⌘K / Ctrl+K). */
export function CommandPalette({ open, onClose, commands, placeholder = 'Search items and commands…' }: { open: boolean; onClose: () => void; commands: Command[]; placeholder?: string }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);
  const results = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const r = commands.filter((c) => {
      const hay = `${c.label} ${c.group} ${c.keywords ?? ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    return r.slice(0, 60);
  }, [q, commands]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  if (!open) return null;
  let lastGroup = '';
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 backdrop-blur-[2px] p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="pv-animate-in w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 text-fg-subtle" aria-hidden />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="pv-palette-list"
            aria-activedescendant={results[active] ? `pv-cmd-${results[active]!.id}` : undefined}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-fg-subtle"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                const c = results[active];
                if (c) {
                  onClose();
                  c.run();
                }
              }
            }}
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} id="pv-palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1 pv-scroll">
          {results.length === 0 && <div className="px-3 py-6 text-center text-sm text-fg-muted">No matches</div>}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && <div className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{header}</div>}
                <div
                  id={`pv-cmd-${c.id}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => {
                    onClose();
                    c.run();
                  }}
                  className={cx('flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 h-10 text-sm', i === active ? 'bg-accent-soft text-fg' : 'text-fg-muted')}
                >
                  {c.icon && <span className="shrink-0 [&>svg]:size-4">{c.icon}</span>}
                  <span className="flex-1 truncate text-fg">{c.label}</span>
                  {c.hint && <span className="text-xs text-fg-subtle truncate max-w-[40%]">{c.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Logo({ className }: { className?: string }) {
  // Original mark: a rounded vault door with a keyhole notch.
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="var(--pv-accent)" />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke="var(--pv-accent-fg)" strokeWidth="2.4" />
      <circle cx="16" cy="14.2" r="2.4" fill="var(--pv-accent-fg)" />
      <rect x="14.9" y="15" width="2.2" height="5.4" rx="1.1" fill="var(--pv-accent-fg)" />
    </svg>
  );
}

export type ThemePref = 'system' | 'light' | 'dark';

export function applyTheme(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
