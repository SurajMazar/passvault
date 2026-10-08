import { beforeAll, describe, expect, it } from 'vitest';
import { initCrypto, createRegistrationMaterial, wrapVaultKeyForSelf, generateVaultKey } from '@passvault/crypto';
import { MemoryStore } from '@passvault/sync';
import type { AccountBundle } from '@passvault/types';
import { VaultSession, newItem, computeInsights, filterItems, searchableText, type Platform } from '../src/index';

const FAST = { opsLimit: 2, memLimitBytes: 32 * 1024 * 1024 };

function memPrefs() {
  const m = new Map<string, string>();
  return { get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => void m.set(k, v), remove: async (k: string) => void m.delete(k) };
}

/**
 * Build a device that has an encrypted cached account but no server session —
 * exercises offline unlock, local edits, and locking without a backend.
 */
async function offlineDevice() {
  await initCrypto();
  const reg = createRegistrationMaterial('correct horse battery', FAST);
  const personalVaultId = crypto.randomUUID();
  const vk = generateVaultKey();
  const account: AccountBundle = {
    user: { id: crypto.randomUUID(), email: 'demo@example.com', name: 'Demo', emailVerified: true, mfaEnabled: true, createdAt: new Date().toISOString() },
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
  const store = new MemoryStore();
  await store.putAccount({ account, cachedAt: new Date().toISOString() });
  await store.putVaults([
    {
      vaultId: personalVaultId,
      type: 'personal',
      kind: null,
      role: 'owner',
      status: 'accepted',
      keyVersion: 1,
      encryptedVaultKey: wrapVaultKeyForSelf(reg.unlocked.userKey, vk, personalVaultId, 1),
      keySignature: null,
      grantedBy: null,
      allowResharing: false,
      expiresAt: null,
      rotationRequired: false,
      memberCount: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]);
  const prefs = memPrefs();
  await prefs.set('lastEmail', 'demo@example.com');
  const lockCalls: string[] = [];
  const platform: Platform = {
    clientType: 'web',
    deviceName: 'test',
    apiBaseUrl: 'http://127.0.0.1:9', // unreachable: proves offline operation
    webAppUrl: 'http://localhost',
    tokens: { get: async () => null, set: async () => undefined, clear: async () => undefined },
    prefs,
    createCacheStore: () => store,
    clipboard: { copySecret: async () => undefined, copyText: async () => undefined },
    files: { pickTextFile: async () => null, saveTextFile: async () => ({ saved: false }) },
    openExternal: async () => undefined,
  };
  const session = new VaultSession(platform);
  session.onLock(() => lockCalls.push('locked'));
  await session.init();
  return { session, store, lockCalls };
}

beforeAll(async () => {
  await initCrypto();
});

describe('VaultSession offline unlock and locking', () => {
  it('starts locked with a cached account and rejects a wrong password', async () => {
    const { session } = await offlineDevice();
    expect(session.getSnapshot().auth.phase).toBe('locked');
    await expect(session.unlock('wrong password!!')).rejects.toThrow(/incorrect/);
    expect(session.isUnlocked).toBe(false);
  });

  it('unlocks offline, encrypts edits into the outbox, and wipes plaintext state on lock', async () => {
    const { session, store, lockCalls } = await offlineDevice();
    await session.unlock('correct horse battery');
    expect(session.getSnapshot().auth.phase).toBe('unlocked');
    await session.saveItem(
      newItem('login', { title: 'Bank', fields: { username: 'me', password: 'S3cret-Value-XYZ', urls: [{ url: 'https://bank.example.com', match: 'host' }] } }),
    );
    const snap = session.getSnapshot();
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0]!.pending).toBe(true);

    // The persisted cache contains only ciphertext.
    const persisted = JSON.stringify({ outbox: await store.outbox(), records: await store.allRecords(), acc: await store.getAccount() });
    expect(persisted).not.toContain('S3cret-Value-XYZ');
    expect(persisted).not.toContain('bank.example.com');
    expect(persisted).not.toContain('Bank');

    // Capture internal key buffers to confirm they are zeroed.
    const internals = session as unknown as { keys: { userKey: Uint8Array }; vaultKeys: Map<string, { key: Uint8Array }>; itemKeys: Map<string, Uint8Array> };
    const userKey = internals.keys.userKey;
    const vaultKey = [...internals.vaultKeys.values()][0]!.key;
    const itemKey = [...internals.itemKeys.values()][0]!;

    session.lock();
    const locked = session.getSnapshot();
    expect(locked.auth.phase).toBe('locked');
    expect(locked.items).toEqual([]);
    expect(locked.projects).toEqual([]);
    expect(JSON.stringify(locked)).not.toContain('S3cret-Value-XYZ');
    expect(userKey.every((b) => b === 0)).toBe(true);
    expect(vaultKey.every((b) => b === 0)).toBe(true);
    expect(itemKey.every((b) => b === 0)).toBe(true);
    expect(internals.keys).toBeNull();
    expect(internals.itemKeys.size).toBe(0);
    expect(lockCalls).toEqual(['locked']);
    await expect(session.saveItem(newItem('secure_note', { title: 'x' }))).rejects.toThrow(/locked/i);

    // Unlocking again restores the pending edit from the encrypted outbox.
    await session.unlock('correct horse battery');
    expect(session.getSnapshot().items[0]!.payload.title).toBe('Bank');
  });

  it('inactivity timeout locks automatically', async () => {
    const { session } = await offlineDevice();
    await session.unlock('correct horse battery');
    const s = session as unknown as { settings: { lockTimeoutMinutes: number } };
    s.settings.lockTimeoutMinutes = 0.001; // 60ms
    session.touch();
    await new Promise((r) => setTimeout(r, 150));
    expect(session.getSnapshot().auth.phase).toBe('locked');
  });

  it('validates payloads: SSH/database/API items need no URL; bad hosts rejected', async () => {
    const { session } = await offlineDevice();
    await session.unlock('correct horse battery');
    await session.saveItem(newItem('ssh_connection', { title: 'Web', fields: { host: 'web.example.com', port: 22, username: 'deploy', authMethod: 'key', hostKeys: [] } }));
    await session.saveItem(newItem('api_credential', { title: 'API', fields: { service: 'X', kind: 'token', token: 't' } }));
    await expect(
      session.saveItem(newItem('ssh_connection', { title: 'Bad', fields: { host: '-oProxyCommand=sh', port: 22, username: 'x', authMethod: 'key', hostKeys: [] } })),
    ).rejects.toThrow();
    expect(session.getSnapshot().items).toHaveLength(2);
  });

  it('trash, restore, and duplicate are encrypted updates', async () => {
    const { session } = await offlineDevice();
    await session.unlock('correct horse battery');
    const id = await session.saveItem(newItem('secure_note', { title: 'Note', fields: { content: 'hello' } }));
    await session.moveToTrash(id);
    expect(session.getSnapshot().items[0]!.payload.trashedAt).not.toBeNull();
    await session.restoreFromTrash(id);
    expect(session.getSnapshot().items[0]!.payload.trashedAt).toBeNull();
    await session.duplicateItem(id);
    expect(session.getSnapshot().items.map((i) => i.payload.title).sort()).toEqual(['Note', 'Note (copy)']);
  });
});

describe('search and insights', () => {
  const login = (id: string, title: string, password: string) => ({
    id,
    vaultId: 'v',
    updatedAt: '2026-01-01',
    shared: false,
    sharedByMe: false,
    favorite: false,
    payload: newItem('login', { title, fields: { username: 'u', password, urls: [{ url: 'https://a.example.com', match: 'host' }] } }),
  });

  it('never indexes secret values', () => {
    const it = login('1', 'GitHub', 'TopSecretValue');
    expect(searchableText(it.payload)).toContain('github');
    expect(searchableText(it.payload)).not.toContain('topsecretvalue');
    const env = newItem('env_file', { title: 'env', fields: { filename: '.env', content: 'API_TOKEN=supersecret\n', variableNotes: {} } });
    expect(searchableText(env)).toContain('api_token');
    expect(searchableText(env)).not.toContain('supersecret');
    expect(filterItems([it], { query: 'TopSecret' })).toHaveLength(0);
    expect(filterItems([it], { query: 'git' })).toHaveLength(1);
  });

  it('flags weak and reused passwords locally', () => {
    const r = computeInsights([login('1', 'A', 'password123'), login('2', 'B', 'password123'), login('3', 'C', 'kX9#vP2!qL7@wR4$')]);
    expect(r.weak.map((w) => w.id).sort()).toEqual(['1', '2']);
    expect(r.reused).toEqual([{ ids: ['1', '2'] }]);
  });
});
