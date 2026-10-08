import type { ItemPayload } from '@passvault/types';
import type { DecryptedItem } from '@passvault/vault-core';
import type { HostKeyEvent } from '../ipc/types';
import { hostPortOf, isSshConnection, toTrustedHostKey, type SessionTrust } from './hops';

export interface TrustSessionLike {
  getSnapshot(): { items: DecryptedItem[] };
  updateItem(id: string, mutate: (p: ItemPayload) => ItemPayload | void): Promise<void>;
}

export type TrustResult = { saved: true } | { saved: false; reason: string };

/**
 * Persists a key the user explicitly trusted (`status: 'unknown'` only) into
 * the ssh_connection item's `fields.hostKeys`. A `mismatch` is never
 * persisted: changed keys must be removed deliberately in the item first.
 * Viewers of shared items (and failed saves) get session-only trust.
 */
export async function persistTrustedHostKey(
  session: TrustSessionLike,
  itemId: string,
  ev: Pick<HostKeyEvent, 'keyType' | 'publicKey' | 'fingerprint' | 'hostPort' | 'status'>,
  sessionTrust: SessionTrust,
  now = new Date(),
): Promise<TrustResult> {
  if (ev.status !== 'unknown') throw new Error('A changed host key is never trusted automatically');
  const item = session.getSnapshot().items.find((i) => i.id === itemId);
  if (!isSshConnection(item)) throw new Error('Server item not found');
  if (hostPortOf(item) !== ev.hostPort) throw new Error(`The key was presented by ${ev.hostPort}, not by ${hostPortOf(item)}`);
  const record = toTrustedHostKey(ev, now);
  const addSessionTrust = () => {
    const list = sessionTrust.get(itemId) ?? [];
    if (!list.some((k) => k.publicKey === record.publicKey && k.keyType === record.keyType && k.hostPort === record.hostPort)) list.push(record);
    sessionTrust.set(itemId, list);
  };
  if (item.role === 'viewer') {
    addSessionTrust();
    return { saved: false, reason: 'You have view-only access to this server, so the key is trusted for this session only and was not saved.' };
  }
  if (item.payload.fields.hostKeys.some((k) => k.publicKey === record.publicKey && k.keyType === record.keyType && k.hostPort === record.hostPort)) {
    return { saved: true };
  }
  try {
    await session.updateItem(itemId, (p) => {
      if (p.type !== 'ssh_connection') return;
      const keys = p.fields.hostKeys ?? [];
      if (!keys.some((k) => k.publicKey === record.publicKey && k.keyType === record.keyType && k.hostPort === record.hostPort)) keys.push(record);
      p.fields.hostKeys = keys;
    });
    return { saved: true };
  } catch (e) {
    addSessionTrust();
    return { saved: false, reason: `The key is trusted for this session but could not be saved: ${e instanceof Error ? e.message : String(e)}` };
  }
}
