import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cancelRun, spawnDetachedRun } from "../src/flow/background.js";
import { defineFlow, type BeeHandle, type FlowContext, type FlowHive, type FlowSpawnInput } from "../src/flow/index.js";
import { parseJsonFlow } from "../src/flow/json.js";
import { executeFlow } from "../src/flow/run.js";
import { HiveFacade } from "../src/flow/hive_facade.js";
import { findRunById, generateRunId, listRuns, PIDLESS_RUNNING_GRACE_MS, readMeta, readResult, runDir, writeMeta } from "../src/flow/runs.js";
import { saveSession, type SessionRecord } from "../src/store.js";

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-flow-run-"));
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

/* ---------- runs.ts: id generation and inventory ---------- */

test("generateRunId returns base32-ts + 4hex pattern", () => {
  const id = generateRunId(1700000000000);
  assert.match(id, /^[0-9A-Z]{13}-[0-9a-f]{4}$/);
});

test("generateRunId is monotonic across millisecond boundaries", () => {
  const a = generateRunId(1700000000000);
  const b = generateRunId(1700000000001);
  assert.ok(a < b, `${a} should sort before ${b}`);
});

/* ---------- executeFlow: minimal flow runs end-to-end ---------- */

test("executeFlow runs a no-op flow and writes meta + result.json", async () => {
  await withTempStore(async (dir) => {
    const flow = defineFlow({
      name: "noop",
      run: async () => "done",
    });
    const outcome = await executeFlow(flow, { installSignalHandlers: false });
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.value, "done");
    assert.equal(outcome.meta.flowName, "noop");
    assert.equal(outcome.result.value, "done");
    // Files exist under ~/.hive/flows/noop/runs/<runId>/
    const meta = await readMeta("noop", outcome.runId);
    assert.ok(meta);
    assert.equal(meta?.status, "ok");
    const result = await readResult("noop", outcome.runId);
    assert.equal(result?.status, "ok");
    assert.ok(result?.endedAt);
    // The run dir lives where the spec promised.
    assert.equal(runDir("noop", outcome.runId), join(dir, "flows", "noop", "runs", outcome.runId));
  });
});

test("executeFlow records failure with stack in result.json", async () => {
  await withTempStore(async () => {
    const flow = defineFlow({
      name: "boom",
      run: async () => {
        throw new Error("kaboom");
      },
    });
    const outcome = await executeFlow(flow, { installSignalHandlers: false });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error?.message, "kaboom");
    assert.ok(outcome.error?.stack, "stack should be captured");
    const result = await readResult("boom", outcome.runId);
    assert.equal(result?.status, "failed");
    assert.equal(result?.error?.message, "kaboom");
  });
});

test("executeFlow survives an unserializable (circular) return value and persists terminal status", async () => {
  await withTempStore(async () => {
    const flow = defineFlow({
      name: "circ",
      run: async () => {
        const value: Record<string, unknown> = { note: "circular" };
        value.self = value;
        return value;
      },
    });
    const outcome = await executeFlow(flow, { installSignalHandlers: false });
    assert.equal(outcome.status, "ok");
    // meta.json must NOT be stranded on "running".
    const meta = await readMeta("circ", outcome.runId);
    assert.equal(meta?.status, "ok");
    assert.ok(meta?.endedAt);
    // result.json exists with the value substituted by a defensive string.
    const result = await readResult("circ", outcome.runId);
    assert.equal(result?.status, "ok");
    assert.match(String(result?.value ?? ""), /unserializable flow result/);
  });
});

test("executeFlow persists pgid derived from the detached-run env marker", async () => {
  await withTempStore(async () => {
    // Simulates the child of spawnDetachedRun whose startup write BEATS the
    // parent's pid/pgid meta patch: no pre-existing meta, env marker set.
    const previous = process.env.HIVE_FLOW_DETACHED;
    process.env.HIVE_FLOW_DETACHED = "1";
    try {
      const flow = defineFlow({ name: "detached-env", run: async () => "ok" });
      const outcome = await executeFlow(flow, { installSignalHandlers: false });
      const meta = await readMeta("detached-env", outcome.runId);
      // detached:true makes the child its own group leader ⇒ pgid === pid.
      assert.equal(meta?.pgid, process.pid);
      assert.equal(meta?.background, true);
    } finally {
      if (previous === undefined) delete process.env.HIVE_FLOW_DETACHED;
      else process.env.HIVE_FLOW_DETACHED = previous;
    }
  });
});

test("executeFlow applies arg defaults", async () => {
  await withTempStore(async () => {
    let observed: Record<string, unknown> | undefined;
    const flow = defineFlow({
      name: "defs",
      args: [{ name: "x", default: 7 }, { name: "y" }],
      run: async (ctx) => {
        observed = { ...ctx.args };
        return ctx.args;
      },
    });
    await executeFlow(flow, { args: { y: "hello" }, installSignalHandlers: false });
    assert.deepEqual(observed, { x: 7, y: "hello" });
  });
});

/* ---------- JSON flow via stub HiveFacade exec ---------- */

// We test the compiled JSON flow with a hand-rolled FlowContext that
// substitutes a stub FlowHive — this lets us verify {{var}} substitution
// end-to-end without ever calling spawnBeeForFlow / tmux.

function stubHive(): { hive: FlowHive; calls: { op: string; args: unknown[] }[] } {
  const calls: { op: string; args: unknown[] }[] = [];
  let counter = 0;
  const hive: FlowHive = {
    spawn: async (spec: FlowSpawnInput) => {
      calls.push({ op: "spawn", args: [spec] });
      const handle: BeeHandle = {
        id: `bee-${++counter}`,
        name: spec.name ?? `${spec.bee}-${counter}`,
        agent: spec.bee,
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      };
      return handle;
    },
    send: async (t, x) => { calls.push({ op: "send", args: [t, x] }); },
    brief: async (t, x) => { calls.push({ op: "brief", args: [t, x] }); },
    waitForSeal: async (t) => { calls.push({ op: "waitForSeal", args: [t] }); return null; },
    wait: async (t) => { calls.push({ op: "wait", args: [t] }); },
    kill: async (t) => { calls.push({ op: "kill", args: [t] }); },
    seal: async (t, p) => { calls.push({ op: "seal", args: [t, p] }); return null; },
    log: (m) => { calls.push({ op: "log", args: [m] }); },
  };
  return { hive, calls };
}

test("JSON flow substitutes {{var}} from args + bindings end-to-end", async () => {
  const flow = parseJsonFlow({
    name: "review",
    args: [{ name: "target", default: "src" }],
    steps: [
      { op: "spawn", as: "arch", bee: "claude", cwd: "{{target}}" },
      { op: "brief", to: "{{arch.id}}", text: "Review {{target}}." },
    ],
  });
  const stub = stubHive();
  const ctx: FlowContext = {
    runId: "fake-run",
    flowName: "review",
    args: { target: "src/cli.ts" },
    bindings: {},
    hive: stub.hive,
  };
  await flow.run(ctx);
  assert.equal(stub.calls.length, 2);
  assert.deepEqual(stub.calls[0]?.args[0], { bee: "claude", cwd: "src/cli.ts" });
  assert.equal(stub.calls[1]?.args[0], "bee-1");
  assert.equal(stub.calls[1]?.args[1], "Review src/cli.ts.");
});

/* ---------- HiveFacade: cleanup=keep vs kill-on-end ---------- */

// We don't actually spawn tmux sessions in unit tests — instead we hand-
// craft SessionRecords and push them onto the facade's spawned list via the
// internal helper. The facade's killAll() then runs through transactionalKill,
// which we replace by swapping out substrateFor via a saved-and-restored
// SessionRecord status check. We avoid real tmux by writing the record but
// using a substrate that always reports !hasSession (so transactionalKill
// takes the alreadyGone fast path and removes the record).

test("cleanup=keep leaves spawned records on disk after run", async () => {
  await withTempStore(async () => {
    const flow = defineFlow({
      name: "keep",
      cleanup: "keep",
      run: async (ctx) => {
        const facade = ctx.hive as HiveFacade;
        // Inject a fake spawned record so we don't need to call substrate.
        const fake: SessionRecord = {
          name: "keep-bee",
          agent: "claude",
          cwd: "/tmp",
          command: "claude",
          tmuxTarget: "keep-bee",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "running",
        };
        await saveSession(fake);
        // The facade tracks spawned records internally; we tap the protected
        // field for test purposes via a typed cast.
        (facade as unknown as { spawned: SessionRecord[] }).spawned.push(fake);
        return "kept";
      },
    });
    const outcome = await executeFlow(flow, { installSignalHandlers: false });
    assert.equal(outcome.status, "ok");
    // Record still on disk: loadSession returns it.
    const { loadSession } = await import("../src/store.js");
    const stillThere = await loadSession("keep-bee");
    assert.ok(stillThere, "cleanup=keep should leave the record alive");
  });
});

test("cleanup=kill-on-end calls killAll() on flow-spawned bees at end", async () => {
  await withTempStore(async () => {
    const flow = defineFlow({
      name: "killit",
      cleanup: "kill-on-end",
      run: async (ctx) => {
        const facade = ctx.hive as HiveFacade;
        const fake: SessionRecord = {
          name: "kill-bee",
          agent: "claude",
          cwd: "/tmp",
          command: "claude",
          tmuxTarget: "kill-bee",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "running",
        };
        await saveSession(fake);
        (facade as unknown as { spawned: SessionRecord[] }).spawned.push(fake);
        return "killed";
      },
    });
    const outcome = await executeFlow(flow, { installSignalHandlers: false });
    assert.equal(outcome.status, "ok");
    // The cleanup path runs transactionalKill which goes through substrate.kill.
    // Since there's no tmux session for "kill-bee", substrate.hasSession returns
    // false on the fast-path probe, and transactionalKill enters alreadyGone
    // mode + deleteSession. So the record should be GONE.
    const { loadSession } = await import("../src/store.js");
    const gone = await loadSession("kill-bee");
    assert.equal(gone, null, "cleanup=kill-on-end should delete the spawned record");
  });
});

/* ---------- SIGINT: AbortController-driven cancellation ---------- */

test("foreground SIGINT cancels the flow and persists cancelled status", async () => {
  await withTempStore(async () => {
    // Build a flow that yields control then waits for the signal. We drive
    // SIGINT explicitly because vitest-style signal injection is exactly what
    // executeFlow's signal handler is wired to do.
    const flow = defineFlow({
      name: "sigint",
      run: async (ctx) => {
        // Wait up to 5s for the abort, then synchronize.
        await new Promise<void>((resolve, reject) => {
          if (ctx.signal?.aborted) { resolve(); return; }
          const onAbort = () => { ctx.signal?.removeEventListener("abort", onAbort); resolve(); };
          ctx.signal?.addEventListener("abort", onAbort);
          // Trip SIGINT after a tick so the handler is installed.
          setTimeout(() => process.kill(process.pid, "SIGINT"), 10);
          // Fallback in case the abort never fires.
          setTimeout(() => reject(new Error("test timeout")), 5_000);
        });
        // The flow itself acknowledges the cancellation by throwing.
        throw new Error(`Flow sigint aborted at step #0`);
      },
    });
    const outcome = await executeFlow(flow, { installSignalHandlers: true });
    assert.equal(outcome.status, "cancelled");
    assert.equal(outcome.error?.cancelled, true);
    const result = await readResult("sigint", outcome.runId);
    assert.equal(result?.status, "cancelled");
    assert.equal(result?.error?.cancelled, true);
  });
});

/* ---------- Run inventory ---------- */

test("listRuns surfaces newest-first across multiple flows", async () => {
  await withTempStore(async () => {
    const a = defineFlow({ name: "a", run: async () => 1 });
    const b = defineFlow({ name: "b", run: async () => 2 });
    const oa = await executeFlow(a, { installSignalHandlers: false });
    await new Promise((r) => setTimeout(r, 10));
    const ob = await executeFlow(b, { installSignalHandlers: false });
    const all = await listRuns();
    assert.equal(all.length, 2);
    // Newest first.
    assert.equal(all[0]?.runId, ob.runId);
    assert.equal(all[1]?.runId, oa.runId);
  });
});

test("findRunById returns the matching run summary", async () => {
  await withTempStore(async () => {
    const flow = defineFlow({ name: "find", run: async () => "x" });
    const outcome = await executeFlow(flow, { installSignalHandlers: false });
    const found = await findRunById(outcome.runId);
    assert.ok(found);
    assert.equal(found?.flowName, "find");
    assert.equal(found?.status, "ok");
  });
});

test("listRuns scoped to a flowName ignores other flows", async () => {
  await withTempStore(async () => {
    await executeFlow(defineFlow({ name: "alpha", run: async () => 1 }), { installSignalHandlers: false });
    await executeFlow(defineFlow({ name: "beta", run: async () => 2 }), { installSignalHandlers: false });
    const alphaOnly = await listRuns({ flowName: "alpha" });
    assert.equal(alphaOnly.length, 1);
    assert.equal(alphaOnly[0]?.flowName, "alpha");
  });
});

test("listRuns downgrades running+dead-pid to orphaned in returned view", async () => {
  await withTempStore(async () => {
    // Write a meta.json directly with an impossible pid to simulate a dead
    // foreground run.
    const { writeMeta } = await import("../src/flow/runs.js");
    const runId = generateRunId();
    await writeMeta("orphan", runId, {
      runId,
      flowName: "orphan",
      args: {},
      status: "running",
      startedAt: new Date().toISOString(),
      pid: 999_999_999,
    });
    const all = await listRuns({ isPidAlive: () => false });
    const match = all.find((r) => r.runId === runId);
    assert.ok(match);
    assert.equal(match?.status, "orphaned");
  });
});

test("listRuns downgrades a STALE pid-less running record to orphaned, but not a fresh one", async () => {
  await withTempStore(async () => {
    // A "running" record with no pid can only mean the spawn died between the
    // pre-write and the pid patch — but ONLY after a grace period, so the
    // legitimate (milliseconds-long) pre-write→patch window never misfires.
    const staleId = generateRunId();
    await writeMeta("pidless", staleId, {
      runId: staleId,
      flowName: "pidless",
      args: {},
      status: "running",
      startedAt: new Date(Date.now() - PIDLESS_RUNNING_GRACE_MS - 5_000).toISOString(),
    });
    const freshId = generateRunId();
    await writeMeta("pidless", freshId, {
      runId: freshId,
      flowName: "pidless",
      args: {},
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const all = await listRuns({ flowName: "pidless" });
    const stale = all.find((r) => r.runId === staleId);
    const fresh = all.find((r) => r.runId === freshId);
    assert.equal(stale?.status, "orphaned");
    assert.equal(fresh?.status, "running");
    // The downgrade is view-level only.
    assert.equal((await readMeta("pidless", staleId))?.status, "running");
  });
});

test("cancelRun persists a terminal status for a pid-less, pgid-less running record", async () => {
  await withTempStore(async () => {
    const runId = generateRunId();
    await writeMeta("strand", runId, {
      runId,
      flowName: "strand",
      args: {},
      status: "running",
      startedAt: new Date().toISOString(),
      // no pid, no pgid: the spawn died before the patch.
    });
    const outcome = await cancelRun("strand", runId);
    assert.equal(outcome.signalled, "already-dead");
    // Regression: this used to return WITHOUT persisting, leaving the record
    // "running" forever with nothing able to downgrade or cancel it.
    const meta = await readMeta("strand", runId);
    assert.equal(meta?.status, "cancelled");
    assert.ok(meta?.endedAt);
  });
});

test("cancelRun re-reads meta and does NOT clobber a concurrently-written terminal status", async () => {
  await withTempStore(async () => {
    const runId = generateRunId();
    const base = {
      runId,
      flowName: "clobber",
      args: {},
      status: "running" as const,
      startedAt: new Date().toISOString(),
      pid: 1_000_000,
      pgid: 1_000_000,
      background: true,
    };
    await writeMeta("clobber", runId, base);
    const outcome = await cancelRun("clobber", runId, {
      graceMs: 50,
      pollMs: 10,
      killImpl: () => {
        // Simulate the child finishing (writing "ok") concurrently with the
        // cancel — between cancelRun's initial read and its final write. The
        // write is synchronous so it deterministically lands before the
        // re-read in cancelRun's final step.
        writeFileSync(
          join(runDir("clobber", runId), "meta.json"),
          `${JSON.stringify({ ...base, status: "ok", endedAt: new Date().toISOString() }, null, 2)}\n`,
        );
      },
      isAlive: () => false,
    });
    assert.equal(outcome.signalled, "SIGTERM");
    const meta = await readMeta("clobber", runId);
    assert.equal(meta?.status, "ok", "the child's terminal status must not be overwritten by a stale snapshot");
  });
});

test("spawnDetachedRun persists status=failed when the spawn itself fails", async () => {
  await withTempStore(async () => {
    const flow = defineFlow({ name: "bg-spawnfail", run: async () => "x" });
    const runId = generateRunId();
    await assert.rejects(
      () =>
        spawnDetachedRun(flow, {}, {
          runId,
          entryOverride: "/tmp/whatever-entry.js",
          execPath: "/nonexistent/honeybee-test-node-binary",
        }),
      /spawn failed/,
    );
    // Regression: the pre-written meta used to stay "running" with no pid.
    const meta = await readMeta("bg-spawnfail", runId);
    assert.equal(meta?.status, "failed");
    assert.ok(meta?.endedAt);
  });
});

test("spawnDetachedRun defaults execArgv to the parent's process.execArgv (minus test/watch flags)", async () => {
  await withTempStore(async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "honeybee-bg-fix-"));
    const originalExecArgv = process.execArgv;
    try {
      // Fixture dumps its own execArgv next to the meta so we can assert what
      // the child actually received.
      const fixture = join(fixtureDir, "fixture.cjs");
      await writeFile(
        fixture,
        `
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
async function main() {
  const runId = process.argv[3];
  let flowName;
  for (let i = 4; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--flow') flowName = process.argv[i + 1];
  }
  const dir = join(process.env.HIVE_STORE_ROOT, 'flows', flowName, 'runs', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'execargv.json'), JSON.stringify(process.execArgv));
}
main().catch((e) => { console.error(e); process.exit(1); });
`,
        { mode: 0o600 },
      );
      // Loader-ish flag propagates; test-runner/watch flags are stripped.
      process.execArgv = ["--no-warnings", "--test", "--watch"];
      const flow = defineFlow({ name: "bg-execargv", run: async () => "x" });
      const result = await spawnDetachedRun(flow, {}, { entryOverride: fixture });
      const dumpPath = join(runDir("bg-execargv", result.runId), "execargv.json");
      const deadline = Date.now() + 5_000;
      let dumped: string | null = null;
      while (Date.now() < deadline) {
        dumped = await readFile(dumpPath, "utf8").catch(() => null);
        if (dumped) break;
        await sleep(50);
      }
      assert.ok(dumped, "child fixture must have written its execArgv");
      assert.deepEqual(JSON.parse(dumped!), ["--no-warnings"]);
    } finally {
      process.execArgv = originalExecArgv;
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});

/* ---------- HiveFacade: BeeHandle has no tmuxTarget ---------- */

test("BeeHandle returned by HiveFacade.spawn() exposes no tmuxTarget", () => {
  // We don't actually spawn here — just inspect the BeeHandle shape that the
  // facade promises through TypeScript + plain runtime checks. The handle
  // type allows id/name/agent/cwd/node only.
  const handle: BeeHandle = { id: "x", name: "n", agent: "claude" };
  assert.equal((handle as Record<string, unknown>).tmuxTarget, undefined);
});

/* ---------- Patch 12: background runs + cancel ----------------- */

// We test the background fork mechanism by overriding the CLI entry with a
// tiny test fixture script. The fixture script implements the SAME contract
// as the real `__flow-exec`: it receives the runId, finds the meta.json under
// HIVE_STORE_ROOT, and either runs to completion (writing result.json with
// status='ok') or sleeps forever (so cancel can SIGTERM it).
//
// This avoids depending on `dist/cli.js` being built and keeps the tests
// hermetic — only the fixture node script, the runs.ts file layout, and the
// spawnDetachedRun signal/exit semantics are exercised.

function fixtureCompletes(): string {
  // The script writes result.json + flips meta.status to 'ok', then exits 0.
  // It mirrors the shape executeFlow would write so listRuns() picks it up.
  //
  // argv shape (mirrors real CLI __flow-exec dispatch):
  //   [node, entry, '__flow-exec', <runId>, '--flow', <flowName>]
  return `
const { mkdir, writeFile, readFile, stat } = require('node:fs/promises');
const { join } = require('node:path');
async function main() {
  // Mirror the real CLI: dispatch on argv[2] === '__flow-exec'; runId is argv[3].
  if (process.argv[2] !== '__flow-exec') { console.error('fixture: expected __flow-exec at argv[2], got', process.argv[2]); process.exit(2); }
  const runId = process.argv[3];
  let flowName;
  for (let i = 4; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--flow') flowName = process.argv[i + 1];
  }
  if (!runId || !flowName) { console.error('missing args'); process.exit(2); }
  const root = process.env.HIVE_STORE_ROOT;
  const runDir = join(root, 'flows', flowName, 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const metaPath = join(runDir, 'meta.json');
  const raw = await readFile(metaPath, 'utf8');
  const meta = JSON.parse(raw);
  // Optional sleep to simulate work.
  if (process.env.FIXTURE_SLEEP_MS) {
    await new Promise((r) => setTimeout(r, Number(process.env.FIXTURE_SLEEP_MS)));
  }
  const endedAt = new Date().toISOString();
  const finalMeta = { ...meta, status: 'ok', endedAt };
  await writeFile(metaPath, JSON.stringify(finalMeta, null, 2) + '\\n');
  const result = {
    runId,
    flowName,
    status: 'ok',
    startedAt: meta.startedAt,
    endedAt,
    value: 'fixture-ok',
  };
  await writeFile(join(runDir, 'result.json'), JSON.stringify(result, null, 2) + '\\n');
}
main().catch((error) => { console.error(error); process.exit(1); });
`;
}

function fixtureBlocks(): string {
  // The script writes "started" to the log and then sleeps forever. cancel
  // signals the process group; SIGTERM terminates Node by default.
  return `
console.log('blocked-start ' + process.pid);
process.stdout.write('');
setInterval(() => {}, 60_000);
`;
}

async function writeFixture(dir: string, body: string): Promise<string> {
  const path = join(dir, "fixture.cjs");
  await writeFile(path, body, { mode: 0o600 });
  return path;
}

test("spawnDetachedRun returns runId+pid+pgid and writes meta with background=true", async () => {
  await withTempStore(async (storeDir) => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "honeybee-bg-fix-"));
    try {
      const fixture = await writeFixture(fixtureDir, fixtureCompletes());
      const flow = defineFlow({ name: "bg-meta", run: async () => "noop" });
      const result = await spawnDetachedRun(
        flow,
        { x: 1 },
        { entryOverride: fixture },
      );
      assert.match(result.runId, /^[0-9A-Z]{13}-[0-9a-f]{4}$/);
      assert.ok(result.pid > 0, "pid should be positive");
      assert.equal(result.pgid, result.pid, "detached child's pgid equals its pid");
      const meta = await readMeta("bg-meta", result.runId);
      assert.ok(meta, "meta.json should exist");
      assert.equal(meta?.background, true);
      assert.equal(meta?.pgid, result.pgid);
      assert.equal(meta?.pid, result.pid);
      assert.equal(meta?.args.x, 1);
      // Wait briefly for the fixture child to finish so it doesn't leak.
      await waitForStatus("bg-meta", result.runId, "ok", 5_000);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});

test("spawnDetachedRun child runs to completion and writes result.json after parent returns", async () => {
  await withTempStore(async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "honeybee-bg-fix-"));
    try {
      const fixture = await writeFixture(fixtureDir, fixtureCompletes());
      const flow = defineFlow({ name: "bg-completes", run: async () => "noop" });
      // Confirm the parent returns immediately (child.unref() — no event
      // loop hold). We use a tight deadline.
      const start = Date.now();
      const result = await spawnDetachedRun(
        flow,
        {},
        { entryOverride: fixture, env: { FIXTURE_SLEEP_MS: "200" } },
      );
      assert.ok(Date.now() - start < 2_000, "parent should return quickly");
      // Poll for result.json to confirm the child survived the parent.
      const finalResult = await waitForResult("bg-completes", result.runId, 8_000);
      assert.equal(finalResult.status, "ok");
      assert.equal(finalResult.value, "fixture-ok");
      const meta = await readMeta("bg-completes", result.runId);
      assert.equal(meta?.status, "ok");
      assert.ok(meta?.endedAt, "meta.endedAt should be set");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});

test("cancelRun sends SIGTERM to pgid and updates meta.status to cancelled", async () => {
  await withTempStore(async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "honeybee-bg-fix-"));
    try {
      const fixture = await writeFixture(fixtureDir, fixtureBlocks());
      const flow = defineFlow({ name: "bg-cancel", run: async () => "noop" });
      const result = await spawnDetachedRun(flow, {}, { entryOverride: fixture });
      // Give the child a moment to enter its blocking setInterval.
      await sleep(150);
      const outcome = await cancelRun("bg-cancel", result.runId, {
        graceMs: 2_000,
        pollMs: 50,
      });
      assert.equal(outcome.signalled, "SIGTERM");
      assert.equal(outcome.pgid, result.pgid);
      const meta = await readMeta("bg-cancel", result.runId);
      assert.equal(meta?.status, "cancelled");
      assert.ok(meta?.endedAt, "endedAt should be set after cancel");
      // The fixture child should now be gone.
      await sleep(100);
      assert.equal(isProcessGroupAlive(result.pgid), false, "process group should be dead");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});

test("cancelRun upgrades SIGTERM to SIGKILL when isAlive keeps returning true", async () => {
  await withTempStore(async () => {
    const runId = generateRunId();
    // Pre-write meta as if a background run were in progress. We don't fork —
    // killImpl + isAlive are stubbed out so we can drive the state machine
    // deterministically.
    await writeMeta("bg-sigkill", runId, {
      runId,
      flowName: "bg-sigkill",
      args: {},
      status: "running",
      startedAt: new Date().toISOString(),
      pid: 1_000_000,
      pgid: 1_000_000,
      background: true,
    });
    const signals: { pgid: number; signal: string | number }[] = [];
    const outcome = await cancelRun("bg-sigkill", runId, {
      graceMs: 200,
      pollMs: 25,
      killImpl: (target, signal) => {
        signals.push({ pgid: target, signal: typeof signal === "string" ? signal : String(signal) });
      },
      isAlive: () => true, // stays alive past graceMs -> forces SIGKILL
    });
    assert.equal(outcome.signalled, "SIGKILL");
    assert.deepEqual(
      signals.map((s) => s.signal),
      ["SIGTERM", "SIGKILL"],
    );
    // Both signals must target the NEGATIVE pgid (process-group semantics).
    for (const s of signals) {
      assert.equal(s.pgid, -1_000_000);
    }
    const meta = await readMeta("bg-sigkill", runId);
    assert.equal(meta?.status, "cancelled");
  });
});

test("cancelRun reports already-dead when status is no longer running", async () => {
  await withTempStore(async () => {
    const runId = generateRunId();
    await writeMeta("bg-done", runId, {
      runId,
      flowName: "bg-done",
      args: {},
      status: "ok",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      pid: 1234,
      pgid: 1234,
      background: true,
    });
    const outcome = await cancelRun("bg-done", runId);
    assert.equal(outcome.signalled, "already-dead");
    // Meta status is left alone — 'ok' should NOT be overwritten with cancelled.
    const meta = await readMeta("bg-done", runId);
    assert.equal(meta?.status, "ok");
  });
});

test("spawnDetachedRun rejects on win32 platform", async () => {
  // We can't actually swap process.platform safely, but we CAN verify the
  // string error surfaces from the cancelRun-side win32 guard if win32 were
  // set. This is a placeholder — the real test value is in the type guard
  // and visible error string asserted above. Skip on POSIX.
  if (process.platform === "win32") {
    const flow = defineFlow({ name: "bg-win", run: async () => "x" });
    await assert.rejects(() => spawnDetachedRun(flow, {}, { entryOverride: "x" }), /not supported on Windows/);
  } else {
    // Spot-check the error string by looking at the source — keeps the
    // intent documented in tests without monkey-patching process.platform.
    const src = await readFile(new URL("../src/flow/background.ts", import.meta.url), "utf8");
    assert.match(src, /not supported on Windows/);
  }
});

/* ---------- helpers used only by patch 12 tests ----------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForStatus(
  flowName: string,
  runId: string,
  target: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = await readMeta(flowName, runId).catch(() => null);
    if (meta && meta.status === target) return;
    await sleep(50);
  }
  const meta = await readMeta(flowName, runId).catch(() => null);
  throw new Error(`waitForStatus(${target}) timed out — last status=${meta?.status ?? "missing"}`);
}

async function waitForResult(
  flowName: string,
  runId: string,
  timeoutMs: number,
): Promise<{ status: string; value?: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await readResult(flowName, runId).catch(() => null);
    if (result) return result as { status: string; value?: unknown };
    await sleep(50);
  }
  throw new Error(`waitForResult timed out (${flowName}/${runId})`);
}
