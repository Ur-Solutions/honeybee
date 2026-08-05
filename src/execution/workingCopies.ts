// Node-local working-copy registry for `explicit` placement (H1 slice).
//
// The protocol is path-free: Apiary places by `workingCopyId`, never by path.
// This registry is the node-private id -> locator mapping that makes an
// ExplicitWorkingCopyRef honest on this node, plus durable per-Run occupancy
// (RFC §13: occupancy is claimed durably for the Run and released
// idempotently). One JSON doc at `<executionRoot()>/working-copies.json`;
// every mutation is lock -> read -> mutate -> atomic write.
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { atomicWriteFile } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { ensureExecutionRoot, executionRoot } from "./nodeState.js";
import { executionError } from "./errors.js";

export type WorkingCopyRecord = {
  workingCopyId: string;
  productId: string;
  /** Node-private absolute path (never crosses the protocol boundary). */
  path: string;
  /** ProductSnapshotRef digest this copy materializes; run.start proves the leased snapshot against it. */
  snapshotDigest: string;
  origin?: string;
  revision?: string;
  branch?: string;
  registeredAt: string;
  /** Durable occupancy claim; absent = vacant. */
  occupancy?: { claimedByRunId: string; claimedAt: string };
};

type WorkingCopyFile = { version: 1; copies: WorkingCopyRecord[] };

function registryPath(): string {
  return join(executionRoot(), "working-copies.json");
}

function lockPath(): string {
  return join(executionRoot(), ".working-copies.lock");
}

/**
 * Read the registry. Absent (ENOENT) means an honestly empty registry; a
 * corrupt or unknown-version file fails closed — overwriting it on the next
 * mutation would silently discard durable occupancy claims.
 */
async function readRegistry(): Promise<WorkingCopyFile> {
  let raw: string;
  try {
    raw = await readFile(registryPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, copies: [] };
    throw executionError("AUTHORITY_UNAVAILABLE", `working-copy registry is unreadable: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const doc = parsed as Record<string, unknown> | null;
  if (!doc || doc.version !== 1 || !Array.isArray(doc.copies)) {
    throw executionError(
      "AUTHORITY_UNAVAILABLE",
      `working-copy registry at ${registryPath()} is corrupt or has an unknown version; refusing to overwrite it — restore or explicitly remove it`,
    );
  }
  return doc as unknown as WorkingCopyFile;
}

async function mutateRegistry<T>(mutate: (file: WorkingCopyFile) => T): Promise<T> {
  await ensureExecutionRoot();
  return withFileLock(lockPath(), async () => {
    const file = await readRegistry();
    const outcome = mutate(file);
    await atomicWriteFile(registryPath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    return outcome;
  });
}

export type RegisterWorkingCopyInput = {
  workingCopyId: string;
  productId: string;
  path: string;
  snapshotDigest: string;
  origin?: string;
  revision?: string;
  branch?: string;
};

/** The identity-bearing content of a registration, for idempotence checks. */
function contentOf(record: Pick<WorkingCopyRecord, "productId" | "path" | "snapshotDigest" | "origin" | "revision" | "branch">): string {
  return JSON.stringify([
    record.productId,
    record.path,
    record.snapshotDigest,
    record.origin ?? null,
    record.revision ?? null,
    record.branch ?? null,
  ]);
}

/**
 * Register a node-local working copy. Idempotent BY CONTENT on workingCopyId:
 * re-registering identical content is a no-op; the same id with different
 * content is a typed conflict — an id can never be silently redirected to a
 * different path/product (especially not while occupied). The path must be an
 * absolute node-local path.
 */
export async function registerWorkingCopy(input: RegisterWorkingCopyInput): Promise<WorkingCopyRecord> {
  return (await registerWorkingCopyIdempotent(input)).record;
}

export type RegisterWorkingCopyOutcome = { record: WorkingCopyRecord; outcome: "created" | "replayed" };

/** registerWorkingCopy, reporting whether this call created the record or replayed an identical one. */
export async function registerWorkingCopyIdempotent(input: RegisterWorkingCopyInput): Promise<RegisterWorkingCopyOutcome> {
  if (!input.workingCopyId || !input.productId || !input.path) {
    throw new Error("registerWorkingCopy: workingCopyId, productId, and path are required");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.snapshotDigest ?? "")) {
    throw new Error("registerWorkingCopy: snapshotDigest must be a sha256:<hex> ProductSnapshotRef digest");
  }
  if (!isAbsolute(input.path)) {
    throw new Error(`registerWorkingCopy: path must be an absolute node-local path, got ${input.path}`);
  }
  const normalized: RegisterWorkingCopyInput = { ...input, path: normalize(input.path) };
  return mutateRegistry((file) => {
    const existing = file.copies.find((copy) => copy.workingCopyId === normalized.workingCopyId);
    if (existing) {
      if (contentOf(existing) === contentOf(normalized)) return { record: existing, outcome: "replayed" as const };
      throw executionError(
        "IDEMPOTENCY_CONFLICT",
        `working copy ${normalized.workingCopyId} is already registered with different content`,
        { workingCopyId: normalized.workingCopyId, ...(existing.occupancy ? { claimedByRunId: existing.occupancy.claimedByRunId } : {}) },
      );
    }
    const record: WorkingCopyRecord = {
      workingCopyId: normalized.workingCopyId,
      productId: normalized.productId,
      path: normalized.path,
      snapshotDigest: normalized.snapshotDigest,
      ...(normalized.origin !== undefined ? { origin: normalized.origin } : {}),
      ...(normalized.revision !== undefined ? { revision: normalized.revision } : {}),
      ...(normalized.branch !== undefined ? { branch: normalized.branch } : {}),
      registeredAt: new Date().toISOString(),
    };
    file.copies.push(record);
    return { record, outcome: "created" as const };
  });
}

export async function readWorkingCopy(workingCopyId: string): Promise<WorkingCopyRecord | null> {
  const file = await readRegistry();
  return file.copies.find((copy) => copy.workingCopyId === workingCopyId) ?? null;
}

/**
 * Durably claim a working copy for one Run. Idempotent for the same runId; a
 * copy claimed by another Run is MATERIALIZATION_FAILED (never silently
 * shared), and an unknown id is MATERIALIZATION_FAILED (the node cannot invent
 * a placement the client never registered).
 */
export async function claimWorkingCopy(workingCopyId: string, runId: string): Promise<WorkingCopyRecord> {
  return mutateRegistry((file) => {
    const record = file.copies.find((copy) => copy.workingCopyId === workingCopyId);
    if (!record) {
      throw executionError("MATERIALIZATION_FAILED", `working copy ${workingCopyId} is not registered on this node`);
    }
    if (record.occupancy && record.occupancy.claimedByRunId !== runId) {
      throw executionError(
        "MATERIALIZATION_FAILED",
        `working copy ${workingCopyId} is occupied by run ${record.occupancy.claimedByRunId}`,
        { workingCopyId, claimedByRunId: record.occupancy.claimedByRunId },
      );
    }
    if (!record.occupancy) {
      record.occupancy = { claimedByRunId: runId, claimedAt: new Date().toISOString() };
    }
    return record;
  });
}

/** Idempotently release a Run's claim (no-op when vacant or claimed by another Run). */
export async function releaseWorkingCopy(workingCopyId: string, runId: string): Promise<void> {
  await mutateRegistry((file) => {
    const record = file.copies.find((copy) => copy.workingCopyId === workingCopyId);
    if (record?.occupancy?.claimedByRunId === runId) delete record.occupancy;
  });
}
