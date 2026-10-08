import type { AccountBundle, RecordDto, VaultMembershipDto } from '@passvault/types';

/**
 * Local cache. It holds ONLY data that is already encrypted by clients
 * (server record envelopes, wrapped keys) plus non-secret sync metadata.
 * No decrypted payloads or unwrapped keys are ever written to a CacheStore.
 */

export type OutboxOp = 'create' | 'update' | 'delete';
export type OutboxStatus = 'pending' | 'failed' | 'conflict';

export interface OutboxEntry {
  mutationId: string;
  recordId: string;
  vaultId: string;
  kind: 'item' | 'project';
  op: OutboxOp;
  /** Revision this edit was based on. null = depends on `afterMutationId` completing first. */
  baseRevision: number | null;
  afterMutationId: string | null;
  formatVersion: number;
  encryptedKey: string | null;
  encryptedPayload: string | null;
  /** target vault when moving between vaults */
  targetVaultId?: string;
  createdAt: string;
  status: OutboxStatus;
  error?: string;
  conflict?: RecordDto;
  attempts: number;
}

export interface CachedAccount {
  account: AccountBundle;
  cachedAt: string;
}

export interface CacheStore {
  getAccount(): Promise<CachedAccount | null>;
  putAccount(a: CachedAccount): Promise<void>;
  getMeta<T>(key: string): Promise<T | null>;
  setMeta<T>(key: string, value: T): Promise<void>;
  allRecords(): Promise<RecordDto[]>;
  putRecords(records: RecordDto[]): Promise<void>;
  replaceVaultRecords(vaultId: string, records: RecordDto[]): Promise<void>;
  deleteVaultRecords(vaultIds: string[]): Promise<void>;
  getVaults(): Promise<VaultMembershipDto[]>;
  putVaults(v: VaultMembershipDto[]): Promise<void>;
  outbox(): Promise<OutboxEntry[]>;
  putOutbox(e: OutboxEntry): Promise<void>;
  removeOutbox(mutationId: string): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory store (tests, and clients that opt out of persistence). */
export class MemoryStore implements CacheStore {
  private account: CachedAccount | null = null;
  private meta = new Map<string, unknown>();
  private records = new Map<string, RecordDto>();
  private vaults: VaultMembershipDto[] = [];
  private box = new Map<string, OutboxEntry>();

  async getAccount() {
    return this.account;
  }
  async putAccount(a: CachedAccount) {
    this.account = structuredClone(a);
  }
  async getMeta<T>(key: string) {
    return (this.meta.has(key) ? structuredClone(this.meta.get(key)) : null) as T | null;
  }
  async setMeta<T>(key: string, value: T) {
    this.meta.set(key, structuredClone(value));
  }
  async allRecords() {
    return [...this.records.values()].map((r) => structuredClone(r));
  }
  async putRecords(records: RecordDto[]) {
    for (const r of records) this.records.set(r.id, structuredClone(r));
  }
  async replaceVaultRecords(vaultId: string, records: RecordDto[]) {
    for (const [id, r] of this.records) if (r.vaultId === vaultId) this.records.delete(id);
    await this.putRecords(records);
  }
  async deleteVaultRecords(vaultIds: string[]) {
    const s = new Set(vaultIds);
    for (const [id, r] of this.records) if (s.has(r.vaultId)) this.records.delete(id);
  }
  async getVaults() {
    return structuredClone(this.vaults);
  }
  async putVaults(v: VaultMembershipDto[]) {
    this.vaults = structuredClone(v);
  }
  async outbox() {
    return [...this.box.values()].map((e) => structuredClone(e)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async putOutbox(e: OutboxEntry) {
    this.box.set(e.mutationId, structuredClone(e));
  }
  async removeOutbox(id: string) {
    this.box.delete(id);
  }
  async clear() {
    this.account = null;
    this.meta.clear();
    this.records.clear();
    this.vaults = [];
    this.box.clear();
  }
}

/**
 * Store backed by a simple async string key/value API (e.g. Neutralinojs
 * storage on desktop, chrome.storage.local in the extension). Values are JSON.
 */
export interface KeyValueBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class KeyValueStore implements CacheStore {
  constructor(
    private readonly kv: KeyValueBackend,
    private readonly prefix = 'pv',
  ) {}
  private k(name: string) {
    return `${this.prefix}_${name}`;
  }
  private async read<T>(name: string, fallback: T): Promise<T> {
    const raw = await this.kv.get(this.k(name));
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  private write(name: string, v: unknown) {
    return this.kv.set(this.k(name), JSON.stringify(v));
  }
  getAccount() {
    return this.read<CachedAccount | null>('account', null);
  }
  putAccount(a: CachedAccount) {
    return this.write('account', a);
  }
  async getMeta<T>(key: string) {
    const m = await this.read<Record<string, unknown>>('meta', {});
    return (m[key] ?? null) as T | null;
  }
  async setMeta<T>(key: string, value: T) {
    const m = await this.read<Record<string, unknown>>('meta', {});
    m[key] = value;
    await this.write('meta', m);
  }
  async allRecords() {
    return Object.values(await this.read<Record<string, RecordDto>>('records', {}));
  }
  async putRecords(records: RecordDto[]) {
    const m = await this.read<Record<string, RecordDto>>('records', {});
    for (const r of records) m[r.id] = r;
    await this.write('records', m);
  }
  async replaceVaultRecords(vaultId: string, records: RecordDto[]) {
    const m = await this.read<Record<string, RecordDto>>('records', {});
    for (const [id, r] of Object.entries(m)) if (r.vaultId === vaultId) delete m[id];
    for (const r of records) m[r.id] = r;
    await this.write('records', m);
  }
  async deleteVaultRecords(vaultIds: string[]) {
    const s = new Set(vaultIds);
    const m = await this.read<Record<string, RecordDto>>('records', {});
    for (const [id, r] of Object.entries(m)) if (s.has(r.vaultId)) delete m[id];
    await this.write('records', m);
  }
  getVaults() {
    return this.read<VaultMembershipDto[]>('vaults', []);
  }
  putVaults(v: VaultMembershipDto[]) {
    return this.write('vaults', v);
  }
  async outbox() {
    const m = await this.read<Record<string, OutboxEntry>>('outbox', {});
    return Object.values(m).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async putOutbox(e: OutboxEntry) {
    const m = await this.read<Record<string, OutboxEntry>>('outbox', {});
    m[e.mutationId] = e;
    await this.write('outbox', m);
  }
  async removeOutbox(id: string) {
    const m = await this.read<Record<string, OutboxEntry>>('outbox', {});
    delete m[id];
    await this.write('outbox', m);
  }
  async clear() {
    for (const n of ['account', 'meta', 'records', 'vaults', 'outbox']) await this.kv.remove(this.k(n));
  }
}
