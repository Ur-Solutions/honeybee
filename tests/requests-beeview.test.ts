// BeeView store-first request projection (step 5 of
// docs/INTERVENTION_REQUESTS.md): durable records are authoritative under
// their shared ids, live derivation stays the daemon-down fallback, observer
// derivation is suppressed by store coverage, and closed history surfaces as
// recentClosedRequests / the explain "Recent history" block.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { pendingNeedsInputFromEvents, structuredStateFromEvents, type HsrEventSnapshot } from "../src/hsr/observe.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import { openAndResolveRequest, openRequest, type InterventionRequestRecord } from "../src/requests/store.js";
import { deriveState, liveTargetKey, type StateContext } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";
import { projectBeeView } from "../src/view/project.js";
import { deriveOpenRequests } from "../src/view/requests.js";

const execFileAsync = promisify(execFile);
const NOW = Date.parse("2026-07-28T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "bee1",
    agent: "stub",
    cwd: "/tmp/work",
    command: "stub",
    tmuxTarget: "bee1",
    createdAt: iso(NOW - 60_000),
    updatedAt: iso(NOW - 30_000),
    status: "running",
    substrate: "hsr",
    ...over,
  };
}

function snapshotFromEvents(events: RunnerEvent[]): HsrEventSnapshot {
  return {
    events,
    tailEvents: events,
    activity: null,
    usage: { totals: null },
    pendingNeedsInput: pendingNeedsInputFromEvents(events),
  };
}

function hsrContext(events: RunnerEvent[]): StateContext {
  const structured = structuredStateFromEvents(events);
  return {
    liveTargets: new Set(),
    hsrLive: new Set(["bee1"]),
    hsrStates: structured ? new Map([["bee1", structured]]) : new Map(),
    now: NOW,
  };
}

function storedRecord(over: Partial<InterventionRequestRecord> = {}): InterventionRequestRecord {
  return {
    id: "req_env_1",
    bee: "bee1",
    kind: "permission",
    status: "open",
    scope: "turn",
    grade: "structured",
    generation: 0,
    openedAt: iso(NOW - 30_000),
    updatedAt: iso(NOW - 30_000),
    question: "stored payload wins",
    evidence: { grade: "structured", source: "hsr-events", detail: "needs_input" },
    ...over,
  };
}

const PENDING_EVENTS: RunnerEvent[] = [
  { type: "turn_start", ts: NOW - 60_000 },
  { type: "needs_input", ts: NOW - 30_000, kind: "permission", question: "live payload", requestId: "req_env_1" },
];

test("a store-open record beats the live derivation under one id — projected verbatim, no duplicate", () => {
  const rec = record();
  const context = hsrContext(PENDING_EVENTS);
  const requests = deriveOpenRequests({
    record: rec,
    context,
    derived: deriveState(rec, context),
    generation: 0,
    eventSnapshot: snapshotFromEvents(PENDING_EVENTS),
    storedRequests: [storedRecord()],
    now: NOW,
  });
  assert.equal(requests.length, 1, "one request, not store+live duplicates");
  assert.equal(requests[0]!.id, "req_env_1");
  assert.equal(requests[0]!.question, "stored payload wins", "the store record is authoritative");
  assert.equal(requests[0]!.status, "open");
});

test("answered-but-events-trailing is NOT needs-reply: the resolved record suppresses the live pending", () => {
  const rec = record();
  const context = hsrContext(PENDING_EVENTS);
  const view = projectBeeView({
    record: rec,
    context,
    eventSnapshot: snapshotFromEvents(PENDING_EVENTS),
    storedRequests: [storedRecord({
      status: "resolved",
      resolvedAt: iso(NOW - 5_000),
      resolvedBy: "hive-answer",
      resolution: "yes",
      updatedAt: iso(NOW - 5_000),
    })],
    now: NOW,
  });
  assert.deepEqual(view.openRequests, [], "no open request while the events tail trails");
  assert.notEqual(view.displayState, "needs-reply");
  assert.ok(view.recentClosedRequests, "closed history present");
  assert.equal(view.recentClosedRequests![0]!.id, "req_env_1");
  assert.equal(view.recentClosedRequests![0]!.status, "resolved");
  assert.equal(view.recentClosedRequests![0]!.resolvedBy, "hive-answer");
});

test("daemon-down fallback: with NO store record the live derivation still opens needs-reply under the same id", () => {
  const rec = record();
  const context = hsrContext(PENDING_EVENTS);
  const view = projectBeeView({
    record: rec,
    context,
    eventSnapshot: snapshotFromEvents(PENDING_EVENTS),
    now: NOW,
  });
  assert.equal(view.openRequests.length, 1);
  assert.equal(view.openRequests[0]!.id, "req_env_1");
  assert.equal(view.openRequests[0]!.question, "live payload");
  assert.equal(view.displayState, "needs-reply");
});

test("an exited runtime still projects a bee-scoped undeliverable-message request", () => {
  const rec = record({ status: "dead", runtimeGeneration: 4 });
  const request = storedRecord({
    id: "manual:bee1:message-delivery:019fe9d1-2dd4-76dc-ba45-a26b675617c9",
    kind: "manual-action",
    scope: "bee",
    generation: 3,
    question: "Restore the working copy, then retry delivery.",
    evidence: { grade: "structured", source: "buz-recovery", detail: "missing-cwd" },
  });
  const view = projectBeeView({ record: rec, context: { liveTargets: new Set(), now: NOW }, storedRequests: [request], now: NOW });
  assert.equal(view.latestRuntime.state, "exited");
  assert.equal(view.displayState, "needs-action");
  assert.equal(view.openRequests[0]?.id, request.id);
});

const PERMISSION_PANE = [
  "tool output scrolls above",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No, and tell Claude what to do differently",
].join("\n");

function blockedPaneSources(stored: InterventionRequestRecord[] | undefined) {
  const rec = record({ substrate: undefined });
  const context: StateContext = {
    liveTargets: new Set([liveTargetKey(rec.node, rec.tmuxTarget)]),
    panes: new Map([[rec.tmuxTarget, PERMISSION_PANE]]),
    now: NOW,
  };
  const derived = deriveState(rec, context);
  assert.equal(derived.state, "blocked", "fixture pane reads as blocked");
  return { record: rec, context, derived, generation: 0, ...(stored ? { storedRequests: stored } : {}), now: NOW };
}

test("an open store-backed needs-reply request suppresses the pane-permission observer derivation", () => {
  const stored = storedRecord({ id: "req_from_store", kind: "question" });
  const requests = deriveOpenRequests(blockedPaneSources([stored]));
  assert.equal(requests.length, 1, "only the structured store record");
  assert.equal(requests[0]!.id, "req_from_store");
  assert.equal(requests[0]!.grade, "structured");
});

test("a same-id store record suppresses re-deriving that observer request", () => {
  // Derive once without a store to learn the observer id, then plant a
  // closed record under that exact id: it must not re-derive as open.
  const first = deriveOpenRequests(blockedPaneSources(undefined));
  assert.equal(first.length, 1);
  const observerId = first[0]!.id;
  assert.match(observerId, /^obs:bee1:0:permission:/);

  const closed = storedRecord({
    id: observerId,
    grade: "observer",
    status: "cancelled",
    cancelledAt: iso(NOW - 1_000),
    cancelReason: "scope-closed",
  });
  const suppressed = deriveOpenRequests(blockedPaneSources([closed]));
  assert.deepEqual(suppressed, [], "same-id store record suppresses the observer derivation");
});

test("open store records from EARLIER generations do not project (superseded closure is the reconciler's job)", () => {
  const rec = record({ runtimeGeneration: 3 });
  const context = hsrContext([]);
  const requests = deriveOpenRequests({
    record: rec,
    context,
    derived: deriveState(rec, context),
    generation: 3,
    storedRequests: [storedRecord({ id: "old-gen", generation: 1 })],
    now: NOW,
  });
  assert.deepEqual(requests, []);
});

// ---------------------------------------------------------------------------
// view/* is WRITE-FREE over the request store: projecting reads records but
// never creates, rewrites, or removes them.
// ---------------------------------------------------------------------------

test("BeeView gathering never writes the request store (bytes and listing unchanged)", async () => {
  const store = await mkdtemp(join(tmpdir(), "hive-requests-readonly-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = store;
  try {
    const { getBeeView } = await import("../src/view/index.js");
    const { readBeeRequests, requestsRoot } = await import("../src/requests/store.js");
    const { readdir, readFile } = await import("node:fs/promises");
    const name = "svw-readonly";
    await mkdir(join(store, "sessions"), { recursive: true });
    await writeFile(join(store, "sessions", `${name}.json`), `${JSON.stringify({
      name,
      agent: "claude",
      cwd: "/tmp",
      command: "claude",
      tmuxTarget: name,
      id: name,
      createdAt: iso(NOW - 60_000),
      updatedAt: iso(NOW - 30_000),
      status: "running",
    }, null, 2)}\n`);
    await openRequest(name, {
      id: "stay-put",
      kind: "question",
      scope: "turn",
      generation: 0,
      question: "untouched?",
      evidence: { grade: "structured", source: "hsr-events", detail: "needs_input" },
    });
    const path = join(requestsRoot(), `${name}.json`);
    const bytesBefore = await readFile(path, "utf8");
    const listingBefore = (await readdir(requestsRoot())).sort();

    const view = await getBeeView(name);
    assert.ok(view.schemaVersion === 1);
    assert.equal((await readBeeRequests(name)).length, 1);
    assert.equal(await readFile(path, "utf8"), bytesBefore, "request file bytes unchanged");
    assert.deepEqual((await readdir(requestsRoot())).sort(), listingBefore, "no files created or removed");
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(store, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// hive state explain: the Recent history block (CLI subprocess over a seeded
// store; daemon down).
// ---------------------------------------------------------------------------

test("hive state explain shows the Recent history block and --json carries recentClosedRequests", async () => {
  const store = await mkdtemp(join(tmpdir(), "hive-requests-explain-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = store;
  try {
    const name = "svw-history";
    await mkdir(join(store, "sessions"), { recursive: true });
    await writeFile(join(store, "sessions", `${name}.json`), `${JSON.stringify({
      name,
      agent: "claude",
      cwd: "/tmp",
      command: "claude",
      tmuxTarget: name,
      id: name,
      createdAt: iso(NOW - 60_000),
      updatedAt: iso(NOW - 30_000),
      status: "running",
    }, null, 2)}\n`);
    await openAndResolveRequest(name, {
      id: "req_hist_1",
      kind: "permission",
      scope: "turn",
      generation: 0,
      question: "Run the fixture?",
      evidence: { grade: "structured", source: "hsr-events", detail: "needs_input" },
    }, { by: "hive-answer", resolution: "yes" });
    await openRequest(name, {
      id: "req_hist_2",
      kind: "question",
      scope: "turn",
      generation: 0,
      question: "Cancelled one?",
      evidence: { grade: "structured", source: "hsr-events", detail: "needs_input" },
    });
    const { cancelRequest } = await import("../src/requests/store.js");
    await cancelRequest(name, "req_hist_2", "scope-closed", "turn ended");

    const env = { ...process.env, HIVE_STORE_ROOT: store, HIVE_NO_KEYCHAIN: "1", NO_COLOR: "1", TERM: "dumb" };
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "state", "explain", name], { cwd: process.cwd(), env });
    assert.match(stdout, /Recent history/);
    assert.match(stdout, /req_hist_1 — resolved by hive-answer/);
    assert.match(stdout, /req_hist_2 — cancelled \(scope-closed\)/);

    const json = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "state", "explain", name, "--json"], { cwd: process.cwd(), env });
    const view = JSON.parse(json.stdout) as { recentClosedRequests?: Array<{ id: string; status: string }> };
    assert.ok(view.recentClosedRequests);
    assert.deepEqual(
      view.recentClosedRequests!.map((request) => `${request.id}:${request.status}`).sort(),
      ["req_hist_1:resolved", "req_hist_2:cancelled"],
    );
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(store, { recursive: true, force: true });
  }
});
