import { wipe } from './sodium.js';
import { decryptBytes, decryptJson, encryptBytes, encryptJson, randomKey } from './envelope.js';

/**
 * Records (vault items and projects).
 *
 *   itemKey (random 32B) --AEAD(ctx "pv:record-key:v1:<vaultId>:<recordId>")--> encryptedKey (under vault key)
 *   payload JSON (padded) --AEAD(ctx "pv:record:v1:<recordId>")--> encryptedPayload (under item key)
 *
 * Binding the payload to the record id prevents the server from swapping
 * payloads between records. The key wrap is bound to the vault and record,
 * so moving a record between vaults only re-wraps its key; history versions
 * remain decryptable with the same item key.
 */
export const RECORD_FORMAT_VERSION = 1;

const keyCtx = (vaultId: string, recordId: string) => `pv:record-key:v1:${vaultId}:${recordId}`;
const payloadCtx = (recordId: string) => `pv:record:v1:${recordId}`;

export interface EncryptedRecordParts {
  encryptedKey: string;
  encryptedPayload: string;
  formatVersion: number;
}

export function encryptRecord<T>(params: {
  recordId: string;
  vaultId: string;
  vaultKey: Uint8Array;
  payload: T;
  /** Reuse an existing item key (updates); a new one is generated otherwise. */
  itemKey?: Uint8Array;
}): EncryptedRecordParts & { itemKey: Uint8Array } {
  const itemKey = params.itemKey ?? randomKey();
  return {
    encryptedKey: encryptBytes(params.vaultKey, itemKey, keyCtx(params.vaultId, params.recordId)),
    encryptedPayload: encryptJson(itemKey, params.payload, payloadCtx(params.recordId)),
    formatVersion: RECORD_FORMAT_VERSION,
    itemKey,
  };
}

export function unwrapRecordKey(params: { recordId: string; vaultId: string; vaultKey: Uint8Array; encryptedKey: string }): Uint8Array {
  return decryptBytes(params.vaultKey, params.encryptedKey, keyCtx(params.vaultId, params.recordId));
}

export function decryptRecordPayload<T>(itemKey: Uint8Array, recordId: string, encryptedPayload: string): T {
  return decryptJson<T>(itemKey, encryptedPayload, payloadCtx(recordId));
}

export function decryptRecord<T>(params: {
  recordId: string;
  vaultId: string;
  vaultKey: Uint8Array;
  encryptedKey: string;
  encryptedPayload: string;
}): { payload: T; itemKey: Uint8Array } {
  const itemKey = unwrapRecordKey(params);
  try {
    return { payload: decryptRecordPayload<T>(itemKey, params.recordId, params.encryptedPayload), itemKey };
  } catch (e) {
    wipe(itemKey);
    throw e;
  }
}

/** Re-wrap an existing item key for another vault (moving into/out of a shared vault). */
export function rewrapRecordKey(itemKey: Uint8Array, targetVaultId: string, targetVaultKey: Uint8Array, recordId: string): string {
  return encryptBytes(targetVaultKey, itemKey, keyCtx(targetVaultId, recordId));
}

/** Encrypt a per-user settings document under the User Key. */
export function encryptSettings(userKey: Uint8Array, settings: unknown): string {
  return encryptJson(userKey, settings, 'pv:settings:v1');
}

export function decryptSettings<T>(userKey: Uint8Array, envelope: string): T {
  return decryptJson<T>(userKey, envelope, 'pv:settings:v1');
}
