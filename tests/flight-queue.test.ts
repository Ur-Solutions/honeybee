import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sweepFlights, type FlightQueueOps, type FlightSweepDeps } from "../src/flight/controller.js";
import {
  claimNextTask,
  enqueueTask,
  finishTask,
  leasedTaskForSlot,
  listTasks,
  readTask,
  taskCounts,
} from "../src/flight/store.js";
import {
  FLIGHT_CONTRACT_DEFAULTS,
  FLIGHT_REPLACEMENT_DEFAULTS,
  slotBeeName,
  type FlightRecord,
  type FlightTaskPacket,
  type SlotRecord,
  type SlotSealObservation,
} from "../src/flight/types.js";
import type { BeeState } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";
import { saveSession } from "../src/store.js";
import { nextRuntimeIncarnationPatch, recordSeal, validateSealArtifact } from "../src/seal.js";
import { latestSealForCurrentIncarnation } from "../src/daemon/flightSweep.js";

const T0 = Date.parse("2026-07-21T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-flight-queue-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function flight(overrides: Partial<FlightRecord> = {}): FlightRecord {
  return {
    id: "FL.q01",
    name: "parity-queue",
    cwd: "/tmp",
    target: { slots: 2, mix: [{ key: "fable", agent: "claude", count: 2 }] },
    contract: { ...FLIGHT_CONTRACT_DEFAULTS },
    replacement: { ...FLIGHT_REPLACEMENT_DEFAULTS },
    status: "active",
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...overrides,
  };
}

function vacantSlot(slotId: string): SlotRecord {
  return { flightId: "FL.q01", slotId, mixKey: "fable", generation: 0, attempt: 0, state: "vacant", since: iso(T0), evidence: {}, history: [] };
}

function bee(name: string): SessionRecord {
  return {
    name,
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: name,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    status: "running",
  };
}

/** In-memory queue implementing FlightQueueOps (mirrors the store semantics). */
function memoryQueue(initialPending: FlightTaskPacket[]): FlightQueueOps & { buckets: Record<string, FlightTaskPacket[]> } {
  const buckets: Record<string, FlightTaskPacket[]> = { pending: [...initialPending], leased: [], done: [], failed: [] };
  return {
    buckets,
    counts: async () => ({
      pending: buckets.pending!.length,
      leased: buckets.leased!.length,
      done: buckets.done!.length,
      failed: buckets.failed!.length,
    }),
    claimNext: async (_flightId, lease) => {
      const next = buckets.pending!.shift();
      if (!next) return null;
      const leased = { ...next, lease: { ...lease, leasedAt: iso(T0) } };
      buckets.leased!.push(leased);
      return leased;
    },
    leasedForSlot: async (_flightId, slotId) => buckets.leased!.find((task) => task.lease?.slotId === slotId) ?? null,
    finish: async (_flightId, taskId, bucket, outcome) => {
      const index = buckets.leased!.findIndex((task) => task.taskId === taskId);
      if (index < 0) return;
      const [task] = buckets.leased!.splice(index, 1);
      buckets[bucket]!.push({ ...task!, outcome: { at: iso(T0), ...outcome } });
    },
  };
}

function packet(taskId: string, overrides: Partial<FlightTaskPacket> = {}): FlightTaskPacket {
  return { taskId, brief: `do ${taskId}`, enqueuedAt: iso(T0), ...overrides };
}

type Harness = {
  deps: FlightSweepDeps;
  slots: Map<string, SlotRecord>;
  flights: Map<string, FlightRecord>;
  ledger: Array<Record<string, unknown>>;
  spawned: Array<{ name: string; task?: string; cwd?: string; brief?: string }>;
  seals: Map<string, SlotSealObservation>;
  queue: ReturnType<typeof memoryQueue>;
  nowMs: () => number;
  setNow: (ms: number) => void;
};

function harness(flightRecord: FlightRecord, initialSlots: SlotRecord[], pending: FlightTaskPacket[], startMs: number): Harness {
  const slots = new Map(initialSlots.map((slot) => [slot.slotId, slot]));
  const flights = new Map([[flightRecord.id, flightRecord]]);
  const ledger: Array<Record<string, unknown>> = [];
  const spawned: Harness["spawned"] = [];
  const seals = new Map<string, SlotSealObservation>();
  const queue = memoryQueue(pending);
  let now = startMs;
  return {
    slots,
    flights,
    ledger,
    spawned,
    seals,
    queue,
    nowMs: () => now,
    setNow: (ms) => {
      now = ms;
    },
    deps: {
      listFlights: async () => [...flights.values()],
      loadFlight: async (flightId) => flights.get(flightId) ?? null,
      listSlots: async () => [...slots.values()].sort((a, b) => a.slotId.localeCompare(b.slotId, undefined, { numeric: true })),
      saveSlot: async (slot) => {
        slots.set(slot.slotId, slot);
      },
      saveFlight: async (f) => {
        flights.set(f.id, f);
      },
      latestSeal: async (beeName) => seals.get(beeName) ?? null,
      spawnSlot: async (f, slot, _mix, task) => {
        const name = slotBeeName(f.id, slot.slotId, slot.generation, slot.attempt);
        spawned.push({ name, ...(task ? { task: task.taskId, cwd: task.cwd ?? f.cwd, brief: task.brief } : {}) });
        return { beeName: name };
      },
      nudge: async () => undefined,
      queue,
      appendLedger: async (event) => {
        ledger.push(event);
      },
      now: () => now,
    },
  };
}

test("lane-keeper: a done task recycles the lane onto the next packet until the queue is empty", async () => {
  const f = flight({ target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] } });
  const h = harness(f, [vacantSlot("s1")], [packet("t1"), packet("t2", { cwd: "/tmp/wt2" })], T0);

  // Sweep 1: lane claims t1 and spawns with the packet's brief.
  await sweepFlights(h.deps, [], new Map());
  assert.equal(h.spawned.length, 1);
  assert.equal(h.spawned[0]!.task, "t1");
  const g0Bee = h.spawned[0]!.name;
  assert.equal(h.slots.get("s1")!.taskId, "t1");
  assert.equal(h.slots.get("s1")!.generation, 0);
  assert.ok(h.ledger.some((e) => e.type === "flight.task.claimed" && e.task === "t1"));

  // Worker seals t1 (contract taskId = queue task id, attempt-scoped).
  h.seals.set(g0Bee, { filename: "seal-t1.json", sealedAt: iso(T0 + 60_000), status: "done", taskId: "t1", attempt: 1 });
  h.setNow(T0 + 2 * 60_000);
  await sweepFlights(h.deps, [bee(g0Bee)], new Map<string, BeeState>([[g0Bee, "sealed"]]));

  // t1 filed as done; lane recycled to generation 1 and claimed t2 with its cwd.
  assert.equal(h.queue.buckets.done!.length, 1);
  assert.equal(h.queue.buckets.done![0]!.taskId, "t1");
  assert.equal(h.queue.buckets.done![0]!.outcome?.sealFilename, "seal-t1.json");
  assert.ok(h.ledger.some((e) => e.type === "flight.task.done" && e.task === "t1"));
  const s1 = h.slots.get("s1")!;
  assert.equal(s1.generation, 1);
  assert.equal(s1.taskId, "t2");
  assert.equal(s1.state, "booting");
  assert.equal(h.spawned.length, 2);
  assert.equal(h.spawned[1]!.task, "t2");
  assert.equal(h.spawned[1]!.cwd, "/tmp/wt2");
  assert.notEqual(h.spawned[1]!.name, g0Bee, "generations never collide on bee names");
  assert.ok(s1.history.some((entry) => entry.taskId === "t1" && entry.outcome === "task-done"));

  // Worker seals t2; queue is now empty → lane drains and the flight completes.
  const g1Bee = h.spawned[1]!.name;
  h.seals.set(g1Bee, { filename: "seal-t2.json", sealedAt: iso(T0 + 3 * 60_000), status: "done", taskId: "t2", attempt: 1 });
  h.setNow(T0 + 4 * 60_000);
  const outcomes = await sweepFlights(h.deps, [bee(g1Bee)], new Map<string, BeeState>([[g1Bee, "sealed"]]));
  assert.equal(h.queue.buckets.done!.length, 2);
  assert.equal(h.slots.get("s1")!.state, "drained");
  assert.ok(h.ledger.some((e) => e.type === "flight.slot.drained"));
  assert.ok(outcomes.some((o) => o.action === "complete" && /tasks 2 done, 0 failed/.test(o.detail ?? "")));
  assert.equal(h.flights.get(f.id)!.status, "closed");
});

test("lane-keeper: attempt exhaustion fails the TASK but the lane lives on to the next packet", async () => {
  const f = flight({
    target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] },
    contract: { ...FLIGHT_CONTRACT_DEFAULTS, maxAttemptsPerSlot: 1 },
  });
  const h = harness(f, [vacantSlot("s1")], [packet("poison"), packet("good")], T0);

  await sweepFlights(h.deps, [], new Map());
  const poisonBee = h.spawned[0]!.name;
  assert.equal(h.spawned[0]!.task, "poison");

  // The worker crashes; attempt 1 was the only allowed attempt.
  h.setNow(T0 + 60_000);
  await sweepFlights(h.deps, [], new Map()); // missing record + past nothing → held (booting grace)
  h.setNow(T0 + f.contract.readinessDeadlineMs + 61_000);
  await sweepFlights(h.deps, [{ ...bee(poisonBee), status: "dead" }], new Map());

  // Task filed as failed; lane recycled (NOT abandoned) and claimed the next packet.
  assert.equal(h.queue.buckets.failed!.length, 1);
  assert.equal(h.queue.buckets.failed![0]!.taskId, "poison");
  assert.ok(h.ledger.some((e) => e.type === "flight.task.failed" && e.task === "poison"));
  const s1 = h.slots.get("s1")!;
  assert.equal(s1.state, "booting");
  assert.equal(s1.taskId, "good");
  assert.equal(s1.generation, 1);
});

test("lane-keeper: enqueueing onto a drained lane revives it next sweep", async () => {
  const f = flight({ target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] } });
  const h = harness(f, [vacantSlot("s1")], [packet("t1")], T0);
  await sweepFlights(h.deps, [], new Map());
  const worker = h.spawned[0]!.name;
  h.seals.set(worker, { filename: "s.json", sealedAt: iso(T0 + 60_000), status: "done", taskId: "t1", attempt: 1 });
  h.setNow(T0 + 2 * 60_000);
  await sweepFlights(h.deps, [bee(worker)], new Map<string, BeeState>([[worker, "sealed"]]));
  assert.equal(h.slots.get("s1")!.state, "drained");
  // Production has no reopen/status-active API. This in-memory mutation keeps
  // the record active only to exercise the supported drained-lane invariant:
  // an already-active queue-backed flight revives a lane when work appears.
  h.flights.set(f.id, { ...h.flights.get(f.id)!, status: "active" });

  h.queue.buckets.pending!.push(packet("t9"));
  h.setNow(T0 + 3 * 60_000);
  await sweepFlights(h.deps, [bee(worker)], new Map<string, BeeState>([[worker, "sealed"]]));
  const s1 = h.slots.get("s1")!;
  assert.equal(s1.state, "booting");
  assert.equal(s1.taskId, "t9");
  assert.ok(h.ledger.some((e) => e.type === "flight.vacancy" && e.reason === "task-available"));
});

test("lane-keeper: a crash mid-claim re-binds the leased task to its slot instead of skipping it", async () => {
  const f = flight({ target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] } });
  const h = harness(f, [vacantSlot("s1")], [], T0);
  // Simulate: task was claimed for s1 but the slot prepare was lost.
  h.queue.buckets.leased!.push({ ...packet("orphaned"), lease: { slotId: "s1", generation: 0, leasedAt: iso(T0) } });
  await sweepFlights(h.deps, [], new Map());
  const s1 = h.slots.get("s1")!;
  assert.equal(s1.taskId, "orphaned");
  assert.equal(s1.state, "booting");
  assert.equal(h.spawned[0]!.task, "orphaned");
  // No double-claim: pending untouched, exactly one lease.
  assert.equal(h.queue.buckets.leased!.length, 1);
});

test("queue store: enqueue → claim → finish round-trip on disk with duplicate refusal", async () => {
  await withTempStore(async () => {
    const id = "FL.disk1";
    await enqueueTask(id, { taskId: "t1", brief: "do t1", enqueuedAt: iso(T0) });
    await enqueueTask(id, { taskId: "t2", brief: "do t2", cwd: "/tmp/wt", enqueuedAt: iso(T0 + 1) });
    await assert.rejects(() => enqueueTask(id, { taskId: "t1", brief: "dup" }), /already exists/);

    assert.deepEqual(await taskCounts(id), { pending: 2, leased: 0, done: 0, failed: 0 });

    const claimed = await claimNextTask(id, { slotId: "s1", generation: 0 });
    assert.equal(claimed?.taskId, "t1");
    assert.equal(claimed?.lease?.slotId, "s1");
    assert.equal((await leasedTaskForSlot(id, "s1"))?.taskId, "t1");
    assert.deepEqual(await taskCounts(id), { pending: 1, leased: 1, done: 0, failed: 0 });

    await finishTask(id, "t1", "done", { sealFilename: "seal.json" });
    const done = await readTask(id, "done", "t1");
    assert.equal(done?.outcome?.sealFilename, "seal.json");
    // idempotent re-finish is a no-op
    await finishTask(id, "t1", "failed", { reason: "nope" });
    assert.deepEqual(await taskCounts(id), { pending: 1, leased: 0, done: 1, failed: 0 });

    const remaining = await listTasks(id, "pending");
    assert.deepEqual(remaining.map((task) => task.taskId), ["t2"]);
    assert.equal(remaining[0]!.cwd, "/tmp/wt");
  });
});

test("default flight seal reader ignores a prior runtime's matching seal after revive", async () => {
  await withTempStore(async () => {
    const record = bee("CO.reused-flight-worker");
    await recordSeal(record.name, validateSealArtifact({
      status: "done",
      summary: "old attempt",
      type: "implementation",
      taskId: "task-1",
      attempt: 1,
    }));
    const revived = { ...record, ...(await nextRuntimeIncarnationPatch(record)) };
    await saveSession(revived);
    assert.equal(await latestSealForCurrentIncarnation(record.name), null);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordSeal(record.name, validateSealArtifact({
      status: "done",
      summary: "new attempt",
      type: "implementation",
      taskId: "task-1",
      attempt: 1,
    }));
    assert.equal((await latestSealForCurrentIncarnation(record.name))?.status, "done");
  });
});

test("canary regression: the daemon sweep stage never awaits spawn-shaped work", async () => {
  await withTempStore(async () => {
    const { createFlightSweeper } = await import("../src/daemon/flightSweep.js");
    const { saveFlight, saveSlot } = await import("../src/flight/store.js");
    const f = flight({ id: "FL.slow1", target: { slots: 1, mix: [{ key: "fable", agent: "claude", count: 1 }] } });
    await saveFlight(f);
    await saveSlot({ ...vacantSlot("s1"), flightId: f.id });
    await enqueueTask(f.id, { taskId: "t1", brief: "slow one" });

    // spawnSlot hangs until we release it — the exact shape (account pick,
    // keychain activation, 90s brief retry) that blew the 120s tick budget.
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => (releaseSpawn = resolve));
    const spawnCalls: string[] = [];
    const sweeper = createFlightSweeper({
      spawnSlot: async (_f, slot) => {
        spawnCalls.push(slot.slotId);
        await spawnGate;
        return { beeName: "slow-bee" };
      },
      nudge: async () => undefined,
      retireBee: async () => undefined,
      withFlightLock: (_id, fn) => fn(),
      appendLedger: async () => undefined,
    });

    // The tick-facing call returns immediately even though the spawn hangs.
    const t0 = Date.now();
    const first = await sweeper([], new Map());
    assert.ok(Date.now() - t0 < 500, `stage took ${Date.now() - t0}ms — must not await the spawn`);
    assert.deepEqual(first, []);

    // While the sweep is in flight, subsequent ticks report it and skip.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(spawnCalls, ["s1"], "the detached sweep really ran");
    const second = await sweeper([], new Map());
    assert.ok(second.some((o) => o.action === "skipped" && /still running/.test(o.detail ?? "")));

    // Release the spawn; the completed sweep's outcomes surface on a later tick.
    releaseSpawn();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const third = await sweeper([], new Map());
    assert.ok(third.some((o) => o.action === "spawn" && o.detail === "slow-bee"), JSON.stringify(third));
  });
});
