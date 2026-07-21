import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseMixFlag } from "../src/commands/flight.js";
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
import { FLIGHT_CONTRACT_DEFAULTS, FLIGHT_REPLACEMENT_DEFAULTS, type FlightRecord, type SlotRecord } from "../src/flight/types.js";

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
