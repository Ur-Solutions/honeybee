import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequestReconciler, type RequestReconcileInput } from "../src/daemon/requestSweep.js";
import { tickDispatchers, type DispatchContext } from "../src/daemon/tick.js";
import { pendingNeedsInputFromEvents, type HsrObservation } from "../src/hsr/observe.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import { authRequestId, needsInputRequestId, stopFailedRequestId } from "../src/requests/keys.js";
import { openRequest, readBeeRequests, requestsRoot, resolveRequest, type OpenRequestInput } from "../src/requests/store.js";
import { safeName, type SessionRecord } from "../src/store.js";
import type { BeeState } from "../src/state.js";
import { lifecycleCursor } from "./lifecycle-fixtures.js";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-requests-reconcile-"));
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

function bee(name: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: name,
    createdAt: iso(NOW - 120_000),
    updatedAt: iso(NOW - 60_000),
    status: "running",
    substrate: "hsr",
    ...over,
  };
}

function obsFor(events: RunnerEvent[], live = true): HsrObservation {
  return {
    live,
    snapshot: "",
    eventSnapshot: {
      events,
      tailEvents: events,
      activity: null,
      usage: { totals: null },
      pendingNeedsInput: pendingNeedsInputFromEvents(events),
    },
  };
}

function input(over: Partial<RequestReconcileInput> = {}): RequestReconcileInput {
  return {
    records: [],
    currentStates: new Map<string, BeeState>(),
    hsrObservations: new Map<string, HsrObservation>(),
    hsrUnavailable: new Set<string>(),
    ...over,
  };
}

function storedInput(over: Partial<OpenRequestInput> = {}): OpenRequestInput {
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

const PENDING_EVENTS: RunnerEvent[] = [
  { type: "turn_start", ts: NOW - 60_000 },
  {
    type: "needs_input",
    ts: NOW - 30_000,
    kind: "permission",
    question: "Run rm -rf /tmp/x?",
    requestId: "req_live_1",
    tool: "Bash",
    options: ["yes", "no"],
  },
];

test("reconciler opens a durable record for a live bee's pending needs_input, with payload and event openedAt", async () => {
  await withTempStore(async () => {
    const reconcile = createRequestReconciler();
    const record = bee("alpha", { runtimeGeneration: 2 });
    const outcomes = await reconcile(input({
      records: [record],
      hsrObservations: new Map([["alpha", obsFor(PENDING_EVENTS)]]),
    }));

    assert.deepEqual(outcomes.map((o) => `${o.action}:${o.id}`), ["open:req_live_1"]);
    const stored = (await readBeeRequests("alpha"))[0]!;
    assert.equal(stored.id, needsInputRequestId("alpha", { requestId: "req_live_1", ts: NOW - 30_000 }));
    assert.equal(stored.status, "open");
    assert.equal(stored.kind, "permission");
    assert.equal(stored.scope, "turn");
    assert.equal(stored.generation, 2);
    assert.equal(stored.openedAt, iso(NOW - 30_000));
    assert.equal(stored.question, "Run rm -rf /tmp/x?");
    assert.equal(stored.tool, "Bash");
    assert.deepEqual(stored.options, ["yes", "no"]);
    assert.equal(stored.evidence.source, "hsr-events");
  });
});

test("steady state: re-seeing the same pending is a no-op — no duplicate outcome, no file rewrite", async () => {
  await withTempStore(async () => {
    const reconcile = createRequestReconciler();
    const record = bee("alpha");
    const obs = new Map([["alpha", obsFor(PENDING_EVENTS)]]);
    const first = await reconcile(input({ records: [record], hsrObservations: obs }));
    assert.equal(first.length, 1);

    const path = join(requestsRoot(), `${safeName("alpha")}.json`);
    const before = await readFile(path, "utf8");
    const second = await reconcile(input({ records: [record], hsrObservations: obs }));
    assert.deepEqual(second, [], "no outcome on the steady-state tick");
    assert.equal(await readFile(path, "utf8"), before, "file bytes untouched");
  });
});

test("stop-failed requests preserve stop doubt while canonical archive still wins", async () => {
  await withTempStore(async () => {
    const reconcile = createRequestReconciler();
    const activeStopDoubt = bee("active-stop-doubt", {
      status: "kill_failed",
      stateMachine: lifecycleCursor("active-stop-doubt", "active", iso(NOW - 30_000)),
    });
    const activeStaleDone = bee("active-stale-done", {
      status: "done",
      stateMachine: lifecycleCursor("active-stale-done", "active", iso(NOW - 30_000)),
    });
    const archived = bee("archived-stale-stop", {
      status: "kill_failed",
      stateMachine: lifecycleCursor("archived-stale-stop", "archived", iso(NOW - 30_000)),
    });
    const outcomes = await reconcile(input({ records: [activeStopDoubt, activeStaleDone, archived] }));
    assert.deepEqual(outcomes.map((outcome) => `${outcome.action}:${outcome.id}`), [
      `open:${stopFailedRequestId(activeStopDoubt.name, 0)}`,
    ]);
    assert.equal((await readBeeRequests(activeStopDoubt.name))[0]?.kind, "manual-action");
    assert.deepEqual(await readBeeRequests(activeStaleDone.name), []);
    assert.deepEqual(await readBeeRequests(archived.name), []);
  });
});

test("a turn_end without an answer cancels the open request scope-closed \"turn ended\"", async () => {
  await withTempStore(async () => {
    const reconcile = createRequestReconciler();
    const record = bee("alpha");
    await reconcile(input({ records: [record], hsrObservations: new Map([["alpha", obsFor(PENDING_EVENTS)]]) }));

    const endedEvents: RunnerEvent[] = [...PENDING_EVENTS, { type: "turn_end", ts: NOW - 5_000 }];
    const outcomes = await reconcile(input({ records: [record], hsrObservations: new Map([["alpha", obsFor(endedEvents)]]) }));
    assert.deepEqual(outcomes.map((o) => `${o.action}:${o.id}:${o.detail}`), ["cancel:req_live_1:turn ended"]);
    const stored = (await readBeeRequests("alpha"))[0]!;
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.cancelReason, "scope-closed");
    assert.equal(stored.cancelDetail, "turn ended");
  });
});

test("an unbounded auth failure opens auth; a later auth_resume resolves it by auth-resume", async () => {
  await withTempStore(async () => {
    const reconcile = createRequestReconciler();
    const record = bee("alpha");
    const authEvents: RunnerEvent[] = [
      { type: "turn_start", ts: NOW - 60_000 },
      { type: "error", ts: NOW - 30_000, message: "Not logged in — run /login to authenticate" },
    ];
    const opened = await reconcile(input({ records: [record], hsrObservations: new Map([["alpha", obsFor(authEvents)]]) }));
    assert.deepEqual(opened.map((o) => `${o.action}:${o.id}`), [`open:${authRequestId("alpha", NOW - 30_000)}`]);
    assert.equal((await readBeeRequests("alpha"))[0]!.scope, "runtime-generation");

    const resumedEvents: RunnerEvent[] = [...authEvents, { type: "auth_resume", ts: NOW - 5_000 }];
    const resolved = await reconcile(input({ records: [record], hsrObservations: new Map([["alpha", obsFor(resumedEvents)]]) }));
    assert.deepEqual(resolved.map((o) => `${o.action}:${o.detail}`), ["resolve:auth-resume"]);
    const stored = (await readBeeRequests("alpha"))[0]!;
    assert.equal(stored.status, "resolved");
    assert.equal(stored.resolvedBy, "auth-resume");
  });
});

test("a trusted observed generation exit cancels open requests \"generation exited\" (and never from mere absence)", async () => {
  await withTempStore(async () => {
    const reconcile = createRequestReconciler();
    const record = bee("alpha", { runtimeGeneration: 1 });
    await openRequest("alpha", storedInput({ id: "current-gen", generation: 1 }));

    // No observation at all this tick (bee absent from the batch): absence is
    // NOT evidence — nothing closes.
    const absent = await reconcile(input({ records: [record] }));
    assert.deepEqual(absent, []);
    assert.equal((await readBeeRequests("alpha"))[0]!.status, "open");

    // The run dir was read and the host pid is dead: trusted exit.
    const outcomes = await reconcile(input({
      records: [record],
      hsrObservations: new Map([["alpha", obsFor([], false)]]),
    }));
    assert.deepEqual(outcomes.map((o) => `${o.action}:${o.id}:${o.detail}`), ["cancel:current-gen:generation exited"]);
    const stored = (await readBeeRequests("alpha"))[0]!;
    assert.equal(stored.cancelReason, "scope-closed");
    assert.equal(stored.cancelDetail, "generation exited");
  });
});

test("a generation bump observed on the record cancels older-generation opens as superseded (backstop)", async () => {
  await withTempStore(async () => {
    const reconcile = createRequestReconciler();
    await openRequest("alpha", storedInput({ id: "old-gen", generation: 1 }));
    const record = bee("alpha", { runtimeGeneration: 3 });
    const outcomes = await reconcile(input({ records: [record], hsrObservations: new Map([["alpha", obsFor([])]]) }));
    assert.deepEqual(outcomes.map((o) => `${o.action}:${o.id}`), ["cancel:old-gen"]);
    const stored = (await readBeeRequests("alpha"))[0]!;
    assert.equal(stored.cancelReason, "superseded");
    assert.equal(stored.cancelDetail, "superseded by generation 3");
  });
});

test("hsrUnavailable: ZERO writes for the bee — nothing opens, nothing closes", async () => {
  await withTempStore(async () => {
    const reconcile = createRequestReconciler();
    await openRequest("alpha", storedInput({ id: "held-open" }));
    const record = bee("alpha", { runtimeGeneration: 5 }); // would supersede if acted on
    const path = join(requestsRoot(), `${safeName("alpha")}.json`);
    const before = await readFile(path, "utf8");

    const outcomes = await reconcile(input({
      records: [record],
      // Even a (stale) observation with pending evidence must be ignored.
      hsrObservations: new Map([["alpha", obsFor(PENDING_EVENTS, false)]]),
      hsrUnavailable: new Set(["alpha"]),
    }));
    assert.deepEqual(outcomes, []);
    assert.equal(await readFile(path, "utf8"), before, "request file untouched");
  });
});

test("registry: request reconciliation precedes automatic recovery and needs-input, and skips an untrusted snapshot", async () => {
  const names = tickDispatchers.map((dispatcher) => dispatcher.name);
  const reconcileIdx = names.indexOf("reconcileRequests");
  const authRecoveryIdx = names.indexOf("recoverAuthNeeded");
  const rotationResumeIdx = names.indexOf("resumeRotationStranded");
  const needsInputIdx = names.indexOf("dispatchNeedsInput");
  assert.ok(reconcileIdx >= 0, "reconcileRequests is registered");
  assert.equal(reconcileIdx + 1, authRecoveryIdx, "auth recovery runs after its durable request is reconciled");
  assert.equal(authRecoveryIdx + 1, rotationResumeIdx, "rotation resume runs after classifier-driven recovery so it wins ties");
  assert.equal(rotationResumeIdx + 1, needsInputIdx, "human routing follows automatic recovery");

  const dispatcher = tickDispatchers[reconcileIdx]!;
  let called = 0;
  const ctx = {
    deps: { reconcileRequests: async () => { called += 1; return []; } },
    records: [],
    observed: new Map(),
    hsrObs: new Map(),
    hsrUnavailable: new Set<string>(),
    sessionsSnapshotTrusted: false,
  } as unknown as DispatchContext;
  assert.equal(dispatcher.run(ctx), undefined, "untrusted sessions snapshot skips the stage");
  assert.equal(called, 0);

  const trusted = { ...ctx, sessionsSnapshotTrusted: true } as DispatchContext;
  await dispatcher.run(trusted);
  assert.equal(called, 1, "trusted snapshot runs the stage");
});

test("restart safety: a FRESH reconciler re-deriving the same evidence does not re-open a resolved request", async () => {
  await withTempStore(async () => {
    const record = bee("alpha");
    const first = createRequestReconciler();
    await first(input({ records: [record], hsrObservations: new Map([["alpha", obsFor(PENDING_EVENTS)]]) }));
    await resolveRequest("alpha", "req_live_1", { by: "hive-answer" });

    // Daemon restart: a brand-new reconciler instance, same trailing evidence
    // (the events tail still shows pendingNeedsInput until turn_end).
    const restarted = createRequestReconciler();
    const outcomes = await restarted(input({ records: [record], hsrObservations: new Map([["alpha", obsFor(PENDING_EVENTS)]]) }));
    assert.deepEqual(outcomes, [], "no re-open, no cancel");
    const stored = (await readBeeRequests("alpha"))[0]!;
    assert.equal(stored.status, "resolved");
  });
});

test("a kill_failed record without a stop-failed request gets one opened by the reconciler", async () => {
  await withTempStore(async () => {
    const reconcile = createRequestReconciler();
    const record = bee("alpha", { status: "kill_failed", runtimeGeneration: 2, lastError: "session still exists after kill" });
    const outcomes = await reconcile(input({ records: [record] }));
    assert.deepEqual(outcomes.map((o) => `${o.action}:${o.id}`), [`open:${stopFailedRequestId("alpha", 2)}`]);
    const stored = (await readBeeRequests("alpha"))[0]!;
    assert.equal(stored.kind, "manual-action");
    assert.equal(stored.scope, "runtime-generation");
    assert.equal(stored.grade, "structured");
    assert.match(stored.question!, /session still exists after kill/);

    // Steady state: the next tick does not duplicate it.
    assert.deepEqual(await reconcile(input({ records: [record] })), []);
  });
});

test("a pending lazy-wake replacement fence never opens a stop-failed request", async () => {
  await withTempStore(async () => {
    const reconcile = createRequestReconciler();
    const record = bee("alpha", {
      status: "kill_failed",
      runtimeGeneration: 2,
      lastError: "replacement operation lazy-wake is stopping generation 2",
      runtimeReplacement: {
        version: 1,
        reservationId: "lazy-wake-reservation",
        operation: "lazy-wake",
        sourceGeneration: 2,
        state: "pending",
        startedAt: iso(NOW - 5_000),
        updatedAt: iso(NOW - 5_000),
      },
    });
    assert.deepEqual(await reconcile(input({ records: [record] })), []);
    assert.deepEqual(await readBeeRequests(record.name), []);

    const failed = {
      ...record,
      runtimeReplacement: {
        ...record.runtimeReplacement!,
        state: "stop-failed" as const,
        detail: "exact stop unconfirmed",
      },
      lastError: "exact stop unconfirmed",
    };
    const outcomes = await reconcile(input({ records: [failed] }));
    assert.deepEqual(outcomes.map((outcome) => `${outcome.action}:${outcome.id}`), [
      `open:${stopFailedRequestId("alpha", 2)}`,
    ]);
  });
});

test("a stronger stop fence opens manual action even when stale replacement provenance remains pending", async () => {
  await withTempStore(async () => {
    const reconcile = createRequestReconciler();
    const record = bee("alpha", {
      status: "kill_failed",
      runtimeGeneration: 2,
      lastError: "explicit retire won while replacement was pending",
      stopIntent: {
        version: 1,
        action: "retire",
        generation: 2,
        requestedAt: iso(NOW - 4_000),
        attempts: 1,
      },
      runtimeReplacement: {
        version: 1,
        reservationId: "compatibility-repair",
        operation: "archive-correction-restore",
        sourceGeneration: 2,
        state: "pending",
        startedAt: iso(NOW - 5_000),
        updatedAt: iso(NOW - 5_000),
      },
    });

    const outcomes = await reconcile(input({ records: [record] }));
    assert.deepEqual(outcomes.map((outcome) => `${outcome.action}:${outcome.id}`), [
      `open:${stopFailedRequestId("alpha", 2)}`,
    ]);
    assert.match((await readBeeRequests("alpha"))[0]!.question!, /explicit retire won/);
  });
});

test("a retired record's opens cancel scope-closed \"retired\" and nothing re-opens", async () => {
  await withTempStore(async () => {
    const reconcile = createRequestReconciler();
    await openRequest("alpha", storedInput({ id: "left-open" }));
    const record = bee("alpha", { status: "done" });
    const outcomes = await reconcile(input({
      records: [record],
      // Even with stale pending evidence, a retired bee opens nothing.
      hsrObservations: new Map([["alpha", obsFor(PENDING_EVENTS)]]),
    }));
    assert.deepEqual(outcomes.map((o) => `${o.action}:${o.id}:${o.detail}`), ["cancel:left-open:retired"]);
    const stored = await readBeeRequests("alpha");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.cancelDetail, "retired");
  });
});

test("boot-tick cache seeding: a fresh reconciler still closes stale opens for bees with no live evidence this tick", async () => {
  await withTempStore(async () => {
    // Requests written before the daemon started (e.g. by CLI verbs).
    await openRequest("alpha", storedInput({ id: "stale", generation: 0 }));
    const record = bee("alpha", { runtimeGeneration: 2 });
    const reconcile = createRequestReconciler();
    // No hsr observation for alpha at all — but the seeded cache knows an open
    // record exists, so the record-level superseded backstop still lands.
    const outcomes = await reconcile(input({ records: [record] }));
    assert.deepEqual(outcomes.map((o) => `${o.action}:${o.id}`), ["cancel:stale"]);
    assert.equal((await readBeeRequests("alpha"))[0]!.cancelReason, "superseded");
  });
});
