import { randomUUID } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { argon2id } from 'hash-wasm';
import {
  ALG_X25519_SEALED,
  CTX,
  DecryptionError,
  GrantVerificationError,
  InvalidRecoveryKeyError,
  KDF_CONTEXT,
  UnsupportedFormatError,
  WrongPasswordError,
  createRegistrationMaterial,
  decryptBytes,
  decryptJson,
  decryptRecord,
  deriveMasterKey,
  derivePasswordKeys,
  encryptBytes,
  encryptJson,
  encryptRecord,
  fromB64,
  generatePassword,
  generateVaultKey,
  grantVaultKey,
  hash256,
  initCrypto,
  newKdfParams,
  openSealed,
  openVaultGrant,
  randomKey,
  rewrapForNewPassword,
  sealTo,
  sodium,
  toB64,
  unlockWithPassword,
  unlockWithRecoveryKey,
  unwrapUserKeyWithDeviceKey,
  utf8,
  validateKdfParams,
  verifyPublicKeySignature,
  wrapUserKeyForDevice,
  wrapVaultKeyForSelf,
  type KdfParams,
} from '@passvault/crypto';
import { gitGrep } from '../lib/util';
import { assert } from '../lib/results';
import type { Suite } from '../lib/suite';

const FAST = { opsLimit: 2, memLimitBytes: 32 * 1024 * 1024 };
const throwsAs = (fn: () => unknown, ...types: Array<new (...a: never[]) => Error>): string => {
  try {
    fn();
  } catch (e) {
    if (types.some((T) => e instanceof T)) return (e as Error).name;
    throw new Error(`threw ${(e as Error)?.name}: ${(e as Error)?.message} (expected ${types.map((t) => t.name).join('|')})`);
  }
  throw new Error(`did not throw (expected ${types.map((t) => t.name).join('|')})`);
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const suite: Suite = {
  id: 'crypto',
  title: 'Encryption and key lifecycle (real implementations, cross-checked against independent libraries)',
  needsApi: false,
  async run({ t }) {
    await initCrypto();
    const s = sodium();

    // ---------------------------------------------------------- independent implementations
    await t.check('crypto.xchacha.cross-impl', 'Envelope AEAD equals XChaCha20-Poly1305-IETF from an independent implementation (@noble/ciphers), both directions', () => {
      for (const len of [0, 1, 63, 64, 1000, 65_537]) {
        const key = randomKey();
        const pt = s.randombytes_buf(len);
        const ctx = `pv:test:${randomUUID()}`;
        const env = fromB64(encryptBytes(key, pt, ctx));
        const aad = new Uint8Array([...env.subarray(0, 2), ...utf8(ctx)]);
        const noblePt = xchacha20poly1305(key, env.subarray(2, 26), aad).decrypt(env.subarray(26));
        assert(hex(noblePt) === hex(pt), `noble could not decrypt our envelope (len ${len})`);
        const nonce = s.randombytes_buf(24);
        const ct = xchacha20poly1305(key, nonce, aad).encrypt(pt);
        const ours = decryptBytes(key, toB64(new Uint8Array([...env.subarray(0, 2), ...nonce, ...ct])), ctx);
        assert(hex(ours) === hex(pt), `we could not decrypt noble's ciphertext (len ${len})`);
      }
      return { ok: true, evidence: 'lengths 0,1,63,64,1000,65537: both directions round-trip with header||context as AAD' };
    }, { severity: 'critical' });

    await t.check('crypto.argon2id.cross-impl', 'Master-key derivation equals Argon2id (v1.3, p=1) from an independent implementation (hash-wasm)', async () => {
      const cases: Array<[string, Partial<KdfParams>]> = [
        ['correct horse battery staple', FAST],
        ['pässwörd-ñ-✓', { opsLimit: 3, memLimitBytes: 64 * 1024 * 1024 }],
      ];
      for (const [pw, o] of cases) {
        const params = newKdfParams(o);
        const ours = deriveMasterKey(pw, params);
        const ref = await argon2id({
          password: pw.normalize('NFC'),
          salt: fromB64(params.salt),
          parallelism: 1,
          iterations: params.opsLimit,
          memorySize: params.memLimitBytes / 1024,
          hashLength: 32,
          outputType: 'binary',
        });
        assert(hex(ours) === hex(ref), `mismatch for ops=${params.opsLimit} mem=${params.memLimitBytes}`);
      }
      return { ok: true, evidence: 'ops=2/mem=32MiB and ops=3/mem=64MiB (default) match hash-wasm argon2id byte for byte' };
    }, { severity: 'critical' });

    await t.check('crypto.subkeys.cross-impl', 'authKey/wrapKey derivation equals BLAKE2b keyed KDF (crypto_kdf) computed independently with @noble/hashes', () => {
      const master = s.randombytes_buf(32);
      for (const [ctx, id] of [[KDF_CONTEXT.auth, 1], [KDF_CONTEXT.wrap, 1], [KDF_CONTEXT.recoveryAuth, 1], [KDF_CONTEXT.recoveryWrap, 1]] as const) {
        const ours = s.crypto_kdf_derive_from_key(32, id, ctx, master);
        const salt = new Uint8Array(16);
        new DataView(salt.buffer).setBigUint64(0, BigInt(id), true);
        const personalization = new Uint8Array(16);
        personalization.set(utf8(ctx));
        const ref = blake2b(new Uint8Array(0), { key: master, dkLen: 32, salt, personalization });
        assert(hex(ours) === hex(ref), `crypto_kdf mismatch for context ${ctx}`);
      }
      return { ok: true, evidence: 'contexts PVauthky, PVwrapky, PVrcauth, PVrcwrap match' };
    }, { severity: 'high' });

    await t.check('crypto.ed25519-x25519-blake2b.cross-impl', 'Signatures, key agreement and fingerprints interoperate with @noble/curves and @noble/hashes', () => {
      const kp = s.crypto_sign_keypair();
      const msg = utf8('pv:vault-grant:v1\nexample');
      const sig = s.crypto_sign_detached(msg, kp.privateKey);
      assert(ed25519.verify(sig, msg, kp.publicKey), 'noble rejected a libsodium Ed25519 signature');
      const nsk = ed25519.utils.randomSecretKey();
      const nsig = ed25519.sign(msg, nsk);
      assert(s.crypto_sign_verify_detached(nsig, msg, ed25519.getPublicKey(nsk)), 'libsodium rejected a noble Ed25519 signature');
      const a = s.crypto_box_keypair();
      const bsk = x25519.utils.randomSecretKey();
      const shared1 = s.crypto_scalarmult(a.privateKey, x25519.getPublicKey(bsk));
      const shared2 = x25519.getSharedSecret(bsk, a.publicKey);
      assert(hex(shared1) === hex(shared2), 'X25519 shared secrets differ');
      const data = s.randombytes_buf(500);
      assert(hex(hash256(data)) === hex(blake2b(data, { dkLen: 32 })), 'BLAKE2b-256 differs');
      return { ok: true, evidence: 'Ed25519 both directions, X25519 shared secret, BLAKE2b-256 equal' };
    }, { severity: 'high' });
    // Sealed boxes (X25519 + XSalsa20-Poly1305) are libsodium's crypto_box_seal; their X25519 part is
    // cross-checked above, the HSalsa20 step is not (no independent HSalsa20 export available).

    // ---------------------------------------------------------- tampering and format strictness
    await t.check('crypto.tamper.aead', 'Any modified byte of an envelope (header, nonce, ciphertext, tag) is rejected', () => {
      const key = randomKey();
      const env = fromB64(encryptBytes(key, utf8('top secret value'), 'ctx'));
      let rejected = 0;
      for (let i = 0; i < env.length; i++) {
        for (const bit of [0x01, 0x80]) {
          const m = env.slice();
          m[i]! ^= bit;
          throwsAs(() => decryptBytes(key, toB64(m), 'ctx'), DecryptionError, UnsupportedFormatError);
          rejected++;
        }
      }
      throwsAs(() => decryptBytes(key, toB64(env.subarray(0, env.length - 1)), 'ctx'), DecryptionError);
      throwsAs(() => decryptBytes(key, '', 'ctx'), DecryptionError);
      throwsAs(() => decryptBytes(key, '!!!not-base64!!!', 'ctx'), DecryptionError);
      throwsAs(() => decryptBytes(randomKey(), toB64(env), 'ctx'), DecryptionError);
      return { ok: true, evidence: `${rejected} single-bit modifications rejected; truncated/empty/garbage/wrong-key rejected` };
    }, { severity: 'critical' });

    await t.check('crypto.format.no-fallback', 'Unknown envelope versions/algorithms are refused (no silent fallback to another format)', () => {
      const key = randomKey();
      const env = fromB64(encryptBytes(key, utf8('x'), 'ctx'));
      const v2 = env.slice();
      v2[0] = 0x02;
      const alg = env.slice();
      alg[1] = ALG_X25519_SEALED;
      const alg9 = env.slice();
      alg9[1] = 0x09;
      const a = throwsAs(() => decryptBytes(key, toB64(v2), 'ctx'), UnsupportedFormatError);
      const b = throwsAs(() => decryptBytes(key, toB64(alg), 'ctx'), UnsupportedFormatError);
      const c = throwsAs(() => decryptBytes(key, toB64(alg9), 'ctx'), UnsupportedFormatError);
      const kp = s.crypto_box_keypair();
      const sealed = fromB64(sealTo(kp.publicKey, utf8('x')));
      sealed[1] = 0x01;
      const d = throwsAs(() => openSealed(kp.publicKey, kp.privateKey, toB64(sealed)), UnsupportedFormatError);
      return { ok: true, evidence: `version 2 → ${a}; AEAD envelope tagged as sealed → ${b}; algorithm 9 → ${c}; sealed box tagged as AEAD → ${d}` };
    }, { severity: 'high' });

    await t.check('crypto.binding.records', 'Record ciphertexts are bound to their record and vault (no swapping payloads or keys between records/vaults)', () => {
      const vaultA = randomUUID();
      const vaultB = randomUUID();
      const vk = generateVaultKey();
      const r1 = randomUUID();
      const r2 = randomUUID();
      const e1 = encryptRecord({ recordId: r1, vaultId: vaultA, vaultKey: vk, payload: { password: 'one' } });
      const e2 = encryptRecord({ recordId: r2, vaultId: vaultA, vaultKey: vk, payload: { password: 'two' } });
      const out: string[] = [];
      out.push(throwsAs(() => decryptRecord({ recordId: r1, vaultId: vaultA, vaultKey: vk, encryptedKey: e1.encryptedKey, encryptedPayload: e2.encryptedPayload }), DecryptionError));
      out.push(throwsAs(() => decryptRecord({ recordId: r2, vaultId: vaultA, vaultKey: vk, encryptedKey: e1.encryptedKey, encryptedPayload: e1.encryptedPayload }), DecryptionError));
      out.push(throwsAs(() => decryptRecord({ recordId: r1, vaultId: vaultB, vaultKey: vk, encryptedKey: e1.encryptedKey, encryptedPayload: e1.encryptedPayload }), DecryptionError));
      const ok = decryptRecord<{ password: string }>({ recordId: r1, vaultId: vaultA, vaultKey: vk, encryptedKey: e1.encryptedKey, encryptedPayload: e1.encryptedPayload });
      assert(ok.payload.password === 'one', 'legitimate record did not decrypt');
      return { ok: true, evidence: `payload swap → ${out[0]}; key-wrap swap → ${out[1]}; same record claimed in another vault → ${out[2]}` };
    }, { severity: 'critical' });

    await t.check('crypto.binding.account-keys', 'Account key wraps are bound to their purpose (user key, private keys, settings, personal vault key version, device unlock)', () => {
      const uk = randomKey();
      const vk = generateVaultKey();
      const vid = randomUUID();
      const wrapped = wrapVaultKeyForSelf(uk, vk, vid, 1);
      throwsAs(() => decryptBytes(uk, wrapped, `pv:vault-key:v1:${vid}:2`), DecryptionError);
      throwsAs(() => decryptBytes(uk, wrapped, `pv:vault-key:v1:${randomUUID()}:1`), DecryptionError);
      const priv = encryptBytes(uk, s.randombytes_buf(32), CTX.privateEncryptionKey);
      throwsAs(() => decryptBytes(uk, priv, CTX.privateSigningKey), DecryptionError);
      throwsAs(() => decryptJson(uk, encryptJson(uk, { a: 1 }, CTX.settings), CTX.userKey), DecryptionError);
      const dev = wrapUserKeyForDevice(uk, 'device-a');
      throwsAs(() => unwrapUserKeyWithDeviceKey(dev.deviceKey, 'device-b', dev.encryptedUserKeyByDevice), DecryptionError);
      return { ok: true, evidence: 'wrong key version, other vault, private-key purpose swap, settings→user-key, other device id: all rejected' };
    }, { severity: 'high' });

    await t.check('crypto.grants.verification', 'Shared-vault key grants: wrong recipient, vault, key version, missing or forged signature are rejected', () => {
      const alice = createRegistrationMaterial('alice-pw-1', FAST);
      const bob = createRegistrationMaterial('bob-pw-1', FAST);
      const mallory = createRegistrationMaterial('mallory-pw-1', FAST);
      const aliceId = randomUUID();
      const bobId = randomUUID();
      const vaultId = randomUUID();
      const vk = generateVaultKey();
      const g = grantVaultKey({ vaultKey: vk, vaultId, keyVersion: 3, recipientUserId: bobId, recipientPublicEncryptionKey: bob.keys.publicEncryptionKey, grantor: alice.unlocked });
      const base = { encryptedVaultKey: g.encryptedVaultKey, keySignature: g.keySignature, vaultId, keyVersion: 3, myUserId: bobId, me: bob.unlocked, grantorPublicSigningKey: alice.keys.publicSigningKey };
      assert(hex(openVaultGrant(base)) === hex(vk), 'legitimate grant did not open');
      const r: string[] = [];
      r.push(throwsAs(() => openVaultGrant({ ...base, vaultId: randomUUID() }), GrantVerificationError));
      r.push(throwsAs(() => openVaultGrant({ ...base, keyVersion: 4 }), GrantVerificationError));
      r.push(throwsAs(() => openVaultGrant({ ...base, myUserId: aliceId }), GrantVerificationError));
      r.push(throwsAs(() => openVaultGrant({ ...base, keySignature: null }), GrantVerificationError));
      r.push(throwsAs(() => openVaultGrant({ ...base, grantorPublicSigningKey: mallory.keys.publicSigningKey }), GrantVerificationError));
      // A server substituting its own grant (sealed to Bob, signed by Mallory) while claiming Alice granted it:
      const forged = grantVaultKey({ vaultKey: generateVaultKey(), vaultId, keyVersion: 3, recipientUserId: bobId, recipientPublicEncryptionKey: bob.keys.publicEncryptionKey, grantor: mallory.unlocked });
      r.push(throwsAs(() => openVaultGrant({ ...base, encryptedVaultKey: forged.encryptedVaultKey, keySignature: forged.keySignature }), GrantVerificationError));
      // Replaying Bob's grant to Mallory: sealed to Bob, Mallory cannot open it.
      r.push(throwsAs(() => openVaultGrant({ ...base, myUserId: bobId, me: mallory.unlocked }), DecryptionError));
      return { ok: true, evidence: `rejections: ${r.join(', ')}` };
    }, { severity: 'critical' });

    await t.check('crypto.public-key-binding', 'A substituted encryption public key is detected by the identity signature', () => {
      const a = createRegistrationMaterial('a-pw-1', FAST);
      const other = s.crypto_box_keypair();
      assert(verifyPublicKeySignature(a.keys.publicEncryptionKey, a.keys.publicSigningKey, a.keys.publicKeySignature), 'own signature invalid');
      assert(!verifyPublicKeySignature(toB64(other.publicKey), a.keys.publicSigningKey, a.keys.publicKeySignature), 'substituted key accepted');
      return { ok: true, evidence: 'publicKeySignature binds the X25519 key to the Ed25519 identity' };
    }, { severity: 'high' });

    // ---------------------------------------------------------- randomness, nonces, parameters
    await t.check('crypto.nonces.unique', 'AEAD nonces are 192-bit random and do not repeat (200,000 encryptions under one key)', () => {
      const key = randomKey();
      const seen = new Set<string>();
      for (let i = 0; i < 200_000; i++) {
        const env = fromB64(encryptBytes(key, new Uint8Array(1), 'n'));
        const n = Buffer.from(env.subarray(2, 26)).toString('base64');
        assert(!seen.has(n), `nonce repeated after ${i} encryptions`);
        seen.add(n);
      }
      return { ok: true, evidence: '200000 distinct 24-byte nonces (random nonces; no counter state to desynchronise)' };
    }, { severity: 'high' });

    await t.check('crypto.randomness.source', 'Security code uses the libsodium CSPRNG (no Math.random in crypto, vault, server or client key paths)', () => {
      const hits = gitGrep('Math\\.random', ['packages/*/src', 'apps/*/src', 'native']);
      // Allowed: purely cosmetic UI (no secrets). Anything else fails.
      const bad = hits.filter((h) => !/apps\/(web|desktop|browser-extension)\/src\/.*(ui|components?)\//i.test(h));
      return { ok: bad.length === 0, evidence: hits.length ? `occurrences:\n${hits.join('\n')}` : 'no Math.random in source' };
    }, { severity: 'high' });

    await t.check('crypto.generator.uniform', 'Password generator draws every character from the CSPRNG over the full alphabet', () => {
      const pw = Array.from({ length: 400 }, () => generatePassword({ length: 64, symbols: true, digits: true, avoidAmbiguous: false })).join('');
      const counts = new Map<string, number>();
      for (const c of pw) counts.set(c, (counts.get(c) ?? 0) + 1);
      const n = pw.length;
      const k = counts.size;
      const expected = n / k;
      let chi = 0;
      for (const v of counts.values()) chi += (v - expected) ** 2 / expected;
      // df = k-1 ≈ 80-90; chi² above ~3x df would be a gross bias.
      return { ok: k >= 70 && chi < 3 * (k - 1), evidence: `${n} chars, ${k} distinct symbols, chi²=${chi.toFixed(1)} (df=${k - 1})` };
    }, { severity: 'medium' });

    await t.check('crypto.kdf.bounds', 'KDF parameters outside the documented bounds are refused (client side)', () => {
      const ok = newKdfParams();
      const bad: Array<[string, KdfParams]> = [
        ['opsLimit 1', { ...ok, opsLimit: 1 }],
        ['opsLimit 11', { ...ok, opsLimit: 11 }],
        ['memLimit 16 MiB', { ...ok, memLimitBytes: 16 * 1024 * 1024 }],
        ['memLimit 2 GiB', { ...ok, memLimitBytes: 2 * 1024 * 1024 * 1024 }],
        ['15-byte salt', { ...ok, salt: toB64(s.randombytes_buf(15)) }],
        ['argon2i', { ...ok, algorithm: 'argon2i' as 'argon2id' }],
        ['version 2', { ...ok, version: 2 as 1 }],
      ];
      for (const [name, p] of bad) {
        let threw = false;
        try {
          validateKdfParams(p);
        } catch {
          threw = true;
        }
        assert(threw, `${name} was accepted`);
      }
      return { ok: true, evidence: `defaults ops=${ok.opsLimit} mem=${ok.memLimitBytes / 1048576}MiB; refused: ${bad.map((b) => b[0]).join(', ')}` };
    }, { severity: 'high' });

    await t.check('crypto.key-separation', 'Login credential, wrap key and recovery subkeys are independent', () => {
      const p = newKdfParams(FAST);
      const k = derivePasswordKeys('separation-test-pw', p);
      assert(k.authKey !== toB64(k.wrapKey), 'authKey equals wrapKey');
      const m = createRegistrationMaterial('separation-test-pw-2', FAST);
      // The server knows authKey; it must not decrypt the user key.
      let opened = true;
      try {
        decryptBytes(fromB64(m.authKey), m.keys.encryptedUserKey, CTX.userKey);
      } catch {
        opened = false;
      }
      assert(!opened, 'authKey decrypts the user key');
      assert(m.keys.recoveryAuthKey !== m.authKey, 'recovery auth key equals password auth key');
      return { ok: true, evidence: 'authKey ≠ wrapKey; authKey cannot decrypt encryptedUserKey; recovery and password credentials differ' };
    }, { severity: 'critical' });

    await t.check('crypto.padding', 'Payload sizes are hidden to 128-byte blocks', () => {
      const key = randomKey();
      const lens = new Set<number>();
      for (let n = 0; n < 100; n++) lens.add(fromB64(encryptJson(key, 'x'.repeat(n), 'p')).length);
      return { ok: lens.size === 1, evidence: `string lengths 0–99 → ${[...lens].join(', ')} byte envelopes` };
    }, { severity: 'low' });

    // ---------------------------------------------------------- lifecycle
    await t.check('crypto.password-change', 'Changing the master password re-wraps the same user key; the old password no longer unlocks the new bundle', () => {
      const m = createRegistrationMaterial('old-password-1', FAST);
      const re = rewrapForNewPassword(m.unlocked.userKey, 'new-password-2', FAST);
      const keys = { ...m.keys, encryptedUserKey: re.encryptedUserKey };
      const unlocked = unlockWithPassword('new-password-2', re.kdf, keys);
      assert(hex(unlocked.userKey) === hex(m.unlocked.userKey), 'user key changed unexpectedly');
      const e = throwsAs(() => unlockWithPassword('old-password-1', re.kdf, keys), WrongPasswordError);
      assert(re.kdf.salt !== m.kdf.salt, 'salt was reused');
      return { ok: true, evidence: `new password unlocks; old password → ${e}; fresh salt` };
    }, { severity: 'high' });

    await t.check('crypto.recovery-key', 'Recovery key unlocks; mistyped or foreign recovery keys are rejected', () => {
      const m = createRegistrationMaterial('rk-password-1', FAST);
      const u = unlockWithRecoveryKey(m.recoveryKey, m.keys.encryptedUserKeyByRecovery, m.keys);
      assert(hex(u.userKey) === hex(m.unlocked.userKey), 'recovery did not yield the user key');
      const typo = m.recoveryKey.replace(/[A-Z2-7]/, (c) => (c === 'A' ? 'B' : 'A'));
      const a = throwsAs(() => unlockWithRecoveryKey(typo, m.keys.encryptedUserKeyByRecovery, m.keys), InvalidRecoveryKeyError);
      const other = createRegistrationMaterial('rk-password-2', FAST);
      const b = throwsAs(() => unlockWithRecoveryKey(other.recoveryKey, m.keys.encryptedUserKeyByRecovery, m.keys), InvalidRecoveryKeyError);
      return { ok: true, evidence: `typo → ${a} (checksum); other account's key → ${b}` };
    }, { severity: 'high' });

    await t.check(
      'crypto.rollback-detection',
      'A server replaying an OLDER ciphertext of the same record is detected by the client',
      () => {
        const vid = randomUUID();
        const rid = randomUUID();
        const vk = generateVaultKey();
        const v1 = encryptRecord({ recordId: rid, vaultId: vid, vaultKey: vk, payload: { password: 'old-rotated-out' } });
        const v2 = encryptRecord({ recordId: rid, vaultId: vid, vaultKey: vk, payload: { password: 'current' }, itemKey: v1.itemKey });
        void v2;
        // The client decrypts whatever (key, payload) pair it receives for the record id; nothing in the
        // ciphertext binds a revision number, so a rolled-back pair is indistinguishable from the current one.
        const replayed = decryptRecord<{ password: string }>({ recordId: rid, vaultId: vid, vaultKey: vk, encryptedKey: v1.encryptedKey, encryptedPayload: v1.encryptedPayload });
        return {
          ok: false,
          evidence: `old revision decrypted without error (password field = "${replayed.payload.password === 'old-rotated-out' ? 'old value' : '?'}"); revisions are server metadata, not authenticated by the client`,
        };
      },
      { severity: 'medium', finding: 'PV-SEC-004' },
    );
  },
};

export default suite;
