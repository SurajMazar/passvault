import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import type { InvitationDto } from '@passvault/types';
import { Badge, Button, Checkbox, useToast } from '@passvault/ui';
import { useApp, useSnapshot, errorMessage } from '../state';

type Inv = InvitationDto & { fingerprint: string };

export function Invitations({ compact }: { compact?: boolean }) {
  const { session } = useApp();
  const snap = useSnapshot();
  const toast = useToast();
  const [list, setList] = useState<Inv[]>([]);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const reload = () =>
    session
      .invitations()
      .then(setList)
      .catch(() => undefined);
  useEffect(() => {
    if (snap.online) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.sync.pendingInvitations, snap.online]);
  if (!list.length) return compact ? <p className="text-sm text-fg-muted">No pending invitations.</p> : null;
  return (
    <div className="space-y-2">
      {list.map((inv) => {
        const pinned = snap.settings.contacts[inv.invitedBy.userId];
        const changed = pinned && pinned.publicSigningKey !== inv.invitedBy.publicSigningKey;
        return (
          <div key={inv.vaultId} className="rounded-lg border border-accent/40 bg-accent-soft p-3 text-sm">
            <div className="flex items-center gap-2">
              <Mail className="size-4 text-accent" />
              <span className="flex-1">
                <strong>{inv.invitedBy.name}</strong> ({inv.invitedBy.email}) shared {inv.kind === 'project' ? 'a project' : `${inv.itemCount} item(s)`} as <Badge>{inv.role}</Badge>
              </span>
            </div>
            <div className="mt-2 font-mono text-xs">{inv.fingerprint}</div>
            {changed && <p className="mt-1 text-xs text-danger">This person’s key changed since you last verified it.</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Checkbox checked={!!verified[inv.vaultId]} onChange={(v) => setVerified({ ...verified, [inv.vaultId]: v })} label="Fingerprint verified with sender" />
              <div className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    try {
                      await session.declineInvitation(inv.vaultId);
                      await reload();
                    } catch (e) {
                      toast(errorMessage(e), 'error');
                    }
                  }}
                >
                  Decline
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!!changed && !verified[inv.vaultId]}
                  onClick={async () => {
                    try {
                      await session.acceptInvitation(inv, !!verified[inv.vaultId]);
                      toast('Invitation accepted', 'success');
                      await reload();
                    } catch (e) {
                      toast(errorMessage(e), 'error');
                    }
                  }}
                >
                  Accept
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
