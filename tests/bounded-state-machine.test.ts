import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isActiveSessionRecord,
  listActiveSessions,
  loadSession,
  markSessionUnverified,
  markSessionVerified,
  saveSession,
  touchSession,
  transitionSession,
  updateSession,
  type SessionRecord,
} from "../src/store.js";
import {
  makeStateMachineCursor,
  reduceBeeTransition,
  type BeeStateMachineCursor,
  type BeeTransitionEvent,
  type HookEvidence,
  type OperatorEvidence,
  type ProbeEvidence,
  type RecoveryEvidence,
  type RequestEvidence,
  type StateMachineSeed,
} from "../src/stateMachine.js";
import { projectBeeView } from "../src/view/project.js";

const T0 = Date.parse("2026-08-11T19:00:00.000Z");

async function withTempStore(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-bounded-state-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = root;
  try {
    await fn(root);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "CO.bounded",
    agent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: "CO.bounded",
    substrate: "hsr",
    runnerPid: 4242,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    status: "running",
    ...overrides,
  };
}

function at(step: number): string {
  return new Date(T0 + step * 1_000).toISOString();
}

function probe(step: number, outcome: ProbeEvidence["outcome"] = "alive"): ProbeEvidence {
  return {
    kind: "probe",
    probeId: `probe-${step}`,
    observerId: "test-observer",
    observedAt: at(step),
    outcome,
    target: { substrate: "hsr", runnerPid: 4242 },
  };
}

function hook(step: number, value: HookEvidence["hook"]): HookEvidence {
  return { kind: "hook", hookId: `hook-${step}`, observedAt: at(step), hook: value };
}

function operator(step: number, action: OperatorEvidence["action"]): OperatorEvidence {
  return { kind: "operator", actionId: `op-${step}`, observedAt: at(step), action };
}

function request(step: number, action: RequestEvidence["action"]): RequestEvidence {
  return { kind: "request", requestId: `req-${step}`, observedAt: at(step), action };
}

function recovery(step: number, outcome: RecoveryEvidence["outcome"]): RecoveryEvidence {
  return {
    kind: "recovery",
    attemptId: `attempt-${step}`,
    observedAt: at(step),
    attempt: 3,
    budget: 3,
    outcome,
  };
}

function eventSet(step: number): BeeTransitionEvent[] {
  const req = request(step, "opened");
  return [
    { eventId: `start-${step}`, at: at(step), type: "turn.started", cause: "first-turn", evidence: hook(step, "turn-start") },
    { eventId: `settle-${step}`, at: at(step), type: "turn.settled", cause: "turn-settled", evidence: hook(step, "turn-end"), probe: probe(step) },
    { eventId: `open-${step}`, at: at(step), type: "request.opened", cause: "auth", requestId: req.requestId, evidence: req },
    { eventId: `lost-${step}`, at: at(step), type: "runtime.lost", cause: "mid-turn-death", probe: probe(step, "dead") },
    { eventId: `recover-ok-${step}`, at: at(step), type: "recovery.succeeded", cause: "revive-ok", evidence: recovery(step, "succeeded"), probe: probe(step) },
    { eventId: `recover-fail-${step}`, at: at(step), type: "recovery.failed", cause: "budget-exhausted", requestId: `recovery-${step}`, evidence: recovery(step, "failed"), probe: probe(step, "dead") },
    { eventId: `resolve-${step}`, at: at(step), type: "request.resolved", cause: "answer", requestId: `req-${step}`, evidence: request(step, "answered") },
    { eventId: `steer-${step}`, at: at(step), type: "turn.steered", cause: "steer", evidence: operator(step, "steer") },
    { eventId: `park-${step}`, at: at(step), type: "runtime.parked", cause: "idle-death", probe: probe(step, "dead") },
    { eventId: `archive-${step}`, at: at(step), type: "bee.archived", cause: "retire", evidence: operator(step, "retire"), probe: probe(step) },
    { eventId: `revive-${step}`, at: at(step), type: "bee.revived", cause: "revive", resume: "working", evidence: operator(step, "revive"), probe: probe(step) },
    { eventId: `revive-needs-you-${step}`, at: at(step), type: "bee.revived", cause: "revive", resume: "needs-you", evidence: operator(step, "revive"), probe: probe(step) },
  ];
}

function axes(cursor: BeeStateMachineCursor | StateMachineSeed): StateMachineSeed {
  return { lifecycle: cursor.lifecycle, runtime: cursor.runtime, work: cursor.work };
}

test("property-style: raw event sequences persist only table edges and audit every rejection with evidence", async () => {
  await withTempStore(async (root) => {
    await saveSession(record());
    let rejected = 0;
    let seed = 0x5eed;
    for (let step = 1; step <= 120; step += 1) {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
      const candidates = eventSet(step);
      const event = candidates[seed % candidates.length]!;
      const before = (await loadSession("CO.bounded"))!;
      const from = before.stateMachine ? axes(before.stateMachine) : { lifecycle: "active", runtime: "live", work: "spawning" } as const;
      let expected: StateMachineSeed | undefined;
      try {
        expected = reduceBeeTransition(from, event).to;
      } catch {
        rejected += 1;
      }

      if (expected) {
        const result = await transitionSession(before.name, event);
        assert.equal(result?.changed, true);
        assert.deepEqual(axes(result!.record.stateMachine!), expected);
      } else {
        await assert.rejects(transitionSession(before.name, event), /illegal .* transition/);
        const after = (await loadSession(before.name))!;
        assert.deepEqual(after.stateMachine, before.stateMachine, "illegal transition cannot change the cursor");
      }
    }

    assert.ok(rejected > 0, "the generated sequence exercises rejected edges");
    const ledger = (await readFile(join(root, "ledger.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const audits = ledger.filter((row) => row.type === "state.transition.rejected" && row.source === "transitionSession");
    assert.equal(audits.length, rejected);
    assert.ok(audits.every((row) => row.event && row.evidence), "every illegal attempt is durably audited with its evidence");

    const current = (await loadSession("CO.bounded"))!;
    await assert.rejects(updateSession(current.name, { stateMachine: current.stateMachine }), /only be changed through transitionSession/);
    assert.deepEqual((await loadSession(current.name))?.stateMachine, current.stateMachine);
  });
});

test("exhaustive table: needs-you runner death has a parked edge but no lost edge", () => {
  const from: StateMachineSeed = { lifecycle: "active", runtime: "live", work: "needs-you" };
  const accepted = eventSet(20).flatMap((event) => {
    try {
      return [[event.type, reduceBeeTransition(from, event).to] as const];
    } catch {
      return [];
    }
  });

  assert.deepEqual(accepted, [
    ["request.resolved", { lifecycle: "active", runtime: "live", work: "working" }],
    ["runtime.parked", { lifecycle: "active", runtime: "parked", work: "needs-you" }],
    ["bee.archived", { lifecycle: "archived", runtime: "parked", work: "done" }],
  ]);
  const lost = eventSet(21).find((event) => event.type === "runtime.lost")!;
  assert.throws(() => reduceBeeTransition(from, lost), /illegal runtime\.lost transition/);

  const parked = accepted.find(([type]) => type === "runtime.parked")![1];
  const resumed = reduceBeeTransition(parked, {
    eventId: "needs-you-resumed",
    at: at(22),
    type: "bee.revived",
    cause: "revive",
    resume: "needs-you",
    evidence: operator(22, "revive"),
    probe: probe(22, "alive"),
  });
  assert.deepEqual(resumed.to, from, "lazy respawn restores runtime without changing the open work axis");
  assert.throws(
    () => reduceBeeTransition({ lifecycle: "archived", runtime: "parked", work: "done" }, {
      eventId: "archived-cannot-resume-needs-you",
      at: at(23),
      type: "bee.revived",
      cause: "revive",
      resume: "needs-you",
      evidence: operator(23, "revive"),
      probe: probe(23, "alive"),
    }),
    /illegal bee\.revived transition/,
  );
});

test("transitionSession is idempotent for an exact lastEventId replay", async () => {
  await withTempStore(async () => {
    await saveSession(record());
    const event = eventSet(1)[0]!;
    const first = await transitionSession("CO.bounded", event);
    const replay = await transitionSession("CO.bounded", event);
    assert.equal(first?.changed, true);
    assert.equal(replay?.changed, false);
    assert.equal(replay?.record.stateMachine?.revision, 1);
  });
});

test("explicit archive and revive events atomically drive legacy status and probe membership", async () => {
  await withTempStore(async () => {
    await saveSession(record());
    const archive = eventSet(1).find((event) => event.type === "bee.archived")!;
    const archived = await transitionSession("CO.bounded", archive);
    assert.equal(archived?.record.status, "done");
    assert.equal(archived?.record.stateMachine?.lifecycle, "archived");
    assert.equal(isActiveSessionRecord(archived!.record), false);
    assert.deepEqual(await listActiveSessions(), []);

    const revive = eventSet(2).find((event) => event.type === "bee.revived")!;
    const revived = await transitionSession("CO.bounded", revive);
    assert.equal(revived?.record.status, "running");
    assert.equal(revived?.record.stateMachine?.lifecycle, "active");
    assert.equal(isActiveSessionRecord(revived!.record), true);
    assert.deepEqual((await listActiveSessions()).map((row) => row.name), ["CO.bounded"]);
  });
});

test("terminal legacy cursor write without probe evidence is rejected at the store layer", async () => {
  await withTempStore(async (root) => {
    await assert.rejects(
      saveSession(record({ lastObservedState: "crashed", lastObservedStateAt: at(1) })),
      /requires probe evidence/,
    );
    await saveSession(record());
    await assert.rejects(
      touchSession("CO.bounded", { lastObservedState: "crashed", lastObservedStateAt: at(1) }),
      /requires probe evidence/,
    );
    assert.equal((await loadSession("CO.bounded"))?.lastObservedState, undefined);
    const ledger = await readFile(join(root, "ledger.jsonl"), "utf8");
    assert.match(ledger, /"type":"state.transition.rejected"/);
    assert.match(ledger, /"evidence":null/);
  });
});

test("a crashed-marked active record stays probeable and heals on an alive probe", async () => {
  await withTempStore(async () => {
    await saveSession(record({ lastObservedState: "crashed", lastObservedStateAt: at(1) }), {
      probeEvidence: probe(1, "dead"),
    });
    const crashed = (await loadSession("CO.bounded"))!;
    assert.equal(isActiveSessionRecord(crashed), true);
    assert.deepEqual((await listActiveSessions()).map((row) => row.name), ["CO.bounded"]);

    await markSessionUnverified("CO.bounded", {
      since: at(1),
      reason: "observer-offline",
      probeScheduledAt: at(2),
      observer: { observerId: "daemon-A", offlineSince: at(1), reason: "restart" },
    });
    await markSessionVerified("CO.bounded", probe(2, "alive"));
    const healed = await loadSession("CO.bounded");
    assert.equal(healed?.lastObservedState, undefined);
    assert.equal(healed?.stateUnverified, undefined);
  });
});

function cursor(from: StateMachineSeed, event: BeeTransitionEvent, revision = 0): BeeStateMachineCursor {
  return makeStateMachineCursor(reduceBeeTransition(from, event), revision);
}

function viewFor(rec: SessionRecord) {
  return projectBeeView({
    record: rec,
    context: { liveTargets: new Set(), hsrLive: new Set(), hsrStates: new Map(), now: T0 + 60_000 },
    now: T0 + 60_000,
  });
}

test("BeeView projects recovering, invisible parked, recovery failure, and observer-offline uncertainty", () => {
  const working: StateMachineSeed = { lifecycle: "active", runtime: "live", work: "working" };
  const lostEvent = eventSet(10).find((event) => event.type === "runtime.lost")!;
  const recovering = cursor(working, lostEvent);
  const recoveringView = viewFor(record({ lastPromptAt: at(1), stateMachine: recovering }));
  assert.equal(recoveringView.displayState, "recovering");
  assert.equal(recoveringView.interactionState, "working");
  assert.equal(recoveringView.latestRuntime.runtimeState, "recovering");

  const parkedEvent = eventSet(11).find((event) => event.type === "runtime.parked")!;
  const parked = cursor({ lifecycle: "active", runtime: "live", work: "done" }, parkedEvent);
  const parkedView = viewFor(record({ lastPromptAt: at(1), stateMachine: parked }));
  assert.equal(parkedView.displayState, "ready");
  assert.equal(parkedView.latestRuntime.runtimeState, "parked");

  const mixedVersionView = viewFor(record({
    status: "done",
    lastPromptAt: at(1),
    stateMachine: parked,
  }));
  assert.equal(mixedVersionView.bee.lifecycleState, "active", "canonical active outranks a stale done scalar");
  assert.equal(mixedVersionView.displayState, "ready");
  assert.equal(mixedVersionView.interactionState, "idle");
  assert.equal(mixedVersionView.latestRuntime.runtimeState, "parked");
  assert.equal(mixedVersionView.latestRuntime.evidence.grade, "structured");
  assert.match(mixedVersionView.latestRuntime.evidence.detail ?? "", /idle runtime parked/);

  const failedEvent = eventSet(12).find((event) => event.type === "recovery.failed")!;
  const failed = cursor(axes(recovering), failedEvent, recovering.revision);
  const failedView = viewFor(record({ lastPromptAt: at(1), stateMachine: failed }));
  assert.equal(failedView.displayState, "needs-action");
  assert.equal(failedView.openRequests[0]?.id, "recovery-12");
  assert.equal(failedView.openRequests[0]?.kind, "manual-action");

  const verifiedView = viewFor(record({ lastPromptAt: at(1), stateMachine: parked }));
  const offlineView = viewFor(record({
    lastPromptAt: at(1),
    stateMachine: parked,
    stateUnverified: {
      since: at(20),
      reason: "observer-offline",
      probeScheduledAt: at(21),
      observer: { observerId: "daemon-A", offlineSince: at(20), reason: "restart window" },
    },
  }));
  assert.equal(offlineView.displayState, verifiedView.displayState, "observer loss cannot change projected state");
  assert.equal(offlineView.latestRuntime.runtimeState, verifiedView.latestRuntime.runtimeState);
  assert.equal(offlineView.verification.unverified, true);
  assert.equal(offlineView.verification.unverifiedSince, at(20));
  assert.equal(offlineView.verification.observerOffline?.observerId, "daemon-A");
});
