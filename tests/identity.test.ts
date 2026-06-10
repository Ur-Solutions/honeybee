import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAgent, resolveHome } from "../src/agents.js";
import { identityEnvForAgent, identityRecipeForAgent } from "../src/drivers.js";

test("plain spawns never rewrite HOME (codex stress-report contract)", () => {
  const spec = resolveAgent("codex", [], { home: "/tmp/slot", yolo: false });
  assert.equal(spec.env.CODEX_HOME, "/tmp/slot");
  assert.equal(spec.env.HOME, undefined);
});

test("identity spawns apply the driver's explicit extra env", () => {
  const codex = resolveAgent("codex", [], { home: "/tmp/slot", yolo: false, identity: true });
  assert.equal(codex.env.CODEX_HOME, "/tmp/slot");
  assert.equal(codex.env.HOME, "/tmp/slot");

  const opencode = resolveAgent("opencode", [], { home: "/tmp/oc", yolo: false, identity: true });
  assert.equal(opencode.env.OPENCODE_CONFIG_DIR, "/tmp/oc");
  assert.equal(opencode.env.XDG_DATA_HOME, "/tmp/oc/xdg-data");

  // claude has no extras: identity spawns look identical to plain ones.
  const claude = resolveAgent("claude", [], { home: "/tmp/cl", yolo: false, identity: true });
  assert.deepEqual(claude.env, { CLAUDE_CONFIG_DIR: "/tmp/cl" });
});

test("identityEnvForAgent expands {home} and is empty for recipe-less extras", () => {
  assert.deepEqual(identityEnvForAgent("codex", "/x"), { HOME: "/x" });
  assert.deepEqual(identityEnvForAgent("claude", "/x"), {});
  assert.deepEqual(identityEnvForAgent("pi", "/x"), {});
});

test("identity recipes exist for the phase-3 tool set", () => {
  for (const tool of ["claude", "codex", "opencode", "grok", "cursor"]) {
    const recipe = identityRecipeForAgent(tool);
    assert.ok(recipe, `missing identity recipe for ${tool}`);
    assert.ok(recipe!.credentialFiles.length > 0);
  }
  assert.equal(identityRecipeForAgent("pi"), undefined);
});

test("numeric home slots follow the per-tool convention for every tool", () => {
  assert.equal(resolveHome("claude", "2"), join(homedir(), ".claude-2"));
  assert.equal(resolveHome("codex", "3"), join(homedir(), ".codex-3"));
  assert.equal(resolveHome("opencode", "1"), join(homedir(), ".opencode-1"));
  assert.equal(resolveHome("claude", "~/custom"), join(homedir(), "custom"));
});
