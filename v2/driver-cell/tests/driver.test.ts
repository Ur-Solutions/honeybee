/**
 * CellDriver integration — pure delegation to the HSR driver with real OS
 * child processes (the WP3 stub agent), running inside provisioned cells.
 * Proves: provisioning on start, cwd = space checkout, sandboxed spawn
 * (darwin), full observation round-trip and the cell surface (capture,
 * remove) against a live driver.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stubAdapter } from "../../adapters/src/index.ts";
import type { DriverObservation } from "../../harness/src/driver.ts";
import { CellDriver } from "../src/driver.ts";
import { defaultScratchPaths } from "../src/sandbox.ts";
import { commitInCell, makeRig, type CellTestRig } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_PATH = join(here, "..", "..", "driver-hsr", "test-agent", "agent.mjs");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeDriver(rig: CellTestRig, opts: { sandbox?: boolean | null } = {}): CellDriver {
  return new CellDriver({
    cellsRoot: rig.cellsRoot,
    nodeKind: "workstation",
    resolveHarness: () => ({
      adapter: stubAdapter,
      command: process.execPath,
      args: [AGENT_PATH],
      env: { ...(process.env as Record<string, string>), STUB_TURN_MS: "5" },
    }),
    resolveCell: (beeId: string) => ({
      provision: {
        beeId,
        originRepo: rig.origin.repo,
        sha: rig.origin.sha,
        wrapper: beeId,
        repoName: "fixture",
        cellId: beeId.replaceAll("bee-", "c"),
      },
      sandbox: opts.sandbox ?? null,
    }),
    hsr: { sessionLogDir: join(rig.root, "logs"), stopKillGraceMs: 400 },
    // Sandboxed runs must still reach the OS tmp + the node binary; the
    // default scratch list covers it. Harness "home" writes go to the logs
    // dir via the driver, outside the sandboxed child.
    sandboxWritablePaths: defaultScratchPaths(),
    disableCow: true,
  });
}

async function drainUntil(
  driver: CellDriver,
  pred: (events: DriverObservation[]) => boolean,
  timeoutMs = 5000,
): Promise<DriverObservation[]> {
  const acc: DriverObservation[] = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    acc.push(...driver.observe());
    if (pred(acc)) return acc;
    if (Date.now() > deadline) throw new Error(`drainUntil timeout; saw: ${JSON.stringify(acc)}`);
    await sleep(10);
  }
}

test("cell-driver.roundtrip: start provisions the cell, runtime runs in the space, full turn cycle", async () => {
  const rig = makeRig();
  const driver = makeDriver(rig);
  try {
    driver.start("bee-1", 1);
    const cell = driver.cellOf("bee-1");
    assert.ok(cell, "start() must provision");
    assert.ok(existsSync(join(cell.paths.spaceDir, ".git")));
    assert.ok(existsSync(join(cell.paths.spaceDir, "README.md")));

    await drainUntil(driver, (e) => e.some((x) => x.kind === "booted"));
    const outcome = driver.deliver("bee-1", 1, 1, "hello cell");
    assert.equal(outcome.accepted, true);
    await drainUntil(driver, (e) => e.some((x) => x.kind === "turn_ended"));

    // Delegation truth: the inner HSR driver owns the process + ground truth.
    assert.equal(driver.consumedGeneration(1), 1);
    assert.equal(driver.hasProcess("bee-1", 1), true);
    assert.equal(driver.snapshotLive().length, 1);

    driver.stop("bee-1", 1, "stopped_by_user");
    await drainUntil(driver, (e) => e.some((x) => x.kind === "exited"));
    assert.equal(driver.hasProcess("bee-1", 1), false);
  } finally {
    driver.disposeAll();
    await sleep(50);
    rig.cleanup();
  }
});

test("cell-driver.exit-path: work committed in the live cell captures out; removeCell guards", async () => {
  const rig = makeRig();
  const driver = makeDriver(rig);
  try {
    driver.start("bee-1", 1);
    await drainUntil(driver, (e) => e.some((x) => x.kind === "booted"));
    const cell = driver.cellOf("bee-1");
    assert.ok(cell);
    commitInCell(cell.paths.spaceDir, "result.ts", "export const done = true;\n", "cell result");

    // A live runtime blocks removeCell (the cell is its cwd).
    assert.throws(() => driver.removeCell("bee-1"), /live runtime/);

    const report = driver.capture("bee-1", { targetBranch: "bee/result", mode: "merge", opId: "cmd-9" });
    assert.equal(report.status, "landed");

    driver.stop("bee-1", 1, "stopped_by_user");
    await drainUntil(driver, (e) => e.some((x) => x.kind === "exited"));
    const res = driver.removeCell("bee-1");
    assert.equal(res.deleted, true);
    assert.equal(res.forced, false); // captured work → clean delete without force
    assert.ok(!existsSync(cell.paths.wrapperDir));
  } finally {
    driver.disposeAll();
    await sleep(50);
    rig.cleanup();
  }
});

test("cell-driver.restart-hydration: a fresh driver re-hydrates cells from cell.json (capture + delete work)", async () => {
  const rig = makeRig();
  const driver = makeDriver(rig);
  try {
    driver.start("bee-1", 1);
    await drainUntil(driver, (e) => e.some((x) => x.kind === "booted"));
    const cell = driver.cellOf("bee-1");
    assert.ok(cell);
    commitInCell(cell.paths.spaceDir, "late.ts", "1\n", "work before restart");
    driver.stop("bee-1", 1, "stopped_by_user");
    await drainUntil(driver, (e) => e.some((x) => x.kind === "exited"));

    // "Daemon restart": new driver object, empty in-memory cache.
    const driver2 = makeDriver(rig);
    const hydrated = driver2.cellOf("bee-1");
    assert.ok(hydrated, "cell.json is the durable allocation truth");
    assert.equal(hydrated.paths.spaceDir, cell.paths.spaceDir);
    assert.equal(hydrated.copyMode, "clone");
    const report = driver2.capture("bee-1", { targetBranch: "bee/late", mode: "merge", opId: "cmd-r" });
    assert.equal(report.status, "landed");
    assert.equal(driver2.removeCell("bee-1").deleted, true);
  } finally {
    driver.disposeAll();
    await sleep(50);
    rig.cleanup();
  }
});

test(
  "cell-driver.sandboxed: per-cell override ON wraps the spawn in Seatbelt; the turn still works (darwin)",
  { skip: platform() !== "darwin" },
  async () => {
    const rig = makeRig();
    const driver = makeDriver(rig, { sandbox: true });
    try {
      driver.start("bee-1", 1);
      const cell = driver.cellOf("bee-1");
      assert.ok(cell);
      await drainUntil(driver, (e) => e.some((x) => x.kind === "booted"), 8000);
      // The profile was materialized into the box (driver-owned, not the checkout).
      assert.ok(existsSync(cell.paths.sandboxProfilePath));
      assert.equal(driver.deliver("bee-1", 1, 1, "hello sandboxed").accepted, true);
      await drainUntil(driver, (e) => e.some((x) => x.kind === "turn_ended"), 8000);
      driver.stop("bee-1", 1, "stopped_by_user");
      await drainUntil(driver, (e) => e.some((x) => x.kind === "exited"), 8000);
    } finally {
      driver.disposeAll();
      await sleep(50);
      rig.cleanup();
    }
  },
);

test("cell-driver.workstation-default: sandbox stays OFF without an override (A4)", async () => {
  const rig = makeRig();
  const driver = makeDriver(rig); // nodeKind workstation, no override
  try {
    driver.start("bee-1", 1);
    await drainUntil(driver, (e) => e.some((x) => x.kind === "booted"));
    const cell = driver.cellOf("bee-1");
    assert.ok(cell);
    assert.ok(!existsSync(cell.paths.sandboxProfilePath), "no profile → no sandbox wrap");
    driver.stop("bee-1", 1, "stopped_by_user");
    await drainUntil(driver, (e) => e.some((x) => x.kind === "exited"));
  } finally {
    driver.disposeAll();
    await sleep(50);
    rig.cleanup();
  }
});
