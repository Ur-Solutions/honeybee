import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectLedgerEvents,
  followLedgerEvents,
  ledgerFilesFor,
  matchesEventFilter,
  parseSince,
  type LedgerEvent,
} from "../src/events.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-events-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

test("parseSince: ISO timestamps and relative durations", () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  assert.equal(parseSince("2026-07-20T11:00:00.000Z", now), Date.parse("2026-07-20T11:00:00.000Z"));
  assert.equal(parseSince("15m", now), now - 15 * 60_000);
  assert.equal(parseSince("2h", now), now - 2 * 3_600_000);
  assert.equal(parseSince("30s", now), now - 30_000);
  assert.equal(parseSince("1d", now), now - 86_400_000);
  assert.throws(() => parseSince("yesterday", now), /--since expects/);
});

test("matchesEventFilter: type globs, sessions, since", () => {
  const event: LedgerEvent = { ts: "2026-07-20T12:00:00.000Z", type: "flight.slot.done", session: "CL.9fe" };
  assert.ok(matchesEventFilter(event, {}));
  assert.ok(matchesEventFilter(event, { types: ["flight.*"] }));
  assert.ok(matchesEventFilter(event, { types: ["seal", "flight.slot.*"] }));
  assert.ok(!matchesEventFilter(event, { types: ["seal"] }));
  assert.ok(matchesEventFilter(event, { sessions: ["CL.9fe"] }));
  assert.ok(!matchesEventFilter(event, { sessions: ["CL.other"] }));
  assert.ok(matchesEventFilter(event, { sinceMs: Date.parse("2026-07-20T11:59:00.000Z") }));
  assert.ok(!matchesEventFilter(event, { sinceMs: Date.parse("2026-07-20T12:01:00.000Z") }));
  // events without a parseable ts never satisfy a since filter
  assert.ok(!matchesEventFilter({ type: "x" }, { sinceMs: 0 }));
});

test("collectLedgerEvents: filters, limits, skips corrupt lines", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "ledger.jsonl");
    await writeFile(
      path,
      [
        line({ ts: "2026-07-20T10:00:00.000Z", type: "session.save", name: "a" }),
        "not-json\n",
        line({ ts: "2026-07-20T10:01:00.000Z", type: "state.transition", session: "a", from: "active", to: "idle_with_output" }),
        line({ ts: "2026-07-20T10:02:00.000Z", type: "state.transition", session: "b", from: "active", to: "crashed" }),
        line({ ts: "2026-07-20T10:03:00.000Z", type: "seal", session: "a" }),
      ].join(""),
    );
    const all = await collectLedgerEvents({ path });
    assert.equal(all.length, 4);
    const transitions = await collectLedgerEvents({ path, filter: { types: ["state.*"] } });
    assert.equal(transitions.length, 2);
    const forA = await collectLedgerEvents({ path, filter: { sessions: ["a"] } });
    assert.equal(forA.length, 3); // session.save carries name=a
    const limited = await collectLedgerEvents({ path, limit: 2 });
    assert.deepEqual(limited.map((e) => e.type), ["state.transition", "seal"]);
  });
});

test("ledgerFilesFor: since reaches into relevant rotations only", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "ledger.jsonl");
    const oldRotation = `${path}.2026-07-01T00-00-00-000Z`;
    const newRotation = `${path}.2026-07-20T09-00-00-000Z`;
    await writeFile(oldRotation, line({ ts: "2026-06-30T00:00:00.000Z", type: "seal" }));
    await writeFile(newRotation, line({ ts: "2026-07-20T08:30:00.000Z", type: "seal", session: "old" }));
    await writeFile(path, line({ ts: "2026-07-20T10:00:00.000Z", type: "seal", session: "new" }));

    const noSince = await ledgerFilesFor({}, path);
    assert.deepEqual(noSince, [path]);

    const sinceMs = Date.parse("2026-07-20T08:00:00.000Z");
    const files = await ledgerFilesFor({ sinceMs }, path);
    assert.deepEqual(files, [newRotation, path]);

    const events = await collectLedgerEvents({ path, filter: { sinceMs } });
    assert.deepEqual(events.map((e) => e.session), ["old", "new"]);
  });
});

test("followLedgerEvents: streams appended lines and survives rotation", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "ledger.jsonl");
    await writeFile(path, line({ ts: "2026-07-20T10:00:00.000Z", type: "seal", session: "backlog" }));
    const seen: LedgerEvent[] = [];
    const controller = new AbortController();
    const done = followLedgerEvents({
      path,
      pollMs: 5,
      signal: controller.signal,
      onEvent: (event) => seen.push(event),
    });

    // Backlog before follow start is not replayed (position starts at EOF).
    await appendFile(path, line({ ts: "2026-07-20T10:01:00.000Z", type: "state.transition", session: "a", to: "sealed" }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(seen.map((e) => e.session), ["a"]);

    // Rotate: move the file away, start a fresh one — follow resumes from 0.
    await rename(path, `${path}.2026-07-20T10-02-00-000Z`);
    await writeFile(path, line({ ts: "2026-07-20T10:03:00.000Z", type: "seal", session: "fresh" }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(seen.map((e) => e.session), ["a", "fresh"]);

    controller.abort();
    await done;
  });
});

test("CR-11a: --session filter matches flight events' bee and flight keys", () => {
  const slotEvent: LedgerEvent = { ts: "2026-07-21T10:00:00.000Z", type: "flight.slot.done", flight: "FL.x", bee: "FL.x-s1-a1", slot: "s1" };
  assert.ok(matchesEventFilter(slotEvent, { sessions: ["FL.x-s1-a1"] }));
  assert.ok(matchesEventFilter(slotEvent, { sessions: ["FL.x"] }));
  assert.ok(!matchesEventFilter(slotEvent, { sessions: ["other"] }));
});

test("CR-11b: fromPosition hands backlog off to follow with no gap and no duplicates", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "ledger.jsonl");
    await writeFile(path, line({ ts: "2026-07-21T10:00:00.000Z", type: "seal", session: "backlog" }));
    let livePosition = 0;
    const { collectLedgerEvents: collect } = await import("../src/events.js");
    const backlog = await collect({ path, onLivePosition: (bytes) => (livePosition = bytes) });
    assert.equal(backlog.length, 1);

    // An event lands AFTER the backlog read but BEFORE follow starts — the
    // exact window the offset handoff closes.
    await appendFile(path, line({ ts: "2026-07-21T10:00:01.000Z", type: "seal", session: "gap" }));

    const seen: LedgerEvent[] = [];
    const controller = new AbortController();
    const done = followLedgerEvents({
      path,
      pollMs: 5,
      fromPosition: livePosition,
      signal: controller.signal,
      onEvent: (event) => seen.push(event),
    });
    await appendFile(path, line({ ts: "2026-07-21T10:00:02.000Z", type: "seal", session: "later" }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    await done;
    assert.deepEqual(seen.map((e) => e.session), ["gap", "later"]);
  });
});
