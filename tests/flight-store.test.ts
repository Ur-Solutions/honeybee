import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cmdFlight, parseMixFlag } from "../src/commands/flight.js";
import { parse } from "../src/parse.js";
import { ledgerPath, saveSession, type SessionRecord } from "../src/store.js";
import { withFileLock } from "../src/lock.js";
import { appendHsrEvent, ensureHsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import { registerNode } from "../src/node.js";
import {
  allocateFlightId,
  deleteFlight,
  flightDir,
  listFlights,
  listSlots,
  loadFlight,
  saveFlight,
  saveSlot,
} from "../src/flight/store.js";
import { FLIGHT_CONTRACT_DEFAULTS, FLIGHT_REPLACEMENT_DEFAULTS, slotBeeName, type FlightRecord, type SlotRecord } from "../src/flight/types.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-flight-"));
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

function flight(id: string): FlightRecord {
  const now = "2026-07-20T10:00:00.000Z";
  return {
    id,
    name: "parity-07",
    cwd: "/tmp/repo",
    brief: "do the shard",
    target: { slots: 2, mix: [{ key: "fable", agent: "claude", count: 1, model: "claude-fable-5", account: "auto" }, { key: "codex", agent: "codex", count: 1 }] },
    contract: { ...FLIGHT_CONTRACT_DEFAULTS, sealType: "implementation" },
    replacement: { ...FLIGHT_REPLACEMENT_DEFAULTS },
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function workerFlight(id: string): FlightRecord {
  return {
    ...flight(id),
    target: { slots: 1, mix: [{ key: "missing", agent: "definitely-missing-hive-agent", count: 1 }] },
    contract: { ...FLIGHT_CONTRACT_DEFAULTS, stallMs: 24 * 60 * 60 * 1_000 },
  };
}

function session(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    name,
    agent: "claude",
    cwd: "/tmp/repo",
    command: "claude",
    tmuxTarget: name,
    createdAt: now,
    updatedAt: now,
    status: "running",
    lastObservedState: "active",
    ...overrides,
  };
}

async function runQuietly(fn: () => Promise<void>): Promise<void> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
}

async function writeStaleExitedHsrMeta(bee: string, mirrorOfNode?: string): Promise<void> {
  await ensureHsrRunDir(bee);
  await writeHsrMeta(bee, {
    bee,
    harness: "stub",
    tier: "server",
    hostPid: 0,
    startedAt: "2026-07-20T09:00:00.000Z",
    controlSocket: "/tmp/stale.sock",
    status: "exited",
    endedAt: "2026-07-20T09:05:00.000Z",
    ...(mirrorOfNode ? { mirrorOfNode } : {}),
  });
}

async function writeLiveHsrMirror(bee: string, mirrorOfNode: string, eventTs: number, fingerprintSeed = "foreign-progress"): Promise<void> {
  await ensureHsrRunDir(bee);
  await writeHsrMeta(bee, {
    bee,
    harness: "stub",
    tier: "server",
    hostPid: 0,
    startedAt: "2026-07-20T09:00:00.000Z",
    controlSocket: "/tmp/mirror.sock",
    status: "running",
    mirrorOfNode,
  });
  await appendHsrEvent(bee, { type: "tool_use", ts: eventTs, tool: fingerprintSeed });
}

async function registerRemoteHsrNode(name: string): Promise<void> {
  await registerNode({
    name,
    kind: "remote-hsr",
    endpoint: `test@${name}`,
    runnerHostVersion: "test",
  });
}

test("flight store: flight + slot round-trip preserves every field", async () => {
  await withTempStore(async () => {
    const id = allocateFlightId();
    assert.match(id, /^FL\.[0-9a-f]{6}$/);
    const record = flight(id);
    await saveFlight(record);
    const slot: SlotRecord = {
      flightId: id,
      slotId: "s1",
      mixKey: "fable",
      generation: 0,
      attempt: 2,
      beeName: "parity-07-s1-a2",
      beeId: "CL.9fe",
      state: "working",
      since: "2026-07-20T10:05:00.000Z",
      attemptStartedAt: "2026-07-20T10:04:00.000Z",
      evidence: { firstEvidenceAt: "2026-07-20T10:06:00.000Z", lastActivityAt: "2026-07-20T10:07:00.000Z" },
      idempotencyKey: `${id}:s1:2`,
      nudgedAt: "2026-07-20T10:20:00.000Z",
      history: [{ attempt: 1, beeName: "parity-07-s1-a1", outcome: "wedged", at: "2026-07-20T10:03:00.000Z" }],
    };
    await saveSlot(slot);

    assert.deepEqual(await loadFlight(id), record);
    const slots = await listSlots(id);
    assert.equal(slots.length, 1);
    assert.deepEqual(slots[0], slot);

    const all = await listFlights();
    assert.equal(all.length, 1);

    await deleteFlight(id);
    assert.equal(await loadFlight(id), null);
  });
});

test("flight store: corrupt slot files are skipped, unknown states dropped", async () => {
  await withTempStore(async () => {
    const id = allocateFlightId();
    await saveFlight(flight(id));
    await writeFile(join(flightDir(id), "slots", "s9.json"), "{ nope", "utf8");
    await writeFile(
      join(flightDir(id), "slots", "s8.json"),
      JSON.stringify({ flightId: id, slotId: "s8", mixKey: "fable", attempt: 1, state: "warp-speed", since: "x", evidence: {}, history: [] }),
      "utf8",
    );
    assert.deepEqual(await listSlots(id), []);
  });
});

test("parseMixFlag: key=agent[/model][@account]:count forms", () => {
  assert.deepEqual(parseMixFlag("fable=claude:5"), { key: "fable", agent: "claude", count: 5 });
  assert.deepEqual(parseMixFlag("fable=claude/claude-fable-5:2"), { key: "fable", agent: "claude", model: "claude-fable-5", count: 2 });
  assert.deepEqual(parseMixFlag("codex=codex/gpt-5.6-sol@auto:5"), { key: "codex", agent: "codex", model: "gpt-5.6-sol", account: "auto", count: 5 });
  assert.deepEqual(parseMixFlag("fast=claude@rr:1"), { key: "fast", agent: "claude", account: "rr", count: 1 });
  assert.throws(() => parseMixFlag("fable=claude"), /--mix expects/);
  assert.throws(() => parseMixFlag("fable:5"), /--mix expects/);
  assert.throws(() => parseMixFlag("fable=claude:0"), /--mix expects|positive integer/);
});

test("flight status API drains and closes monotonically without a flight.active path", async () => {
  await withTempStore(async () => {
    const id = allocateFlightId();
    await saveFlight(flight(id));
    const logs: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      await cmdFlight(parse(["flight", "drain", id]));
      assert.equal((await loadFlight(id))?.status, "draining");
      await cmdFlight(parse(["flight", "close", id]));
      assert.equal((await loadFlight(id))?.status, "closed");
      await assert.rejects(() => cmdFlight(parse(["flight", "drain", id])), /closed flights cannot transition to draining/);
    } finally {
      console.log = originalLog;
    }

    const ledger = await readFile(ledgerPath(), "utf8");
    assert.match(ledger, /"type":"flight\.draining"/);
    assert.match(ledger, /"type":"flight\.closed"/);
    assert.doesNotMatch(ledger, /"type":"flight\.active"/);
    assert.ok(logs.length >= 2);
  });
});

test("flight status API waits on the sweep lock before mutating status", async () => {
  await withTempStore(async () => {
    const id = allocateFlightId();
    await saveFlight(flight(id));
    let pending: Promise<void> | undefined;
    await runQuietly(async () => {
      await withFileLock(join(flightDir(id), ".sweep.lock"), async () => {
        pending = cmdFlight(parse(["flight", "drain", id]));
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal((await loadFlight(id))?.status, "active");
      }, { timeoutMs: 1_000, staleMs: 10_000 });
      await pending;
    });

    assert.equal((await loadFlight(id))?.status, "draining");
  });
});

test("flight sweep ignores stale local HSR death for a revived tmux slot bee", async () => {
  await withTempStore(async () => {
    const id = allocateFlightId();
    const f = workerFlight(id);
    const beeName = slotBeeName(id, "s1", 0, 1);
    const now = new Date().toISOString();
    await saveFlight(f);
    await saveSlot({
      flightId: id,
      slotId: "s1",
      mixKey: "missing",
      generation: 0,
      attempt: 1,
      beeName,
      state: "working",
      since: now,
      attemptStartedAt: now,
      evidence: { firstEvidenceAt: now, lastActivityAt: now },
      history: [],
    });
    await saveSession(session(beeName, { substrate: "local-tmux" }));
    await writeStaleExitedHsrMeta(beeName);

    await runQuietly(() => cmdFlight(parse(["flight", "sweep", id, "--json"])));

    const [slot] = await listSlots(id);
    assert.equal(slot?.state, "working");
    assert.equal(slot?.beeName, beeName);
    const ledger = await readFile(ledgerPath(), "utf8").catch(() => "");
    assert.doesNotMatch(ledger, /flight\.slot\.crashed|flight\.slot\.spawn_failed|flight\.vacancy/);
  });
});

test("flight sweep ignores stale local HSR mirror death for a remote-HSR slot bee", async () => {
  await withTempStore(async () => {
    const id = allocateFlightId();
    const f = workerFlight(id);
    const beeName = slotBeeName(id, "s1", 0, 1);
    const now = new Date().toISOString();
    await registerRemoteHsrNode("runner01");
    await saveFlight(f);
    await saveSlot({
      flightId: id,
      slotId: "s1",
      mixKey: "missing",
      generation: 0,
      attempt: 1,
      beeName,
      state: "working",
      since: now,
      attemptStartedAt: now,
      evidence: { firstEvidenceAt: now, lastActivityAt: now },
      history: [],
    });
    await saveSession(session(beeName, { node: "runner01" }));
    await writeStaleExitedHsrMeta(beeName, "runner01");

    await runQuietly(() => cmdFlight(parse(["flight", "sweep", id, "--json"])));

    const [slot] = await listSlots(id);
    assert.equal(slot?.state, "working");
    assert.equal(slot?.beeName, beeName);
    const ledger = await readFile(ledgerPath(), "utf8").catch(() => "");
    assert.doesNotMatch(ledger, /flight\.slot\.crashed|flight\.slot\.spawn_failed|flight\.vacancy/);
  });
});

test("flight sweep ignores a live local HSR mirror whose node does not match the remote record", async () => {
  await withTempStore(async () => {
    const id = allocateFlightId();
    const f = workerFlight(id);
    const beeName = slotBeeName(id, "s1", 0, 1);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    await registerRemoteHsrNode("runner01");
    await registerRemoteHsrNode("runner02");
    await saveFlight(f);
    await saveSlot({
      flightId: id,
      slotId: "s1",
      mixKey: "missing",
      generation: 0,
      attempt: 1,
      beeName,
      state: "working",
      since: now,
      attemptStartedAt: now,
      evidence: { firstEvidenceAt: now, lastActivityAt: now, lastActivityFingerprint: "old-fp" },
      history: [],
    });
    await saveSession(session(beeName, { node: "runner02" }));
    await writeLiveHsrMirror(beeName, "runner01", nowMs + 60_000);

    await runQuietly(() => cmdFlight(parse(["flight", "sweep", id, "--json"])));

    const [slot] = await listSlots(id);
    assert.equal(slot?.state, "working");
    assert.equal(slot?.beeName, beeName);
    assert.equal(slot?.evidence.lastActivityAt, now);
    assert.equal(slot?.evidence.lastActivityFingerprint, "old-fp");
    const ledger = await readFile(ledgerPath(), "utf8").catch(() => "");
    assert.doesNotMatch(ledger, /flight\.slot\.stalled|flight\.slot\.crashed|flight\.vacancy/);
  });
});
