import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type CoreStore, type CoreStoreOptions } from "../src/index.ts";

/**
 * All tests run against SQLite files inside fresh OS temp dirs — never a real store
 * and never anything under ~/.hive.
 */
export interface Harness {
  path: string;
  now: () => number;
  open: (opts?: Omit<CoreStoreOptions, "now">) => CoreStore;
  cleanup: () => void;
}

/** Deterministic strictly-increasing clock (1s per call). */
export function makeClock(start = 1_000_000): () => number {
  let t = start;
  return () => (t += 1_000);
}

export function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-core-"));
  const path = join(dir, "core.sqlite3");
  const now = makeClock();
  return {
    path,
    now,
    open: (opts = {}) => openCoreStore(path, { now, ephemeral: true, ...opts }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function makeBee(store: CoreStore, name = "worker") {
  return store.createBee({ name, agent: "claude", substrate: "tmux", cwd: "/tmp/w" });
}

/** Drive a bee's current generation from booting into `running` with a pid identity. */
export function bootToRunning(store: CoreStore, beeId: string, pid: number, pidStartedAt: number): void {
  const rt = store.currentRuntime(beeId);
  if (!rt) throw new Error("no runtime");
  store.updateRuntimeState(beeId, rt.generation, "running", { pid, pidStartedAt });
}
