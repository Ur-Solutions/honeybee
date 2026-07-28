import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applySealCompletion, activateAgent, reconcileMachine } from "../src/comb/machine.js";
import { createRun } from "../src/comb/store.js";
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
