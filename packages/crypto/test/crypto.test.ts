import { beforeAll, describe, expect, it } from 'vitest';
import {
  initCrypto,
  encryptBytes,
  decryptBytes,
  encryptJson,
  decryptJson,
  randomKey,
  DecryptionError,
  UnsupportedFormatError,
  fromB64,
  toB64,
  createRegistrationMaterial,
  unlockWithPassword,
  unlockWithRecoveryKey,
  WrongPasswordError,
  InvalidRecoveryKeyError,
  rewrapForNewPassword,
  rotateUserKey,
  deriveLogin,
  parseRecoveryKey,
  generateVaultKey,
  wrapVaultKeyForSelf,
  openVaultGrant,
  grantVaultKey,
  GrantVerificationError,
  encryptRecord,
  decryptRecord,
  rewrapRecordKey,
  generatePassword,
  generatePassphrase,
  publicKeyFingerprint,
  openAccountKeys,
  validateKdfParams,
  newKdfParams,
  wrapUserKeyForDevice,
  unwrapUserKeyWithDeviceKey,
  wipe,
} from '../src/index.js';

// Low-cost KDF parameters keep tests fast; production defaults are enforced by validateKdfParams minimums.
const FAST = { opsLimit: 2, memLimitBytes: 32 * 1024 * 1024 };

beforeAll(async () => {
  await initCrypto();
});

function flipByte(envelope: string, index: number): string {
  const raw = fromB64(envelope);
  raw[index] = raw[index]! ^ 0x01;
  return toB64(raw);
}

describe('AEAD envelopes', () => {
  it('round-trips bytes and JSON', () => {
    const key = randomKey();
    const env = encryptBytes(key, new Uint8Array([1, 2, 3]), 'ctx');
    expect(Array.from(decryptBytes(key, env, 'ctx'))).toEqual([1, 2, 3]);
    const j = encryptJson(key, { a: 'secret', n: 1 }, 'json');
    expect(decryptJson(key, j, 'json')).toEqual({ a: 'secret', n: 1 });
  });

  it('uses a fresh nonce for every encryption', () => {
    const key = randomKey();
    const a = encryptBytes(key, new Uint8Array([9]), 'c');
    const b = encryptBytes(key, new Uint8Array([9]), 'c');
    expect(a).not.toEqual(b);
    expect(fromB64(a).subarray(2, 26)).not.toEqual(fromB64(b).subarray(2, 26));
  });

  it('rejects tampered ciphertext, nonce, header, and tag', () => {
    const key = randomKey();
    const env = encryptBytes(key, new Uint8Array(64).fill(7), 'ctx');
    const len = fromB64(env).byteLength;
    for (const idx of [5, 30, len - 1]) {
      expect(() => decryptBytes(key, flipByte(env, idx), 'ctx')).toThrow(DecryptionError);
    }
    expect(() => decryptBytes(key, flipByte(env, 0), 'ctx')).toThrow(UnsupportedFormatError);
    expect(() => decryptBytes(key, env.slice(0, 20), 'ctx')).toThrow(DecryptionError);
  });

  it('rejects the wrong key or wrong context (prevents ciphertext swapping)', () => {
    const key = randomKey();
    const env = encryptBytes(key, new Uint8Array([1]), 'pv:record:v1:item-a');
    expect(() => decryptBytes(randomKey(), env, 'pv:record:v1:item-a')).toThrow(DecryptionError);
    expect(() => decryptBytes(key, env, 'pv:record:v1:item-b')).toThrow(DecryptionError);
  });

  it('pads JSON payloads to hide exact length', () => {
    const key = randomKey();
    const short = fromB64(encryptJson(key, { s: 'a' }, 'c')).byteLength;
    const longer = fromB64(encryptJson(key, { s: 'a'.repeat(60) }, 'c')).byteLength;
    expect(short).toEqual(longer);
  });
});

describe('KDF parameter validation', () => {
  it('enforces minimums', () => {
    const p = newKdfParams();
    expect(() => validateKdfParams(p)).not.toThrow();
    expect(() => validateKdfParams({ ...p, opsLimit: 1 })).toThrow();
    expect(() => validateKdfParams({ ...p, memLimitBytes: 1024 })).toThrow();
    expect(() => validateKdfParams({ ...p, salt: toB64(new Uint8Array(8)) })).toThrow();
  });
});

describe('account keys', () => {
  it('registers, unlocks with password, and rejects wrong password', () => {
    const reg = createRegistrationMaterial('correct horse battery staple', FAST);
    const keys = { ...reg.keys };
    const unlocked = unlockWithPassword('correct horse battery staple', reg.kdf, keys);
    expect(unlocked.userKey).toEqual(reg.unlocked.userKey);
    expect(() => unlockWithPassword('wrong password', reg.kdf, keys)).toThrow(WrongPasswordError);
  });

  it('auth key is deterministic, independent of wrap key, and never equals the password', () => {
    const reg = createRegistrationMaterial('pw-123456789', FAST);
    const a = deriveLogin('pw-123456789', reg.kdf);
    expect(a.authKey).toEqual(reg.authKey);
    expect(toB64(a.wrapKey)).not.toEqual(a.authKey);
    expect(a.authKey).not.toContain('pw-123456789');
  });

  it('master password change re-wraps the same user key; old password stops working on new bundle', () => {
    const reg = createRegistrationMaterial('old-password-1', FAST);
    const change = rewrapForNewPassword(reg.unlocked.userKey, 'new-password-2', FAST);
    const newKeys = { ...reg.keys, encryptedUserKey: change.encryptedUserKey };
    expect(change.kdf.salt).not.toEqual(reg.kdf.salt);
    expect(change.authKey).not.toEqual(reg.authKey);
    const u = unlockWithPassword('new-password-2', change.kdf, newKeys);
    expect(u.userKey).toEqual(reg.unlocked.userKey);
    expect(() => unlockWithPassword('old-password-1', change.kdf, newKeys)).toThrow(WrongPasswordError);
    // An un-synced device still holding the old bundle can still unlock with the old password (documented).
    expect(unlockWithPassword('old-password-1', reg.kdf, reg.keys).userKey).toEqual(reg.unlocked.userKey);
  });

  it('user key rotation produces a new key and keeps the asymmetric identities', () => {
    const reg = createRegistrationMaterial('pw-rotate-0001', FAST);
    const vaultId = 'vault-1';
    const vk = generateVaultKey();
    const rot = rotateUserKey(reg.unlocked, 'pw-rotate-0002', FAST);
    expect(rot.newUserKey).not.toEqual(reg.unlocked.userKey);
    const keys = {
      ...reg.keys,
      encryptedUserKey: rot.encryptedUserKey,
      encryptedPrivateEncryptionKey: rot.encryptedPrivateEncryptionKey,
      encryptedPrivateSigningKey: rot.encryptedPrivateSigningKey,
    };
    const u = unlockWithPassword('pw-rotate-0002', rot.kdf, keys);
    expect(u.encryptionKeyPair.publicKey).toEqual(reg.unlocked.encryptionKeyPair.publicKey);
    // Personal vault key must be re-wrapped under the new UK.
    const rewrapped = wrapVaultKeyForSelf(u.userKey, vk, vaultId, 1);
    expect(openVaultGrant({ encryptedVaultKey: rewrapped, vaultId, keyVersion: 1, myUserId: 'u', me: u })).toEqual(vk);
    const oldWrap = wrapVaultKeyForSelf(reg.unlocked.userKey, vk, vaultId, 1);
    expect(() => openVaultGrant({ encryptedVaultKey: oldWrap, vaultId, keyVersion: 1, myUserId: 'u', me: u })).toThrow(DecryptionError);
  });

  it('recovery key unlocks, detects typos, and rejects other accounts', () => {
    const reg = createRegistrationMaterial('pw-recovery-01', FAST);
    const u = unlockWithRecoveryKey(reg.recoveryKey, reg.keys.encryptedUserKeyByRecovery, reg.keys);
    expect(u.userKey).toEqual(reg.unlocked.userKey);
    const typo = reg.recoveryKey.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    expect(() => parseRecoveryKey(typo)).toThrow(InvalidRecoveryKeyError);
    const other = createRegistrationMaterial('pw-recovery-02', FAST);
    expect(() => unlockWithRecoveryKey(other.recoveryKey, reg.keys.encryptedUserKeyByRecovery, reg.keys)).toThrow(InvalidRecoveryKeyError);
  });

  it('detects substituted public keys', () => {
    const a = createRegistrationMaterial('pw-a-000000', FAST);
    const b = createRegistrationMaterial('pw-b-000000', FAST);
    expect(() => openAccountKeys(a.unlocked.userKey, { ...a.keys, publicEncryptionKey: b.keys.publicEncryptionKey })).toThrow();
  });

  it('device unlock key wraps the user key bound to a device id', () => {
    const reg = createRegistrationMaterial('pw-device-0001', FAST);
    const d = wrapUserKeyForDevice(reg.unlocked.userKey, 'device-1');
    expect(unwrapUserKeyWithDeviceKey(d.deviceKey, 'device-1', d.encryptedUserKeyByDevice)).toEqual(reg.unlocked.userKey);
    expect(() => unwrapUserKeyWithDeviceKey(d.deviceKey, 'device-2', d.encryptedUserKeyByDevice)).toThrow(DecryptionError);
  });

  it('wipe zeroes key buffers', () => {
    const k = randomKey();
    wipe(k);
    expect(k.every((b) => b === 0)).toBe(true);
  });
});

describe('vault grants and sharing', () => {
  const alice = () => createRegistrationMaterial('alice-password-1', FAST);
  const bob = () => createRegistrationMaterial('bob-password-123', FAST);

  it('grants a vault key to a recipient who verifies the signature', () => {
    const a = alice();
    const b = bob();
    const vk = generateVaultKey();
    const grant = grantVaultKey({
      vaultKey: vk,
      vaultId: 'v1',
      keyVersion: 1,
      recipientUserId: 'bob',
      recipientPublicEncryptionKey: b.keys.publicEncryptionKey,
      grantor: a.unlocked,
    });
    const opened = openVaultGrant({
      ...grant,
      vaultId: 'v1',
      keyVersion: 1,
      myUserId: 'bob',
      me: b.unlocked,
      grantorPublicSigningKey: a.keys.publicSigningKey,
    });
    expect(opened).toEqual(vk);
  });

  it('rejects grants replayed to another vault, user, key version, or with a forged signer', () => {
    const a = alice();
    const b = bob();
    const mallory = createRegistrationMaterial('mallory-pass-01', FAST);
    const grant = grantVaultKey({
      vaultKey: generateVaultKey(),
      vaultId: 'v1',
      keyVersion: 1,
      recipientUserId: 'bob',
      recipientPublicEncryptionKey: b.keys.publicEncryptionKey,
      grantor: a.unlocked,
    });
    const base = { ...grant, myUserId: 'bob', me: b.unlocked, grantorPublicSigningKey: a.keys.publicSigningKey };
    expect(() => openVaultGrant({ ...base, vaultId: 'v2', keyVersion: 1 })).toThrow(GrantVerificationError);
    expect(() => openVaultGrant({ ...base, vaultId: 'v1', keyVersion: 2 })).toThrow(GrantVerificationError);
    expect(() => openVaultGrant({ ...base, vaultId: 'v1', keyVersion: 1, myUserId: 'carol' })).toThrow(GrantVerificationError);
    expect(() =>
      openVaultGrant({ ...base, vaultId: 'v1', keyVersion: 1, grantorPublicSigningKey: mallory.keys.publicSigningKey }),
    ).toThrow(GrantVerificationError);
    expect(() => openVaultGrant({ ...base, vaultId: 'v1', keyVersion: 1, keySignature: null })).toThrow(GrantVerificationError);
  });

  it('fingerprints are stable and distinct', () => {
    const a = alice();
    const b = bob();
    const fa = publicKeyFingerprint(a.keys.publicSigningKey, a.keys.publicEncryptionKey);
    expect(fa).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    expect(fa).toEqual(publicKeyFingerprint(a.keys.publicSigningKey, a.keys.publicEncryptionKey));
    expect(fa).not.toEqual(publicKeyFingerprint(b.keys.publicSigningKey, b.keys.publicEncryptionKey));
  });
});

describe('records', () => {
  it('round-trips and binds payload to record id and key to vault', () => {
    const vk = generateVaultKey();
    const enc = encryptRecord({ recordId: 'r1', vaultId: 'v1', vaultKey: vk, payload: { title: 'GitHub', password: 'hunter2' } });
    expect(enc.encryptedPayload).not.toContain('hunter2');
    const dec = decryptRecord<{ title: string }>({ recordId: 'r1', vaultId: 'v1', vaultKey: vk, ...enc });
    expect(dec.payload.title).toBe('GitHub');
    expect(() => decryptRecord({ recordId: 'r2', vaultId: 'v1', vaultKey: vk, ...enc })).toThrow(DecryptionError);
    expect(() => decryptRecord({ recordId: 'r1', vaultId: 'v9', vaultKey: vk, ...enc })).toThrow(DecryptionError);
  });

  it('moving a record re-wraps only the item key', () => {
    const v1 = generateVaultKey();
    const v2 = generateVaultKey();
    const enc = encryptRecord({ recordId: 'r1', vaultId: 'v1', vaultKey: v1, payload: { x: 1 } });
    const moved = rewrapRecordKey(enc.itemKey, 'v2', v2, 'r1');
    const dec = decryptRecord({ recordId: 'r1', vaultId: 'v2', vaultKey: v2, encryptedKey: moved, encryptedPayload: enc.encryptedPayload });
    expect(dec.payload).toEqual({ x: 1 });
  });
});

describe('generators', () => {
  it('generates passwords with every enabled class and requested length', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword({ length: 12 });
      expect(p).toHaveLength(12);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^a-zA-Z0-9]/);
    }
    expect(generatePassword({ length: 30, symbols: false, avoidAmbiguous: true })).not.toMatch(/[Il1O0!@#]/);
    expect(() => generatePassword({ length: 4 })).toThrow();
  });

  it('generates passphrases from the EFF list', () => {
    const p = generatePassphrase({ words: 5, separator: ' ' });
    expect(p.split(' ')).toHaveLength(5);
  });
});
