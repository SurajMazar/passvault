import { ApiError, type ApiClient } from '@passvault/api-client';
import type { RecordDto, RevisionConflictDetails, SyncResponse, VaultMembershipDto } from '@passvault/types';
import type { CacheStore, OutboxEntry } from './store';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  lastSyncAt: string | null;
  lastError: string | null;
  pending: number;
  failed: number;
  conflicts: number;
  pendingInvitations: number;
}

export interface SyncChange {
  /** records were added/updated/removed in the cache */
  recordsChanged: boolean;
  vaultsChanged: boolean;
  /** vault ids the caller lost access to (records purged from cache) */
  removedVaults: string[];
}

const CURSOR_KEY = 'syncCursor';
const LAST_SYNC_KEY = 'lastSyncAt';

function newId(): string {
  return crypto.randomUUID();
}

/**
 * Synchronisation engine.
 *
 *  - pull: incremental `GET /sync` by global sequence cursor. Tombstones are
 *    kept in the cache so deleted records never resurrect from stale state.
 *    Vaults missing from the membership list are purged locally (revoked or
 *    expired access). `resyncVaults` are re-listed in full.
 *  - push: an outbox of encrypted mutations with client-generated mutation
 *    ids (idempotent retries) and base revisions (optimistic concurrency).
 *    A 409 marks the entry as a conflict for the user to resolve; nothing is
 *    overwritten silently.
 */
export class SyncEngine {
  private running: Promise<SyncChange> | null = null;
  private status: SyncStatus = {
    state: 'idle',
    lastSyncAt: null,
    lastError: null,
    pending: 0,
    failed: 0,
    conflicts: 0,
    pendingInvitations: 0,
  };
  private listeners = new Set<(s: SyncStatus) => void>();

  constructor(
    private readonly api: ApiClient,
    private readonly store: CacheStore,
  ) {}

  onStatus(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  private async emit(patch: Partial<SyncStatus>) {
    const box = await this.store.outbox();
    this.status = {
      ...this.status,
      ...patch,
      pending: box.filter((e) => e.status === 'pending').length,
      failed: box.filter((e) => e.status === 'failed').length,
      conflicts: box.filter((e) => e.status === 'conflict').length,
    };
    for (const l of this.listeners) l(this.status);
  }

  async loadStatus(): Promise<void> {
    await this.emit({ lastSyncAt: await this.store.getMeta<string>(LAST_SYNC_KEY) });
  }

  private followUp: Promise<SyncChange> | null = null;

  /**
   * Run push then pull. If a run is already in progress, a single follow-up
   * run is queued so edits enqueued mid-run are pushed promptly (calls made
   * during a run all share that follow-up).
   */
  sync(): Promise<SyncChange> {
    if (!this.running) {
      this.running = this.runOnce().finally(() => {
        this.running = null;
      });
      return this.running;
    }
    if (!this.followUp) {
      this.followUp = this.running
        .catch(() => undefined)
        .then(() => {
          this.followUp = null;
          return this.sync();
        });
    }
    return this.followUp;
  }

  private async runOnce(): Promise<SyncChange> {
    await this.emit({ state: 'syncing' });
    try {
      const pushed = await this.push();
      const change = await this.pull();
      const now = new Date().toISOString();
      await this.store.setMeta(LAST_SYNC_KEY, now);
      await this.emit({ state: 'idle', lastSyncAt: now, lastError: null });
      return { ...change, recordsChanged: change.recordsChanged || pushed };
    } catch (e) {
      if (e instanceof ApiError && e.isNetwork) {
        await this.emit({ state: 'offline', lastError: e.message });
      } else {
        await this.emit({ state: 'error', lastError: e instanceof Error ? e.message : String(e) });
      }
      throw e;
    }
  }

  async pull(): Promise<SyncChange> {
    let cursor = (await this.store.getMeta<string>(CURSOR_KEY)) ?? '0';
    let recordsChanged = false;
    let vaultsChanged = false;
    let removedVaults: string[] = [];
    let page: SyncResponse;
    let first = true;
    const reloaded = new Set<string>();
    do {
      page = await this.api.sync(cursor);
      if (first) {
        first = false;
        const before = await this.store.getVaults();
        const nowIds = new Set(page.vaults.map((v) => v.vaultId));
        removedVaults = before.map((v) => v.vaultId).filter((id) => !nowIds.has(id));
        if (removedVaults.length) {
          await this.store.deleteVaultRecords(removedVaults);
          recordsChanged = true;
        }
        vaultsChanged = removedVaults.length > 0 || JSON.stringify(before) !== JSON.stringify(page.vaults);
        await this.store.putVaults(page.vaults);
      }
      // Membership changes can land on any page of a multi-page pull.
      for (const vaultId of page.resyncVaults) {
        if (reloaded.has(vaultId)) continue;
        reloaded.add(vaultId);
        await this.fullVaultReload(vaultId);
        recordsChanged = true;
      }
      if (page.records.length) {
        // Records only for vaults we currently have access to.
        const allowed = new Set(page.vaults.map((v: VaultMembershipDto) => v.vaultId));
        await this.store.putRecords(page.records.filter((r) => allowed.has(r.vaultId)));
        recordsChanged = true;
      }
      cursor = page.cursor;
      await this.store.setMeta(CURSOR_KEY, cursor);
    } while (page.hasMore);
    await this.emit({ pendingInvitations: page.pendingInvitations });
    return { recordsChanged, vaultsChanged, removedVaults };
  }

  private async fullVaultReload(vaultId: string) {
    const all: RecordDto[] = [];
    let cursor: string | undefined;
    do {
      const p = await this.api.vaultRecords(vaultId, cursor);
      all.push(...p.data);
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    await this.store.replaceVaultRecords(vaultId, all);
  }

  // ---------- outbox ----------

  async enqueue(entry: Omit<OutboxEntry, 'mutationId' | 'createdAt' | 'status' | 'attempts' | 'afterMutationId'> & { afterMutationId?: string | null }): Promise<OutboxEntry> {
    const full: OutboxEntry = {
      ...entry,
      afterMutationId: entry.afterMutationId ?? null,
      mutationId: newId(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
    };
    await this.store.putOutbox(full);
    await this.emit({});
    return full;
  }

  /** Latest pending outbox entry for a record (used to chain dependent edits). */
  async latestEntryFor(recordId: string): Promise<OutboxEntry | null> {
    const box = (await this.store.outbox()).filter((e) => e.recordId === recordId);
    return box.length ? box[box.length - 1]! : null;
  }

  async push(): Promise<boolean> {
    let changed = false;
    const entries = await this.store.outbox();
    const blockedRecords = new Set<string>();
    // Edits waiting on an entry pushed earlier in this run, rebased onto its new revision.
    const rebased = new Map<string, OutboxEntry>();
    for (const snapshot of entries) {
      const entry = rebased.get(snapshot.mutationId) ?? snapshot;
      if (entry.status !== 'pending') {
        blockedRecords.add(entry.recordId);
        continue;
      }
      if (blockedRecords.has(entry.recordId)) continue;
      if (entry.baseRevision === null && entry.op !== 'create') {
        // waits for an earlier entry (still in the outbox) to complete
        blockedRecords.add(entry.recordId);
        continue;
      }
      try {
        const result = await this.send(entry);
        await this.store.removeOutbox(entry.mutationId);
        if (result) {
          await this.store.putRecords([result]);
          for (const d of await this.rebaseDependents(entry.mutationId, result.revision)) rebased.set(d.mutationId, d);
        }
        changed = true;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.isNetwork) throw e; // stop; retry later with the same mutation ids
        blockedRecords.add(entry.recordId);
        if (e.code === 'revision_conflict') {
          const current = (e.details as RevisionConflictDetails | undefined)?.current;
          await this.store.putOutbox({ ...entry, status: 'conflict', conflict: current, error: 'Changed elsewhere', attempts: entry.attempts + 1 });
          if (current) await this.store.putRecords([current]);
        } else {
          await this.store.putOutbox({ ...entry, status: 'failed', error: e.message, attempts: entry.attempts + 1 });
        }
        changed = true;
      }
    }
    await this.emit({});
    return changed;
  }

  private async send(e: OutboxEntry): Promise<RecordDto | null> {
    switch (e.op) {
      case 'create':
        return this.api.createRecord({
          id: e.recordId,
          vaultId: e.vaultId,
          kind: e.kind,
          formatVersion: e.formatVersion,
          encryptedKey: e.encryptedKey!,
          encryptedPayload: e.encryptedPayload!,
          mutationId: e.mutationId,
        });
      case 'update':
        return this.api.updateRecord(e.recordId, {
          baseRevision: e.baseRevision!,
          formatVersion: e.formatVersion,
          encryptedKey: e.encryptedKey!,
          encryptedPayload: e.encryptedPayload!,
          ...(e.targetVaultId ? { vaultId: e.targetVaultId } : {}),
          mutationId: e.mutationId,
        });
      case 'delete':
        return this.api.deleteRecord(e.recordId, { baseRevision: e.baseRevision!, mutationId: e.mutationId });
    }
  }

  private async rebaseDependents(mutationId: string, revision: number): Promise<OutboxEntry[]> {
    const out: OutboxEntry[] = [];
    for (const d of await this.store.outbox()) {
      if (d.afterMutationId === mutationId) {
        const next = { ...d, baseRevision: revision, afterMutationId: null };
        await this.store.putOutbox(next);
        out.push(next);
      }
    }
    return out;
  }

  /** Resolve a conflict. */
  async resolveConflict(mutationId: string, resolution: { keep: 'mine'; encryptedKey: string; encryptedPayload: string } | { keep: 'theirs' }) {
    const box = await this.store.outbox();
    const entry = box.find((e) => e.mutationId === mutationId);
    if (!entry || entry.status !== 'conflict') throw new Error('no such conflict');
    await this.store.removeOutbox(mutationId);
    if (resolution.keep === 'mine' && entry.conflict && !entry.conflict.deletedAt) {
      await this.enqueue({
        recordId: entry.recordId,
        vaultId: entry.conflict.vaultId,
        kind: entry.kind,
        op: entry.op === 'delete' ? 'delete' : 'update',
        baseRevision: entry.conflict.revision,
        formatVersion: entry.formatVersion,
        encryptedKey: resolution.encryptedKey,
        encryptedPayload: resolution.encryptedPayload,
      });
    }
    // Any later entries for the same record were based on the discarded edit; mark them failed for review.
    for (const d of box) {
      if (d.recordId === entry.recordId && d.mutationId !== mutationId && d.status === 'pending' && d.afterMutationId === mutationId) {
        await this.store.putOutbox({ ...d, status: 'failed', error: 'Depends on a discarded conflicting edit' });
      }
    }
    await this.emit({});
  }

  async discard(mutationId: string) {
    await this.store.removeOutbox(mutationId);
    await this.emit({});
  }

  async retry(mutationId: string) {
    const e = (await this.store.outbox()).find((x) => x.mutationId === mutationId);
    if (e) await this.store.putOutbox({ ...e, status: 'pending', error: undefined });
    await this.emit({});
  }

  async reset() {
    await this.store.clear();
    this.status = { ...this.status, lastSyncAt: null, pending: 0, failed: 0, conflicts: 0 };
    await this.emit({ state: 'idle' });
  }
}
