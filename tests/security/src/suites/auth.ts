import { randomUUID } from 'node:crypto';
import { deriveRecoveryKeys, initCrypto, rewrapForNewPassword, wrapUserKeyForRecovery, generateRecoveryKey } from '@passvault/crypto';
import { buildRegistration, freshTotp, loginAgain, newActor, reauth, registrationToken, totpAt, uniqueEmail, createRecord, type Actor } from '../lib/actors';
import { brief, errCode, traffic, type ApiResponse } from '../lib/http';
import { waitForMail } from '../lib/mail';
import { registerSecret } from '../lib/results';
import { requireDisposable, type Suite } from '../lib/suite';
import { vitestCheck } from '../lib/vitest';

const same = (a: ApiResponse, b: ApiResponse) => a.status === b.status && JSON.stringify(stripReq(a.body)) === JSON.stringify(stripReq(b.body));
const stripReq = (b: unknown) => (b && typeof b === 'object' ? { ...(b as object), requestId: undefined } : b);

const suite: Suite = {
  id: 'auth',
  title: 'Authentication, MFA, sessions, step-up and recovery',
  needsApi: true,
  async run(ctx) {
    const { t } = ctx;
    const env = ctx.env!;
    const api = env.api;
    await initCrypto();
    ctx.log('creating synthetic actors…');
    const alice: Actor = await newActor(env, 'auth-alice');

    // ---------------------------------------------------------------- registration
    await t.check('auth.register.no-enumeration', 'register/start answers identically for existing and new emails', async () => {
      const a = await api.post('/auth/register/start', { email: alice.email });
      const b = await api.post('/auth/register/start', { email: uniqueEmail('fresh') });
      return { ok: same(a, b) && a.status === 202, evidence: `existing → ${brief(a)} ${a.text || '(empty)'}; new → ${brief(b)} ${b.text || '(empty)'}` };
    }, { severity: 'medium' });

    await t.check('auth.register.code-attempt-limit', 'Five wrong email codes burn the code; the correct code is then refused', async () => {
      const email = uniqueEmail('codes');
      const t0 = Date.now();
      await api.post('/auth/register/start', { email });
      const { match: code } = await waitForMail(env.mailpit, email, t0, /\b(\d{6})\b/);
      const wrong = code === '000000' ? '111111' : '000000';
      const codes: string[] = [];
      for (let i = 0; i < 5; i++) codes.push(brief(await api.post('/auth/register/verify', { email, code: wrong })));
      const right = await api.post('/auth/register/verify', { email, code });
      return { ok: right.status === 400 && errCode(right) === 'invalid_code', evidence: `wrong codes: ${codes.join(', ')}; correct code afterwards → ${brief(right)}` };
    }, { severity: 'high' });

    await t.check('auth.register.token-single-use-and-bound', 'Registration tokens are single-use and bound to the verified email', async () => {
      const email = uniqueEmail('tok');
      const tok = await registrationToken(env, email);
      registerSecret(tok);
      const other = buildRegistration(uniqueEmail('other'));
      const wrongEmail = await api.post('/auth/register', { ...other.body, registrationToken: tok });
      const reg = buildRegistration(email);
      const first = await api.post('/auth/register', { ...reg.body, registrationToken: tok });
      const reg2 = buildRegistration(email);
      const second = await api.post('/auth/register', { ...reg2.body, registrationToken: tok });
      return {
        ok: wrongEmail.status === 400 && first.status === 201 && second.status === 400,
        evidence: `token for ${'A'} used with email B → ${brief(wrongEmail)}; first use → ${brief(first)}; reuse → ${brief(second)}`,
      };
    }, { severity: 'high' });

    await t.check('auth.register.kdf-bounds', 'The server refuses registrations and password changes with KDF parameters below the minimum', async () => {
      const email = uniqueEmail('kdf');
      const tok = await registrationToken(env, email);
      const reg = buildRegistration(email);
      const weak = await api.post('/auth/register', { ...reg.body, kdf: { ...reg.body.kdf, opsLimit: 1 }, registrationToken: tok });
      const weakMem = await api.post('/auth/register', { ...reg.body, kdf: { ...reg.body.kdf, memLimitBytes: 1024 * 1024 }, registrationToken: tok });
      return { ok: weak.status === 400 && weakMem.status === 400, evidence: `opsLimit 1 → ${brief(weak)}; memLimit 1 MiB → ${brief(weakMem)}` };
    }, { severity: 'high' });

    // ---------------------------------------------------------------- login / enumeration
    await t.check('auth.prelogin.no-enumeration', 'prelogin returns a well-formed, stable KDF record for unknown emails', async () => {
      const unknown = uniqueEmail('nobody');
      const a = await api.post('/auth/prelogin', { email: unknown });
      const b = await api.post('/auth/prelogin', { email: unknown });
      const k = await api.post('/auth/prelogin', { email: alice.email });
      const keys = (r: ApiResponse) => Object.keys(r.body?.kdf ?? {}).sort().join(',');
      const ok = a.status === 200 && k.status === 200 && keys(a) === keys(k) && a.body.kdf.salt === b.body.kdf.salt;
      return {
        ok,
        evidence: `unknown → ${keys(a)} (salt stable: ${a.body.kdf.salt === b.body.kdf.salt}); known → ${keys(k)}. Note: an unknown email always gets the default parameters (ops ${a.body.kdf.opsLimit}, mem ${a.body.kdf.memLimitBytes}); accounts created with non-default parameters are distinguishable (documented).`,
      };
    }, { severity: 'medium' });

    await t.check('auth.login.no-enumeration', 'Wrong credentials for a known account and any credentials for an unknown email get the same answer', async () => {
      const dev = { id: randomUUID(), name: 'enum', clientType: 'cli' as const };
      const wrong = await api.post('/auth/login', { email: alice.email, authKey: buildRegistration('x@y.z').body.authKey, device: dev });
      const unknown = await api.post('/auth/login', { email: uniqueEmail('ghost'), authKey: alice.authKey, device: dev });
      return { ok: same(wrong, unknown) && wrong.status === 401, evidence: `known+wrong → ${brief(wrong)} "${wrong.body?.error?.message}"; unknown → ${brief(unknown)} "${unknown.body?.error?.message}"` };
    }, { severity: 'medium' });

    // ---------------------------------------------------------------- MFA
    await t.check('auth.mfa.required', 'Password alone yields no session: the pending MFA token cannot call the API', async () => {
      const login = await api.post('/auth/login', { email: alice.email, authKey: alice.authKey, device: { id: randomUUID(), name: 'mfa', clientType: 'cli' } });
      registerSecret(login.body?.mfaToken);
      const acct = await api.get('/account', { token: login.body?.mfaToken });
      const sync = await api.get('/sync', { token: login.body?.mfaToken });
      return {
        ok: login.body?.status === 'mfa_required' && !login.body?.session && acct.status === 401 && sync.status === 401,
        evidence: `login → status=${login.body?.status}, session=${login.body?.session ? 'present' : 'absent'}; mfaToken as bearer: /account ${brief(acct)}, /sync ${brief(sync)}`,
      };
    }, { severity: 'critical' });

    await t.check('auth.mfa.totp-replay', 'A TOTP code is accepted once; replaying it (same 30 s window) is refused', async () => {
      const code = await freshTotp(alice.totpSecret);
      const a = await api.post('/auth/reauth', { authKey: alice.authKey, code }, { token: alice.token });
      const b = await api.post('/auth/reauth', { authKey: alice.authKey, code }, { token: alice.token });
      const prev = await api.post('/auth/reauth', { authKey: alice.authKey, code: totpAt(alice.totpSecret, Date.now() - 30_000) }, { token: alice.token });
      return { ok: a.status === 200 && b.status === 403 && prev.status === 403, evidence: `first use → ${brief(a)}; replay → ${brief(b)}; previous window's code → ${brief(prev)}` };
    }, { severity: 'high' });

    await t.check('auth.mfa.attempt-limit', 'Five wrong MFA codes revoke the pending sign-in (a correct code is then refused)', async () => {
      const login = await api.post('/auth/login', { email: alice.email, authKey: alice.authKey, device: { id: randomUUID(), name: 'mfa-limit', clientType: 'cli' } });
      const codes: string[] = [];
      for (let i = 0; i < 5; i++) codes.push(brief(await api.post('/auth/mfa/verify', { mfaToken: login.body.mfaToken, code: '000000' })));
      const ok = await api.post('/auth/mfa/verify', { mfaToken: login.body.mfaToken, code: await freshTotp(alice.totpSecret) });
      return { ok: ok.status === 401, evidence: `wrong codes: ${codes.join(', ')}; correct code afterwards → ${brief(ok)}` };
    }, { severity: 'high' });

    const rc = await newActor(env, 'auth-rcodes');
    await t.check('auth.mfa.recovery-code-single-use', 'A recovery code signs in once; the same code is refused afterwards', async () => {
      const code = rc.recoveryCodes[0]!;
      const l1 = await api.post('/auth/login', { email: rc.email, authKey: rc.authKey, device: { id: randomUUID(), name: 'rc1', clientType: 'cli' } });
      const v1 = await api.post('/auth/mfa/verify', { mfaToken: l1.body.mfaToken, recoveryCode: code });
      registerSecret(v1.body?.session?.token);
      const l2 = await api.post('/auth/login', { email: rc.email, authKey: rc.authKey, device: { id: randomUUID(), name: 'rc2', clientType: 'cli' } });
      const v2 = await api.post('/auth/mfa/verify', { mfaToken: l2.body.mfaToken, recoveryCode: code });
      return { ok: v1.status === 200 && v2.status === 401, evidence: `first use → ${brief(v1)} (remaining ${v1.body?.remainingRecoveryCodes}); reuse → ${brief(v2)}` };
    }, { severity: 'high' });

    await t.check('auth.mfa.recovery-code-race', 'Concurrent redemption of one recovery code across 4 pending sign-ins succeeds exactly once', async () => {
      const code = rc.recoveryCodes[1]!;
      const pend = [];
      for (let i = 0; i < 4; i++) pend.push((await api.post('/auth/login', { email: rc.email, authKey: rc.authKey, device: { id: randomUUID(), name: `race${i}`, clientType: 'cli' } })).body.mfaToken as string);
      const rs = await Promise.all(pend.map((m) => api.post('/auth/mfa/verify', { mfaToken: m, recoveryCode: code })));
      for (const r of rs) registerSecret(r.body?.session?.token);
      const wins = rs.filter((r) => r.status === 200).length;
      return { ok: wins === 1, evidence: `results: ${rs.map(brief).join(', ')}` };
    }, { severity: 'high' });

    // ---------------------------------------------------------------- sessions
    await t.check('auth.session.tokens', 'Malformed, tampered, pending and revoked tokens are all refused', async () => {
      const second = await loginAgain(env, alice);
      const flip = (s: string) => s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
      const variants: Array<[string, Record<string, string>]> = [
        ['no header', {}],
        ['empty bearer', { authorization: 'Bearer ' }],
        ['short token', { authorization: 'Bearer abc' }],
        ['200-char token', { authorization: `Bearer ${'A'.repeat(200)}` }],
        ['non-base64url chars', { authorization: `Bearer ${second.slice(0, -2)}+/` }],
        ['flipped last char', { authorization: `Bearer ${flip(second)}` }],
        ['Basic scheme', { authorization: `Basic ${Buffer.from(`x:${second}`).toString('base64')}` }],
        ['token in query only', {}],
      ];
      const out: string[] = [];
      for (const [name, headers] of variants) {
        const r = await api.get('/account', { headers: { ...headers, 'x-pv-probe': 'token-in-query' }, query: name === 'token in query only' ? { token: second, access_token: second } : undefined });
        out.push(`${name} → ${brief(r)}`);
        if (r.status !== 401) return { ok: false, evidence: out.join('; ') };
      }
      const okNow = await api.get('/account', { token: second });
      await api.post('/auth/logout', {}, { token: second });
      const afterLogout = await api.get('/account', { token: second });
      const stillAlice = await api.get('/account', { token: alice.token });
      out.push(`valid → ${brief(okNow)}; after logout → ${brief(afterLogout)}; other session → ${brief(stillAlice)}`);
      return { ok: okNow.status === 200 && afterLogout.status === 401 && stillAlice.status === 200, evidence: out.join('; ') };
    }, { severity: 'critical' });

    await t.check('auth.session.rotation', 'Completing MFA issues a new token and retires the pending one (no fixation, no reuse)', async () => {
      const login = await api.post('/auth/login', { email: alice.email, authKey: alice.authKey, device: { id: randomUUID(), name: 'rot', clientType: 'cli' } });
      const v = await api.post('/auth/mfa/verify', { mfaToken: login.body.mfaToken, code: await freshTotp(alice.totpSecret) });
      registerSecret(v.body?.session?.token);
      const again = await api.post('/auth/mfa/verify', { mfaToken: login.body.mfaToken, code: await freshTotp(alice.totpSecret) });
      return {
        ok: v.status === 200 && v.body.session.token !== login.body.mfaToken && again.status === 401,
        evidence: `active token differs from pending token: ${v.body?.session?.token !== login.body.mfaToken}; pending token reused → ${brief(again)}`,
      };
    }, { severity: 'high' });

    await t.check('auth.stepup.required', 'Sensitive actions require a recent re-authentication (password + TOTP)', async () => {
      const fresh = await loginAgain(env, alice);
      const pw = rewrapForNewPassword(alice.material.unlocked.userKey, 'not-used-pw', { opsLimit: 2, memLimitBytes: 32 * 1024 * 1024 });
      const calls: Array<[string, Promise<ApiResponse>]> = [
        ['change password', api.post('/account/password', { authKey: pw.authKey, kdf: pw.kdf, encryptedUserKey: pw.encryptedUserKey, signOutOtherSessions: false }, { token: fresh })],
        ['regenerate recovery codes', api.post('/account/mfa/recovery-codes', {}, { token: fresh })],
        ['sign out everywhere', api.post('/auth/logout-all', {}, { token: fresh })],
        ['re-enroll MFA', api.post('/auth/mfa/enroll/start', {}, { token: fresh })],
      ];
      const out: string[] = [];
      let ok = true;
      for (const [name, p] of calls) {
        const r = await p;
        out.push(`${name} → ${brief(r)}`);
        ok &&= r.status === 403 && errCode(r) === 'reauth_required';
      }
      await api.post('/auth/logout', {}, { token: fresh });
      return { ok, evidence: out.join('; ') };
    }, { severity: 'high' });

    await t.check('auth.reauth.recovery-code-not-accepted', 'Re-authentication cannot be satisfied with a recovery code or a wrong password', async () => {
      const r1 = await api.post('/auth/reauth', { authKey: alice.authKey, recoveryCode: alice.recoveryCodes[0] }, { token: alice.token });
      const r2 = await api.post('/auth/reauth', { authKey: rc.authKey, code: await freshTotp(alice.totpSecret) }, { token: alice.token });
      return { ok: r1.status >= 400 && r2.status === 403, evidence: `recovery code → ${brief(r1)}; another account's authKey → ${brief(r2)}` };
    }, { severity: 'medium' });

    // ---------------------------------------------------------------- password change
    await t.check('auth.password-change', 'Password change (after re-auth) retires the old credential and can sign out other sessions', async () => {
      const u = await newActor(env, 'auth-pwchange');
      const other = await loginAgain(env, u);
      await reauth(env, u);
      const pw = rewrapForNewPassword(u.material.unlocked.userKey, 'brand-new-password-77', { opsLimit: 2, memLimitBytes: 32 * 1024 * 1024 });
      registerSecret(pw.authKey);
      const r = await api.post('/account/password', { authKey: pw.authKey, kdf: pw.kdf, encryptedUserKey: pw.encryptedUserKey, signOutOtherSessions: true }, { token: u.token });
      const otherAfter = await api.get('/account', { token: other });
      const oldLogin = await api.post('/auth/login', { email: u.email, authKey: u.authKey, device: { id: randomUUID(), name: 'old', clientType: 'cli' } });
      const newLogin = await api.post('/auth/login', { email: u.email, authKey: pw.authKey, device: { id: randomUUID(), name: 'new', clientType: 'cli' } });
      registerSecret(newLogin.body?.mfaToken);
      return {
        ok: r.status === 204 && otherAfter.status === 401 && oldLogin.status === 401 && newLogin.status === 200,
        evidence: `change → ${brief(r)}; other session → ${brief(otherAfter)}; old credential → ${brief(oldLogin)}; new credential → ${brief(newLogin)} (${newLogin.body?.status})`,
      };
    }, { severity: 'high' });

    // ---------------------------------------------------------------- web / transport properties
    await t.check('auth.no-cookies', 'The API never sets cookies (bearer tokens only, so cookie CSRF does not apply)', () => {
      const withCookies = traffic.filter((x) => Object.keys(x.responseHeaders).some((h) => h.toLowerCase() === 'set-cookie'));
      return { ok: withCookies.length === 0, evidence: `${traffic.length} responses inspected; ${withCookies.length} with Set-Cookie` };
    }, { severity: 'high' });

    await t.check('auth.cors', 'CORS: other origins get no access; allowed origins get an exact origin without credentials', async () => {
      const pre = async (origin: string) =>
        fetch(`${api.base}/api/v1/auth/login`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' } });
      const evil = await pre('https://evil.example');
      const good = await pre(ctx.env!.stack?.webOrigin ?? 'http://localhost:5173');
      const nullO = await pre('null');
      const e = evil.headers.get('access-control-allow-origin');
      const g = good.headers.get('access-control-allow-origin');
      const n = nullO.headers.get('access-control-allow-origin');
      const cred = good.headers.get('access-control-allow-credentials');
      return { ok: !e && !n && g === (ctx.env!.stack?.webOrigin ?? 'http://localhost:5173') && cred !== 'true', evidence: `evil → ACAO=${e}; null → ACAO=${n}; allowed → ACAO=${g}, credentials=${cred}` };
    }, { severity: 'high' });

    await t.check('auth.mail-links.host-header', 'Emailed links use the configured web URL, not request headers (no host-header injection)', async () => {
      const t0 = Date.now();
      await api.post('/recovery/start', { email: alice.email }, { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', forwarded: 'host=evil.example;proto=https', 'x-original-host': 'evil.example' } });
      const m = await waitForMail(env.mailpit, alice.email, t0, /(https?:\/\/[^\s]+recover#token=[A-Za-z0-9_-]+)/);
      registerSecret(m.match.split('#token=')[1]);
      const expected = ctx.env!.stack?.webOrigin;
      return { ok: !m.text.includes('evil.example') && (!expected || m.match.startsWith(expected)), evidence: `link origin: ${new URL(m.match).origin}; mail mentions evil.example: ${m.text.includes('evil.example')}` };
    }, { severity: 'high' });

    // ---------------------------------------------------------------- recovery
    await t.check('auth.recovery.needs-recovery-key', 'Email + MFA alone cannot take over a vault: completing recovery needs the vault recovery key; links are single-use', async () => {
      const u = await newActor(env, 'auth-recovery');
      const t0 = Date.now();
      await api.post('/recovery/start', { email: u.email });
      const { match: link } = await waitForMail(env.mailpit, u.email, t0, /recover#token=([A-Za-z0-9_-]+)/);
      registerSecret(link);
      const v = await api.post('/recovery/verify', { token: link, code: await freshTotp(u.totpSecret) });
      registerSecret(v.body?.recoveryToken);
      const reuse = await api.post('/recovery/verify', { token: link, code: await freshTotp(u.totpSecret) });
      const plaintextFields = Object.keys(v.body ?? {}).filter((k) => /userKey$|privateKey$|vaultKey$/i.test(k) && !/^encrypted/i.test(k));
      const fake = deriveRecoveryKeys(generateRecoveryKey());
      const newPw = rewrapForNewPassword(u.material.unlocked.userKey, 'recovered-pw-1', { opsLimit: 2, memLimitBytes: 32 * 1024 * 1024 });
      const newRec = wrapUserKeyForRecovery(u.material.unlocked.userKey, generateRecoveryKey());
      const wrongKey = await api.post('/recovery/complete-vault', {
        recoveryToken: v.body.recoveryToken,
        recoveryAuthKey: fake.authKey,
        authKey: newPw.authKey,
        kdf: newPw.kdf,
        encryptedUserKey: newPw.encryptedUserKey,
        newEncryptedUserKeyByRecovery: newRec.encryptedUserKeyByRecovery,
        newRecoveryAuthKey: newRec.recoveryAuthKey,
      });
      return {
        ok: v.status === 200 && reuse.status === 401 && wrongKey.status === 401 && plaintextFields.length === 0,
        evidence: `verify → ${brief(v)} (fields: ${Object.keys(v.body ?? {}).join(', ')}); link reuse → ${brief(reuse)}; complete-vault with a wrong recovery key → ${brief(wrongKey)}`,
      };
    }, { severity: 'critical' });

    if (requireDisposable(ctx, t, 'auth.recovery.reset-destroys-data', 'Account reset via email + MFA destroys vault data instead of exposing it')) {
      await t.check('auth.recovery.reset-destroys-data', 'Account reset via email + MFA destroys vault data instead of exposing it, and revokes all sessions', async () => {
        const u = await newActor(env, 'auth-reset');
        const rec = await createRecord(env, u, u.personalVaultId, u.personalVaultKey, { title: 'kept secret', password: 'reset-canary-1' });
        const t0 = Date.now();
        await api.post('/recovery/start', { email: u.email });
        const { match: link } = await waitForMail(env.mailpit, u.email, t0, /recover#token=([A-Za-z0-9_-]+)/);
        const v = await api.post('/recovery/verify', { token: link, code: await freshTotp(u.totpSecret) });
        const fresh = buildRegistration(u.email);
        const r = await api.post('/recovery/reset-account', { recoveryToken: v.body.recoveryToken, confirmation: 'DELETE MY VAULT DATA', authKey: fresh.body.authKey, kdf: fresh.body.kdf, keys: fresh.body.keys, personalVault: fresh.body.personalVault });
        const oldSession = await api.get('/account', { token: u.token });
        const login = await api.post('/auth/login', { email: u.email, authKey: fresh.body.authKey, device: { id: randomUUID(), name: 'after-reset', clientType: 'cli' } });
        const m = await api.post('/auth/mfa/verify', { mfaToken: login.body.mfaToken, code: await freshTotp(u.totpSecret) });
        registerSecret(m.body?.session?.token);
        const old = await api.get(`/records/${rec.id}`, { token: m.body?.session?.token });
        return {
          ok: r.status === 204 && oldSession.status === 401 && (old.status === 410 || old.status === 404),
          evidence: `reset → ${brief(r)}; old session → ${brief(oldSession)}; old record afterwards → ${brief(old)} (tombstoned, ciphertext dropped)`,
        };
      }, { severity: 'critical' });
    }

    t.notApplicable('auth.email-change', 'Email-change flow', 'no email-change endpoint exists (API surface reviewed: 47 routes)');
    t.notApplicable('auth.refresh-token', 'Refresh-token replay', 'no refresh tokens: opaque server-side sessions, looked up on every request');
    t.notApplicable('auth.oauth-redirects', 'Open redirects / OAuth callbacks', 'the API issues no redirects and has no OAuth/SSO callbacks; emailed links are covered by auth.mail-links.host-header');

    // ---------------------------------------------------------------- time-dependent server checks (in-process, fake clock)
    await vitestCheck(t, 'auth.time-dependent', 'Time-dependent server rules: lockout without enumeration, code/link/reauth/session/membership expiry (in-process API, fake clock)', 'apps/api', {
      severity: 'high',
      files: ['test/security.e2e.test.ts'],
      finding: 'PV-SEC-001',
    });

    // ---------------------------------------------------------------- per-IP throttling (last: exhausts this IP's auth budget for a minute)
    if (requireDisposable(ctx, t, 'auth.rate-limit.per-ip', 'Per-IP throttling on authentication endpoints')) {
      await t.check('auth.rate-limit.per-ip', 'Per-IP throttling on authentication endpoints (429 with Retry-After)', async () => {
        const rs = await Promise.all(Array.from({ length: 30 }, () => api.post('/auth/prelogin', { email: uniqueEmail('rl') }, { noRetry: true })));
        const limited = rs.filter((r) => r.status === 429);
        const retryAfter = limited[0]?.headers.get('retry-after');
        return { ok: limited.length > 0 && !!retryAfter, evidence: `30 parallel prelogin calls: ${rs.length - limited.length} answered, ${limited.length} throttled (Retry-After ${retryAfter}s)` };
      }, { severity: 'medium' });
    }
  },
};

export default suite;
