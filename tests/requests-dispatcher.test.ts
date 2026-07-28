// Needs-input dispatcher over the durable request store (step 4 of
// docs/INTERVENTION_REQUESTS.md): routing exactly-once is carried by the
// persisted routedAt/escalated marks, so it survives DISPATCHER RESTARTS, and
// a request resolved while the daemon was down is never routed at all.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listMessages } from "../src/buz.js";
import { createNeedsInputDispatcher } from "../src/daemon/needsInput.js";
import { ensureHsrRunDir, hsrEventsPath, writeHsrMeta, type HsrMeta } from "../src/hsr/runDir.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import { needsInputRequestId } from "../src/requests/keys.js";
import { openAndResolveRequest, openRequest, readBeeRequests } from "../src/requests/store.js";
import { saveSession, type SessionRecord } from "../src/store.js";
import type { BeeState } from "../src/state.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-requests-dispatch-"));
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

function hsrRecord(name: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  const iso = new Date().toISOString();
  return {
    name,
    agent: "stub",
    cwd: process.cwd(),
    command: "stub",
    tmuxTarget: name,
    substrate: "hsr",
    createdAt: iso,
    updatedAt: iso,
    status: "running",
    ...extra,
  };
}

function liveMeta(bee: string): HsrMeta {
  return {
    bee,
    harness: "stub",
    tier: "stream",
    hostPid: process.pid,
    startedAt: new Date().toISOString(),
    controlSocket: "/tmp/unused.sock",
    status: "running",
  };
}

async function writeEvents(bee: string, events: RunnerEvent[]): Promise<void> {
  await ensureHsrRunDir(bee);
  await writeFile(hsrEventsPath(bee), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
}

const BLOCKED_EVENTS: RunnerEvent[] = [
  { type: "turn_start", ts: 10 },
  { type: "needs_input", ts: 11, kind: "question", question: "which way?", requestId: "route-1" },
];

async function seedBlockedChild(child: string, parent: string): Promise<{ records: SessionRecord[]; states: Map<string, BeeState> }> {
  const childRecord = hsrRecord(child, { id: `${child}-id`, parentId: `${parent}-id` });
  const parentRecord = hsrRecord(parent, { id: `${parent}-id` });
  await saveSession(childRecord);
  await saveSession(parentRecord);
  await writeHsrMeta(child, liveMeta(child));
  await writeEvents(child, BLOCKED_EVENTS);
  return {
    records: [childRecord, parentRecord],
    states: new Map<string, BeeState>([
      [child, "blocked"],
      [parent, "idle_with_output"],
    ]),
  };
}

test("routing is exactly-once across two dispatcher INSTANCES (daemon restart simulation)", async () => {
  await withTempStore(async () => {
    const { records, states } = await seedBlockedChild("rt-child", "rt-parent");

    const first = createNeedsInputDispatcher();
    const outcomes = await first(records, states);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.routedTo, "rt-parent");
    assert.equal((await listMessages("rt-parent", "queue")).length, 1);

    // The routing mark is on disk, not in dispatcher memory.
    const stored = (await readBeeRequests("rt-child")).find((r) => r.id === "route-1")!;
    assert.equal(stored.status, "open");
    assert.equal(stored.routedTo, "rt-parent");
    assert.ok(stored.routedAt);

    // Daemon restart: a BRAND-NEW dispatcher instance sees the same evidence.
    const relaunched = createNeedsInputDispatcher();
    const again = await relaunched(records, states);
    assert.deepEqual(again, [], "no re-route after restart");
    assert.equal((await listMessages("rt-parent", "queue")).length, 1, "no duplicate buz");
  });
});

test("escalation is persisted: a parentless bee escalates once, across instances", async () => {
  await withTempStore(async () => {
    const orphan = hsrRecord("esc-orphan", { id: "esc-orphan-id" });
    await saveSession(orphan);
    await writeHsrMeta("esc-orphan", liveMeta("esc-orphan"));
    await writeEvents("esc-orphan", BLOCKED_EVENTS);
    const states = new Map<string, BeeState>([["esc-orphan", "blocked"]]);

    const first = createNeedsInputDispatcher();
    const outcomes = await first([orphan], states);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.escalated, true);

    const stored = (await readBeeRequests("esc-orphan")).find((r) => r.id === "route-1")!;
    assert.equal(stored.escalated, true);
    assert.ok(stored.escalatedAt);

    const relaunched = createNeedsInputDispatcher();
    assert.deepEqual(await relaunched([orphan], states), [], "escalation not repeated after restart");
  });
});

test("a request resolved while the daemon was down is NEVER routed", async () => {
  await withTempStore(async () => {
    const { records, states } = await seedBlockedChild("res-child", "res-parent");

    // hive answer landed while no daemon ran: the record exists RESOLVED under
    // the shared id (the events tail still shows the pending needs_input).
    await openAndResolveRequest("res-child", {
      id: needsInputRequestId("res-child", { requestId: "route-1", ts: 11 }),
      kind: "question",
      scope: "turn",
      generation: 0,
      question: "which way?",
      evidence: { grade: "structured", source: "hsr-events", detail: "needs_input" },
    }, { by: "hive-answer" });

    const dispatch = createNeedsInputDispatcher();
    const outcomes = await dispatch(records, states);
    assert.deepEqual(outcomes, [], "resolved request produces no routing outcome");
    assert.equal((await listMessages("res-parent", "queue")).length, 0, "no buz for an answered request");
    const stored = (await readBeeRequests("res-child")).find((r) => r.id === "route-1")!;
    assert.equal(stored.routedTo, undefined);
    assert.equal(stored.escalated, undefined);
  });
});

test("missing record self-heals: the dispatcher opens the request itself, then routes and marks it", async () => {
  await withTempStore(async () => {
    const { records, states } = await seedBlockedChild("heal-child", "heal-parent");
    assert.deepEqual(await readBeeRequests("heal-child"), [], "no reconciler ran — store empty");

    const dispatch = createNeedsInputDispatcher();
    const outcomes = await dispatch(records, states);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.routedTo, "heal-parent");

    const stored = (await readBeeRequests("heal-child")).find((r) => r.id === "route-1")!;
    assert.equal(stored.status, "open");
    assert.equal(stored.kind, "question");
    assert.equal(stored.question, "which way?");
    assert.equal(stored.routedTo, "heal-parent");
  });
});

test("an already-open unrouted record (reconciler-owned) is routed and marked without a duplicate open", async () => {
  await withTempStore(async () => {
    const { records, states } = await seedBlockedChild("pre-child", "pre-parent");
    await openRequest("pre-child", {
      id: "route-1",
      kind: "question",
      scope: "turn",
      generation: 0,
      question: "which way?",
      evidence: { grade: "structured", source: "hsr-events", detail: "needs_input" },
    });

    const dispatch = createNeedsInputDispatcher();
    const outcomes = await dispatch(records, states);
    assert.equal(outcomes.length, 1);
    const requests = await readBeeRequests("pre-child");
    assert.equal(requests.length, 1, "no duplicate record");
    assert.equal(requests[0]!.routedTo, "pre-parent");
  });
});
