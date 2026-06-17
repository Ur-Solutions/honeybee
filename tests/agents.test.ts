import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentDefaultsToYolo, resolveAgent, spawnBeeForFlow, splitShellWords } from "../src/agents.js";
import { assertExecutableAvailable } from "../src/execCheck.js";

test("grok supports numbered profile aliases and GROK_HOME isolation", () => {
  const oldHive = process.env.HIVE_GROK_CMD;
  const oldLegacy = process.env.AP_GROK_CMD;
  delete process.env.HIVE_GROK_CMD;
  delete process.env.AP_GROK_CMD;

  try {
    // grok2 canonicalizes to the grok driver, bound to the ~/.grok-2 home slot.
    const spec = resolveAgent("grok2");
    assert.equal(spec.kind, "grok");
    assert.equal(spec.requestedKind, "grok2");
    assert.equal(spec.command, "grok");
    assert.equal(spec.env.GROK_HOME, join(homedir(), ".grok-2"));
    assert.equal(spec.homePath, join(homedir(), ".grok-2"));

    // The base kind with an explicit home slot gets the same GROK_HOME env.
    const baseGrokWithProfileHome = resolveAgent("grok", [], { home: "2" });
    assert.equal(baseGrokWithProfileHome.kind, "grok");
    assert.equal(baseGrokWithProfileHome.env.GROK_HOME, join(homedir(), ".grok-2"));
  } finally {
    if (oldHive === undefined) delete process.env.HIVE_GROK_CMD;
    else process.env.HIVE_GROK_CMD = oldHive;
    if (oldLegacy === undefined) delete process.env.AP_GROK_CMD;
    else process.env.AP_GROK_CMD = oldLegacy;
  }
});

test("kimi resolves to the kimi-code CLI with its own home env and yolo flag", () => {
  // Numbered slots follow the generic ~/.<kind>-<n> convention; the default
  // (unslotted) `kimi` bee uses the CLI's own ~/.kimi-code via no home override.
  const spec = resolveAgent("kimi", [], { home: "1" });
  assert.equal(spec.kind, "kimi");
  assert.equal(spec.command, "kimi");
  assert.equal(spec.env.KIMI_CODE_HOME, join(homedir(), ".kimi-1"));

  const yolo = resolveAgent("kimi", [], { yolo: true });
  assert.deepEqual(yolo.args, ["--yolo"]);
});

test("agent defaults are safe unless yolo mode is explicit", () => {
  const oldHive = process.env.HIVE_CLAUDE_CMD;
  const oldYolo = process.env.HIVE_CLAUDE_YOLO;
  const oldGlobalYolo = process.env.HIVE_YOLO;
  delete process.env.HIVE_CLAUDE_CMD;
  delete process.env.HIVE_CLAUDE_YOLO;
  delete process.env.HIVE_YOLO;

  try {
    assert.deepEqual(resolveAgent("claude").args, []);
    assert.deepEqual(resolveAgent("claude", [], { yolo: true }).args, ["--dangerously-skip-permissions"]);
  } finally {
    if (oldHive === undefined) delete process.env.HIVE_CLAUDE_CMD;
    else process.env.HIVE_CLAUDE_CMD = oldHive;
    if (oldYolo === undefined) delete process.env.HIVE_CLAUDE_YOLO;
    else process.env.HIVE_CLAUDE_YOLO = oldYolo;
    if (oldGlobalYolo === undefined) delete process.env.HIVE_YOLO;
    else process.env.HIVE_YOLO = oldGlobalYolo;
  }
});

test("claude (and its aliases) default to yolo; other bees do not", () => {
  assert.equal(agentDefaultsToYolo("claude"), true);
  assert.equal(agentDefaultsToYolo("cc3"), true);
  assert.equal(agentDefaultsToYolo("claude2"), true);
  assert.equal(agentDefaultsToYolo("codex"), false);
  assert.equal(agentDefaultsToYolo("codex2"), false);
  assert.equal(agentDefaultsToYolo("grok"), false);
});

test("an explicit yolo decision is authoritative over env signals", () => {
  const oldYolo = process.env.HIVE_CLAUDE_YOLO;
  const oldCmd = process.env.HIVE_CLAUDE_CMD;
  delete process.env.HIVE_CLAUDE_CMD;
  process.env.HIVE_CLAUDE_YOLO = "1";
  try {
    // env asks for yolo, but an explicit yolo:false (e.g. --no-yolo) wins.
    assert.deepEqual(resolveAgent("claude", [], { yolo: false }).args, []);
    // explicit yolo:true yields the permissionless command.
    assert.deepEqual(resolveAgent("claude", [], { yolo: true }).args, ["--dangerously-skip-permissions"]);
  } finally {
    if (oldYolo === undefined) delete process.env.HIVE_CLAUDE_YOLO;
    else process.env.HIVE_CLAUDE_YOLO = oldYolo;
    if (oldCmd === undefined) delete process.env.HIVE_CLAUDE_CMD;
    else process.env.HIVE_CLAUDE_CMD = oldCmd;
  }
});

test("env command overrides are parsed as argv and expand tilde words", () => {
  const oldHive = process.env.HIVE_CLAUDE_CMD;
  process.env.HIVE_CLAUDE_CMD = "python3 ~/bin/claude-wrapper.py --label 'two words'";

  try {
    const spec = resolveAgent("claude");
    assert.equal(spec.command, "python3");
    assert.deepEqual(spec.args, [join(homedir(), "bin/claude-wrapper.py"), "--label", "two words"]);
  } finally {
    if (oldHive === undefined) delete process.env.HIVE_CLAUDE_CMD;
    else process.env.HIVE_CLAUDE_CMD = oldHive;
  }
});

test("splitShellWords does not treat shell metacharacters as syntax", () => {
  assert.deepEqual(splitShellWords("claude; curl https://example.test/$(whoami)"), ["claude;", "curl", "https://example.test/$(whoami)"]);
});

// ──────────────────────────────────────────────────────────────────────────
// S2 — model selector args (account-first spawn)
// ──────────────────────────────────────────────────────────────────────────

test("resolveAgent: opencode embeds the qualified --model <provider>/<model> selector", () => {
  const spec = resolveAgent("opencode", [], { model: "MiniMax-M3", provider: "minimax-coding-plan" });
  assert.equal(spec.command, "opencode");
  assert.deepEqual(spec.args, ["run", "--interactive", "--model", "minimax-coding-plan/MiniMax-M3"]);
});

test("resolveAgent: opencode with a model but no provider emits no selector (no `--model undefined/...`)", () => {
  // A provider-less opencode account (e.g. un-migrated) must not produce a
  // malformed `--model undefined/<model>`; it falls back to opencode's default.
  const spec = resolveAgent("opencode", [], { model: "MiniMax-M3" });
  assert.deepEqual(spec.args, ["run", "--interactive"]);
  assert.ok(!spec.args.includes("--model"));
});

test("resolveAgent: claude embeds a bare --model selector", () => {
  const spec = resolveAgent("claude", [], { model: "opus" });
  assert.equal(spec.command, "claude");
  assert.deepEqual(spec.args, ["--model", "opus"]);
});

test("resolveAgent: no model means no model args (byte-identical to today)", () => {
  // Snapshot equality: omitting model/provider must reproduce the pre-S2 args.
  assert.deepEqual(resolveAgent("opencode").args, ["run", "--interactive"]);
  assert.deepEqual(resolveAgent("claude").args, []);
  assert.deepEqual(resolveAgent("codex").args, []);
});

test("resolveAgent: model args precede user extraArgs so `-- …` still overrides", () => {
  const spec = resolveAgent("claude", ["--foo"], { model: "opus" });
  assert.deepEqual(spec.args, ["--model", "opus", "--foo"]);
});

test("resolveAgent: a config/env command override suppresses modelArgs (no double --model, fix #5)", () => {
  const oldCmd = process.env.HIVE_CLAUDE_CMD;
  // A command that already embeds --model must NOT get a second one appended.
  process.env.HIVE_CLAUDE_CMD = "claude --model sonnet";
  try {
    const spec = resolveAgent("claude", [], { model: "opus" });
    assert.equal(spec.command, "claude");
    assert.deepEqual(spec.args, ["--model", "sonnet"]);
  } finally {
    if (oldCmd === undefined) delete process.env.HIVE_CLAUDE_CMD;
    else process.env.HIVE_CLAUDE_CMD = oldCmd;
  }
});

test("resolveAgent: drivers without a modelArgs hook (grok) ignore model — no model args", () => {
  const spec = resolveAgent("grok", [], { model: "grok-4", provider: "xai" });
  // grok's command is unchanged; no --model is appended (hook is undefined).
  assert.ok(!spec.args.includes("--model"));
});

test("assertExecutableAvailable accepts a real executable and rejects a missing one", async () => {
  await assertExecutableAvailable(process.execPath);
  await assert.rejects(assertExecutableAvailable("hive-test-no-such-binary-xyz"), /Executable not found on PATH/);
});

test("spawnBeeForFlow refuses a local spawn when the agent executable is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-agents-spawn-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    // Without the availability check this would create a tmux session that
    // dies instantly while leaving a "running" record behind.
    await assert.rejects(
      spawnBeeForFlow({ agent: "hive-test-no-such-binary-xyz", extraArgs: [], cwd: "/tmp", yolo: false }),
      /Executable not found on PATH: hive-test-no-such-binary-xyz/,
    );
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
