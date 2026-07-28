import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createFlightCapacityProvider,
  readLease,
  type ActivationAddress,
  type FlightCapacityAcquireRequest,
  type FlightCapacityDeps,
  type ResolvedSubject,
} from "../src/flight/capacity.js";
import { listSlots, saveFlight, saveSlot } from "../src/flight/store.js";
import {
  FLIGHT_CONTRACT_DEFAULTS,
  FLIGHT_REPLACEMENT_DEFAULTS,
  slotBeeName,
  type FlightRecord,
  type SlotRecord,
} from "../src/flight/types.js";
import type { SessionRecord } from "../src/store.js";

const T0 = Date.parse("2026-07-28T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-flight-capacity-"));
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
    id: "FL.cap01",
    name: "capacity-test",
    cwd: "/tmp",
    target: { slots: 2, mix: [{ key: "fable", agent: "claude", count: 1 }, { key: "codex", agent: "codex", count: 1 }] },
    contract: { ...FLIGHT_CONTRACT_DEFAULTS },
    replacement: { ...FLIGHT_REPLACEMENT_DEFAULTS },
    status: "active",
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...overrides,
  };
}

function laneSlot(slotId: string, overrides: Partial<SlotRecord> = {}): SlotRecord {
  return {
    flightId: "FL.cap01",
    slotId,
    mixKey: "fable",
    generation: 0,
    attempt: 0,
    state: "drained",
    since: iso(T0),
    evidence: {},
    history: [],
    ...overrides,
  };
}

const ACTIVATION: ActivationAddress = { runId: "run-1", nodeId: "implement", attempt: 1, itemIndex: 0 };
const SUBJECT: ResolvedSubject = { kind: "pr", key: "digitech#42", revision: "abc123" };

function request(overrides: Partial<FlightCapacityAcquireRequest> = {}): FlightCapacityAcquireRequest {
  return {
    flightId: "FL.cap01",
    activation: ACTIVATION,
    taskId: "run-1/implement@1#0",
    attempt: 1,
    subject: SUBJECT,
    brief: "implement the node",
    idempotencyKey: "run-1:implement:1:0",
    ...overrides,
  };
}

type Harness = {
  deps: Partial<FlightCapacityDeps>;
  spawns: Array<{ slotId: string; generation: number; attempt: number; taskId?: string; brief?: string }>;
  retired: string[];
  ledger: Array<Record<string, unknown>>;
  sessions: Map<string, SessionRecord>;
  failSpawn: boolean;
};

function harness(): Harness {
  const spawns: Harness["spawns"] = [];
  const retired: string[] = [];
  const ledger: Array<Record<string, unknown>> = [];
  const sessions = new Map<string, SessionRecord>();
  const h: Harness = {
    spawns,
    retired,
    ledger,
    sessions,
    failSpawn: false,
    deps: {
      withFlightLock: (_id, fn) => fn(),
      spawnSlot: async (f, slot, _mix, task) => {
        if (h.failSpawn) throw new Error("no accounts available");
        spawns.push({ slotId: slot.slotId, generation: slot.generation, attempt: slot.attempt, ...(task ? { taskId: task.taskId, brief: task.brief } : {}) });
        return { beeName: slotBeeName(f.id, slot.slotId, slot.generation, slot.attempt), beeId: "CL.test" };
      },
      loadSession: async (name) => sessions.get(name) ?? null,
      retireBee: async (name) => {
        retired.push(name);
      },
      listFlightIds: async () => ["FL.cap01"],
      appendLedger: async (event) => {
        ledger.push(event);
      },
      now: () => T0 + 60_000,
    },
  };
  return h;
}

test("acquire: leases a drained lane, spawns with the comb's brief/taskId, persists lease + claim durably", async () => {
  await withTempStore(async () => {
    await saveFlight(flight());
    await saveSlot(laneSlot("s1"));
    await saveSlot(laneSlot("s2", { mixKey: "codex", state: "vacant" }));
    const h = harness();
    const provider = createFlightCapacityProvider(h.deps);

    const result = await provider.acquire(request());
    assert.equal(result.kind, "acquired");
    const acquired = result as { kind: "acquired"; leaseId: string; beeName: string; beeId?: string };
    assert.equal(acquired.beeName, slotBeeName("FL.cap01", "s1", 1, 1));
    assert.equal(acquired.beeId, "CL.test");
    assert.match(acquired.leaseId, /^LS\.[0-9a-f]{8}$/);

    // Drained lane preferred, claimed at generation+1 with the comb's keys.
    assert.deepEqual(h.spawns, [{ slotId: "s1", generation: 1, attempt: 1, taskId: "run-1/implement@1#0", brief: "implement the node" }]);
    const s1 = (await listSlots("FL.cap01")).find((s) => s.slotId === "s1")!;
    assert.equal(s1.state, "booting");
    assert.equal(s1.taskId, "run-1/implement@1#0");
    assert.equal(s1.attempt, 1);
    assert.equal(s1.generation, 1);
    assert.equal(s1.idempotencyKey, "run-1:implement:1:0");

    const lease = await readLease("FL.cap01", "run-1:implement:1:0");
    assert.equal(lease?.status, "acquired");
    assert.equal(lease?.beeName, acquired.beeName);
    assert.deepEqual(lease?.activation, ACTIVATION);
    assert.deepEqual(lease?.subject, SUBJECT);
    assert.ok(h.ledger.some((e) => e.type === "flight.lease.acquired" && e.run === "run-1" && e.node === "implement"));

    // lookup returns the acquired identity.
    assert.deepEqual(await provider.lookup("run-1:implement:1:0"), { leaseId: acquired.leaseId, beeName: acquired.beeName, beeId: "CL.test" });
    assert.equal(await provider.lookup("unknown-key"), null);
  });
});

test("acquire is idempotent: same key replays the same lease without a second spawn", async () => {
  await withTempStore(async () => {
    await saveFlight(flight());
    await saveSlot(laneSlot("s1"));
    const h = harness();
    const provider = createFlightCapacityProvider(h.deps);

    const first = await provider.acquire(request());
    const second = await provider.acquire(request());
    assert.equal(second.kind, "acquired");
    assert.deepEqual(second, first);
    assert.equal(h.spawns.length, 1, "no double-spawn on replay");
  });
});

test("acquire: unavailable on inactive flight, no matching lane, mixKey filter, and backpressure", async () => {
  await withTempStore(async () => {
    const h = harness();
    const provider = createFlightCapacityProvider(h.deps);

    // Unknown/inactive flight.
    await saveFlight(flight({ status: "draining" }));
    await saveSlot(laneSlot("s1"));
    const inactive = await provider.acquire(request());
    assert.equal(inactive.kind, "unavailable");

    // Active but every lane busy.
    await saveFlight(flight());
    await saveSlot(laneSlot("s1", { state: "working", taskId: "queue-task", beeName: "busy-bee" }));
    const busy = await provider.acquire(request({ idempotencyKey: "k2" }));
    assert.equal(busy.kind, "unavailable");

    // mixKey filter: only a codex lane free, fable demanded.
    await saveSlot(laneSlot("s2", { mixKey: "codex", state: "vacant" }));
    const wrongMix = await provider.acquire(request({ idempotencyKey: "k3", mixKey: "fable" }));
    assert.equal(wrongMix.kind, "unavailable");

    // Backpressure: maxConcurrentBoots exhausted by booting lanes.
    await saveFlight(flight({ replacement: { policy: "replace-before-collect", maxConcurrentBoots: 1 } }));
    await saveSlot(laneSlot("s1", { state: "booting", taskId: "queue-task", beeName: "boot-bee" }));
    await saveSlot(laneSlot("s2", { mixKey: "codex", state: "vacant" }));
    const backpressure = await provider.acquire(request({ idempotencyKey: "k4", mixKey: "codex" }));
    assert.equal(backpressure.kind, "unavailable");
    assert.equal(h.spawns.length, 0, "no spawn happened in any unavailable path");
  });
});

test("crash recovery: an 'acquiring' lease adopts the already-spawned bee instead of double-spawning", async () => {
  await withTempStore(async () => {
    await saveFlight(flight());
    await saveSlot(laneSlot("s1"));
    const h = harness();
    // First acquire crashes between spawn and confirm: simulate by spawning
    // through a provider whose saveSlot works but whose confirm we interrupt —
    // easiest faithful simulation: run acquire fully, then rewind the lease
    // to "acquiring" and the slot to the claimed (pre-confirm) shape.
    const provider = createFlightCapacityProvider(h.deps);
    const first = await provider.acquire(request());
    assert.equal(first.kind, "acquired");
    const beeName = (first as { beeName: string }).beeName;
    // Register the spawned bee as a live session (what adoption checks).
    h.sessions.set(beeName, {
      name: beeName,
      agent: "claude",
      cwd: "/tmp",
      command: "claude",
      tmuxTarget: beeName,
      createdAt: iso(T0),
      updatedAt: iso(T0),
      status: "running",
      id: "CL.test",
    });
    const lease = (await readLease("FL.cap01", "run-1:implement:1:0"))!;
    const { saveSlot: storeSaveSlot } = await import("../src/flight/store.js");
    const claimed = (await listSlots("FL.cap01")).find((s) => s.slotId === "s1")!;
    const preConfirm = { ...claimed, state: "provisioning" as const };
    delete preConfirm.beeName;
    delete preConfirm.beeId;
    await storeSaveSlot(preConfirm);
    const { atomicWriteFile, storeRoot } = await import("../src/fsx.js");
    const { safeName } = await import("../src/store.js");
    await atomicWriteFile(
      join(storeRoot(), "flights", "FL.cap01", "leases", `${safeName("run-1:implement:1:0")}.json`),
      `${JSON.stringify({ ...lease, status: "acquiring", beeName: undefined }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const recovered = await provider.acquire(request());
    assert.equal(recovered.kind, "acquired");
    assert.equal((recovered as { beeName: string }).beeName, beeName);
    assert.equal(h.spawns.length, 1, "adoption — not a second spawn");
    const s1 = (await listSlots("FL.cap01")).find((s) => s.slotId === "s1")!;
    assert.equal(s1.state, "booting");
    assert.equal(s1.beeName, beeName);
  });
});

test("spawn failure: lane restored unbound, unavailable returned, re-acquire succeeds on a fresh attempt", async () => {
  await withTempStore(async () => {
    await saveFlight(flight());
    await saveSlot(laneSlot("s1"));
    const h = harness();
    const provider = createFlightCapacityProvider(h.deps);

    h.failSpawn = true;
    const failed = await provider.acquire(request());
    assert.equal(failed.kind, "unavailable");
    const s1 = (await listSlots("FL.cap01")).find((s) => s.slotId === "s1")!;
    assert.equal(s1.state, "vacant");
    assert.equal(s1.taskId, undefined, "lane not left bound to a spawn that never happened");
    assert.ok(h.ledger.some((e) => e.type === "flight.lease.spawn_failed"));

    h.failSpawn = false;
    const retried = await provider.acquire(request());
    assert.equal(retried.kind, "acquired");
  });
});

test("release: recycles the bound lane, retires the bee, is idempotent, and tolerates an already-moved lane", async () => {
  await withTempStore(async () => {
    await saveFlight(flight());
    await saveSlot(laneSlot("s1"));
    const h = harness();
    const provider = createFlightCapacityProvider(h.deps);
    const acquired = (await provider.acquire(request())) as { leaseId: string; beeName: string };

    await provider.release(acquired.leaseId, "done");
    const s1 = (await listSlots("FL.cap01")).find((s) => s.slotId === "s1")!;
    assert.equal(s1.state, "vacant");
    assert.equal(s1.generation, 2, "lane recycled past the lease generation");
    assert.equal(s1.taskId, undefined);
    assert.deepEqual(h.retired, [acquired.beeName]);
    assert.ok(s1.history.some((entry) => entry.outcome === "comb-lease-done"));
    const lease = await readLease("FL.cap01", "run-1:implement:1:0");
    assert.equal(lease?.status, "released");
    assert.equal(lease?.releaseReason, "done");
    assert.ok(h.ledger.some((e) => e.type === "flight.lease.released" && e.reason === "done"));

    // Idempotent second release.
    await provider.release(acquired.leaseId, "done");
    assert.equal(h.retired.length, 1);

    // Unknown lease throws.
    await assert.rejects(() => provider.release("LS.deadbeef", "cancelled"), /unknown flight capacity lease/);

    // Already-moved lane (sweeper recycled first): release only files the lease.
    const second = (await provider.acquire(request({ idempotencyKey: "k9", taskId: "t9" }))) as { leaseId: string };
    const moved = (await listSlots("FL.cap01")).find((s) => s.slotId === "s1")!;
    await saveSlot({ ...moved, generation: moved.generation + 5, state: "working", taskId: "queue-task-x" });
    await provider.release(second.leaseId, "cancelled");
    const after = (await listSlots("FL.cap01")).find((s) => s.slotId === "s1")!;
    assert.equal(after.taskId, "queue-task-x", "a lane the sweeper re-bound is left alone");
  });
});
