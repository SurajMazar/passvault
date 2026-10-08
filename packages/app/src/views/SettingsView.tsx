import { useEffect, useMemo, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { Fingerprint, LogOut, MonitorSmartphone, ShieldCheck, Trash2, Download } from 'lucide-react';
import type { AuditEventDto, DeviceListItem, SessionListItem } from '@passvault/types';
import { Badge, Banner, Button, Card, Field, IconButton, Input, SecretInput, Select, Spinner, StrengthMeter, Switch, Tabs, TypeIcon, useConfirm, useToast } from '@passvault/ui';
import { computeInsights, passwordStrength } from '@passvault/vault-core';
import { useApp, useSnapshot, useUi, errorMessage } from '../state';
import { GeneratorPanel } from './Generator';

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card title={title}>
      {description && <p className="-mt-1 mb-3 text-sm text-fg-muted">{description}</p>}
      {children}
    </Card>
  );
}

function SecurityTab() {
  const snap = useSnapshot();
  const ui = useUi();
  const live = snap.items.filter((i) => !i.payload.trashedAt && !i.payload.archived);
  const r = useMemo(() => computeInsights(live.map((i) => ({ id: i.id, payload: i.payload }))), [live]);
  const title = (id: string) => snap.items.find((i) => i.id === id);
  const Row = ({ id, note }: { id: string; note?: string }) => {
    const it = title(id);
    if (!it) return null;
    return (
      <li>
        <button className="flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-bg-subtle" onClick={() => ui.go(it.payload.type, { selectedId: id })}>
          <TypeIcon type={it.payload.type} size="sm" />
          <span className="flex-1 truncate text-sm">{it.payload.title}</span>
          {note && <span className="text-xs text-fg-subtle">{note}</span>}
        </button>
      </li>
    );
  };
  return (
    <div className="space-y-4">
      <Banner tone="neutral">Checked {r.checked} passwords locally with zxcvbn. No password or hash leaves this device.</Banner>
      <Section title={`Weak passwords (${r.weak.length})`}>
        {r.weak.length ? <ul>{r.weak.map((w) => <Row key={w.id} id={w.id} note={['very weak', 'weak', 'fair'][w.score]} />)}</ul> : <p className="text-sm text-fg-muted">None found.</p>}
      </Section>
      <Section title={`Reused passwords (${r.reused.length} groups)`}>
        {r.reused.length ? (
          <div className="space-y-3">
            {r.reused.map((g, i) => (
              <ul key={i} className="rounded-md border border-border p-1">
                {g.ids.map((id) => (
                  <Row key={id} id={id} />
                ))}
              </ul>
            ))}
          </div>
        ) : (
          <p className="text-sm text-fg-muted">None found.</p>
        )}
      </Section>
      <Section title={`Expiring credentials (${r.expiringSoon.length})`}>
        {r.expiringSoon.length ? <ul>{r.expiringSoon.map((e) => <Row key={e.id} id={e.id} note={e.expired ? 'expired' : `expires ${e.expiresAt}`} />)}</ul> : <p className="text-sm text-fg-muted">Nothing expires in the next 30 days.</p>}
      </Section>
      <Section title={`Logins without HTTPS (${r.insecureUrls.length})`}>
        {r.insecureUrls.length ? <ul>{r.insecureUrls.map((id) => <Row key={id} id={id} />)}</ul> : <p className="text-sm text-fg-muted">None.</p>}
      </Section>
    </div>
  );
}

function AccountTab() {
  const { session } = useApp();
  const snap = useSnapshot();
  const toast = useToast();
  const confirm = useConfirm();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [code, setCode] = useState('');
  const [signOut, setSignOut] = useState(true);
  const [rotate, setRotate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newRecovery, setNewRecovery] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [reenroll, setReenroll] = useState<{ secret: string; qr: string } | null>(null);
  const [reCode, setReCode] = useState('');
  const strength = next ? passwordStrength(next) : null;
  return (
    <div className="space-y-4">
      <Section title="Account">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-fg-subtle">Name</dt>
          <dd>{snap.user?.name}</dd>
          <dt className="text-fg-subtle">Email</dt>
          <dd>{snap.user?.email}</dd>
          <dt className="text-fg-subtle">Two-step</dt>
          <dd>{snap.user?.mfaEnabled ? <Badge tone="ok">Authenticator app</Badge> : <Badge tone="danger">Not set up</Badge>}</dd>
        </dl>
      </Section>
      <Section
        title="Change master password"
        description="Your User Key is re-wrapped under the new password; items are not re-encrypted. Devices that are offline can still open their cached vault with the old password until they reconnect — choose “sign out other devices” to force them to sign in again."
      >
        <div className="grid max-w-xl gap-3">
          <Field label="Current master password">{(id) => <SecretInput id={id} value={cur} onChange={setCur} autoComplete="current-password" />}</Field>
          <Field label="New master password">{(id) => <SecretInput id={id} value={next} onChange={setNext} autoComplete="new-password" />}</Field>
          {strength && <StrengthMeter score={strength.score} label={strength.label} />}
          <Field label="Confirm new master password">{(id) => <SecretInput id={id} value={next2} onChange={setNext2} autoComplete="new-password" />}</Field>
          <Field label="Authenticator code">{(id) => <Input id={id} className="!w-32 font-mono" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />}</Field>
          <Switch checked={signOut} onChange={setSignOut} label="Sign out all other devices" />
          <Switch checked={rotate} onChange={setRotate} label="Also rotate my account encryption key" description="Use after a suspected device compromise. Issues a new recovery key and disables biometric unlock on this device." />
          <div>
            <Button
              variant="primary"
              loading={busy}
              disabled={!cur || !next || next !== next2 || (strength?.score ?? 0) < 3 || next.length < 12 || code.length !== 6}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await session.changeMasterPassword({ currentPassword: cur, newPassword: next, code, signOutOtherSessions: signOut, rotateUserKey: rotate });
                  toast('Master password changed', 'success');
                  setCur('');
                  setNext('');
                  setNext2('');
                  setCode('');
                  if (r.newRecoveryKey) setNewRecovery(r.newRecoveryKey);
                } catch (e) {
                  toast(errorMessage(e), 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Change master password
            </Button>
          </div>
          {newRecovery && (
            <Banner tone="warn" title="Save your new recovery key — the old one no longer works">
              <div className="mt-1 font-mono text-sm break-all select-all text-fg">{newRecovery}</div>
            </Banner>
          )}
        </div>
      </Section>
      <Section title="Two-step verification" description="Recovery codes let you sign in without your authenticator. Each works once. They restore account access only — they cannot decrypt your vault.">
        <ReauthActions
          onRegenerate={async (pw, c) => setCodes(await session.regenerateRecoveryCodes(pw, c))}
          onReenroll={async (pw, c) => {
            const r = await session.startMfaReenrollment(pw, c);
            setReenroll({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 180 }) });
          }}
        />
        {codes && (
          <div className="mt-3 space-y-2">
            <Banner tone="warn">Your previous recovery codes no longer work. Save these now.</Banner>
            <ol className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-surface-2 p-3 font-mono text-sm sm:grid-cols-5">
              {codes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
          </div>
        )}
        {reenroll && (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <img src={reenroll.qr} alt="New authenticator QR code" className="rounded border border-border bg-white p-1" />
            <div className="space-y-2">
              <div className="font-mono text-xs break-all">{reenroll.secret}</div>
              <Input aria-label="Code from new authenticator" className="!w-32 font-mono" value={reCode} onChange={(e) => setReCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  try {
                    setCodes(await session.confirmMfaReenrollment(reCode));
                    setReenroll(null);
                    toast('Authenticator replaced. Trusted devices were reset.', 'success');
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }}
              >
                Confirm
              </Button>
            </div>
          </div>
        )}
      </Section>
      <Section title="Sign out everywhere" description="Revokes every session on every device, including this one. Encrypted caches stay on devices until they are signed out locally.">
        <LogoutEverywhere />
      </Section>
      <Section title="Delete local data">
        <Button
          variant="danger"
          icon={<Trash2 className="size-4" />}
          onClick={async () => {
            if (await confirm({ title: 'Sign out and remove local data?', body: 'Removes the encrypted cache from this device. Unsynced changes are lost.', confirmLabel: 'Sign out' })) await session.logout();
          }}
        >
          Sign out of this device
        </Button>
      </Section>
    </div>
  );
}

function ReauthActions({ onRegenerate, onReenroll }: { onRegenerate: (pw: string, code: string) => Promise<void>; onReenroll: (pw: string, code: string) => Promise<void> }) {
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const run = (fn: (p: string, c: string) => Promise<void>) => async () => {
    try {
      await fn(pw, code);
      setPw('');
      setCode('');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Master password">{(id) => <SecretInput id={id} value={pw} onChange={setPw} />}</Field>
      <Field label="Current code">{(id) => <Input id={id} className="!w-28 font-mono" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />}</Field>
      <Button disabled={!pw || code.length !== 6} onClick={run(onRegenerate)}>
        New recovery codes
      </Button>
      <Button disabled={!pw || code.length !== 6} onClick={run(onReenroll)}>
        Replace authenticator
      </Button>
    </div>
  );
}

function LogoutEverywhere() {
  const { session } = useApp();
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Master password">{(id) => <SecretInput id={id} value={pw} onChange={setPw} />}</Field>
      <Field label="Code">{(id) => <Input id={id} className="!w-28 font-mono" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />}</Field>
      <Button variant="danger" icon={<LogOut className="size-4" />} disabled={!pw || code.length !== 6} onClick={() => session.logoutEverywhere(pw, code).catch((e) => toast(errorMessage(e), 'error'))}>
        Sign out everywhere
      </Button>
    </div>
  );
}

function SessionsTab() {
  const { session } = useApp();
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [devices, setDevices] = useState<DeviceListItem[] | null>(null);
  const reload = async () => {
    try {
      const [s, d] = await Promise.all([session.listSessions(), session.listDevices()]);
      setSessions(s);
      setDevices(d);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="space-y-4">
      <Section title="Active sessions">
        {!sessions ? (
          <Spinner />
        ) : (
          <ul className="divide-y divide-border">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2">
                <MonitorSmartphone className="size-4 text-fg-subtle" />
                <div className="min-w-0 flex-1 text-sm">
                  <div>
                    {s.deviceName} <span className="text-fg-subtle">· {s.clientType}</span> {s.current && <Badge tone="accent">This device</Badge>}
                  </div>
                  <div className="text-xs text-fg-subtle">
                    Last active {new Date(s.lastSeenAt).toLocaleString()}
                    {s.ipPrefix && ` · ${s.ipPrefix}`}
                  </div>
                </div>
                {!s.current && (
                  <Button size="sm" onClick={async () => (await session.revokeSession(s.id), void reload())}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Devices" description="Trusted devices skip the two-step prompt for 30 days. Removing a device signs it out.">
        {!devices ? (
          <Spinner />
        ) : (
          <ul className="divide-y divide-border">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div>
                    {d.name} <span className="text-fg-subtle">· {d.clientType}</span> {d.trusted && <Badge tone="ok">Trusted until {d.trustedUntil ? new Date(d.trustedUntil).toLocaleDateString() : '?'}</Badge>}
                  </div>
                  <div className="text-xs text-fg-subtle">
                    First seen {new Date(d.firstSeenAt).toLocaleDateString()} · {d.activeSessions} active session(s)
                  </div>
                </div>
                {d.trusted && (
                  <Button size="sm" onClick={async () => (await session.untrustDevice(d.id), void reload())}>
                    Untrust
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={async () => (await session.forgetDevice(d.id), void reload())}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function SharingTab() {
  const { session } = useApp();
  const snap = useSnapshot();
  const contacts = Object.entries(snap.settings.contacts);
  return (
    <div className="space-y-4">
      <Section title="Your sharing fingerprint" description="Read this to people who share with you so they can confirm they are encrypting to your real key.">
        <div className="flex items-center gap-2 font-mono text-sm tracking-wide">
          <Fingerprint className="size-4 text-fg-subtle" />
          {session.myFingerprint()}
        </div>
      </Section>
      <Section title="Known contacts" description="Keys are pinned the first time you share. A changed key blocks sharing until you verify it again.">
        {contacts.length === 0 ? (
          <p className="text-sm text-fg-muted">No contacts yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {contacts.map(([id, c]) => (
              <li key={id} className="flex items-center gap-2 py-2 text-sm">
                <span className="flex-1">{c.email}</span>
                {c.fingerprint && <span className="hidden font-mono text-xs text-fg-subtle md:inline">{c.fingerprint}</span>}
                {c.verified ? <Badge tone="ok"><ShieldCheck className="size-3" /> verified</Badge> : <Badge>unverified</Badge>}
                <IconButton
                  size="sm"
                  label="Forget contact"
                  onClick={() => {
                    const next = { ...snap.settings.contacts };
                    delete next[id];
                    void session.saveSettings({ ...snap.settings, contacts: next });
                  }}
                >
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function PreferencesTab() {
  const { session } = useApp();
  const snap = useSnapshot();
  const ui = useUi();
  const toast = useToast();
  const [bio, setBio] = useState<{ available: boolean; reason?: string; enabled: boolean } | null>(null);
  useEffect(() => {
    const b = session.platformRef.biometrics;
    if (!b) return;
    void Promise.all([b.status(), session.biometricsEnabled()]).then(([s, enabled]) => setBio({ ...s, enabled }));
  }, [session]);
  const s = snap.settings;
  return (
    <div className="space-y-4">
      <Section title="Locking">
        <div className="grid max-w-md gap-3">
          <Field label="Lock after inactivity" hint="Applies on this account across devices. Locking clears decrypted data from memory.">
            {(id, d) => (
              <Select id={id} aria-describedby={d} value={String(s.lockTimeoutMinutes)} onChange={(e) => void session.saveSettings({ ...s, lockTimeoutMinutes: Number(e.target.value) })}>
                {[1, 5, 15, 30, 60, 240].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} minute${m > 1 ? 's' : ''}` : `${m / 60} hour${m > 60 ? 's' : ''}`}
                  </option>
                ))}
                <option value="0">Never (not recommended)</option>
              </Select>
            )}
          </Field>
          <Field label="Clear clipboard after copying a secret">
            {(id) => (
              <Select id={id} value={String(s.clipboardClearSeconds)} onChange={(e) => void session.saveSettings({ ...s, clipboardClearSeconds: Number(e.target.value) })}>
                {[10, 20, 30, 60, 120].map((n) => (
                  <option key={n} value={n}>
                    {n} seconds
                  </option>
                ))}
                <option value="0">Never</option>
              </Select>
            )}
          </Field>
        </div>
      </Section>
      {session.platformRef.biometrics && (
        <Section title="Touch ID" description="Keeps a device-only key that only your fingerprint can release: the Keychain on signed builds, otherwise this Mac’s Secure Enclave. That key unwraps your vault key on this Mac; your master password always works too.">
          {!bio ? (
            <Spinner />
          ) : !bio.available ? (
            <Banner tone="neutral">Unavailable: {bio.reason ?? 'not supported on this device'}</Banner>
          ) : (
            <Switch
              checked={bio.enabled}
              onChange={async (v) => {
                try {
                  if (v) await session.enableBiometrics();
                  else await session.disableBiometrics();
                  setBio({ ...bio, enabled: v });
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
              }}
              label="Unlock with Touch ID"
            />
          )}
        </Section>
      )}
      <Section title="Appearance">
        <Field label="Theme">
          {(id) => (
            <Select id={id} className="!w-48" value={ui.theme} onChange={(e) => ui.set({ theme: e.target.value as typeof ui.theme })}>
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          )}
        </Field>
      </Section>
    </div>
  );
}

function SyncTab() {
  const { session } = useApp();
  const snap = useSnapshot();
  const ui = useUi();
  const problems = [...snap.items, ...snap.projects].filter((i) => i.conflict || i.failed);
  return (
    <div className="space-y-4">
      <Section title="Sync status">
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
          <dt className="text-fg-subtle">Connection</dt>
          <dd>{snap.online ? 'Online' : 'Offline'}</dd>
          <dt className="text-fg-subtle">State</dt>
          <dd>{snap.sync.state}</dd>
          <dt className="text-fg-subtle">Last sync</dt>
          <dd>{snap.sync.lastSyncAt ? new Date(snap.sync.lastSyncAt).toLocaleString() : 'never'}</dd>
          <dt className="text-fg-subtle">Pending changes</dt>
          <dd>{snap.sync.pending}</dd>
          <dt className="text-fg-subtle">Failed</dt>
          <dd>{snap.sync.failed}</dd>
          <dt className="text-fg-subtle">Conflicts</dt>
          <dd>{snap.sync.conflicts}</dd>
        </dl>
        <Button className="mt-3" onClick={() => void session.syncNow().catch(() => undefined)}>
          Sync now
        </Button>
      </Section>
      <Section title="Needs attention">
        {problems.length === 0 ? (
          <p className="text-sm text-fg-muted">Everything is in sync.</p>
        ) : (
          <ul className="space-y-2">
            {problems.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1">{p.kind === 'item' ? p.payload.title : p.payload.name}</span>
                {p.conflict && (
                  <Button size="sm" onClick={() => ui.set({ conflictId: p.id })}>
                    Resolve conflict
                  </Button>
                )}
                {p.failed && (
                  <>
                    <span className="text-xs text-danger">{p.failed.error}</span>
                    <Button size="sm" onClick={() => void session.retryFailed(p.id)}>
                      Retry
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void session.discardFailed(p.id)}>
                      Discard
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="How sync works">
        <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
          <li>Only encrypted records are cached on this device and sent to the server.</li>
          <li>Edits made offline are queued and replayed safely; a newer server version is never overwritten without your decision.</li>
          <li>Permanently deleted items leave a tombstone so stale devices cannot bring them back.</li>
          <li>An offline device cannot learn about revoked access until it reconnects; it keeps what it had cached until then.</li>
        </ul>
      </Section>
    </div>
  );
}

function AuditTab() {
  const { session } = useApp();
  const [events, setEvents] = useState<AuditEventDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async (c?: string) => {
    try {
      const r = await session.auditEvents(c);
      setEvents((e) => [...(c ? (e ?? []) : []), ...r.data]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Section title="Security activity" description="Server-observed account and sharing events. Local actions such as revealing, copying, or autofilling are not recorded and cannot be proven.">
      {error && <Banner tone="danger">{error}</Banner>}
      {!events && !error && <Spinner />}
      {events && (
        <ul className="divide-y divide-border text-sm">
          {events.map((e) => (
            <li key={e.id} className="flex gap-3 py-1.5">
              <span className="w-44 shrink-0 text-xs text-fg-subtle">{new Date(e.createdAt).toLocaleString()}</span>
              <span className="font-mono text-xs">{e.type}</span>
              <span className="truncate text-xs text-fg-subtle">{e.ipPrefix ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <Button size="sm" className="mt-2" onClick={() => void load(cursor)}>
          Load more
        </Button>
      )}
    </Section>
  );
}

function ExportTab() {
  const { session } = useApp();
  const confirm = useConfirm();
  const toast = useToast();
  return (
    <div className="space-y-4">
      <Section title="Export vault" description="Creates a plaintext JSON file of your items. Decryption happens on this device.">
        <Banner tone="danger" title="Plaintext secrets">
          Anyone who can read the exported file can read every secret in it. Store it encrypted, never commit it to source control, and remember that deleting a file does not guarantee it is erased from disk.
        </Banner>
        <Button
          className="mt-3"
          icon={<Download className="size-4" />}
          onClick={async () => {
            if (!(await confirm({ title: 'Export all items as plaintext?', confirmLabel: 'Choose location…', typeToConfirm: 'EXPORT' }))) return;
            const r = await session.platformRef.files.saveTextFile({ suggestedName: `passvault-export-${new Date().toISOString().slice(0, 10)}.json`, text: session.exportPlaintext() });
            if (r.saved) toast(r.ownerOnly ? 'Exported with owner-only permissions' : 'Exported', 'success');
          }}
        >
          Export…
        </Button>
      </Section>
      <Section title="What the server can see">
        <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
          <li>Your email, name, and public keys; when you sign in, from which device type and IP prefix.</li>
          <li>Encrypted records: their ids, sizes (padded), which vault they belong to, revision numbers, and timestamps.</li>
          <li>Who shares with whom, their roles, and expiry dates.</li>
          <li>Never: item titles, usernames, URLs, hosts, notes, tags, project names, file contents, or your search queries.</li>
        </ul>
      </Section>
    </div>
  );
}

export function SettingsView() {
  const { ext } = useApp();
  const ui = useUi();
  const tabs: Array<{ id: string; label: string; render: () => ReactNode }> = [
    { id: 'security', label: 'Security', render: () => <SecurityTab /> },
    { id: 'account', label: 'Account', render: () => <AccountTab /> },
    { id: 'sessions', label: 'Sessions & devices', render: () => <SessionsTab /> },
    { id: 'sharing', label: 'Sharing', render: () => <SharingTab /> },
    { id: 'preferences', label: 'Preferences', render: () => <PreferencesTab /> },
    { id: 'generator', label: 'Generator', render: () => <Card><GeneratorPanel /></Card> },
    { id: 'sync', label: 'Sync', render: () => <SyncTab /> },
    { id: 'audit', label: 'Activity', render: () => <AuditTab /> },
    { id: 'export', label: 'Export & privacy', render: () => <ExportTab /> },
    ...(ext.settingsSections ?? []),
  ];
  const active = tabs.find((t) => t.id === ui.settingsTab) ?? tabs[0]!;
  return (
    <div className="h-full overflow-y-auto pv-scroll">
      <div className="mx-auto max-w-5xl p-4 sm:p-8">
        <h1 className="mb-6 text-xl font-semibold tracking-tight">Security & settings</h1>
        <div className="lg:hidden mb-4 overflow-x-auto">
          <Tabs label="Settings sections" value={active.id} onChange={(id) => ui.set({ settingsTab: id })} tabs={tabs.map((t) => ({ id: t.id, label: t.label }))} />
        </div>
        <div className="grid gap-8 lg:grid-cols-[13rem_1fr]">
          <nav aria-label="Settings sections" className="hidden lg:block">
            <ul className="sticky top-0 space-y-0.5">
              {tabs.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-current={t.id === active.id ? 'page' : undefined}
                    onClick={() => ui.set({ settingsTab: t.id })}
                    className={
                      t.id === active.id
                        ? 'w-full rounded-lg bg-surface px-3 h-9 text-left text-[13.5px] font-medium text-fg shadow-[var(--shadow-card)] ring-1 ring-border'
                        : 'w-full rounded-lg px-3 h-9 text-left text-[13.5px] text-fg-muted hover:bg-surface-3 hover:text-fg'
                    }
                  >
                    {t.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="min-w-0 space-y-4">{active.render()}</div>
        </div>
      </div>
    </div>
  );
}
