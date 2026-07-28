import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  claimPath,
  deriveSubjectClaim,
  loadClaim,
  releaseClaim,
  withPreparedClaim,
} from "../src/comb/claims.js";
import {
  deterministicAgentName,
  sweepCombs,
  type CombSweepDeps,
} from "../src/comb/controller.js";
import { asCombError } from "../src/comb/errors.js";
import { atomicWriteFile } from "../src/fsx.js";
import { deliveryRequestDigest, instantiateRun } from "../src/comb/instantiate.js";
import {
  applySealCompletion,
  activateAgent,
  evaluatePredicate,
  reconcileMachine,
} from "../src/comb/machine.js";
import { lintComb } from "../src/comb/schema.js";
import {
  boardView,
  cancelRun,
  createRun,
  emptyCleanup,
  listRuns,
  listSweepableRuns,
  loadRun,
  mutateRun,
  recordRunEvent,
} from "../src/comb/store.js";
import type { ActivationRecord, CombSpec, RunRecord } from "../src/comb/types.js";
import type { SealRecord } from "../src/seal.js";

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-comb-review-regression-"));
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

function agentNode(id: string) {
  return {
    id,
    executor: "agent" as const,
    binding: "strict" as const,
    agent: { capacity: { kind: "spawn" as const, bee: "codex" }, brief: `work ${id}` },
  };
}

function sealFor(activation: ActivationRecord, status: SealRecord["status"] = "done"): SealRecord {
  return {
    beeName: `bee-${activation.address.nodeId}-a${activation.address.attempt}`,
    sealedAt: "2026-07-28T12:00:01.000Z",
    status,
    summary: "complete",
    taskId: activation.taskId,
    attempt: activation.address.attempt,
  };
}

function finish(run: RunRecord, nodeId: string, status: SealRecord["status"] = "done"): ActivationRecord {
  const activation = Object.values(run.activations).find(
    (candidate) =>
      candidate.address.nodeId === nodeId &&
      !candidate.invalidatedAt &&
      candidate.status !== "done" &&
      candidate.status !== "failed" &&
      candidate.status !== "skipped",
  );
  assert.ok(activation, `expected a live ${nodeId} activation`);
  activateAgent(run, activation, "2026-07-28T12:00:00.000Z");
  applySealCompletion(run, activation, sealFor(activation, status), "2026-07-28T12:00:01.000Z");
  return activation;
}

function sweepDeps(overrides: Partial<CombSweepDeps> = {}): CombSweepDeps {
  return {
    listRuns: listSweepableRuns,
    latestSeal: async () => null,
    spawnAgent: async (request) => ({ name: request.name }),
    lookupAgent: async () => null,
    retireAgent: async () => undefined,
    releaseClaim,
    now: () => Date.now(),
    ...overrides,
  };
}

function claimedDefinition(name = "claim-comb"): CombSpec {
  return {
    formatVersion: 2,
    name,
    input: {
      kind: "json-schema",
      schema: {
        type: "object",
        properties: { pr: { type: "integer" } },
        required: ["pr"],
      },
    },
    claim: { scope: "product-comb", inputPointer: "/pr", collision: "refuse" },
    nodes: [agentNode("work")],
    edges: [],
  };
}

test("review repro A1: partial-branch retry re-derives every all-join member in the new cohort", async () => {
  await withTempStore(async (dir) => {
    const definition: CombSpec = {
      formatVersion: 2,
      name: "partial-retry",
      input: { kind: "informal", description: "x" },
      nodes: [
        agentNode("a"),
        agentNode("b"),
        { ...agentNode("c"), join: { mode: "all", tolerateFailures: 0 } },
      ],
      edges: [
        { id: "a-c", from: "a", to: "c", kind: "forward", on: "done" },
        { id: "b-c", from: "b", to: "c", kind: "forward", on: "done" },
        { id: "c-retry", from: "c", to: "a", kind: "retry", on: "failed" },
      ],
    };
    const run = await createRun({
      definition,
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
      policies: { maxAttemptsPerActivation: 3, retryBackoffMs: 0, retireAgentsOnTerminal: false },
    });

    finish(run, "a");
    finish(run, "b");
    reconcileMachine(run, "2026-07-28T12:00:02.000Z");
    finish(run, "c", "failed");
    reconcileMachine(run, "2026-07-28T12:00:03.000Z");

    const a2 = run.activations["a@2#0"];
    const b2 = run.activations["b@2#0"];
    assert.ok(a2, "retry destination is recreated");
    assert.ok(b2, "the other required all-join branch is recreated");
    assert.equal(a2.cohortId, b2.cohortId);
    assert.ok(run.activations["a@1#0"]?.invalidatedAt);
    assert.ok(run.activations["b@1#0"]?.invalidatedAt);

    finish(run, "a");
    finish(run, "b");
    reconcileMachine(run, "2026-07-28T12:00:04.000Z");
    const c2 = run.activations["c@2#0"];
    assert.ok(c2, "the join is materialized in the retry cohort");
    assert.equal(c2.cohortId, a2.cohortId);
    assert.equal(run.status, "active");
  });
});

test("review repro A2: any/quorum resolution never skips a source activation shared with another join", async () => {
  await withTempStore(async (dir) => {
    const definition: CombSpec = {
      formatVersion: 2,
      name: "shared-skip",
      input: { kind: "informal", description: "x" },
      nodes: [
        agentNode("a"),
        agentNode("b"),
        { ...agentNode("j"), join: { mode: "any", tolerateFailures: 0 } },
        { ...agentNode("m"), join: { mode: "all", tolerateFailures: 0 } },
      ],
      edges: [
        { id: "a-j", from: "a", to: "j", kind: "forward", on: "done" },
        { id: "b-j", from: "b", to: "j", kind: "forward", on: "done" },
        { id: "a-m", from: "a", to: "m", kind: "forward", on: "done" },
        { id: "b-m", from: "b", to: "m", kind: "forward", on: "done" },
      ],
    };
    const run = await createRun({
      definition,
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
      policies: { retireAgentsOnTerminal: false },
    });

    const b1 = run.activations["b@1#0"]!;
    activateAgent(run, b1, "2026-07-28T12:00:00.000Z");
    finish(run, "a");
    reconcileMachine(run, "2026-07-28T12:00:02.000Z");

    assert.equal(b1.status, "active");
    const anyJoin = run.activations["j@1#0"];
    assert.ok(anyJoin);
    assert.equal(anyJoin.aggregate?.skipped, 1);
    assert.equal(run.activations["m@1#0"], undefined, "the all join remains unresolved while b is live");

    applySealCompletion(run, b1, sealFor(b1), "2026-07-28T12:00:03.000Z");
    reconcileMachine(run, "2026-07-28T12:00:04.000Z");
    assert.equal(
      Object.values(run.activations).find((activation) => activation.id === "m@1#0")?.status,
      "pending",
    );
  });
});

test("review repro A3: self-retrying a join never creates a second live activation in the old cohort", async () => {
  await withTempStore(async (dir) => {
    const definition: CombSpec = {
      formatVersion: 2,
      name: "self-retry-join",
      input: { kind: "informal", description: "x" },
      nodes: [
        agentNode("a"),
        agentNode("b"),
        { ...agentNode("c"), join: { mode: "all", tolerateFailures: 0 } },
      ],
      edges: [
        { id: "a-c", from: "a", to: "c", kind: "forward", on: "done" },
        { id: "b-c", from: "b", to: "c", kind: "forward", on: "done" },
        { id: "c-retry", from: "c", to: "c", kind: "retry", on: "failed" },
      ],
    };
    const run = await createRun({
      definition,
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
      policies: { maxAttemptsPerActivation: 5, retryBackoffMs: 0, retireAgentsOnTerminal: false },
    });

    finish(run, "a");
    finish(run, "b");
    reconcileMachine(run, "2026-07-28T12:00:02.000Z");
    finish(run, "c", "failed");
    reconcileMachine(run, "2026-07-28T12:00:03.000Z");
    reconcileMachine(run, "2026-07-28T12:00:04.000Z");

    const current = Object.values(run.activations).filter(
      (activation) =>
        activation.address.nodeId === "c" &&
        !activation.invalidatedAt &&
        (activation.status === "pending" || activation.status === "active"),
    );
    assert.equal(current.length, 1);
    assert.equal(current[0]?.id, "c@2#0");
    assert.equal(Object.values(run.activations).some((activation) => activation.id === "c@3#0"), false);
  });
});

test("review repro B1: cancelling a done run is an idempotent terminal acknowledgement", async () => {
  await withTempStore(async (dir) => {
    const run = await createRun({
      definition: {
        formatVersion: 2,
        name: "done-cancel",
        input: { kind: "informal", description: "x" },
        nodes: [agentNode("solo")],
        edges: [],
      },
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
      policies: { retireAgentsOnTerminal: false },
    });
    finish(run, "solo");
    reconcileMachine(run, "2026-07-28T12:00:02.000Z");
    await mutateRun(run.id, (record) => {
      Object.assign(record, run);
    });
    const before = (await loadRun(run.id))!;

    const after = await cancelRun(run.id, { reason: "late duplicate" });
    assert.equal(after.status, "done");
    assert.equal(after.cleanup.status, before.cleanup.status);
    assert.equal(after.endedAt, before.endedAt);
    assert.equal(after.cancellation, undefined);
    assert.equal(after.nextEventSequence, before.nextEventSequence);
  });
});

test("review repro B2: instant terminal cleanup releases the claim and leaves the sweep set", async () => {
  await withTempStore(async () => {
    const definition = claimedDefinition();
    const first = await instantiateRun({
      definition,
      input: { pr: 42 },
      cwd: "/tmp",
      productKey: "prod",
      origin: { kind: "manual", actor: "test" },
    });
    const deps = sweepDeps({
      spawnAgent: async () => {
        throw new Error("spawn binary missing");
      },
    });
    for (let index = 0; index < 4; index += 1) await sweepCombs(deps, [], new Map());

    const terminal = (await loadRun(first.run.id))!;
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.cleanup.status, "complete");
    assert.ok(terminal.endedAt);
    assert.ok(terminal.subjectClaimReleasedAt);
    assert.equal((await loadClaim(terminal.subjectClaimId!))?.status, "released");
    assert.equal((await listSweepableRuns()).some((run) => run.id === terminal.id), false);

    const second = await instantiateRun({
      definition,
      input: { pr: 42 },
      cwd: "/tmp",
      productKey: "prod",
      origin: { kind: "manual", actor: "test" },
    });
    assert.notEqual(second.run.id, first.run.id);
    assert.equal(second.created, true);
  });
});

test("review repro B3: cancellation classifies a crash-orphaned prepared effect", async () => {
  await withTempStore(async () => {
    const created = await instantiateRun({
      definition: claimedDefinition(),
      input: { pr: 7 },
      cwd: "/tmp",
      productKey: "prod",
      origin: { kind: "manual", actor: "test" },
    });
    const runId = created.run.id;
    await sweepCombs(sweepDeps({
      spawnAgent: async () => {
        throw new Error("SIMULATED-DAEMON-CRASH");
      },
    }), [], new Map());
    await mutateRun(runId, (run) => {
      for (const effect of Object.values(run.effects)) {
        effect.status = "prepared";
        delete effect.executeStartedAt;
        delete effect.error;
      }
      for (const activation of Object.values(run.activations)) {
        activation.status = "pending";
        delete activation.endedAt;
        delete activation.failure;
      }
      run.status = "active";
      delete run.failure;
      delete run.endedAt;
      run.cleanup = emptyCleanup("not-required");
    });

    await cancelRun(runId, { reason: "cancel while daemon is down" });
    const deps = sweepDeps();
    for (let index = 0; index < 3; index += 1) await sweepCombs(deps, [], new Map());

    const terminal = (await loadRun(runId))!;
    assert.equal(terminal.status, "cancelled");
    assert.equal(terminal.cleanup.status, "complete");
    assert.deepEqual(Object.values(terminal.effects).map((effect) => effect.status), ["not-executed"]);
    assert.equal((await loadClaim(terminal.subjectClaimId!))?.status, "released");
    assert.equal((await listSweepableRuns()).some((run) => run.id === runId), false);
  });
});

test("review repro B4: attempts exhaustion performs full cleanup, retirement, and claim release", async () => {
  await withTempStore(async () => {
    const definition: CombSpec = {
      ...claimedDefinition("exhaust"),
      claim: { scope: "product-comb", inputPointer: "", collision: "refuse" },
      input: { kind: "json-schema", schema: { type: "object" } },
      edges: [{ id: "retry", from: "work", to: "work", kind: "retry", on: "failed" }],
    };
    const created = await instantiateRun({
      definition,
      input: {},
      cwd: "/tmp",
      productKey: "prod",
      origin: { kind: "manual", actor: "test" },
      policies: { maxAttemptsPerActivation: 1, retryBackoffMs: 0 },
    });
    const seals = new Map<string, SealRecord>();
    const retired: string[] = [];
    const deps = sweepDeps({
      spawnAgent: async (request) => {
        seals.set(request.name, {
          beeName: request.name,
          sealedAt: new Date(Date.now() + 1_000).toISOString(),
          status: "failed",
          summary: "gave up",
          taskId: request.taskId,
          attempt: request.attempt,
        });
        return { name: request.name };
      },
      latestSeal: async (name) => {
        const seal = seals.get(name);
        return seal ? { filename: `${name}.json`, seal } : null;
      },
      retireAgent: async (name) => {
        retired.push(name);
      },
    });
    for (let index = 0; index < 5; index += 1) await sweepCombs(deps, [], new Map());

    const terminal = (await loadRun(created.run.id))!;
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.failure?.code, "attempts-exhausted");
    assert.equal(terminal.cleanup.status, "complete");
    assert.ok(terminal.endedAt);
    assert.deepEqual(retired, [Object.values(terminal.activations)[0]?.beeHandles[0]?.name]);
    assert.equal((await loadClaim(terminal.subjectClaimId!))?.status, "released");
    assert.equal((await listSweepableRuns()).some((run) => run.id === terminal.id), false);
  });
});

test("review repro B5: a spawn that crosses cancellation is confirmed, retired, and never wedges ambiguous", async () => {
  await withTempStore(async (dir) => {
    const run = await createRun({
      definition: {
        formatVersion: 2,
        name: "cancel-crossing",
        input: { kind: "informal", description: "x" },
        nodes: [agentNode("work")],
        edges: [],
      },
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
    });
    const retired: string[] = [];
    const deps = sweepDeps({
      listRuns: async () => {
        const current = await loadRun(run.id);
        return current ? [current] : [];
      },
      spawnAgent: async (request) => {
        await cancelRun(run.id, { reason: "cross fence" });
        return { name: request.name };
      },
      retireAgent: async (name) => {
        retired.push(name);
      },
    });

    await sweepCombs(deps, [], new Map());
    const terminal = (await loadRun(run.id))!;
    assert.equal(terminal.status, "cancelled");
    assert.equal(terminal.cleanup.status, "complete");
    assert.deepEqual(Object.values(terminal.effects).map((effect) => effect.status), ["confirmed"]);
    assert.equal(retired.length, 1);
  });
});

test("review contract B6: a prepared claim with its durable matching run repairs to held", async () => {
  await withTempStore(async (dir) => {
    const definition = claimedDefinition("prepared-repair");
    const input = { pr: 91 };
    const runId = "0000000000001-cafe";
    const claim = deriveSubjectClaim({
      definition,
      productKey: "prod",
      input,
      runId,
      now: "2026-07-28T12:00:00.000Z",
    })!;
    await mkdir(dirname(claimPath(claim.id)), { recursive: true });
    await atomicWriteFile(claimPath(claim.id), `${JSON.stringify(claim, null, 2)}\n`, { mode: 0o600 });
    await createRun({
      definition,
      input,
      cwd: dir,
      productKey: "prod",
      origin: { kind: "manual", actor: "test" },
      runId,
      subjectClaimId: claim.id,
    });

    const competitor = deriveSubjectClaim({
      definition,
      productKey: "prod",
      input,
      runId: "0000000000002-cafe",
    })!;
    await assert.rejects(
      withPreparedClaim(competitor, "refuse", async () => {
        throw new Error("must not create");
      }),
      (error: unknown) => (error as { code?: string }).code === "claim_conflict",
    );
    assert.equal((await loadClaim(claim.id))?.status, "held");
    assert.equal((await loadClaim(claim.id))?.runId, runId);
  });
});

test("review contract B7: simultaneous allocators produce one run and one structured refusal", async () => {
  await withTempStore(async () => {
    const definition = claimedDefinition("allocator-race");
    const options = {
      definition,
      input: { pr: 123 },
      cwd: "/tmp",
      productKey: "prod",
      origin: { kind: "manual" as const, actor: "test" },
    };
    const outcomes = await Promise.allSettled([
      instantiateRun(options),
      instantiateRun(options),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const refusal = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(refusal && refusal.status === "rejected");
    assert.equal((refusal.reason as { code?: string }).code, "claim_conflict");
    assert.equal((await listRuns()).length, 1);
    const onlyRun = (await listRuns())[0]!;
    assert.equal((await loadClaim(onlyRun.subjectClaimId!))?.status, "held");
  });
});

test("review major B8: persisted blocked-ambiguous spawn cleanup is automatically resolvable", async () => {
  await withTempStore(async (dir) => {
    const run = await createRun({
      definition: {
        formatVersion: 2,
        name: "legacy-ambiguous",
        input: { kind: "informal", description: "x" },
        nodes: [agentNode("work")],
        edges: [],
      },
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
    });
    const retired: string[] = [];
    const deps = sweepDeps({
      spawnAgent: async (request) => ({ name: request.name }),
      retireAgent: async (name) => {
        retired.push(name);
      },
    });
    await sweepCombs(deps, [], new Map());
    await cancelRun(run.id, { reason: "legacy state fixture" });
    await mutateRun(run.id, (record) => {
      const effect = Object.values(record.effects)[0]!;
      effect.status = "ambiguous";
      record.cleanup.status = "blocked-ambiguous";
      record.cleanup.pendingEffectKeys = [effect.key];
    });

    await sweepCombs(deps, [], new Map());
    const resolved = (await loadRun(run.id))!;
    assert.equal(Object.values(resolved.effects)[0]?.status, "failed");
    assert.equal(resolved.cleanup.status, "complete");
    assert.equal(retired.length, 1);
    assert.equal((await listSweepableRuns()).some((candidate) => candidate.id === run.id), false);
  });
});

test("review critical B9: evidence mismatch enters the same terminal cleanup and claim-release path", async () => {
  await withTempStore(async () => {
    const created = await instantiateRun({
      definition: claimedDefinition("mismatch-cleanup"),
      input: { pr: 55 },
      cwd: "/tmp",
      productKey: "prod",
      origin: { kind: "manual", actor: "test" },
    });
    const seals = new Map<string, SealRecord>();
    const retired: string[] = [];
    const deps = sweepDeps({
      spawnAgent: async (request) => {
        seals.set(request.name, {
          beeName: request.name,
          sealedAt: new Date(Date.now() + 1_000).toISOString(),
          status: "done",
          summary: "wrong activation",
          taskId: `${request.taskId}-wrong`,
          attempt: request.attempt,
        });
        return { name: request.name };
      },
      latestSeal: async (name) => {
        const seal = seals.get(name);
        return seal ? { filename: `${name}.json`, seal } : null;
      },
      retireAgent: async (name) => {
        retired.push(name);
      },
    });
    for (let index = 0; index < 3; index += 1) await sweepCombs(deps, [], new Map());

    const terminal = (await loadRun(created.run.id))!;
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.failure?.code, "evidence-mismatch");
    assert.equal(terminal.cleanup.status, "complete");
    assert.equal((await loadClaim(terminal.subjectClaimId!))?.status, "released");
    assert.equal(retired.length, 1);
    assert.equal((await listSweepableRuns()).some((candidate) => candidate.id === terminal.id), false);
  });
});

test("review repro C1: lint rejects every slice-2-only authored shape", () => {
  const base = {
    formatVersion: 2,
    name: "future-shape",
    input: { kind: "informal", description: "x" },
    nodes: [agentNode("work")],
    edges: [],
  };
  const fixtures: Array<{ label: string; definition: unknown }> = [
    {
      label: "subscriptions",
      definition: {
        ...base,
        subscriptions: [{
          nodeId: "work",
          triggerId: "trigger",
          subject: { source: "run-input", pointer: "" },
          eventKinds: ["push"],
          delivery: "queue",
        }],
      },
    },
    {
      label: "human executor",
      definition: {
        ...base,
        nodes: [{
          id: "review",
          executor: "human",
          binding: "strict",
          human: {
            title: "Review",
            packetKind: "web",
            feedbackDestination: { type: "new-agent" },
          },
        }],
      },
    },
    {
      label: "engine action",
      definition: {
        ...base,
        nodes: [{
          id: "land",
          executor: "engine",
          binding: "strict",
          engine: { kind: "action", intent: "land" },
        }],
      },
    },
    {
      label: "child run",
      definition: {
        ...base,
        nodes: [{
          id: "child",
          executor: "engine",
          binding: "strict",
          engine: {
            kind: "child-run",
            comb: { kind: "registry", name: "child", version: 1 },
            input: {},
          },
        }],
      },
    },
    {
      label: "ci status",
      definition: {
        ...base,
        nodes: [{
          id: "gate",
          executor: "engine",
          binding: "strict",
          engine: { kind: "predicate", predicate: { kind: "ci-status", equals: "success" } },
        }],
      },
    },
    {
      label: "waiting edge",
      definition: {
        ...base,
        nodes: [agentNode("work"), agentNode("timeout")],
        edges: [{
          id: "wait",
          from: "work",
          to: "timeout",
          kind: "waiting",
          on: "waiting",
          when: { kind: "clock", afterMs: 1_000, from: "activation-start" },
        }],
      },
    },
    {
      label: "checkout",
      definition: {
        ...base,
        nodes: [{ ...agentNode("work"), checkout: { pool: "review", mode: "exclusive" } }],
      },
    },
    {
      label: "blocking-since clock",
      definition: {
        ...base,
        nodes: [{
          id: "clock",
          executor: "engine",
          binding: "strict",
          engine: {
            kind: "predicate",
            predicate: { kind: "clock", afterMs: 1_000, from: "blocking-since" },
          },
        }],
      },
    },
    {
      label: "flight capacity",
      definition: {
        ...base,
        nodes: [{
          id: "work",
          executor: "agent",
          binding: "strict",
          agent: { capacity: { kind: "flight", flightId: "reviewers" }, brief: "work" },
        }],
      },
    },
  ];
  for (const fixture of fixtures) {
    assert.throws(
      () => lintComb(fixture.definition),
      /not supported in strict-spine slice 1/,
      fixture.label,
    );
  }
});

test("review contract C2: no-subscription runs report intakeReady false but still execute agents", async () => {
  await withTempStore(async (dir) => {
    const run = await createRun({
      definition: {
        formatVersion: 2,
        name: "no-intake",
        input: { kind: "informal", description: "x" },
        nodes: [agentNode("work")],
        edges: [],
      },
      input: null,
      cwd: dir,
      productKey: "test",
      origin: { kind: "manual", actor: "test" },
    });
    assert.equal(run.intakeReady, false);
    let spawns = 0;
    await sweepCombs(sweepDeps({
      spawnAgent: async (request) => {
        spawns += 1;
        return { name: request.name };
      },
    }), [], new Map());
    assert.equal(spawns, 1);
  });
});

test("review contract C3: join-existing honestly refuses without subscription matching", async () => {
  await withTempStore(async () => {
    const definition: CombSpec = {
      ...claimedDefinition("join-refusal"),
      claim: { scope: "product-comb", inputPointer: "/pr", collision: "join-existing" },
    };
    const first = await instantiateRun({
      definition,
      input: { pr: 88 },
      cwd: "/tmp",
      productKey: "prod",
      origin: { kind: "manual", actor: "first" },
    });
    await assert.rejects(
      instantiateRun({
        definition,
        input: { pr: 88 },
        cwd: "/tmp",
        productKey: "prod",
        origin: { kind: "trigger", triggerId: "other", deliveryId: "delivery" },
        collision: "join-existing",
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "claim_conflict");
        assert.equal((error as { details?: { holdingRunId?: string } }).details?.holdingRunId, first.run.id);
        return true;
      },
    );
  });
});

test("review minor C4: claim declarations are structurally validated during lint", () => {
  assert.throws(
    () => lintComb({
      formatVersion: 2,
      name: "bad-claim",
      input: { kind: "informal", description: "x" },
      claim: { scope: "banana", inputPointer: 5, collision: "refuse" },
      nodes: [agentNode("work")],
      edges: [],
    }),
    /\$\.claim/,
  );
});

test("review critical D1: replay recovers a claimless run persisted before its delivery index", async () => {
  await withTempStore(async (dir) => {
    const definition: CombSpec = {
      formatVersion: 2,
      name: "delivery-repair",
      input: { kind: "informal", description: "x" },
      nodes: [agentNode("work")],
      edges: [],
    };
    const origin = {
      kind: "trigger" as const,
      triggerId: "trigger-1",
      deliveryId: "delivery-crash-1",
    };
    const options = {
      definition,
      input: null,
      cwd: dir,
      productKey: "prod",
      origin,
    };
    const requestDigest = deliveryRequestDigest(options);
    const orphaned = await createRun({
      ...options,
      originDeliveryRequestDigest: requestDigest,
    });

    const replay = await instantiateRun(options);
    assert.equal(replay.run.id, orphaned.id);
    assert.equal(replay.replayedDelivery, true);
    assert.equal(replay.created, true);
    assert.equal((await listRuns()).length, 1);
  });
});

test("review critical D2: replay adopts a claimed run instead of returning permanent claim conflict", async () => {
  await withTempStore(async (dir) => {
    const definition = claimedDefinition("claimed-delivery-repair");
    const origin = {
      kind: "trigger" as const,
      triggerId: "trigger-2",
      deliveryId: "delivery-crash-2",
    };
    const options = {
      definition,
      input: { pr: 77 },
      cwd: dir,
      productKey: "prod",
      origin,
    };
    const requestDigest = deliveryRequestDigest(options);
    const runId = "0000000000003-cafe";
    const claim = deriveSubjectClaim({
      definition,
      productKey: options.productKey,
      input: options.input,
      runId,
    })!;
    const orphaned = await withPreparedClaim(claim, "refuse", async (claimId) => {
      const run = await createRun({
        ...options,
        runId,
        subjectClaimId: claimId,
        originDeliveryRequestDigest: requestDigest,
      });
      return { value: run, run };
    });

    const replay = await instantiateRun(options);
    assert.equal(replay.run.id, orphaned.run.id);
    assert.equal(replay.replayedDelivery, true);
    assert.equal((await listRuns()).length, 1);
    assert.equal((await loadClaim(claim.id))?.status, "held");
  });
});

test("review contract E1: transient filesystem errors retain a retryable external-dependency class", () => {
  const error = Object.assign(new Error("temporary storage failure"), { code: "EIO" });
  const classified = asCombError(error);
  assert.equal(classified.code, "external_dependency");
  assert.equal(classified.exitCode, 7);
});

test("review repro E2: an unresolved brief placeholder fails once instead of wedging every sweep", async () => {
  await withTempStore(async (dir) => {
    const created = await createRun({
      definition: {
        formatVersion: 2,
        name: "bad-placeholder",
        input: { kind: "informal", description: "x" },
        nodes: [{
          ...agentNode("work"),
          agent: {
            capacity: { kind: "spawn", bee: "codex" },
            brief: "review {{input.missing}}",
          },
        }],
        edges: [],
      },
      input: {},
      cwd: dir,
      productKey: "prod",
      origin: { kind: "manual", actor: "test" },
    });

    const first = await sweepCombs(sweepDeps(), [], new Map());
    assert.equal(first.some((outcome) => outcome.action === "error"), false);
    const failed = await loadRun(created.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.failure?.code, "invalid-brief");
    assert.equal(failed?.activations["work@1#0"]?.failure?.retryable, false);
    assert.deepEqual(failed?.effects, {});
    assert.equal(failed?.cleanup.status, "complete");

    const second = await sweepCombs(sweepDeps(), [], new Map());
    assert.equal(second.some((outcome) => outcome.action === "error"), false);
    assert.equal((await listSweepableRuns()).some((run) => run.id === created.id), false);
  });
});

test("review major E3: output-equals resolves false when its producer is terminal without output", async () => {
  await withTempStore(async (dir) => {
    const run = await createRun({
      definition: {
        formatVersion: 2,
        name: "terminal-output-predicate",
        input: { kind: "informal", description: "x" },
        nodes: [
          {
            ...agentNode("source"),
            output: { kind: "json-schema", schema: { type: "object" } },
          },
        ],
        edges: [],
      },
      input: null,
      cwd: dir,
      productKey: "prod",
      origin: { kind: "manual", actor: "test" },
    });
    const source = run.activations["source@1#0"]!;
    source.status = "failed";
    source.endedAt = "2026-07-28T12:00:01.000Z";
    assert.deepEqual(
      evaluatePredicate(
        run,
        { kind: "output-equals", nodeId: "source", path: "/verdict", equals: "pass" },
        { itemIndex: 0, now: "2026-07-28T12:00:02.000Z" },
      ),
      { state: "false", message: "source completed without schema-validated output" },
    );
  });
});

test("review minor E4: deterministic bee names distinguish runs with the same visible suffix", async () => {
  await withTempStore(async (dir) => {
    const run = await createRun({
      definition: {
        formatVersion: 2,
        name: "bee-name-entropy",
        input: { kind: "informal", description: "x" },
        nodes: [agentNode("work")],
        edges: [],
      },
      input: null,
      cwd: dir,
      productKey: "prod",
      origin: { kind: "manual", actor: "test" },
    });
    const activation = run.activations["work@1#0"]!;
    assert.notEqual(
      deterministicAgentName("0000000000001-abcde", activation),
      deterministicAgentName("9999999999999-abcde", activation),
    );
  });
});

test("review minor E5: board views expose the run's recorded violation count", async () => {
  await withTempStore(async (dir) => {
    const run = await createRun({
      definition: {
        formatVersion: 2,
        name: "violation-count",
        input: { kind: "informal", description: "x" },
        nodes: [agentNode("work")],
        edges: [],
      },
      input: null,
      cwd: dir,
      productKey: "prod",
      origin: { kind: "manual", actor: "test" },
    });
    recordRunEvent(run, "comb.violation", run.activations["work@1#0"]!.address, { code: "first" });
    recordRunEvent(run, "comb.violation", run.activations["work@1#0"]!.address, { code: "second" });
    assert.equal(boardView(run).violationCount, 2);
  });
});
