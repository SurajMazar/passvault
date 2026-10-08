import { randomUUID } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import {
  createRegistrationMaterial,
  encryptRecord,
  generateVaultKey,
  grantVaultKey,
  initCrypto,
  rewrapRecordKey,
  wrapVaultKeyForSelf,
  type RegistrationMaterial,
} from '@passvault/crypto';
import type * as T from '@passvault/types';
import { Api, brief, type ApiResponse } from './http';
import { waitForMail } from './mail';
import { registerSecret } from './results';

/** Minimum KDF parameters the server accepts (keeps actor creation fast; strength is not under test here). */
export const ACTOR_KDF = { opsLimit: 2, memLimitBytes: 32 * 1024 * 1024 };

export interface Actor {
  tag: string;
  email: string;
  name: string;
  password: string;
  material: RegistrationMaterial;
  authKey: string;
  userId: string;
  personalVaultId: string;
  personalVaultKey: Uint8Array;
  deviceId: string;
  token: string;
  totpSecret: string;
  recoveryCodes: string[];
}

export interface Env {
  api: Api;
  mailpit: string;
}

const lastStep = new Map<string, number>();
/** A TOTP code from a 30-second step this secret has not used yet (the server rejects replays). */
export async function freshTotp(secret: string): Promise<string> {
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    if ((lastStep.get(secret) ?? -1) < step) {
      lastStep.set(secret, step);
      return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate();
    }
    await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 300));
  }
}
export function totpAt(secret: string, timestamp: number) {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate({ timestamp });
}

export const uniqueEmail = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@sec.example.test`;

export function buildRegistration(email: string, password = `pw-${randomUUID()}`) {
  const material = createRegistrationMaterial(password, ACTOR_KDF);
  const personalVaultId = randomUUID();
  const personalVaultKey = generateVaultKey();
  registerSecret(password, material.authKey, material.recoveryKey, material.keys.recoveryAuthKey);
  const body: Omit<T.RegisterRequest, 'registrationToken'> = {
    email,
    name: 'Security Tester',
    kdf: material.kdf,
    authKey: material.authKey,
    keys: material.keys,
    personalVault: { id: personalVaultId, encryptedVaultKey: wrapVaultKeyForSelf(material.unlocked.userKey, personalVaultKey, personalVaultId, 1) },
  };
  return { body, material, password, personalVaultId, personalVaultKey };
}

/** register/start → mailed code → register/verify → registrationToken */
export async function registrationToken(env: Env, email: string): Promise<string> {
  let code = '';
  for (let attempt = 0; attempt < 2 && !code; attempt++) {
    // One resend if the first mail does not arrive (e.g. right after the stack started).
    const t0 = Date.now();
    const s = await env.api.post('/auth/register/start', { email });
    if (s.status !== 202) throw new Error(`register/start ${brief(s)}`);
    code = await waitForMail(env.mailpit, email, t0, /\b(\d{6})\b/).then((m) => m.match, (e: Error) => (attempt ? Promise.reject(e) : ''));
  }
  const v = await env.api.post('/auth/register/verify', { email, code });
  if (v.status !== 200) throw new Error(`register/verify ${brief(v)}`);
  return v.body.registrationToken as string;
}

/** Fully onboarded user: verified email, registered, TOTP enrolled, active session. */
export async function newActor(env: Env, tag: string): Promise<Actor> {
  await initCrypto();
  const email = uniqueEmail(tag);
  const reg = buildRegistration(email);
  const token = await registrationToken(env, email);
  const r = await env.api.post('/auth/register', { ...reg.body, registrationToken: token });
  if (r.status !== 201) throw new Error(`register ${brief(r)}`);
  const deviceId = randomUUID();
  const login = await env.api.post('/auth/login', { email, authKey: reg.material.authKey, device: { id: deviceId, name: `harness-${tag}`, clientType: 'cli' } });
  if (login.status !== 200 || !login.body.mfaToken) throw new Error(`login ${brief(login)}`);
  const start = await env.api.post('/auth/mfa/enroll/start', { mfaToken: login.body.mfaToken });
  if (start.status !== 200) throw new Error(`enroll/start ${brief(start)}`);
  const secret = start.body.secret as string;
  registerSecret(secret);
  const confirm = await env.api.post('/auth/mfa/enroll/confirm', { mfaToken: login.body.mfaToken, code: await freshTotp(secret) });
  if (confirm.status !== 200) throw new Error(`enroll/confirm ${brief(confirm)}`);
  registerSecret(confirm.body.session.token, ...(confirm.body.recoveryCodes as string[]));
  return {
    tag,
    email,
    name: 'Security Tester',
    password: reg.password,
    material: reg.material,
    authKey: reg.material.authKey,
    userId: r.body.userId,
    personalVaultId: reg.personalVaultId,
    personalVaultKey: reg.personalVaultKey,
    deviceId,
    token: confirm.body.session.token,
    totpSecret: secret,
    recoveryCodes: confirm.body.recoveryCodes,
  };
}

/** Second session for an existing actor (login + TOTP). */
export async function loginAgain(env: Env, a: Actor): Promise<string> {
  const deviceId = randomUUID();
  const login = await env.api.post('/auth/login', { email: a.email, authKey: a.authKey, device: { id: deviceId, name: `harness-${a.tag}-2`, clientType: 'cli' } });
  if (login.status !== 200) throw new Error(`login ${brief(login)}`);
  const v = await env.api.post('/auth/mfa/verify', { mfaToken: login.body.mfaToken, code: await freshTotp(a.totpSecret) });
  if (v.status !== 200) throw new Error(`mfa/verify ${brief(v)}`);
  registerSecret(v.body.session.token);
  return v.body.session.token as string;
}

export async function reauth(env: Env, a: Actor, token = a.token): Promise<void> {
  const r = await env.api.post('/auth/reauth', { authKey: a.authKey, code: await freshTotp(a.totpSecret) }, { token });
  if (r.status !== 200) throw new Error(`reauth ${brief(r)}`);
}

export interface SharedVault {
  vaultId: string;
  vaultKey: Uint8Array;
  keyVersion: number;
}

export async function createSharedVault(env: Env, owner: Actor, allowResharing = false): Promise<SharedVault> {
  const vaultId = randomUUID();
  const vaultKey = generateVaultKey();
  const grant = grantVaultKey({ vaultKey, vaultId, keyVersion: 1, recipientUserId: owner.userId, recipientPublicEncryptionKey: owner.material.keys.publicEncryptionKey, grantor: owner.material.unlocked });
  const r = await env.api.post('/vaults', { id: vaultId, kind: 'item', allowResharing, encryptedVaultKey: grant.encryptedVaultKey, keySignature: grant.keySignature }, { token: owner.token });
  if (r.status !== 201) throw new Error(`create vault ${brief(r)}`);
  return { vaultId, vaultKey, keyVersion: 1 };
}

export function inviteBody(v: SharedVault, grantor: Actor, recipient: Actor, role: T.VaultRole, expiresAt?: string | null): T.InviteMemberRequest {
  const g = grantVaultKey({
    vaultKey: v.vaultKey,
    vaultId: v.vaultId,
    keyVersion: v.keyVersion,
    recipientUserId: recipient.userId,
    recipientPublicEncryptionKey: recipient.material.keys.publicEncryptionKey,
    grantor: grantor.material.unlocked,
  });
  return { recipientUserId: recipient.userId, role, keyVersion: v.keyVersion, ...g, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

export async function invite(env: Env, v: SharedVault, grantor: Actor, recipient: Actor, role: T.VaultRole, expiresAt?: string | null) {
  const r = await env.api.post(`/vaults/${v.vaultId}/members`, inviteBody(v, grantor, recipient, role, expiresAt), { token: grantor.token });
  if (r.status !== 201) throw new Error(`invite ${brief(r)}`);
}

export async function accept(env: Env, v: SharedVault, a: Actor) {
  const r = await env.api.post(`/invitations/${v.vaultId}/accept`, {}, { token: a.token });
  if (r.status !== 200) throw new Error(`accept ${brief(r)}`);
}

export function recordBody(vaultId: string, vaultKey: Uint8Array, payload: unknown, id = randomUUID()) {
  const enc = encryptRecord({ recordId: id, vaultId, vaultKey, payload });
  return {
    id,
    itemKey: enc.itemKey,
    body: { id, vaultId, kind: 'item' as const, formatVersion: enc.formatVersion, encryptedKey: enc.encryptedKey, encryptedPayload: enc.encryptedPayload, mutationId: randomUUID() },
  };
}

export async function createRecord(env: Env, a: Actor, vaultId: string, vaultKey: Uint8Array, payload: unknown = { title: 'x' }) {
  const rb = recordBody(vaultId, vaultKey, payload);
  const r = await env.api.post('/records', rb.body, { token: a.token });
  if (r.status !== 201) throw new Error(`create record ${brief(r)}`);
  return { id: rb.id, revision: r.body.revision as number, itemKey: rb.itemKey };
}

export function updateBody(vaultId: string, vaultKey: Uint8Array, id: string, baseRevision: number, payload: unknown = { title: 'updated' }) {
  const enc = encryptRecord({ recordId: id, vaultId, vaultKey, payload });
  return { baseRevision, formatVersion: enc.formatVersion, encryptedKey: enc.encryptedKey, encryptedPayload: enc.encryptedPayload, mutationId: randomUUID() };
}

/** Owner rotates a shared vault key: new grants for `members` (incl. the owner) and re-wrapped record keys. */
export async function rotateVault(
  env: Env,
  owner: Actor,
  v: SharedVault,
  members: Actor[],
  records: Array<{ id: string; itemKey: Uint8Array; revision: number }>,
): Promise<ApiResponse> {
  const newKey = generateVaultKey();
  const newVersion = v.keyVersion + 1;
  const grants = members.map((m) => {
    const g = grantVaultKey({
      vaultKey: newKey,
      vaultId: v.vaultId,
      keyVersion: newVersion,
      recipientUserId: m.userId,
      recipientPublicEncryptionKey: m.material.keys.publicEncryptionKey,
      grantor: owner.material.unlocked,
    });
    return { userId: m.userId, encryptedVaultKey: g.encryptedVaultKey, keySignature: g.keySignature };
  });
  const recs = records.map((r) => ({ id: r.id, baseRevision: r.revision, encryptedKey: rewrapRecordKey(r.itemKey, v.vaultId, newKey, r.id) }));
  const res = await env.api.post(`/vaults/${v.vaultId}/rotate`, { newKeyVersion: newVersion, grants, records: recs }, { token: owner.token });
  if (res.status === 200) {
    v.vaultKey = newKey;
    v.keyVersion = newVersion;
    for (const r of records) r.revision += 1;
  }
  return res;
}
