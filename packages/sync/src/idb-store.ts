import { openDB, type IDBPDatabase } from 'idb';
import type { RecordDto, VaultMembershipDto } from '@passvault/types';
import type { CacheStore, CachedAccount, OutboxEntry } from './store';

/** IndexedDB-backed encrypted cache for the web app and browser extension. */
export class IndexedDbStore implements CacheStore {
  private dbp: Promise<IDBPDatabase>;
  constructor(name = 'passvault-cache') {
    this.dbp = openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('kv');
        const records = db.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('vaultId', 'vaultId');
        db.createObjectStore('outbox', { keyPath: 'mutationId' });
      },
    });
  }
  async getAccount() {
    return ((await (await this.dbp).get('kv', 'account')) as CachedAccount | undefined) ?? null;
  }
  async putAccount(a: CachedAccount) {
    await (await this.dbp).put('kv', a, 'account');
  }
  async getMeta<T>(key: string) {
    return ((await (await this.dbp).get('kv', `meta:${key}`)) as T | undefined) ?? null;
  }
  async setMeta<T>(key: string, value: T) {
    await (await this.dbp).put('kv', value, `meta:${key}`);
  }
  async allRecords() {
    return (await (await this.dbp).getAll('records')) as RecordDto[];
  }
  async putRecords(records: RecordDto[]) {
    const tx = (await this.dbp).transaction('records', 'readwrite');
    await Promise.all([...records.map((r) => tx.store.put(r)), tx.done]);
  }
  async replaceVaultRecords(vaultId: string, records: RecordDto[]) {
    const tx = (await this.dbp).transaction('records', 'readwrite');
    const keys = await tx.store.index('vaultId').getAllKeys(vaultId);
    await Promise.all([...keys.map((k) => tx.store.delete(k)), ...records.map((r) => tx.store.put(r)), tx.done]);
  }
  async deleteVaultRecords(vaultIds: string[]) {
    const tx = (await this.dbp).transaction('records', 'readwrite');
    for (const v of vaultIds) {
      const keys = await tx.store.index('vaultId').getAllKeys(v);
      for (const k of keys) await tx.store.delete(k);
    }
    await tx.done;
  }
  async getVaults() {
    return ((await (await this.dbp).get('kv', 'vaults')) as VaultMembershipDto[] | undefined) ?? [];
  }
  async putVaults(v: VaultMembershipDto[]) {
    await (await this.dbp).put('kv', v, 'vaults');
  }
  async outbox() {
    const all = (await (await this.dbp).getAll('outbox')) as OutboxEntry[];
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async putOutbox(e: OutboxEntry) {
    await (await this.dbp).put('outbox', e);
  }
  async removeOutbox(id: string) {
    await (await this.dbp).delete('outbox', id);
  }
  async clear() {
    const db = await this.dbp;
    const tx = db.transaction(['kv', 'records', 'outbox'], 'readwrite');
    await Promise.all([tx.objectStore('kv').clear(), tx.objectStore('records').clear(), tx.objectStore('outbox').clear(), tx.done]);
  }
}
