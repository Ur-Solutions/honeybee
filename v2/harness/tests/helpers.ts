import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { formatViolation, type SimResult } from "../src/index.ts";

/**
 * All simulations run against SQLite files inside fresh OS temp dirs — never a
 * real store and never anything under ~/.hive.
 */
export interface TmpDirs {
  dbPath: (name: string) => string;
  cleanup: () => void;
}

export function tmpDirs(): TmpDirs {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-harness-"));
  return {
    dbPath: (name: string) => join(dir, `${name}.sqlite3`),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Profiles (spec Q2): the fast profile is the CI gate (`npm run v2:harness`);
 * HARNESS_PROFILE=long runs the large seed batch (`npm run v2:harness:long`).
 */
export const LONG = process.env.HARNESS_PROFILE === "long";

/** Seed batch for a test: fast seeds always, long seeds appended on the long profile. */
export function seeds(fast: number[], long: number[]): number[] {
  return LONG ? [...fast, ...long] : fast;
}

/** Step-count scale factor for the long profile. */
export function scaleSteps(steps: number): number {
  return LONG ? steps * 3 : steps;
}

/**
 * Assert a run produced zero violations; on failure, print the violation
 * ledger (seed + op log tail as structured one-liners) for deterministic
 * reproduction, per the spec's replayability requirement.
 */
export function assertClean(result: SimResult): void {
  if (result.violations.length > 0) {
    for (const v of result.violations) console.error(formatViolation(v));
  }
  assert.equal(
    result.violations.length,
    0,
    `seed ${result.seed}: ${result.violations.length} invariant violation(s) — ledger printed above`,
  );
}
