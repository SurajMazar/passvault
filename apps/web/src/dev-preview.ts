/**
 * DEV ONLY (tree-shaken from production builds): `?preview` creates an
 * offline, locally-encrypted demo account so the dashboard UI can be explored
 * without a backend. Nothing is sent to a server; edits stay queued locally.
 * Master password for the preview account: "preview-password-123".
 */
import { createRegistrationMaterial, generateVaultKey, initCrypto, wrapVaultKeyForSelf } from '@passvault/crypto';
import { IndexedDbStore } from '@passvault/sync';
import type { AccountBundle } from '@passvault/types';

export const PREVIEW_EMAIL = 'preview@example.com';
export const PREVIEW_PASSWORD = 'preview-password-123';

export async function setupPreviewAccount(): Promise<void> {
  await initCrypto();
  const store = new IndexedDbStore(`passvault-${PREVIEW_EMAIL.replace(/[^a-z0-9]/g, '_')}`);
  if (await store.getAccount()) {
    localStorage.setItem('pv-lastEmail', PREVIEW_EMAIL);
    return;
  }
  const reg = createRegistrationMaterial(PREVIEW_PASSWORD, { opsLimit: 2, memLimitBytes: 32 * 1024 * 1024 });
  const personalVaultId = crypto.randomUUID();
  const now = new Date().toISOString();
  const account: AccountBundle = {
    user: { id: crypto.randomUUID(), email: PREVIEW_EMAIL, name: 'Preview User', emailVerified: true, mfaEnabled: true, createdAt: now },
    kdf: reg.kdf,
    keys: {
      encryptedUserKey: reg.keys.encryptedUserKey,
      publicEncryptionKey: reg.keys.publicEncryptionKey,
      encryptedPrivateEncryptionKey: reg.keys.encryptedPrivateEncryptionKey,
      publicSigningKey: reg.keys.publicSigningKey,
      encryptedPrivateSigningKey: reg.keys.encryptedPrivateSigningKey,
      publicKeySignature: reg.keys.publicKeySignature,
    },
    personalVaultId,
    settings: { encryptedSettings: null, revision: 0 },
  };
  await store.putAccount({ account, cachedAt: now });
  await store.putVaults([
    {
      vaultId: personalVaultId,
      type: 'personal',
      kind: null,
      role: 'owner',
      status: 'accepted',
      keyVersion: 1,
      encryptedVaultKey: wrapVaultKeyForSelf(reg.unlocked.userKey, generateVaultKey(), personalVaultId, 1),
      keySignature: null,
      grantedBy: null,
      allowResharing: false,
      expiresAt: null,
      rotationRequired: false,
      memberCount: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  localStorage.setItem('pv-lastEmail', PREVIEW_EMAIL);
}
