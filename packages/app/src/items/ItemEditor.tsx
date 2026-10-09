import { useMemo, useState, type ReactNode } from 'react';
import { Plus, Trash2, Wand2, Upload, KeyRound, Share2 } from 'lucide-react';
import {
  API_CREDENTIAL_KINDS,
  CUSTOM_FIELD_TYPES,
  DATABASE_DEFAULT_PORTS,
  DATABASE_ENGINES,
  ITEM_TYPE_LABELS,
  SSH_AUTH_METHODS,
  TLS_MODES,
  URL_MATCH_LABELS,
  URL_MATCH_MODES,
  type CustomField,
  type ItemPayload,
} from '@passvault/types';
import { generatePassword } from '@passvault/crypto';
import { isValidHost, isValidSshUsername, itemPayloadSchema } from '@passvault/validation';
import { Banner, Button, Dialog, Field, IconButton, Input, SecretInput, Select, StrengthMeter, TagInput, TextArea, useToast } from '@passvault/ui';
import { newItem, passwordStrength, IDENTIFIER_MAX, cardBrand, cardDigits, luhnValid } from '@passvault/vault-core';
import { useApp, useSnapshot, useUi, errorMessage } from '../state';
import { sshPublicKeyInfo } from './ssh-keys';

type Draft = ItemPayload;

function GenButton({ onGen }: { onGen: (v: string) => void }) {
  return (
    <IconButton size="sm" label="Generate password" onClick={() => onGen(generatePassword({ length: 24 }))}>
      <Wand2 className="size-4" />
    </IconButton>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

export function ItemEditor() {
  const { session, ext } = useApp();
  const snap = useSnapshot();
  const ui = useUi();
  const toast = useToast();
  const ed = ui.editor!;
  const existing = ed.mode === 'edit' ? snap.items.find((i) => i.id === ed.id) : null;
  const [draft, setDraft] = useState<Draft>(() =>
    existing
      ? structuredClone(existing.payload)
      : (newItem(ed.mode === 'create' ? ed.type : 'login', {
          projectId: ed.mode === 'create' ? (ed.projectId ?? null) : null,
          environment: ed.mode === 'create' ? (ed.environment ?? null) : null,
          ...(ed.mode === 'create' ? (ed.preset as Partial<ItemPayload>) : {}),
        }) as Draft),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const close = () => ui.set({ editor: null });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }) as Draft);
  const setF = (patch: Record<string, unknown>) => setDraft((d) => ({ ...d, fields: { ...d.fields, ...patch } }) as Draft);
  const f = draft.fields as unknown as Record<string, unknown>;
  const err = (path: string) => errors[path] ?? errors[`fields.${path}`] ?? null;

  const writableProjects = snap.projects.filter((p) => !p.payload.trashedAt && p.role !== 'viewer');
  const project = draft.projectId ? snap.projects.find((p) => p.id === draft.projectId) : null;
  const projectShared = project && project.shared;
  const envOptions = project ? project.payload.environments.map((e) => e.name) : ['Development', 'Staging', 'Production'];

  const save = async () => {
    const candidate = { ...draft, tags: [...new Set(draft.tags)], environment: draft.environment || null } as Draft;
    if (candidate.type === 'login' && existing?.payload.type === 'login' && existing.payload.fields.password !== candidate.fields.password) {
      candidate.fields.passwordUpdatedAt = new Date().toISOString();
    }
    const r = itemPayloadSchema.safeParse(candidate);
    if (!r.success) {
      const e: Record<string, string> = {};
      for (const i of r.error.issues) e[i.path.join('.')] = i.message;
      setErrors(e);
      return;
    }
    setBusy(true);
    try {
      const id = await session.saveItem(r.data as Draft, existing?.id);
      toast(existing ? 'Saved' : `${ITEM_TYPE_LABELS[draft.type]} created`, 'success');
      ui.set({ editor: null, selectedId: id });
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const strength = useMemo(() => {
    const pw = draft.type === 'login' || draft.type === 'database' ? (f.password as string) : '';
    return pw ? passwordStrength(pw) : null;
  }, [draft.type, f.password]);

  const customFields = draft.customFields;
  const setCustom = (cf: CustomField[]) => set({ customFields: cf });

  return (
    <Dialog
      open
      onClose={close}
      size="lg"
      title={existing ? `Edit ${ITEM_TYPE_LABELS[draft.type].toLowerCase()}` : `New ${ITEM_TYPE_LABELS[draft.type].toLowerCase()}`}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={save} loading={busy}>
            {existing ? 'Save changes' : 'Create'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Title" error={err('title')}>
          {(id) => <Input id={id} data-autofocus value={draft.title} onChange={(e) => set({ title: e.target.value })} aria-invalid={!!err('title')} />}
        </Field>

        {draft.type === 'login' && (
          <>
            <Row>
              <Field label="Username or email">{(id) => <Input id={id} value={f.username as string} onChange={(e) => setF({ username: e.target.value })} autoComplete="off" />}</Field>
              <Field label="Password" error={err('password')}>
                {(id) => <SecretInput id={id} value={f.password as string} onChange={(v) => setF({ password: v })} trailing={<GenButton onGen={(v) => setF({ password: v })} />} />}
              </Field>
            </Row>
            {strength && <StrengthMeter score={strength.score} label={strength.label} />}
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-fg-muted">Websites</legend>
              {(f.urls as Array<{ url: string; match: string }>).map((u, i) => (
                <div key={i} className="flex gap-2">
                  <Input aria-label={`Website ${i + 1}`} placeholder="https://example.com" value={u.url} onChange={(e) => setF({ urls: (f.urls as Array<{ url: string; match: string }>).map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
                  <Select aria-label="URL matching rule" className="!w-56" value={u.match} onChange={(e) => setF({ urls: (f.urls as Array<{ url: string; match: string }>).map((x, j) => (j === i ? { ...x, match: e.target.value } : x)) })}>
                    {URL_MATCH_MODES.map((m) => (
                      <option key={m} value={m}>
                        {URL_MATCH_LABELS[m]}
                      </option>
                    ))}
                  </Select>
                  <IconButton label="Remove website" onClick={() => setF({ urls: (f.urls as unknown[]).filter((_, j) => j !== i) })}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              ))}
              <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setF({ urls: [...(f.urls as unknown[]), { url: '', match: 'host' }] })}>
                Add website
              </Button>
            </fieldset>
          </>
        )}

        {draft.type === 'ssh_connection' && (
          <>
            <Row>
              <Field label="Hostname or IP" error={err('host') ?? (f.host && !isValidHost(f.host as string) ? 'Not a valid hostname or IP address' : null)}>
                {(id) => <Input id={id} value={f.host as string} onChange={(e) => setF({ host: e.target.value.trim() })} className="font-mono" spellCheck={false} />}
              </Field>
              <Row>
                <Field label="Port" error={err('port')}>
                  {(id) => <Input id={id} type="number" min={1} max={65535} value={String(f.port)} onChange={(e) => setF({ port: Number(e.target.value) })} />}
                </Field>
                <Field label="Username" error={err('username') ?? (f.username && !isValidSshUsername(f.username as string) ? 'Invalid username' : null)}>
                  {(id) => <Input id={id} value={f.username as string} onChange={(e) => setF({ username: e.target.value.trim() })} className="font-mono" spellCheck={false} />}
                </Field>
              </Row>
            </Row>
            <Row>
              <Field label="Authentication">
                {(id) => (
                  <Select id={id} value={f.authMethod as string} onChange={(e) => setF({ authMethod: e.target.value })}>
                    {SSH_AUTH_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {{ password: 'Password', key: 'SSH key from vault', agent: 'SSH agent', keyboard_interactive: 'Interactive prompts (OTP, etc.)' }[m]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {f.authMethod === 'password' || f.authMethod === 'keyboard_interactive' ? (
                <Field label="Password (optional)" hint="Never passed on a command line or typed into other apps.">
                  {(id, d) => <SecretInput id={id} describedBy={d} value={(f.password as string) ?? ''} onChange={(v) => setF({ password: v || undefined })} />}
                </Field>
              ) : (
                <Field label="SSH key">
                  {(id) => (
                    <Select id={id} value={(f.sshKeyItemId as string) ?? ''} onChange={(e) => setF({ sshKeyItemId: e.target.value || undefined })}>
                      <option value="">Choose a key…</option>
                      {snap.items
                        .filter((i) => i.payload.type === 'ssh_key' && !i.payload.trashedAt)
                        .map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.payload.title}
                          </option>
                        ))}
                    </Select>
                  )}
                </Field>
              )}
            </Row>
            <Field label="Jump host (optional)">
              {(id) => (
                <Select id={id} value={(f.jumpHostItemId as string) ?? ''} onChange={(e) => setF({ jumpHostItemId: e.target.value || undefined })}>
                  <option value="">None — connect directly</option>
                  {snap.items
                    .filter((i) => i.payload.type === 'ssh_connection' && i.id !== existing?.id && !i.payload.trashedAt)
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.payload.title}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          </>
        )}

        {draft.type === 'ssh_key' && <SshKeyFields f={f} setF={setF} errors={errors} hasNative={!!ext.sshKeys} />}

        {draft.type === 'database' && (
          <>
            <Row>
              <Field label="Engine">
                {(id) => (
                  <Select id={id} value={f.engine as string} onChange={(e) => setF({ engine: e.target.value, port: DATABASE_DEFAULT_PORTS[e.target.value as keyof typeof DATABASE_DEFAULT_PORTS] ?? f.port })}>
                    {DATABASE_ENGINES.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="TLS" hint={f.tlsMode === 'disable' ? 'Credentials and data travel unencrypted.' : undefined}>
                {(id, d) => (
                  <Select id={id} aria-describedby={d} value={f.tlsMode as string} onChange={(e) => setF({ tlsMode: e.target.value })}>
                    {TLS_MODES.map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </Select>
                )}
              </Field>
            </Row>
            <Row>
              <Field label="Host">{(id) => <Input id={id} value={f.host as string} onChange={(e) => setF({ host: e.target.value })} className="font-mono" />}</Field>
              <Field label="Port" error={err('port')}>
                {(id) => <Input id={id} type="number" value={f.port ? String(f.port) : ''} onChange={(e) => setF({ port: e.target.value ? Number(e.target.value) : undefined })} />}
              </Field>
            </Row>
            <Row>
              <Field label="Database">{(id) => <Input id={id} value={f.database as string} onChange={(e) => setF({ database: e.target.value })} className="font-mono" />}</Field>
              <Field label="Username">{(id) => <Input id={id} value={f.username as string} onChange={(e) => setF({ username: e.target.value })} className="font-mono" />}</Field>
            </Row>
            <Field label="Password">{(id) => <SecretInput id={id} value={f.password as string} onChange={(v) => setF({ password: v })} trailing={<GenButton onGen={(v) => setF({ password: v })} />} />}</Field>
            <Field label="Connection string (optional, treated as secret)">
              {(id) => <SecretInput id={id} value={(f.connectionString as string) ?? ''} onChange={(v) => setF({ connectionString: v || undefined })} />}
            </Field>
            <Field label="CA certificate (optional)">
              {(id) => <TextArea id={id} rows={3} className="font-mono text-xs" value={(f.caCertificate as string) ?? ''} onChange={(e) => setF({ caCertificate: e.target.value || undefined })} />}
            </Field>
          </>
        )}

        {draft.type === 'api_credential' && (
          <>
            <Row>
              <Field label="Service">{(id) => <Input id={id} value={f.service as string} onChange={(e) => setF({ service: e.target.value })} />}</Field>
              <Field label="Credential type">
                {(id) => (
                  <Select id={id} value={f.kind as string} onChange={(e) => setF({ kind: e.target.value })}>
                    {API_CREDENTIAL_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {{ token: 'Bearer / access token', api_key: 'API key', client_credentials: 'Client ID + secret', basic: 'Username + password' }[k]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </Row>
            <Field label="Endpoint (optional)">{(id) => <Input id={id} value={(f.endpoint as string) ?? ''} onChange={(e) => setF({ endpoint: e.target.value || undefined })} className="font-mono" />}</Field>
            {f.kind === 'token' && <Field label="Token">{(id) => <SecretInput id={id} value={(f.token as string) ?? ''} onChange={(v) => setF({ token: v || undefined })} />}</Field>}
            {f.kind === 'api_key' && <Field label="API key">{(id) => <SecretInput id={id} value={(f.apiKey as string) ?? ''} onChange={(v) => setF({ apiKey: v || undefined })} />}</Field>}
            {f.kind === 'client_credentials' && (
              <Row>
                <Field label="Client ID">{(id) => <Input id={id} value={(f.clientId as string) ?? ''} onChange={(e) => setF({ clientId: e.target.value || undefined })} className="font-mono" />}</Field>
                <Field label="Client secret">{(id) => <SecretInput id={id} value={(f.clientSecret as string) ?? ''} onChange={(v) => setF({ clientSecret: v || undefined })} />}</Field>
              </Row>
            )}
            {f.kind === 'basic' && (
              <Row>
                <Field label="Username">{(id) => <Input id={id} value={(f.username as string) ?? ''} onChange={(e) => setF({ username: e.target.value || undefined })} />}</Field>
                <Field label="Password">{(id) => <SecretInput id={id} value={(f.password as string) ?? ''} onChange={(v) => setF({ password: v || undefined })} />}</Field>
              </Row>
            )}
            <Field label="Expires (optional)">{(id) => <Input id={id} type="date" value={(f.expiresAt as string) ?? ''} onChange={(e) => setF({ expiresAt: e.target.value || undefined })} className="!w-48" />}</Field>
          </>
        )}

        {draft.type === 'env_file' && (
          <>
            <Field label="Filename" error={err('filename')} hint="e.g. .env, .env.local, .env.production">
              {(id, d) => <Input id={id} aria-describedby={d} value={f.filename as string} onChange={(e) => setF({ filename: e.target.value })} className="font-mono" />}
            </Field>
            <Field label="Contents (raw — values are visible while editing here)" hint="Imported text is stored exactly as written. Nothing is executed or interpolated.">
              {(id, d) => (
                <div className="space-y-2">
                  <TextArea id={id} aria-describedby={d} rows={10} spellCheck={false} className="font-mono text-xs" value={f.content as string} onChange={(e) => setF({ content: e.target.value })} />
                  <Button
                    size="sm"
                    icon={<Upload className="size-3.5" />}
                    onClick={async () => {
                      const r = await session.platformRef.files.pickTextFile({ title: 'Import environment file', maxBytes: 1_400_000 });
                      if (r) {
                        setF({ content: r.text, filename: (f.filename as string) === '.env' && r.name ? r.name : f.filename });
                        if (!draft.title) set({ title: r.name });
                      }
                    }}
                  >
                    Import file…
                  </Button>
                </div>
              )}
            </Field>
          </>
        )}

        {draft.type === 'payment_card' && <CardFields f={f} setF={setF} err={err} />}

        {draft.type === 'secure_note' && (
          <Field label="Note" hint="Plain text. Shown as text only — HTML and scripts are never rendered.">
            {(id, d) => <TextArea id={id} aria-describedby={d} rows={10} value={f.content as string} onChange={(e) => setF({ content: e.target.value })} />}
          </Field>
        )}

        <div className="border-t border-border pt-4 space-y-3">
          <Row>
            <Field label="Project">
              {(id) => (
                <Select id={id} value={draft.projectId ?? ''} onChange={(e) => set({ projectId: e.target.value || null })} disabled={!!existing && existing.shared && existing.vaultId !== snap.projects.find((p) => p.id === existing.payload.projectId)?.vaultId}>
                  <option value="">No project</option>
                  {writableProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.payload.name}
                      {p.shared ? ' (shared)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Environment">
              {(id) => (
                <>
                  <Input id={id} list={`${id}-envs`} value={draft.environment ?? ''} onChange={(e) => set({ environment: e.target.value || null })} placeholder="e.g. Production" />
                  <datalist id={`${id}-envs`}>
                    {envOptions.map((e) => (
                      <option key={e} value={e} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
          </Row>
          {projectShared && !existing && (
            <Banner tone="warn" icon={<Share2 className="size-4" />} title="This project is shared">
              New items in “{project!.payload.name}” are encrypted to the project’s shared vault, so every project member can access them.
            </Banner>
          )}
          {existing && draft.projectId !== existing.payload.projectId && project?.vaultId !== existing.vaultId && (
            <Banner tone="neutral">Changing the project only updates the label. To move an item into or out of a shared project, use Share or Manage access.</Banner>
          )}
          <Row>
            <Field label="Category / folder">{(id) => <Input id={id} value={draft.folder} onChange={(e) => set({ folder: e.target.value })} placeholder="e.g. Work/Infra" />}</Field>
            <Field label="Tags" hint="Press comma or Enter to add a tag">
              {(id, d) => <TagInput id={id} describedBy={d} value={draft.tags} onChange={(tags) => set({ tags })} />}
            </Field>
          </Row>
          <Field label="Identifier" hint={`Short label shown next to the title and found by search, e.g. “personal” or “client A” (up to ${IDENTIFIER_MAX} characters).`}>
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                maxLength={Math.max(IDENTIFIER_MAX, draft.description.length)}
                value={draft.description}
                placeholder="e.g. personal"
                onChange={(e) => set({ description: e.target.value })}
              />
            )}
          </Field>
          <Field label="Private notes" hint="Encrypted. Rendered as plain text.">
            {(id, d) => <TextArea id={id} aria-describedby={d} rows={3} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />}
          </Field>
        </div>

        <fieldset className="border-t border-border pt-4 space-y-2">
          <legend className="text-xs font-medium text-fg-muted">Custom fields</legend>
          {customFields.map((cf, i) => (
            <div key={cf.id} className="flex gap-2">
              <Input aria-label="Field label" placeholder="Label" className="!w-40" value={cf.label} onChange={(e) => setCustom(customFields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <Select aria-label="Field type" className="!w-28" value={cf.type} onChange={(e) => setCustom(customFields.map((x, j) => (j === i ? { ...x, type: e.target.value as CustomField['type'] } : x)))}>
                {CUSTOM_FIELD_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </Select>
              <div className="flex-1">
                {cf.type === 'secret' ? (
                  <SecretInput value={cf.value} onChange={(v) => setCustom(customFields.map((x, j) => (j === i ? { ...x, value: v } : x)))} />
                ) : (
                  <Input aria-label="Field value" value={cf.value} onChange={(e) => setCustom(customFields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                )}
              </div>
              <IconButton label="Remove field" onClick={() => setCustom(customFields.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setCustom([...customFields, { id: crypto.randomUUID(), label: '', type: 'text', value: '' }])}>
            Add field
          </Button>
        </fieldset>
        {Object.keys(errors).length > 0 && (
          <Banner tone="danger" title="Please fix the highlighted fields">
            {Object.entries(errors)
              .map(([k, v]) => `${k}: ${v}`)
              .join('; ')}
          </Banner>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function SshKeyFields({ f, setF, errors, hasNative }: { f: Record<string, unknown>; setF: (p: Record<string, unknown>) => void; errors: Record<string, string>; hasNative: boolean }) {
  const { ext } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [alg, setAlg] = useState<'ed25519' | 'ecdsa-p256' | 'rsa-3072' | 'rsa-4096'>('ed25519');
  const analyze = async (publicKey: string, privateKey: string, passphrase?: string) => {
    try {
      if (ext.sshKeys && (privateKey || publicKey)) {
        const r = await ext.sshKeys.inspect({ privateKey: privateKey || undefined, publicKey: publicKey || undefined, passphrase });
        setF({ publicKey: r.publicKey, fingerprint: r.fingerprint, algorithm: r.algorithm, comment: r.comment || (f.comment as string | undefined) });
        if (r.encrypted && !passphrase) toast('This private key is passphrase-protected. Enter the passphrase so it can be used for connections.', 'warn');
      } else if (publicKey) {
        const info = await sshPublicKeyInfo(publicKey);
        setF({ fingerprint: info.fingerprint, algorithm: info.algorithm, comment: info.comment || (f.comment as string | undefined) });
      }
    } catch (e) {
      toast(`Could not read key: ${errorMessage(e)}`, 'error');
    }
  };
  return (
    <>
      {hasNative && (
        <div className="flex items-end gap-2 rounded-lg border border-border bg-surface-2 p-3">
          <Field label="Generate a new key" className="flex-1">
            {(id) => (
              <Select id={id} value={alg} onChange={(e) => setAlg(e.target.value as typeof alg)}>
                <option value="ed25519">Ed25519 (recommended)</option>
                <option value="ecdsa-p256">ECDSA P-256</option>
                <option value="rsa-3072">RSA 3072</option>
                <option value="rsa-4096">RSA 4096</option>
              </Select>
            )}
          </Field>
          <Button
            icon={<KeyRound className="size-4" />}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await ext.sshKeys!.generate({ algorithm: alg, comment: (f.comment as string) || 'passvault', passphrase: (f.passphrase as string) || undefined });
                setF({ publicKey: r.publicKey, privateKey: r.privateKey, fingerprint: r.fingerprint, algorithm: r.algorithm });
              } catch (e) {
                toast(errorMessage(e), 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Generate
          </Button>
        </div>
      )}
      <Field label="Private key" hint="Paste an OpenSSH or PEM private key. Stored encrypted." error={errors['fields.privateKey']}>
        {(id, d) => <TextArea id={id} aria-describedby={d} rows={5} spellCheck={false} className="font-mono text-xs" value={f.privateKey as string} onChange={(e) => setF({ privateKey: e.target.value })} onBlur={() => void analyze(f.publicKey as string, f.privateKey as string, f.passphrase as string)} />}
      </Field>
      <Field label="Passphrase (optional)">{(id) => <SecretInput id={id} value={(f.passphrase as string) ?? ''} onChange={(v) => setF({ passphrase: v || undefined })} />}</Field>
      <Field label="Public key" hint={hasNative ? 'Derived from the private key when possible.' : 'Paste the matching .pub line to compute the fingerprint.'}>
        {(id, d) => <TextArea id={id} aria-describedby={d} rows={2} spellCheck={false} className="font-mono text-xs" value={f.publicKey as string} onChange={(e) => setF({ publicKey: e.target.value })} onBlur={() => void analyze(f.publicKey as string, f.privateKey as string, f.passphrase as string)} />}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fingerprint">{(id) => <Input id={id} readOnly value={f.fingerprint as string} className="font-mono text-xs" />}</Field>
        <Field label="Algorithm">{(id) => <Input id={id} readOnly value={f.algorithm as string} />}</Field>
      </div>
      <Field label="Comment">{(id) => <Input id={id} value={(f.comment as string) ?? ''} onChange={(e) => setF({ comment: e.target.value || undefined })} />}</Field>
    </>
  );
}

/** Payment card: number stored as digits, shown in groups of four; brand and checksum are hints. */
function CardFields({ f, setF, err }: { f: Record<string, unknown>; setF: (patch: Record<string, unknown>) => void; err: (path: string) => string | null }) {
  const number = String(f.number ?? '');
  const brand = cardBrand(number);
  const grouped = brand === 'American Express' ? number.replace(/^(\d{0,4})(\d{0,6})(\d{0,5}).*/, (_, a, b, c) => [a, b, c].filter(Boolean).join(' ')) : number.replace(/(\d{4})(?=\d)/g, '$1 ');
  const year = new Date().getFullYear();
  const years = Array.from({ length: 16 }, (_, i) => String(year - 1 + i));
  const expYear = String(f.expYear ?? '');
  if (expYear && !years.includes(expYear)) years.unshift(expYear);
  return (
    <>
      <Field label="Name on card">{(id) => <Input id={id} value={String(f.cardholder ?? '')} onChange={(e) => setF({ cardholder: e.target.value })} autoComplete="off" />}</Field>
      <Field
        label="Card number"
        error={err('number')}
        hint={number.length >= 12 && !luhnValid(number) ? 'This number does not pass the card checksum — check for a typo.' : number ? brand : 'Digits only; spaces are added for you.'}
      >
        {(id, d) => (
          <Input
            id={id}
            aria-describedby={d}
            inputMode="numeric"
            autoComplete="off"
            className="font-mono tracking-wider"
            value={grouped}
            maxLength={23}
            onChange={(e) => setF({ number: cardDigits(e.target.value).slice(0, 19) })}
            placeholder="1234 5678 9012 3456"
          />
        )}
      </Field>
      <Row>
        <Field label="Expiry month" error={err('expMonth')}>
          {(id) => (
            <Select id={id} value={String(f.expMonth ?? '')} onChange={(e) => setF({ expMonth: e.target.value })}>
              <option value="">—</option>
              {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Expiry year" error={err('expYear')}>
          {(id) => (
            <Select id={id} value={expYear} onChange={(e) => setF({ expYear: e.target.value })}>
              <option value="">—</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </Row>
      <Row>
        <Field label="Security code (CVV)" error={err('cvv')}>
          {(id) => <SecretInput id={id} value={String(f.cvv ?? '')} onChange={(v) => setF({ cvv: cardDigits(v).slice(0, 4) })} />}
        </Field>
        <Field label="PIN" error={err('pin')}>
          {(id) => <SecretInput id={id} value={String(f.pin ?? '')} onChange={(v) => setF({ pin: v.slice(0, 32) })} />}
        </Field>
      </Row>
    </>
  );
}
