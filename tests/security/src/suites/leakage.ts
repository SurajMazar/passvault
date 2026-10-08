import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { initCrypto } from '@passvault/crypto';
import { newItem } from '@passvault/vault-core';
import { freshTotp, newActor, type Actor } from '../lib/actors';
import { dumpClientStorage, signIn } from '../lib/client';
import { traffic } from '../lib/http';
import { allMailText } from '../lib/mail';
import { ROOT, WORK } from '../lib/paths';
import { registerSecret } from '../lib/results';
import { requireDisposable, type Suite } from '../lib/suite';
import { findCanaries, sleep } from '../lib/util';

/** One unique synthetic secret per item type and field. */
function canaries(): Record<string, string> {
  const c = (name: string) => `PVCANARY-${name}-${randomBytes(9).toString('base64url')}`;
  const names = [
    'login.title', 'login.username', 'login.password', 'login.notes', 'login.url',
    'ssh_connection.host', 'ssh_connection.password',
    'ssh_key.privateKey', 'ssh_key.passphrase',
    'database.password', 'database.connectionString',
    'api_credential.token', 'api_credential.clientSecret',
    'env_file.value', 'env_file.filename',
    'secure_note.content',
    'edited.password', 'history.oldPassword', 'shared.note', 'search.term',
  ];
  const out = Object.fromEntries(names.map((n) => [n, c(n)]));
  // Fields with a strict shape (validated by the client) get a canary of that shape.
  out['ssh_connection.host'] = `pvcanary-${randomBytes(6).toString('hex')}.example.test`;
  out['login.url'] = `pvcanary${randomBytes(6).toString('hex')}`;
  return out;
}

const suite: Suite = {
  id: 'leakage',
  title: 'Secret-leak detection with synthetic canaries (traffic, database, logs, mail, client storage)',
  needsApi: true,
  async run(ctx) {
    const { t, log } = ctx;
    const env = ctx.env!;
    await initCrypto();
    const C = canaries();
    for (const v of Object.values(C)) registerSecret(v);

    // Capture every request the real clients make (vault-core uses the global fetch).
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await realFetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(env.api.base)) {
        const body = await res.clone().text();
        traffic.push({ method: init?.method ?? 'GET', url, requestHeaders: {}, requestBody: typeof init?.body === 'string' ? init.body : '', status: res.status, responseHeaders: Object.fromEntries(res.headers.entries()), responseBody: body });
      }
      return res;
    }) as typeof fetch;

    try {
      log('exercising create / edit / history / share / search with canaries…');
      const owner: Actor = await newActor(env, 'leak-owner');
      const peer: Actor = await newActor(env, 'leak-peer');
      const masterSecrets = { 'owner.masterPassword': owner.password, 'owner.recoveryKey': owner.material.recoveryKey, 'peer.masterPassword': peer.password };
      const oc = await signIn(env, owner, 'leak-owner-device');
      const s = oc.session;
      const ids: string[] = [];
      ids.push(await s.saveItem(newItem('login', { title: C['login.title'], notes: C['login.notes'], fields: { username: C['login.username'], password: C['history.oldPassword'], urls: [{ url: `https://${C['login.url']}.example.com/`, match: 'host' }] } } as never)));
      ids.push(await s.saveItem(newItem('ssh_connection', { title: 'server', fields: { host: C['ssh_connection.host'], port: 22, username: 'root', authMethod: 'password', password: C['ssh_connection.password'], hostKeys: [] } } as never)));
      ids.push(await s.saveItem(newItem('ssh_key', { title: 'key', fields: { publicKey: 'ssh-ed25519 AAAA test', privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${C['ssh_key.privateKey']}\n-----END OPENSSH PRIVATE KEY-----`, passphrase: C['ssh_key.passphrase'], fingerprint: 'SHA256:x', algorithm: 'ed25519' } } as never)));
      ids.push(await s.saveItem(newItem('database', { title: 'db', fields: { engine: 'postgresql', host: 'db.internal', database: 'app', username: 'app', password: C['database.password'], tlsMode: 'require', connectionString: `postgres://app:${C['database.connectionString']}@db/app` } } as never)));
      ids.push(await s.saveItem(newItem('api_credential', { title: 'api', fields: { service: 'svc', kind: 'client_credentials', token: C['api_credential.token'], clientId: 'id', clientSecret: C['api_credential.clientSecret'] } } as never)));
      ids.push(await s.saveItem(newItem('env_file', { title: 'env', fields: { filename: `${C['env_file.filename']!.replace(/[^A-Za-z0-9._-]/g, '')}.env`, content: `DATABASE_URL=postgres://u:${C['env_file.value']}@h/db\n`, variableNotes: {} } } as never)));
      ids.push(await s.saveItem(newItem('secure_note', { title: 'note', fields: { content: C['secure_note.content'] } } as never)));
      await s.syncNow();
      // edit → history
      await s.updateItem(ids[0]!, (p) => {
        if (p.type === 'login') p.fields.password = C['edited.password']!;
      });
      await s.syncNow();
      await s.itemVersions(ids[0]!);
      // search (client-side)
      void s.getSnapshot().items.filter((i) => JSON.stringify(i.payload).includes(C['search.term']!));
      // share the login + note to the peer through the real client flow
      const r = await s.lookupRecipient(peer.email);
      await s.share({ target: { kind: 'items', itemIds: [ids[0]!, ids[6]!] }, recipients: [{ recipient: r, role: 'viewer', expiresAt: null }], allowResharing: false });
      await s.updateItem(ids[6]!, (p) => {
        if (p.type === 'secure_note') p.fields.content = `${p.fields.content}\n${C['shared.note']}`;
      });
      await s.syncNow();
      const pc = await signIn(env, peer, 'leak-peer-device');
      for (const inv of await pc.session.invitations()) await pc.session.acceptInvitation(inv, false);
      await pc.session.syncNow();
      const peerSees = pc.session.getSnapshot().items.some((i) => JSON.stringify(i.payload).includes(C['shared.note']!));
      // a failure path: a conflicting write from a second device of the owner
      const oc2 = await signIn(env, owner, 'leak-owner-device-2');
      await oc2.session.updateItem(ids[1]!, (p) => {
        if (p.type === 'ssh_connection') p.fields.port = 2222;
      });
      await s.updateItem(ids[1]!, (p) => {
        if (p.type === 'ssh_connection') p.fields.port = 2200;
      });
      await Promise.allSettled([oc2.session.syncNow(), s.syncNow()]);

      await t.check('leak.flow-exercised', 'The canary flows actually ran (items created, edited, shared, decrypted by the recipient)', () => ({
        ok: peerSees && s.getSnapshot().items.length >= 7,
        evidence: `${s.getSnapshot().items.length} items for the owner; recipient decrypted the shared canary note: ${peerSees}`,
      }), { severity: 'high' });

      const all = { ...C, ...masterSecrets };
      const wire = traffic.map((x) => `${x.method} ${x.url}\n${JSON.stringify(x.requestHeaders)}\n${x.requestBody}\n${x.status}\n${JSON.stringify(x.responseHeaders)}\n${x.responseBody}`).join('\n');
      await t.check('leak.traffic', 'No item plaintext, master password or recovery key appears in any API request or response (plain or encoded)', () => {
        const hits = findCanaries(wire, all);
        return { ok: hits.length === 0, evidence: `${traffic.length} exchanges scanned for ${Object.keys(all).length} secrets × 7 encodings; hits: ${hits.join(', ') || 'none'}` };
      }, { severity: 'critical' });

      if (requireDisposable(ctx, t, 'leak.database', 'Database contains no plaintext secrets') && env.stack) {
        await t.check('leak.database', 'A full database dump contains no item plaintext, master passwords, auth keys, TOTP secrets, recovery codes or session tokens', () => {
          const dump = env.stack!.pgDump();
          const extra: Record<string, string> = {
            'owner.authKey': owner.authKey,
            'owner.totpSecret': owner.totpSecret,
            'owner.recoveryCode': owner.recoveryCodes[0]!,
            'owner.sessionToken': owner.token,
            'owner.recoveryAuthKey': owner.material.keys.recoveryAuthKey,
          };
          const hits = findCanaries(dump, { ...all, ...extra });
          return { ok: hits.length === 0, evidence: `pg_dump ${(dump.length / 1024).toFixed(0)} KiB scanned; hits: ${hits.join(', ') || 'none'}` };
        }, { severity: 'critical' });

        await t.check('leak.server-logs', 'API logs at debug level contain no secrets, credentials, tokens, codes or item data', () => {
          const logs = env.stack!.apiLogs();
          const extra: Record<string, string> = {
            'owner.authKey': owner.authKey,
            'owner.totpSecret': owner.totpSecret,
            'owner.recoveryCode': owner.recoveryCodes[1]!,
            'owner.sessionToken': owner.token,
            'peer.sessionToken': peer.token,
            'client.sessionToken': oc.token() ?? 'none-none-none',
          };
          const hits = findCanaries(logs, { ...all, ...extra });
          return { ok: hits.length === 0, evidence: `${logs.split('\n').length} log lines (LOG_LEVEL=debug) scanned; hits: ${hits.join(', ') || 'none'}` };
        }, { severity: 'critical' });

        await t.check('leak.mail', 'Emails carry only the intended codes/links, never item data or passwords', async () => {
          const mail = await allMailText(env.mailpit);
          const hits = findCanaries(mail, all);
          return { ok: hits.length === 0, evidence: `${(mail.length / 1024).toFixed(0)} KiB of mail scanned; hits: ${hits.join(', ') || 'none'}` };
        }, { severity: 'high' });
      }

      await t.check('leak.client-cache', "The client's persistent cache holds only ciphertext (no item plaintext, no master password)", async () => {
        const dump = (await dumpClientStorage(oc)) + (await dumpClientStorage(pc));
        const hits = findCanaries(dump, all);
        return { ok: hits.length === 0, evidence: `owner + recipient cache stores scanned (${(dump.length / 1024).toFixed(0)} KiB); hits: ${hits.join(', ') || 'none'}` };
      }, { severity: 'critical' });

      // ---------------------------------------------------------------- web browser storage
      const webOut = join(WORK, 'web-dist');
      if (!existsSync(join(webOut, 'index.html'))) {
        t.unverified('leak.web-storage', 'Web app browser storage holds no plaintext', 'web build not available (run the web suite first in the same run)');
      } else {
        const preview = spawn('npx', ['vite', 'preview', '--outDir', webOut, '--host', '127.0.0.1', '--port', '4317', '--strictPort'], { cwd: join(ROOT, 'apps/web'), stdio: 'ignore' });
        try {
          for (let i = 0; i < 60; i++) {
            try {
              if ((await fetch('http://127.0.0.1:4317/')).ok) break;
            } catch {
              /* starting */
            }
            await sleep(250);
          }
          await t.check('leak.web-storage', 'After sign-in, browsing and locking, web localStorage/sessionStorage/IndexedDB/cookies hold no plaintext', async () => {
            const browser = await chromium.launch();
            const page = await browser.newPage();
            try {
              await page.goto('http://127.0.0.1:4317/');
              await page.getByLabel('Email', { exact: true }).fill(owner.email);
              await page.getByLabel('Master password', { exact: true }).fill(owner.password);
              await page.getByRole('button', { name: 'Sign in', exact: true }).click();
              await page.getByLabel('Authentication code', { exact: true }).fill(await freshTotp(owner.totpSecret));
              await page.getByRole('button', { name: 'Verify', exact: true }).click();
              await page.getByRole('complementary', { name: 'Main navigation' }).waitFor({ timeout: 20_000 });
              await page.getByRole('complementary', { name: 'Main navigation' }).getByRole('button', { name: /^All items/ }).click();
              await page.getByRole('listbox', { name: 'Items' }).getByRole('option').first().waitFor({ timeout: 20_000 });
              const options = page.getByRole('listbox', { name: 'Items' }).getByRole('option');
              for (let i = 0; i < Math.min(await options.count(), 8); i++) {
                await options.nth(i).click();
                await sleep(300);
              }
              const unlocked = await page.evaluate(storageDump);
              await page.getByRole('button', { name: /Lock vault/ }).first().click().catch(() => undefined);
              await sleep(800);
              const locked = await page.evaluate(storageDump);
              const cookies = JSON.stringify(await page.context().cookies());
              const hitsU = findCanaries(unlocked, all);
              const hitsL = findCanaries(locked + cookies, all);
              // Guard against a vacuous pass: the dump must contain the session and the encrypted cache.
              const meaningful = unlocked.includes('pv-session=') && /\/records=\[\{/.test(unlocked);
              return {
                ok: meaningful && !hitsU.length && !hitsL.length,
                evidence: `storage while unlocked: ${unlocked.length} bytes (session token present: ${unlocked.includes('pv-session=')}, encrypted records present: ${/\/records=\[\{/.test(unlocked)}) → canary hits: ${hitsU.join(', ') || 'none'}; after lock: ${locked.length} bytes → ${hitsL.join(', ') || 'none'}`,
              };
            } finally {
              await browser.close();
            }
          }, { severity: 'critical' });
        } finally {
          preview.kill();
        }
      }
      for (const c of [oc, oc2, pc]) c.session.lock();
    } finally {
      globalThis.fetch = realFetch;
    }
  },
};

/** Runs in the page: every value in localStorage, sessionStorage and all IndexedDB databases. */
async function storageDump(): Promise<string> {
  const out: string[] = [];
  for (const st of [localStorage, sessionStorage]) for (let i = 0; i < st.length; i++) out.push(`${st.key(i)}=${st.getItem(st.key(i)!)}`);
  const dbs = (await indexedDB.databases?.()) ?? [];
  for (const d of dbs) {
    if (!d.name) continue;
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(d.name!);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    for (const name of Array.from(db.objectStoreNames)) {
      const rows = await new Promise<unknown[]>((res, rej) => {
        const r = db.transaction(name, 'readonly').objectStore(name).getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      out.push(`${d.name}/${name}=${JSON.stringify(rows)}`);
    }
    db.close();
  }
  return out.join('\n');
}

export default suite;
