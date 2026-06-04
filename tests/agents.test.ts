import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAgent, splitShellWords } from "../src/agents.js";

test("grok does not use numbered profile aliases", () => {
  const oldHive = process.env.HIVE_GROK_CMD;
  const oldLegacy = process.env.AP_GROK_CMD;
  delete process.env.HIVE_GROK_CMD;
  delete process.env.AP_GROK_CMD;

  try {
    const spec = resolveAgent("grok2");

    assert.equal(spec.kind, "grok2");
    assert.equal(spec.requestedKind, "grok2");
    assert.equal(spec.command, "grok2");
    assert.deepEqual(spec.env, {});
    assert.equal(spec.homePath, undefined);
    assert.deepEqual(spec.args, []);

    const baseGrokWithProfileHome = resolveAgent("grok", [], { home: "2" });
    assert.equal(baseGrokWithProfileHome.kind, "grok");
    assert.deepEqual(baseGrokWithProfileHome.env, {});
    assert.equal(baseGrokWithProfileHome.homePath, undefined);
  } finally {
    if (oldHive === undefined) delete process.env.HIVE_GROK_CMD;
    else process.env.HIVE_GROK_CMD = oldHive;
    if (oldLegacy === undefined) delete process.env.AP_GROK_CMD;
    else process.env.AP_GROK_CMD = oldLegacy;
  }
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
