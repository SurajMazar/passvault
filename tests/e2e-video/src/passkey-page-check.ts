/**
 * Real-browser check of the passkey page script (passkey-main.js from the built
 * extension): in Chromium, on a secure origin, navigator.credentials.create/get must
 * return objects a website accepts — instanceof PublicKeyCredential, working
 * response getters, toJSON() — built from PassVault's authenticator answers. The
 * extension background is stood in for by answering the bridge messages with real
 * registration/assertion data from src/background/webauthn.ts, and the assertion is
 * verified against the public key the page received.
 *
 *   PV_EXT_DIR=<built extension dir> pnpm --filter @passvault/e2e-video check:passkey-page
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createPasskey, signAssertion } from '../../../apps/browser-extension/src/background/webauthn';

const EXT = process.env.PV_EXT_DIR;
if (!EXT) throw new Error('Set PV_EXT_DIR to a built extension (dist) directory');
const mainScript = readFileSync(join(EXT, 'passkey-main.js'), 'utf8');

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const site = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>Passkey test</title><h1>Sign in</h1>');
});
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const ORIGIN = `http://localhost:${(site.address() as { port: number }).port}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  // PassVault's answers, computed by the real authenticator code for this origin.
  const reg = await createPasskey({ rpId: 'localhost', rpName: 'Test', origin: ORIGIN, challenge: 'Y2hhbGxlbmdlLTEyMzQ1Njc4', user: { id: 'dXNlci0x', name: 'alice', displayName: 'Alice' } });
  const asn = await signAssertion(reg.passkey, { origin: ORIGIN, challenge: 'bmV4dC1jaGFsbGVuZ2UtMTIz' });
  await page.addInitScript(mainScript);
  await page.addInitScript(
    ({ reg, asn }) => {
      // stand-in for passkey-bridge.js + the background: answer like PassVault would
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.type !== 'pv-passkey-req' || d.kind === 'abort') return;
        (window as unknown as { __pvLast: unknown }).__pvLast = d;
        const result = d.kind === 'create' ? reg : asn;
        window.postMessage({ type: 'pv-passkey-res', id: d.id, result }, location.origin);
      });
    },
    { reg: { credentialId: reg.credentialId, clientDataJSON: reg.clientDataJSON, attestationObject: reg.attestationObject, authenticatorData: reg.authenticatorData, publicKey: reg.publicKey }, asn },
  );
  await page.goto(`${ORIGIN}/`);

  const created = await page.evaluate(async () => {
    const c = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Test' },
        user: { id: new TextEncoder().encode('user-1'), name: 'alice', displayName: 'Alice' },
        challenge: new TextEncoder().encode('challenge-12345678'),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      },
    })) as PublicKeyCredential;
    const r = c.response as AuthenticatorAttestationResponse;
    const json = (c as unknown as { toJSON(): Record<string, unknown> }).toJSON();
    return {
      instance: c instanceof PublicKeyCredential,
      responseInstance: r instanceof AuthenticatorAttestationResponse,
      id: c.id,
      rawIdLen: c.rawId.byteLength,
      type: c.type,
      alg: r.getPublicKeyAlgorithm(),
      pubKeyLen: r.getPublicKey()?.byteLength ?? 0,
      transports: r.getTransports(),
      jsonKeys: Object.keys(json).sort().join(','),
      sentChallenge: ((window as unknown as { __pvLast: { options: { challenge: string } } }).__pvLast).options.challenge,
    };
  });
  check('create() returns a PublicKeyCredential', created.instance && created.responseInstance && created.type === 'public-key', JSON.stringify(created));
  check('credential id and raw id match the passkey', created.id === reg.credentialId && created.rawIdLen === 16);
  check('response exposes the ES256 public key', created.alg === -7 && created.pubKeyLen === 91);
  check('toJSON() works (used by many sites)', created.jsonKeys.includes('response') && created.jsonKeys.includes('rawId'));
  check('the challenge reached PassVault intact', created.sentChallenge === 'Y2hhbGxlbmdlLTEyMzQ1Njc4');

  // Plain JavaScript string: the TS runner's helpers do not exist inside the page.
  const signed = (await page.evaluate(`(async () => {
    const spkiB64 = ${JSON.stringify(reg.publicKey)};
    const c = await navigator.credentials.get({ publicKey: { challenge: new TextEncoder().encode('next-challenge-123'), rpId: 'localhost' } });
    const r = c.response;
    const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (x) => x.charCodeAt(0));
    const der = new Uint8Array(r.signature);
    let p = 2;
    const int = () => { const len = der[p + 1]; let v = der.slice(p + 2, p + 2 + len); p += 2 + len; while (v.length > 32) v = v.slice(1); const o = new Uint8Array(32); o.set(v, 32 - v.length); return o; };
    const raw = new Uint8Array(64); raw.set(int()); raw.set(int(), 32);
    const key = await crypto.subtle.importKey('spki', unb64(spkiB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', r.clientDataJSON));
    const data = new Uint8Array([...new Uint8Array(r.authenticatorData), ...hash]);
    return {
      instance: c instanceof PublicKeyCredential && r instanceof AuthenticatorAssertionResponse,
      verified: await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, data),
      userHandle: new TextDecoder().decode(r.userHandle),
      origin: JSON.parse(new TextDecoder().decode(r.clientDataJSON)).origin,
    };
  })()`)) as { instance: boolean; verified: boolean; userHandle: string; origin: string };
  check('get() returns a PublicKeyCredential assertion', signed.instance);
  check('the assertion signature verifies with the registered key', signed.verified);
  check('user handle and origin are the passkey’s', signed.userHandle === 'user-1' && signed.origin === ORIGIN, JSON.stringify(signed));

  const passthrough = (await page.evaluate(`navigator.credentials.get({ password: true }).then((c) => String(c), (e) => e.name)`)) as string;
  check('non-passkey credential requests still go to the browser', passthrough !== 'undefined');
} finally {
  await browser.close();
  site.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
