/**
 * DEV ONLY (tree-shaken from production builds; requires `vite build --mode
 * development` and `?preview` in the URL, i.e. the verification harness in
 * cloud mode — the real window never has a query string).
 *
 * Creates an offline, locally encrypted demo account in Neutralino storage so
 * the desktop features can be exercised without the API, and exposes the
 * session/controller on `window.__pvDev` for scripted verification.
 * Master password of the preview account: "preview-password-123".
 */
import { createRegistrationMaterial, generateVaultKey, initCrypto, wrapVaultKeyForSelf } from '@passvault/crypto';
import type { AccountBundle } from '@passvault/types';
import type { Platform } from '@passvault/vault-core';

export const PREVIEW_EMAIL = 'preview@example.com';
export const PREVIEW_PASSWORD = 'preview-password-123';

export async function setupPreviewAccount(platform: Platform): Promise<void> {
  await initCrypto();
  const store = platform.createCacheStore(PREVIEW_EMAIL);
  if (!(await store.getAccount())) {
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
  }
  await platform.prefs.set('lastEmail', PREVIEW_EMAIL);
}
