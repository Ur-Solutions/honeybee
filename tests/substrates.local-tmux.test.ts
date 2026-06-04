import assert from "node:assert/strict";
import { test } from "node:test";
import { clearSubstrateCache, localSubstrate, LOCAL_NODE, substrateFor, substrateForNode } from "../src/substrates/index.js";
import { createLocalTmuxSubstrate } from "../src/substrates/local-tmux.js";
import * as legacyTmux from "../src/tmux.js";

test("createLocalTmuxSubstrate returns a Substrate tagged 'local-tmux' on the local node", () => {
  const s = createLocalTmuxSubstrate();
  assert.equal(s.kind, "local-tmux");
  assert.equal(s.node, LOCAL_NODE);
});

test("localSubstrate() caches and returns the same instance", () => {
  const a = localSubstrate();
  const b = localSubstrate();
  assert.equal(a, b);
});

test("clearSubstrateCache() causes localSubstrate() to return a fresh instance", () => {
  const before = localSubstrate();
  clearSubstrateCache();
  const after = localSubstrate();
  assert.notEqual(before, after, "cache should be invalidated");
  assert.equal(after.kind, "local-tmux");
});

test("substrateFor dispatches the local substrate when record.node is undefined or 'local'", () => {
  const a = substrateFor({});
  const b = substrateFor({ node: "local" });
  const c = substrateFor({ node: "" });
  assert.equal(a.kind, "local-tmux");
  assert.equal(b.kind, "local-tmux");
  assert.equal(c.kind, "local-tmux");
});

test("substrateFor throws a clear, actionable error for unregistered remote nodes", () => {
  assert.throws(() => substrateFor({ node: "mini01" }), /Unknown node: mini01.*hive node register mini01/);
});

test("substrateForNode rejects unknown nodes with a registration hint", () => {
  assert.throws(() => substrateForNode("mini01"), /Unknown node: mini01.*hive node register/);
  assert.doesNotThrow(() => substrateForNode("local"));
  assert.doesNotThrow(() => substrateForNode(undefined));
});

test("tmux.js shim exposes the same callable names as the substrate's methods", () => {
  const s = createLocalTmuxSubstrate();
  // Spot-check the method/function names that callers depend on.
  for (const name of ["hasSession", "newSession", "sendText", "sendEnter", "sendKey", "capture", "kill", "listTmuxSessions", "attachCommand", "attachSession"] as const) {
    if (name === "listTmuxSessions") {
      assert.equal(typeof (legacyTmux as Record<string, unknown>)[name], "function");
      assert.equal(typeof s.listSessions, "function");
      continue;
    }
    assert.equal(typeof (legacyTmux as Record<string, unknown>)[name], "function", `legacyTmux.${name} should be a function`);
    assert.equal(typeof (s as unknown as Record<string, unknown>)[name], "function", `substrate.${name} should be a function`);
  }
  assert.equal(typeof legacyTmux.formatShellCommand, "function");
});

test("tmux.js shim's attachCommand returns the same shape as the substrate's attachCommand", () => {
  const s = createLocalTmuxSubstrate();
  const previous = process.env.TMUX;
  delete process.env.TMUX;
  try {
    const shimCmd = legacyTmux.attachCommand("alpha");
    const substrateCmd = s.attachCommand("alpha");
    assert.deepEqual(shimCmd, substrateCmd);
    assert.deepEqual(shimCmd, ["tmux", "attach-session", "-t", "alpha"]);
  } finally {
    if (previous === undefined) delete process.env.TMUX;
    else process.env.TMUX = previous;
  }
});

test("attachCommand returns 'switch-client' when running inside an existing tmux", () => {
  const s = createLocalTmuxSubstrate();
  const previous = process.env.TMUX;
  process.env.TMUX = "/tmp/tmux-1000/default,1234,0";
  try {
    assert.deepEqual(s.attachCommand("alpha"), ["tmux", "switch-client", "-t", "alpha"]);
  } finally {
    if (previous === undefined) delete process.env.TMUX;
    else process.env.TMUX = previous;
  }
});
