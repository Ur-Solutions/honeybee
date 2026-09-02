/**
 * Argv composition (per-bee spawn args, schema v5) — the precedence rule in
 * adapters/args.ts: base < default < bee < resume; later valued flag wins,
 * boolean flags idempotent, keyed `-c key=value` per key, aliases fold,
 * unknown tokens/positionals verbatim in place; the codex spawn plan lifts
 * model + approval flags off argv into the thread request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { agyArgGrammar, claudeArgGrammar, codexArgGrammar, grokArgGrammar, grokSpawnPlan, composeArgv, parseArgUnits, codexSpawnPlan } from "../src/index.ts";

const CLAUDE_BASE = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];

test("args.compose.1: claude — base < default < bee < resume; later --model wins, boolean idempotent, resume last", () => {
  const argv = composeArgv(claudeArgGrammar, [
    CLAUDE_BASE,
    ["--model", "opus", "--dangerously-skip-permissions"],
    ["--dangerously-skip-permissions", "--model", "fable", "--effort", "high"],
    ["--resume", "sid-1"],
  ]);
  assert.deepEqual(argv, [...CLAUDE_BASE, "--dangerously-skip-permissions", "--model", "fable", "--effort", "high", "--resume", "sid-1"]);
});

test("args.compose.2: empty/null layers, --flag=value spelling, -r alias, repeated within one layer, no bee args", () => {
  assert.deepEqual(composeArgv(claudeArgGrammar, [CLAUDE_BASE, undefined, null, []]), CLAUDE_BASE);
  assert.deepEqual(composeArgv(claudeArgGrammar, [["--model=opus"], ["--model", "fable"]]), ["--model", "fable"]);
  assert.deepEqual(composeArgv(claudeArgGrammar, [["--model", "opus"], ["--model=fable"]]), ["--model=fable"], "surviving token keeps its spelling");
  assert.deepEqual(composeArgv(claudeArgGrammar, [["-r", "old"], ["--resume", "new"]]), ["--resume", "new"], "-r and --resume are one flag");
  assert.deepEqual(composeArgv(claudeArgGrammar, [["--effort", "low", "--effort", "high", "--verbose", "--verbose"]]), ["--effort", "high", "--verbose"]);
  // a later base-layer flag can be overridden by the bee even when the base put it first
  assert.deepEqual(composeArgv(claudeArgGrammar, [["--output-format", "text"], ["--output-format", "stream-json"]]), ["--output-format", "stream-json"]);
});

test("args.compose.3: unknown flags and positionals pass through verbatim in place — never de-duplicated or re-ordered", () => {
  const argv = composeArgv(claudeArgGrammar, [
    ["/path/to/fake-claude.mjs", "-p", "--weird", "x", "--weird", "y"],
    ["--model", "fable", "--weird", "z"],
  ]);
  assert.deepEqual(argv, ["/path/to/fake-claude.mjs", "-p", "--weird", "x", "--weird", "y", "--model", "fable", "--weird", "z"]);
  // dangling valued flag at the end of a layer is left as-is (the harness will complain)
  assert.deepEqual(composeArgv(claudeArgGrammar, [["--model"], ["--effort", "high"]]), ["--model", "--effort", "high"]);
});

test("args.compose.4: codex — -m/--model alias, -c keyed per key (later wins per key, different keys coexist), --config spellings", () => {
  const argv = composeArgv(codexArgGrammar, [
    ["app-server", "-c", "service_tier=default"],
    ["--model", "gpt-5.5", "-c", 'model_reasoning_effort="high"'],
    ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="ultra"', "--config", "features.fast_mode=false", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-approvals-and-sandbox"],
  ]);
  assert.deepEqual(argv, [
    "app-server",
    "-c", "service_tier=default",
    "-m", "gpt-5.6-sol",
    "-c", 'model_reasoning_effort="ultra"',
    "--config", "features.fast_mode=false",
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  const units = parseArgUnits(codexArgGrammar, ["-c=x=1", "--config=x=2"]);
  assert.deepEqual(units.map((u) => u.identity), ["--config:x", "--config:x"]);
});

test("args.compose.5: codexSpawnPlan lifts --model + approval/sandbox flags into the thread request; -c overrides and positionals stay on argv", () => {
  const plan = codexSpawnPlan(["app-server", "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="ultra"', "--full-auto", "-a", "never", "-s", "workspace-write"]);
  assert.deepEqual(plan.argv, ["app-server", "-c", 'model_reasoning_effort="ultra"']);
  assert.equal(plan.model, "gpt-5.6-sol");
  assert.deepEqual(plan.absorbed, ["--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.6-sol", "--full-auto", "-a", "never", "-s", "workspace-write"]);
  const none = codexSpawnPlan(["app-server"]);
  assert.deepEqual(none, { argv: ["app-server"], model: undefined, absorbed: [] });
  assert.equal(codexSpawnPlan(["-m", "x", "--model=y"]).model, "y", "last model wins (already composed input)");
});

test("args.compose.6: grokSpawnPlan lifts --model/--effort in front of stdio", () => {
  const composed = composeArgv(grokArgGrammar, [
    ["--no-auto-update", "agent", "--no-leader", "--always-approve", "stdio"],
    ["--model", "grok-4.6", "--effort", "high"],
  ]);
  assert.deepEqual(composed, ["--no-auto-update", "agent", "--no-leader", "--always-approve", "stdio", "--model", "grok-4.6", "--effort", "high"]);
  const plan = grokSpawnPlan(composed);
  assert.deepEqual(plan.argv, ["--no-auto-update", "agent", "--no-leader", "--always-approve", "--model", "grok-4.6", "--effort", "high", "stdio"]);
  assert.equal(plan.model, "grok-4.6");
});

test("args.compose.7: agy valued flags use later-wins composition and permission bypass is idempotent", () => {
  const valueFlags = [
    "--model",
    "--effort",
    "--conversation",
    "--print-timeout",
    "--agent",
    "--project",
    "--log-file",
    "--add-dir",
    "--mode",
  ];
  assert.deepEqual([...agyArgGrammar.valueFlags], valueFlags);
  const argv = composeArgv(agyArgGrammar, [
    ["--print=", "--dangerously-skip-permissions", "--model", "default", "--print-timeout", "12h"],
    ["--dangerously-skip-permissions", "--model=gemini-3.8-flash-low", "--effort", "high"],
    ["--conversation", "recorded-session"],
  ]);
  assert.deepEqual(argv, [
    "--print=",
    "--dangerously-skip-permissions",
    "--print-timeout", "12h",
    "--model=gemini-3.8-flash-low",
    "--effort", "high",
    "--conversation", "recorded-session",
  ]);
});
