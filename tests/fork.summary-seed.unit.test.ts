// Pure unit tests for the `--seed summary` handoff mode (session-fork-and-
// handoff epic): seal-as-summary requirement, handoff brief composition with
// and without an instruction, and the mode staying OUT of the default ladder.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickForkSeed, type ForkSeedInput } from "../src/fork.js";
import type { SealRecord } from "../src/seal.js";
import type { SessionRecord } from "../src/store.js";

function source(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "CL.src",
    agent: "claude",
    cwd: "/tmp/work",
    command: "claude",
    tmuxTarget: "CL-src",
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    status: "running",
    id: "CL.src",
    ...overrides,
  };
}

function seal(overrides: Partial<SealRecord> = {}): SealRecord {
  return {
    beeName: "CL.src",
    sealedAt: "2026-07-24T11:00:00.000Z",
    status: "done",
    summary: "Implemented the parser and half the tests",
    filesChanged: ["a.ts"],
    risks: ["flaky suite"],
    nextActions: ["finish tests"],
    ...overrides,
  };
}

function input(overrides: Partial<ForkSeedInput> = {}): ForkSeedInput {
  return {
    source: source(),
    seal: null,
    readLog: false,
    targetTool: "claude",
    sourceTool: "claude",
    forkName: "CL.src",
    ...overrides,
  };
}

test("--seed summary with a seal yields a handoff brief carrying summary, risks, and instruction", () => {
  const decision = pickForkSeed(input({ seal: seal(), requestedSeed: "summary", handoffInstruction: "focus on the edge cases" }));
  assert.equal(decision.mode, "summary");
  if (decision.mode !== "summary") return;
  assert.match(decision.brief, /taking over from CL\.src via handoff/);
  assert.match(decision.brief, /Implemented the parser/);
  assert.match(decision.brief, /flaky suite/);
  assert.match(decision.brief, /Your instruction: focus on the edge cases/);
  assert.equal(decision.checkpoint, "summary:2026-07-24T11:00:00.000Z");
});

test("--seed summary with no instruction is a pure compaction restart", () => {
  const decision = pickForkSeed(input({ seal: seal(), requestedSeed: "summary" }));
  assert.equal(decision.mode, "summary");
  if (decision.mode !== "summary") return;
  assert.match(decision.brief, /Continue the work from this summary\./);
  assert.doesNotMatch(decision.brief, /Your instruction/);
});

test("--seed summary without a seal refuses with guidance", () => {
  const decision = pickForkSeed(input({ requestedSeed: "summary" }));
  assert.equal(decision.mode, "refuse");
  if (decision.mode !== "refuse") return;
  assert.match(decision.reason, /hive handoff/);
});

test("summary never enters the default ladder: a bare fork with a seal still seeds seal-style", () => {
  const decision = pickForkSeed(input({ seal: seal() }));
  assert.equal(decision.mode, "seal");
});
