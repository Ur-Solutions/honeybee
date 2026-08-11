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
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { hsrRunDir, readHsrMeta } from "./runDir.js";
import { readHsrMetaStrict } from "./runDir.js";
import { inspectProcessBirth, type ProcessBirthFingerprint, type ProcessIdentityReader } from "./processIdentity.js";
import { connectRpcClient } from "./rpc.js";

export type PendingHsrTurn = {
  id: string;
  text: string;
  queuedAt: string;
  /** Run-dir-local filename; never persisted inside the JSON payload. */
  filename: string;
};

export type PendingHsrDeliveryGate = {
  /** True only for the first acceptance of this id in the live host. */
  claim: (deliveryId: string) => boolean;
  /** Release after durable journal acknowledgement (or failed acceptance). */
  release: (deliveryId: string) => void;
};

/**
 * Incarnation-local delivery idempotency. A replacement host intentionally
 * gets a fresh gate and may replay a still-pending id after a real crash.
 */
export function createPendingHsrDeliveryGate(): PendingHsrDeliveryGate {
  const accepted = new Set<string>();
  return {
    claim: (deliveryId) => {
      if (accepted.has(deliveryId)) return false;
      accepted.add(deliveryId);
      return true;
    },
    release: (deliveryId) => {
      accepted.delete(deliveryId);
    },
  };
}

function pendingTurnsDir(bee: string): string {
  return join(hsrRunDir(bee), "pending-turns");
}

const RECOVERY_REPLAY_VERSION = 1 as const;

export type StagedPendingHsrTurns = {
  version: typeof RECOVERY_REPLAY_VERSION;
  bee: string;
  episodeId: string;
  stagedAt: string;
  restoredAt?: string;
  turns: Array<Pick<PendingHsrTurn, "id" | "filename" | "queuedAt">>;
};

function recoveryReplayDir(bee: string): string {
  return join(hsrRunDir(bee), "recovery-replay");
}

function recoveryReplayTurnsDir(bee: string): string {
  return join(recoveryReplayDir(bee), "turns");
}

function recoveryReplayManifestPath(bee: string): string {
  return join(recoveryReplayDir(bee), "manifest.json");
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
export async function enqueuePendingHsrTurn(bee: string, text: string): Promise<PendingHsrTurn> {
  const id = randomUUID();
  const queuedAt = new Date().toISOString();
  const payload = { id, text, queuedAt };
  const dir = pendingTurnsDir(bee);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // ISO timestamps sort chronologically; the machine monotonic clock preserves
  // order for turns accepted in the same millisecond while the delivery lock
  // serializes their creation across processes.
  const monotonic = process.hrtime.bigint().toString().padStart(20, "0");
  const filename = `${queuedAt.replace(/[:.]/g, "-")}-${monotonic}-${id}.json`;
  await atomicWriteFile(join(dir, filename), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  return { ...payload, filename };
}

async function readTurnsFromDir(dir: string): Promise<PendingHsrTurn[]> {
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const turns: PendingHsrTurn[] = [];
  for (const filename of files) {
    const path = join(dir, filename);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PendingHsrTurn>;
      if (typeof parsed.id === "string" && typeof parsed.text === "string" && typeof parsed.queuedAt === "string") {
        turns.push({ id: parsed.id, text: parsed.text, queuedAt: parsed.queuedAt, filename });
        continue;
      }
    } catch {
      // atomicWriteFile makes this a debris-only path.
    }
    // A corrupt partial file cannot be delivered and must not block later
    // valid turns. It also cannot be recovered, so remove the debris loudly
    // enough for callers to notice through a reduced recovered-turn count.
    await rm(path, { force: true }).catch(() => undefined);
  }
  return turns;
}

/** Read journaled turns in delivery order without exposing their contents in diagnostics. */
export async function readPendingHsrTurns(bee: string): Promise<PendingHsrTurn[]> {
  return readTurnsFromDir(pendingTurnsDir(bee));
}

async function readRecoveryReplayManifest(bee: string): Promise<StagedPendingHsrTurns | null> {
  try {
    const parsed = JSON.parse(await readFile(recoveryReplayManifestPath(bee), "utf8")) as Partial<StagedPendingHsrTurns>;
    if (
      parsed.version !== RECOVERY_REPLAY_VERSION ||
      parsed.bee !== bee ||
      typeof parsed.episodeId !== "string" ||
      typeof parsed.stagedAt !== "string" ||
      !Array.isArray(parsed.turns)
    ) return null;
    const turns = parsed.turns.filter((turn): turn is StagedPendingHsrTurns["turns"][number] =>
      !!turn && typeof turn.id === "string" && typeof turn.filename === "string" && typeof turn.queuedAt === "string");
    return {
      version: RECOVERY_REPLAY_VERSION,
      bee,
      episodeId: parsed.episodeId,
      stagedAt: parsed.stagedAt,
      ...(typeof parsed.restoredAt === "string" ? { restoredAt: parsed.restoredAt } : {}),
      turns,
    };
  } catch {
    return null;
  }
}

/** Read the owner-only recovery manifest; null when no replay is staged. */
export function readStagedPendingHsrTurns(bee: string): Promise<StagedPendingHsrTurns | null> {
  return readRecoveryReplayManifest(bee);
}

/**
 * Move every unacknowledged turn out of `pending-turns/` before ordinary HSR
 * stop tears that directory down. The original files and delivery ids survive:
 * recovery never fabricates a second logical turn merely because a host died.
 *
 * The move and manifest are protected by the same delivery lock as live sends.
 * A process crash before the manifest write is repairable: the next staging
 * pass adopts valid files already present in `recovery-replay/turns`.
 */
export async function stagePendingHsrTurnsForRecovery(
  bee: string,
  episodeId: string,
): Promise<StagedPendingHsrTurns> {
  return withHsrTurnDeliveryLock(bee, async () => {
    const existing = await readRecoveryReplayManifest(bee);
    const stageDir = recoveryReplayTurnsDir(bee);
    await mkdir(stageDir, { recursive: true, mode: 0o700 });
    for (const turn of await readPendingHsrTurns(bee)) {
      const source = join(pendingTurnsDir(bee), turn.filename);
      const destination = join(stageDir, turn.filename);
      try {
        await rename(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const staged = (await readTurnsFromDir(stageDir)).find((candidate) => candidate.filename === turn.filename);
        if (!staged || staged.id !== turn.id || staged.text !== turn.text) throw error;
        await rm(source, { force: true });
      }
    }
    const turns = await readTurnsFromDir(stageDir);
    const manifest: StagedPendingHsrTurns = {
      version: RECOVERY_REPLAY_VERSION,
      bee,
      // An uncleared older manifest owns the same durable turns. Preserve its
      // episode id so a supervisor restart cannot create a competing replay.
      episodeId: existing?.episodeId ?? episodeId,
      stagedAt: existing?.stagedAt ?? new Date().toISOString(),
      turns: turns.map(({ id, filename, queuedAt }) => ({ id, filename, queuedAt })),
    };
    await atomicWriteFile(recoveryReplayManifestPath(bee), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return manifest;
  });
}

/**
 * Restore staged files to the live host's normal pending journal. This only
 * moves durable files; the caller must then ask the host to drain them. It is
 * safe to repeat after a daemon restart: an already-restored matching file is
 * retained once, never copied.
 */
export async function restorePendingHsrTurnsAfterRecovery(bee: string): Promise<StagedPendingHsrTurns | null> {
  return withHsrTurnDeliveryLock(bee, async () => {
    const manifest = await readRecoveryReplayManifest(bee);
    if (!manifest) return null;
    const stageDir = recoveryReplayTurnsDir(bee);
    const pendingDir = pendingTurnsDir(bee);
    await mkdir(pendingDir, { recursive: true, mode: 0o700 });
    for (const turn of await readTurnsFromDir(stageDir)) {
      const source = join(stageDir, turn.filename);
      const destination = join(pendingDir, turn.filename);
      try {
        await rename(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const pending = (await readPendingHsrTurns(bee)).find((candidate) => candidate.filename === turn.filename);
        if (!pending || pending.id !== turn.id || pending.text !== turn.text) throw error;
        await rm(source, { force: true });
      }
    }
    const restored: StagedPendingHsrTurns = {
      ...manifest,
      restoredAt: new Date().toISOString(),
    };
    await atomicWriteFile(recoveryReplayManifestPath(bee), `${JSON.stringify(restored, null, 2)}\n`, { mode: 0o600 });
    return restored;
  });
}

/** Clear the replay marker only after the replacement host accepted a drain. */
export async function clearStagedPendingHsrTurns(bee: string): Promise<void> {
  await rm(recoveryReplayDir(bee), { recursive: true, force: true });
}

export type StagedPendingTurnDrain = (bee: string) => Promise<number>;

async function drainReplacementHost(bee: string): Promise<number> {
  const meta = await readHsrMetaStrict(bee);
  if (!meta || meta.status !== "running" || !meta.controlSocket) {
    throw new Error(`HSR bee ${bee} has no running replacement host to drain recovered turns`);
  }
  const client = await connectRpcClient(meta.controlSocket);
  try {
    const response = await client.call("drainPending") as { delivered?: unknown };
    return typeof response?.delivered === "number" ? response.delivered : 0;
  } finally {
    client.close();
  }
}

/**
 * Restore + ask the replacement host to drain + clear the marker. The marker
 * is deliberately cleared LAST. If the daemon dies anywhere earlier, the
 * next pass repeats the host RPC, whose delivery-id gate makes that safe.
 */
export async function drainStagedPendingHsrTurns(
  bee: string,
  drain: StagedPendingTurnDrain = drainReplacementHost,
): Promise<number> {
  const staged = await restorePendingHsrTurnsAfterRecovery(bee);
  if (!staged) return 0;
  const delivered = await drain(bee);
  await clearStagedPendingHsrTurns(bee);
  return delivered;
}

/** True while at least one durable turn still awaits a successful boundary. */
export async function hasPendingHsrTurns(bee: string): Promise<boolean> {
  return (await readPendingHsrTurns(bee)).length > 0;
}

/** Ack one journaled turn after a completed, non-auth-failed provider turn. */
export async function removePendingHsrTurn(bee: string, filename: string): Promise<void> {
  if (basename(filename) !== filename || !filename.endsWith(".json")) {
    throw new Error("invalid pending HSR turn filename");
  }
  await rm(join(pendingTurnsDir(bee), filename), { force: true });
}

/**
 * Drain queued turns in creation order. Caller must hold the delivery lock.
 * The file stays after `send` accepts it. The host removes it only after a
 * completed turn without a login-required auth error, so an expired in-memory
 * token cannot silently consume the operator's prompt. A host crash or auth
 * recovery re-drains the same file with at-least-once semantics.
 */
export async function drainPendingHsrTurns(
  bee: string,
  send: (turn: PendingHsrTurn) => Promise<void>,
): Promise<number> {
  const turns = await readPendingHsrTurns(bee);
  let delivered = 0;
  for (const turn of turns) {
    await send(turn);
    delivered += 1;
  }
  return delivered;
}

/**
 * Enqueue a turn for a host that may not have published its meta.json yet.
 *
 * spawnBee returns without waiting for the detached host's cold start, so a
 * bee's first prompt routinely arrives BEFORE meta.json exists. Under the
 * delivery lock, a missing or "queued" meta means the host's queued→running
 * drain has not run yet (the running flip and the drain share this same lock —
 * host.ts), so a turn persisted here is guaranteed to be picked up. Returns
 * false when the host is past booting (running/exited) or provably dead — the
 * caller then falls back to the live-send path or its normal error.
 */
export async function enqueueTurnForBootingHsrHost(
  bee: string,
  hostPid: number | undefined,
  text: string,
  hostFingerprint?: ProcessBirthFingerprint,
  processIdentityReader?: ProcessIdentityReader,
): Promise<boolean> {
  return withHsrTurnDeliveryLock(bee, async () => {
    const meta = await readHsrMeta(bee);
    if (meta) {
      if (
        meta.status !== "queued" ||
        await inspectProcessBirth(meta.hostPid, meta.hostFingerprint, processIdentityReader) !== "match"
      ) return false;
      await enqueuePendingHsrTurn(bee, text);
      return true;
    }
    if (
      hostPid === undefined ||
      await inspectProcessBirth(hostPid, hostFingerprint, processIdentityReader) !== "match"
    ) return false;
    await enqueuePendingHsrTurn(bee, text);
    return true;
  });
}

/** Intentional retire/kill cancels prompts that never reached the harness. */
export async function clearPendingHsrTurns(bee: string): Promise<void> {
  await rm(pendingTurnsDir(bee), { recursive: true, force: true });
}
