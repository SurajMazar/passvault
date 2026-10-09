import { useEffect, useState, type ReactNode } from 'react';
import {
  Check,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileCode2,
  FolderKanban,
  Globe,
  KeyRound,
  KeySquare,
  Server,
  StickyNote,
} from 'lucide-react';
import { Badge, IconButton, cx, inputBase } from './primitives';

export type ItemTypeKey = 'login' | 'ssh_connection' | 'ssh_key' | 'database' | 'api_credential' | 'env_file' | 'secure_note' | 'project';

const TYPE_ICON = {
  login: Globe,
  ssh_connection: Server,
  ssh_key: KeySquare,
  database: Database,
  api_credential: KeyRound,
  env_file: FileCode2,
  secure_note: StickyNote,
  project: FolderKanban,
} as const;

const TYPE_TINT: Record<ItemTypeKey, string> = {
  login: 'bg-sky-500/12 text-sky-600 dark:text-sky-300',
  ssh_connection: 'bg-violet-500/12 text-violet-600 dark:text-violet-300',
  ssh_key: 'bg-amber-500/14 text-amber-700 dark:text-amber-300',
  database: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  api_credential: 'bg-rose-500/12 text-rose-600 dark:text-rose-300',
  env_file: 'bg-teal-500/14 text-teal-700 dark:text-teal-300',
  secure_note: 'bg-slate-500/14 text-slate-600 dark:text-slate-300',
  project: 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-300',
};

export function TypeIcon({ type, size = 'md' }: { type: ItemTypeKey; size?: 'sm' | 'md' | 'lg' }) {
  const I = TYPE_ICON[type];
  return (
    <span aria-hidden className={cx('inline-flex shrink-0 items-center justify-center', TYPE_TINT[type], size === 'sm' ? 'size-6 rounded-md' : size === 'md' ? 'size-9 rounded-lg' : 'size-12 rounded-xl')}>
      <I className={size === 'lg' ? 'size-6' : size === 'md' ? 'size-[18px]' : 'size-3.5'} />
    </span>
  );
}

export function EnvBadge({ env }: { env: string | null | undefined }) {
  if (!env) return null;
  const e = env.toLowerCase();
  if (e === 'production' || e === 'prod')
    return (
      <Badge tone="prod" title="Production environment">
        ● Production
      </Badge>
    );
  if (e === 'staging') return <Badge tone="warn">Staging</Badge>;
  if (e === 'development' || e === 'dev') return <Badge tone="ok">Development</Badge>;
  return <Badge>{env}</Badge>;
}

export function CopyButton({ onCopy, label = 'Copy', size = 'sm' }: { onCopy: () => Promise<void> | void; label?: string; size?: 'sm' | 'md' }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <IconButton
      label={done ? 'Copied' : label}
      size={size}
      onClick={async () => {
        await onCopy();
        setDone(true);
      }}
    >
      {done ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
    </IconButton>
  );
}

/**
 * A field row for a (possibly secret) value. Secrets are masked by default;
 * the plaintext is only placed in the DOM while revealed.
 */
export function FieldRow(props: {
  label: ReactNode;
  value: string | null | undefined;
  secret?: boolean;
  mono?: boolean;
  multiline?: boolean;
  onCopy?: (value: string) => Promise<void> | void;
  extra?: ReactNode;
  /** auto re-mask after N seconds (default 30) */
  remaskAfter?: number;
}) {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!revealed) return;
    const t = setTimeout(() => setRevealed(false), (props.remaskAfter ?? 30) * 1000);
    return () => clearTimeout(t);
  }, [revealed, props.remaskAfter]);
  const v = props.value ?? '';
  if (!v && !props.extra) return null;
  const masked = props.secret && !revealed;
  return (
    <div className="group grid grid-cols-[minmax(5.5rem,8.5rem)_1fr_auto] items-start gap-3 -mx-2 px-2 py-2.5 rounded-lg border-b border-border/70 last:border-b-0 hover:bg-surface-2">
      <div className="pt-0.5 text-[13px] text-fg-subtle">{props.label}</div>
      <div className={cx('min-w-0 break-words text-sm', (props.mono || props.secret) && 'font-mono', props.multiline && !masked && 'whitespace-pre-wrap')}>
        {masked ? (
          <span className="pv-masked whitespace-nowrap text-fg-muted select-none" aria-label="hidden value">
            ••••••••••
          </span>
        ) : (
          v
        )}
        {props.extra}
      </div>
      <div className="flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {props.secret && (
          <IconButton size="sm" label={revealed ? 'Hide' : 'Reveal'} onClick={() => setRevealed((r) => !r)}>
            {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </IconButton>
        )}
        {props.onCopy && v && <CopyButton label={`Copy ${typeof props.label === 'string' ? props.label.toLowerCase() : 'value'}`} onCopy={() => props.onCopy!(v)} />}
      </div>
    </div>
  );
}

/** Password-style input with the reveal toggle inside the field. */
export function SecretInput(props: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  describedBy?: string;
  trailing?: ReactNode;
  invalid?: boolean;
  size?: 'md' | 'lg';
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative flex-1">
        <input
          id={props.id}
          type={show ? 'text' : 'password'}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          autoComplete={props.autoComplete ?? 'off'}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={props.describedBy}
          aria-invalid={props.invalid || undefined}
          className={cx(inputBase, props.size === 'lg' ? 'h-11 text-[15px]' : 'h-9', 'pr-10', show || !props.value ? '' : 'tracking-[0.2em]', show && 'font-mono')}
        />
        <button
          type="button"
          aria-label={show ? 'Hide' : 'Show'}
          title={show ? 'Hide' : 'Show'}
          onClick={() => setShow((s) => !s)}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg text-fg-subtle hover:text-fg"
        >
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {props.trailing}
    </div>
  );
}

export function StrengthMeter({ score, label }: { score: number; label: string }) {
  const colors = ['bg-danger', 'bg-danger', 'bg-warn', 'bg-ok', 'bg-ok'];
  return (
    <div className="flex items-center gap-2" aria-label={`Password strength: ${label}`}>
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cx('h-1 flex-1 rounded', i < Math.max(1, score) ? colors[score] : 'bg-border')} />
        ))}
      </div>
      <span className="text-xs text-fg-muted w-20 text-right">{label}</span>
    </div>
  );
}
