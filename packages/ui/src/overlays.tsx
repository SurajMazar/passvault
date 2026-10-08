import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { Button, IconButton, Input, cx } from './primitives';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Accessible modal dialog with focus trap and focus restore. */
export function Dialog(props: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** prevent closing by Escape/backdrop (e.g. while showing a one-time secret) */
  dismissable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const dismissable = props.dismissable ?? true;
  useEffect(() => {
    if (!props.open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) {
        e.stopPropagation();
        props.onClose();
      }
      if (e.key === 'Tab' && el) {
        const nodes = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
        if (!nodes.length) return;
        const f = nodes[0]!;
        const l = nodes[nodes.length - 1]!;
        if (e.shiftKey && document.activeElement === f) {
          e.preventDefault();
          l.focus();
        } else if (!e.shiftKey && document.activeElement === l) {
          e.preventDefault();
          f.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);
  if (!props.open) return null;
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-5xl' }[props.size ?? 'md'];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/45 backdrop-blur-[2px] p-4 sm:pt-[8vh]" onMouseDown={(e) => dismissable && e.target === e.currentTarget && props.onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description ? descId : undefined}
        tabIndex={-1}
        className={cx('pv-animate-in w-full rounded-2xl border border-border bg-surface shadow-[var(--shadow-pop)] outline-none', width)}
      >
        <header className="flex items-start gap-3 px-6 pt-5 pb-4">
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-[17px] font-semibold tracking-tight">
              {props.title}
            </h2>
            {props.description && (
              <p id={descId} className="mt-1 text-sm text-fg-muted">
                {props.description}
              </p>
            )}
          </div>
          {dismissable && (
            <IconButton label="Close" size="sm" onClick={props.onClose}>
              <X className="size-4" />
            </IconButton>
          )}
        </header>
        <div className="px-6 pb-5 max-h-[70vh] overflow-y-auto pv-scroll">{props.children}</div>
        {props.footer && <footer className="flex flex-wrap justify-end gap-2 rounded-b-2xl border-t border-border bg-surface-2 px-6 py-3.5">{props.footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  /** require typing this exact text to confirm (destructive/plaintext operations) */
  typeToConfirm?: string;
}

const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const [typed, setTyped] = useState('');
  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setTyped('');
    setState({ opts, resolve });
  }), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  const o = state?.opts;
  const blocked = !!o?.typeToConfirm && typed !== o.typeToConfirm;
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog
        open={!!state}
        onClose={() => close(false)}
        title={o?.title ?? ''}
        size="sm"
        footer={
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant={o?.tone === 'primary' ? 'primary' : 'danger'} disabled={blocked} onClick={() => close(true)}>
              {o?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-fg-muted">
          {o?.body}
          {o?.typeToConfirm && (
            <label className="block">
              <span className="text-xs">
                Type <code className="font-mono text-fg">{o.typeToConfirm}</code> to confirm
              </span>
              <Input data-autofocus className="mt-1" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
          )}
        </div>
      </Dialog>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmCtx);
}

// ---------------- toasts ----------------

type ToastTone = 'info' | 'success' | 'error' | 'warn';
interface Toast {
  id: number;
  tone: ToastTone;
  message: ReactNode;
}
const ToastCtx = createContext<(message: ReactNode, tone?: ToastTone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((message: ReactNode, tone: ToastTone = 'info') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  const icon = { info: Info, success: CheckCircle2, error: XCircle, warn: AlertTriangle };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div aria-live="polite" className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
          {toasts.map((t) => {
            const I = icon[t.tone];
            return (
              <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} className="pv-animate-in flex items-start gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-3 text-sm shadow-[var(--shadow-pop)]">
                <I className={cx('mt-0.5 size-4 shrink-0', t.tone === 'success' && 'text-ok', t.tone === 'error' && 'text-danger', t.tone === 'warn' && 'text-warn', t.tone === 'info' && 'text-accent')} />
                <div className="flex-1">{t.message}</div>
                <button className="text-fg-subtle hover:text-fg" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

// ---------------- dropdown menu ----------------

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
}

export function Menu({ trigger, items, align = 'right' }: { trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode; items: MenuItem[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => items.filter((i) => !i.hidden), [items]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not([disabled])') ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length]?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    setTimeout(() => ref.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus(), 0);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <div role="menu" className={cx('pv-animate-in absolute z-40 mt-1.5 min-w-52 rounded-xl border border-border bg-surface p-1.5 shadow-[var(--shadow-pop)]', align === 'right' ? 'right-0' : 'left-0')}>
          {visible.map((it, i) => (
            <button
              key={i}
              role="menuitem"
              type="button"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 h-9 text-left text-sm hover:bg-surface-3 focus:bg-surface-3 focus:outline-none disabled:opacity-40',
                it.danger ? 'text-danger' : 'text-fg',
              )}
            >
              {it.icon && <span className="size-4 shrink-0 text-fg-subtle [&>svg]:size-4">{it.icon}</span>}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
