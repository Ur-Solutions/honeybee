import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { NodeRecord } from "../src/node.js";
import { clearSubstrateCache, localSubstrate, LOCAL_NODE, substrateFor, substrateForNode, substrateForRecord } from "../src/substrates/index.js";
import { createLocalTmuxSubstrate, hasSession, kill as tmuxKillSession, newSession, sendText, tmux } from "../src/substrates/local-tmux.js";
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
  for (const name of ["hasSession", "newSession", "newPane", "sendText", "sendEnter", "sendKey", "capture", "kill", "killPane", "listTmuxSessions", "attachCommand", "attachSession"] as const) {
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
    assert.deepEqual(shimCmd, ["tmux", "attach-session", "-t", "=alpha"]);
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
    assert.deepEqual(s.attachCommand("alpha"), ["tmux", "switch-client", "-t", "=alpha"]);
  } finally {
    if (previous === undefined) delete process.env.TMUX;
    else process.env.TMUX = previous;
  }
});

test("substrateForRecord keys the ssh cache on name + sshCommand + sshArgs, not just endpoint", () => {
  clearSubstrateCache();
  const base: NodeRecord = {
    name: "mini01",
    kind: "ssh-tmux",
    endpoint: "trmd@mini01",
    capabilities: ["*"],
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
  };
  try {
    const a = substrateForRecord(base);
    assert.equal(substrateForRecord({ ...base }), a, "identical records share one substrate");
    // Two nodes on one endpoint must not collapse into one cache entry.
    assert.notEqual(substrateForRecord({ ...base, name: "mini02" }), a);
    // node update --ssh-args/--ssh-command with an unchanged endpoint must
    // produce a fresh substrate for long-lived processes (daemon).
    assert.notEqual(substrateForRecord({ ...base, sshArgs: ["-F", "/etc/ssh/config"] }), a);
    assert.notEqual(substrateForRecord({ ...base, sshCommand: "/usr/local/bin/ssh" }), a);
  } finally {
    clearSubstrateCache();
  }
});

test("local sendText streams a >1MB prompt via load-buffer stdin (no ARG_MAX limit)", { timeout: 60_000 }, async () => {
  const target = `hive-sendtext-argmax-${process.pid}`;
  const buffer = `hive-${target}`;
  try {
    // A pane that drains its stdin so the paste cannot wedge the pty.
    await newSession(target, "/tmp", { command: "sh", args: ["-c", "cat > /dev/null"] });
    assert.equal(await hasSession(target), true);

    // Larger than macOS ARG_MAX (~1MB) and Linux MAX_ARG_STRLEN (128KB): the
    // old `set-buffer <text>` argv form would fail with E2BIG.
    const text = "x".repeat(1_500_000);
    await sendText(target, text);

    const shown = await tmux(["show-buffer", "-b", buffer]);
    assert.equal(shown.stdout.trimEnd(), text, "buffer should hold the full streamed text");
  } finally {
    await tmux(["delete-buffer", "-b", buffer], { reject: false });
    await tmuxKillSession(target).catch(() => undefined);
  }
});

test("local newSession cleans up its hive-launch tmpdir when tmux refuses the session", { timeout: 30_000 }, async () => {
  const target = `hive-launch-cleanup-${process.pid}`;
  // Isolate os.tmpdir() so only this call's launch dir can appear in it.
  // (tmux's own socket uses TMUX_TMPDIR//tmp, so this doesn't fork a server.)
  const isolatedTmp = await mkdtemp(join(tmpdir(), "hive-launch-isolated-"));
  const previous = process.env.TMPDIR;
  try {
    // Occupy the name so newSession's `tmux new-session` fails (duplicate).
    await tmux(["new-session", "-d", "-s", target, "sleep 30"]);
    process.env.TMPDIR = isolatedTmp;
    await assert.rejects(newSession(target, "/tmp", { command: "sleep", args: ["1"] }), /duplicate session/i);
    const leftovers = await readdir(isolatedTmp);
    assert.deepEqual(leftovers, [], "launch payload tmpdir should be removed on failure");
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await tmuxKillSession(target).catch(() => undefined);
    await rm(isolatedTmp, { recursive: true, force: true });
  }
});
