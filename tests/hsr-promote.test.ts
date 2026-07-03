/**
 * APIA-84 promote/demote — pure-piece unit tests.
 *
 * Covers the parts that don't need a tmux server or a live harness:
 *   - resume-arg construction per harness (the interactive promote path reuses
 *     src/swap.ts `resumeArgs`);
 *   - the claude adapter's RESUME behavior in buildClaudeStreamConfig (the demote
 *     headless path): `--resume <id>` is emitted and any `--session-id <id>` pair
 *     is stripped, so a resumed headless run rejoins the SAME provider session
 *     instead of trying to start a fresh one;
 *   - payload threading (RunnerOpts.resume + sessionId → the adapter turns it
 *     into `--resume`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClaudeStreamConfig } from "../src/hsr/adapters/claude.js";
import { codexAdapter } from "../src/hsr/adapters/codex.js";
import { resumeArgs } from "../src/swap.js";
import { assertResumable, tmuxSessionSurvives } from "../src/cli.js";
import type { RunnerOpts } from "../src/hsr/types.js";
import type { SessionRecord } from "../src/store.js";

function recordFor(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "b", agent: "codex", cwd: "/tmp", command: "codex", tmuxTarget: "b",
    createdAt: "", updatedAt: "", status: "running", providerSessionId: "sess-1", ...over,
  } as SessionRecord;
}

// --- promote/demote resume gating (claude is de-gated: disjoint session stores)
test("assertResumable: claude is rejected with the store-separation reason", () => {
  assert.throws(() => assertResumable(recordFor({ agent: "claude" }), "promote"), /does not support claude/);
});

test("assertResumable: codex with a provider session id is accepted", () => {
  assert.equal(assertResumable(recordFor({ agent: "codex" }), "promote"), "codex");
});

test("assertResumable: a non-resume-gated harness is rejected", () => {
  assert.throws(() => assertResumable(recordFor({ agent: "opencode" }), "demote"), /only codex/);
});

/** A minimal RunnerOpts; individual tests override command/args/resume/etc. */
function optsFor(over: Partial<RunnerOpts> = {}): RunnerOpts {
  return { bee: "test", cwd: "/tmp", env: {}, runDir: "/tmp/run", ...over };
}

// --- resume-arg construction (interactive promote path) ----------------------

test("resumeArgs: claude resume uses --resume <id>", () => {
  assert.deepEqual(resumeArgs("claude", "abc-123"), ["--resume", "abc-123"]);
});

test("resumeArgs: codex resume is the `resume <id>` subcommand", () => {
  assert.deepEqual(resumeArgs("codex", "thread-9"), ["resume", "thread-9"]);
});

test("resumeArgs: missing session id falls back to the continue/last form", () => {
  assert.deepEqual(resumeArgs("claude", undefined), ["--continue"]);
  assert.deepEqual(resumeArgs("codex", undefined), ["resume", "--last"]);
});

// --- claude adapter RESUME (demote headless path) ----------------------------

test("buildClaudeStreamConfig: resume emits --resume and strips --session-id", () => {
  const { config } = buildClaudeStreamConfig(
    optsFor({
      resume: true,
      sessionId: "sess-xyz",
      // A fresh spawn's forced session-id pinning that a resume must NOT carry.
      args: ["--session-id", "sess-xyz", "--model", "haiku", "--dangerously-skip-permissions"],
    }),
  );
  assert.ok(config.args.includes("--resume"), "must carry --resume on a resume");
  const idx = config.args.indexOf("--resume");
  assert.equal(config.args[idx + 1], "sess-xyz", "--resume must be followed by the session id");
  assert.ok(!config.args.includes("--session-id"), "the --session-id flag must be stripped on a resume");
  // The value must not linger orphaned either: it appears exactly once (after --resume).
  assert.equal(config.args.filter((a) => a === "sess-xyz").length, 1);
  // Unrelated caller flags are preserved.
  assert.ok(config.args.includes("--model") && config.args.includes("haiku"));
  assert.ok(config.args.includes("--dangerously-skip-permissions"));
});

test("buildClaudeStreamConfig: resume is idempotent when the caller already has --resume", () => {
  const { config } = buildClaudeStreamConfig(
    optsFor({ resume: true, sessionId: "sess-xyz", args: ["--resume", "sess-xyz", "--model", "haiku"] }),
  );
  assert.equal(config.args.filter((a) => a === "--resume").length, 1, "--resume must not be duplicated");
});

test("buildClaudeStreamConfig: a FRESH spawn keeps --session-id and never adds --resume", () => {
  const { config } = buildClaudeStreamConfig(
    optsFor({ sessionId: "sess-xyz", args: ["--session-id", "sess-xyz", "--model", "haiku"] }),
  );
  assert.ok(config.args.includes("--session-id"), "fresh spawn keeps --session-id");
  assert.ok(!config.args.includes("--resume"), "fresh spawn must not carry --resume");
});

test("buildClaudeStreamConfig: resume without a sessionId is a no-op (no --resume, no strip)", () => {
  const { config } = buildClaudeStreamConfig(optsFor({ resume: true, args: ["--session-id", "keep", "--model", "haiku"] }));
  assert.ok(!config.args.includes("--resume"), "no session id → cannot resume");
  assert.ok(config.args.includes("--session-id"), "without a session id nothing is stripped");
});

// --- promote liveness gate (the relaunch-safety net) -------------------------
// The e2e proved claude keeps its interactive-TUI and headless-`-p` session
// stores DISJOINT: promote's interactive `--resume <id>` cannot find an HSR
// (`-p`) session, so the relaunched pane exits at once and the tmux window
// collapses. Without a liveness gate promote would flip the record and report
// success on a DEAD, unrecoverable bee. tmuxSessionSurvives is that gate.

test("tmuxSessionSurvives: a session that vanishes mid-window is a failed relaunch", async () => {
  let calls = 0;
  // Alive on the first poll, gone on the second — the agent exited immediately.
  const substrate = { hasSession: async () => ++calls < 2 };
  assert.equal(await tmuxSessionSurvives(substrate, "CL-x", 500, 10), false);
});

test("tmuxSessionSurvives: a session that never comes up fails fast", async () => {
  const substrate = { hasSession: async () => false };
  assert.equal(await tmuxSessionSurvives(substrate, "CL-x", 500, 10), false);
});

test("tmuxSessionSurvives: a session that stays up the whole window is healthy", async () => {
  const substrate = { hasSession: async () => true };
  assert.equal(await tmuxSessionSurvives(substrate, "CL-x", 40, 10), true);
});

test("tmuxSessionSurvives: a throwing hasSession is treated as gone (not a hang)", async () => {
  const substrate = { hasSession: async () => { throw new Error("tmux down"); } };
  assert.equal(await tmuxSessionSurvives(substrate, "CL-x", 500, 10), false);
});

// --- codex adapter shape (resume branch verified live in hsr-codex-live) ------

test("codexAdapter: is a server-tier adapter (thread/resume path lives in start)", () => {
  // The resume branch (thread/resume({threadId})) needs a live app-server, so it
  // is exercised by the codex-live e2e; here we just pin the adapter contract.
  assert.equal(codexAdapter.harness, "codex");
  assert.equal(codexAdapter.tier(), "server");
});
