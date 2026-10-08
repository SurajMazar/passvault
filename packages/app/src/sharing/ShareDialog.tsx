import { useEffect, useState } from 'react';
import { AlertTriangle, ShieldCheck, UserMinus, UserPlus, RotateCw, Fingerprint } from 'lucide-react';
import type { VaultMemberDto, VaultRole } from '@passvault/types';
import { Badge, Banner, Button, Checkbox, Dialog, Field, IconButton, Input, Select, Spinner, Switch, useConfirm, useToast } from '@passvault/ui';
import type { RecipientInfo } from '@passvault/vault-core';
import { useApp, useSnapshot, useUi, errorMessage } from '../state';

function FingerprintBox({ r, verified, onVerified }: { r: RecipientInfo; verified: boolean; onVerified: (v: boolean) => void }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
      <div className="flex items-center gap-2">
        <Fingerprint className="size-4 text-fg-subtle" />
        <span className="font-medium">{r.name}</span>
        <span className="text-fg-subtle">{r.email}</span>
        {r.pinned === 'match' && <Badge tone="ok">Known key</Badge>}
        {r.pinned === 'new' && <Badge>First share</Badge>}
        {r.pinned === 'changed' && <Badge tone="danger">Key changed</Badge>}
      </div>
      <div className="mt-2 font-mono text-xs tracking-wide">{r.fingerprint}</div>
      <p className="mt-1 text-xs text-fg-muted">Ask {r.name} to read their fingerprint from Settings → Sharing over a separate channel (call, chat). If it matches, mark it verified.</p>
      <div className="mt-2">
        <Checkbox checked={verified} onChange={onVerified} label="I compared this fingerprint with the recipient" />
      </div>
    </div>
  );
}

export function ShareDialog() {
  const { session } = useApp();
  const snap = useSnapshot();
  const ui = useUi();
  const toast = useToast();
  const confirm = useConfirm();
  const target = ui.shareTarget!;
  const [email, setEmail] = useState('');
  const [lookup, setLookup] = useState<RecipientInfo | null>(null);
  const [verified, setVerified] = useState(false);
  const [role, setRole] = useState<VaultRole>('viewer');
  const [expiry, setExpiry] = useState('');
  const [resharing, setResharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => ui.set({ shareTarget: null });
  const itemIds = target.kind === 'items' ? target.itemIds : snap.items.filter((i) => i.payload.projectId === target.projectId).map((i) => i.id);
  const warnings = session.sharingWarnings(itemIds);
  const project = target.kind === 'project' ? snap.projects.find((p) => p.id === target.projectId) : null;
  const titles = target.kind === 'items' ? itemIds.map((id) => snap.items.find((i) => i.id === id)?.payload.title).filter(Boolean) : [];

  const find = async () => {
    setError(null);
    setLookup(null);
    try {
      const r = await session.lookupRecipient(email);
      if (r.userId === session.userId) throw new Error('That is you.');
      setLookup(r);
      setVerified(r.verified);
    } catch (e) {
      setError((e as { status?: number }).status === 404 ? 'No verified PassVault user with that email.' : errorMessage(e));
    }
  };

  const share = async () => {
    if (!lookup) return;
    if (lookup.pinned === 'changed' && !verified) return setError('This person’s key changed. Verify the new fingerprint before sharing.');
    if (warnings.length) {
      const ok = await confirm({
        title: 'Share sensitive secrets?',
        body: (
          <ul className="list-disc space-y-1 pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
            <li>Recipients can copy anything they can view. Revoking access later cannot erase copies, so rotate the underlying secrets if access is removed.</li>
          </ul>
        ),
        confirmLabel: 'Share',
        typeToConfirm: 'SHARE',
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = { ...lookup, verified };
      if (verified && !lookup.verified) await session.pinContact(r, true);
      await session.share({ target, recipients: [{ recipient: r, role, expiresAt: expiry ? new Date(`${expiry}T23:59:59`).toISOString() : null }], allowResharing: resharing });
      toast(`Invitation sent to ${lookup.email}`, 'success');
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title={target.kind === 'project' ? `Share project “${project?.payload.name}”` : `Share ${titles.length === 1 ? `“${titles[0]}”` : `${titles.length} items`}`}
      description="Items are encrypted to the recipient’s public key. PassVault’s server cannot read them."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!lookup} onClick={share} icon={<UserPlus className="size-4" />}>
            Send invitation
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {target.kind === 'project' && (
          <Banner tone="warn" title="Future items inherit sharing">
            Everything in this project — including items you add later — will be shared with every member. Keep personal secrets out of shared projects.
          </Banner>
        )}
        {warnings.length > 0 && (
          <Banner tone="prod" icon={<AlertTriangle className="size-4" />} title="Sensitive content">
            {warnings.join(' ')}
          </Banner>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void find();
          }}
        >
          <Field label="Recipient email" className="flex-1">
            {(id) => <Input id={id} data-autofocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Button type="submit" disabled={!email}>
            Find
          </Button>
        </form>
        {lookup && <FingerprintBox r={lookup} verified={verified} onVerified={setVerified} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Access">
            {(id) => (
              <Select id={id} value={role} onChange={(e) => setRole(e.target.value as VaultRole)}>
                <option value="viewer">Viewer — can view and copy</option>
                <option value="editor">Editor — can edit and add</option>
                <option value="owner">Owner — can also manage access</option>
              </Select>
            )}
          </Field>
          <Field label="Expires (optional)" hint="Enforced by the server when the recipient is online.">
            {(id, d) => <Input id={id} aria-describedby={d} type="date" value={expiry} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpiry(e.target.value)} />}
          </Field>
        </div>
        <Switch checked={resharing} onChange={setResharing} label="Allow editors to share with others" description="Only applies to a new share. Owners can change this later." />
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Dialog>
  );
}

export function MembersDialog() {
  const { session } = useApp();
  const snap = useSnapshot();
  const ui = useUi();
  const toast = useToast();
  const confirm = useConfirm();
  const vaultId = ui.membersVaultId!;
  const vault = snap.vaults.find((v) => v.vaultId === vaultId);
  const [members, setMembers] = useState<VaultMemberDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rotationNotice, setRotationNotice] = useState(false);
  const isOwner = vault?.role === 'owner';
  const reload = () =>
    session
      .members(vaultId)
      .then(setMembers)
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);
  const close = () => ui.set({ membersVaultId: null });
  const records = [...snap.items, ...snap.projects].filter((r) => r.vaultId === vaultId);
  const firstItem = snap.items.find((i) => i.vaultId === vaultId);

  const revoke = async (m: VaultMemberDto) => {
    const self = m.userId === session.userId;
    const ok = await confirm({
      title: self ? 'Leave this shared vault?' : `Remove ${m.email}?`,
      body: self ? (
        'You will lose access to these items on all your devices.'
      ) : (
        <div className="space-y-2">
          <p>Their access to future changes ends now. PassVault will rotate the encryption key and re-encrypt the shared items so keys they kept cannot read new versions.</p>
          <p className="font-medium text-fg">This cannot erase copies they already made, and they may still decrypt older versions they downloaded. Rotate the actual passwords, tokens, and SSH authorizations at each service.</p>
        </div>
      ),
      confirmLabel: self ? 'Leave' : 'Remove and rotate key',
    });
    if (!ok) return;
    try {
      if (self) {
        await session.leaveVault(vaultId);
        close();
        return;
      }
      const r = await session.revokeMember(vaultId, m.userId);
      setRotationNotice(true);
      toast(r.rotated ? 'Access removed and key rotated' : 'Access removed. Key rotation is pending — open this dialog again online to finish.', r.rotated ? 'success' : 'warn');
      await reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <Dialog open onClose={close} size="lg" title="Manage access" description={`${records.length} record(s) in this shared vault.`}>
      <div className="space-y-4">
        {vault?.rotationRequired && isOwner && (
          <Banner
            tone="warn"
            title="Key rotation pending"
            action={
              <Button size="sm" icon={<RotateCw className="size-3.5" />} onClick={async () => {
                try {
                  await session.rotateVaultKey(vaultId);
                  toast('Key rotated', 'success');
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
              }}>
                Rotate now
              </Button>
            }
          >
            A member was removed or expired. Rotate the vault key so they cannot read future changes.
          </Banner>
        )}
        {rotationNotice && (
          <Banner tone="prod" icon={<AlertTriangle className="size-4" />} title="Rotate the underlying secrets">
            Removing access does not change the secrets themselves. Change the affected passwords, revoke API tokens, and remove SSH public keys from servers the removed member could reach.
          </Banner>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
        {!members && !error && <Spinner />}
        {members && (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {members
              .filter((m) => m.status !== 'declined')
              .map((m) => (
                <li key={m.userId} className="flex flex-wrap items-center gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {m.name} {m.userId === session.userId && <span className="text-fg-subtle">(you)</span>}
                    </div>
                    <div className="text-xs text-fg-subtle">
                      {m.email}
                      {m.expiresAt && ` · expires ${new Date(m.expiresAt).toLocaleDateString()}`}
                    </div>
                  </div>
                  <Badge tone={m.status === 'accepted' ? 'ok' : m.status === 'invited' ? 'accent' : 'neutral'}>{m.status}</Badge>
                  {snap.settings.contacts[m.userId]?.verified && <ShieldCheck className="size-4 text-ok" aria-label="Fingerprint verified" />}
                  {isOwner && m.userId !== session.userId && (m.status === 'accepted' || m.status === 'invited') ? (
                    <Select
                      aria-label={`Role for ${m.email}`}
                      className="!h-7 !w-28 text-xs"
                      value={m.role}
                      onChange={async (e) => {
                        try {
                          await session.updateMember(vaultId, m.userId, { role: e.target.value as VaultRole });
                          await reload();
                        } catch (err) {
                          toast(errorMessage(err), 'error');
                        }
                      }}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="owner">Owner</option>
                    </Select>
                  ) : (
                    <Badge>{m.role}</Badge>
                  )}
                  {(m.status === 'accepted' || m.status === 'invited') && (isOwner || m.userId === session.userId) && (
                    <IconButton size="sm" variant="danger" label={m.userId === session.userId ? 'Leave' : `Remove ${m.email}`} onClick={() => void revoke(m)}>
                      <UserMinus className="size-4" />
                    </IconButton>
                  )}
                </li>
              ))}
          </ul>
        )}
        {isOwner && vault && (
          <Switch
            checked={vault.allowResharing}
            onChange={async (v) => {
              try {
                await session.setResharing(vaultId, v);
                await session.syncNow();
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
            label="Allow editors to share with others"
          />
        )}
        <div className="flex flex-wrap gap-2">
          {(isOwner || vault?.allowResharing) && firstItem && (
            <Button
              icon={<UserPlus className="size-4" />}
              onClick={() => {
                const proj = snap.projects.find((p) => p.vaultId === vaultId);
                ui.set({ membersVaultId: null, shareTarget: proj ? { kind: 'project', projectId: proj.id } : { kind: 'items', itemIds: records.filter((r) => r.kind === 'item').map((r) => r.id) } });
              }}
            >
              Invite someone
            </Button>
          )}
          {isOwner && (
            <Button
              variant="ghost"
              onClick={async () => {
                if (await confirm({ title: 'Stop sharing?', body: 'Items move back into your personal vault and all other members lose access. Copies they made are not erased; rotate secrets if needed.', confirmLabel: 'Stop sharing' })) {
                  try {
                    await session.unshare(vaultId);
                    close();
                    toast('Sharing stopped', 'success');
                  } catch (e) {
                    toast(errorMessage(e), 'error');
                  }
                }
              }}
            >
              Stop sharing
            </Button>
          )}
        </div>
        <p className="text-xs text-fg-subtle">Audit logs record invitations, role changes, and removals. They cannot show when someone revealed, copied, or used a secret offline.</p>
      </div>
    </Dialog>
  );
}
