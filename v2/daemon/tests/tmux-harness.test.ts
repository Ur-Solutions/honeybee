/**
 * Tmux TUI spawn shape — grok types, claude/codex paste; observation homes
 * honour GROK_HOME / CLAUDE_CONFIG_DIR / CODEX_HOME; HSR plumbing stays off argv.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { BUILTIN_AGENTS } from "../src/config.ts";
import { tmuxArgsFor, tmuxDeliveryMode, tmuxObservationFor, tmuxSpawnSpec } from "../src/tmuxHarness.ts";

test("tmux.grok: type delivery, GROK_HOME locator, permission default, HSR plumbing off", () => {
  assert.equal(tmuxDeliveryMode("grok"), "type");
  assert.deepEqual(tmuxArgsFor("grok", ["--model", "grok-4.6", "--effort", "high"]), [
    "--permission-mode", "bypassPermissions", "--model", "grok-4.6", "--effort", "high",
  ]);
  assert.deepEqual(tmuxArgsFor("grok", ["--permission-mode", "default"]), ["--permission-mode", "default"]);
  const spec = tmuxSpawnSpec(BUILTIN_AGENTS.grok!, {
    agent: "grok",
    cwd: "/tmp/work",
    args: ["--model", "grok-4.6"],
    env: { GROK_HOME: "/homes/grok-x" },
  });
  assert.equal(spec.command, "grok");
  assert.equal(spec.deliveryMode, "type");
  assert.ok(!spec.args.includes("stdio"));
  assert.ok(!spec.args.includes("agent"));
  const loc = tmuxObservationFor({ agent: "grok", cwd: "/tmp/work", args: null, env: { GROK_HOME: "/homes/grok-x" } });
  assert.equal(loc.transcript?.parser, "grok");
  assert.ok(String(loc.transcript?.locator.dir).startsWith(join("/homes/grok-x", "sessions")));
});

test("tmux.claude/codex: paste delivery; skip-permissions default; homes from env", () => {
  assert.equal(tmuxDeliveryMode("claude"), "paste");
  assert.equal(tmuxDeliveryMode("codex"), "paste");
  assert.deepEqual(tmuxArgsFor("claude", ["--model", "fable"]), ["--dangerously-skip-permissions", "--model", "fable"]);
  assert.deepEqual(tmuxArgsFor("codex", ["-m", "gpt-5.6-sol"]), ["-m", "gpt-5.6-sol"]);
  const claude = tmuxObservationFor({
    agent: "claude", cwd: "/tmp/c", args: null, env: { CLAUDE_CONFIG_DIR: "/homes/claude-x" },
  });
  assert.equal(claude.transcript?.parser, "claude");
  assert.match(claude.transcript?.locator.dir ?? "", /\/homes\/claude-x\/projects\//);
  const codex = tmuxObservationFor({
    agent: "codex", cwd: "/tmp/x", args: null, env: { CODEX_HOME: "/homes/codex-x" },
  });
  assert.equal(codex.transcript?.parser, "codex");
  assert.equal(codex.transcript?.locator.dir, join("/homes/codex-x", "sessions"));
});

test("tmux.agy: paste delivery, hooks lifecycle, HOME-scoped sqlite mirror, unattended default, HSR plumbing off", () => {
  assert.equal(tmuxDeliveryMode("agy"), "paste");
  assert.deepEqual(tmuxArgsFor("agy", ["--model", "gemini-3.8-flash", "--effort", "high"]), [
    "--dangerously-skip-permissions", "--model", "gemini-3.8-flash", "--effort", "high",
  ]);
  assert.deepEqual(tmuxArgsFor("agy", ["--dangerously-skip-permissions"]), ["--dangerously-skip-permissions"]);
  const spec = tmuxSpawnSpec(BUILTIN_AGENTS.agy!, {
    agent: "agy",
    cwd: "/Users/trmd/work/agy-project",
    args: ["--model", "gemini-3.8-flash"],
    env: { HOME: "/homes/agy-x", SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 1" },
  });
  assert.equal(spec.command, "agy");
  assert.equal(spec.deliveryMode, "paste");
  assert.ok(!spec.args.includes("--print="));
  assert.ok(!spec.args.includes("--input-format"));
  assert.ok(!spec.args.includes("--output-format"));
  assert.equal(spec.observation.hooks?.kind, "agy");
  assert.equal(spec.observation.explicitTurnEnd, true);
  assert.equal(spec.observation.transcript, undefined);
  const mirror = spec.observation.transcriptMirror;
  assert.equal(mirror?.locator.dir, join("/homes/agy-x", ".gemini", "antigravity-cli", "conversations"));
  assert.equal(String(mirror?.locator.match), String(/\.db$/));
  assert.equal(mirror?.locator.format, "agy-sqlite");
  assert.ok(mirror?.locator.containsAny?.includes("/Users/trmd/work/agy-project"));
  assert.ok(mirror?.locator.containsAny?.includes("file:///Users/trmd/work/agy-project"));
});
