import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Loader2 } from 'lucide-react';

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'sm' | 'md' | 'lg';

const variantClass: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border border-transparent shadow-sm disabled:bg-surface-3 disabled:text-fg-subtle disabled:shadow-none',
  secondary: 'bg-surface text-fg border border-border-strong hover:bg-surface-2 hover:border-fg-subtle/40 shadow-[var(--pv-shadow-card)]',
  ghost: 'bg-transparent text-fg-muted hover:text-fg hover:bg-surface-3 border border-transparent',
  danger: 'bg-danger text-white hover:brightness-110 border border-transparent shadow-sm dark:text-black',
  subtle: 'bg-surface-3 text-fg border border-transparent hover:bg-border',
};
const sizeClass: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-lg',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'pv-press inline-flex items-center justify-center font-medium whitespace-nowrap select-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 disabled:cursor-not-allowed disabled:opacity-70',
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary' | 'danger';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'ghost', className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40',
        size === 'sm' ? 'size-7' : 'size-9',
        variant === 'ghost' && 'text-fg-muted hover:text-fg hover:bg-surface-3',
        variant === 'secondary' && 'text-fg border border-border-strong bg-surface hover:bg-surface-2',
        variant === 'danger' && 'text-danger hover:bg-danger-soft',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export const inputBase =
  'w-full rounded-lg border border-border-strong bg-surface text-fg placeholder:text-fg-subtle px-3 text-sm shadow-[inset_0_1px_1px_rgb(0_0_0/0.03)] transition-[border-color,box-shadow] focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/15 focus-visible:outline-none disabled:opacity-60 disabled:bg-surface-3 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/15';

/**
 * Text fields hold hostnames, usernames, keys, commands and names: macOS/iOS
 * autocorrect, auto-capitalisation and spell-check would silently change them.
 * Off by default; a field can still opt in.
 */
const noAutocorrect = { autoCorrect: 'off', autoCapitalize: 'off', spellCheck: false } as const;

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(inputBase, 'h-9', className)} {...noAutocorrect} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(inputBase, 'py-2 min-h-20 leading-relaxed pv-scroll', className)} {...noAutocorrect} {...rest} />;
});

/** Splits "a, b,c" into trimmed, unique, non-empty tags. */
export function splitTags(text: string): string[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Tags as chips: a comma or Enter turns the typed text into a tag, Backspace in an
 * empty field removes the last one, pasting "a, b, c" adds three, and leaving the
 * field keeps what was typed.
 */
export function TagInput(props: { id?: string; value: string[]; onChange: (tags: string[]) => void; describedBy?: string; placeholder?: string; maxTags?: number }) {
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const next = [...props.value];
    for (const t of splitTags(raw)) if (!next.includes(t)) next.push(t);
    const capped = props.maxTags ? next.slice(0, props.maxTags) : next;
    if (capped.length !== props.value.length) props.onChange(capped);
  };
  const remove = (i: number) => props.onChange(props.value.filter((_, j) => j !== i));
  return (
    <div
      className={cx(inputBase, 'flex min-h-9 flex-wrap items-center gap-1.5 py-1.5 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15')}
      onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}
    >
      {props.value.map((t, i) => (
        <span key={t} className="inline-flex max-w-full items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-xs text-accent">
          <span className="truncate">{t}</span>
          <button type="button" aria-label={`Remove tag ${t}`} className="opacity-70 hover:opacity-100" onClick={() => remove(i)}>
            ×
          </button>
        </span>
      ))}
      <input
        id={props.id}
        aria-describedby={props.describedBy}
        value={text}
        placeholder={props.value.length ? '' : props.placeholder}
        className="min-w-24 flex-1 bg-transparent text-sm outline-none"
        {...noAutocorrect}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(',')) {
            const cut = v.lastIndexOf(',');
            add(v.slice(0, cut));
            setText(v.slice(cut + 1).trimStart());
          } else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) {
            e.preventDefault();
            add(text);
            setText('');
          } else if (e.key === 'Backspace' && !text && props.value.length) {
            remove(props.value.length - 1);
          }
        }}
        onBlur={() => {
          if (text.trim()) add(text);
          setText('');
        }}
      />
    </div>
  );
}

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(inputBase, 'h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Field(props: { label: ReactNode; hint?: ReactNode; error?: string | null; children: (id: string, describedBy?: string) => ReactNode; className?: string }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [props.hint ? hintId : null, props.error ? errId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('flex flex-col gap-1.5', props.className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-fg">
        {props.label}
      </label>
      {props.children(id, describedBy)}
      {props.hint && (
        <p id={hintId} className="text-xs leading-relaxed text-fg-subtle">
          {props.hint}
        </p>
      )}
      {props.error && (
        <p id={errId} role="alert" className="text-xs text-danger">
          {props.error}
        </p>
      )}
    </div>
  );
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <button
        id={id}
        role="switch"
        type="button"
        aria-checked={props.checked}
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
        className={cx(
          'mt-0.5 relative inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50',
          props.checked ? 'bg-accent border-accent' : 'bg-bg-subtle border-border-strong',
        )}
      >
        <span className={cx('absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-transform duration-200 ease-[cubic-bezier(0.3,1.4,0.5,1)]', props.checked ? 'translate-x-4' : 'translate-x-0.5')} />
      </button>
      <label htmlFor={id} className="text-sm cursor-pointer">
        <span className="text-fg">{props.label}</span>
        {props.description && <span className="block text-xs text-fg-subtle">{props.description}</span>}
      </label>
    </div>
  );
}

export function Checkbox(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
      <input type="checkbox" className="size-4 accent-[var(--pv-accent)]" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  );
}

type Tone = 'neutral' | 'accent' | 'danger' | 'warn' | 'ok' | 'prod';
const toneClass: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-fg-muted border-transparent',
  accent: 'bg-accent-soft text-accent border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  prod: 'bg-prod-soft text-prod border-prod/40',
};

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-full border px-2 h-5 text-[11px] font-medium whitespace-nowrap', toneClass[tone], className)}>
      {children}
    </span>
  );
}

export function Banner({ tone = 'neutral', title, children, action, icon }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('flex gap-3 rounded-xl border px-3.5 py-3 text-sm leading-relaxed', toneClass[tone])}>
      {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
      <div className="flex-1 min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cx(title ? 'mt-0.5' : '', 'text-fg-muted')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading', className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cx('inline-flex items-center gap-2 text-fg-muted', className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded bg-bg-subtle', className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong bg-surface-2 px-1 font-mono text-[10px] text-fg-muted">{children}</kbd>;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-14 gap-2">
      {icon && <div className="text-fg-subtle mb-1">{icon}</div>}
      <div className="font-semibold text-fg">{title}</div>
      {children && <div className="text-sm text-fg-muted max-w-sm">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-border bg-surface shadow-[var(--shadow-card)]', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 h-12">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: Array<{ id: T; label: ReactNode }>; label: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-border">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              const n = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
              onChange(tabs[n]!.id);
              refs.current[n]?.focus();
            }
          }}
          className={cx(
            '-mb-px border-b-2 px-3 h-10 text-sm font-medium whitespace-nowrap transition-colors',
            value === t.id ? 'border-accent text-fg' : 'border-transparent text-fg-subtle hover:text-fg',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Calls handler when Escape is pressed (used by dialogs/panels). */
export function useEscape(handler: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handler();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [handler, enabled]);
}
