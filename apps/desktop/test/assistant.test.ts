import { describe, expect, it } from 'vitest';
import { newItem, type DecryptedItem } from '@passvault/vault-core';
import { findTargets, parseIntent, resolveOne } from '../src/ui/assistant';

describe('buddy command understanding', () => {
  it.each([
    ['copy github password', { kind: 'copy', field: 'password', query: 'github' }],
    ['password for github', { kind: 'copy', field: 'password', query: 'github' }],
    ['github pw', { kind: 'copy', field: 'password', query: 'github' }],
    ["what's my netflix password", { kind: 'copy', field: 'password', query: 'netflix' }],
    ['username for aws', { kind: 'copy', field: 'username', query: 'aws' }],
    ['copy aws user', { kind: 'copy', field: 'username', query: 'aws' }],
    ['email for linear', { kind: 'copy', field: 'username', query: 'linear' }],
    ['new password', { kind: 'generate', passphrase: false, length: 20 }],
    ['generate 32', { kind: 'generate', passphrase: false, length: 32 }],
    ['generate password 4', { kind: 'generate', passphrase: false, length: 8 }],
    ['passphrase', { kind: 'generate', passphrase: true, length: 5 }],
    ['new passphrase 7', { kind: 'generate', passphrase: true, length: 7 }],
    ['ssh prod', { kind: 'connect', query: 'prod' }],
    ['connect to web-1', { kind: 'connect', query: 'web-1' }],
    ['save login for netflix.com', { kind: 'save', site: 'netflix.com' }],
    ['save', { kind: 'save', site: '' }],
    ['lock', { kind: 'lock' }],
    ['Settings', { kind: 'settings' }],
    ['help', { kind: 'help' }],
    ['', { kind: 'help' }],
    ['open github', { kind: 'open', query: 'github' }],
    ['staging db', { kind: 'search', query: 'staging db' }],
  ])('%s', (text, want) => {
    expect(parseIntent(text)).toEqual(want);
  });
});

describe('finding what the user means', () => {
  const item = (id: string, payload: DecryptedItem['payload']): DecryptedItem => ({ id, payload, role: 'owner' }) as unknown as DecryptedItem;
  const items = [
    item('1', newItem('login', { title: 'GitHub', fields: { username: 'ann', password: 'x', urls: [{ url: 'https://github.com', match: 'host' }] } })),
    item('2', newItem('login', { title: 'GitHub (work)', fields: { username: 'ann-work', password: 'y', urls: [{ url: 'https://github.com', match: 'host' }] } })),
    item('3', newItem('ssh_connection', { title: 'prod web', fields: { host: 'prod-web-1.example.com', port: 22, username: 'deploy', authMethod: 'agent', hostKeys: [] } as never })),
    item('4', newItem('login', { title: 'Netflix', fields: { username: 'ann', password: 'z', urls: [] } })),
  ];

  it('ranks the exact title first and asks when it is ambiguous', () => {
    const gh = findTargets(items, 'github', ['login']);
    expect(gh.map((i) => i.id)).toEqual(['1', '2']);
    expect(resolveOne(gh)).toBeNull();
    expect(resolveOne(findTargets(items, 'netflix', ['login']))?.id).toBe('4');
    expect(findTargets(items, 'prod', ['ssh_connection']).map((i) => i.id)).toEqual(['3']);
    expect(findTargets(items, 'nothing-here')).toEqual([]);
  });
});
