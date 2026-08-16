/** Bee-scoped durable fence for transport acceptance whose metadata commit failed. */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import type { DeliveryStopDoubt, SessionRecord } from "./store.js";

const DELIVERY_DOUBT_VERSION = 1 as const;

export type DeliveryDoubtRecord = {
  version: typeof DELIVERY_DOUBT_VERSION;
  bee: string;
  deliveryId: string;
  contentDigest: string;
  source: {
    createdAt: string;
    runtimeGeneration: number;
    id?: string;
    uuid?: string;
  };
  phase: "ambiguous" | "delivered" | "discarded";
  createdAt: string;
  updatedAt: string;
  reason?: string;
};

function beeKey(bee: string): string {
  return createHash("sha256").update(bee).digest("hex");
}

function idKey(deliveryId: string): string {
  return createHash("sha256").update(deliveryId).digest("hex");
}

function doubtDir(bee: string): string {
  return join(storeRoot(), "delivery-doubt", beeKey(bee));
}

function doubtPath(bee: string, deliveryId: string): string {
  return join(doubtDir(bee), `delivery-${idKey(deliveryId)}.json`);
}

function doubtLockPath(bee: string): string {
  return join(storeRoot(), "locks", "delivery-doubt", `${beeKey(bee)}.lock`);
}

export function deliveryContentDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseDoubt(raw: string, expectedBee: string): DeliveryDoubtRecord {
  const value = JSON.parse(raw) as Partial<DeliveryDoubtRecord>;
  if (
    value.version !== DELIVERY_DOUBT_VERSION ||
    value.bee !== expectedBee ||
    typeof value.deliveryId !== "string" || !value.deliveryId ||
    typeof value.contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.contentDigest) ||
    !value.source || typeof value.source !== "object" ||
    typeof value.source.createdAt !== "string" ||
    !Number.isSafeInteger(value.source.runtimeGeneration) || (value.source.runtimeGeneration ?? -1) < 0 ||
    (value.source.id !== undefined && typeof value.source.id !== "string") ||
    (value.source.uuid !== undefined && typeof value.source.uuid !== "string") ||
    (value.phase !== "ambiguous" && value.phase !== "delivered" && value.phase !== "discarded") ||
    typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" ||
    (value.reason !== undefined && typeof value.reason !== "string")
  ) {
    throw new Error(`malformed delivery-doubt receipt for ${expectedBee}`);
  }
  return value as DeliveryDoubtRecord;
}

export async function readDeliveryDoubts(bee: string): Promise<DeliveryDoubtRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(doubtDir(bee));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: DeliveryDoubtRecord[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    records.push(parseDoubt(await readFile(join(doubtDir(bee), entry), "utf8"), bee));
  }
  return records;
}

export async function readDeliveryDoubt(bee: string, deliveryId: string): Promise<DeliveryDoubtRecord | null> {
  try {
    return parseDoubt(await readFile(doubtPath(bee, deliveryId), "utf8"), bee);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function persistDeliveryDoubt(
  record: SessionRecord,
  deliveryId: string,
  text: string,
  reason: string,
): Promise<DeliveryDoubtRecord> {
  return withFileLock(doubtLockPath(record.name), async () => {
    const existing = await readDeliveryDoubt(record.name, deliveryId);
    const contentDigest = deliveryContentDigest(text);
    const source = {
      createdAt: record.createdAt,
      runtimeGeneration: record.runtimeGeneration ?? 0,
      ...(record.id ? { id: record.id } : {}),
      ...(record.uuid ? { uuid: record.uuid } : {}),
    };
    if (existing) {
      if (existing.contentDigest !== contentDigest || JSON.stringify(existing.source) !== JSON.stringify(source)) {
        throw new Error(`delivery-doubt id ${deliveryId} is already bound to different work`);
      }
      return existing;
    }
    const now = new Date().toISOString();
    const receipt: DeliveryDoubtRecord = {
      version: DELIVERY_DOUBT_VERSION,
      bee: record.name,
      deliveryId,
      contentDigest,
      source,
      phase: "ambiguous",
      createdAt: now,
      updatedAt: now,
      reason,
    };
    await mkdir(doubtDir(record.name), { recursive: true, mode: 0o700 });
    await atomicWriteFile(doubtPath(record.name, deliveryId), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    return receipt;
  });
}

/**
 * Export the canonical last-resort marker before a destructive SessionRecord
 * purge. This sidecar lives outside both the HSR run dir and session row, so
 * the exact Buz queue identity remains reconcilable after kill/clean.
 */
export async function persistCanonicalDeliveryStopDoubt(
  record: SessionRecord,
  marker: DeliveryStopDoubt,
): Promise<DeliveryDoubtRecord> {
  if (
    marker.source.createdAt !== record.createdAt ||
    marker.source.runtimeGeneration !== (record.runtimeGeneration ?? 0) ||
    (marker.source.id !== undefined && marker.source.id !== record.id) ||
    (marker.source.uuid !== undefined && marker.source.uuid !== record.uuid)
  ) {
    throw new Error(`canonical delivery marker ${marker.deliveryId} does not own ${record.name}'s runtime generation`);
  }
  return withFileLock(doubtLockPath(record.name), async () => {
    const existing = await readDeliveryDoubt(record.name, marker.deliveryId);
    if (existing) {
      if (existing.contentDigest !== marker.contentDigest || JSON.stringify(existing.source) !== JSON.stringify(marker.source)) {
        throw new Error(`delivery-doubt id ${marker.deliveryId} is already bound to different work`);
      }
      return existing;
    }
    const now = new Date().toISOString();
    const receipt: DeliveryDoubtRecord = {
      version: DELIVERY_DOUBT_VERSION,
      bee: record.name,
      deliveryId: marker.deliveryId,
      contentDigest: marker.contentDigest,
      source: { ...marker.source },
      phase: "ambiguous",
      createdAt: marker.createdAt,
      updatedAt: now,
      reason: marker.fenceError,
    };
    await mkdir(doubtDir(record.name), { recursive: true, mode: 0o700 });
    await atomicWriteFile(doubtPath(record.name, marker.deliveryId), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    return receipt;
  });
}

export async function assertNoUnresolvedDeliveryDoubt(
  bee: string,
  operation: string,
  allowedDeliveryId?: string,
): Promise<void> {
  const unresolved = (await readDeliveryDoubts(bee)).find((record) =>
    record.phase === "ambiguous" && record.deliveryId !== allowedDeliveryId);
  if (unresolved) {
    const error = new Error(`${operation}: ${bee} has unresolved delivery ownership ${unresolved.deliveryId}`) as Error & {
      code?: string;
      deliveryId?: string;
    };
    error.code = "HIVE_HSR_DELIVERY_AMBIGUOUS";
    error.deliveryId = unresolved.deliveryId;
    throw error;
  }
}

export async function settleDeliveryDoubt(
  bee: string,
  deliveryId: string,
  verdict: "delivered" | "discarded",
): Promise<DeliveryDoubtRecord | null> {
  return withFileLock(doubtLockPath(bee), async () => {
    const current = await readDeliveryDoubt(bee, deliveryId);
    if (!current) return null;
    const phase = verdict;
    if (current.phase !== "ambiguous" && current.phase !== phase) {
      throw new Error(`delivery-doubt ${deliveryId} is already settled as ${current.phase}`);
    }
    if (current.phase === phase) return current;
    const next: DeliveryDoubtRecord = { ...current, phase, updatedAt: new Date().toISOString() };
    delete next.reason;
    await atomicWriteFile(doubtPath(bee, deliveryId), `${JSON.stringify(next)}\n`, { mode: 0o600 });
    return next;
  });
}
