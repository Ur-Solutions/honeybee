import { dirname, resolve } from "node:path";
import { storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import {
  loadSession,
  safeName,
  saveSessionLocked,
  withSessionLock,
  type SessionRecord,
} from "./store.js";

/**
 * One durable, cross-process transaction for runtime lifecycle side effects.
 *
 * Lock order is deliberately one-way:
 *
 *   lifecycle -> activation-home (when needed) -> session -> active-index
 *
 * The lifecycle lock is distinct from the non-reentrant session record lock.
 * Callers may therefore perform ordinary store operations while holding a
 * lifecycle transaction; only the short CAS commit below takes the record
 * lock. Code holding a session or activation-home lock must never enter a
 * lifecycle transaction.
 */

export class LifecycleConflictError extends Error {
  readonly code = "HIVE_LIFECYCLE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "LifecycleConflictError";
  }
}

type LifecycleIdentity = {
  name: string;
  createdAt: string;
  id?: string;
  uuid?: string;
  runtimeGeneration: number;
};

function lifecycleIdentity(record: SessionRecord): LifecycleIdentity {
  return {
    name: record.name,
    createdAt: record.createdAt,
    ...(record.id ? { id: record.id } : {}),
    ...(record.uuid ? { uuid: record.uuid } : {}),
    runtimeGeneration: record.runtimeGeneration ?? 0,
  };
}

function sameLifecycleIdentity(record: SessionRecord, expected: LifecycleIdentity): boolean {
  return record.name === expected.name
    && record.createdAt === expected.createdAt
    && (record.runtimeGeneration ?? 0) === expected.runtimeGeneration
    && (expected.id === undefined || record.id === expected.id)
    && (expected.uuid === undefined || record.uuid === expected.uuid);
}

function lifecycleLockPath(name: string): string {
  const root = resolve(storeRoot(), "lifecycle-locks");
  const target = resolve(root, `${safeName(name)}.lock`);
  if (dirname(target) !== root) throw new Error(`lifecycle lock escaped its store root: ${name}`);
  return target;
}

export type SessionLifecycleTransaction = {
  refresh(): Promise<SessionRecord>;
  commit(patch: Partial<SessionRecord>): Promise<SessionRecord>;
  destructiveCommit<T>(fn: (current: SessionRecord) => Promise<T>): Promise<T>;
};

class LockedSessionLifecycleTransaction implements SessionLifecycleTransaction {
  #record: SessionRecord;
  #identity: LifecycleIdentity;

  constructor(record: SessionRecord) {
    this.#record = record;
    this.#identity = lifecycleIdentity(record);
  }

  /** Re-read and validate the exact authoritative runtime generation. */
  async refresh(): Promise<SessionRecord> {
    const current = await loadSession(this.#identity.name);
    if (!current) {
      throw new LifecycleConflictError(`Session ${this.#identity.name} no longer exists`);
    }
    if (!sameLifecycleIdentity(current, this.#identity)) {
      throw new LifecycleConflictError(
        `Session ${this.#identity.name} changed lifecycle generation while the operation was in flight`,
      );
    }
    this.#record = current;
    return current;
  }

  /**
   * Merge a patch only if the identity/generation observed by this transaction
   * still owns the record. A successful generation bump advances the token.
   */
  async commit(patch: Partial<SessionRecord>): Promise<SessionRecord> {
    return withSessionLock(this.#identity.name, async () => {
      const current = await loadSession(this.#identity.name);
      if (!current || !sameLifecycleIdentity(current, this.#identity)) {
        throw new LifecycleConflictError(
          `Session ${this.#identity.name} lost its lifecycle commit race`,
        );
      }
      const merged: SessionRecord = { ...current, ...patch, name: current.name };
      const bag = merged as Record<string, unknown>;
      for (const key of Object.keys(bag)) {
        if (bag[key] === undefined) delete bag[key];
      }
      await saveSessionLocked(merged);
      this.#record = merged;
      this.#identity = lifecycleIdentity(merged);
      return merged;
    });
  }

  /**
   * Run an irreversible commit while the short record lock proves this exact
   * generation still owns the canonical row. The callback must not call a
   * store API that re-acquires the same session lock.
   */
  async destructiveCommit<T>(fn: (current: SessionRecord) => Promise<T>): Promise<T> {
    return withSessionLock(this.#identity.name, async () => {
      const current = await loadSession(this.#identity.name);
      if (!current || !sameLifecycleIdentity(current, this.#identity)) {
        throw new LifecycleConflictError(
          `Session ${this.#identity.name} lost its lifecycle destructive commit race`,
        );
      }
      return fn(current);
    });
  }
}

/**
 * Serialize one lifecycle operation and reject a stale caller before it can
 * touch a runtime. Metadata-only record writes may proceed independently, but
 * every runtime replacement/terminal operation must use this transaction.
 */
export async function withSessionLifecycleTransaction<T>(
  expected: SessionRecord,
  fn: (transaction: SessionLifecycleTransaction) => Promise<T>,
): Promise<T> {
  return withSessionLifecycleLock(expected.name, async () => {
    const current = await loadSession(expected.name);
    if (!current) throw new LifecycleConflictError(`Session ${expected.name} no longer exists`);
    const expectedIdentity = lifecycleIdentity(expected);
    if (!sameLifecycleIdentity(current, expectedIdentity)) {
      throw new LifecycleConflictError(
        `Session ${expected.name} is now runtime generation ${current.runtimeGeneration ?? 0}; `
        + `caller observed ${expected.runtimeGeneration ?? 0}`,
      );
    }
    return fn(new LockedSessionLifecycleTransaction(current));
  });
}

/** Low-level lifecycle serialization for malformed-record purge recovery. */
export async function withSessionLifecycleLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(lifecycleLockPath(name), fn, { timeoutMs: 120_000, staleMs: 180_000 });
}
