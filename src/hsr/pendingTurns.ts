/**
 * Durable turns accepted while a detached HSR host is still queued.
 *
 * `hive x` is fire-and-forget: it must be able to hand off the initial prompt
 * without waiting for every older cold start. A queued host therefore accepts
 * turns as owner-only files in its run dir. The host and live send path share a
 * per-bee lock so the queued -> running transition cannot lose or double-send a
 * turn that lands on the boundary.
 */

import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { hsrRunDir } from "./runDir.js";

type PendingTurn = {
  id: string;
  text: string;
  queuedAt: string;
};

function pendingTurnsDir(bee: string): string {
  return join(hsrRunDir(bee), "pending-turns");
}

function deliveryLockPath(bee: string): string {
  const key = createHash("sha1").update(hsrRunDir(bee)).digest("hex");
  return join(storeRoot(), "locks", "hsr-turn-delivery", `${key}.lock`);
}

/** Serialize queued writes against the host's queued -> running drain. */
export function withHsrTurnDeliveryLock<T>(bee: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(deliveryLockPath(bee), fn, { timeoutMs: 30_000 });
}

/** Persist one turn without waiting for the harness to finish cold-starting. */
export async function enqueuePendingHsrTurn(bee: string, text: string): Promise<void> {
  const id = randomUUID();
  const queuedAt = new Date().toISOString();
  const turn: PendingTurn = { id, text, queuedAt };
  const dir = pendingTurnsDir(bee);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // ISO timestamps sort chronologically; the machine monotonic clock preserves
  // order for turns accepted in the same millisecond while the delivery lock
  // serializes their creation across processes.
  const monotonic = process.hrtime.bigint().toString().padStart(20, "0");
  const filename = `${queuedAt.replace(/[:.]/g, "-")}-${monotonic}-${id}.json`;
  await atomicWriteFile(join(dir, filename), `${JSON.stringify(turn)}\n`, { mode: 0o600 });
}

/**
 * Drain queued turns in creation order. Caller must hold the delivery lock.
 * A turn file is removed only after `send` accepts it, giving crash recovery
 * at-least-once semantics instead of silently losing the user's prompt.
 */
export async function drainPendingHsrTurns(bee: string, send: (text: string) => Promise<void>): Promise<number> {
  const dir = pendingTurnsDir(bee);
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".json"))
    .sort();
  let delivered = 0;
  for (const filename of files) {
    const path = join(dir, filename);
    let turn: PendingTurn | undefined;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PendingTurn>;
      if (typeof parsed.id === "string" && typeof parsed.text === "string" && typeof parsed.queuedAt === "string") {
        turn = parsed as PendingTurn;
      }
    } catch {
      // A corrupt partial file cannot be delivered and must not block later
      // valid turns. atomicWriteFile makes this a debris-only path.
    }
    if (!turn) {
      await rm(path, { force: true }).catch(() => undefined);
      continue;
    }
    await send(turn.text);
    await rm(path, { force: true });
    delivered += 1;
  }
  return delivered;
}

/** Intentional retire/kill cancels prompts that never reached the harness. */
export async function clearPendingHsrTurns(bee: string): Promise<void> {
  await rm(pendingTurnsDir(bee), { recursive: true, force: true });
}
