import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { ItemPayload } from '@passvault/types';
import { Banner, Button, Dialog, Spinner, useConfirm, useToast } from '@passvault/ui';
import { useApp, useSnapshot, useUi, errorMessage } from '../state';
import { EnvDiffTable } from '../env/EnvFileView';

type Version = Awaited<ReturnType<import('@passvault/vault-core').VaultSession['itemVersions']>>[number];

/** Field-level change summary without revealing values. */
function changedFields(a: ItemPayload, b: ItemPayload): string[] {
  const out: string[] = [];
  for (const k of ['title', 'description', 'notes', 'folder', 'environment', 'projectId'] as const) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  if (a.tags.join() !== b.tags.join()) out.push('tags');
  const af = a.fields as unknown as Record<string, unknown>;
  const bf = b.fields as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(af), ...Object.keys(bf)])) if (JSON.stringify(af[k]) !== JSON.stringify(bf[k])) out.push(k);
  if (JSON.stringify(a.customFields) !== JSON.stringify(b.customFields)) out.push('custom fields');
  if (a.trashedAt !== b.trashedAt) out.push(b.trashedAt ? 'moved to trash' : 'restored');
  return out;
}

export function HistoryDialog() {
  const { session } = useApp();
  const snap = useSnapshot();
  const ui = useUi();
  const toast = useToast();
  const confirm = useConfirm();
  const item = snap.items.find((i) => i.id === ui.historyId);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState<number | null>(null);
  useEffect(() => {
    if (!ui.historyId) return;
    session
      .itemVersions(ui.historyId)
      .then(setVersions)
      .catch((e) => setError(errorMessage(e)));
  }, [ui.historyId, session]);
  const close = () => ui.set({ historyId: null });
  if (!item) return null;
  const current = item.payload;
  return (
    <Dialog open onClose={close} size="lg" title={`History — ${current.title}`} description="Previous versions are stored encrypted. Restoring creates a new version; nothing is overwritten.">
      {error && <Banner tone="danger">{error}</Banner>}
      {!versions && !error && <Spinner label="Loading history" />}
      {versions && versions.length === 0 && <p className="text-sm text-fg-muted">No previous versions yet.</p>}
      <ol className="space-y-2">
        {versions?.map((v) => {
          const p = v.payload as ItemPayload | null;
          return (
            <li key={v.revision} className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <div className="text-sm font-medium">Revision {v.revision}</div>
                  <div className="text-xs text-fg-subtle">
                    {new Date(v.createdAt).toLocaleString()}
                    {v.createdBy !== session.userId ? ' · by another member' : ''}
                  </div>
                </div>
                {p && current.type === 'env_file' && p.type === 'env_file' && (
                  <Button size="sm" onClick={() => setCompare(compare === v.revision ? null : v.revision)}>
                    {compare === v.revision ? 'Hide diff' : 'Compare'}
                  </Button>
                )}
                {p && item.role !== 'viewer' && (
                  <Button
                    size="sm"
                    icon={<RotateCcw className="size-3.5" />}
                    onClick={async () => {
                      if (!(await confirm({ title: `Restore revision ${v.revision}?`, body: 'The current content is kept in history.', confirmLabel: 'Restore', tone: 'primary' }))) return;
                      try {
                        await session.restoreVersion(item.id, p);
                        toast('Version restored', 'success');
                        close();
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }}
                  >
                    Restore
                  </Button>
                )}
              </div>
              {p ? (
                <div className="mt-1 text-xs text-fg-muted">Differs from current in: {changedFields(p, current).join(', ') || 'nothing'}</div>
              ) : (
                <div className="mt-1 text-xs text-warn">{v.error}</div>
              )}
              {compare === v.revision && p?.type === 'env_file' && current.type === 'env_file' && (
                <div className="mt-3">
                  <EnvDiffTable left={p.fields.content} right={current.fields.content} leftLabel={`rev ${v.revision}`} rightLabel="current" />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </Dialog>
  );
}

export function ConflictDialog() {
  const { session } = useApp();
  const ui = useUi();
  const toast = useToast();
  const id = ui.conflictId!;
  const versions = (() => {
    try {
      return session.conflictVersions(id);
    } catch {
      return null;
    }
  })();
  const close = () => ui.set({ conflictId: null });
  const mine = versions?.mine as ItemPayload | null;
  const theirs = versions?.theirs as ItemPayload | null;
  const resolve = async (keep: 'mine' | 'theirs' | 'both') => {
    try {
      await session.resolveConflict(id, keep);
      toast('Conflict resolved', 'success');
      close();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <Dialog
      open
      onClose={close}
      size="lg"
      title="Resolve sync conflict"
      description="This item was changed on another device after you started editing. Choose which version to keep — nothing is overwritten until you decide."
      footer={
        <>
          <Button onClick={close}>Decide later</Button>
          <Button onClick={() => resolve('both')} disabled={!mine || !theirs}>
            Keep both
          </Button>
          <Button onClick={() => resolve('theirs')}>Keep theirs</Button>
          <Button variant="primary" onClick={() => resolve('mine')}>
            Keep mine
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          ['Your version', mine],
          ['Their version', theirs],
        ].map(([label, p]) => (
          <div key={label as string} className="rounded-lg border border-border p-3">
            <div className="text-xs font-semibold uppercase text-fg-subtle">{label as string}</div>
            {p ? (
              <>
                <div className="mt-1 font-medium">{(p as ItemPayload).title}</div>
                {mine && theirs && <div className="mt-1 text-xs text-fg-muted">Changed fields: {changedFields(mine, theirs).join(', ') || 'none'}</div>}
              </>
            ) : (
              <div className="mt-1 text-sm text-fg-muted">{label === 'Their version' ? 'Deleted on another device' : 'Delete'}</div>
            )}
          </div>
        ))}
      </div>
      {mine?.type === 'env_file' && theirs?.type === 'env_file' && (
        <div className="mt-4">
          <EnvDiffTable left={theirs.fields.content} right={mine.fields.content} leftLabel="theirs" rightLabel="mine" />
        </div>
      )}
    </Dialog>
  );
}
