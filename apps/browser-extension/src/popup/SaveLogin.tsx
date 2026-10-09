import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Save, ShieldAlert } from 'lucide-react';
import { Banner, Button, Field, IconButton, Input, SecretInput, Select, Spinner, TextArea, useConfirm, useToast } from '@passvault/ui';
import { URL_MATCH_LABELS } from '@passvault/types';
import type { CaptureResponse, MetaResponse } from '../shared/protocol';
import { call, errorText } from './rpc';

const MATCH_MODES = ['host', 'base_domain', 'starts_with', 'exact'] as const;
type MatchMode = (typeof MATCH_MODES)[number];

/**
 * "Save login from this page": reads the current username/password from the
 * top frame (one-shot injection), then requires explicit confirmation here.
 * Nothing is saved until the user presses Save / Update.
 */
export function SaveLogin({ tabId, onDone }: { tabId: number; onDone: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [cap, setCap] = useState<CaptureResponse | null>(null);
  const [meta, setMeta] = useState<MetaResponse>({ folders: [], tags: [], projects: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState('');
  const [match, setMatch] = useState<MatchMode>('host');
  const [folder, setFolder] = useState('');
  const [tags, setTags] = useState('');
  const [projectId, setProjectId] = useState('');
  const [notes, setNotes] = useState('');
  // other fields of the login form (e.g. "Account ID or alias"), saved as custom fields
  const [extras, setExtras] = useState<Array<{ label: string; value: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void call({ type: 'autofill.capture', tabId })
      .then((c) => {
        setCap(c);
        setTitle(c.suggestedTitle);
        setUsername(c.username);
        setPassword(c.password);
        setUrl(c.origin);
        setExtras(c.extras);
      })
      .catch((e) => setLoadError(errorText(e)));
    void call({ type: 'vault.meta' })
      .then(setMeta)
      .catch(() => undefined);
    // Clear captured secrets from popup memory when leaving.
    return () => {
      setPassword('');
      setCap(null);
    };
  }, [tabId]);

  const update = cap?.existing.find((e) => e.passwordDiffers && !e.readOnly && e.username.trim().toLowerCase() === username.trim().toLowerCase());
  const same = cap?.existing.find((e) => !e.passwordDiffers && e.username.trim().toLowerCase() === username.trim().toLowerCase());

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call({
        type: 'item.saveLogin',
        confirmed: true,
        draft: {
          title: title.trim(),
          username,
          password,
          url: url.trim(),
          match,
          notes,
          folder,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          projectId: projectId || null,
          extras,
        },
      });
      toast('Login saved to your vault.', 'success');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const updatePassword = async () => {
    if (!update) return;
    const ok = await confirm({
      title: 'Update saved password?',
      body: (
        <p>
          The password of <strong className="text-fg">{update.title}</strong> ({update.username || 'no username'}) will be replaced with the one on this page. The
          previous password stays in the item history.
        </p>
      ),
      confirmLabel: 'Update password',
      tone: 'primary',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await call({ type: 'item.updatePassword', confirmed: true, id: update.id, password });
      toast('Password updated.', 'success');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <IconButton label="Back" size="sm" onClick={onDone}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <h2 className="text-sm font-semibold">Save login from this page</h2>
      </div>
      {loadError ? (
        <Banner tone="danger">{loadError}</Banner>
      ) : !cap ? (
        <Spinner />
      ) : (
        <form onSubmit={save} className="flex flex-col gap-2.5">
          {cap.insecure && (
            <Banner tone="warn" icon={<ShieldAlert className="size-4" />}>
              This page does not use HTTPS. Saving is allowed, but filling it later will ask for confirmation.
            </Banner>
          )}
          {!cap.foundPasswordField && <Banner>No password field was found on this page. You can still enter the details yourself.</Banner>}
          {update && (
            <Banner
              tone="accent"
              title="This login is already saved"
              action={
                <Button size="sm" variant="primary" onClick={() => void updatePassword()} disabled={busy || !password}>
                  Update password
                </Button>
              }
            >
              “{update.title}” has a different password for this username.
            </Banner>
          )}
          {same && !update && <Banner tone="ok">Already saved as “{same.title}” with this password.</Banner>}
          <Field label="Title">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />}</Field>
          <Field label="Username">{(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} />}</Field>
          <Field label="Password">{(id) => <SecretInput id={id} value={password} onChange={setPassword} />}</Field>
          <Field label="Website">{(id) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} required spellCheck={false} />}</Field>
          <Field label="Match" hint="Exact host is the safest default.">
            {(id, d) => (
              <Select id={id} aria-describedby={d} value={match} onChange={(e) => setMatch(e.target.value as MatchMode)}>
                {MATCH_MODES.map((m) => (
                  <option key={m} value={m}>
                    {URL_MATCH_LABELS[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Folder">
              {(id) => (
                <>
                  <Input id={id} list="pv-folders" value={folder} onChange={(e) => setFolder(e.target.value)} />
                  <datalist id="pv-folders">
                    {meta.folders.map((f) => (
                      <option key={f} value={f} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
            <Field label="Tags">{(id) => <Input id={id} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="work, sso" />}</Field>
          </div>
          {meta.projects.length > 0 && (
            <Field label="Project">
              {(id) => (
                <Select id={id} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">None (personal vault)</option>
                  {meta.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {extras.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[13px] font-medium text-fg">Also saved from this form</span>
              {extras.map((x, i) => (
                <div key={`${x.label}-${i}`} className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs">
                  <span className="min-w-0 flex-1 truncate" title={`${x.label}: ${x.value}`}>
                    <span className="text-fg-subtle">{x.label}:</span> {x.value}
                  </span>
                  <button type="button" className="text-fg-subtle hover:text-fg" aria-label={`Don’t save ${x.label}`} onClick={() => setExtras((xs) => xs.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <Field label="Notes">{(id) => <TextArea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="min-h-12" />}</Field>
          {error && <Banner tone="danger">{error}</Banner>}
          <div className="flex justify-end gap-2 pt-1">
            <Button onClick={onDone}>Cancel</Button>
            <Button type="submit" variant={update ? 'secondary' : 'primary'} loading={busy} disabled={!title.trim() || !url.trim()} icon={<Save className="size-4" />}>
              {update ? 'Save as new' : 'Save'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
