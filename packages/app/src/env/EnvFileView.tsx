import { useMemo, useState } from 'react';
import { Eye, EyeOff, Pencil, Plus, Trash2, Search, Copy, Download, FileWarning, Check, X, Info } from 'lucide-react';
import { addEntry, diffEnv, entries, parseEnv, removeEntry, renameKey, setInlineComment, setValue, serializeEnv, type EntryLine, type ParsedEnv, type EnvDiffEntry } from '@passvault/env-parser';
import type { ItemPayload } from '@passvault/types';
import { isProductionEnvironment } from '@passvault/types';
import { Badge, Banner, Button, Card, CopyButton, IconButton, Input, SecretInput, Tabs, TextArea, cx, useConfirm, useToast } from '@passvault/ui';
import type { DecryptedItem } from '@passvault/vault-core';
import { useApp, errorMessage } from '../state';
import { useCopy } from '../items/ItemDetail';

type EnvItem = DecryptedItem & { payload: ItemPayload<'env_file'> };

function IssueList({ env }: { env: ParsedEnv }) {
  if (!env.issues.length) return null;
  const errors = env.issues.filter((i) => i.severity === 'error');
  const others = env.issues.filter((i) => i.severity !== 'error');
  return (
    <details className="rounded-lg border border-border bg-surface px-3 py-2 text-sm" open={errors.length > 0}>
      <summary className="cursor-pointer select-none">
        <span className="font-medium">{errors.length ? `${errors.length} line(s) not understood` : 'Parser notes'}</span>
        <span className="ml-2 text-xs text-fg-subtle">
          {env.issues.length} note(s){!env.fullySupported && ' · raw text is kept exactly as written'}
        </span>
      </summary>
      <ul className="mt-2 space-y-1 text-xs">
        {[...errors, ...others].map((i, n) => (
          <li key={n} className="flex gap-2">
            <Badge tone={i.severity === 'error' ? 'danger' : i.severity === 'warning' ? 'warn' : 'neutral'}>Line {i.lineNumber}</Badge>
            <span className="text-fg-muted">{i.message}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function EnvFileView({ item }: { item: EnvItem }) {
  const { session } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const copy = useCopy();
  const [mode, setMode] = useState<'structured' | 'raw'>('structured');
  const [q, setQ] = useState('');
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; key: string; value: string; comment: string; note: string } | null>(null);
  const [adding, setAdding] = useState<{ key: string; value: string; note: string } | null>(null);
  const [rawDraft, setRawDraft] = useState<string | null>(null);
  const readOnly = item.role === 'viewer' || !!item.payload.trashedAt;
  const content = item.payload.fields.content;
  const env = useMemo(() => parseEnv(content), [content]);
  const list = useMemo(() => {
    const all = entries(env);
    const t = q.trim().toLowerCase();
    return t ? all.filter((e) => e.key.toLowerCase().includes(t)) : all;
  }, [env, q]);
  const notes = item.payload.fields.variableNotes;
  const prod = isProductionEnvironment(item.payload.environment) || /prod/i.test(item.payload.fields.filename);

  const saveContent = async (text: string, nextNotes = notes) => {
    try {
      await session.updateItem(item.id, (p) => {
        if (p.type !== 'env_file') return;
        p.fields.content = text;
        p.fields.variableNotes = nextNotes;
      });
      return true;
    } catch (e) {
      toast(errorMessage(e), 'error');
      return false;
    }
  };

  const applyEdit = async (res: ReturnType<typeof setValue>, nextNotes?: Record<string, string>) => {
    if (!res.ok) {
      toast(`Not applied: ${res.error}. Use raw mode for this change.`, 'warn');
      return false;
    }
    return saveContent(res.text, nextNotes);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const cur = entries(env).find((e) => e.id === editing.id);
    if (!cur) return;
    let r: ReturnType<typeof setValue> = { ok: true, env, text: content };
    if (editing.value !== cur.value) r = setValue(env, editing.id, editing.value);
    let id = editing.id;
    if (r.ok && r.entryId) id = r.entryId;
    if (r.ok && (editing.comment || null) !== cur.inlineComment) {
      r = setInlineComment(r.env, id, editing.comment || null);
      if (r.ok && r.entryId) id = r.entryId;
    }
    if (r.ok && editing.key !== cur.key) r = renameKey(r.env, id, editing.key);
    const nextNotes = { ...notes };
    delete nextNotes[cur.key];
    if (editing.note.trim()) nextNotes[editing.key] = editing.note.trim();
    if (await applyEdit(r, nextNotes)) setEditing(null);
  };

  const exportFile = async () => {
    const ok = await confirm({
      title: `Download ${item.payload.fields.filename}?`,
      body: 'The file will contain every value in plaintext. It is not added to source control automatically. Deleting it later does not guarantee the data is erased from disk.',
      confirmLabel: 'Choose location…',
      typeToConfirm: prod ? 'EXPORT' : undefined,
    });
    if (!ok) return;
    const r = await session.platformRef.files.saveTextFile({ suggestedName: item.payload.fields.filename, text: content });
    if (r.saved) toast(r.ownerOnly ? `Saved with owner-only permissions${r.location ? ` to ${r.location}` : ''}` : 'Saved', 'success');
  };

  const copyAll = async () => {
    if (await confirm({ title: 'Copy the whole file?', body: 'All values will be placed on the clipboard in plaintext.', confirmLabel: 'Copy', tone: 'primary' })) await copy(content);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          label="View mode"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setRawDraft(null);
          }}
          tabs={[
            { id: 'structured', label: 'Variables' },
            { id: 'raw', label: 'Raw file' },
          ]}
        />
        <div className="ml-auto flex gap-1">
          <Button size="sm" icon={<Copy className="size-3.5" />} onClick={copyAll}>
            Copy file
          </Button>
          <Button size="sm" icon={<Download className="size-3.5" />} onClick={exportFile}>
            Download
          </Button>
        </div>
      </div>
      <IssueList env={env} />

      {mode === 'structured' ? (
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
              <Input aria-label="Search variable names" placeholder="Search variable names" className="pl-7" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {!readOnly && (
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setAdding({ key: '', value: '', note: '' })}>
                Add variable
              </Button>
            )}
          </div>
          {adding && (
            <div className="mb-3 space-y-2 rounded-lg border border-accent/40 bg-accent-soft p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <Input aria-label="Variable name" placeholder="NAME" className="font-mono" value={adding.key} onChange={(e) => setAdding({ ...adding, key: e.target.value })} />
                <SecretInput value={adding.value} onChange={(v) => setAdding({ ...adding, value: v })} placeholder="value" />
              </div>
              <Input aria-label="Note (stored outside the file)" placeholder="Note (optional, stored outside the file)" value={adding.note} onChange={(e) => setAdding({ ...adding, note: e.target.value })} />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!adding.key}
                  onClick={async () => {
                    const nextNotes = adding.note ? { ...notes, [adding.key]: adding.note } : notes;
                    if (await applyEdit(addEntry(env, adding.key, adding.value), nextNotes)) setAdding(null);
                  }}
                >
                  Add
                </Button>
                <Button size="sm" onClick={() => setAdding(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {list.length === 0 ? (
            <p className="py-6 text-center text-sm text-fg-muted">{q ? 'No variables match.' : 'No variables yet.'}</p>
          ) : (
            <table className="w-full table-fixed text-sm">
              <thead className="sr-only">
                <tr>
                  <th>Name</th>
                  <th>Value</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((e: EntryLine) => {
                  const isDup = (env.duplicates[e.key]?.length ?? 0) > 1;
                  if (editing?.id === e.id)
                    return (
                      <tr key={e.id} className="border-b border-border">
                        <td colSpan={3} className="py-2">
                          <div className="space-y-2 rounded-lg border border-accent/40 bg-accent-soft p-3">
                            <div className="grid gap-2 sm:grid-cols-2">
                              <Input aria-label="Variable name" className="font-mono" value={editing.key} onChange={(ev) => setEditing({ ...editing, key: ev.target.value })} />
                              <SecretInput value={editing.value} onChange={(v) => setEditing({ ...editing, value: v })} />
                            </div>
                            <div className="grid gap-2 sm:grid-cols-2">
                              <Input aria-label="Inline comment (in file)" placeholder="Inline comment (written into the file)" value={editing.comment} onChange={(ev) => setEditing({ ...editing, comment: ev.target.value })} />
                              <Input aria-label="Note (outside the file)" placeholder="Note (kept outside the file)" value={editing.note} onChange={(ev) => setEditing({ ...editing, note: ev.target.value })} />
                            </div>
                            <div className="flex gap-2">
                              <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={saveEdit}>
                                Save
                              </Button>
                              <Button size="sm" icon={<X className="size-3.5" />} onClick={() => setEditing(null)}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  const shown = revealed.has(e.id);
                  return (
                    <tr key={e.id} className="group border-b border-border last:border-b-0 align-top">
                      <td className="w-[38%] py-2 pr-2">
                        <div className="font-mono text-xs font-medium break-all">{e.key}</div>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {isDup && <Badge tone="warn">duplicate</Badge>}
                          {e.exported && <Badge>export</Badge>}
                          {e.multiline && <Badge>multiline</Badge>}
                          {e.hasInterpolation && (
                            <Badge tone="neutral" title="References like ${VAR} or $(cmd) are shown literally and never expanded">
                              not expanded
                            </Badge>
                          )}
                        </div>
                        {notes[e.key] && <div className="mt-1 text-xs text-fg-subtle">{notes[e.key]}</div>}
                        {e.inlineComment && <div className="mt-0.5 text-xs text-fg-subtle"># {e.inlineComment}</div>}
                      </td>
                      <td className="py-2 pr-2 font-mono text-xs break-all">
                        {shown ? <span className="whitespace-pre-wrap">{e.value || <em className="text-fg-subtle">empty</em>}</span> : <span className="pv-masked text-fg-muted select-none">••••••••</span>}
                      </td>
                      <td className="w-28 py-1.5 text-right whitespace-nowrap">
                        <IconButton size="sm" label={shown ? `Hide ${e.key}` : `Reveal ${e.key}`} onClick={() => setRevealed((s) => { const n = new Set(s); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })}>
                          {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </IconButton>
                        <CopyButton label={`Copy ${e.key}`} onCopy={() => copy(e.value)} />
                        {!readOnly && (
                          <>
                            <IconButton size="sm" label={`Edit ${e.key}`} onClick={() => setEditing({ id: e.id, key: e.key, value: e.value, comment: e.inlineComment ?? '', note: notes[e.key] ?? '' })}>
                              <Pencil className="size-4" />
                            </IconButton>
                            <IconButton
                              size="sm"
                              variant="danger"
                              label={`Remove ${e.key}`}
                              onClick={async () => {
                                if (await confirm({ title: `Remove ${e.key}?`, body: 'The previous version stays in history.', confirmLabel: 'Remove' })) {
                                  const n = { ...notes };
                                  delete n[e.key];
                                  await applyEdit(removeEntry(env, e.id), n);
                                }
                              }}
                            >
                              <Trash2 className="size-4" />
                            </IconButton>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="mt-3 flex items-start gap-1.5 text-xs text-fg-subtle">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            Structured edits change only the edited line; comments, blank lines, ordering and quoting elsewhere are preserved byte-for-byte.
          </p>
        </Card>
      ) : (
        <Card>
          <Banner tone="warn" icon={<FileWarning className="size-4" />}>
            Raw mode shows every value in plaintext.
          </Banner>
          {rawDraft === null ? (
            <>
              <pre className="mt-3 max-h-[28rem] overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-xs whitespace-pre pv-scroll">{content || ' '}</pre>
              {!readOnly && (
                <Button size="sm" className="mt-2" icon={<Pencil className="size-3.5" />} onClick={() => setRawDraft(content)}>
                  Edit raw text
                </Button>
              )}
            </>
          ) : (
            <>
              <TextArea aria-label="Raw file contents" rows={16} spellCheck={false} className={cx('mt-3 font-mono text-xs')} value={rawDraft} onChange={(e) => setRawDraft(e.target.value)} />
              <RawPreview text={rawDraft} />
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="primary" onClick={async () => (await saveContent(rawDraft)) && setRawDraft(null)}>
                  Save
                </Button>
                <Button size="sm" onClick={() => setRawDraft(null)}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function RawPreview({ text }: { text: string }) {
  const p = useMemo(() => parseEnv(text), [text]);
  const errs = p.issues.filter((i) => i.severity === 'error').length;
  return (
    <p className={cx('mt-1 text-xs', errs ? 'text-warn' : 'text-fg-subtle')}>
      {entries(p).length} variable(s){errs ? ` · ${errs} line(s) not understood (kept as written)` : ''}
      {Object.keys(p.duplicates).length ? ` · duplicates: ${Object.keys(p.duplicates).join(', ')}` : ''}
    </p>
  );
}

/** Masked comparison of two env files: names and status only, values revealed on demand. */
export function EnvDiffTable({ left, right, leftLabel, rightLabel }: { left: string; right: string; leftLabel: string; rightLabel: string }) {
  const [reveal, setReveal] = useState<string | null>(null);
  const lp = useMemo(() => parseEnv(left), [left]);
  const rp = useMemo(() => parseEnv(right), [right]);
  const diff = useMemo(() => diffEnv(lp, rp), [lp, rp]);
  const lv = (k: string) => [...entries(lp)].reverse().find((e) => e.key === k)?.value;
  const rv = (k: string) => [...entries(rp)].reverse().find((e) => e.key === k)?.value;
  const counts = diff.reduce<Record<string, number>>((m, d) => ((m[d.status] = (m[d.status] ?? 0) + 1), m), {});
  const tone: Record<EnvDiffEntry['status'], 'ok' | 'danger' | 'warn' | 'neutral'> = { added: 'ok', removed: 'danger', changed: 'warn', unchanged: 'neutral' };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="ok">{counts.added ?? 0} only in {rightLabel}</Badge>
        <Badge tone="danger">{counts.removed ?? 0} only in {leftLabel}</Badge>
        <Badge tone="warn">{counts.changed ?? 0} different</Badge>
        <Badge>{counts.unchanged ?? 0} same</Badge>
      </div>
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="text-left text-xs text-fg-subtle">
            <th className="w-[34%] py-1">Variable</th>
            <th className="py-1">{leftLabel}</th>
            <th className="py-1">{rightLabel}</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {diff
            .filter((d) => d.status !== 'unchanged')
            .concat(diff.filter((d) => d.status === 'unchanged'))
            .map((d) => (
              <tr key={d.key} className="border-t border-border align-top">
                <td className="py-1.5 pr-2">
                  <div className="font-mono text-xs break-all">{d.key}</div>
                  <Badge tone={tone[d.status]}>{d.status === 'added' ? `only in ${rightLabel}` : d.status === 'removed' ? `only in ${leftLabel}` : d.status}</Badge>
                </td>
                {[lv(d.key), rv(d.key)].map((v, i) => (
                  <td key={i} className="py-1.5 pr-2 font-mono text-xs break-all">
                    {v === undefined ? <span className="text-fg-subtle">—</span> : reveal === d.key ? v : <span className="pv-masked text-fg-muted">••••••</span>}
                  </td>
                ))}
                <td className="py-1">
                  <IconButton size="sm" label={reveal === d.key ? `Hide ${d.key}` : `Reveal ${d.key}`} onClick={() => setReveal(reveal === d.key ? null : d.key)}>
                    {reveal === d.key ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </IconButton>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export { serializeEnv };
