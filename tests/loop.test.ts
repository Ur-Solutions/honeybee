import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildLoopConfig, coerceDuration, parseContextMode } from "../src/loop/context.js";
import {
  appendIterLog,
  ensureLoopDir,
  isStopRequested,
  listLoops,
  loopHistoryLogPath,
  loopHistoryMdPath,
  loopIterLogPath,
  loopProgressPath,
  type LoopConfig,
  readLoopConfig,
  reconcileLoopStatus,
  requestStop,
  updateLoopConfig,
  writeIterSeal,
  writeLoopConfig,
} from "../src/loop/state.js";
import { runStopPredicate } from "../src/loop/until.js";
import {
  buildIterationPrompt,
  foldForward,
  HISTORY_DIGEST_THRESHOLD,
  INJECTION_BUDGET_BYTES,
  rederiveHistory,
  truncateForInjection,
} from "../src/loop/summarizer.js";
import { __setLoopTestHooks, loopFlow } from "../src/loop/flow.js";
import { listFlows, loadFlow } from "../src/flow/index.js";
import { executeFlow } from "../src/flow/run.js";
import { HiveFacade } from "../src/flow/hive_facade.js";
import { cancelRun, spawnDetachedRun } from "../src/flow/background.js";
import { defineFlow } from "../src/flow/index.js";
import { readMeta, readResult } from "../src/flow/runs.js";
import { recordSeal, type SealRecord, validateSealArtifact } from "../src/seal.js";
import { saveSession, type SessionRecord } from "../src/store.js";

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-loop-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeRecord(name: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    name,
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: name,
    createdAt: now,
    updatedAt: now,
    status: "running",
    id: name,
  };
}

const baseArgs = {
  bee: "claude",
  cwd: "/tmp",
  context: "ralph",
  prompt: "Do the work.",
};

/* ──────────────────────────────────────────────────────────────────────────
 * 1. context.ts
 * ────────────────────────────────────────────────────────────────────────── */

test("parseContextMode maps presets to carrier+memory knobs", () => {
  assert.deepEqual(parseContextMode("persistent"), { context: "persistent", carrier: "same", memory: "harness" });
  assert.deepEqual(parseContextMode("ralph"), { context: "ralph", carrier: "fresh", memory: "none" });
  assert.deepEqual(parseContextMode("rolling"), { context: "rolling", carrier: "fresh", memory: "rolling" });
  assert.throws(() => parseContextMode("nope"), /Unknown --context/);
});

test("buildLoopConfig requires --max unless --forever", () => {
  // No max, not forever → throws.
  assert.throws(() => buildLoopConfig({ ...baseArgs }), /--max/);
  // forever → max becomes null, no throw.
  const cfg = buildLoopConfig({ ...baseArgs, forever: true });
  assert.equal(cfg.stop.forever, true);
  assert.equal(cfg.stop.max, null);
  // explicit max → kept.
  const cfg2 = buildLoopConfig({ ...baseArgs, max: 5 });
  assert.equal(cfg2.stop.max, 5);
  // invalid max → throws.
  assert.throws(() => buildLoopConfig({ ...baseArgs, max: 0 }), /positive integer/);
});

test("buildLoopConfig: --forever ignores a supplied max (flow arg default of 100)", () => {
  // Regression: the flow runtime applies the arg default max=100 even for
  // --forever loops, which used to write a phantom stop.max=100 into loop.json.
  const cfg = buildLoopConfig({ ...baseArgs, forever: true, max: 100 });
  assert.equal(cfg.stop.forever, true);
  assert.equal(cfg.stop.max, null);
  // Even an invalid max is irrelevant under --forever.
  const cfg2 = buildLoopConfig({ ...baseArgs, forever: true, max: "bogus" });
  assert.equal(cfg2.stop.max, null);
});

test("buildLoopConfig validates --stop-on-seal CSV against seal statuses", () => {
  const cfg = buildLoopConfig({ ...baseArgs, max: 3, stopOnSeal: "done,failed" });
  assert.deepEqual(cfg.stop.stopOnSeal, ["done", "failed"]);
  // default is ["done"].
  const cfg2 = buildLoopConfig({ ...baseArgs, max: 3 });
  assert.deepEqual(cfg2.stop.stopOnSeal, ["done"]);
  assert.throws(() => buildLoopConfig({ ...baseArgs, max: 3, stopOnSeal: "done,bogus" }), /Invalid --stop-on-seal/);
});

test("coerceDuration parses 30s/10m/2h", () => {
  assert.equal(coerceDuration("30s"), 30_000);
  assert.equal(coerceDuration("10m"), 600_000);
  assert.equal(coerceDuration("2h"), 7_200_000);
  assert.equal(coerceDuration(""), null);
  assert.equal(coerceDuration(undefined), null);
  assert.throws(() => coerceDuration("nonsense"), /Invalid --max-duration/);
  const cfg = buildLoopConfig({ ...baseArgs, max: 3, maxDuration: "5m" });
  assert.equal(cfg.stop.maxDurationMs, 300_000);
});

test("buildLoopConfig requires bee/cwd/context/prompt", () => {
  assert.throws(() => buildLoopConfig({ cwd: "/tmp", context: "ralph", prompt: "x", max: 1 }), /--bee/);
  assert.throws(() => buildLoopConfig({ bee: "claude", context: "ralph", prompt: "x", max: 1 }), /--cwd/);
  assert.throws(() => buildLoopConfig({ bee: "claude", cwd: "/tmp", prompt: "x", max: 1 }), /--context/);
  assert.throws(() => buildLoopConfig({ bee: "claude", cwd: "/tmp", context: "ralph", max: 1 }), /--prompt/);
});

/* ──────────────────────────────────────────────────────────────────────────
 * 2. state.ts
 * ────────────────────────────────────────────────────────────────────────── */

test("loop.json write/read/update round-trips under the temp store", async () => {
  await withTempStore(async () => {
    const cfg = buildLoopConfig({ ...baseArgs, max: 10, loopId: "L1" });
    cfg.loopId = "L1";
    await writeLoopConfig(cfg);
    const back = await readLoopConfig("L1");
    assert.ok(back);
    assert.equal(back?.loopId, "L1");
    assert.equal(back?.context, "ralph");
    assert.equal(back?.stop.max, 10);

    const updated = await updateLoopConfig("L1", { iteration: 3, lastSealStatus: "done" });
    assert.equal(updated.iteration, 3);
    assert.equal(updated.lastSealStatus, "done");
    assert.ok(updated.updatedAt >= cfg.updatedAt);

    assert.equal(await readLoopConfig("does-not-exist"), null);
  });
});

test("listLoops returns newest-first by startedAt", async () => {
  await withTempStore(async () => {
    const older = buildLoopConfig({ ...baseArgs, max: 1, loopId: "old" });
    older.loopId = "old";
    older.startedAt = "2020-01-01T00:00:00.000Z";
    await writeLoopConfig(older);
    const newer = buildLoopConfig({ ...baseArgs, max: 1, loopId: "new" });
    newer.loopId = "new";
    newer.startedAt = "2025-01-01T00:00:00.000Z";
    await writeLoopConfig(newer);

    const loops = await listLoops();
    assert.equal(loops.length, 2);
    assert.equal(loops[0]?.loopId, "new");
    assert.equal(loops[1]?.loopId, "old");
  });
});

test("listLoops downgrades running loops with a dead driver pid to orphaned (view only)", async () => {
  await withTempStore(async () => {
    const dead = buildLoopConfig({ ...baseArgs, max: 1, loopId: "DEAD" });
    dead.loopId = "DEAD";
    dead.pid = 999_999_999;
    await writeLoopConfig(dead);
    const alive = buildLoopConfig({ ...baseArgs, max: 1, loopId: "ALIVE" });
    alive.loopId = "ALIVE";
    alive.pid = process.pid;
    await writeLoopConfig(alive);
    const noPid = buildLoopConfig({ ...baseArgs, max: 1, loopId: "NOPID" });
    noPid.loopId = "NOPID";
    await writeLoopConfig(noPid);

    const loops = await listLoops({ isPidAlive: (pid) => pid === process.pid });
    const byId = new Map(loops.map((l) => [l.loopId, l]));
    assert.equal(byId.get("DEAD")?.status, "orphaned");
    assert.equal(byId.get("ALIVE")?.status, "running");
    // No pid yet (pre-driver write window) — left as-is.
    assert.equal(byId.get("NOPID")?.status, "running");
    // The on-disk file is untouched: this is a view-level downgrade.
    const onDisk = await readLoopConfig("DEAD");
    assert.equal(onDisk?.status, "running");
  });
});

test("reconcileLoopStatus only downgrades running+dead-pid", () => {
  const cfg = buildLoopConfig({ ...baseArgs, max: 1, loopId: "R" });
  cfg.loopId = "R";
  cfg.pid = 12345;
  assert.equal(reconcileLoopStatus(cfg, () => false).status, "orphaned");
  assert.equal(reconcileLoopStatus(cfg, () => true).status, "running");
  const done = { ...cfg, status: "done" as const };
  assert.equal(reconcileLoopStatus(done, () => false).status, "done");
});

test("stop-request sentinel write + detect", async () => {
  await withTempStore(async () => {
    await ensureLoopDir("S1");
    assert.equal(await isStopRequested("S1"), false);
    await requestStop("S1");
    assert.equal(await isStopRequested("S1"), true);
  });
});

test("writeIterSeal + appendIterLog land under the loop dir", async () => {
  await withTempStore(async (dir) => {
    await ensureLoopDir("ITER");
    const seal: SealRecord = { status: "done", summary: "did a thing", beeName: "b", sealedAt: new Date().toISOString() };
    await writeIterSeal("ITER", 2, seal);
    const raw = await readFile(join(dir, "loops", "ITER", "seals", "iter-002.json"), "utf8");
    assert.match(raw, /did a thing/);
    await appendIterLog("ITER", 2, "status=done");
    const log = await readFile(join(dir, "loops", "ITER", "iter-002.log"), "utf8");
    assert.match(log, /status=done/);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 3. until.ts
 * ────────────────────────────────────────────────────────────────────────── */

test("runStopPredicate: exit 0 → true, exit 1 → false, missing cmd → false", async () => {
  assert.equal(await runStopPredicate("exit 0", process.cwd()), true);
  assert.equal(await runStopPredicate("exit 1", process.cwd()), false);
  assert.equal(await runStopPredicate("this-command-does-not-exist-xyz", process.cwd()), false);
});

test("runStopPredicate never throws and resolves false on timeout", async () => {
  const result = await runStopPredicate("sleep 5", process.cwd(), { timeoutMs: 100 });
  assert.equal(result, false);
});

test("runStopPredicate kills the WHOLE process group on timeout (no leaked children)", async () => {
  // Regression: timeout/abort used to SIGKILL only the /bin/sh wrapper, so a
  // compound command's children survived and leaked every iteration.
  const dir = await mkdtemp(join(tmpdir(), "honeybee-until-"));
  let grandchild = 0;
  try {
    const pidFile = join(dir, "child.pid");
    const result = await runStopPredicate(`sleep 30 & echo $! > ${pidFile}; wait`, dir, { timeoutMs: 300 });
    assert.equal(result, false);
    grandchild = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(Number.isInteger(grandchild) && grandchild > 0, "pidfile must contain the grandchild pid");
    // Give the SIGKILL a moment to be delivered/reaped.
    await sleep(150);
    assert.equal(pidAlive(grandchild), false, "grandchild `sleep` must die with the process group");
  } finally {
    if (grandchild > 0 && pidAlive(grandchild)) {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        // ignore
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("runStopPredicate resolves false (no throw) when the signal is ALREADY aborted", async () => {
  // Regression: an already-aborted signal used to throw a TDZ ReferenceError
  // (clearTimeout(timer) before `timer` was initialized), escaping the
  // documented "never throws to the caller" contract.
  const controller = new AbortController();
  controller.abort();
  const result = await runStopPredicate("exit 0", process.cwd(), { signal: controller.signal });
  assert.equal(result, false);
});

/* ──────────────────────────────────────────────────────────────────────────
 * 4. summarizer.ts
 * ────────────────────────────────────────────────────────────────────────── */

test("buildIterationPrompt (rolling) PREPENDS progress+history and appends fold-forward instruction", () => {
  const prompt = buildIterationPrompt({
    task: "Refactor the parser.",
    mode: "rolling",
    progress: "PRIOR-PROGRESS-MARKER",
    history: "PRIOR-HISTORY-MARKER",
    loopId: "L",
    iteration: 4,
  });
  // Prior context is injected.
  assert.match(prompt, /PRIOR-PROGRESS-MARKER/);
  assert.match(prompt, /PRIOR-HISTORY-MARKER/);
  // The task is present.
  assert.match(prompt, /Refactor the parser\./);
  // Fold-forward wording is present and it is explicitly NOT a reset.
  assert.match(prompt, /integrate/i);
  assert.match(prompt, /fold-forward/i);
  assert.match(prompt, /do NOT reset/i);
  // Progress must appear before the task (prepended).
  assert.ok(prompt.indexOf("PRIOR-PROGRESS-MARKER") < prompt.indexOf("Refactor the parser."));
});

test("buildIterationPrompt (ralph) does not prepend rolling context", () => {
  const prompt = buildIterationPrompt({
    task: "Take the next item.",
    mode: "none",
    progress: "SHOULD-NOT-APPEAR",
    history: "SHOULD-NOT-APPEAR",
    loopId: "L",
    iteration: 1,
  });
  assert.doesNotMatch(prompt, /SHOULD-NOT-APPEAR/);
  assert.match(prompt, /Take the next item\./);
  // Still appends the standing seal instruction.
  assert.match(prompt, /seal/i);
});

test("truncateForInjection keeps the most recent content behind an elision marker", () => {
  // Under budget → untouched.
  assert.equal(truncateForInjection("short", 100), "short");
  // Over budget → tail kept, marker prepended, size bounded.
  const lines = Array.from({ length: 5_000 }, (_, i) => `line-${i}`).join("\n");
  const out = truncateForInjection(lines, 1_024);
  assert.match(out, /elided to fit the injection budget/);
  assert.ok(out.includes("line-4999"), "the newest content is retained");
  assert.ok(!out.includes("line-0\n"), "the oldest content is dropped");
  assert.ok(Buffer.byteLength(out, "utf8") < 1_024 + 200, "output stays near the budget");
});

test("buildIterationPrompt (rolling) budgets the injected progress/history (PRD §10)", () => {
  const huge = `OLDEST-MARKER\n${"x".repeat(INJECTION_BUDGET_BYTES * 2)}\nNEWEST-MARKER`;
  const prompt = buildIterationPrompt({
    task: "Do the task.",
    mode: "rolling",
    progress: huge,
    history: huge,
    loopId: "L",
    iteration: 2,
  });
  assert.doesNotMatch(prompt, /OLDEST-MARKER/);
  assert.match(prompt, /NEWEST-MARKER/);
  assert.match(prompt, /elided to fit the injection budget/);
  assert.ok(prompt.length < INJECTION_BUDGET_BYTES * 3, "prompt size is bounded by the per-section budget");
  // The fold-forward closing instruction now states a maximum length.
  assert.match(prompt, /under roughly \d+ characters/);
});

test("foldForward overwrites progress, appends ONE history.log line, re-derives history.md", async () => {
  await withTempStore(async () => {
    await ensureLoopDir("F");
    const seal1: SealRecord = {
      status: "done",
      summary: "Integrated state after pass 1.",
      filesChanged: ["a.ts"],
      beeName: "b",
      sealedAt: new Date().toISOString(),
    };
    await foldForward("F", 1, seal1);
    let progress = await readFile(loopProgressPath("F"), "utf8");
    assert.match(progress, /Integrated state after pass 1\./);
    assert.match(progress, /a\.ts/);
    let log = await readFile(loopHistoryLogPath("F"), "utf8");
    assert.equal(log.trim().split("\n").length, 1);
    assert.match(log, /iter 1 status=done/);

    const seal2: SealRecord = { status: "done", summary: "Integrated state after pass 2.", beeName: "b", sealedAt: new Date().toISOString() };
    await foldForward("F", 2, seal2);
    // progress.md OVERWRITTEN (no trace of pass 1 content).
    progress = await readFile(loopProgressPath("F"), "utf8");
    assert.match(progress, /Integrated state after pass 2\./);
    assert.doesNotMatch(progress, /pass 1/);
    // history.log APPEND-ONLY: now two lines, the pass-1 line intact.
    log = await readFile(loopHistoryLogPath("F"), "utf8");
    const lines = log.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /iter 1 status=done/);
    assert.match(lines[1]!, /iter 2 status=done/);
    // history.md is re-derived from the raw log.
    const md = await readFile(loopHistoryMdPath("F"), "utf8");
    assert.match(md, /iter 1/);
    assert.match(md, /iter 2/);
  });
});

test("rederiveHistory elides the middle past the threshold but keeps history.log intact", async () => {
  await withTempStore(async () => {
    await ensureLoopDir("H");
    const count = HISTORY_DIGEST_THRESHOLD + 5;
    for (let i = 1; i <= count; i += 1) {
      const seal: SealRecord = { status: "done", summary: `pass ${i}`, beeName: "b", sealedAt: new Date(Date.now() + i).toISOString() };
      await foldForward("H", i, seal);
    }
    const log = await readFile(loopHistoryLogPath("H"), "utf8");
    assert.equal(log.trim().split("\n").length, count, "history.log keeps every line");
    await rederiveHistory("H");
    const md = await readFile(loopHistoryMdPath("H"), "utf8");
    assert.match(md, /earlier iterations elided/);
    // The most recent iteration is retained in the digest.
    assert.match(md, new RegExp(`iter ${count} `));
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 5. Driver via executeFlow + test hooks
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Install loop test hooks that bypass real tmux: ensureBee saves a fake record
 * + tracks it on the facade; send schedules a recordSeal so waitForSeal
 * resolves. The seal status per iteration is supplied by `sealFor`.
 */
function installDriverHooks(sealFor: (iter: number) => SealRecord["status"] | { status: SealRecord["status"]; summary?: string }): void {
  __setLoopTestHooks({
    ensureBee: async ({ facade, cfg, iter }) => {
      const name = cfg.carrier === "fresh" ? `loop-bee-i${iter}` : "loop-bee";
      const record = fakeRecord(name);
      await saveSession(record);
      (facade as unknown as { spawned: SessionRecord[] }).spawned.push(record);
      return record;
    },
    send: async ({ handle, iter }) => {
      const spec = sealFor(iter);
      const status = typeof spec === "string" ? spec : spec.status;
      const summary = typeof spec === "string" ? `iteration ${iter} summary` : spec.summary ?? `iteration ${iter} summary`;
      // Space the seal slightly so sealedAt differs from any baseline.
      setTimeout(() => {
        void recordSeal(handle.name, validateSealArtifact({ status, summary }));
      }, 15);
    },
    // Tight boundary polling keeps the driver tests fast and deterministic.
    boundaryPollMs: 10,
  });
}

test("driver: ralph stops on --until exit 0", async () => {
  await withTempStore(async () => {
    installDriverHooks(() => "done");
    try {
      // stopOnSeal is set to a status the seal never produces (seal is "done"),
      // so the loop only exits via --until.
      const outcome = await executeFlow(loopFlow, {
        args: { ...baseArgs, context: "ralph", max: 50, stopOnSeal: "needs_input", until: "exit 0", loopId: "U1" },
        runId: "U1",
        installSignalHandlers: false,
      });
      const cfg = await readLoopConfig("U1");
      assert.equal(cfg?.status, "done");
      assert.equal(cfg?.stopReason, "until");
      assert.equal((outcome.value as { status: string }).status, "done");
    } finally {
      __setLoopTestHooks(undefined);
    }
  });
});

test("driver: stops on max", async () => {
  await withTempStore(async () => {
    // Seal status that is NOT in stopOnSeal so the loop runs to max.
    installDriverHooks(() => "failed");
    try {
      await executeFlow(loopFlow, {
        args: { ...baseArgs, context: "ralph", max: 3, stopOnSeal: "done", loopId: "M1" },
        runId: "M1",
        installSignalHandlers: false,
      });
      const cfg = await readLoopConfig("M1");
      assert.equal(cfg?.status, "done");
      assert.equal(cfg?.stopReason, "max");
      assert.equal(cfg?.iteration, 3);
    } finally {
      __setLoopTestHooks(undefined);
    }
  });
});

test("driver: persistent re-prompts the SAME bee each iteration", async () => {
  await withTempStore(async () => {
    const beeNames = new Set<string>();
    __setLoopTestHooks({
      ensureBee: async ({ facade }) => {
        const record = fakeRecord("persist-bee");
        await saveSession(record);
        (facade as unknown as { spawned: SessionRecord[] }).spawned.push(record);
        beeNames.add(record.name);
        return record;
      },
      send: async ({ handle, iter }) => {
        setTimeout(() => {
          void recordSeal(handle.name, validateSealArtifact({ status: iter >= 2 ? "done" : "failed", summary: `pass ${iter}` }));
        }, 15);
      },
    });
    try {
      await executeFlow(loopFlow, {
        args: { ...baseArgs, context: "persistent", max: 5, stopOnSeal: "done", loopId: "P1" },
        runId: "P1",
        installSignalHandlers: false,
      });
      const cfg = await readLoopConfig("P1");
      assert.equal(cfg?.status, "done");
      assert.equal(cfg?.iteration, 2);
      // Only one bee identity was ever used (carrier=same).
      assert.equal(beeNames.size, 1);
    } finally {
      __setLoopTestHooks(undefined);
    }
  });
});

test("driver: rolling writes progress.md + history files", async () => {
  await withTempStore(async () => {
    installDriverHooks((iter) => ({ status: iter >= 2 ? "done" : "failed", summary: `fold pass ${iter}` }));
    try {
      await executeFlow(loopFlow, {
        args: { ...baseArgs, context: "rolling", max: 5, stopOnSeal: "done", summarizer: "self", loopId: "R1" },
        runId: "R1",
        installSignalHandlers: false,
      });
      const cfg = await readLoopConfig("R1");
      assert.equal(cfg?.status, "done");
      const progress = await readFile(loopProgressPath("R1"), "utf8");
      assert.match(progress, /fold pass 2/);
      const log = await readFile(loopHistoryLogPath("R1"), "utf8");
      assert.match(log, /iter 1/);
      assert.match(log, /iter 2/);
    } finally {
      __setLoopTestHooks(undefined);
    }
  });
});

test("driver: blocked/needs_input seal pauses the loop, KEEPS the bee + currentBee", async () => {
  await withTempStore(async () => {
    installDriverHooks(() => "blocked");
    try {
      await executeFlow(loopFlow, {
        args: { ...baseArgs, context: "ralph", max: 5, stopOnSeal: "done", loopId: "B1" },
        runId: "B1",
        installSignalHandlers: false,
      });
      const cfg = await readLoopConfig("B1");
      assert.equal(cfg?.status, "paused");
      assert.equal(cfg?.stopReason, "seal:blocked");
      // Paused after the FIRST blocked iteration — no spinning.
      assert.equal(cfg?.iteration, 1);
      // PRD pause-and-notify: the operator must be able to attach to the very
      // bee that blocked — loop.json keeps pointing at it…
      assert.equal(cfg?.currentBee, "loop-bee-i1");
      // …and neither the fresh-carrier kill nor the flow's kill-on-end cleanup
      // destroyed it (an untracked bee survives killAll).
      const { loadSession } = await import("../src/store.js");
      const survivor = await loadSession("loop-bee-i1");
      assert.ok(survivor, "the paused bee's session record must survive cleanup");
    } finally {
      __setLoopTestHooks(undefined);
    }
  });
});

test("driver: explicit --stop-on-seal blocked STOPS instead of pausing", async () => {
  await withTempStore(async () => {
    // Regression: the implicit pause branch used to fire before the explicit
    // stop-on-seal membership check, so stopOnSeal=blocked could never trigger.
    installDriverHooks(() => "blocked");
    try {
      const outcome = await executeFlow(loopFlow, {
        args: { ...baseArgs, context: "ralph", max: 5, stopOnSeal: "blocked", loopId: "B2" },
        runId: "B2",
        installSignalHandlers: false,
      });
      const cfg = await readLoopConfig("B2");
      assert.equal(cfg?.status, "done");
      assert.equal(cfg?.stopReason, "seal:blocked");
      assert.equal(cfg?.iteration, 1);
      assert.equal((outcome.value as { stopReason: string }).stopReason, "seal:blocked");
    } finally {
      __setLoopTestHooks(undefined);
    }
  });
});

test("driver: boundary races seal detection against idle — a never-sealing bee concludes via idle, not the seal cap", async () => {
  await withTempStore(async () => {
    const startedAt = Date.now();
    __setLoopTestHooks({
      ensureBee: async ({ facade, iter }) => {
        const record = fakeRecord(`loop-idle-i${iter}`);
        await saveSession(record);
        (facade as unknown as { spawned: SessionRecord[] }).spawned.push(record);
        return record;
      },
      send: async () => {
        // never seals
      },
      // The seal cap is LONG — only the idle race can finish the iteration fast.
      sealTimeoutMs: 60_000,
      boundaryIdleMs: 40,
      boundaryGraceMs: 40,
      boundaryPollMs: 10,
      capturePane: async () => "stable pane content",
    });
    try {
      await executeFlow(loopFlow, {
        args: { ...baseArgs, context: "ralph", max: 2, stopOnSeal: "done", loopId: "IDLE1" },
        runId: "IDLE1",
        installSignalHandlers: false,
      });
      const cfg = await readLoopConfig("IDLE1");
      assert.equal(cfg?.status, "done");
      assert.equal(cfg?.stopReason, "max");
      assert.equal(cfg?.iteration, 2);
      assert.ok(Date.now() - startedAt < 10_000, "idle detection must beat the 60s seal cap");
    } finally {
      __setLoopTestHooks(undefined);
    }
  });
});

test("driver: a seal landing BEFORE the boundary wait starts is still detected (pre-send baseline)", async () => {
  await withTempStore(async () => {
    // Regression: waitForSeal used to take its OWN baseline AFTER send, so a
    // seal recorded synchronously during send was mistaken for the baseline
    // and only the full timeout fallback could surface it.
    const startedAt = Date.now();
    __setLoopTestHooks({
      ensureBee: async ({ facade, iter }) => {
        const record = fakeRecord(`loop-fast-i${iter}`);
        await saveSession(record);
        (facade as unknown as { spawned: SessionRecord[] }).spawned.push(record);
        return record;
      },
      send: async ({ handle, iter }) => {
        // Seal SYNCHRONOUSLY — lands before the boundary wait begins.
        await recordSeal(handle.name, validateSealArtifact({ status: "done", summary: `fast pass ${iter}` }));
      },
      sealTimeoutMs: 60_000,
      boundaryPollMs: 10,
    });
    try {
      await executeFlow(loopFlow, {
        args: { ...baseArgs, context: "ralph", max: 5, stopOnSeal: "done", loopId: "FAST1" },
        runId: "FAST1",
        installSignalHandlers: false,
      });
      const cfg = await readLoopConfig("FAST1");
      assert.equal(cfg?.status, "done");
      assert.equal(cfg?.stopReason, "seal:done");
      assert.equal(cfg?.iteration, 1);
      assert.ok(Date.now() - startedAt < 10_000, "the fast seal must be seen immediately, not after the cap");
    } finally {
      __setLoopTestHooks(undefined);
    }
  });
});

test("driver: stop-on-sentinel fires in ralph (fresh-carrier) mode", async () => {
  await withTempStore(async () => {
    // Regression: in fresh-carrier modes the bee is killed + handle cleared
    // BEFORE the sentinel scan ran, so --stop-on-sentinel could never fire.
    // The scanSentinel hook asserts it is invoked with a LIVE handle.
    let sawLiveHandle = false;
    __setLoopTestHooks({
      ensureBee: async ({ facade, iter }) => {
        const record = fakeRecord(`loop-sentinel-i${iter}`);
        await saveSession(record);
        (facade as unknown as { spawned: SessionRecord[] }).spawned.push(record);
        return record;
      },
      send: async ({ handle, iter }) => {
        // Seal "failed" so stop-on-seal (default done) never fires.
        setTimeout(() => {
          void recordSeal(handle.name, validateSealArtifact({ status: "failed", summary: `pass ${iter}` }));
        }, 15);
      },
      scanSentinel: async ({ handle }) => {
        if (handle) sawLiveHandle = true;
        return true; // marker present
      },
    });
    try {
      const outcome = await executeFlow(loopFlow, {
        args: { ...baseArgs, context: "ralph", max: 10, stopOnSeal: "done", stopOnSentinel: "DONE-MARKER", loopId: "SENT1" },
        runId: "SENT1",
        installSignalHandlers: false,
      });
      const cfg = await readLoopConfig("SENT1");
      assert.equal(cfg?.status, "done");
      assert.equal(cfg?.stopReason, "sentinel");
      assert.equal(cfg?.iteration, 1, "stops on the first iteration whose pane matches");
      assert.equal(sawLiveHandle, true, "sentinel scanned a LIVE handle (before the fresh-carrier kill)");
      assert.equal((outcome.value as { stopReason: string }).stopReason, "sentinel");
    } finally {
      __setLoopTestHooks(undefined);
    }
  });
});

test("driver: a no-seal turn does NOT synthesize done; falls through to mechanical stops", async () => {
  await withTempStore(async () => {
    // Regression: status defaulted to "done" when no seal was observed, which
    // tripped stop-on-seal=[done] and stopped a non-sealing loop after one
    // iteration. It must instead fall through to --max (and sentinel/until).
    __setLoopTestHooks({
      ensureBee: async ({ facade, iter }) => {
        const record = fakeRecord(`loop-noseal-i${iter}`);
        await saveSession(record);
        (facade as unknown as { spawned: SessionRecord[] }).spawned.push(record);
        return record;
      },
      // No send hook → no seal is ever recorded. The boundary cap is short
      // and collect() returns null, so the boundary observes NO seal.
      send: async () => {
        // intentionally records no seal
      },
      sealTimeoutMs: 150,
      boundaryPollMs: 10,
    });
    try {
      await executeFlow(loopFlow, {
        // No until/sentinel → only --max should stop it. If the bug were
        // present, it would stop at iteration 1 via synthesized done.
        args: { ...baseArgs, context: "ralph", max: 2, stopOnSeal: "done", loopId: "NOSEAL1" },
        runId: "NOSEAL1",
        installSignalHandlers: false,
      });
      const cfg = await readLoopConfig("NOSEAL1");
      assert.equal(cfg?.status, "done");
      assert.equal(cfg?.stopReason, "max", "no-seal turns run to max, not a synthesized done");
      assert.equal(cfg?.iteration, 2);
      // Observability must not claim a seal that never happened: the distinct
      // value "none" is recorded, never a fabricated "done".
      assert.equal(cfg?.lastSealStatus, "none");
      const iterLog = await readFile(loopIterLogPath("NOSEAL1", 2), "utf8");
      assert.match(iterLog, /status=none/);
      assert.doesNotMatch(iterLog, /status=done/);
    } finally {
      __setLoopTestHooks(undefined);
    }
  });
});

test("driver: stop-request sentinel halts before the next iteration", async () => {
  await withTempStore(async () => {
    installDriverHooks(() => "failed"); // never satisfies stopOnSeal=done
    try {
      // Pre-write the sentinel so the very first loop guard trips.
      await ensureLoopDir("STOPREQ");
      await requestStop("STOPREQ");
      await executeFlow(loopFlow, {
        args: { ...baseArgs, context: "ralph", max: 5, stopOnSeal: "done", loopId: "STOPREQ" },
        runId: "STOPREQ",
        installSignalHandlers: false,
      });
      const cfg = await readLoopConfig("STOPREQ");
      assert.equal(cfg?.status, "stopped");
      assert.equal(cfg?.stopReason, "stop-requested");
      assert.equal(cfg?.iteration, 0);
    } finally {
      __setLoopTestHooks(undefined);
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 6. Built-in registry
 * ────────────────────────────────────────────────────────────────────────── */

test("loadFlow('loop') resolves the built-in flow", async () => {
  await withTempStore(async () => {
    const flow = await loadFlow("loop");
    assert.ok(flow);
    assert.equal(flow?.name, "loop");
    assert.equal(flow?.cleanup, "kill-on-end");
  });
});

test("listFlows includes the built-in loop flow", async () => {
  await withTempStore(async () => {
    const flows = await listFlows();
    assert.ok(flows.some((f) => f.name === "loop"));
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 7. Background + cancel
 * ────────────────────────────────────────────────────────────────────────── */

function fixtureCompletes(): string {
  return `
const { mkdir, writeFile, readFile } = require('node:fs/promises');
const { join } = require('node:path');
async function main() {
  if (process.argv[2] !== '__flow-exec') { process.exit(2); }
  const runId = process.argv[3];
  let flowName;
  for (let i = 4; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--flow') flowName = process.argv[i + 1];
  }
  if (!runId || !flowName) { process.exit(2); }
  const root = process.env.HIVE_STORE_ROOT;
  const runDir = join(root, 'flows', flowName, 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const metaPath = join(runDir, 'meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  const endedAt = new Date().toISOString();
  await writeFile(metaPath, JSON.stringify({ ...meta, status: 'ok', endedAt }, null, 2) + '\\n');
  await writeFile(join(runDir, 'result.json'), JSON.stringify({ runId, flowName, status: 'ok', startedAt: meta.startedAt, endedAt, value: 'ok' }, null, 2) + '\\n');
}
main().catch((e) => { console.error(e); process.exit(1); });
`;
}

test("spawnDetachedRun(loopFlow, …) honors __flow-exec contract and writes meta/result", async () => {
  await withTempStore(async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "honeybee-loop-fix-"));
    try {
      const fixture = join(fixtureDir, "fixture.cjs");
      await writeFile(fixture, fixtureCompletes(), { mode: 0o600 });
      const result = await spawnDetachedRun(loopFlow, { ...baseArgs, max: 1 }, { entryOverride: fixture });
      assert.match(result.runId, /^[0-9A-Z]{13}-[0-9a-f]{4}$/);
      assert.equal(result.pgid, result.pid);
      // Reap: wait for the child to flip meta to ok.
      const deadline = Date.now() + 5_000;
      let meta = await readMeta("loop", result.runId);
      while ((!meta || meta.status === "running") && Date.now() < deadline) {
        await sleep(50);
        meta = await readMeta("loop", result.runId);
      }
      assert.equal(meta?.status, "ok");
      const res = await readResult("loop", result.runId);
      assert.equal(res?.status, "ok");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});

test("cancelRun('loop', …) signals the NEGATIVE pgid", async () => {
  await withTempStore(async () => {
    const { writeMeta } = await import("../src/flow/runs.js");
    const runId = "0000000000000-abcd";
    await writeMeta("loop", runId, {
      runId,
      flowName: "loop",
      args: {},
      status: "running",
      startedAt: new Date().toISOString(),
      pid: 1_234_567,
      pgid: 1_234_567,
      background: true,
    });
    const signals: { target: number; signal: string }[] = [];
    const outcome = await cancelRun("loop", runId, {
      graceMs: 50,
      pollMs: 10,
      killImpl: (target, signal) => {
        signals.push({ target, signal: String(signal) });
      },
      isAlive: () => false,
    });
    assert.equal(outcome.signalled, "SIGTERM");
    assert.equal(signals[0]?.target, -1_234_567, "must target the negative pgid");
    const meta = await readMeta("loop", runId);
    assert.equal(meta?.status, "cancelled");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * 8. Facade happy path
 * ────────────────────────────────────────────────────────────────────────── */

test("HiveFacade.loop writes initial loop.json and loopStop sets the sentinel", async () => {
  await withTempStore(async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "honeybee-loop-fix-"));
    try {
      const fixture = join(fixtureDir, "fixture.cjs");
      await writeFile(fixture, fixtureCompletes(), { mode: 0o600 });
      // Point the detached spawn at the fixture entry so we don't fork the real CLI.
      const original = process.argv[1];
      process.argv[1] = fixture;
      const facade = new HiveFacade({ flowName: "loop", runId: "facade-run" });
      let loopId: string;
      try {
        loopId = await facade.loop({ bee: "claude", cwd: "/tmp", context: "ralph", prompt: "x", max: 2 });
      } finally {
        process.argv[1] = original;
      }
      // Short, bee-id-style loop id (LP.<hex>) — targetable by suffix, not a raw run id.
      assert.match(loopId, /^LP\.[0-9a-f]{3,}$/);
      const cfg = await facade.loopStatus(loopId);
      assert.ok(cfg);
      assert.equal(cfg?.context, "ralph");
      assert.equal(cfg?.stop.max, 2);

      // Graceful stop writes the sentinel.
      await facade.loopStop(loopId);
      assert.equal(await isStopRequested(loopId), true);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});

test("HiveFacade.loop persists an errored loop.json when the detached spawn fails", async () => {
  await withTempStore(async () => {
    // Regression: a spawn failure AFTER the loop.json pre-write used to strand
    // the loop as "running" with no pid — nothing could ever reconcile it.
    const facade = new HiveFacade({ flowName: "loop", runId: "facade-run-spawnfail" });
    const original = process.argv[1];
    process.argv[1] = ""; // resolveEntry() throws → spawnDetachedRun rejects
    try {
      await assert.rejects(
        () => facade.loop({ bee: "claude", cwd: "/tmp", context: "ralph", prompt: "x", max: 1 }),
        /could not resolve CLI entry path/,
      );
    } finally {
      process.argv[1] = original;
    }
    const loops = await listLoops();
    assert.equal(loops.length, 1);
    assert.equal(loops[0]?.status, "errored");
    assert.match(loops[0]?.stopReason ?? "", /^spawn:/);
    assert.ok(loops[0]?.endedAt, "a terminal endedAt is persisted");
  });
});

test("HiveFacade.loop validates eagerly (bad config throws before spawning)", async () => {
  await withTempStore(async () => {
    const facade = new HiveFacade({ flowName: "loop", runId: "facade-run-2" });
    // No max and not forever → buildLoopConfig throws.
    await assert.rejects(
      () => facade.loop({ bee: "claude", cwd: "/tmp", context: "ralph", prompt: "x" } as Parameters<typeof facade.loop>[0]),
      /--max/,
    );
  });
});

// Keep the defineFlow import referenced (used by other suites' patterns).
void defineFlow;
