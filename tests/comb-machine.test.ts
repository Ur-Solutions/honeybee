import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cancelRun, combRunDir, createRun, listSweepableRuns, loadRun } from "../src/comb/store.js";
import { applySealCompletion, activateAgent, effectBaseKey, evaluatePredicate, reconcileMachine } from "../src/comb/machine.js";
import { sweepCombs, type CombSweepDeps } from "../src/comb/controller.js";
import { judgeCombEvidence } from "../src/comb/evidence.js";
import type { ActivationRecord, CombSpec, JsonValue, RunRecord } from "../src/comb/types.js";
import type { SealRecord } from "../src/seal.js";
import { withFileLock } from "../src/lock.js";

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-comb-machine-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function reviewerNode(id: string) {
  return {
    id,
    executor: "agent" as const,
    binding: "strict" as const,
    output: {
      kind: "json-schema" as const,
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" }, finding: { type: "string" } },
        required: ["ok", "finding"],
        additionalProperties: false,
      },
    },
    agent: { capacity: { kind: "spawn" as const, bee: "codex" }, brief: `Review as ${id}` },
  };
}

function joinComb(mode: "all" | "any" | "quorum", tolerateFailures = 0, quorum?: number): CombSpec {
  return {
    formatVersion: 2,
    name: `join-${mode}`,
    input: { kind: "json-schema", schema: { type: "object" } },
    nodes: [
      reviewerNode("a"),
      reviewerNode("b"),
      reviewerNode("c"),
      {
        id: "join",
        executor: "engine",
        binding: "strict",
        join: { mode, tolerateFailures, ...(quorum !== undefined ? { quorum } : {}) },
        engine: { kind: "predicate", predicate: { kind: "output-equals", nodeId: "a", path: "/ok", equals: true } },
      },
    ],
    edges: ["a", "b", "c"].map((from) => ({ id: `${from}-join`, from, to: "join", kind: "forward" as const, on: "done" as const })),
    output: {
      contract: {
        kind: "json-schema",
        schema: {
          type: "object",
          properties: {
            items: { type: "array" },
            succeeded: { type: "integer" },
            failed: { type: "integer" },
            skipped: { type: "integer" },
          },
          required: ["items", "succeeded", "failed", "skipped"],
        },
      },
      value: { source: "node-output", nodeId: "join", pointer: "", lineage: "current", item: "aggregate" },
    },
  };
}

function sealFor(activation: ActivationRecord, output: JsonValue, status: SealRecord["status"] = "done"): SealRecord {
  return {
    beeName: `bee-${activation.address.nodeId}`,
    sealedAt: "2026-07-28T12:00:01.000Z",
    status,
    summary: "complete",
    taskId: activation.taskId,
    attempt: activation.address.attempt,
    output,
  };
}

function finish(run: RunRecord, id: string, status: SealRecord["status"] = "done"): void {
  const activation = Object.values(run.activations).find((candidate) => candidate.address.nodeId === id && !candidate.invalidatedAt)!;
  activateAgent(run, activation, "2026-07-28T12:00:00.000Z");
  applySealCompletion(run, activation, sealFor(activation, { ok: true, finding: id }, status), "2026-07-28T12:00:01.000Z");
}

test("all join tolerates configured failures and publishes a bounded aggregate output", async () => {
  await withTempStore(async (dir) => {
    const run = await createRun({
      definition: joinComb("all", 1),
      input: {},
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
      now: "2026-07-28T12:00:00.000Z",
      policies: { retireAgentsOnTerminal: false },
    });
    finish(run, "a");
    finish(run, "b");
    finish(run, "c", "failed");
    reconcileMachine(run, "2026-07-28T12:00:02.000Z");
    const joined = Object.values(run.activations).find((activation) => activation.address.nodeId === "join")!;
    assert.equal(joined.status, "done");
    assert.deepEqual(joined.aggregate && {
      succeeded: joined.aggregate.succeeded,
      failed: joined.aggregate.failed,
      skipped: joined.aggregate.skipped,
    }, { succeeded: 2, failed: 1, skipped: 0 });
    assert.equal(run.status, "done");
    assert.deepEqual(run.output, joined.aggregate);
  });
});

test("any and quorum joins skip unresolved siblings without mixing cohorts", async () => {
  for (const fixture of [
    { mode: "any" as const, quorum: undefined, successes: ["a"] },
    { mode: "quorum" as const, quorum: 2, successes: ["a", "b"] },
  ]) {
    await withTempStore(async (dir) => {
      const run = await createRun({
        definition: joinComb(fixture.mode, 1, fixture.quorum),
        input: {},
        cwd: dir,
        productKey: "test",
        origin: { kind: "manual", actor: "test" },
        policies: { retireAgentsOnTerminal: false },
      });
      fixture.successes.forEach((id) => finish(run, id));
      reconcileMachine(run, "2026-07-28T12:00:02.000Z");
      const joined = Object.values(run.activations).find((activation) => activation.address.nodeId === "join")!;
      assert.equal(joined.status, "done");
      assert.equal(joined.aggregate?.succeeded, fixture.successes.length);
      assert.equal(joined.aggregate?.skipped, 3 - fixture.successes.length);
      assert.equal(run.status, "done");
    });
  }
});

test("invalid schema output follows a retry edge into attempt N+1 and invalidates old lineage", async () => {
  await withTempStore(async (dir) => {
    const work = reviewerNode("work");
    const definition: CombSpec = {
      formatVersion: 2,
      name: "retry-output",
      input: { kind: "informal", description: "none" },
      nodes: [work],
      edges: [{ id: "retry-work", from: "work", to: "work", kind: "retry", on: "failed" }],
    };
    const run = await createRun({
      definition,
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
      policies: { maxAttemptsPerActivation: 2, retireAgentsOnTerminal: false },
    });
    const first = run.activations["work@1#0"]!;
    activateAgent(run, first, "2026-07-28T12:00:00.000Z");
    applySealCompletion(run, first, sealFor(first, { ok: true }), "2026-07-28T12:00:01.000Z");
    assert.equal(first.failure?.code, "invalid-output");
    reconcileMachine(run, "2026-07-28T12:00:02.000Z");
    assert.ok(first.invalidatedAt);
    assert.equal(run.activations["work@2#0"]?.status, "pending");
    assert.equal(run.activations["work@2#0"]?.address.attempt, 2);
    assert.notEqual(run.activations["work@2#0"]?.cohortId, first.cohortId);
  });
});

test("output-equals uses RFC 6901, canonical equality, no coercion, and waits for output", async () => {
  await withTempStore(async (dir) => {
    const run = await createRun({
      definition: joinComb("all"),
      input: {},
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
    });
    assert.deepEqual(
      evaluatePredicate(run, { kind: "output-equals", nodeId: "a", path: "/ok", equals: true }, { itemIndex: 0, now: "2026-07-28T12:00:00.000Z" }),
      { state: "waiting" },
    );
    finish(run, "a");
    assert.equal(evaluatePredicate(run, { kind: "output-equals", nodeId: "a", path: "/ok", equals: true }, { itemIndex: 0, now: "2026-07-28T12:00:00.000Z" }).state, "true");
    assert.equal(evaluatePredicate(run, { kind: "output-equals", nodeId: "a", path: "/ok", equals: "true" }, { itemIndex: 0, now: "2026-07-28T12:00:00.000Z" }).state, "false");
    assert.equal(evaluatePredicate(run, { kind: "output-equals", nodeId: "a", path: "/missing", equals: null }, { itemIndex: 0, now: "2026-07-28T12:00:00.000Z" }).state, "false");
  });
});

test("effect base keys include item index and attempt", () => {
  const base = {
    id: "a@1#0",
    address: { runId: "run", nodeId: "a", attempt: 1, itemIndex: 0 },
  } as ActivationRecord;
  assert.equal(effectBaseKey(base), "run:a[0]:1");
  assert.equal(effectBaseKey({ ...base, address: { ...base.address, itemIndex: 1 } }), "run:a[1]:1");
  assert.equal(effectBaseKey({ ...base, address: { ...base.address, attempt: 2 } }), "run:a[0]:2");
});

test("comb evidence composes the shared activation rule with exact subject and item correlation", () => {
  const activation = {
    id: "a@2#3",
    address: { runId: "run", nodeId: "a", attempt: 2, itemIndex: 3 },
    claim: { taskId: "run/a/3", attempt: 2, attemptStartedAt: "2026-07-28T12:00:00.000Z" },
    subject: { kind: "git-ref", key: "repo:main", revision: "abc" },
  } as ActivationRecord;
  const evidence = {
    recordedAt: "2026-07-28T12:00:01.000Z",
    taskId: "run/a/3",
    activation: activation.address,
    subject: activation.subject,
  };
  assert.equal(judgeCombEvidence(activation, evidence), "match");
  assert.equal(judgeCombEvidence(activation, { ...evidence, activation: { ...evidence.activation, itemIndex: 4 } }), "mismatch");
  assert.equal(judgeCombEvidence(activation, { ...evidence, subject: { ...evidence.subject, revision: "def" } }), "mismatch");
  assert.equal(judgeCombEvidence(activation, { ...evidence, taskId: "other" }), "mismatch");
  assert.equal(judgeCombEvidence(activation, { ...evidence, recordedAt: "2026-07-28T11:59:59.000Z" }), "none");
});

test("controller persists prepare/executing before spawn and never duplicates a confirmed spawn", async () => {
  await withTempStore(async (dir) => {
    const definition: CombSpec = {
      formatVersion: 2,
      name: "one-agent",
      input: { kind: "informal", description: "none" },
      nodes: [reviewerNode("work")],
      edges: [],
    };
    const run = await createRun({
      definition,
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
      policies: { retireAgentsOnTerminal: false },
    });
    let spawns = 0;
    const deps: CombSweepDeps = {
      listRuns: listSweepableRuns,
      latestSeal: async () => null,
      spawnAgent: async (request) => {
        spawns += 1;
        const during = (await loadRun(run.id))!;
        assert.equal(Object.values(during.effects)[0]?.status, "executing");
        return { name: request.name, id: "bee-id" };
      },
      lookupAgent: async () => null,
      retireAgent: async () => undefined,
      now: () => Date.parse("2026-07-28T12:00:00.000Z"),
    };
    await sweepCombs(deps, [], new Map());
    await sweepCombs(deps, [], new Map());
    assert.equal(spawns, 1);
    const stored = (await loadRun(run.id))!;
    assert.equal(Object.values(stored.effects)[0]?.status, "confirmed");
    assert.equal(stored.activations["work@1#0"]?.beeHandles[0]?.id, "bee-id");
  });
});

test("cross-controller run sweep lock prevents duplicate irreversible spawns", async () => {
  await withTempStore(async (dir) => {
    const definition: CombSpec = {
      formatVersion: 2,
      name: "concurrent-agent",
      input: { kind: "informal", description: "none" },
      nodes: [reviewerNode("work")],
      edges: [],
    };
    await createRun({
      definition,
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
      policies: { retireAgentsOnTerminal: false },
    });
    let spawns = 0;
    const deps: CombSweepDeps = {
      listRuns: listSweepableRuns,
      latestSeal: async () => null,
      spawnAgent: async (request) => {
        spawns += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { name: request.name };
      },
      lookupAgent: async () => null,
      retireAgent: async () => undefined,
      withRunSweepLock: (runId, fn) =>
        withFileLock(join(combRunDir(runId), ".sweep.lock"), fn, { timeoutMs: 2_000 }),
      now: () => Date.now(),
    };
    await Promise.all([
      sweepCombs(deps, [], new Map()),
      sweepCombs(deps, [], new Map()),
    ]);
    assert.equal(spawns, 1);
  });
});

test("crash recovery waits for adoption evidence before failing an unconfirmed spawn", async () => {
  await withTempStore(async (dir) => {
    const definition: CombSpec = {
      formatVersion: 2,
      name: "recover-agent",
      input: { kind: "informal", description: "none" },
      nodes: [reviewerNode("work")],
      edges: [],
    };
    const run = await createRun({
      definition,
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
      policies: { firstEvidenceMs: 100, retireAgentsOnTerminal: false },
    });
    let now = Date.parse("2026-07-28T12:00:00.000Z");
    let spawns = 0;
    let signalSpawn!: () => void;
    let releaseSpawn!: (result: { name: string; id?: string }) => void;
    const spawnStarted = new Promise<void>((resolve) => { signalSpawn = resolve; });
    const spawnResult = new Promise<{ name: string; id?: string }>((resolve) => { releaseSpawn = resolve; });
    const deps: CombSweepDeps = {
      listRuns: listSweepableRuns,
      latestSeal: async () => null,
      spawnAgent: async () => {
        spawns += 1;
        signalSpawn();
        return spawnResult;
      },
      lookupAgent: async () => null,
      retireAgent: async () => undefined,
      now: () => now,
    };

    const interruptedSweep = sweepCombs(deps, [], new Map());
    await spawnStarted;
    const withinWindow = await sweepCombs(deps, [], new Map());
    assert.equal(withinWindow.some((outcome) => outcome.detail === "executing spawn is still within its adoption window"), true);
    assert.equal((await loadRun(run.id))?.activations["work@1#0"]?.status, "active");

    now += 101;
    const afterWindow = await sweepCombs(deps, [], new Map());
    assert.equal(afterWindow.some((outcome) => outcome.error === "executing spawn was not adoptable"), true);
    releaseSpawn({ name: `late-${run.id}` });
    await interruptedSweep;

    const stored = (await loadRun(run.id))!;
    assert.equal(spawns, 1);
    assert.equal(stored.activations["work@1#0"]?.status, "failed");
    assert.equal(stored.activations["work@1#0"]?.failure?.code, "spawn-adoption-missing");
    assert.equal(Object.values(stored.effects)[0]?.status, "failed");
    assert.deepEqual(stored.activations["work@1#0"]?.beeHandles, []);
  });
});

test("cancellation is a fence before effects and crossing it during execute becomes ambiguous", async () => {
  await withTempStore(async (dir) => {
    const definition: CombSpec = {
      formatVersion: 2,
      name: "cancel-agent",
      input: { kind: "informal", description: "none" },
      nodes: [reviewerNode("work")],
      edges: [],
    };
    const before = await createRun({
      definition,
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
    });
    await cancelRun(before.id);
    let beforeSpawns = 0;
    await sweepCombs({
      listRuns: listSweepableRuns,
      latestSeal: async () => null,
      spawnAgent: async (request) => { beforeSpawns += 1; return { name: request.name }; },
      lookupAgent: async () => null,
      retireAgent: async () => undefined,
      now: () => Date.now(),
    }, [], new Map());
    assert.equal(beforeSpawns, 0);

    const during = await createRun({
      definition,
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
    });
    const deps: CombSweepDeps = {
      listRuns: async () => [(await loadRun(during.id))!],
      latestSeal: async () => null,
      spawnAgent: async (request) => {
        await cancelRun(during.id, { reason: "race" });
        return { name: request.name };
      },
      lookupAgent: async () => null,
      retireAgent: async () => undefined,
      now: () => Date.now(),
    };
    await sweepCombs(deps, [], new Map());
    const crossed = (await loadRun(during.id))!;
    assert.equal(Object.values(crossed.effects)[0]?.status, "ambiguous");
    assert.equal(crossed.cleanup.status, "blocked-ambiguous");
  });
});

test("state-machine safety properties hold across generated evidence/order traces", async () => {
  await withTempStore(async (dir) => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const definition: CombSpec = {
        formatVersion: 2,
        name: `property-${seed}`,
        input: { kind: "informal", description: "none" },
        nodes: [reviewerNode("work")],
        edges: [{ id: "retry", from: "work", to: "work", kind: "retry", on: "failed" }],
      };
      const run = await createRun({
        definition,
        input: null,
        cwd: dir,
        productKey: "test",
        origin: { kind: "manual", actor: "property" },
        policies: { maxAttemptsPerActivation: 3, retryBackoffMs: 0, retireAgentsOnTerminal: false },
      });
      let state = seed;
      for (let step = 0; step < 8 && run.status === "active"; step += 1) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        const current = Object.values(run.activations)
          .filter((activation) => !activation.invalidatedAt)
          .sort((a, b) => b.address.attempt - a.address.attempt)[0]!;
        if (current.status === "pending") activateAgent(run, current, `2026-07-28T12:00:0${step}.000Z`);
        if (state % 3 === 0) {
          applySealCompletion(run, current, sealFor(current, { ok: true, finding: `seed-${seed}` }), `2026-07-28T12:00:0${step}.500Z`);
        } else if (state % 3 === 1) {
          applySealCompletion(run, current, sealFor(current, { invalid: true }), `2026-07-28T12:00:0${step}.500Z`);
        }
        reconcileMachine(run, `2026-07-28T12:00:0${step}.900Z`);
        for (const activation of Object.values(run.activations)) {
          if (activation.status === "done") assert.notEqual(activation.output, undefined, "done requires schema-valid output");
        }
        const identities = Object.values(run.activations).map((activation) => activation.id);
        assert.equal(new Set(identities).size, identities.length, "attempts never overwrite history");
      }
    }
  });
});
