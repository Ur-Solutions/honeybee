// Pure unit tests for the fork seed-mode picker (no tmux, no store, no I/O).
// Exercises the §7.1 ladder: resume vs seal vs log vs none vs refuse, plus the
// cross-harness forcing-non-resume policy that must never regress.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickForkSeed, type ForkSeedInput } from "../src/fork.js";
import type { SessionRecord } from "../src/store.js";
import type { SealRecord } from "../src/seal.js";

function source(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "CL.src",
    agent: "claude",
    cwd: "/tmp/work",
    command: "claude",
    tmuxTarget: "CL-src",
    createdAt: "2026-06-16T10:00:00.000Z",
    updatedAt: "2026-06-16T10:00:00.000Z",
    status: "running",
    id: "CL.src",
    ...overrides,
  };
}

function seal(overrides: Partial<SealRecord> = {}): SealRecord {
  return {
    beeName: "CL.src",
    sealedAt: "2026-06-16T09:30:00.000Z",
    status: "done",
    summary: "Implemented the parser",
    filesChanged: ["a.ts", "b.ts"],
    nextActions: ["run tests", "ship"],
    ...overrides,
  };
}

function input(overrides: Partial<ForkSeedInput> = {}): ForkSeedInput {
  return {
    source: source(),
    seal: null,
    requestedSeed: undefined,
    readLog: false,
    targetTool: "claude",
    sourceTool: "claude",
    forkName: "CL.src",
    ...overrides,
  };
}

test("resume: same tool + providerSessionId + default seed → native resume args", () => {
  const decision = pickForkSeed(input({ source: source({ providerSessionId: "abc" }) }));
  assert.equal(decision.mode, "resume");
  if (decision.mode !== "resume") return;
  assert.deepEqual(decision.resumeArgs, ["--resume", "abc"]);
  assert.equal(decision.checkpoint, "resume:abc");
});

test("cross-harness downgrade: claude→codex with a seal and default seed → seal (never resume)", () => {
  const decision = pickForkSeed(
    input({
      source: source({ providerSessionId: "abc" }),
      seal: seal(),
      targetTool: "codex",
      sourceTool: "claude",
    }),
  );
  assert.equal(decision.mode, "seal");
});

test("cross-harness + explicit --seed resume → refuse mentioning same-harness", () => {
  const decision = pickForkSeed(
    input({
      source: source({ providerSessionId: "abc" }),
      seal: seal(),
      requestedSeed: "resume",
      targetTool: "codex",
      sourceTool: "claude",
    }),
  );
  assert.equal(decision.mode, "refuse");
  if (decision.mode !== "refuse") return;
  assert.match(decision.reason, /same-harness/);
});

test("seal: same tool, no providerSessionId, seal present → seal brief + checkpoint", () => {
  const decision = pickForkSeed(input({ seal: seal() }));
  assert.equal(decision.mode, "seal");
  if (decision.mode !== "seal") return;
  assert.match(decision.brief, /Implemented the parser/);
  assert.match(decision.brief, /a\.ts, b\.ts/);
  assert.equal(decision.checkpoint, "seal:2026-06-16T09:30:00.000Z");
});

test("log fallthrough: no providerSessionId, no seal, transcriptPath set → log brief", () => {
  const decision = pickForkSeed(input({ source: source({ transcriptPath: "/tmp/t.jsonl" }) }));
  assert.equal(decision.mode, "log");
  if (decision.mode !== "log") return;
  assert.match(decision.brief, /\/tmp\/t\.jsonl/);
  assert.equal(decision.checkpoint, "log:/tmp/t.jsonl");
});

test("--read-log override: even with a resumable session, readLog → log", () => {
  const decision = pickForkSeed(
    input({ source: source({ providerSessionId: "abc", transcriptPath: "/tmp/t.jsonl" }), readLog: true }),
  );
  assert.equal(decision.mode, "log");
});

test("--read-log with no transcript → refuse", () => {
  const decision = pickForkSeed(input({ readLog: true }));
  assert.equal(decision.mode, "refuse");
  if (decision.mode !== "refuse") return;
  assert.match(decision.reason, /transcriptPath/);
});

test("refuse: no session, no seal, no transcriptPath", () => {
  const decision = pickForkSeed(input());
  assert.equal(decision.mode, "refuse");
});

test("none: --seed none → boot cold", () => {
  const decision = pickForkSeed(input({ requestedSeed: "none", source: source({ providerSessionId: "abc" }) }));
  assert.equal(decision.mode, "none");
  if (decision.mode !== "none") return;
  assert.equal(decision.checkpoint, "none");
});

test("--seed seal with no seal → refuse", () => {
  const decision = pickForkSeed(input({ requestedSeed: "seal" }));
  assert.equal(decision.mode, "refuse");
  if (decision.mode !== "refuse") return;
  assert.match(decision.reason, /no seal/);
});

test("--seed log behaves like read-log", () => {
  const decision = pickForkSeed(input({ requestedSeed: "log", source: source({ transcriptPath: "/tmp/t.jsonl" }) }));
  assert.equal(decision.mode, "log");
});
