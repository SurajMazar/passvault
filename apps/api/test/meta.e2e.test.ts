/**
 * GET /meta (server description for clients choosing a server) and the
 * REGISTRATION_OPEN switch. Real app + real Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkServer } from '@passvault/vault-core/servers';
import { P, boot, buildRegistration, registerVerified, uniqueEmail, type Ctx } from './helpers';

describe('meta (registration open)', () => {
  let ctx: Ctx;
  let base: string;
  beforeAll(async () => {
    ctx = await boot();
    base = (await ctx.app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(() => ctx.close());

  it('describes the server without authentication, cookies or configuration', async () => {
    const r = await ctx.http.get(`${P}/meta`).expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.body).toEqual({
      service: 'passvault',
      version: expect.any(String),
      api: { current: 1, min: 1 },
      capabilities: expect.arrayContaining(['vault.e2ee.v1', 'sync.v1', 'auth.mfa.totp']),
      registration: 'open',
    });
  });

  it('a client check accepts it, sending no credentials', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const spy: typeof fetch = (input, init) => {
      seen.push({ url: String(input), init });
      return fetch(input, init);
    };
    const c = await checkServer(base, { allowLocalHttp: true, fetchImpl: spy });
    expect(c).toMatchObject({ ok: true, url: base, apiVersion: 1, registration: 'open', degraded: false });
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([`${P}/meta`, `${P}/health`]);
    for (const s of seen) {
      expect(s.init?.credentials).toBe('omit');
      expect(s.init?.redirect).toBe('error');
      expect(Object.keys((s.init?.headers as Record<string, string>) ?? {}).map((h) => h.toLowerCase())).not.toContain('authorization');
    }
  });

  it('a client check under a wrong path prefix explains how to fix the address', async () => {
    const c = await checkServer(`${base}/not-here`, { allowLocalHttp: true });
    expect(c).toMatchObject({ ok: false, code: 'not_passvault' });
  });
});

describe('meta (registration closed)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await boot({ REGISTRATION_OPEN: 'false' });
  });
  afterAll(() => ctx.close());

  it('reports closed registration and refuses sign-up at every step', async () => {
    expect((await ctx.http.get(`${P}/meta`).expect(200)).body.registration).toBe('closed');
    const s = await ctx.http.post(`${P}/auth/register/start`).send({ email: uniqueEmail('closed') }).expect(403);
    expect(s.body.error.code).toBe('registration_closed');
    const reg = buildRegistration(uniqueEmail('closed2'));
    const r = await ctx.http.post(`${P}/auth/register`).send({ ...reg.body, registrationToken: 'x'.repeat(43) }).expect(403);
    expect(r.body.error.code).toBe('registration_closed');
  });

  it('existing accounts are unaffected', async () => {
    // registerVerified uses register/start, so create the user on an open server first.
    const open = await boot();
    const u = await registerVerified(open, 'existing');
    await open.close();
    const r = await ctx.http.post(`${P}/auth/prelogin`).send({ email: u.email }).expect(200);
    expect(r.body.kdf).toEqual(u.material.kdf);
  });
});
