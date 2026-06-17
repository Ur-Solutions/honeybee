import assert from "node:assert/strict";
import { test } from "node:test";
import { agentKinds, hasAgentDriver } from "../src/drivers.js";

test("agentKinds lists claude first and only real drivers", () => {
  const kinds = agentKinds();
  assert.equal(kinds[0], "claude");
  assert.ok(kinds.includes("codex"));
  assert.ok(kinds.includes("kimi"));
  for (const kind of kinds) assert.ok(hasAgentDriver(kind), `${kind} should be a real driver`);
});

test("agentKinds returns every driver exactly once", () => {
  const kinds = agentKinds();
  assert.equal(new Set(kinds).size, kinds.length);
});
