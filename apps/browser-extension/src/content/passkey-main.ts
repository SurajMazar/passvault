/**
 * Runs in the page's own JavaScript world (MAIN), at document start, in the top frame
 * of pages where the user turned on "Save and use passkeys". It wraps
 * navigator.credentials.create/get for publicKey (passkey) requests and hands them to
 * PassVault through the isolated bridge (passkey-bridge.ts). PassVault asks the user
 * in its own window; if they choose another device — or PassVault has nothing for
 * this site — the browser's original implementation runs instead.
 *
 * Nothing secret ever passes through here except the finished WebAuthn response the
 * site asked for. Self-contained: no imports (it is injected as a plain script).
 */
(() => {
  const creds = navigator.credentials;
  if (!creds || window.top !== window || (window as unknown as { __pvPasskeys?: boolean }).__pvPasskeys) return;
  (window as unknown as { __pvPasskeys?: boolean }).__pvPasskeys = true;

  const origCreate = creds.create.bind(creds);
  const origGet = creds.get.bind(creds);
  const REQ = 'pv-passkey-req';
  const RES = 'pv-passkey-res';

  const b64url = (buf: BufferSource) => {
    const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64url = (s: string) => {
    const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0)).buffer;
  };

  let seq = 0;
  const ask = (kind: 'create' | 'get', options: unknown, signal?: AbortSignal | null) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = `${Date.now()}-${++seq}-${Math.random().toString(36).slice(2)}`;
      const onMsg = (e: MessageEvent) => {
        const d = e.data as { type?: string; id?: string; result?: Record<string, unknown> } | null;
        if (e.source !== window || !d || d.type !== RES || d.id !== id) return;
        window.removeEventListener('message', onMsg);
        resolve(d.result ?? { fallback: true });
      };
      window.addEventListener('message', onMsg);
      signal?.addEventListener('abort', () => {
        window.removeEventListener('message', onMsg);
        window.postMessage({ type: REQ, id, kind: 'abort' }, location.origin);
        reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      });
      window.postMessage({ type: REQ, id, kind, options }, location.origin);
    });

  const defineAll = <T extends object>(obj: T, props: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(props)) Object.defineProperty(obj, k, { value: v, enumerable: true });
    return obj;
  };

  const attestationCredential = (r: Record<string, string>) => {
    const response = Object.create(AuthenticatorAttestationResponse.prototype) as AuthenticatorAttestationResponse;
    defineAll(response, {
      clientDataJSON: unb64url(r.clientDataJSON!),
      attestationObject: unb64url(r.attestationObject!),
      getTransports: () => ['internal', 'hybrid'],
      getAuthenticatorData: () => unb64url(r.authenticatorData!),
      getPublicKey: () => unb64url(r.publicKey!),
      getPublicKeyAlgorithm: () => -7,
      toJSON: () => ({
        clientDataJSON: r.clientDataJSON,
        attestationObject: r.attestationObject,
        authenticatorData: r.authenticatorData,
        publicKey: r.publicKey,
        publicKeyAlgorithm: -7,
        transports: ['internal', 'hybrid'],
      }),
    });
    return credential(r.credentialId!, response, () => (response as unknown as { toJSON(): unknown }).toJSON());
  };

  const assertionCredential = (r: Record<string, string>) => {
    const response = Object.create(AuthenticatorAssertionResponse.prototype) as AuthenticatorAssertionResponse;
    defineAll(response, {
      clientDataJSON: unb64url(r.clientDataJSON!),
      authenticatorData: unb64url(r.authenticatorData!),
      signature: unb64url(r.signature!),
      userHandle: r.userHandle ? unb64url(r.userHandle) : null,
      toJSON: () => ({ clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle || undefined }),
    });
    return credential(r.credentialId!, response, () => (response as unknown as { toJSON(): unknown }).toJSON());
  };

  const credential = (id: string, response: AuthenticatorResponse, responseJSON: () => unknown) => {
    const c = Object.create(PublicKeyCredential.prototype) as PublicKeyCredential;
    return defineAll(c, {
      id,
      rawId: unb64url(id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response,
      getClientExtensionResults: () => ({}),
      toJSON: () => ({ id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform', response: responseJSON(), clientExtensionResults: {} }),
    });
  };

  const failure = (r: Record<string, unknown>) => new DOMException(String(r.message || 'The operation is not allowed.'), String(r.error || 'NotAllowedError'));

  creds.create = async function (options?: CredentialCreationOptions) {
    const pk = options?.publicKey;
    if (!pk) return origCreate(options);
    const r = await ask(
      'create',
      {
        rp: { id: pk.rp.id, name: pk.rp.name },
        user: { id: b64url(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
        challenge: b64url(pk.challenge),
        pubKeyCredParams: (pk.pubKeyCredParams || []).map((p) => ({ type: p.type, alg: p.alg })),
        excludeCredentials: (pk.excludeCredentials || []).map((c) => b64url(c.id)),
      },
      options?.signal,
    );
    if (r.fallback) return origCreate(options);
    if (r.error) throw failure(r);
    return attestationCredential(r as Record<string, string>);
  };

  creds.get = async function (options?: CredentialRequestOptions) {
    const pk = options?.publicKey;
    // Conditional (autofill) requests stay with the browser; PassVault answers explicit ones.
    if (!pk || options?.mediation === 'conditional') return origGet(options);
    const r = await ask(
      'get',
      { rpId: pk.rpId, challenge: b64url(pk.challenge), allowCredentials: (pk.allowCredentials || []).map((c) => b64url(c.id)) },
      options?.signal,
    );
    if (r.fallback) return origGet(options);
    if (r.error) throw failure(r);
    return assertionCredential(r as Record<string, string>);
  };
})();
