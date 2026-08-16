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
import { join } from "node:path";
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
  updatedAt: string;
  mode: "turn" | "next-tool";
  phase: "queued" | "dispatching" | "accepted" | "started" | "auth_failed" | "completed" | "ambiguous" | "discarded";
  host?: PendingHsrTurnHost;
  error?: string;
  /** Run-dir-local filename; never persisted inside the JSON payload. */
  filename: string;
};

export type PendingHsrTurnHost = {
  hostPid: number;
  startedAt: string;
  hostFingerprint?: ProcessBirthFingerprint;
};

export type PendingHsrDeliveryDecision = {
  action: "dispatch" | "settled";
  turn: PendingHsrTurn;
};

export class HsrDeliveryAmbiguousError extends Error {
  readonly code = "HIVE_HSR_DELIVERY_AMBIGUOUS";

  constructor(readonly deliveryId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HsrDeliveryAmbiguousError";
  }
}

export class HsrDeliveryInFlightError extends Error {
  readonly code = "HIVE_HSR_DELIVERY_IN_FLIGHT";

  constructor(readonly deliveryId: string, message: string) {
    super(message);
    this.name = "HsrDeliveryInFlightError";
  }
}

export class HsrDeliveryIdentityConflictError extends Error {
  readonly code = "HIVE_HSR_DELIVERY_ID_CONFLICT";

  constructor(readonly deliveryId: string, message: string) {
    super(message);
    this.name = "HsrDeliveryIdentityConflictError";
  }
}

export class HsrDeliveryDiscardedError extends Error {
  readonly code = "HIVE_HSR_DELIVERY_DISCARDED";

  constructor(readonly deliveryId: string, message: string) {
    super(message);
    this.name = "HsrDeliveryDiscardedError";
  }
}

export function isHsrDeliveryAmbiguous(error: unknown): boolean {
  return error instanceof HsrDeliveryAmbiguousError ||
    (error as { code?: unknown } | null | undefined)?.code === "HIVE_HSR_DELIVERY_AMBIGUOUS";
}

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

/**
 * Terminal delivery ownership that must outlive an explicit HSR run-dir
 * purge while an external Buz queue item can still reference the same id.
 */
function retainedTurnReceiptsDir(bee: string): string {
  const beeKey = createHash("sha256").update(bee).digest("hex");
  return join(storeRoot(), "hsr-delivery-receipts", beeKey);
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

function turnKey(deliveryId: string): string {
  return createHash("sha256").update(deliveryId).digest("hex");
}

function pendingTurnStateLockPath(bee: string, deliveryId: string): string {
  const beeKey = createHash("sha1").update(hsrRunDir(bee)).digest("hex");
  return join(storeRoot(), "locks", "hsr-turn-state", beeKey, `${turnKey(deliveryId)}.lock`);
}

function deterministicTurnFilename(deliveryId: string): string {
  return `delivery-${turnKey(deliveryId)}.json`;
}

/** Serialize queued writes against the host's queued -> running drain. */
export function withHsrTurnDeliveryLock<T>(bee: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(deliveryLockPath(bee), fn, { timeoutMs: 30_000 });
}

/** Persist one turn without waiting for the harness to finish cold-starting. */
export async function enqueuePendingHsrTurn(
  bee: string,
  text: string,
  options: { deliveryId?: string; mode?: "turn" | "next-tool" } = {},
): Promise<PendingHsrTurn> {
  const id = options.deliveryId ?? randomUUID();
  if (!id || id.length > 1_024) throw new Error("pending HSR delivery id must be 1..1024 characters");
  const mode = options.mode ?? "turn";
  const existing = (await readPendingHsrTurns(bee)).find((turn) => turn.id === id);
  if (existing) {
    if (existing.text !== text || existing.mode !== mode) {
      throw new HsrDeliveryIdentityConflictError(
        id,
        `HSR delivery id ${id} is already bound to different content or delivery mode`,
      );
    }
    return existing;
  }
  const queuedAt = new Date().toISOString();
  const payload = { id, text, queuedAt, updatedAt: queuedAt, mode, phase: "queued" as const };
  const dir = pendingTurnsDir(bee);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // A caller-provided Buz id maps to one stable journal pathname. Delivery
  // order comes from queuedAt below, not the hash-shaped filename.
  const filename = deterministicTurnFilename(id);
  try {
    const collision = JSON.parse(await readFile(join(dir, filename), "utf8")) as Partial<PendingHsrTurn>;
    if (collision.id !== id || collision.text !== text || (collision.mode ?? "turn") !== mode) {
      throw new HsrDeliveryIdentityConflictError(id, `HSR delivery id ${id} collided with a different journal record`);
    }
    return normalizePendingTurn(collision, filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWriteFile(join(dir, filename), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  return { ...payload, filename };
}

const PENDING_PHASES = new Set<PendingHsrTurn["phase"]>([
  "queued",
  "dispatching",
  "accepted",
  "started",
  "auth_failed",
  "completed",
  "ambiguous",
  "discarded",
]);

function validHost(value: unknown): value is PendingHsrTurnHost {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const host = value as Partial<PendingHsrTurnHost>;
  if (!Number.isSafeInteger(host.hostPid) || (host.hostPid ?? 0) <= 0 || typeof host.startedAt !== "string") return false;
  if (host.hostFingerprint === undefined) return true;
  return !!host.hostFingerprint &&
    typeof host.hostFingerprint === "object" &&
    Number.isSafeInteger(host.hostFingerprint.pgid) &&
    host.hostFingerprint.pgid > 0 &&
    typeof host.hostFingerprint.startedAt === "string";
}

function normalizePendingTurn(parsed: Partial<PendingHsrTurn>, filename: string): PendingHsrTurn {
  if (typeof parsed.id !== "string" || typeof parsed.text !== "string" || typeof parsed.queuedAt !== "string") {
    throw new Error(`malformed pending HSR turn journal: ${filename}`);
  }
  const phase = parsed.phase === undefined
    ? "queued"
    : typeof parsed.phase === "string" && PENDING_PHASES.has(parsed.phase as PendingHsrTurn["phase"])
      ? parsed.phase as PendingHsrTurn["phase"]
      : null;
  if (!phase) throw new Error(`malformed pending HSR turn ${filename}: unknown phase`);
  const mode = parsed.mode === undefined
    ? "turn"
    : parsed.mode === "turn" || parsed.mode === "next-tool"
      ? parsed.mode
      : null;
  if (!mode) throw new Error(`malformed pending HSR turn ${filename}: unknown delivery mode`);
  const host = validHost(parsed.host) ? parsed.host : undefined;
  if ((phase === "dispatching" || phase === "accepted" || phase === "started" || phase === "auth_failed") && !host) {
    throw new Error(`malformed pending HSR turn ${filename}: phase ${phase} has no host incarnation`);
  }
  return {
    id: parsed.id,
    text: parsed.text,
    queuedAt: parsed.queuedAt,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : parsed.queuedAt,
    mode,
    phase,
    ...(host ? { host } : {}),
    ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    filename,
  };
}

async function readTurnsFromDir(dir: string): Promise<PendingHsrTurn[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    // A missing directory is the only proof that no delivery ownership exists.
    // Permission, I/O, and shape failures must fence later work rather than be
    // misread as an empty journal.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `could not enumerate pending HSR turn journals in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const files = entries.filter((name) => name.endsWith(".json")).sort();
  const turns: PendingHsrTurn[] = [];
  for (const filename of files) {
    const path = join(dir, filename);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PendingHsrTurn>;
      turns.push(normalizePendingTurn(parsed, filename));
    } catch (error) {
      // A delivery journal is ownership evidence. Corruption must fence later
      // work rather than being auto-deleted and silently re-used.
      throw new Error(`could not read pending HSR turn ${filename}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return turns.sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.filename.localeCompare(right.filename));
}

/** Read journaled turns in delivery order without exposing their contents in diagnostics. */
export async function readPendingHsrTurns(bee: string): Promise<PendingHsrTurn[]> {
  const active = await readTurnsFromDir(pendingTurnsDir(bee));
  const retained = await readTurnsFromDir(retainedTurnReceiptsDir(bee));
  const byId = new Map<string, PendingHsrTurn>();
  for (const turn of [...active, ...retained]) {
    const existing = byId.get(turn.id);
    if (!existing) {
      byId.set(turn.id, turn);
      continue;
    }
    const immutable = ({ id, text, queuedAt, mode, host }: PendingHsrTurn) => ({ id, text, queuedAt, mode, host });
    if (JSON.stringify(immutable(existing)) !== JSON.stringify(immutable(turn))) {
      throw new Error(`conflicting durable HSR delivery receipts for ${turn.id}`);
    }
    if (existing.phase === turn.phase) {
      byId.set(turn.id, existing.updatedAt >= turn.updatedAt ? existing : turn);
      continue;
    }
    // Reconciliation may crash between rewriting the active and retained
    // copies. A terminal operator verdict is a monotonic successor of the
    // exact same ambiguity; select it so a retry can finish the other copy.
    const phases = new Set([existing.phase, turn.phase]);
    if (phases.has("ambiguous") && phases.has("completed")) {
      byId.set(turn.id, existing.phase === "completed" ? existing : turn);
      continue;
    }
    if (phases.has("ambiguous") && phases.has("discarded")) {
      byId.set(turn.id, existing.phase === "discarded" ? existing : turn);
      continue;
    }
    throw new Error(`conflicting durable HSR delivery phases for ${turn.id}: ${existing.phase} vs ${turn.phase}`);
  }
  return [...byId.values()].sort((left, right) =>
    left.queuedAt.localeCompare(right.queuedAt) || left.filename.localeCompare(right.filename));
}

export async function readPendingHsrTurn(bee: string, deliveryId: string): Promise<PendingHsrTurn | null> {
  return (await readPendingHsrTurns(bee)).find((turn) => turn.id === deliveryId) ?? null;
}

export type PendingHsrTurnCancellation =
  | { cancelled: true }
  | { cancelled: false; turn: PendingHsrTurn | null };

/**
 * Cancel a caller offer only while the host has provably not claimed it.
 * The per-id lock linearizes removal against queued -> dispatching: either the
 * file disappears first and the host cannot send, or the host claim wins and
 * its durable ownership is returned to the caller for fail-closed handling.
 */
export async function cancelPendingHsrTurnIfQueued(
  bee: string,
  deliveryId: string,
): Promise<PendingHsrTurnCancellation> {
  return withFileLock(pendingTurnStateLockPath(bee, deliveryId), async () => {
    const current = await readPendingHsrTurn(bee, deliveryId);
    if (!current || current.phase !== "queued") return { cancelled: false, turn: current };
    await rm(join(pendingTurnsDir(bee), current.filename));
    return { cancelled: true };
  }, { timeoutMs: 30_000 });
}

function sameHost(left: PendingHsrTurnHost | undefined, right: PendingHsrTurnHost): boolean {
  if (!left || left.hostPid !== right.hostPid || left.startedAt !== right.startedAt) return false;
  if (!left.hostFingerprint || !right.hostFingerprint) return false;
  return left.hostFingerprint.pgid === right.hostFingerprint.pgid &&
    left.hostFingerprint.startedAt === right.hostFingerprint.startedAt;
}

async function writePendingHsrTurn(bee: string, turn: PendingHsrTurn): Promise<void> {
  const { filename, ...payload } = turn;
  await atomicWriteFile(join(pendingTurnsDir(bee), filename), `${JSON.stringify(payload)}\n`, { mode: 0o600 });
}

async function mutatePendingHsrTurn<T>(
  bee: string,
  deliveryId: string,
  mutate: (current: PendingHsrTurn) => Promise<{ turn: PendingHsrTurn; result: T }> | { turn: PendingHsrTurn; result: T },
): Promise<T> {
  return withFileLock(pendingTurnStateLockPath(bee, deliveryId), async () => {
    const current = await readPendingHsrTurn(bee, deliveryId);
    if (!current) throw new Error(`HSR delivery ${deliveryId} has no durable pending-turn record`);
    let changed: { turn: PendingHsrTurn; result: T };
    try {
      changed = await mutate(current);
    } catch (error) {
      if (error instanceof PersistedTransitionError) {
        await writePendingHsrTurn(bee, error.turn);
        throw error.original;
      }
      throw error;
    }
    if (JSON.stringify(changed.turn) !== JSON.stringify(current)) await writePendingHsrTurn(bee, changed.turn);
    return changed.result;
  }, { timeoutMs: 30_000 });
}

function assertTurnIdentity(
  turn: PendingHsrTurn,
  text: string,
  mode: PendingHsrTurn["mode"],
): void {
  if (turn.text !== text || turn.mode !== mode) {
    throw new HsrDeliveryIdentityConflictError(
      turn.id,
      `HSR delivery id ${turn.id} is already bound to different content or delivery mode`,
    );
  }
}

async function preparePendingHsrDelivery(
  bee: string,
  deliveryId: string,
  text: string,
  mode: PendingHsrTurn["mode"],
  host: PendingHsrTurnHost,
): Promise<PendingHsrDeliveryDecision> {
  return mutatePendingHsrTurn<PendingHsrDeliveryDecision>(bee, deliveryId, (current) => {
    assertTurnIdentity(current, text, mode);
    if (current.phase === "completed") return { turn: current, result: { action: "settled", turn: current } };
    if (current.phase === "discarded") {
      throw new HsrDeliveryDiscardedError(deliveryId, `HSR delivery ${deliveryId} was explicitly discarded`);
    }
    if (current.phase === "ambiguous") {
      throw new HsrDeliveryAmbiguousError(deliveryId, current.error ?? `HSR delivery ${deliveryId} is durably ambiguous`);
    }
    if (current.phase === "accepted" || current.phase === "started") {
      if (sameHost(current.host, host)) return { turn: current, result: { action: "settled", turn: current } };
      const next: PendingHsrTurn = {
        ...current,
        phase: "ambiguous",
        updatedAt: new Date().toISOString(),
        error: `HSR delivery ${deliveryId} reached ${current.phase} on a prior host incarnation; provider outcome is ambiguous`,
      };
      throwAfterPersist(next, new HsrDeliveryAmbiguousError(deliveryId, next.error!));
    }
    if (current.phase === "dispatching") {
      if (!sameHost(current.host, host)) {
        const next: PendingHsrTurn = {
          ...current,
          phase: "ambiguous",
          updatedAt: new Date().toISOString(),
          error: `HSR delivery ${deliveryId} crossed dispatch on a prior host incarnation; provider acceptance is ambiguous`,
        };
        throwAfterPersist(next, new HsrDeliveryAmbiguousError(deliveryId, next.error!));
      }
      // The host is the only authority allowed to write dispatching. Seeing
      // the same-host phase again therefore means another handler already
      // owns (or owned) the provider call; replaying here would double-send.
      throw new HsrDeliveryInFlightError(deliveryId, `HSR delivery ${deliveryId} is already dispatching on this host`);
    }
    // queued and auth_failed are the only replayable phases. Auth recovery
    // retains the exact id/text and merely binds it to the replacement host.
    const next: PendingHsrTurn = {
      ...current,
      phase: "dispatching",
      host,
      updatedAt: new Date().toISOString(),
    };
    delete next.error;
    return { turn: next, result: { action: "dispatch", turn: next } };
  });
}

class PersistedTransitionError extends Error {
  constructor(readonly turn: PendingHsrTurn, readonly original: Error) {
    super(original.message, { cause: original });
  }
}

function throwAfterPersist(turn: PendingHsrTurn, error: Error): never {
  throw new PersistedTransitionError(turn, error);
}

/** Atomically claim a queued/replayable record inside the exact live host. */
export async function claimPendingHsrTurnOnHost(
  bee: string,
  deliveryId: string,
  text: string,
  mode: PendingHsrTurn["mode"],
  host: PendingHsrTurnHost,
): Promise<PendingHsrDeliveryDecision> {
  try {
    return await preparePendingHsrDelivery(bee, deliveryId, text, mode, host);
  } catch (error) {
    if (error instanceof PersistedTransitionError) {
      await writePendingHsrTurn(bee, error.turn);
      throw error.original;
    }
    throw error;
  }
}

async function advancePendingHsrTurn(
  bee: string,
  deliveryId: string,
  host: PendingHsrTurnHost,
  phase: "accepted" | "started" | "auth_failed" | "completed" | "ambiguous",
  error?: string,
): Promise<PendingHsrTurn> {
  return mutatePendingHsrTurn(bee, deliveryId, (current) => {
    if (current.phase === "completed" || current.phase === "auth_failed" || current.phase === "ambiguous" || current.phase === "discarded") {
      return { turn: current, result: current };
    }
    if (!sameHost(current.host, host)) {
      throw new HsrDeliveryAmbiguousError(
        deliveryId,
        `HSR delivery ${deliveryId} cannot be advanced by a different host incarnation`,
      );
    }
    const allowed = phase === "accepted"
      ? current.phase === "dispatching"
      : phase === "started"
        ? current.phase === "dispatching" || current.phase === "accepted"
        : current.phase === "dispatching" || current.phase === "accepted" || current.phase === "started";
    if (!allowed) return { turn: current, result: current };
    const next: PendingHsrTurn = {
      ...current,
      phase,
      updatedAt: new Date().toISOString(),
      ...(phase === "ambiguous" && error ? { error } : {}),
    };
    if (phase !== "ambiguous") delete next.error;
    return { turn: next, result: next };
  });
}

export const markPendingHsrTurnAccepted = (bee: string, id: string, host: PendingHsrTurnHost) =>
  advancePendingHsrTurn(bee, id, host, "accepted");
export const markPendingHsrTurnStarted = (bee: string, id: string, host: PendingHsrTurnHost) =>
  advancePendingHsrTurn(bee, id, host, "started");
export const markPendingHsrTurnAuthFailed = (bee: string, id: string, host: PendingHsrTurnHost) =>
  advancePendingHsrTurn(bee, id, host, "auth_failed");
export const markPendingHsrTurnCompleted = (bee: string, id: string, host: PendingHsrTurnHost) =>
  advancePendingHsrTurn(bee, id, host, "completed");
export const markPendingHsrTurnAmbiguous = (bee: string, id: string, host: PendingHsrTurnHost, error: string) =>
  advancePendingHsrTurn(bee, id, host, "ambiguous", error);

async function readRecoveryReplayManifest(bee: string): Promise<StagedPendingHsrTurns | null> {
  let raw: string;
  try {
    raw = await readFile(recoveryReplayManifestPath(bee), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `could not read HSR recovery replay manifest for ${bee}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let parsed: Partial<StagedPendingHsrTurns>;
  try {
    parsed = JSON.parse(raw) as Partial<StagedPendingHsrTurns>;
  } catch (error) {
    throw new Error(`malformed HSR recovery replay manifest for ${bee}`, { cause: error });
  }
  if (
    parsed.version !== RECOVERY_REPLAY_VERSION ||
    parsed.bee !== bee ||
    typeof parsed.episodeId !== "string" ||
    parsed.episodeId.length === 0 ||
    typeof parsed.stagedAt !== "string" ||
    (parsed.restoredAt !== undefined && typeof parsed.restoredAt !== "string") ||
    !Array.isArray(parsed.turns) ||
    !parsed.turns.every((turn): turn is StagedPendingHsrTurns["turns"][number] =>
      !!turn &&
      typeof turn === "object" &&
      typeof turn.id === "string" &&
      turn.id.length > 0 &&
      typeof turn.filename === "string" &&
      turn.filename === deterministicTurnFilename(turn.id) &&
      typeof turn.queuedAt === "string")
  ) {
    throw new Error(`malformed HSR recovery replay manifest for ${bee}`);
  }
  return {
    version: RECOVERY_REPLAY_VERSION,
    bee,
    episodeId: parsed.episodeId,
    stagedAt: parsed.stagedAt,
    ...(parsed.restoredAt !== undefined ? { restoredAt: parsed.restoredAt } : {}),
    turns: parsed.turns,
  };
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
    // Retained terminal receipts live outside the ephemeral run dir and are
    // never replay payloads. Stage only active run-dir journals.
    for (const turn of await readTurnsFromDir(pendingTurnsDir(bee))) {
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
  let delivered: number;
  try {
    delivered = await drain(bee);
  } catch (error) {
    const ambiguous = (await readPendingHsrTurns(bee)).find((turn) => turn.phase === "ambiguous");
    if (ambiguous) {
      throw new HsrDeliveryAmbiguousError(
        ambiguous.id,
        ambiguous.error ?? `HSR delivery ${ambiguous.id} became ambiguous during recovery drain`,
        { cause: error },
      );
    }
    throw error;
  }
  const ambiguous = (await readPendingHsrTurns(bee)).find((turn) => turn.phase === "ambiguous");
  if (ambiguous) {
    throw new HsrDeliveryAmbiguousError(
      ambiguous.id,
      ambiguous.error ?? `HSR delivery ${ambiguous.id} became ambiguous during recovery drain`,
    );
  }
  await clearStagedPendingHsrTurns(bee);
  return delivered;
}

/** True while at least one durable turn still awaits a successful boundary. */
export async function hasPendingHsrTurns(bee: string): Promise<boolean> {
  return (await readPendingHsrTurns(bee)).some((turn) => turn.phase !== "completed" && turn.phase !== "discarded");
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
    if (turn.phase === "completed" || turn.phase === "discarded") continue;
    if (turn.phase === "ambiguous") {
      throw new HsrDeliveryAmbiguousError(
        turn.id,
        turn.error ?? `HSR delivery ${turn.id} is durably ambiguous`,
      );
    }
    try {
      await send(turn);
    } catch (error) {
      // An old-host dispatch is an ordered manual-action fence. Leave this and
      // every later turn untouched; never let a later prompt overtake it.
      if (isHsrDeliveryAmbiguous(error)) throw error;
      throw error;
    }
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
  options: { deliveryId?: string; mode?: "turn" | "next-tool" } = {},
): Promise<boolean> {
  return withHsrTurnDeliveryLock(bee, async () => {
    const meta = await readHsrMeta(bee);
    if (meta) {
      if (
        meta.status !== "queued" ||
        await inspectProcessBirth(meta.hostPid, meta.hostFingerprint, processIdentityReader) !== "match"
      ) return false;
      await enqueuePendingHsrTurn(bee, text, options);
      return true;
    }
    if (
      hostPid === undefined ||
      await inspectProcessBirth(hostPid, hostFingerprint, processIdentityReader) !== "match"
    ) return false;
    await enqueuePendingHsrTurn(bee, text, options);
    return true;
  });
}

export type IntentionalStopPendingTurnSettlement = {
  cancelledQueued: number;
  retained: PendingHsrTurn[];
};

/**
 * Settle turn ownership after the exact host and child group are proven gone.
 * Only `queued` proves that the host never claimed the provider side effect.
 * A dispatching/accepted/started turn is converted to a durable ambiguity;
 * auth-failed remains replayable with the same id, while completed and prior
 * ambiguity records remain receipts until explicit run purge.
 */
export async function settlePendingHsrTurnsForIntentionalStop(
  bee: string,
): Promise<IntentionalStopPendingTurnSettlement> {
  return withHsrTurnDeliveryLock(bee, async () => {
    let cancelledQueued = 0;
    for (const turn of await readPendingHsrTurns(bee)) {
      if (turn.phase === "queued") {
        await rm(join(pendingTurnsDir(bee), turn.filename));
        cancelledQueued += 1;
        continue;
      }
      if (turn.phase === "dispatching" || turn.phase === "accepted" || turn.phase === "started") {
        await markPendingHsrTurnAmbiguous(
          bee,
          turn.id,
          turn.host!,
          `HSR delivery ${turn.id} reached ${turn.phase} before its exact host was intentionally stopped; provider outcome requires manual reconciliation`,
        );
      }
    }
    return { cancelledQueued, retained: await readPendingHsrTurns(bee) };
  });
}

async function forcePendingHsrTurnAmbiguousForPurge(
  bee: string,
  deliveryId: string,
): Promise<PendingHsrTurn> {
  return mutatePendingHsrTurn(bee, deliveryId, (current) => {
    if (current.phase === "completed" || current.phase === "ambiguous" || current.phase === "discarded") {
      return { turn: current, result: current };
    }
    if (current.phase === "queued") {
      throw new Error(`queued HSR delivery ${deliveryId} must be cancelled before purge preservation`);
    }
    const next: PendingHsrTurn = {
      ...current,
      phase: "ambiguous",
      updatedAt: new Date().toISOString(),
      error: `HSR delivery ${deliveryId} retained ${current.phase} ownership across explicit run purge; provider outcome requires manual reconciliation`,
    };
    return { turn: next, result: next };
  });
}

/**
 * Copy terminal receipts outside hsrRoot BEFORE a destructive run purge.
 * A crash after any copy is idempotent; a read/write conflict aborts purge so
 * the canonical SessionRecord remains the retry handle.
 */
export async function preservePendingHsrTurnReceiptsForPurge(bee: string): Promise<PendingHsrTurn[]> {
  return withHsrTurnDeliveryLock(bee, async () => {
    for (const turn of await readTurnsFromDir(pendingTurnsDir(bee))) {
      if (turn.phase === "queued") {
        await rm(join(pendingTurnsDir(bee), turn.filename));
      } else if (turn.phase !== "completed" && turn.phase !== "ambiguous" && turn.phase !== "discarded") {
        await forcePendingHsrTurnAmbiguousForPurge(bee, turn.id);
      }
    }
    const terminal = await readTurnsFromDir(pendingTurnsDir(bee));
    const receiptDir = retainedTurnReceiptsDir(bee);
    if (terminal.length > 0) await mkdir(receiptDir, { recursive: true, mode: 0o700 });
    for (const turn of terminal) {
      if (turn.phase !== "completed" && turn.phase !== "ambiguous" && turn.phase !== "discarded") {
        throw new Error(`refusing to purge ${bee} with nonterminal HSR delivery ${turn.id} at ${turn.phase}`);
      }
      const target = join(receiptDir, turn.filename);
      try {
        const existing = normalizePendingTurn(JSON.parse(await readFile(target, "utf8")) as Partial<PendingHsrTurn>, turn.filename);
        const comparable = ({ filename: _filename, ...value }: PendingHsrTurn) => value;
        if (JSON.stringify(comparable(existing)) !== JSON.stringify(comparable(turn))) {
          throw new Error(`retained HSR delivery receipt conflict for ${turn.id}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const { filename: _filename, ...payload } = turn;
        await atomicWriteFile(target, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      }
    }
    return readTurnsFromDir(receiptDir);
  });
}

/** Remove a completed receipt only after its external mailbox row is durable. */
export async function clearCompletedPendingHsrTurnReceipt(bee: string, deliveryId: string): Promise<boolean> {
  return withFileLock(pendingTurnStateLockPath(bee, deliveryId), async () => {
    const current = await readPendingHsrTurn(bee, deliveryId);
    if (!current) return false;
    if (current.phase !== "completed") {
      throw new Error(`refusing to clear non-completed HSR delivery receipt ${deliveryId} at ${current.phase}`);
    }
    const filename = deterministicTurnFilename(deliveryId);
    await rm(join(pendingTurnsDir(bee), filename), { force: true });
    await rm(join(retainedTurnReceiptsDir(bee), filename), { force: true });
    return true;
  }, { timeoutMs: 30_000 });
}

/** Operator proof that an ambiguous provider effect did in fact complete. */
export async function markAmbiguousPendingHsrTurnReceiptCompleted(
  bee: string,
  deliveryId: string,
): Promise<PendingHsrTurn> {
  return withFileLock(pendingTurnStateLockPath(bee, deliveryId), async () => {
    const current = await readPendingHsrTurn(bee, deliveryId);
    if (!current) throw new Error(`HSR delivery ${deliveryId} has no durable receipt`);
    if (current.phase !== "ambiguous" && current.phase !== "completed") {
      throw new Error(`refusing delivered reconciliation for HSR delivery ${deliveryId} at ${current.phase}`);
    }
    const next: PendingHsrTurn = {
      ...current,
      phase: "completed",
      updatedAt: current.phase === "completed" ? current.updatedAt : new Date().toISOString(),
    };
    delete next.error;
    const { filename: _filename, ...payload } = next;
    let wrote = false;
    for (const dir of [pendingTurnsDir(bee), retainedTurnReceiptsDir(bee)]) {
      const path = join(dir, next.filename);
      try {
        await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await atomicWriteFile(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      wrote = true;
    }
    if (!wrote) throw new Error(`HSR delivery ${deliveryId} disappeared during delivered reconciliation`);
    return next;
  }, { timeoutMs: 30_000 });
}

/** Operator proof that a matching external work item was durably discarded. */
export async function markAmbiguousPendingHsrTurnReceiptDiscarded(bee: string, deliveryId: string): Promise<PendingHsrTurn> {
  return withFileLock(pendingTurnStateLockPath(bee, deliveryId), async () => {
    const current = await readPendingHsrTurn(bee, deliveryId);
    if (!current) throw new Error(`HSR delivery ${deliveryId} has no durable receipt`);
    if (current.phase !== "ambiguous" && current.phase !== "discarded") {
      throw new Error(`refusing to discard non-ambiguous HSR delivery receipt ${deliveryId} at ${current.phase}`);
    }
    const next: PendingHsrTurn = {
      ...current,
      phase: "discarded",
      updatedAt: current.phase === "discarded" ? current.updatedAt : new Date().toISOString(),
    };
    delete next.error;
    const { filename: _filename, ...payload } = next;
    let wrote = false;
    for (const dir of [pendingTurnsDir(bee), retainedTurnReceiptsDir(bee)]) {
      const path = join(dir, next.filename);
      try {
        await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await atomicWriteFile(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      wrote = true;
    }
    if (!wrote) throw new Error(`HSR delivery ${deliveryId} disappeared during discard reconciliation`);
    return next;
  }, { timeoutMs: 30_000 });
}

/**
 * Turn a transport-accepted receipt into the authoritative manual fence when
 * publishing the caller's SessionRecord/recipient metadata fails. This is a
 * separate authority from the generic delivery-doubt sidecar: either durable
 * write is sufficient to prevent a fresh id from bypassing accepted work.
 *
 * A cold-host offer may still be `queued` with no host identity. Marking that
 * exact offer ambiguous is conservative but sound: the provider has not been
 * proven untouched across the failed caller publication, and operator
 * reconciliation can still settle the immutable id without redelivery.
 */
export async function markPendingHsrTurnPublicationAmbiguous(
  bee: string,
  deliveryId: string,
  detail: string,
): Promise<PendingHsrTurn | null> {
  return withFileLock(pendingTurnStateLockPath(bee, deliveryId), async () => {
    const current = await readPendingHsrTurn(bee, deliveryId);
    if (!current) return null;
    if (current.phase === "discarded") {
      throw new HsrDeliveryDiscardedError(deliveryId, `HSR delivery ${deliveryId} was explicitly discarded`);
    }
    // `completed` is a stronger provider receipt and may exist in both the
    // active and retained directories during purge hand-off. Never demote it
    // copy-by-copy to ambiguous: a crash between writes would be resolved back
    // to completed by the monotonic merge. The caller must retain its generic
    // sidecar or canonical non-runnable fallback for metadata publication
    // doubt instead.
    if (current.phase === "completed") return null;
    const next: PendingHsrTurn = current.phase === "ambiguous"
      ? current
      : {
          ...current,
          phase: "ambiguous",
          updatedAt: new Date().toISOString(),
          error: detail,
        };
    const { filename: _filename, ...payload } = next;
    let wrote = false;
    for (const dir of [pendingTurnsDir(bee), retainedTurnReceiptsDir(bee)]) {
      const path = join(dir, next.filename);
      try {
        await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await atomicWriteFile(path, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      wrote = true;
    }
    if (!wrote) throw new Error(`HSR delivery ${deliveryId} disappeared while publishing its ambiguity fence`);
    return next;
  }, { timeoutMs: 30_000 });
}

/**
 * Source-event persistence failed after the provider could have acted. Convert
 * every nonterminal delivery owned by this run into an explicit manual verdict
 * and copy the resulting receipts outside the disposable run directory. The
 * host sets its in-memory integrity fence before entering this helper, so no
 * new send can race into the set after the snapshot.
 */
export async function ambiguatePendingHsrTurnsForEventIntegrity(
  bee: string,
  detail: string,
): Promise<string[]> {
  const ids = await withHsrTurnDeliveryLock(bee, async () => {
    const unresolved = (await readPendingHsrTurns(bee)).filter((turn) =>
      turn.phase !== "completed" && turn.phase !== "discarded");
    for (const turn of unresolved) {
      await markPendingHsrTurnPublicationAmbiguous(bee, turn.id, detail);
    }
    return unresolved.map((turn) => turn.id);
  });
  // All source records are terminal now, so the purge-preservation helper only
  // performs its idempotent outside-run-dir copies (it cannot cancel/reclassify).
  await preservePendingHsrTurnReceiptsForPurge(bee);
  return ids;
}

/** Explicit run purge removes every receipt after its external owners settle. */
export async function clearPendingHsrTurns(bee: string): Promise<void> {
  await rm(pendingTurnsDir(bee), { recursive: true, force: true });
}
