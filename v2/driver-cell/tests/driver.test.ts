/**
 * CellDriver integration — pure delegation to the HSR driver with real OS
 * child processes (the WP3 stub agent), running inside provisioned cells.
 * Proves: provisioning on start, cwd = space checkout, sandboxed spawn
 * (darwin), full observation round-trip and the cell surface (capture,
 * remove) against a live driver.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stubAdapter } from "../../adapters/src/index.ts";
import type { DriverObservation } from "../../harness/src/driver.ts";
import { CellDriver, CellRuntimeLiveError } from "../src/driver.ts";
import { gitImagesRootForCells, readCurrentGitImage } from "../src/gitImage.ts";
import { reserveCell } from "../src/provision.ts";
import { probeCow } from "../src/cow.ts";
import { defaultScratchPaths, type NodeKind } from "../src/sandbox.ts";
import { commitInCell, makeRig, type CellTestRig } from "./helpers.ts";
import { pidAlive } from "../../driver-hsr/tests/helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT_PATH = join(here, "..", "..", "driver-hsr", "test-agent", "agent.mjs");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeDriver(
  rig: CellTestRig,
  opts: {
    sandbox?: boolean | null;
    backgroundProvisioning?: boolean;
    provisionWorkerUrl?: URL;
    disableCow?: boolean;
    gitImagesRoot?: string;
    nodeKind?: NodeKind;
  } = {},
): CellDriver {
  return new CellDriver({
    cellsRoot: rig.cellsRoot,
    nodeKind: opts.nodeKind ?? "workstation",
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
    disableCow: opts.disableCow ?? true,
    backgroundProvisioning: opts.backgroundProvisioning,
    provisionWorkerUrl: opts.provisionWorkerUrl,
    gitImagesRoot: opts.gitImagesRoot,
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
    await sleep(10);
    rig.cleanup();
  }
});

test("cell-driver.background: start returns before provisioning and later boots from the durable ledger", async () => {
  const rig = makeRig();
  const driver = makeDriver(rig, { backgroundProvisioning: true });
  try {
    const startedAt = performance.now();
    driver.start("bee-1", 1);
    assert.ok(performance.now() - startedAt < 500, "start must not run Git provisioning on the daemon lane");
    assert.equal(driver.hasProcess("bee-1", 1), true, "pending provisioning owns the generation");

    await drainUntil(driver, (events) => events.some((event) => event.kind === "booted"), 15_000);
    const cell = driver.cellOf("bee-1");
    assert.ok(cell);
    assert.ok(existsSync(join(cell.paths.spaceDir, ".git")));
    driver.stop("bee-1", 1, "stopped_by_user");
    await drainUntil(driver, (events) => events.some((event) => event.kind === "exited"));
  } finally {
    driver.disposeAll();
    await sleep(10);
    rig.cleanup();
  }
});

test("cell-driver.background: first Cell ensures the image before boot and the next Cell stays hot", {
  skip: platform() !== "darwin" && platform() !== "linux",
}, async (t) => {
  const rig = makeRig();
  if (!probeCow(join(rig.origin.repo, ".git"), rig.cellsRoot)) {
    rig.cleanup();
    t.skip("filesystem has no local CoW support");
    return;
  }
  const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
  const driver = makeDriver(rig, { backgroundProvisioning: true, disableCow: false, gitImagesRoot: imagesRoot });
  try {
    driver.start("bee-1", 1);
    await drainUntil(driver, (events) => events.some((event) => event.kind === "booted"), 15_000);
    assert.equal(driver.cellOf("bee-1")?.copyMode, "image-cow");

    // The post-turn maintenance lane remains a cheap ready/retry check.
    const delivered = driver.deliver("bee-1", 1, 1, "prime image after first turn");
    assert.equal(delivered.accepted, true);
    await drainUntil(driver, (events) => events.some((event) => event.kind === "turn_ended"), 15_000);

    const deadline = Date.now() + 15_000;
    while (readCurrentGitImage(imagesRoot, rig.origin.repo) == null) {
      if (Date.now() > deadline) throw new Error("background Git image refresh timed out");
      await sleep(10);
    }

    driver.start("bee-2", 1);
    await drainUntil(
      driver,
      (events) => events.some((event) => event.beeId === "bee-2" && event.kind === "booted"),
      15_000,
    );
    assert.equal(driver.cellOf("bee-2")?.copyMode, "image-cow");
    driver.stop("bee-1", 1, "stopped_by_user");
    driver.stop("bee-2", 1, "stopped_by_user");
    await drainUntil(driver, (events) => events.filter((event) => event.kind === "exited").length >= 2);
  } finally {
    driver.disposeAll();
    await sleep(10);
    rig.cleanup();
  }
});

test("cell-driver.background: satellites do not build the workstation-local Git image", async () => {
  const rig = makeRig();
  const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
  const driver = makeDriver(rig, {
    backgroundProvisioning: true,
    disableCow: false,
    gitImagesRoot: imagesRoot,
    nodeKind: "satellite",
    sandbox: false,
  });
  try {
    driver.start("bee-1", 1);
    await drainUntil(driver, (events) => events.some((event) => event.kind === "booted"), 15_000);
    await sleep(50);
    assert.equal(readCurrentGitImage(imagesRoot, rig.origin.repo), null);
    driver.stop("bee-1", 1, "stopped_by_user");
    await drainUntil(driver, (events) => events.some((event) => event.kind === "exited"));
  } finally {
    driver.disposeAll();
    await sleep(10);
    rig.cleanup();
  }
});

test("cell-driver.background: worker exit without a result becomes a boot failure", async () => {
  const rig = makeRig();
  const driver = makeDriver(rig, {
    backgroundProvisioning: true,
    provisionWorkerUrl: new URL("./fixtures/silent-worker.mjs", import.meta.url),
  });
  try {
    driver.start("bee-1", 1);
    const observations = await drainUntil(
      driver,
      (events) => events.some((event) => event.kind === "exited"),
    );
    const exited = observations.find((event) => event.kind === "exited");
    assert.equal(exited?.exitCause, "crashed");
    assert.match(exited?.detail ?? "", /without a result/);
    assert.equal(driver.hasProcess("bee-1", 1), false);
  } finally {
    driver.disposeAll();
    await sleep(10);
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
    await sleep(10);
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
    await sleep(10);
    rig.cleanup();
  }
});

test("cell-driver.reserved-only: a cell reserved (seed ledger) but never started removes outright; sessions delegate; typed live-runtime refusal", async () => {
  const rig = makeRig();
  const driver = makeDriver(rig);
  try {
    // Reserve for bee-2 exactly the way the daemon does at spawn.
    const reserved = reserveCell(rig.cellsRoot, {
      beeId: "bee-2",
      originRepo: rig.origin.repo,
      sha: rig.origin.sha,
      wrapper: "bee-2",
      repoName: "fixture",
      cellId: "c2",
    });
    assert.equal(driver.cellOf("bee-2"), null, "reserved ≠ provisioned");
    const res = driver.removeCell("bee-2");
    assert.deepEqual(res, { deleted: true, forced: false, report: null });
    assert.equal(existsSync(reserved.paths.wrapperDir), false, "seed-only wrapper removed outright");
    assert.deepEqual(driver.removeCell("bee-2"), { deleted: false, forced: false, report: null }, "gone → absent");

    // A started bee: the live-runtime refusal is typed, and its session id flows through the cell driver.
    driver.start("bee-1", 1);
    await drainUntil(driver, (e) => e.some((x) => x.kind === "booted"));
    assert.throws(() => driver.removeCell("bee-1"), (err: Error) => err instanceof CellRuntimeLiveError);
    const sessions = driver.observeSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.beeId, "bee-1");
    assert.ok(sessions[0]?.sessionId.startsWith("stub-"), "stub reports stub-<pid>");
    driver.stop("bee-1", 1, "stopped_by_user");
    await drainUntil(driver, (e) => e.some((x) => x.kind === "exited"));
  } finally {
    driver.disposeAll();
    await sleep(10);
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
    await sleep(10);
    rig.cleanup();
  }
});

test("cell-driver.restart: a successor daemon re-adopts a live cell runtime from the ledger at full capability", async () => {
  const rig = makeRig();
  const first = makeDriver(rig);
  let second: CellDriver | null = null;
  try {
    first.start("bee-1", 1);
    await drainUntil(first, (e) => e.some((x) => x.kind === "booted"));
    assert.equal(first.deliver("bee-1", 1, 1, "before restart").accepted, true);
    await drainUntil(first, (e) => e.some((x) => x.kind === "turn_ended"));
    const checkpoint = checkpointOf(first, "bee-1");
    const proc = first.procOf("bee-1", 1)!;
    assert.ok(proc.pid > 0);

    // The crash gap: the runner persists a completion the dying daemon never
    // folds. The successor must recover it from the journal, not from silence.
    assert.equal(first.deliver("bee-1", 1, 2, "@slow:80 persisted before crash").accepted, true);
    await waitForJournal(first.observationLogPath("bee-1", 1), (text) =>
      text.includes('"turn_ended","messageId":2'),
    );
    first.detachAll();
    assert.ok(pidAlive(proc.pid), "the cell runtime must survive the daemon");

    // A fresh driver has an EMPTY cell cache — only cell.json on disk knows
    // this bee's allocation. Adoption must hydrate from that ledger; before
    // the fix it threw "no provisioned cell", lost the adapter, and adopted
    // degraded (no tail → the bee stayed "running" forever).
    second = makeDriver(rig);
    assert.equal(second.adopt("bee-1", 1, proc.pid, proc.pidStartedAt, "running", checkpoint), true);
    assert.equal(second.isDegraded("bee-1", 1), false, "ledger-backed adoption is never degraded");
    assert.equal(second.cellOf("bee-1")?.replayed, true, "the cell was re-hydrated from its ledger");
    assert.equal(second.cellOf("bee-1")?.paths.spaceDir, first.cellOf("bee-1")?.paths.spaceDir);

    const recovered = await drainUntil(second, (e) => e.some((x) => x.kind === "turn_ended"));
    assert.ok(recovered.some((x) => x.kind === "turn_ended" && x.generation === 1));
    assert.ok(checkpointOf(second, "bee-1") > checkpoint, "the journal cursor advances past the replayed completion");

    // Full capability: the successor delivers to the SAME process.
    const deadline = Date.now() + 5000;
    let accepted = false;
    while (!accepted && Date.now() < deadline) {
      second.observe();
      accepted = second.deliver("bee-1", 1, 3, "after restart").accepted;
      if (!accepted) await sleep(20);
    }
    assert.ok(accepted, "successor daemon must deliver to the adopted cell runtime");
    await drainUntil(second, (e) => e.some((x) => x.kind === "turn_ended"));
    assert.equal(second.procOf("bee-1", 1)!.pid, proc.pid);

    second.stop("bee-1", 1, "stopped_by_user");
    await drainUntil(second, (e) => e.some((x) => x.kind === "exited"));
  } finally {
    second?.disposeAll();
    first.disposeAll();
    await sleep(10);
    rig.cleanup();
  }
});

function checkpointOf(driver: CellDriver, beeId: string): number {
  const evidence = driver.observeRecoveryCursors().find((row) => row.beeId === beeId);
  assert.ok(evidence, `missing recovery cursor for ${beeId}`);
  return evidence.cursor;
}

async function waitForJournal(path: string, predicate: (text: string) => boolean): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const text = readFileSync(path, "utf8");
      if (predicate(text)) return text;
    } catch {
      // The host creates the journal shortly after boot; keep probing.
    }
    if (Date.now() > deadline) throw new Error(`journal condition timed out: ${path}`);
    await sleep(10);
  }
}
