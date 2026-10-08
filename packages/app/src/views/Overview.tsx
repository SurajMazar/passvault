import { useMemo } from 'react';
import { AlertTriangle, Clock3, KeyRound, Plus, RefreshCw, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
import { ITEM_TYPES, ITEM_TYPE_LABELS } from '@passvault/types';
import { Badge, Banner, Button, Card, EnvBadge, TypeIcon, useToast } from '@passvault/ui';
import { computeInsights, itemSubtitle, seedDemoData } from '@passvault/vault-core';
import { useApp, useSnapshot, useUi, errorMessage } from '../state';
import { Invitations } from '../sharing/Invitations';

export function Overview() {
  const { session } = useApp();
  const snap = useSnapshot();
  const ui = useUi();
  const toast = useToast();
  const live = snap.items.filter((i) => !i.payload.trashedAt && !i.payload.archived);
  const insights = useMemo(() => computeInsights(live.map((i) => ({ id: i.id, payload: i.payload }))), [live]);
  const recent = [...live].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const issues = insights.weak.length + insights.reused.reduce((n, r) => n + r.ids.length, 0) + insights.expiringSoon.length + insights.insecureUrls.length;
  const s = snap.sync;

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 pv-scroll">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <h1 className="text-xl font-semibold">Hello, {snap.user?.name?.split(' ')[0] ?? 'there'}</h1>
            <p className="text-sm text-fg-muted">
              {live.length} items · {snap.projects.length} projects · {snap.vaults.filter((v) => v.type === 'shared').length} shared collections
            </p>
          </div>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => ui.set({ editor: { mode: 'create', type: 'login' } })}>
            New item
          </Button>
        </div>

        {(s.conflicts > 0 || s.failed > 0) && (
          <Banner tone="danger" icon={<AlertTriangle className="size-4" />} title="Some changes need attention" action={<Button size="sm" onClick={() => ui.go('settings', { settingsTab: 'sync' })}>Review</Button>}>
            {s.conflicts} conflict(s), {s.failed} failed change(s). Nothing has been overwritten.
          </Banner>
        )}
        {snap.vaults.some((v) => v.rotationRequired && v.role === 'owner') && (
          <Banner tone="warn" title="A shared vault needs a key rotation" action={<Button size="sm" onClick={() => ui.set({ membersVaultId: snap.vaults.find((v) => v.rotationRequired && v.role === 'owner')!.vaultId })}>Open</Button>}>
            A member was removed or their access expired.
          </Banner>
        )}
        {snap.vaults.some((v) => v.error) && (
          <Banner tone="danger" title="A shared vault could not be opened">
            {snap.vaults.find((v) => v.error)!.error}
          </Banner>
        )}

        {live.length === 0 && (
          <Card title="Get started">
            <div className="flex flex-wrap items-center gap-3">
              <p className="flex-1 text-sm text-fg-muted">Your vault is empty. Add your first login, server, or .env file — or load dummy demo data to explore.</p>
              <Button
                icon={<Sparkles className="size-4" />}
                onClick={async () => {
                  try {
                    await seedDemoData(session);
                    toast('Demo data added (all values are fake)', 'success');
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }}
              >
                Add demo data
              </Button>
            </div>
          </Card>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ITEM_TYPES.map((t) => {
            const n = live.filter((i) => i.payload.type === t).length;
            return (
              <button key={t} onClick={() => ui.go(t)} className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left hover:border-accent">
                <TypeIcon type={t} />
                <div>
                  <div className="text-lg font-semibold tabular-nums">{n}</div>
                  <div className="text-xs text-fg-muted">{ITEM_TYPE_LABELS[t]}s</div>
                </div>
              </button>
            );
          })}
          <button onClick={() => ui.go('projects')} className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left hover:border-accent">
            <TypeIcon type="project" />
            <div>
              <div className="text-lg font-semibold tabular-nums">{snap.projects.length}</div>
              <div className="text-xs text-fg-muted">Projects</div>
            </div>
          </button>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={<span className="flex items-center gap-2"><Clock3 className="size-4" /> Recent changes</span>} className="lg:col-span-2">
            {recent.length === 0 ? (
              <p className="text-sm text-fg-muted">No items yet.</p>
            ) : (
              <ul className="-my-1">
                {recent.map((i) => (
                  <li key={i.id}>
                    <button className="flex w-full items-center gap-3 rounded-md px-1 py-1.5 text-left hover:bg-bg-subtle" onClick={() => ui.go(i.payload.type, { selectedId: i.id })}>
                      <TypeIcon type={i.payload.type} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{i.payload.title}</span>
                        <span className="block truncate text-xs text-fg-subtle">{itemSubtitle(i.payload)}</span>
                      </span>
                      <EnvBadge env={i.payload.environment} />
                      {i.pending && <Badge>pending</Badge>}
                      <span className="text-xs text-fg-subtle whitespace-nowrap">{new Date(i.updatedAt).toLocaleDateString()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="space-y-4">
            <Card title={<span className="flex items-center gap-2">{issues ? <ShieldAlert className="size-4 text-warn" /> : <ShieldCheck className="size-4 text-ok" />} Security insights</span>} actions={<Button size="sm" variant="ghost" onClick={() => ui.go('settings', { settingsTab: 'security' })}>Details</Button>}>
              <ul className="space-y-1.5 text-sm">
                <li className="flex justify-between"><span>Weak passwords</span><Badge tone={insights.weak.length ? 'danger' : 'ok'}>{insights.weak.length}</Badge></li>
                <li className="flex justify-between"><span>Reused passwords</span><Badge tone={insights.reused.length ? 'danger' : 'ok'}>{insights.reused.reduce((n, r) => n + r.ids.length, 0)}</Badge></li>
                <li className="flex justify-between"><span>Expiring credentials</span><Badge tone={insights.expiringSoon.length ? 'warn' : 'ok'}>{insights.expiringSoon.length}</Badge></li>
                <li className="flex justify-between"><span>Non-HTTPS logins</span><Badge tone={insights.insecureUrls.length ? 'warn' : 'ok'}>{insights.insecureUrls.length}</Badge></li>
              </ul>
              <p className="mt-2 text-xs text-fg-subtle">Calculated on this device. Passwords are never sent anywhere for checking.</p>
            </Card>
            <Card title={<span className="flex items-center gap-2"><KeyRound className="size-4" /> Invitations</span>}>
              <Invitations compact />
            </Card>
            <Card title={<span className="flex items-center gap-2"><RefreshCw className="size-4" /> Sync</span>}>
              <div className="text-sm text-fg-muted">
                {snap.online ? (s.lastSyncAt ? `Last synced ${new Date(s.lastSyncAt).toLocaleString()}` : 'Not synced yet') : 'Offline'}
                {s.pending > 0 && ` · ${s.pending} pending`}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
