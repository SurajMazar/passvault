import type { ItemPayload, TrustedHostKey } from '@passvault/types';
import type { DecryptedItem } from '@passvault/vault-core';
import type { Hop, HopPublic, HostKey } from '../ipc/types';

/**
 * Builds helper `Hop`s from vault items. Secrets (password, private key,
 * passphrase) only ever go into the returned `Hop` objects, which are sent in
 * a single IPC message; they are never logged. `buildExternalParams` builds
 * the non-secret parameters for `term.openExternal`.
 */

export type SshConnectionItem = DecryptedItem & { payload: ItemPayload<'ssh_connection'> };
export type SshKeyItem = DecryptedItem & { payload: ItemPayload<'ssh_key'> };

export class HopBuildError extends Error {
  override name = 'HopBuildError';
}

/** Session-only trust (e.g. a viewer of a shared item who cannot save): itemId → keys. */
export type SessionTrust = Map<string, TrustedHostKey[]>;

const MAX_TRUSTED = 20;

export function isSshConnection(i: DecryptedItem | undefined | null): i is SshConnectionItem {
  return !!i && i.payload.type === 'ssh_connection';
}

export function isSshKey(i: DecryptedItem | undefined | null): i is SshKeyItem {
  return !!i && i.payload.type === 'ssh_key';
}

/** host:port exactly like Go's net.JoinHostPort (IPv6 literals in brackets). */
export function formatHostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

export function hostPortOf(item: SshConnectionItem): string {
  return formatHostPort(item.payload.fields.host, item.payload.fields.port);
}

/** Trusted keys for the item's own host:port (keys saved for another host:port are ignored). */
export function trustedKeysFor(item: SshConnectionItem, sessionTrust?: SessionTrust): HostKey[] {
  const hp = hostPortOf(item);
  const all = [...(item.payload.fields.hostKeys ?? []), ...(sessionTrust?.get(item.id) ?? [])];
  const out: HostKey[] = [];
  const seen = new Set<string>();
  for (const k of all) {
    if (k.hostPort !== hp) continue;
    const id = `${k.keyType} ${k.publicKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ keyType: k.keyType, publicKey: k.publicKey });
    if (out.length >= MAX_TRUSTED) break;
  }
  return out;
}

function publicHop(item: SshConnectionItem): HopPublic {
  const f = item.payload.fields;
  if (!f.host) throw new HopBuildError(`“${item.payload.title}” has no host`);
  if (!Number.isInteger(f.port) || f.port < 1 || f.port > 65535) throw new HopBuildError(`“${item.payload.title}” has an invalid port`);
  if (!f.username) throw new HopBuildError(`“${item.payload.title}” has no username`);
  return { host: f.host, port: f.port, username: f.username };
}

function resolveKeyItem(item: SshConnectionItem, items: DecryptedItem[]): SshKeyItem {
  const id = item.payload.fields.sshKeyItemId;
  if (!id) throw new HopBuildError(`“${item.payload.title}” uses SSH key authentication but no key is selected`);
  const k = items.find((i) => i.id === id);
  if (!isSshKey(k)) throw new HopBuildError(`The SSH key for “${item.payload.title}” is missing or not shared with you`);
  if (!k.payload.fields.privateKey) throw new HopBuildError(`The SSH key “${k.payload.title}” has no private key`);
  return k;
}

export function buildHop(item: SshConnectionItem, items: DecryptedItem[], sessionTrust?: SessionTrust): Hop {
  const pub = publicHop(item);
  const f = item.payload.fields;
  let auth: Hop['auth'];
  switch (f.authMethod) {
    case 'password':
      auth = { method: 'password', password: f.password ?? '' };
      break;
    case 'key': {
      const k = resolveKeyItem(item, items);
      auth = { method: 'key', privateKey: k.payload.fields.privateKey, ...(k.payload.fields.passphrase ? { passphrase: k.payload.fields.passphrase } : {}) };
      break;
    }
    case 'agent':
      auth = { method: 'agent' };
      break;
    case 'keyboard_interactive':
      // The stored password is never sent automatically: the user fills it per prompt.
      auth = { method: 'keyboard_interactive' };
      break;
    default:
      throw new HopBuildError('Unsupported authentication method');
  }
  return { ...pub, auth, trustedHostKeys: trustedKeysFor(item, sessionTrust) };
}

export function resolveJumpItem(item: SshConnectionItem, items: DecryptedItem[]): SshConnectionItem | undefined {
  const id = item.payload.fields.jumpHostItemId;
  if (!id) return undefined;
  if (id === item.id) throw new HopBuildError(`“${item.payload.title}” uses itself as its jump host`);
  const j = items.find((i) => i.id === id);
  if (!isSshConnection(j)) throw new HopBuildError(`The jump host of “${item.payload.title}” is missing or not shared with you`);
  return j;
}

export interface ResolvedConnection {
  target: Hop;
  jump?: Hop;
  targetItem: SshConnectionItem;
  jumpItem?: SshConnectionItem;
}

export function buildConnection(item: SshConnectionItem, items: DecryptedItem[], sessionTrust?: SessionTrust): ResolvedConnection {
  const jumpItem = resolveJumpItem(item, items);
  return {
    target: buildHop(item, items, sessionTrust),
    targetItem: item,
    ...(jumpItem ? { jump: buildHop(jumpItem, items, sessionTrust), jumpItem } : {}),
  };
}

export interface ExternalTerminalParams {
  app: 'terminal' | 'iterm';
  target: HopPublic;
  jump?: HopPublic;
  trustedHostKeys: HostKey[];
  jumpTrustedHostKeys?: HostKey[];
  useAgent: boolean;
}

/**
 * Non-secret parameters for `term.openExternal`. Never includes passwords,
 * private keys or passphrases. `missingTrust` lists hops with no trusted key
 * (the helper would refuse with host_key_unknown).
 */
export function buildExternalParams(
  item: SshConnectionItem,
  items: DecryptedItem[],
  opts: { app: 'terminal' | 'iterm'; agentRunning: boolean; sessionTrust?: SessionTrust },
): { params: ExternalTerminalParams; missingTrust: Array<'target' | 'jump'> } {
  const jumpItem = resolveJumpItem(item, items);
  const usesKeys = (i: SshConnectionItem) => i.payload.fields.authMethod === 'key' || i.payload.fields.authMethod === 'agent';
  const params: ExternalTerminalParams = {
    app: opts.app,
    target: publicHop(item),
    trustedHostKeys: trustedKeysFor(item, opts.sessionTrust),
    useAgent: opts.agentRunning && (usesKeys(item) || (!!jumpItem && usesKeys(jumpItem))),
  };
  if (jumpItem) {
    params.jump = publicHop(jumpItem);
    params.jumpTrustedHostKeys = trustedKeysFor(jumpItem, opts.sessionTrust);
  }
  const missingTrust: Array<'target' | 'jump'> = [];
  if (params.trustedHostKeys.length === 0) missingTrust.push('target');
  if (jumpItem && (params.jumpTrustedHostKeys?.length ?? 0) === 0) missingTrust.push('jump');
  return { params, missingTrust };
}

/** Builds the TrustedHostKey record persisted in `fields.hostKeys`. */
export function toTrustedHostKey(ev: { keyType: string; publicKey: string; fingerprint: string; hostPort: string }, now = new Date()): TrustedHostKey {
  return { keyType: ev.keyType, publicKey: ev.publicKey, fingerprint: ev.fingerprint, hostPort: ev.hostPort, trustedAt: now.toISOString() };
}
