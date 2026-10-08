import { describe, expect, it } from 'vitest';
import { isValidHost, isValidSshUsername, itemPayloadSchema, loginRequest, mfaVerifyRequest, createRecordRequest } from '../src/index';

describe('connection validators', () => {
  it('accepts hostnames and IPs', () => {
    for (const h of ['example.com', 'db-1.internal', 'localhost', '10.0.0.1', '::1', 'fe80::1', '2001:db8::8a2e:370:7334', 'a.b.c.']) {
      expect(isValidHost(h), h).toBe(true);
    }
  });
  it('rejects option injection and shell metacharacters', () => {
    for (const h of ['-oProxyCommand=evil', 'host;rm -rf /', 'a b', 'host$(id)', 'user@host', '', 'x'.repeat(300), '`id`', 'host\nX']) {
      expect(isValidHost(h), h).toBe(false);
    }
    for (const u of ['-l', 'root;id', 'a b', '$(id)', '']) {
      expect(isValidSshUsername(u), u).toBe(false);
    }
    expect(isValidSshUsername('deploy')).toBe(true);
    expect(isValidSshUsername('first.last@corp')).toBe(true);
  });
});

describe('API schemas', () => {
  it('rejects unknown keys (strict objects)', () => {
    const r = loginRequest.safeParse({
      email: 'a@b.co',
      authKey: 'A'.repeat(43),
      device: { id: '6b0a3a3e-7a59-4f39-9e4b-4e5c7a0f2f11', name: 'Mac', clientType: 'web' },
      password: 'plaintext!',
    });
    expect(r.success).toBe(false);
  });

  it('requires exactly one MFA factor', () => {
    expect(mfaVerifyRequest.safeParse({ mfaToken: 'abc', code: '123456' }).success).toBe(true);
    expect(mfaVerifyRequest.safeParse({ mfaToken: 'abc' }).success).toBe(false);
    expect(mfaVerifyRequest.safeParse({ mfaToken: 'abc', code: '123456', recoveryCode: 'AAAAA-AAAAA-AAAAA-AAAAA' }).success).toBe(false);
  });

  it('rejects non-base64url ciphertext', () => {
    const r = createRecordRequest.safeParse({
      id: '6b0a3a3e-7a59-4f39-9e4b-4e5c7a0f2f11',
      vaultId: '6b0a3a3e-7a59-4f39-9e4b-4e5c7a0f2f12',
      kind: 'item',
      formatVersion: 1,
      encryptedKey: 'abc',
      encryptedPayload: '{"title":"plaintext"}',
      mutationId: '6b0a3a3e-7a59-4f39-9e4b-4e5c7a0f2f13',
    });
    expect(r.success).toBe(false);
  });
});

describe('item payloads', () => {
  const base = {
    v: 1 as const,
    title: 'Prod DB',
    description: '',
    notes: '',
    folder: '',
    tags: [],
    favorite: false,
    archived: false,
    trashedAt: null,
    customFields: [],
  };
  it('does not require URLs for non-login items', () => {
    const r = itemPayloadSchema.safeParse({
      ...base,
      type: 'ssh_connection',
      fields: { host: 'db.example.com', port: 22, username: 'deploy', authMethod: 'key', hostKeys: [] },
    });
    expect(r.success).toBe(true);
  });
  it('rejects env filenames with paths', () => {
    const r = itemPayloadSchema.safeParse({ ...base, type: 'env_file', fields: { filename: '../.env', content: '', variableNotes: {} } });
    expect(r.success).toBe(false);
  });
});
