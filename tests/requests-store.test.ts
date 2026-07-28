import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pendingNeedsInputFromEvents, structuredStateFromEvents, type HsrEventSnapshot } from "../src/hsr/observe.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import { authRequestId, needsInputRequestId, stopFailedRequestId } from "../src/requests/keys.js";
import {
  cancelOpenRequests,
  cancelRequest,
  closeRequestsForNewIncarnation,
  listBeesWithRequests,
  markRequestRouted,
  openAndResolveRequest,
  openRequest,
  readBeeRequests,
  removeBeeRequests,
  requestsRoot,
  resolveRequest,
  REQUEST_STORE_VERSION,
  type InterventionRequestRecord,
  type OpenRequestInput,
} from "../src/requests/store.js";
import { deriveState, type StateContext } from "../src/state.js";
import { ledgerPath, safeName, type SessionRecord } from "../src/store.js";
import { deriveOpenRequests } from "../src/view/requests.js";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-requests-store-"));
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

function input(over: Partial<OpenRequestInput> = {}): OpenRequestInput {
  return {
    id: "req_1",
    kind: "permission",
    scope: "turn",
    generation: 0,
    question: "Run it?",
    evidence: { grade: "structured", source: "hsr-events", detail: "needs_input" },
    ...over,
  };
}

async function readLedgerRows(): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(ledgerPath(), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Id parity: the store's key builders emit byte-identical ids to the live
// BeeView derivation, for every structured source.
// ---------------------------------------------------------------------------

function liveRequestsFor(bee: string, events: RunnerEvent[]) {
  const record: SessionRecord = {
    name: bee,
    agent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: bee,
    createdAt: iso(NOW - 60_000),
    updatedAt: iso(NOW - 30_000),
    status: "running",
    substrate: "hsr",
  };
  const structured = structuredStateFromEvents(events);
  const context: StateContext = {
    liveTargets: new Set(),
    hsrLive: new Set([bee]),
    hsrStates: structured ? new Map([[bee, structured]]) : new Map(),
    now: NOW,
  };
  const snapshot: HsrEventSnapshot = {
    events,
    tailEvents: events,
    activity: null,
    usage: { totals: null },
    pendingNeedsInput: pendingNeedsInputFromEvents(events),
  };
  return deriveOpenRequests({ record, context, derived: deriveState(record, context), generation: 0, eventSnapshot: snapshot, now: NOW });
}

test("id parity: needsInputRequestId matches the live view derivation, with and without adapter ids", () => {
  const withId = liveRequestsFor("bee1", [
    { type: "turn_start", ts: NOW - 60_000 },
    { type: "needs_input", ts: NOW - 30_000, kind: "question", question: "Which?", requestId: "req_env_1" },
  ]);
  assert.equal(withId.length, 1);
  assert.equal(withId[0]!.id, needsInputRequestId("bee1", { requestId: "req_env_1", ts: NOW - 30_000 }));
  assert.equal(withId[0]!.id, "req_env_1");

  const idless = liveRequestsFor("bee1", [
    { type: "turn_start", ts: NOW - 60_000 },
    { type: "needs_input", ts: NOW - 30_000, kind: "permission", question: "Run it?" },
  ]);
  assert.equal(idless.length, 1);
  // The observer normalizes a missing adapter id to the "pending" placeholder;
  // both spellings must fall back to the same ni:<bee>:<ts> id.
  assert.equal(idless[0]!.id, needsInputRequestId("bee1", { requestId: "pending", ts: NOW - 30_000 }));
  assert.equal(idless[0]!.id, needsInputRequestId("bee1", { requestId: "", ts: NOW - 30_000 }));
  assert.equal(idless[0]!.id, needsInputRequestId("bee1", { ts: NOW - 30_000 }));
  assert.equal(idless[0]!.id, `ni:bee1:${NOW - 30_000}`);
});

test("id parity: authRequestId matches the live view derivation", () => {
  const requests = liveRequestsFor("bee1", [
    { type: "turn_start", ts: NOW - 60_000 },
    { type: "error", ts: NOW - 30_000, message: "Not logged in — run /login to authenticate" },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.id, authRequestId("bee1", NOW - 30_000));
  assert.equal(requests[0]!.id, `auth:bee1:${NOW - 30_000}`);
});

test("id parity: stopFailedRequestId uses the manual:<bee>:<gen>:stop-failed scheme", () => {
  assert.equal(stopFailedRequestId("bee1", 3), "manual:bee1:3:stop-failed");
});

// ---------------------------------------------------------------------------
// openRequest idempotency + the no-resurrection rule.
// ---------------------------------------------------------------------------

test("openRequest is idempotent on id: the second open is created:false and does not clobber the payload", async () => {
  await withTempStore(async () => {
    const first = await openRequest("bee1", input({ question: "original question", openedAt: iso(NOW - 30_000) }));
    assert.equal(first.created, true);
    assert.equal(first.record.status, "open");
    assert.equal(first.record.openedAt, iso(NOW - 30_000));

    const second = await openRequest("bee1", input({ question: "CLOBBERED question", openedAt: iso(NOW) }));
    assert.equal(second.created, false);
    assert.equal(second.record.question, "original question");
    assert.equal(second.record.openedAt, iso(NOW - 30_000));

    const stored = await readBeeRequests("bee1");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.question, "original question");
  });
});

test("openRequest stamps openedAt with write time when the source carries no event ts", async () => {
  await withTempStore(async () => {
    const { record } = await openRequest("bee1", input());
    assert.ok(record.openedAt.length > 0, "openedAt is ALWAYS present");
    assert.ok(Number.isFinite(Date.parse(record.openedAt)));
    assert.equal(record.openedAt, record.updatedAt);
  });
});

test("no-resurrection: openRequest on a resolved record is a no-op; same for cancelled", async () => {
  await withTempStore(async () => {
    await openRequest("bee1", input({ id: "resolved-one" }));
    await resolveRequest("bee1", "resolved-one", { by: "hive-answer" });
    const reopened = await openRequest("bee1", input({ id: "resolved-one" }));
    assert.equal(reopened.created, false);
    assert.equal(reopened.record.status, "resolved");

    await openRequest("bee1", input({ id: "cancelled-one" }));
    await cancelRequest("bee1", "cancelled-one", "scope-closed", "turn ended");
    const reopenedCancelled = await openRequest("bee1", input({ id: "cancelled-one" }));
    assert.equal(reopenedCancelled.created, false);
    assert.equal(reopenedCancelled.record.status, "cancelled");

    const stored = await readBeeRequests("bee1");
    assert.equal(stored.length, 2, "no duplicate records were appended");
    assert.deepEqual(stored.map((r) => r.status).sort(), ["cancelled", "resolved"]);
  });
});

// ---------------------------------------------------------------------------
// resolve/cancel transition only from open.
// ---------------------------------------------------------------------------

test("resolveRequest resolves an open record with by/resolution and caps the resolution text", async () => {
  await withTempStore(async () => {
    await openRequest("bee1", input());
    const resolved = await resolveRequest("bee1", "req_1", { by: "hive-answer:parent-bee", resolution: "y".repeat(900) });
    assert.ok(resolved);
    assert.equal(resolved!.status, "resolved");
    assert.equal(resolved!.resolvedBy, "hive-answer:parent-bee");
    assert.equal(resolved!.resolution!.length, 500, "resolution capped at ~500 chars");
    assert.ok(resolved!.resolvedAt);
  });
});

test("resolve and cancel are no-ops on closed or missing records", async () => {
  await withTempStore(async () => {
    assert.equal(await resolveRequest("bee1", "missing", { by: "hive-answer" }), null);
    assert.equal(await cancelRequest("bee1", "missing", "scope-closed"), null);

    await openRequest("bee1", input({ id: "a" }));
    await cancelRequest("bee1", "a", "scope-closed", "turn ended");
    assert.equal(await resolveRequest("bee1", "a", { by: "hive-answer" }), null, "cancelled stays cancelled");

    await openRequest("bee1", input({ id: "b" }));
    await resolveRequest("bee1", "b", { by: "hive-answer" });
    assert.equal(await cancelRequest("bee1", "b", "superseded"), null, "resolved stays resolved");

    const byId = new Map((await readBeeRequests("bee1")).map((r) => [r.id, r.status]));
    assert.equal(byId.get("a"), "cancelled");
    assert.equal(byId.get("b"), "resolved");
  });
});

test("openAndResolveRequest lands a resolved record in one write when absent, resolves when open, no-ops when closed", async () => {
  await withTempStore(async () => {
    // Absent → created directly as resolved (the daemon-down hive answer path).
    const created = await openAndResolveRequest("bee1", input({ id: "fresh" }), { by: "hive-answer", resolution: "yes" });
    assert.ok(created);
    assert.equal(created!.status, "resolved");
    assert.equal(created!.resolution, "yes");

    // Open → resolved.
    await openRequest("bee1", input({ id: "open-one" }));
    const resolved = await openAndResolveRequest("bee1", input({ id: "open-one" }), { by: "hive-answer" });
    assert.equal(resolved!.status, "resolved");

    // Cancelled → untouched.
    await openRequest("bee1", input({ id: "closed-one" }));
    await cancelRequest("bee1", "closed-one", "scope-closed");
    assert.equal(await openAndResolveRequest("bee1", input({ id: "closed-one" }), { by: "hive-answer" }), null);
    const byId = new Map((await readBeeRequests("bee1")).map((r) => [r.id, r.status]));
    assert.equal(byId.get("closed-one"), "cancelled");
  });
});

// ---------------------------------------------------------------------------
// cancelOpenRequests filters.
// ---------------------------------------------------------------------------

test("cancelOpenRequests beforeGeneration cancels strictly-older generations only, with kind/scope filters", async () => {
  await withTempStore(async () => {
    await openRequest("bee1", input({ id: "gen0", generation: 0 }));
    await openRequest("bee1", input({ id: "gen1-auth", generation: 1, kind: "auth", scope: "runtime-generation" }));
    await openRequest("bee1", input({ id: "gen2", generation: 2 }));
    await openRequest("bee1", input({ id: "gen1-resolved", generation: 1 }));
    await resolveRequest("bee1", "gen1-resolved", { by: "hive-answer" });

    const cancelled = await cancelOpenRequests("bee1", { beforeGeneration: 2 }, "superseded", "superseded by generation 2");
    assert.deepEqual(cancelled.map((r) => r.id).sort(), ["gen0", "gen1-auth"]);
    const byId = new Map((await readBeeRequests("bee1")).map((r) => [r.id, r]));
    assert.equal(byId.get("gen0")!.status, "cancelled");
    assert.equal(byId.get("gen0")!.cancelReason, "superseded");
    assert.equal(byId.get("gen0")!.cancelDetail, "superseded by generation 2");
    assert.equal(byId.get("gen2")!.status, "open", "current generation stays open");
    assert.equal(byId.get("gen1-resolved")!.status, "resolved", "closed records untouched");

    // Kind filter: only auth.
    await openRequest("bee1", input({ id: "auth-open", kind: "auth", scope: "runtime-generation", generation: 2 }));
    await openRequest("bee1", input({ id: "question-open", kind: "question", generation: 2 }));
    const authOnly = await cancelOpenRequests("bee1", { kinds: ["auth"] }, "scope-closed", "generation exited");
    assert.deepEqual(authOnly.map((r) => r.id), ["auth-open"]);
    assert.equal((await readBeeRequests("bee1")).find((r) => r.id === "question-open")!.status, "open");
  });
});

test("closeRequestsForNewIncarnation cancels superseded with the generation-stamped detail", async () => {
  await withTempStore(async () => {
    await openRequest("bee1", input({ id: "old", generation: 1 }));
    const cancelled = await closeRequestsForNewIncarnation("bee1", 2);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]!.cancelReason, "superseded");
    assert.equal(cancelled[0]!.cancelDetail, "superseded by generation 2");
  });
});

// ---------------------------------------------------------------------------
// markRequestRouted.
// ---------------------------------------------------------------------------

test("markRequestRouted works only while open, and only once", async () => {
  await withTempStore(async () => {
    await openRequest("bee1", input());
    const routed = await markRequestRouted("bee1", "req_1", { routedTo: "parent" });
    assert.ok(routed);
    assert.equal(routed!.routedTo, "parent");
    assert.ok(routed!.routedAt);

    // Second routing attempt is a no-op — exactly-once across restarts.
    assert.equal(await markRequestRouted("bee1", "req_1", { routedTo: "other" }), null);
    assert.equal((await readBeeRequests("bee1"))[0]!.routedTo, "parent");

    // Escalation marking on an open, unrouted record.
    await openRequest("bee1", input({ id: "orphaned" }));
    const escalated = await markRequestRouted("bee1", "orphaned", { escalated: true });
    assert.equal(escalated!.escalated, true);
    assert.ok(escalated!.escalatedAt);
    assert.equal(await markRequestRouted("bee1", "orphaned", { routedTo: "late-parent" }), null, "escalated is terminal for routing");

    // Resolved record is never routed.
    await openRequest("bee1", input({ id: "answered" }));
    await resolveRequest("bee1", "answered", { by: "hive-answer" });
    assert.equal(await markRequestRouted("bee1", "answered", { routedTo: "parent" }), null);
  });
});

// ---------------------------------------------------------------------------
// Retention pruning.
// ---------------------------------------------------------------------------

test("prune: opens are never pruned; closed keeps newest N plus anything closed <24h", async () => {
  await withTempStore(async () => {
    const previousKeep = process.env.HIVE_REQUESTS_KEEP_CLOSED;
    process.env.HIVE_REQUESTS_KEEP_CLOSED = "2";
    try {
      const nowMs = Date.now();
      const old = (id: string, ageMs: number): InterventionRequestRecord => ({
        id,
        bee: "bee1",
        kind: "permission",
        status: "cancelled",
        scope: "turn",
        grade: "structured",
        generation: 0,
        openedAt: iso(nowMs - ageMs - 1_000),
        updatedAt: iso(nowMs - ageMs),
        cancelledAt: iso(nowMs - ageMs),
        cancelReason: "scope-closed",
        evidence: { grade: "structured", source: "hsr-events" },
      });
      const openRec: InterventionRequestRecord = {
        ...old("still-open", 90 * 60 * 60 * 1000),
        status: "open",
      };
      delete (openRec as Partial<InterventionRequestRecord>).cancelledAt;
      delete (openRec as Partial<InterventionRequestRecord>).cancelReason;
      const doc = {
        version: REQUEST_STORE_VERSION,
        bee: "bee1",
        requests: [
          openRec,
          old("ancient-1", 80 * 60 * 60 * 1000), // way past 24h, beyond keep-2 → pruned
          old("ancient-2", 70 * 60 * 60 * 1000), // way past 24h, beyond keep-2 → pruned
          old("recent-closed", 60 * 60 * 1000),  // closed 1h ago → kept by the 24h rule
          old("newest-1", 30 * 60 * 1000),
          old("newest-2", 10 * 60 * 1000),
        ],
      };
      await mkdir(requestsRoot(), { recursive: true });
      await writeFile(join(requestsRoot(), `${safeName("bee1")}.json`), `${JSON.stringify(doc, null, 2)}\n`);

      // Any mutation triggers the prune.
      await openRequest("bee1", input({ id: "trigger" }));

      const ids = new Set((await readBeeRequests("bee1")).map((r) => r.id));
      assert.ok(ids.has("still-open"), "an ancient OPEN record is never pruned");
      assert.ok(ids.has("newest-1") && ids.has("newest-2"), "newest N closed kept");
      assert.ok(ids.has("recent-closed"), "closed <24h kept even beyond the count cap");
      assert.ok(!ids.has("ancient-1") && !ids.has("ancient-2"), "old closed beyond the cap pruned");
      assert.ok(ids.has("trigger"));
    } finally {
      if (previousKeep === undefined) delete process.env.HIVE_REQUESTS_KEEP_CLOSED;
      else process.env.HIVE_REQUESTS_KEEP_CLOSED = previousKeep;
    }
  });
});

// ---------------------------------------------------------------------------
// Corrupt/missing files, listing, removal.
// ---------------------------------------------------------------------------

test("readBeeRequests returns [] on missing and corrupt files; a mutation heals the corrupt file", async () => {
  await withTempStore(async () => {
    assert.deepEqual(await readBeeRequests("nobody"), []);

    await mkdir(requestsRoot(), { recursive: true });
    await writeFile(join(requestsRoot(), `${safeName("bee1")}.json`), "{not json!!");
    assert.deepEqual(await readBeeRequests("bee1"), []);

    const { created } = await openRequest("bee1", input());
    assert.equal(created, true);
    assert.equal((await readBeeRequests("bee1")).length, 1);
  });
});

test("listBeesWithRequests enumerates request files (safeName stems) and skips locks; removeBeeRequests deletes", async () => {
  await withTempStore(async () => {
    assert.deepEqual(await listBeesWithRequests(), []);
    await openRequest("bee1", input());
    await openRequest("other.bee", input({ id: "x" }));
    const names = (await listBeesWithRequests()).sort();
    assert.deepEqual(names, [safeName("bee1"), safeName("other.bee")].sort());

    await removeBeeRequests("bee1");
    assert.deepEqual(await listBeesWithRequests(), [safeName("other.bee")]);
    assert.deepEqual(await readBeeRequests("bee1"), []);
  });
});

// ---------------------------------------------------------------------------
// Ledger rows.
// ---------------------------------------------------------------------------

test("mutations append compact request.open/request.resolve/request.cancel ledger rows; no-ops append nothing", async () => {
  await withTempStore(async () => {
    await openRequest("bee1", input({ generation: 3 }));
    await openRequest("bee1", input({ generation: 3 })); // idempotent no-op → no row
    await resolveRequest("bee1", "req_1", { by: "hive-answer" });
    await resolveRequest("bee1", "req_1", { by: "hive-answer" }); // no-op → no row
    await openRequest("bee1", input({ id: "req_2" }));
    await cancelRequest("bee1", "req_2", "scope-closed", "turn ended");
    await openAndResolveRequest("bee1", input({ id: "req_3" }), { by: "hive-answer:caller" });

    const rows = (await readLedgerRows()).filter((row) => typeof row.type === "string" && String(row.type).startsWith("request."));
    assert.deepEqual(
      rows.map((row) => `${row.type}:${row.id}`),
      [
        "request.open:req_1",
        "request.resolve:req_1",
        "request.open:req_2",
        "request.cancel:req_2",
        "request.open:req_3",
        "request.resolve:req_3",
      ],
    );
    const open = rows[0]!;
    assert.equal(open.session, "bee1");
    assert.equal(open.kind, "permission");
    assert.equal(open.scope, "turn");
    assert.equal(open.generation, 3);
    assert.ok(typeof open.ts === "string");
    assert.equal(rows[1]!.by, "hive-answer");
    assert.equal(rows[3]!.reason, "scope-closed");
    assert.equal(rows[3]!.detail, "turn ended");
    assert.equal(rows[5]!.by, "hive-answer:caller");
  });
});
