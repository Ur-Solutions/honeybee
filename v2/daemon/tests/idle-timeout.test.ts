/**
 * Idle-timeout reaper (2026-09-02): the DaemonCore policy that stops a
 * runtime idle past its effective timeout with exit cause `idle_timeout`.
 *
 * Unit tier (DaemonCore + FakeDriver + virtual clock): the timeout fires; it
 * does NOT fire while running / booting / mail pending / a question is open /
 * any condition flag is set; per-bee override and the 0 = never value; the
 * decision is re-checked right before the kill (a message that lands between
 * the policy's decision and the stop turns the reap into a recorded no-op);
 * one dying generation never earns a second stop; revive-on-send (including
 * `--urgency now`) works exactly as for any stopped bee.
 *
 * Integration tier (real daemon + stub agent over a temp socket): tiny
 * window → stopped(idle_timeout) → `send --urgency now` revives and delivers;
 * a bee spawned with idleTimeoutMs 0 is left alone until the override is
 * lifted over `bee.setIdleTimeout`; `health.idleTimeoutMs` reports the node
 * value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLAGS, openCoreStore, type CoreStore, type Flag } from "../../core/src/index.ts";
import type { StopCause } from "../../harness/src/driver.ts";
import { DaemonCore, type DaemonPolicy } from "../src/loops.ts";
import type {
  HealthResult,
  MailboxResult,
  SendRpcResult,
  SetIdleTimeoutResult,
  SpawnResult,
  ViewResult,
} from "../src/protocol.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { FakeDriver, makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

// ---------------------------------------------------------------------------
// unit tier
// ---------------------------------------------------------------------------

/**
 * A FakeDriver whose stop() signals but does not exit until told — the real
 * shape (SIGTERM now, the exit observation a tick or more later).
 */
class SlowStopDriver extends FakeDriver {
  readonly stops: Array<{ beeId: string; generation: number; cause: StopCause }> = [];
  private readonly dying = new Map<string, { generation: number; cause: StopCause }>();

  override stop(beeId: string, generation: number, cause: StopCause): { hadProcess: boolean } {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation) return { hadProcess: false };
    this.stops.push({ beeId, generation, cause });
    this.dying.set(beeId, { generation, cause });
    return { hadProcess: true };
  }

  exitNow(beeId: string): void {
    const d = this.dying.get(beeId);
    if (!d) throw new Error(`${beeId} is not dying`);
    this.dying.delete(beeId);
    this.procs.delete(beeId);
    this.events.push({ beeId, generation: d.generation, kind: "exited", exitCause: d.cause });
  }
}

interface Rig<D extends FakeDriver = FakeDriver> {
  store: CoreStore;
  driver: D;
  core: DaemonCore;
  clock: { now: number };
  /** The live policy object — mutable so a test can hold the executor (commandsPerStep 0). */
  policy: DaemonPolicy;
  ops: string[];
  cleanup: () => void;
}

function makeRig<D extends FakeDriver>(
  policy: Partial<DaemonPolicy>,
  driverOf: (now: () => number) => D,
): Rig<D> {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-idle-"));
  const clock = { now: 1000 };
  const now = (): number => clock.now;
  const store = openCoreStore(join(dir, "core.sqlite3"), { now, maxAttempts: 3, backoffBaseMs: 1, ephemeral: true });
  const driver = driverOf(now);
  const ops: string[] = [];
  const live: DaemonPolicy = { bootHangTimeoutSteps: 100_000, commandsPerStep: 8, idleWindowSteps: 100, ...policy };
  const core = new DaemonCore({ store, driver, policy: live, now, log: (op) => ops.push(op) });
  core.boot();
  return {
    store,
    driver,
    core,
    clock,
    policy: live,
    ops,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const rig = (policy: Partial<DaemonPolicy> = {}): Rig => makeRig(policy, (now) => new FakeDriver(now));
const slowRig = (policy: Partial<DaemonPolicy> = {}): Rig<SlowStopDriver> => makeRig(policy, (now) => new SlowStopDriver(now));

function spawnIdle(r: Rig, id = "bee-1", opts: { idleTimeoutMs?: number | null } = {}): void {
  r.store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp", ...opts });
  r.store.enqueueCommand("spawn", id);
  r.core.step(); // spawn → booted + turn_ended queued
  r.core.step(); // drain → running → idle
  r.core.step();
  assert.equal(r.store.currentRuntime(id)?.state, "idle");
}

/** Advance past the window and run enough steps for policy → stop → exit drain. */
function pastWindow(r: Rig, by = 200): void {
  r.clock.now += by;
  r.core.step();
  r.core.step();
}

/** The harness answers a delivery with a turn (turn_started → turn_ended): the idle clock restarts. */
function turn(r: Rig, id = "bee-1", generation = 1): void {
  r.driver.events.push({ beeId: id, generation, kind: "turn_started" });
  r.driver.events.push({ beeId: id, generation, kind: "turn_ended" });
  r.core.step();
  assert.equal(r.store.currentRuntime(id)?.state, "idle");
}

function stopCommands(r: Rig, id = "bee-1"): number {
  return r.store.listCommands({ beeId: id }).filter((c) => c.verb === "stop").length;
}

test("idle.1: fires — idle past the window → stopped(idle_timeout), distinct from stopped_by_system, audited on the runtime row", () => {
  const r = rig();
  try {
    spawnIdle(r);
    r.clock.now += 100; // exactly the window: not past it
    r.core.step();
    assert.equal(r.store.currentRuntime("bee-1")?.state, "idle");
    assert.equal(stopCommands(r), 0);
    pastWindow(r, 1);
    const rt = r.store.currentRuntime("bee-1");
    assert.equal(rt?.state, "stopped");
    assert.equal(rt?.exitCause, "idle_timeout");
    const stop = r.store.listCommands({ beeId: "bee-1" }).find((c) => c.verb === "stop");
    assert.deepEqual(stop?.args, { cause: "idle_timeout", reason: "idle_timeout" });
    assert.equal(stop?.status, "done");
    assert.ok(r.ops.some((o) => o.startsWith("policy.idle_stop bee=bee-1 gen=1 idleFor=101 timeout=100")), r.ops.join("\n"));
    // `hive events` / --json: the runtime.updated audit row carries the cause.
    const updated = r.store.auditRows().filter((a) => a.kind === "runtime.updated" && a.beeId === "bee-1");
    const last = updated[updated.length - 1]?.payload as { runtime: { exitCause: string } };
    assert.equal(last.runtime.exitCause, "idle_timeout");
    assert.equal(r.store.view("bee-1").exitCause, "idle_timeout");
    assert.equal(r.store.view("bee-1").reachable, true, "a reaped bee stays reachable");
  } finally {
    r.cleanup();
  }
});

test("idle.2: never fires while running — a turn in flight is not idle, however long it takes", () => {
  const r = rig();
  try {
    r.driver.autoBoot = false;
    r.store.createBee({ id: "bee-1", name: "bee-1", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    r.store.enqueueCommand("spawn", "bee-1");
    r.core.step();
    const p = r.driver.procs.get("bee-1")!;
    r.driver.events.push({ beeId: "bee-1", generation: 1, kind: "booted", pid: p.pid, pidStartedAt: p.pidStartedAt });
    r.core.step();
    assert.equal(r.store.currentRuntime("bee-1")?.state, "running");
    r.clock.now += 10_000;
    r.core.step();
    r.core.step();
    assert.equal(r.store.currentRuntime("bee-1")?.state, "running");
    assert.equal(stopCommands(r), 0);
    // The turn ends: the clock starts THEN, not at spawn.
    r.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_ended" });
    r.core.step();
    assert.equal(r.store.currentRuntime("bee-1")?.state, "idle");
    r.clock.now += 50;
    r.core.step();
    assert.equal(stopCommands(r), 0, "idle for 50 of 100: not yet");
    pastWindow(r, 60);
    assert.equal(r.store.currentRuntime("bee-1")?.exitCause, "idle_timeout");
  } finally {
    r.cleanup();
  }
});

test("idle.3: never fires while booting — only the boot-hang policy governs a missing handshake", () => {
  const r = rig();
  try {
    r.driver.autoBoot = false;
    r.store.createBee({ id: "bee-1", name: "bee-1", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    r.store.enqueueCommand("spawn", "bee-1");
    r.core.step();
    assert.equal(r.store.currentRuntime("bee-1")?.state, "booting");
    r.clock.now += 10_000;
    r.core.step();
    r.core.step();
    assert.equal(r.store.currentRuntime("bee-1")?.state, "booting");
    assert.equal(stopCommands(r), 0);
    assert.ok(!r.ops.some((o) => o.startsWith("policy.idle_stop")));
  } finally {
    r.cleanup();
  }
});

test("idle.4: never fires with undelivered mail — and fires once the mailbox drains", () => {
  const r = rig();
  try {
    spawnIdle(r);
    r.driver.acceptDeliveries = false;
    r.store.send("bee-1", "pending");
    r.clock.now += 1000;
    r.core.step();
    r.core.step();
    assert.equal(r.store.currentRuntime("bee-1")?.state, "idle");
    assert.equal(stopCommands(r), 0);
    r.driver.acceptDeliveries = true;
    r.core.step(); // deliver
    assert.equal(r.store.undeliveredMessages("bee-1").length, 0);
    // Delivered but unanswered: the harness holds input it has not turned on
    // yet — not provably idle, so still no reap (silence is not evidence).
    r.core.step();
    r.core.step();
    assert.equal(r.store.currentRuntime("bee-1")?.state, "idle");
    assert.equal(stopCommands(r), 0);
    turn(r); // the harness answers; the clock restarts at this idle edge
    r.core.step();
    assert.equal(stopCommands(r), 0, "fresh idle edge: within the window again");
    pastWindow(r);
    assert.equal(r.store.currentRuntime("bee-1")?.exitCause, "idle_timeout");
  } finally {
    r.cleanup();
  }
});

test("idle.5: never fires with an open `hive ask` question — the answer lifts the hold", () => {
  const r = rig();
  try {
    spawnIdle(r);
    const q = r.store.askQuestion("bee-1", { text: "merge or rebase?" });
    r.clock.now += 1000;
    r.core.step();
    r.core.step();
    assert.equal(r.store.currentRuntime("bee-1")?.state, "idle");
    assert.equal(stopCommands(r), 0);
    // The answer is delivered as mail; once it lands the window applies again.
    r.store.answerQuestion(q.id, "rebase");
    r.core.step(); // deliver the answer
    assert.equal(r.store.undeliveredMessages("bee-1").length, 0);
    turn(r); // the bee acts on the answer
    pastWindow(r);
    assert.equal(r.store.currentRuntime("bee-1")?.exitCause, "idle_timeout");
  } finally {
    r.cleanup();
  }
});

for (const flag of FLAGS) {
  test(`idle.6[${flag}]: never fires while the ${flag} flag is set — clearing it lets the window apply`, () => {
    const r = rig();
    try {
      spawnIdle(r);
      r.store.setFlag("bee-1", flag as Flag, "test");
      r.clock.now += 1000;
      r.core.step();
      r.core.step();
      assert.equal(r.store.currentRuntime("bee-1")?.state, "idle");
      assert.equal(stopCommands(r), 0);
      r.store.clearFlag("bee-1", flag as Flag, "test");
      r.core.step();
      r.core.step();
      assert.equal(r.store.currentRuntime("bee-1")?.exitCause, "idle_timeout");
    } finally {
      r.cleanup();
    }
  });
}

test("idle.7: per-bee override — a longer and a shorter timeout each win over the node value; the override applies to the CURRENT runtime", () => {
  const r = rig({ idleWindowSteps: 100 });
  try {
    spawnIdle(r, "long", { idleTimeoutMs: 500 });
    spawnIdle(r, "short", { idleTimeoutMs: 20 });
    spawnIdle(r, "plain");
    r.clock.now += 30;
    r.core.step();
    r.core.step();
    assert.equal(r.store.currentRuntime("short")?.exitCause, "idle_timeout", "short's own 20 fired");
    assert.equal(r.store.currentRuntime("long")?.state, "idle");
    assert.equal(r.store.currentRuntime("plain")?.state, "idle");
    r.clock.now += 100;
    r.core.step();
    r.core.step();
    assert.equal(r.store.currentRuntime("plain")?.exitCause, "idle_timeout", "the node's 100 fired");
    assert.equal(r.store.currentRuntime("long")?.state, "idle", "long's own 500 holds");
    // Changing the override mid-generation applies at once: no revive needed.
    r.store.updateBeeIdleTimeout("long", 50);
    r.core.step();
    r.core.step();
    assert.equal(r.store.currentRuntime("long")?.exitCause, "idle_timeout");
    assert.ok(r.ops.some((o) => o.includes("policy.idle_stop bee=long") && o.endsWith("timeout=50 perBee")), r.ops.join("\n"));
  } finally {
    r.cleanup();
  }
});

test("idle.8: 0 = never — a disabled bee is never reaped; a per-bee value still applies when the node reaper is off", () => {
  const r = rig({ idleWindowSteps: null });
  try {
    spawnIdle(r, "keep", { idleTimeoutMs: 0 });
    spawnIdle(r, "own", { idleTimeoutMs: 40 });
    spawnIdle(r, "plain");
    r.clock.now += 1_000_000;
    r.core.step();
    r.core.step();
    assert.equal(r.store.currentRuntime("keep")?.state, "idle");
    assert.equal(r.store.currentRuntime("plain")?.state, "idle", "node reaper off + inherit = never");
    assert.equal(r.store.currentRuntime("own")?.exitCause, "idle_timeout");
    // The node reaper comes on; `keep` still says never.
    r.policy.idleWindowSteps = 10;
    r.clock.now += 1_000_000;
    r.core.step();
    r.core.step();
    assert.equal(r.store.currentRuntime("keep")?.state, "idle");
    assert.equal(r.store.currentRuntime("plain")?.exitCause, "idle_timeout");
  } finally {
    r.cleanup();
  }
});

test("idle.9: the race — mail arrives between the decision and the kill: the stop settles as a no-op, the runtime stays, the mail is delivered, no bounce", () => {
  const r = rig();
  try {
    spawnIdle(r);
    r.policy.commandsPerStep = 0; // hold the executor: the decision is made, the kill is not
    r.clock.now += 200;
    r.core.step();
    const stop = r.store.listCommands({ beeId: "bee-1" }).find((c) => c.verb === "stop");
    assert.equal(stop?.status, "queued");
    assert.deepEqual(stop?.args, { cause: "idle_timeout", reason: "idle_timeout" });
    const sent = r.store.send("bee-1", "just in time");
    assert.equal(sent.wakeCommand, null, "the runtime is live: no wake");
    r.policy.commandsPerStep = 8;
    r.core.step(); // executor: re-check → skip; delivery: deliver
    r.core.step();
    const rt = r.store.currentRuntime("bee-1");
    assert.equal(rt?.state, "idle");
    assert.equal(rt?.generation, 1, "no revive bounce");
    assert.equal(r.store.getCommand(stop!.id)?.status, "done", "the moot stop settles done, never failed");
    assert.ok(r.ops.some((o) => o === `cmd.stop.skip id=${stop!.id} bee=bee-1 gen=1 cause=idle_timeout reason=pending_mail`), r.ops.join("\n"));
    assert.deepEqual(r.driver.deliveredIds, [sent.message.id]);
    assert.equal(r.driver.starts.length, 1);
    // The delivered message has not been answered by a turn yet: the reaper
    // waits for the next idle edge, so no second stop is enqueued meanwhile.
    r.clock.now += 200;
    r.core.step();
    r.core.step();
    assert.equal(stopCommands(r), 1);
    assert.equal(r.store.currentRuntime("bee-1")?.state, "idle");
    turn(r);
    pastWindow(r);
    assert.equal(r.store.currentRuntime("bee-1")?.exitCause, "idle_timeout");
  } finally {
    r.cleanup();
  }
});

test("idle.10: the race, other blockers — a question asked or a flag set after the decision also makes the kill a no-op", () => {
  for (const block of ["question", "flag"] as const) {
    const r = rig();
    try {
      spawnIdle(r);
      r.policy.commandsPerStep = 0;
      r.clock.now += 200;
      r.core.step();
      assert.equal(stopCommands(r), 1);
      if (block === "question") r.store.askQuestion("bee-1", { text: "still there?" });
      else r.store.setFlag("bee-1", "auth_needed", "expired");
      r.policy.commandsPerStep = 8;
      r.core.step();
      r.core.step();
      assert.equal(r.store.currentRuntime("bee-1")?.state, "idle", block);
      const reason = block === "question" ? "open_question" : "flag=auth_needed";
      assert.ok(r.ops.some((o) => o.includes(`cmd.stop.skip`) && o.endsWith(`reason=${reason}`)), r.ops.join("\n"));
    } finally {
      r.cleanup();
    }
  }
});

test("idle.11: one dying generation earns exactly one stop — the exit landing ticks later never re-triggers the reaper", () => {
  const r = slowRig();
  try {
    spawnIdle(r);
    r.clock.now += 200;
    r.core.step(); // decide + signal
    r.core.step();
    r.core.step();
    r.clock.now += 200;
    r.core.step();
    assert.equal(r.driver.stops.length, 1, "signaled once");
    assert.equal(stopCommands(r), 1, "one stop command, not one per tick");
    assert.equal(r.store.currentRuntime("bee-1")?.state, "idle", "still idle until the exit is observed");
    r.driver.exitNow("bee-1");
    r.core.step();
    assert.equal(r.store.currentRuntime("bee-1")?.exitCause, "idle_timeout");
    assert.deepEqual(r.driver.stops[0], { beeId: "bee-1", generation: 1, cause: "idle_timeout" });
  } finally {
    r.cleanup();
  }
});

test("idle.12: operator stop is unchanged — cause stopped_by_user, and the reaper leaves a runtime the operator is already stopping alone", () => {
  const r = slowRig();
  try {
    spawnIdle(r);
    r.store.enqueueCommand("stop", "bee-1", { cause: "stopped_by_user" });
    r.core.step(); // signal (user)
    r.clock.now += 200;
    r.core.step();
    r.core.step();
    assert.equal(stopCommands(r), 1, "no reaper stop on top of the operator's");
    r.driver.exitNow("bee-1");
    r.core.step();
    assert.equal(r.store.currentRuntime("bee-1")?.exitCause, "stopped_by_user");
  } finally {
    r.cleanup();
  }
});

test("idle.13: revive-on-send after a reap — next, idle and `now` urgency all wake generation N+1 and deliver", () => {
  for (const urgency of ["next", "idle", "now"] as const) {
    const r = rig();
    try {
      spawnIdle(r);
      pastWindow(r);
      assert.equal(r.store.currentRuntime("bee-1")?.exitCause, "idle_timeout");
      const sent = r.store.send("bee-1", `wake ${urgency}`, { urgency });
      assert.ok(sent.wakeCommand, "send to a reaped bee enqueues send_wake in the same transaction");
      r.core.step(); // wake → revive gen 2
      r.core.step(); // booted + turn_ended → idle
      r.core.step(); // deliver
      assert.equal(r.store.currentRuntime("bee-1")?.generation, 2, urgency);
      assert.equal(r.store.currentRuntime("bee-1")?.state, "idle");
      assert.deepEqual(r.driver.deliveredIds, [sent.message.id]);
      assert.equal(r.store.undeliveredMessages("bee-1").length, 0);
      assert.equal(r.driver.interrupts.length, 0, "an idle runtime is never interrupted");
    } finally {
      r.cleanup();
    }
  }
});

test("idle.14: a bee whose exit cause is idle_timeout counts as a clean stop for the spawn budget (never a boot failure)", () => {
  const r = rig();
  try {
    spawnIdle(r);
    pastWindow(r);
    assert.equal(r.store.getBee("bee-1")?.spawnFailures, 0);
    assert.deepEqual(r.store.activeFlags("bee-1"), []);
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// integration tier — a real daemon, the stub agent
// ---------------------------------------------------------------------------

async function settleIdle(client: RpcClient, beeId: string, what: string): Promise<void> {
  await waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.view.runtimeState === "idle";
  }, what, 30_000);
}

test("idle.int: tiny window → stopped(idle_timeout); `send --urgency now` revives + delivers; idleTimeoutMs 0 keeps a bee up until lifted; health reports the node value", async () => {
  const { dir, cleanup } = makeDaemonDir({ idleWindowMs: 250, tickMs: 40 });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const health = await client.request<HealthResult>("health");
    assert.equal(health.idleTimeoutMs, 250);

    const sleepy = (await client.request<SpawnResult>("spawn", { name: "sleepy", agent: "stub", cwd: "/tmp" })).beeId;
    const keeper = (await client.request<SpawnResult>("spawn", { name: "keeper", agent: "stub", cwd: "/tmp", idleTimeoutMs: 0 })).beeId;
    await settleIdle(client, sleepy, "sleepy idle");
    await settleIdle(client, keeper, "keeper idle");
    const keeperView = await client.request<ViewResult>("view", { beeId: keeper });
    assert.equal(keeperView.bee?.idleTimeoutMs, 0);

    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: sleepy });
      return v.view.runtimeState === "stopped";
    }, "sleepy reaped", 10_000);
    const stopped = await client.request<ViewResult>("view", { beeId: sleepy });
    assert.equal(stopped.view.exitCause, "idle_timeout");
    assert.equal(stopped.view.reachable, true);
    const kept = await client.request<ViewResult>("view", { beeId: keeper });
    assert.equal(kept.view.runtimeState, "idle", "idleTimeoutMs 0 = never reaped");

    // `--urgency now` to a reaped bee: the wake is enqueued with the send and
    // generation 2 receives the message.
    const sent = await client.request<SendRpcResult>("send", { beeId: sleepy, body: "urgent revive", urgency: "now" });
    assert.ok(sent.commandId != null, "send to a reaped bee enqueues the wake in the same transaction");
    const gen = await waitFor(async () => {
      const { messages } = await client.request<MailboxResult>("mailbox", { beeId: sleepy });
      const m = messages.find((x) => x.id === sent.messageId);
      return m?.deliveredAt != null ? m.deliveredGeneration : null;
    }, "delivered into the revived generation", 12_000);
    assert.equal(gen, 2);

    // Lifting the override over RPC applies to the current runtime.
    const set = await client.request<SetIdleTimeoutResult>("bee.setIdleTimeout", { beeId: keeper, idleTimeoutMs: null });
    assert.equal(set.applied, true);
    assert.equal(set.bee.idleTimeoutMs, null);
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: keeper });
      return v.view.runtimeState === "stopped" && v.view.exitCause === "idle_timeout";
    }, "keeper reaped after the override was lifted", 10_000);
    // Validation: a negative or fractional value is a typed request error.
    await assert.rejects(
      client.request("bee.setIdleTimeout", { beeId: keeper, idleTimeoutMs: -1 }),
      (err: unknown) => err instanceof Error && /non-negative integer/.test(err.message),
    );
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
