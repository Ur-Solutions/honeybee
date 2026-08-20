/**
 * TmuxDriver integration (spec 05 test tier 2): private-socket sessions,
 * exact-identity spawn/stop, exit-cause recovery via remain-on-exit,
 * kill-server guard, and cross-restart adoption with full deliverability.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { TmuxServer } from "../src/tmux.ts";
import { drainUntil, kinds, makeRig, sleep } from "./helpers.ts";
import { pidAlive } from "../../driver-hsr/src/psutil.ts";

test("tmux.roundtrip: spawn on the private socket, deliver, observe a full turn, clean @exit", async () => {
  const rig = makeRig();
  try {
    rig.configure("bee-1", "transcript");
    rig.driver.start("bee-1", 1);
    const boot = await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "booted"));
    const booted = boot.find((x) => x.kind === "booted");
    assert.ok(booted?.pid != null && booted.pid > 0, "pid captured at spawn");
    assert.ok(booted.pidStartedAt != null);
    assert.deepEqual(kinds(boot).slice(0, 2), ["booted", "turn_ended"]); // boots straight to idle

    // The session lives on OUR private server, listed there and only there.
    const sessions = new TmuxServer({ socketPath: rig.socketPath }).run(["list-sessions", "-F", "#{session_name}"]);
    assert.match(sessions, /hive-v2-bee-1-g1/);

    const outcome = rig.driver.deliver("bee-1", 1, 1, "hello tmux");
    assert.equal(outcome.accepted, true);
    const turn = await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "turn_ended"));
    assert.deepEqual(kinds(turn), ["turn_started", "turn_ended"]);
    assert.equal(rig.driver.consumedGeneration(1), 1);
    assert.deepEqual(rig.driver.observeDeliveryNotes(), [], "confirmed delivery carries no note");

    // Clean exit: @exit → pane dead with status 0 → exitCause clean.
    assert.equal(rig.driver.deliver("bee-1", 1, 2, "bye @exit").accepted, true);
    const exit = await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "exited"));
    assert.equal(exit.find((x) => x.kind === "exited")?.exitCause, "clean");
    assert.equal(rig.driver.hasProcess("bee-1", 1), false);
  } finally {
    rig.cleanup();
  }
});

test("tmux.crash: a mid-turn process death is observed as exited(crashed)", async () => {
  const rig = makeRig();
  try {
    rig.configure("bee-1", "transcript");
    rig.driver.start("bee-1", 1);
    await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "booted"));
    rig.driver.deliver("bee-1", 1, 1, "oops @crash");
    const exit = await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "exited"));
    assert.equal(exit.find((x) => x.kind === "exited")?.exitCause, "crashed");
  } finally {
    rig.cleanup();
  }
});

test("tmux.stop: TERM stops the exact pid; a SIGTERM-ignoring runtime gets the KILL escalation", async () => {
  const rig = makeRig();
  try {
    rig.configure("bee-1", "transcript");
    rig.driver.start("bee-1", 1);
    await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "booted"));
    const pid = rig.driver.procOf("bee-1", 1)?.pid;
    assert.ok(pid != null);
    assert.deepEqual(rig.driver.stop("bee-1", 1, "stopped_by_user"), { hadProcess: true });
    const exit = await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "exited"));
    assert.equal(exit.find((x) => x.kind === "exited")?.exitCause, "stopped_by_user");
    assert.equal(pidAlive(pid), false);
    // Stopping again: no process, honestly reported.
    assert.deepEqual(rig.driver.stop("bee-1", 1, "stopped_by_user"), { hadProcess: false });

    // KILL escalation for a TERM-ignoring runtime. A full turn first: the
    // stub must demonstrably be running (signal handler installed) before
    // the TERM, or the test would race node's own boot.
    rig.configure("bee-2", "transcript", { TMUX_STUB_IGNORE_SIGTERM: "1" });
    rig.driver.start("bee-2", 1);
    await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "booted"));
    rig.driver.deliver("bee-2", 1, 99, "warmup");
    await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "turn_ended"));
    const pid2 = rig.driver.procOf("bee-2", 1)?.pid;
    assert.ok(pid2 != null);
    const termAt = Date.now();
    rig.driver.stop("bee-2", 1, "stopped_by_system");
    const exit2 = await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "exited"), 8000);
    assert.equal(exit2.find((x) => x.kind === "exited")?.exitCause, "stopped_by_system");
    assert.equal(pidAlive(pid2), false);
    // The death took the KILL escalation path (TERM was demonstrably ignored
    // for the full grace window).
    assert.ok(Date.now() - termAt >= 400, "exit before the grace window — TERM was not ignored");
  } finally {
    rig.cleanup();
  }
});

test("tmux.kill-server-guard: kill-server refuses without the pinned opt-in (the v1 lesson)", () => {
  const rig = makeRig();
  try {
    // Through the command path: never allowed, even on an opted-in server.
    const opted = new TmuxServer({ socketPath: rig.socketPath, allowKillServer: true });
    assert.throws(() => opted.try(["kill-server"]), /refusing/);
    assert.throws(() => opted.run(["kill-server"]), /refusing/);
    // killServer() without the explicit opt-in: refused.
    const unpinned = new TmuxServer({ socketPath: rig.socketPath });
    assert.throws(() => unpinned.killServer(), /refusing to run `tmux kill-server`/);
    // And a socketless server cannot even be constructed.
    assert.throws(() => new TmuxServer({ socketPath: "" }), /private socketPath is required/);
  } finally {
    rig.cleanup();
  }
});

test("tmux.adopt: a fresh driver instance re-adopts by exact identity and stays fully deliverable", async () => {
  const rig = makeRig();
  try {
    rig.configure("bee-1", "transcript");
    rig.driver.start("bee-1", 1);
    await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "booted"));
    rig.driver.deliver("bee-1", 1, 1, "first turn");
    await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "turn_ended" ));
    const proc = rig.driver.procOf("bee-1", 1);
    assert.ok(proc);

    // "Daemon restart": a new driver object, same socket, no shared state.
    const driver2 = rig.makeSiblingDriver();
    assert.equal(driver2.snapshotLive().length, 0);
    // Wrong identity refuses (recycled-pid protection).
    assert.equal(driver2.adopt("bee-1", 1, proc.pid, proc.pidStartedAt - 60_000), false);
    assert.equal(driver2.adopt("bee-1", 1, proc.pid, proc.pidStartedAt), true);
    assert.deepEqual(driver2.snapshotLive(), [
      { beeId: "bee-1", generation: 1, pid: proc.pid, pidStartedAt: proc.pidStartedAt },
    ]);

    // Adopted runtimes settle to idle via quiescence (no new turn required)…
    await drainUntil(driver2, (e) => e.some((x) => x.kind === "turn_ended"));
    // …and remain FULLY deliverable after the restart (spec: never degraded).
    assert.equal(driver2.deliver("bee-1", 1, 2, "post-restart message").accepted, true);
    const turn = await drainUntil(driver2, (e) => e.some((x) => x.kind === "turn_started"));
    assert.ok(kinds(turn).includes("turn_started"), "post-restart delivery observer-confirmed");
    await drainUntil(driver2, (e) => e.some((x) => x.kind === "turn_ended"));
    assert.deepEqual(driver2.observeDeliveryNotes(), []);

    driver2.stop("bee-1", 1, "stopped_by_user");
    await drainUntil(driver2, (e) => e.some((x) => x.kind === "exited"));
  } finally {
    rig.cleanup();
  }
});

test("tmux.session-hygiene: dead panes are reaped from the private server", async () => {
  const rig = makeRig();
  try {
    rig.configure("bee-1", "transcript");
    rig.driver.start("bee-1", 1);
    await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "booted"));
    rig.driver.deliver("bee-1", 1, 1, "bye @exit");
    await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "exited"));
    await sleep(50);
    const res = spawnSync("tmux", ["-S", rig.socketPath, "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
    });
    assert.ok(!(res.stdout ?? "").includes("hive-v2-bee-1-g1"), "dead session must be cleaned up");
  } finally {
    rig.cleanup();
  }
});

test("tmux.interrupt (v6): idle → no-op; a hung turn is ended by C-c to the exact pane (turn_ended observed), the runtime stays live and takes the next message; gone → no_process", async () => {
  const rig = makeRig();
  try {
    rig.configure("bee-1", "hooks");
    rig.driver.start("bee-1", 1);
    const boot = await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "turn_ended"));
    const pid = boot.find((x) => x.kind === "booted")?.pid as number;
    assert.deepEqual(rig.driver.interrupt("bee-1", 1), { interrupted: false, reason: "idle" });

    assert.equal(rig.driver.deliver("bee-1", 1, 1, "please @hang").accepted, true);
    await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "turn_started"));
    await sleep(80);
    assert.deepEqual(kinds(rig.driver.observe()).filter((k) => k === "turn_ended"), [], "hung: no turn_ended");

    assert.deepEqual(rig.driver.interrupt("bee-1", 1), { interrupted: true });
    const ended = await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "turn_ended"), 6000);
    assert.equal(ended.some((x) => x.kind === "exited"), false, "C-c ends the turn, not the process");
    assert.ok(rig.driver.hasProcess("bee-1", 1));
    assert.ok(pidAlive(pid));

    assert.equal(rig.driver.deliver("bee-1", 1, 2, "after").accepted, true);
    const next = await drainUntil(rig.driver, (e) => e.some((x) => x.kind === "turn_ended"), 6000);
    assert.equal(next.some((x) => x.kind === "exited"), false);
    assert.deepEqual(rig.driver.interrupt("bee-1", 2), { interrupted: false, reason: "no_process" });
    assert.deepEqual(rig.driver.interrupt("nobody", 1), { interrupted: false, reason: "no_process" });
  } finally {
    rig.cleanup();
  }
});
