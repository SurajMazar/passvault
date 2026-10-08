import { describe, expect, it } from 'vitest';
import { buildConnection, buildExternalParams, buildHop, formatHostPort, HopBuildError, trustedKeysFor, type SshConnectionItem } from '../src/ssh/hops';
import { server, sshKey, trusted } from './items';

describe('hop building', () => {
  it('formats host:port like net.JoinHostPort', () => {
    expect(formatHostPort('example.com', 22)).toBe('example.com:22');
    expect(formatHostPort('2001:db8::1', 2222)).toBe('[2001:db8::1]:2222');
  });

  it('password auth carries the stored password; keys filtered by host:port', () => {
    const s = server({ host: 'a.example.com', port: 2222, hostKeys: [trusted('a.example.com:2222'), trusted('a.example.com:22', 'OTHERKEY'), trusted('b.example.com:2222', 'BKEY')] }) as SshConnectionItem;
    const hop = buildHop(s, [s]);
    expect(hop).toMatchObject({ host: 'a.example.com', port: 2222, username: 'deploy', auth: { method: 'password', password: 'S3cret-pw' } });
    expect(hop.trustedHostKeys).toEqual([{ keyType: 'ssh-ed25519', publicKey: trusted('x').publicKey }]);
  });

  it('IPv6 keys match the bracketed host:port', () => {
    const s = server({ host: '2001:db8::1', hostKeys: [trusted('[2001:db8::1]:22')] }) as SshConnectionItem;
    expect(trustedKeysFor(s)).toHaveLength(1);
  });

  it('key auth resolves the ssh_key item (private key + passphrase)', () => {
    const k = sshKey();
    const s = server({ host: 'h', authMethod: 'key', sshKeyItemId: k.id }) as SshConnectionItem;
    const hop = buildHop(s, [s, k]);
    expect(hop.auth).toEqual({ method: 'key', privateKey: expect.stringContaining('PRIVATE'), passphrase: 'pass-phrase' });
    expect(hop.auth.password).toBeUndefined();
  });

  it('missing or unshared key item is a clear error', () => {
    const s = server({ host: 'h', authMethod: 'key', sshKeyItemId: 'missing' }) as SshConnectionItem;
    expect(() => buildHop(s, [s])).toThrow(HopBuildError);
    const s2 = server({ host: 'h', authMethod: 'key' }) as SshConnectionItem;
    expect(() => buildHop(s2, [s2])).toThrow(/no key is selected/);
  });

  it('keyboard-interactive and agent never include the stored password', () => {
    const kbd = server({ host: 'h', authMethod: 'keyboard_interactive' }) as SshConnectionItem;
    expect(buildHop(kbd, [kbd]).auth).toEqual({ method: 'keyboard_interactive' });
    const ag = server({ host: 'h', authMethod: 'agent' }) as SshConnectionItem;
    expect(buildHop(ag, [ag]).auth).toEqual({ method: 'agent' });
  });

  it('resolves the jump host item with its own credentials and keys', () => {
    const k = sshKey();
    const jump = server({ host: 'bastion.example.com', username: 'jumper', authMethod: 'key', sshKeyItemId: k.id, hostKeys: [trusted('bastion.example.com:22', 'JUMPKEY')] });
    const target = server({ host: '10.0.0.5', jumpHostItemId: jump.id, hostKeys: [trusted('10.0.0.5:22')] }) as SshConnectionItem;
    const c = buildConnection(target, [target, jump, k]);
    expect(c.jumpItem?.id).toBe(jump.id);
    expect(c.jump).toMatchObject({ host: 'bastion.example.com', username: 'jumper', auth: { method: 'key' }, trustedHostKeys: [{ publicKey: 'JUMPKEY' }] });
    expect(c.target.trustedHostKeys).toHaveLength(1);
  });

  it('refuses a self-referencing or missing jump host', () => {
    const t = server({ host: 'h' });
    (t.payload as { fields: { jumpHostItemId?: string } }).fields.jumpHostItemId = t.id;
    expect(() => buildConnection(t as SshConnectionItem, [t])).toThrow(/itself/);
    const t2 = server({ host: 'h', jumpHostItemId: 'nope' }) as SshConnectionItem;
    expect(() => buildConnection(t2, [t2])).toThrow(/missing/);
  });

  it('session-only trust is included for the item it belongs to', () => {
    const s = server({ host: 'h' }) as SshConnectionItem;
    expect(trustedKeysFor(s, new Map([[s.id, [trusted('h:22')]]]))).toHaveLength(1);
    expect(trustedKeysFor(s, new Map([['other', [trusted('h:22')]]]))).toHaveLength(0);
  });
});

describe('external terminal params', () => {
  it('never contain passwords, private keys or passphrases', () => {
    const k = sshKey();
    const jump = server({ host: 'bastion', authMethod: 'password', password: 'JumpSecret!', hostKeys: [trusted('bastion:22', 'J')] });
    const t = server({ host: 'target', authMethod: 'key', sshKeyItemId: k.id, jumpHostItemId: jump.id, hostKeys: [trusted('target:22')] }) as SshConnectionItem;
    const { params, missingTrust } = buildExternalParams(t, [t, jump, k], { app: 'terminal', agentRunning: true });
    const json = JSON.stringify(params);
    for (const secret of ['S3cret-pw', 'JumpSecret!', 'PRIVATE', 'pass-phrase']) expect(json).not.toContain(secret);
    expect(Object.keys(params.target).sort()).toEqual(['host', 'port', 'username']);
    expect(params.jump).toEqual({ host: 'bastion', port: 22, username: 'deploy' });
    expect(params.trustedHostKeys).toHaveLength(1);
    expect(params.jumpTrustedHostKeys).toEqual([{ keyType: 'ssh-ed25519', publicKey: 'J' }]);
    expect(params.useAgent).toBe(true);
    expect(missingTrust).toEqual([]);
  });

  it('useAgent only when the agent runs and a hop uses keys; reports hops without trust', () => {
    const t = server({ host: 'pw-only' }) as SshConnectionItem;
    expect(buildExternalParams(t, [t], { app: 'iterm', agentRunning: true }).params.useAgent).toBe(false);
    const k = server({ host: 'k', authMethod: 'agent' }) as SshConnectionItem;
    expect(buildExternalParams(k, [k], { app: 'iterm', agentRunning: false }).params.useAgent).toBe(false);
    expect(buildExternalParams(k, [k], { app: 'iterm', agentRunning: true }).missingTrust).toEqual(['target']);
  });
});
