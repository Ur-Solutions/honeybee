/**
 * Driver integration tests (spec 03 test tier 2): real OS child processes via
 * the stub agent executable. Covers spawn, deliver (booting refusal Q2, accept,
 * mid-turn), stop (TERM honored + KILL escalation), crash mid-turn, clean
 * exit, hang, spawn failure, verbatim session logs, flag evidence, exact
 * process identity (own process group, pid-at-spawn) and boot re-adoption
 * against the real CoreStore's reconcileAtBoot (B7).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { HsrDriver } from "../src/index.ts";
import { claudeAdapter, stubAdapter } from "../../adapters/src/index.ts";
import {
  AGENT_PATH,
  drainEvidenceUntil,
  drainUntil,
  makeRig,
  ofKind,
  pidAlive,
  sleep,
} from "./helpers.ts";

test("spawn: booted carries pid-at-spawn identity; own process group; verbatim session log", async () => {
  const rig = makeRig();
  try {
    rig.agentEnv.set("bee-a", { STUB_SESSION_ID: "sess-a" });
    rig.driver.start("bee-a", 1);

    // pid + start time are available immediately after start() (WP2 amendment).
    const proc = rig.driver.procOf("bee-a", 1);
    assert.ok(proc && proc.pid > 0, "procOf must expose the spawn-time pid");
    assert.ok(proc.pidStartedAt > 0);

    const events = await drainUntil(rig.driver, (e) => ofKind(e, "booted").length > 0);
    const booted = ofKind(events, "booted")[0]!;
    assert.equal(booted.beeId, "bee-a");
    assert.equal(booted.generation, 1);
    assert.equal(booted.pid, proc.pid);
    assert.equal(booted.pidStartedAt, proc.pidStartedAt);
    // A ready-without-initial-turn boot lands on idle: booted then turn_ended.
    await drainUntil(rig.driver, () => true, 50).catch(() => undefined);

    // Own process group (spec point 1): the child is its own group leader.
    const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(proc.pid)], { encoding: "utf8" }).trim());
    assert.equal(pgid, proc.pid, "detached child must lead its own process group");

    // Q1: the session log is the verbatim native stream.
    const log = readFileSync(rig.driver.sessionLogPath("bee-a"), "utf8").trim().split("\n");
    const ready = JSON.parse(log[0]!) as Record<string, unknown>;
    assert.deepEqual(ready, { event: "ready", sessionId: "sess-a" });

    assert.ok(rig.driver.hasProcess("bee-a", 1));
    assert.deepEqual(rig.driver.snapshotLive(), [
      { beeId: "bee-a", generation: 1, pid: proc.pid, pidStartedAt: proc.pidStartedAt },
    ]);
  } finally {
    rig.cleanup();
  }
});

test("start throws while the bee already has a live, healthy process", async () => {
  const rig = makeRig();
  try {
    rig.driver.start("bee-dup", 1);
    assert.throws(() => rig.driver.start("bee-dup", 2), /already has a live process/);
  } finally {
    rig.cleanup();
  }
});

test("deliver: not_ready while booting (Q2); accepted at idle; ground truth + agent ack", async () => {
  const rig = makeRig();
  try {
    rig.agentEnv.set("bee-b", { STUB_BOOT_DELAY_MS: "300" });
    rig.driver.start("bee-b", 1);

    // Refusal during boot is deterministic and reasoned — never a queue.
    assert.deepEqual(rig.driver.deliver("bee-b", 1, 11, "early"), { accepted: false, reason: "not_ready" });
    assert.equal(rig.driver.consumedGeneration(11), undefined);

    await drainUntil(rig.driver, (e) => ofKind(e, "turn_ended").length >= 1); // booted → idle
    assert.deepEqual(rig.driver.deliver("bee-b", 1, 11, "hello"), { accepted: true });
    assert.equal(rig.driver.consumedGeneration(11), 1);

    const events = await drainUntil(
      rig.driver,
      (e) => ofKind(e, "turn_started").length >= 1 && ofKind(e, "turn_ended").length >= 1,
    );
    assert.ok(ofKind(events, "turn_started").length >= 1);

    // The agent actually received message 11 (its ack is in the verbatim log).
    const log = readFileSync(rig.driver.sessionLogPath("bee-b"), "utf8");
    assert.match(log, /"turn_started","messageId":11/);
    assert.match(log, /echo:hello/);

    // Stale generation / unknown bee → no_process.
    assert.deepEqual(rig.driver.deliver("bee-b", 2, 12, "x"), { accepted: false, reason: "no_process" });
    assert.deepEqual(rig.driver.deliver("nobody", 1, 13, "x"), { accepted: false, reason: "no_process" });
  } finally {
    rig.cleanup();
  }
});

test("stop: TERM honored → exited(stopped_by_user); dead-already is hadProcess:false", async () => {
  const rig = makeRig();
  try {
    rig.driver.start("bee-c", 1);
    await drainUntil(rig.driver, (e) => ofKind(e, "booted").length > 0);
    const pid = rig.driver.procOf("bee-c", 1)!.pid;

    assert.deepEqual(rig.driver.stop("bee-c", 1, "stopped_by_user"), { hadProcess: true });
    const events = await drainUntil(rig.driver, (e) => ofKind(e, "exited").length > 0);
    assert.equal(ofKind(events, "exited")[0]!.exitCause, "stopped_by_user");
    assert.ok(!rig.driver.hasProcess("bee-c", 1));
    await sleep(20);
    assert.ok(!pidAlive(pid), "process must actually be gone");

    // A second stop is a truthful no-op, never an error (spec point 4).
    assert.deepEqual(rig.driver.stop("bee-c", 1, "stopped_by_user"), { hadProcess: false });
    assert.deepEqual(rig.driver.stop("bee-never", 1, "stopped_by_system"), { hadProcess: false });
  } finally {
    rig.cleanup();
  }
});

test("stop: SIGTERM-ignoring process is KILLed after the bounded grace", async () => {
  const rig = makeRig({ stopKillGraceMs: 150 });
  try {
    rig.agentEnv.set("bee-d", { STUB_IGNORE_SIGTERM: "1" });
    rig.driver.start("bee-d", 1);
    await drainUntil(rig.driver, (e) => ofKind(e, "booted").length > 0);
    const pid = rig.driver.procOf("bee-d", 1)!.pid;

    const t0 = Date.now();
    rig.driver.stop("bee-d", 1, "stopped_by_system");
    const events = await drainUntil(rig.driver, (e) => ofKind(e, "exited").length > 0, 3000);
    const elapsed = Date.now() - t0;
    assert.equal(ofKind(events, "exited")[0]!.exitCause, "stopped_by_system");
    assert.ok(elapsed >= 140, `KILL escalated too early (${elapsed}ms < grace)`);
    await sleep(20);
    assert.ok(!pidAlive(pid));
  } finally {
    rig.cleanup();
  }
});

test("crash mid-turn → exited(crashed); hang → no turn_ended, stop still works", async () => {
  const rig = makeRig();
  try {
    rig.driver.start("bee-e", 1);
    await drainUntil(rig.driver, (e) => ofKind(e, "turn_ended").length >= 1);
    assert.equal(rig.driver.deliver("bee-e", 1, 21, "@crash").accepted, true);
    const crashed = await drainUntil(rig.driver, (e) => ofKind(e, "exited").length > 0);
    assert.equal(ofKind(crashed, "exited")[0]!.exitCause, "crashed");

    rig.driver.start("bee-f", 1);
    await drainUntil(rig.driver, (e) => ofKind(e, "turn_ended").length >= 1);
    assert.equal(rig.driver.deliver("bee-f", 1, 22, "@hang").accepted, true);
    await drainUntil(rig.driver, (e) => ofKind(e, "turn_started").length >= 1);
    await sleep(150);
    assert.deepEqual(ofKind(rig.driver.observe(), "turn_ended"), [], "a hung turn must not end");
    rig.driver.stop("bee-f", 1, "stopped_by_system");
    const stopped = await drainUntil(rig.driver, (e) => ofKind(e, "exited").length > 0);
    assert.equal(ofKind(stopped, "exited")[0]!.exitCause, "stopped_by_system");
  } finally {
    rig.cleanup();
  }
});

test("clean exit after a turn → exited(clean)", async () => {
  const rig = makeRig();
  try {
    rig.driver.start("bee-g", 1);
    await drainUntil(rig.driver, (e) => ofKind(e, "turn_ended").length >= 1);
    assert.equal(rig.driver.deliver("bee-g", 1, 31, "done please @exit").accepted, true);
    const events = await drainUntil(rig.driver, (e) => ofKind(e, "exited").length > 0);
    assert.equal(ofKind(events, "exited")[0]!.exitCause, "clean");
    // The turn completed before the exit.
    assert.ok(ofKind(events, "turn_ended").length >= 1);
  } finally {
    rig.cleanup();
  }
});

test("boot crash (exit before ready) and unspawnable binary → exited(crashed), never a throw", async () => {
  const rig = makeRig();
  try {
    rig.agentEnv.set("bee-h", { STUB_EXIT_BEFORE_READY: "1" });
    rig.driver.start("bee-h", 1);
    const events = await drainUntil(rig.driver, (e) => ofKind(e, "exited").length > 0);
    assert.equal(ofKind(events, "exited")[0]!.exitCause, "crashed");
    assert.equal(ofKind(events, "booted").length, 0);
  } finally {
    rig.cleanup();
  }

  const rig2 = makeRig();
  const driver = new HsrDriver({
    sessionLogDir: join(rig2.dir, "logs2"),
    resolve: () => ({
      adapter: stubAdapter,
      command: join(rig2.dir, "no-such-binary"),
      args: [],
    }),
  });
  try {
    driver.start("bee-i", 1);
    const events = await drainUntil(driver, (e) => ofKind(e, "exited").length > 0);
    assert.equal(ofKind(events, "exited")[0]!.exitCause, "crashed");
  } finally {
    driver.disposeAll();
    rig2.cleanup();
  }
});

test("flag evidence: auth/rate-limit setters and their contrary-evidence clearers", async () => {
  const rig = makeRig();
  try {
    rig.driver.start("bee-j", 1);
    await drainUntil(rig.driver, (e) => ofKind(e, "turn_ended").length >= 1);
    // The boot itself is spawn_failed contrary evidence.
    const bootEvidence = await drainEvidenceUntil(rig.driver, (ev) =>
      ev.some((f) => f.flag === "spawn_failed" && f.action === "clear"),
    );
    assert.ok(bootEvidence.every((f) => f.beeId === "bee-j" && f.generation === 1));

    assert.equal(rig.driver.deliver("bee-j", 1, 41, "@authfail").accepted, true);
    await drainEvidenceUntil(rig.driver, (ev) =>
      ev.some((f) => f.flag === "auth_needed" && f.action === "set"),
    );

    assert.equal(rig.driver.deliver("bee-j", 1, 42, "@ratelimit").accepted, true);
    await drainEvidenceUntil(rig.driver, (ev) =>
      ev.some((f) => f.flag === "resource_blocked" && f.action === "set"),
    );

    // A successful turn clears both (the flag-clearing rule, spec 03).
    assert.equal(rig.driver.deliver("bee-j", 1, 43, "all good now").accepted, true);
    const clears = await drainEvidenceUntil(rig.driver, (ev) =>
      ev.some((f) => f.flag === "auth_needed" && f.action === "clear") &&
      ev.some((f) => f.flag === "resource_blocked" && f.action === "clear"),
    );
    assert.ok(clears.length >= 2);
  } finally {
    rig.cleanup();
  }
});

test("re-adoption (B7): reconcileAtBoot adopts the surviving pid and stops the dead one", async () => {
  const rig = makeRig();
  const dbPath = join(rig.dir, "core.sqlite3");
  try {
    rig.driver.start("bee-k", 1);
    await drainUntil(rig.driver, (e) => ofKind(e, "booted").length > 0);
    const proc = rig.driver.procOf("bee-k", 1)!;

    // The daemon records process identity at spawn (pid-at-spawn amendment).
    let store = openCoreStore(dbPath);
    store.createBee({ id: "bee-k", name: "bee-k", agent: "stub", substrate: "hsr", cwd: rig.dir, proc });
    store.close();

    // Daemon restart: reopen the store, reconcile against the driver's snapshot.
    store = openCoreStore(dbPath);
    const rec = store.reconcileAtBoot(
      rig.driver.snapshotLive().map((p) => ({ pid: p.pid, startedAt: p.pidStartedAt })),
    );
    assert.deepEqual(rec.adopted, [{ beeId: "bee-k", generation: 1, pid: proc.pid }]);
    assert.deepEqual(rec.stopped, []);

    // Now the process dies while the daemon is away; the next boot must
    // reconcile it to stopped(machine_restart) — never a failed state.
    rig.driver.stop("bee-k", 1, "stopped_by_system");
    await drainUntil(rig.driver, (e) => ofKind(e, "exited").length > 0);
    const rec2 = store.reconcileAtBoot(
      rig.driver.snapshotLive().map((p) => ({ pid: p.pid, startedAt: p.pidStartedAt })),
    );
    assert.deepEqual(rec2.adopted, []);
    assert.deepEqual(rec2.stopped, [{ beeId: "bee-k", generation: 1 }]);
    assert.equal(store.currentRuntime("bee-k")!.exitCause, "machine_restart");
    store.close();
  } finally {
    rig.cleanup();
  }
});

test("revive while the old process is dying: start defers, spawns after the death, in order", async () => {
  const rig = makeRig({ stopKillGraceMs: 200 });
  try {
    rig.agentEnv.set("bee-l", { STUB_IGNORE_SIGTERM: "1" }); // maximize the dying window
    rig.driver.start("bee-l", 1);
    await drainUntil(rig.driver, (e) => ofKind(e, "booted").length > 0);

    rig.driver.stop("bee-l", 1, "stopped_by_system");
    // While generation 1 is dying, the daemon may already start generation 2.
    rig.agentEnv.set("bee-l", {});
    rig.driver.start("bee-l", 2);
    assert.ok(rig.driver.hasProcess("bee-l", 2), "deferred start still reads as a process in flight");
    // A dying generation-1 process must not swallow deliveries.
    assert.deepEqual(rig.driver.deliver("bee-l", 1, 51, "x"), { accepted: false, reason: "not_ready" });

    const events = await drainUntil(
      rig.driver,
      (e) => ofKind(e, "booted").some((b) => b.generation === 2),
      5000,
    );
    const exited = ofKind(events, "exited");
    assert.equal(exited[0]!.generation, 1);
    const bootedGen2 = ofKind(events, "booted").find((b) => b.generation === 2)!;
    assert.ok(
      events.indexOf(exited[0]!) < events.indexOf(bootedGen2),
      "generation 1 must exit before generation 2 boots",
    );
    assert.ok(rig.driver.procOf("bee-l", 2)!.pid > 0);
  } finally {
    rig.cleanup();
  }
});

test("observe() and observeEvidence() never block and drain exactly once", async () => {
  const rig = makeRig();
  try {
    assert.deepEqual(rig.driver.observe(), []);
    assert.deepEqual(rig.driver.observeEvidence(), []);
    rig.driver.start("bee-m", 1);
    const events = await drainUntil(rig.driver, (e) => ofKind(e, "booted").length > 0);
    assert.ok(events.length > 0);
    assert.deepEqual(rig.driver.observe(), [], "a second drain right after must be empty");
  } finally {
    rig.cleanup();
  }
});

test("session log survives across generations as one verbatim stream (Q1)", async () => {
  const rig = makeRig();
  try {
    rig.agentEnv.set("bee-n", { STUB_SESSION_ID: "gen1" });
    rig.driver.start("bee-n", 1);
    await drainUntil(rig.driver, (e) => ofKind(e, "turn_ended").length >= 1);
    rig.driver.stop("bee-n", 1, "stopped_by_user");
    await drainUntil(rig.driver, (e) => ofKind(e, "exited").length > 0);

    rig.agentEnv.set("bee-n", { STUB_SESSION_ID: "gen2" });
    rig.driver.start("bee-n", 2);
    await drainUntil(rig.driver, (e) => ofKind(e, "booted").some((b) => b.generation === 2));

    const path = rig.driver.sessionLogPath("bee-n");
    assert.ok(existsSync(path));
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const readies = lines.filter((l) => l.event === "ready").map((l) => l.sessionId);
    assert.deepEqual(readies, ["gen1", "gen2"]);
  } finally {
    rig.cleanup();
  }
});

test("readyAtSpawn: silent-until-input runtime (claude stream-json) is deliverable at spawn", async (t) => {
  // Encodes the WP3 smoke discovery: claude -p --input-format stream-json
  // emits NOTHING until the first stdin message. Waiting for init deadlocks;
  // readyAtSpawn adapters must get a synthetic booted and accept delivery
  // immediately, with stdin buffering carrying the message.
  const dir = mkdtempSync(join(tmpdir(), "hive-drv-ras-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, "silent-claude.mjs");
  writeFileSync(fake, `
    process.stdin.setEncoding("utf8");
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        buf = buf.slice(i + 1);
        // First contact: init arrives only now, then the turn result.
        process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "late-sess" }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }) + "\\n");
      }
    });
  `);
  const driver = new HsrDriver({
    sessionLogDir: join(dir, "logs"),
    resolve: () => ({
      adapter: claudeAdapter,
      command: process.execPath,
      args: [fake],
    }),
  });
  try {
    driver.start("ras-1", 1);
    const out = driver.deliver("ras-1", 1, 1, "hello");
    assert.equal(out.accepted, true, `deliver at spawn: ${out.reason ?? "accepted"}`);
    // The synthetic booted observation arrives as soon as the OS confirms the
    // spawn (the `spawn` event, milliseconds) — never gated on the runtime's
    // first output line.
    const first = await drainUntil(driver, (e) => ofKind(e, "booted").length > 0, 2000);
    assert.equal(ofKind(first, "exited").length, 0, "no exit before the synthetic booted");
    const seen: string[] = first.map((e) => e.kind);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !seen.includes("turn_ended")) {
      seen.push(...driver.observe().map((e) => e.kind));
      await sleep(50);
    }
    assert.ok(seen.includes("turn_started"), "driver-synthesized turn_started");
    assert.ok(seen.includes("turn_ended"), "turn_ended from the late stream");
  } finally {
    driver.stop("ras-1", 1, "stopped_by_system");
  }
});

test("readyAtSpawn: a spawn that fails outright (missing cwd / binary) is exited(crashed) with NO synthetic booted", async (t) => {
  // The spawn-loop hazard: before, the synthetic booted was pushed
  // synchronously, so a claude bee with a missing cwd looked like
  // booted → running → crashed every generation and never counted as a boot
  // failure. The `spawn` event gate makes the failure honest: the store stays
  // in booting, the exit counts against the bee's spawn-failure budget.
  const dir = mkdtempSync(join(tmpdir(), "hive-drv-ras-fail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missingCwd = new HsrDriver({
    sessionLogDir: join(dir, "logs-cwd"),
    resolve: () => ({
      adapter: claudeAdapter,
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      cwd: join(dir, "no-such-cwd"),
    }),
  });
  try {
    missingCwd.start("ras-cwd", 1);
    const events = await drainUntil(missingCwd, (e) => ofKind(e, "exited").length > 0, 2000);
    assert.equal(ofKind(events, "booted").length, 0, "no synthetic booted for a failed spawn");
    assert.equal(ofKind(events, "exited")[0]!.exitCause, "crashed");
    assert.equal(missingCwd.hasProcess("ras-cwd", 1), false);
  } finally {
    missingCwd.disposeAll();
  }
  const missingBinary = new HsrDriver({
    sessionLogDir: join(dir, "logs-bin"),
    resolve: () => ({
      adapter: claudeAdapter,
      command: join(dir, "no-such-claude"),
      args: [],
    }),
  });
  try {
    missingBinary.start("ras-bin", 1);
    const events = await drainUntil(missingBinary, (e) => ofKind(e, "exited").length > 0, 2000);
    assert.equal(ofKind(events, "booted").length, 0, "no synthetic booted for a missing binary");
    assert.equal(ofKind(events, "exited")[0]!.exitCause, "crashed");
  } finally {
    missingBinary.disposeAll();
  }
});

test("late init must not close an in-flight turn (cell smoke 2026-08-17 phantom turn_ended)", async (t) => {
  // Real claude: init arrives ~100ms AFTER the first message, then the model
  // works for a while, then `result`. Before the fix the adapter's
  // bootedToIdle turn_ended (companion of the late init) closed the live turn
  // ~100ms in — callers saw "turn ended", found no output, tore claude down.
  const dir = mkdtempSync(join(tmpdir(), "hive-drv-lateinit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = join(dir, "late-init-claude.mjs");
  writeFileSync(fake, `
    process.stdin.setEncoding("utf8");
    let buf = "";
    process.stdin.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        buf = buf.slice(i + 1);
        // init arrives late, THEN the model "works" 600ms, THEN result.
        process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "late-sess" }) + "\\n");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "DONE" }) + "\\n");
        }, 600);
      }
    });
  `);
  const driver = new HsrDriver({
    sessionLogDir: join(dir, "logs"),
    resolve: () => ({ adapter: claudeAdapter, command: process.execPath, args: [fake] }),
  });
  try {
    driver.start("li-1", 1);
    driver.observe(); // synthetic booted
    assert.equal(driver.deliver("li-1", 1, 1, "work").accepted, true);
    const t0 = Date.now();
    let endedAt: number | null = null;
    const seen: string[] = [];
    while (Date.now() - t0 < 3000) {
      for (const e of driver.observe()) {
        seen.push(e.kind);
        if (e.kind === "turn_ended" && endedAt == null) endedAt = Date.now() - t0;
      }
      if (endedAt != null) break;
      await sleep(25);
    }
    assert.ok(endedAt != null, "the real result must end the turn");
    assert.ok(endedAt >= 500, `turn_ended must wait for the real result (~600ms), got ${endedAt}ms — phantom late-init turn_ended`);
    assert.equal(seen.filter((k) => k === "turn_ended").length, 1, "exactly one turn_ended");
  } finally {
    driver.stop("li-1", 1, "stopped_by_system");
  }
});

test("session evidence (spec 07 §F): the booted session id is drained via observeSessions, once per value, per generation", async () => {
  const rig = makeRig();
  try {
    rig.agentEnv.set("bee-s", { STUB_SESSION_ID: "sess-frozen-1" });
    rig.driver.start("bee-s", 1);
    await drainUntil(rig.driver, (e) => ofKind(e, "booted").length > 0);
    const sessions = rig.driver.observeSessions();
    assert.deepEqual(sessions, [{ beeId: "bee-s", generation: 1, sessionId: "sess-frozen-1" }]);
    assert.deepEqual(rig.driver.observeSessions(), [], "drained");
    // generation 2 after a stop reports again (same value → new generation, new evidence)
    rig.driver.stop("bee-s", 1, "stopped_by_user");
    await drainUntil(rig.driver, (e) => ofKind(e, "exited").length > 0);
    rig.driver.start("bee-s", 2);
    await drainUntil(rig.driver, (e) => ofKind(e, "booted").length > 0);
    assert.deepEqual(rig.driver.observeSessions(), [{ beeId: "bee-s", generation: 2, sessionId: "sess-frozen-1" }]);
  } finally {
    rig.cleanup();
  }
});

test("v6 interrupt: idle → reasoned no-op; mid-turn (hung) → in-band interrupt ends the turn (turn_ended), process stays live, next delivery works; booting/gone → not_ready/no_process", async () => {
  const rig = makeRig();
  try {
    rig.agentEnv.set("bee-i", { STUB_BOOT_DELAY_MS: "150" });
    rig.driver.start("bee-i", 1);
    assert.deepEqual(rig.driver.interrupt("bee-i", 1), { interrupted: false, reason: "not_ready" }, "booting: no channel yet");
    await drainUntil(rig.driver, (e) => ofKind(e, "turn_ended").length >= 1); // booted → idle
    const proc = rig.driver.procOf("bee-i", 1)!;
    assert.deepEqual(rig.driver.interrupt("bee-i", 1), { interrupted: false, reason: "idle" });

    // a hung turn: never ends on its own
    assert.deepEqual(rig.driver.deliver("bee-i", 1, 21, "@hang"), { accepted: true });
    await drainUntil(rig.driver, (e) => ofKind(e, "turn_started").length >= 1);
    await sleep(80);
    assert.deepEqual(rig.driver.observe().filter((e) => e.kind === "turn_ended"), [], "hung: no turn_ended");

    // interrupt → the stub ends the turn now; the process is NOT killed
    assert.deepEqual(rig.driver.interrupt("bee-i", 1), { interrupted: true });
    const ended = await drainUntil(rig.driver, (e) => ofKind(e, "turn_ended").length >= 1);
    assert.equal(ofKind(ended, "exited").length, 0, "runtime still live");
    assert.ok(rig.driver.hasProcess("bee-i", 1));
    assert.ok(pidAlive(proc.pid));
    const log = readFileSync(rig.driver.sessionLogPath("bee-i"), "utf8");
    assert.match(log, /"turn_ended","messageId":21,"ok":true,"interrupted":true/);

    // the runtime is idle again and takes the next message
    assert.deepEqual(rig.driver.deliver("bee-i", 1, 22, "after"), { accepted: true });
    const next = await drainUntil(rig.driver, (e) => ofKind(e, "turn_ended").length >= 1);
    assert.equal(ofKind(next, "exited").length, 0);
    assert.match(readFileSync(rig.driver.sessionLogPath("bee-i"), "utf8"), /echo:after/);

    // gone / stale generation
    assert.deepEqual(rig.driver.interrupt("bee-i", 2), { interrupted: false, reason: "no_process" });
    assert.deepEqual(rig.driver.interrupt("nobody", 1), { interrupted: false, reason: "no_process" });
    // dying (stop requested) → not_ready
    rig.driver.stop("bee-i", 1, "stopped_by_user");
    assert.deepEqual(rig.driver.interrupt("bee-i", 1), { interrupted: false, reason: "not_ready" });
    await drainUntil(rig.driver, (e) => ofKind(e, "exited").length >= 1);
  } finally {
    rig.cleanup();
  }
});

test("v6 interrupt: a harness without an in-band interrupt answers unsupported (never SIGINT)", async () => {
  const rig = makeRig();
  try {
    const noInterrupt = { ...stubAdapter };
    delete (noInterrupt as { encodeInterrupt?: unknown }).encodeInterrupt;
    const dir = rig.dir;
    const driver = new HsrDriver({
      sessionLogDir: join(dir, "logs2"),
      stopKillGraceMs: 400,
      resolve: () => ({ adapter: noInterrupt, command: process.execPath, args: [AGENT_PATH], cwd: dir, env: { ...process.env, STUB_TURN_MS: "5" } }),
    });
    try {
      driver.start("bee-u", 1);
      await drainUntil(driver, (e) => ofKind(e, "turn_ended").length >= 1);
      assert.deepEqual(driver.deliver("bee-u", 1, 31, "@hang"), { accepted: true });
      await drainUntil(driver, (e) => ofKind(e, "turn_started").length >= 1);
      assert.deepEqual(driver.interrupt("bee-u", 1), { interrupted: false, reason: "unsupported" });
      assert.ok(driver.hasProcess("bee-u", 1));
    } finally {
      driver.disposeAll();
    }
  } finally {
    rig.cleanup();
  }
});
