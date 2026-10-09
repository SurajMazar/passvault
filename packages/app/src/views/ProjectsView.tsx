import { useMemo, useState } from 'react';
import { ArrowLeft, FolderKanban, GitCompare, Plus, Share2, Star, Users, Pencil, Trash2 } from 'lucide-react';
import { ITEM_TYPES, ITEM_TYPE_LABELS, type ProjectPayload, type ItemType, type EnvironmentKind } from '@passvault/types';
import { Badge, Banner, Button, Card, Dialog, EmptyState, EnvBadge, Field, IconButton, Input, Menu, Select, TagInput, TypeIcon, useConfirm, useToast } from '@passvault/ui';
import { itemSubtitle, newProject, type DecryptedProject } from '@passvault/vault-core';
import { useApp, useSnapshot, useUi, errorMessage } from '../state';
import { EnvDiffTable } from '../env/EnvFileView';

function ProjectForm({ project, onClose }: { project: DecryptedProject | null; onClose: () => void }) {
  const { session } = useApp();
  const toast = useToast();
  const [p, setP] = useState<ProjectPayload>(() => (project ? structuredClone(project.payload) : newProject('')));
  const [newEnv, setNewEnv] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title={project ? 'Edit project' : 'New project'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!p.name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const id = await session.saveProject(p, project?.id);
                useUi.getState().set({ projectId: id });
                onClose();
              } catch (e) {
                toast(errorMessage(e), 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            {project ? 'Save' : 'Create project'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">{(id) => <Input id={id} data-autofocus value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />}</Field>
        <Field label="Description">{(id) => <Input id={id} value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} />}</Field>
        <Field label="Tags" hint="Press comma or Enter to add a tag">
          {(id, d) => <TagInput id={id} describedBy={d} value={p.tags} onChange={(tags) => setP({ ...p, tags })} />}
        </Field>
        <fieldset>
          <legend className="text-xs font-medium text-fg-muted">Environments</legend>
          <ul className="mt-1 space-y-1">
            {p.environments.map((e, i) => (
              <li key={e.id} className="flex items-center gap-2">
                <Input aria-label="Environment name" value={e.name} onChange={(ev) => setP({ ...p, environments: p.environments.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)) })} />
                <Select aria-label="Kind" className="!w-36" value={e.kind} onChange={(ev) => setP({ ...p, environments: p.environments.map((x, j) => (j === i ? { ...x, kind: ev.target.value as EnvironmentKind } : x)) })}>
                  <option value="development">Development</option>
                  <option value="staging">Staging</option>
                  <option value="production">Production</option>
                  <option value="custom">Custom</option>
                </Select>
                <IconButton label="Remove environment" onClick={() => setP({ ...p, environments: p.environments.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newEnv.trim()) return;
              setP({ ...p, environments: [...p.environments, { id: crypto.randomUUID(), name: newEnv.trim(), kind: 'custom' }] });
              setNewEnv('');
            }}
          >
            <Input aria-label="New environment" placeholder="Add environment (e.g. QA)" value={newEnv} onChange={(e) => setNewEnv(e.target.value)} />
            <Button type="submit" size="md">
              Add
            </Button>
          </form>
        </fieldset>
      </div>
    </Dialog>
  );
}

function CompareDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const snap = useSnapshot();
  const files = snap.items.filter((i) => i.payload.type === 'env_file' && i.payload.projectId === projectId && !i.payload.trashedAt);
  const [a, setA] = useState(files[0]?.id ?? '');
  const [b, setB] = useState(files[1]?.id ?? files[0]?.id ?? '');
  const fa = files.find((f) => f.id === a);
  const fb = files.find((f) => f.id === b);
  const label = (f: typeof fa) => (f ? `${f.payload.environment ?? ''} ${f.payload.type === 'env_file' ? f.payload.fields.filename : ''}`.trim() : '');
  return (
    <Dialog open onClose={onClose} size="xl" title="Compare environments" description="Shows which variable names were added, removed, or changed. Values stay masked until you reveal them.">
      {files.length < 2 ? (
        <p className="text-sm text-fg-muted">Add at least two environment files to this project to compare them.</p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              [a, setA, 'Left'],
              [b, setB, 'Right'],
            ].map(([v, set, l]) => (
              <Field key={l as string} label={l as string}>
                {(id) => (
                  <Select id={id} value={v as string} onChange={(e) => (set as (s: string) => void)(e.target.value)}>
                    {files.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.payload.title} — {label(f)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ))}
          </div>
          {fa && fb && fa.payload.type === 'env_file' && fb.payload.type === 'env_file' && <EnvDiffTable left={fa.payload.fields.content} right={fb.payload.fields.content} leftLabel={label(fa) || 'left'} rightLabel={label(fb) || 'right'} />}
        </div>
      )}
    </Dialog>
  );
}

export function ProjectsView() {
  const { session } = useApp();
  const snap = useSnapshot();
  const ui = useUi();
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState<DecryptedProject | 'new' | null>(null);
  const [comparing, setComparing] = useState(false);
  const projects = snap.projects.filter((p) => !p.payload.trashedAt).sort((a, b) => a.payload.name.localeCompare(b.payload.name));
  const project = ui.projectId ? snap.projects.find((p) => p.id === ui.projectId) : null;
  const items = useMemo(() => (project ? snap.items.filter((i) => i.payload.projectId === project.id && !i.payload.trashedAt) : []), [project, snap.items]);

  if (!project) {
    return (
      <div className="h-full overflow-y-auto p-6 pv-scroll">
        <div className="mx-auto max-w-5xl">
          <div className="mb-4 flex items-center gap-2">
            <h1 className="flex-1 text-lg font-semibold">Projects</h1>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm('new')}>
              New project
            </Button>
          </div>
          {projects.length === 0 ? (
            <EmptyState icon={<FolderKanban className="size-8" />} title="No projects yet" action={<Button onClick={() => setForm('new')}>Create a project</Button>}>
              Group environment files, servers, databases, and API keys by project and environment.
            </EmptyState>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => {
                const n = snap.items.filter((i) => i.payload.projectId === p.id && !i.payload.trashedAt).length;
                return (
                  <button key={p.id} onClick={() => ui.set({ projectId: p.id })} className="rounded-lg border border-border bg-surface p-4 text-left hover:border-accent">
                    <div className="flex items-center gap-2">
                      <TypeIcon type="project" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{p.payload.name}</div>
                        <div className="text-xs text-fg-subtle">{n} item(s)</div>
                      </div>
                      {p.payload.favorite && <Star className="size-4 fill-warn text-warn" />}
                      {p.shared && <Badge tone="accent">{p.sharedByMe ? 'Shared' : p.role}</Badge>}
                    </div>
                    {p.payload.description && <p className="mt-2 line-clamp-2 text-sm text-fg-muted">{p.payload.description}</p>}
                    <div className="mt-3 flex flex-wrap gap-1">
                      {p.payload.environments.map((e) => (
                        <EnvBadge key={e.id} env={e.kind === 'custom' ? e.name : e.kind} />
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {form && <ProjectForm project={form === 'new' ? null : form} onClose={() => setForm(null)} />}
      </div>
    );
  }

  const readOnly = project.role === 'viewer';
  const envs = project.payload.environments;
  const byEnv = (name: string | null) => items.filter((i) => (name === null ? !i.payload.environment || !envs.some((e) => e.name.toLowerCase() === i.payload.environment!.toLowerCase()) : i.payload.environment?.toLowerCase() === name.toLowerCase()));

  return (
    <div className="h-full overflow-y-auto p-6 pv-scroll">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <IconButton label="All projects" onClick={() => ui.set({ projectId: null })}>
            <ArrowLeft className="size-4" />
          </IconButton>
          <TypeIcon type="project" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold">{project.payload.name}</h1>
            {project.payload.description && <p className="text-sm text-fg-muted">{project.payload.description}</p>}
          </div>
          <Button icon={<GitCompare className="size-4" />} onClick={() => setComparing(true)}>
            Compare environments
          </Button>
          {project.sharedByMe || !project.shared ? (
            <Button icon={<Share2 className="size-4" />} onClick={() => ui.set({ shareTarget: { kind: 'project', projectId: project.id } })}>
              Share
            </Button>
          ) : null}
          {project.shared && (
            <Button icon={<Users className="size-4" />} onClick={() => ui.set({ membersVaultId: project.vaultId })}>
              Access
            </Button>
          )}
          {!readOnly && (
            <Menu
              trigger={(t) => (
                <Button {...t} icon={<Plus className="size-4" />} variant="primary">
                  Add
                </Button>
              )}
              items={ITEM_TYPES.map((t: ItemType) => ({ label: ITEM_TYPE_LABELS[t], icon: <TypeIcon type={t} size="sm" />, onSelect: () => ui.set({ editor: { mode: 'create', type: t, projectId: project.id } }) }))}
            />
          )}
          {!readOnly && (
            <Menu
              trigger={(t) => (
                <IconButton {...t} label="Project actions">
                  <Pencil className="size-4" />
                </IconButton>
              )}
              items={[
                { label: 'Edit project', icon: <Pencil />, onSelect: () => setForm(project) },
                { label: project.payload.favorite ? 'Unfavorite' : 'Favorite', icon: <Star />, onSelect: () => void session.saveProject({ ...project.payload, favorite: !project.payload.favorite }, project.id) },
                {
                  label: 'Delete project…',
                  icon: <Trash2 />,
                  danger: true,
                  onSelect: async () => {
                    if (items.length) return toast('Move or delete the project’s items first.', 'warn');
                    if (await confirm({ title: `Delete project “${project.payload.name}”?`, confirmLabel: 'Delete' })) {
                      try {
                        await session.saveProject({ ...project.payload, trashedAt: new Date().toISOString() }, project.id);
                        await session.deletePermanently(project.id);
                        ui.set({ projectId: null });
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                      }
                    }
                  },
                },
              ]}
            />
          )}
        </div>
        {project.shared && (
          <Banner tone="accent" icon={<Share2 className="size-4" />}>
            This project is shared with {snap.vaults.find((v) => v.vaultId === project.vaultId)?.memberCount ?? 'other'} member(s). Items added to it are shared with all of them.
          </Banner>
        )}
        <div className="grid gap-4 lg:grid-cols-3">
          {[...envs.map((e) => ({ key: e.id, name: e.name as string | null, kind: e.kind })), { key: 'none', name: null, kind: 'custom' as const }].map((e) => {
            const list = byEnv(e.name);
            if (e.name === null && list.length === 0) return null;
            return (
              <Card
                key={e.key}
                title={e.name === null ? 'No environment' : <EnvBadge env={e.kind === 'custom' ? e.name : e.kind} />}
                actions={
                  !readOnly && e.name ? (
                    <IconButton size="sm" label={`Add environment file to ${e.name}`} onClick={() => ui.set({ editor: { mode: 'create', type: 'env_file', projectId: project.id, environment: e.name } })}>
                      <Plus className="size-4" />
                    </IconButton>
                  ) : undefined
                }
                className={e.kind === 'production' ? 'border-prod/50' : undefined}
              >
                {list.length === 0 ? (
                  <p className="text-sm text-fg-subtle">Nothing here yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {list.map((i) => (
                      <li key={i.id}>
                        <button className="flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-bg-subtle" onClick={() => ui.go(i.payload.type, { selectedId: i.id })}>
                          <TypeIcon type={i.payload.type} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{i.payload.title}</span>
                            <span className="block truncate text-xs text-fg-subtle">{itemSubtitle(i.payload)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      </div>
      {form && <ProjectForm project={form === 'new' ? null : form} onClose={() => setForm(null)} />}
      {comparing && <CompareDialog projectId={project.id} onClose={() => setComparing(false)} />}
    </div>
  );
}
