/**
 * Integration-test helpers: everything runs against fresh OS temp dirs
 * (mkdtemp) — session logs, stores, all of it. Never ~/.hive, never the repo.
 * The only executable ever spawned is the stub agent (test-agent/agent.mjs).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HsrDriver, type SpawnSpec } from "../src/index.ts";
import { stubAdapter } from "../../adapters/src/index.ts";
import type { DriverObservation } from "../../harness/src/driver.ts";
import type { FlagEvidence } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_PATH = join(here, "..", "test-agent", "agent.mjs");

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TestRig {
  dir: string;
  driver: HsrDriver;
  /** Per-bee env overrides for the stub agent (set before start()). */
  agentEnv: Map<string, Record<string, string>>;
  cleanup: () => void;
}

export function makeRig(opts: { stopKillGraceMs?: number } = {}): TestRig {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-driver-"));
  const agentEnv = new Map<string, Record<string, string>>();
  const driver = new HsrDriver({
    sessionLogDir: join(dir, "logs"),
    stopKillGraceMs: opts.stopKillGraceMs ?? 400,
    resolve(beeId: string): SpawnSpec {
      return {
        adapter: stubAdapter,
        command: process.execPath,
        args: [AGENT_PATH],
        cwd: dir,
        env: { ...process.env, STUB_TURN_MS: "5", ...(agentEnv.get(beeId) ?? {}) },
      };
    },
  });
  return {
    dir,
    driver,
    agentEnv,
    cleanup: () => {
      driver.disposeAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Accumulate drained observations until `pred` holds or `timeoutMs` passes. */
export async function drainUntil(
  driver: HsrDriver,
  pred: (events: DriverObservation[]) => boolean,
  timeoutMs = 4000,
): Promise<DriverObservation[]> {
  const acc: DriverObservation[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    acc.push(...driver.observe());
    if (pred(acc)) return acc;
    if (Date.now() > deadline) {
      throw new Error(`drainUntil timeout; saw: ${JSON.stringify(acc)}`);
    }
    await sleep(10);
  }
}

/** Accumulate drained flag evidence until `pred` holds or `timeoutMs` passes. */
export async function drainEvidenceUntil(
  driver: HsrDriver,
  pred: (evidence: FlagEvidence[]) => boolean,
  timeoutMs = 4000,
): Promise<FlagEvidence[]> {
  const acc: FlagEvidence[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    acc.push(...driver.observeEvidence());
    if (pred(acc)) return acc;
    if (Date.now() > deadline) {
      throw new Error(`drainEvidenceUntil timeout; saw: ${JSON.stringify(acc)}`);
    }
    await sleep(10);
  }
}

export function ofKind(events: DriverObservation[], kind: DriverObservation["kind"]): DriverObservation[] {
  return events.filter((e) => e.kind === kind);
}

/** True while the OS still knows the pid (signal 0 probe; EPERM counts as alive). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
