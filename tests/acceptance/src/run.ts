/**
 * End-to-end acceptance run against a real PassVault API (+ Mailpit for
 * registration codes). Drives the same VaultSession used by the web,
 * extension, and desktop clients, with two users and two devices.
 *
 *   API_URL=http://localhost:3100 MAILPIT_URL=http://localhost:8025 pnpm --filter @passvault/acceptance acceptance
 *
 * Uses only dummy data and throwaway accounts (unique emails per run).
 */
import { TOTP } from 'otpauth';
import { MemoryStore } from '@passvault/sync';
import { VaultSession, itemIdentifier, newItem, newProject, type Platform } from '@passvault/vault-core';
import { diffEnv, entries, parseEnv, setValue } from '@passvault/env-parser';
import type { ItemPayload } from '@passvault/types';

const API_URL = process.env.API_URL ?? 'http://localhost:3100';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const RUN = Date.now().toString(36);

let failures = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
async function scenario(name: string, fn: () => Promise<void>) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failures++;
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail });
    console.log(`  ✗ ${name}\n      ${detail}`);
  }
}

// ---------------- harness ----------------

interface Device {
  session: VaultSession;
  offline: { value: boolean };
}

function makeDevice(name: string): Device {
  const offline = { value: false };
  const prefs = new Map<string, string>();
  let token: string | null = null;
  const stores = new Map<string, MemoryStore>();
  const platform: Platform = {
    clientType: 'cli',
    deviceName: name,
    apiBaseUrl: API_URL,
    webAppUrl: 'http://localhost:5173',
    tokens: { get: async () => token, set: async (t) => void (token = t), clear: async () => void (token = null) },
    prefs: { get: async (k) => prefs.get(k) ?? null, set: async (k, v) => void prefs.set(k, v), remove: async (k) => void prefs.delete(k) },
    createCacheStore: (scope) => {
      if (!stores.has(scope)) stores.set(scope, new MemoryStore());
      return stores.get(scope)!;
    },
    clipboard: { copySecret: async () => undefined, copyText: async () => undefined },
    files: { pickTextFile: async () => null, saveTextFile: async () => ({ saved: false }) },
    openExternal: async () => undefined,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (offline.value) throw new TypeError('simulated offline');
      return fetch(input, init);
    }) as typeof fetch,
  };
  return { session: new VaultSession(platform), offline };
}

async function mailCode(email: string, after: number): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const j = (await r.json()) as { messages: Array<{ ID: string; Created: string }> };
    const msg = j.messages.find((m) => Date.parse(m.Created) >= after - 1000);
    if (msg) {
      const m = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${msg.ID}`)).json()) as { Text: string };
      const code = /\b(\d{6})\b/.exec(m.Text)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no verification email for ${email}`);
}

const totps = new Map<string, TOTP>();
const lastStep = new Map<string, number>();
/** Next TOTP code, waiting for a fresh time step so the server's replay protection is respected. */
async function freshCode(email: string): Promise<string> {
  const t = totps.get(email)!;
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    if (lastStep.get(email) !== step) {
      lastStep.set(email, step);
      return t.generate();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function registerAndEnroll(d: Device, email: string, name: string, password: string) {
  const s = d.session;
  await s.init();
  const started = Date.now();
  await s.startRegistration(email);
  const code = await mailCode(email, started);
  const token = await s.verifyRegistration(email, code);
  const { recoveryKey } = await s.register(token, email, name, password);
  check(/^[A-Z2-7]{5}(-[A-Z2-7]{1,5}){10}$/.test(recoveryKey), 'recovery key format');
  const phase = await s.login(email, password);
  check(phase.phase === 'mfa_enroll', `expected mandatory MFA enrollment, got ${phase.phase}`);
  const { secret } = await s.startMfaEnrollment();
  totps.set(email, new TOTP({ secret, digits: 6, period: 30, algorithm: 'SHA1' }));
  const codes = await s.confirmMfaEnrollment(await freshCode(email));
  check(codes.length === 10, 'ten recovery codes');
  s.acknowledgeRecoveryCodes();
  check(s.getSnapshot().auth.phase === 'unlocked', 'unlocked after enrollment');
  await s.syncNow();
  return { recoveryKey, codes };
}

async function loginExisting(d: Device, email: string, password: string) {
  await d.session.init();
  const phase = await d.session.login(email, password);
  check(phase.phase === 'mfa_verify', `expected MFA prompt on new device, got ${phase.phase}`);
  await d.session.verifyMfa({ code: await freshCode(email) });
  await d.session.syncNow();
}

const item = (d: Device, title: string) => d.session.getSnapshot().items.find((i) => i.payload.title === title);

// ---------------- scenarios ----------------

async function main() {
  console.log(`PassVault acceptance run ${RUN} against ${API_URL}\n`);
  const health = await (await fetch(`${API_URL}/api/v1/health`)).json();
  check((health as { status: string }).status === 'ok', 'API healthy');

  const aliceEmail = `alice.${RUN}@example.com`;
  const bobEmail = `bob.${RUN}@example.com`;
  const alicePw = 'violet-harbor-copper-quill-58';
  const bobPw = 'saffron-tundra-pixel-anchor-23';
  const alice = makeDevice('alice-laptop');
  const alice2 = makeDevice('alice-desktop');
  const bob = makeDevice('bob-laptop');
  let projectId = '';
  let sharedVaultId = '';

  await scenario('1. Register (email verified first), mandatory MFA enrollment, unlock', async () => {
    await registerAndEnroll(alice, aliceEmail, 'Alice', alicePw);
    await registerAndEnroll(bob, bobEmail, 'Bob', bobPw);
  });

  await scenario('2. Save a website login with notes, tags, and category', async () => {
    await alice.session.saveItem(
      newItem('login', {
        title: 'Example Shop',
        notes: 'Shared team account (dummy)',
        tags: ['shop', 'team'],
        folder: 'Work/Vendors',
        fields: { username: 'ops@example.com', password: 'Dummy-Pass-123!x', urls: [{ url: 'https://shop.example.com', match: 'host' }] },
      }),
    );
    await alice.session.syncNow();
    const it = item(alice, 'Example Shop');
    check(it && it.revision === 1 && !it.pending, 'login synced at revision 1');
    check(it.payload.tags.includes('team') && it.payload.folder === 'Work/Vendors', 'tags/category kept');
  });

  await scenario('4. Save SSH, database, and API credentials without website URLs', async () => {
    await alice.session.saveItem(newItem('ssh_connection', { title: 'Bastion', fields: { host: '198.51.100.7', port: 2222, username: 'deploy', authMethod: 'password', password: 'dummy', hostKeys: [] } }));
    await alice.session.saveItem(newItem('database', { title: 'Analytics DB', fields: { engine: 'postgresql', host: 'db.example.net', port: 5432, database: 'analytics', username: 'reader', password: 'dummy', tlsMode: 'verify-full' } }));
    await alice.session.saveItem(newItem('api_credential', { title: 'Weather API', fields: { service: 'Weather', kind: 'api_key', apiKey: 'wk_dummy_123' } }));
    await alice.session.syncNow();
    for (const t of ['Bastion', 'Analytics DB', 'Weather API']) check(item(alice, t)?.revision === 1, `${t} synced`);
  });

  await scenario('5. Project with Development and Production .env files', async () => {
    projectId = await alice.session.saveProject(newProject('Storefront'));
    await alice.session.saveItem(newItem('env_file', { title: 'Storefront dev', projectId, environment: 'Development', fields: { filename: '.env', content: '# dev\nAPI_URL=http://localhost:8080\nSECRET_KEY="dev-secret"\nDEBUG=true\n', variableNotes: {} } }));
    await alice.session.saveItem(newItem('env_file', { title: 'Storefront prod', projectId, environment: 'Production', fields: { filename: '.env.production', content: '# prod\nAPI_URL=https://api.example.com\nSECRET_KEY="prod-secret"\nSENTRY_DSN=https://k@sentry.example.com/1\n', variableNotes: {} } }));
    await alice.session.syncNow();
    check(item(alice, 'Storefront prod')?.payload.projectId === projectId, 'env file in project');
  });

  await scenario('6. Edit a variable, compare environments, restore a version, export intentionally', async () => {
    const dev = item(alice, 'Storefront dev')!;
    const content = (dev.payload as ItemPayload<'env_file'>).fields.content;
    const parsed = parseEnv(content);
    const target = entries(parsed).find((e) => e.key === 'DEBUG')!;
    const edited = setValue(parsed, target.id, 'false');
    check(edited.ok, 'structured edit applied');
    check(edited.text === content.replace('DEBUG=true', 'DEBUG=false'), 'only the edited line changed');
    await alice.session.updateItem(dev.id, (p) => void (p.type === 'env_file' && (p.fields.content = edited.text)));
    await alice.session.syncNow();
    const prod = item(alice, 'Storefront prod')!;
    const diff = diffEnv(parseEnv(edited.text), parseEnv((prod.payload as ItemPayload<'env_file'>).fields.content));
    const status = Object.fromEntries(diff.map((d) => [d.key, d.status]));
    check(status.API_URL === 'changed' && status.DEBUG === 'removed' && status.SENTRY_DSN === 'added', `diff ${JSON.stringify(status)}`);
    check(!JSON.stringify(diff).includes('prod-secret'), 'diff never exposes values');
    const versions = await alice.session.itemVersions(dev.id);
    check(versions.length >= 1 && versions[0]!.payload, 'encrypted history decrypts');
    await alice.session.restoreVersion(dev.id, versions[0]!.payload as ItemPayload);
    await alice.session.syncNow();
    const restored = item(alice, 'Storefront dev')!;
    check((restored.payload as ItemPayload<'env_file'>).fields.content.includes('DEBUG=true'), 'restored previous content');
    check(restored.revision === 3, `restore creates a new revision (got ${restored.revision})`);
    const exported = alice.session.exportPlaintext([restored.id]);
    check(exported.includes('DEBUG=true') && exported.includes('unencrypted'), 'explicit plaintext export with warning');
  });

  await scenario('7. Second device signs in (MFA) and syncs the same encrypted items', async () => {
    await loginExisting(alice2, aliceEmail, alicePw);
    const titles = alice2.session.getSnapshot().items.map((i) => i.payload.title).sort();
    check(titles.includes('Storefront prod') && titles.includes('Example Shop') && titles.length === 6, `device 2 sees ${titles.length} items`);
    check(alice2.session.getSnapshot().projects.some((p) => p.payload.name === 'Storefront'), 'device 2 sees the project');
  });

  await scenario('8. Cards, passkeys, extra login fields and identifiers sync; unknown future fields survive edits', async () => {
    await alice.session.saveItem(
      newItem('payment_card', {
        title: 'Team Visa',
        description: 'ops-visa',
        fields: { cardholder: 'Alex Rivera', number: '4111111111111111', expMonth: '08', expYear: '2031', cvv: '123', pin: '' },
      }),
    );
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
    const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
    const passkey = {
      credentialId: b64u(crypto.getRandomValues(new Uint8Array(32))),
      rpId: 'shop.example.com',
      rpName: 'Example Shop',
      userHandle: 'dXNlci0x',
      userName: 'ops@example.com',
      userDisplayName: 'Ops',
      alg: -7 as const,
      privateKey: b64u(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
      createdAt: new Date().toISOString(),
    };
    await alice.session.saveItem(
      newItem('login', {
        title: 'AWS console',
        description: 'aws-prod-root\nlonger notes about the account',
        customFields: [{ id: crypto.randomUUID(), label: 'Account ID', type: 'text', value: '123456789012' }],
        fields: { username: 'ops', password: 'Dummy-Aws-Pass-1!', urls: [{ url: 'https://signin.aws.amazon.com', match: 'host' }], passkeys: [passkey] },
      }),
    );
    // A field written by a newer client this one does not know.
    await alice.session.updateItem(item(alice, 'AWS console')!.id, (p) => {
      (p as unknown as Record<string, unknown>).futureField = { kept: true };
      (p.fields as unknown as Record<string, unknown>).futureLoginField = 'kept';
    });
    await alice.session.syncNow();
    await alice2.session.syncNow();

    const card = item(alice2, 'Team Visa');
    check(card?.payload.type === 'payment_card', 'card synced to device 2');
    check(card.payload.fields.number === '4111111111111111' && card.payload.fields.cvv === '123' && itemIdentifier(card.payload) === 'ops-visa', 'card fields and identifier intact');
    const aws = item(alice2, 'AWS console');
    check(aws?.payload.type === 'login', 'login synced to device 2');
    check(aws.payload.fields.passkeys?.[0]?.credentialId === passkey.credentialId && aws.payload.fields.passkeys[0].privateKey === passkey.privateKey, 'passkey synced');
    check(aws.payload.customFields[0]?.value === '123456789012', 'extra login field synced');
    check(itemIdentifier(aws.payload) === 'aws-prod-root', 'identifier is the first line of the description');

    // Device 2 edits something unrelated; nothing it does not know about may be lost.
    await alice2.session.updateItem(aws.id, (p) => void (p.notes = 'rotated'));
    await alice2.session.syncNow();
    await alice.session.syncNow();
    const back = item(alice, 'AWS console')!.payload as unknown as Record<string, unknown> & { fields: Record<string, unknown>; notes: string };
    const dbg = (d: Device) => { const i = item(d, 'AWS console')!; return `rev=${i.revision} pending=${!!i.pending} conflict=${!!i.conflict} notes=${JSON.stringify(i.payload.notes)}`; };
    check(back.notes === 'rotated', `edit from device 2 arrived (device1 ${dbg(alice)}; device2 ${dbg(alice2)})`);
    check((back.futureField as { kept?: boolean })?.kept === true && back.fields.futureLoginField === 'kept', 'unknown fields preserved through another client’s edit');
    check(Array.isArray(back.fields.passkeys) && (back.fields.passkeys as unknown[]).length === 1, 'passkey preserved through edit');

    const blob = JSON.stringify(await alice.session.api.sync('0'));
    for (const s of ['4111111111111111', '123456789012', 'aws-prod-root', passkey.privateKey]) check(!blob.includes(s), `sync response leaks "${s}"`);
  });

  await scenario('11. Share a project with another user and enforce editing permissions', async () => {
    const r = await alice.session.lookupRecipient(bobEmail);
    check(r.pinned === 'new' && /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/.test(r.fingerprint), 'recipient fingerprint shown');
    sharedVaultId = await alice.session.share({ target: { kind: 'project', projectId }, recipients: [{ recipient: { ...r, verified: true }, role: 'viewer', expiresAt: null }], allowResharing: false });
    const invs = await bob.session.invitations();
    const inv = invs.find((i) => i.vaultId === sharedVaultId);
    check(inv && inv.role === 'viewer', 'bob has a pending invitation');
    check(inv.fingerprint === alice.session.myFingerprint(), 'bob sees alice’s real fingerprint');
    await bob.session.acceptInvitation(inv, true);
    const bobItem = item(bob, 'Storefront prod');
    check(bobItem && bobItem.role === 'viewer' && bobItem.shared, 'bob decrypts shared items');
    // client refuses, and the server independently refuses a viewer write
    let clientRefused = false;
    try {
      await bob.session.updateItem(bobItem.id, (p) => void (p.notes = 'viewer edit'));
    } catch {
      clientRefused = true;
    }
    check(clientRefused, 'client blocks viewer edits');
    try {
      await bob.session.api.updateRecord(bobItem.id, { baseRevision: bobItem.revision, formatVersion: 1, encryptedKey: 'AQ', encryptedPayload: 'AQ', mutationId: crypto.randomUUID() });
      check(false, 'server accepted a viewer write');
    } catch (e) {
      check((e as { status?: number }).status === 403, `server rejects viewer write with 403 (got ${(e as { status?: number }).status})`);
    }
    // upgrade to editor: edit propagates back to alice
    await alice.session.updateMember(sharedVaultId, bob.session.userId!, { role: 'editor' });
    await bob.session.syncNow();
    await bob.session.updateItem(item(bob, 'Storefront prod')!.id, (p) => void (p.notes = 'Rotated by Bob'));
    await bob.session.syncNow();
    await alice.session.syncNow();
    check(item(alice, 'Storefront prod')?.payload.notes === 'Rotated by Bob', 'editor change visible to owner');
    // items added to the shared project later inherit sharing
    await alice.session.saveItem(newItem('secure_note', { title: 'Storefront runbook', projectId, fields: { content: 'dummy' } }));
    await alice.session.syncNow();
    await bob.session.syncNow();
    check(item(bob, 'Storefront runbook'), 'new project item is shared automatically');
    check(!item(bob, 'Example Shop'), 'unshared personal items stay private');
  });

  await scenario('12. Revoke future access: key rotation and re-encryption', async () => {
    const before = alice.session.getSnapshot().vaults.find((v) => v.vaultId === sharedVaultId)!.keyVersion;
    const r = await alice.session.revokeMember(sharedVaultId, bob.session.userId!);
    check(r.rotated, 'vault key rotated after revocation');
    await alice.session.syncNow();
    const after = alice.session.getSnapshot().vaults.find((v) => v.vaultId === sharedVaultId)!.keyVersion;
    check(after === before + 1, `key version ${before} → ${after}`);
    check(item(alice, 'Storefront prod')?.payload.notes === 'Rotated by Bob', 'owner still reads re-encrypted items');
    await bob.session.syncNow();
    check(!item(bob, 'Storefront prod') && !bob.session.getSnapshot().vaults.some((v) => v.vaultId === sharedVaultId), 'revoked member’s cache purged');
    try {
      await bob.session.api.vaultRecords(sharedVaultId);
      check(false, 'revoked member can still list records');
    } catch (e) {
      check([403, 404].includes((e as { status?: number }).status ?? 0), 'server denies revoked member');
    }
  });

  await scenario('13. Lock the vault: decrypted state cleared and new key use refused', async () => {
    let hookCalled = false;
    const off = alice2.session.onLock(() => (hookCalled = true));
    alice2.session.lock();
    off();
    const snap = alice2.session.getSnapshot();
    check(snap.auth.phase === 'locked' && snap.items.length === 0 && !alice2.session.isUnlocked, 'locked with no plaintext state');
    check(hookCalled, 'platform lock hooks (terminal/agent shutdown) invoked');
    let refused = false;
    try {
      await alice2.session.saveItem(newItem('secure_note', { title: 'x', fields: { content: 'x' } }));
    } catch {
      refused = true;
    }
    check(refused, 'writes refused while locked');
    await alice2.session.unlock(alicePw);
    check(alice2.session.getSnapshot().items.length > 0, 'unlock restores from encrypted cache');
  });

  await scenario('14. Offline edit, concurrent change, conflict resolution', async () => {
    const id = item(alice, 'Example Shop')!.id;
    alice.offline.value = true;
    await alice.session.updateItem(id, (p) => void (p.notes = 'edited offline on laptop'));
    check(item(alice, 'Example Shop')?.pending, 'offline edit queued');
    await alice2.session.syncNow();
    await alice2.session.updateItem(id, (p) => void (p.notes = 'edited on desktop'));
    await alice2.session.syncNow();
    alice.offline.value = false;
    await alice.session.syncNow();
    const conflicted = item(alice, 'Example Shop')!;
    check(conflicted.conflict, 'conflict detected instead of overwriting');
    const both = alice.session.conflictVersions(id) as { mine: ItemPayload; theirs: ItemPayload };
    check(both.mine.notes === 'edited offline on laptop' && both.theirs.notes === 'edited on desktop', 'both versions available');
    await alice.session.resolveConflict(id, 'mine');
    await alice.session.syncNow();
    await alice2.session.syncNow();
    check(item(alice2, 'Example Shop')?.payload.notes === 'edited offline on laptop', 'resolution propagated');
  });

  await scenario('Deletion tombstones prevent resurrection', async () => {
    const id = item(alice, 'Weather API')!.id;
    await alice.session.moveToTrash(id);
    await alice.session.deletePermanently(id);
    await alice.session.syncNow();
    await alice2.session.syncNow();
    check(!item(alice2, 'Weather API'), 'deletion propagated to other device');
    try {
      await alice2.session.api.updateRecord(id, { baseRevision: 1, formatVersion: 1, encryptedKey: 'AQ', encryptedPayload: 'AQ', mutationId: crypto.randomUUID() });
      check(false, 'deleted record updated');
    } catch (e) {
      check((e as { status?: number }).status === 410, 'stale update rejected with 410 gone');
    }
  });

  await scenario('Server stores no plaintext for item fields', async () => {
    const page = await alice.session.api.sync('0');
    const blob = JSON.stringify(page);
    for (const s of ['Example Shop', 'ops@example.com', 'Dummy-Pass-123!x', 'prod-secret', 'Storefront', 'db.example.net']) check(!blob.includes(s), `sync response leaks "${s}"`);
  });

  for (const d of [alice, alice2, bob]) await d.session.logout().catch(() => undefined);
  console.log(`\n${results.length - failures}/${results.length} scenarios passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
