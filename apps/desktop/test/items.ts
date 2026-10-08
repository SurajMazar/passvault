import type { ItemPayload, TrustedHostKey } from '@passvault/types';
import type { DecryptedItem } from '@passvault/vault-core';

let n = 0;
function item(payload: ItemPayload, extra: Partial<DecryptedItem> = {}): DecryptedItem {
  n++;
  return {
    id: extra.id ?? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    vaultId: 'v1',
    revision: 1,
    createdAt: '',
    updatedAt: '',
    createdBy: 'u',
    updatedBy: 'u',
    pending: false,
    conflict: null,
    failed: null,
    shared: false,
    sharedByMe: false,
    role: 'owner',
    kind: 'item',
    favorite: false,
    payload,
    ...extra,
  } as DecryptedItem;
}

const common = { v: 1 as const, description: '', notes: '', folder: '', tags: [], projectId: null, favorite: false, archived: false, trashedAt: null, customFields: [] };

export function server(fields: Partial<ItemPayload<'ssh_connection'>['fields']> & { host: string }, extra: Partial<DecryptedItem> & { environment?: string } = {}) {
  const { environment, ...rest } = extra;
  return item(
    {
      ...common,
      type: 'ssh_connection',
      title: `srv ${fields.host}`,
      environment: environment ?? null,
      fields: { port: 22, username: 'deploy', authMethod: 'password', password: 'S3cret-pw', hostKeys: [] as TrustedHostKey[], ...fields },
    } as ItemPayload,
    rest,
  );
}

export function sshKey(extra: Partial<DecryptedItem> = {}, passphrase = 'pass-phrase') {
  return item(
    {
      ...common,
      type: 'ssh_key',
      title: 'deploy key',
      fields: { publicKey: 'ssh-ed25519 AAAA test', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE\n-----END OPENSSH PRIVATE KEY-----', passphrase, fingerprint: 'SHA256:key', algorithm: 'ed25519' },
    } as ItemPayload,
    extra,
  );
}

export const ED_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIFKKSbdlJQr+G47ZQBjpPBpehmBTyJFu0aTQwWHPxjTA';
export function trusted(hostPort: string, publicKey = ED_KEY): TrustedHostKey {
  return { keyType: 'ssh-ed25519', publicKey, fingerprint: `SHA256:${publicKey.slice(-8)}`, trustedAt: '2026-01-01T00:00:00.000Z', hostPort };
}
