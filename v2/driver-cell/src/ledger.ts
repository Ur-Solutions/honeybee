/**
 * cell.json — the operation-keyed allocation ledger (WP5, spec 05 point 2).
 *
 * Provisioning is replay-safe: every step records itself in the ledger only
 * AFTER it completed, keyed by the operation id (the command id driving the
 * provisioning). A crash mid-provision leaves an incomplete operation; the
 * replay re-runs from the first unrecorded step, idempotently. Writes are
 * atomic (temp file + rename) so the ledger itself can never be half-written.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CopyMode = "image-cow" | "cow" | "clone";

export interface GitImageRecord {
  repoKey: string;
  generation: string;
}

export interface WarmRecord {
  mode: "cow" | "cold";
  /** Artifact dirs actually copied in (cow) — or why the cell is cold. */
  dirs: string[];
  reason?: string;
}

export interface ProvisionSteps {
  git_placed?: { mode: CopyMode; at: number; image?: GitImageRecord };
  hygiene?: { at: number };
  checkout?: { sha: string; at: number };
  warm?: WarmRecord & { at: number };
}

export interface LedgerOperation {
  startedAt: number;
  completedAt?: number;
  steps: ProvisionSteps;
}

export interface CellLedger {
  version: 1;
  beeId: string;
  origin: string;
  sha: string;
  wrapper: string;
  spaceName: string;
  createdAt: number;
  /** Recorded honestly per spec: how the .git actually arrived. */
  copy_mode?: CopyMode;
  /** Per-cell sandbox override (A4); absent = node-kind default. */
  sandbox?: boolean;
  /** Warm artifact dirs requested at reservation (A5); absent = none. */
  warm?: string[];
  operations: Record<string, LedgerOperation>;
}

export function newLedger(init: {
  beeId: string;
  origin: string;
  sha: string;
  wrapper: string;
  spaceName: string;
  now: number;
  sandbox?: boolean | null;
  warm?: string[];
}): CellLedger {
  return {
    version: 1,
    beeId: init.beeId,
    origin: init.origin,
    sha: init.sha,
    wrapper: init.wrapper,
    spaceName: init.spaceName,
    createdAt: init.now,
    ...(init.sandbox == null ? {} : { sandbox: init.sandbox }),
    ...(init.warm && init.warm.length > 0 ? { warm: [...init.warm] } : {}),
    operations: {},
  };
}

export function readLedger(path: string): CellLedger | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed: unknown = JSON.parse(raw); // a corrupt ledger is a bug — fail loudly
  if (parsed == null || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
    throw new Error(`cell ledger ${path}: unrecognized shape`);
  }
  return parsed as CellLedger;
}

/** Atomic write: temp + rename, so a crash can never leave a torn ledger. */
export function writeLedger(path: string, ledger: CellLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.cell.json.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, path);
}

/** The operation record for `opId`, creating it (in memory) when absent. */
export function operationOf(ledger: CellLedger, opId: string, now: number): LedgerOperation {
  const existing = ledger.operations[opId];
  if (existing) return existing;
  const fresh: LedgerOperation = { startedAt: now, steps: {} };
  ledger.operations[opId] = fresh;
  return fresh;
}

/** Whether ANY operation completed a full provisioning of this cell. */
export function isProvisioned(ledger: CellLedger): boolean {
  return Object.values(ledger.operations).some((op) => op.completedAt != null);
}
