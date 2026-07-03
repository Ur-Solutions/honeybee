import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  // Spot-check the method/function names that callers depend on. Combs are
  // retired (APIA-85): newPane/killPane are no longer Substrate methods, but the
  // low-level tmux shim keeps exporting them for direct callers.
  for (const name of ["hasSession", "newSession", "sendText", "sendEnter", "sendKey", "capture", "kill", "listTmuxSessions", "attachCommand", "attachSession", "setWindowOptions"] as const) {
    if (name === "listTmuxSessions") {
      assert.equal(typeof (legacyTmux as Record<string, unknown>)[name], "function");
      assert.equal(typeof s.listSessions, "function");
      continue;
    }
    assert.equal(typeof (legacyTmux as Record<string, unknown>)[name], "function", `legacyTmux.${name} should be a function`);
    assert.equal(typeof (s as unknown as Record<string, unknown>)[name], "function", `substrate.${name} should be a function`);
  }
  // Low-level pane helpers remain on the tmux shim (not on the substrate object).
  assert.equal(typeof (legacyTmux as Record<string, unknown>).newPane, "function");
  assert.equal(typeof (legacyTmux as Record<string, unknown>).killPane, "function");
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

test("local kill terminates the supplied launcher process group", { timeout: 10_000 }, async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  assert.ok(child.pid);
  child.unref();
  try {
    await tmuxKillSession(`missing-${process.pid}`, { launcherPgid: child.pid });
    await sleep(200);
    assert.equal(processGroupAlive(child.pid), false);
  } finally {
    if (processGroupAlive(child.pid)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

test("local launcher restores real HOME from a fake parent env unless explicitly overridden", { timeout: 30_000 }, async () => {
  const targetA = `hive-launch-home-a-${process.pid}`;
  const targetB = `hive-launch-home-b-${process.pid}`;
  const dir = await mkdtemp(join(tmpdir(), "hive-launch-home-"));
  const outA = join(dir, "a.txt");
  const outB = join(dir, "b.txt");
  const previousHome = process.env.HOME;
  const previousRealHome = process.env.HIVE_REAL_HOME;

  const writeHome = (path: string) => [
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(path)}, process.env.HOME || "")`,
  ];
  try {
    process.env.HOME = "/tmp/hive-fake-account-home";
    process.env.HIVE_REAL_HOME = "/tmp/hive-real-user-home";

    await newSession(targetA, "/tmp", { command: process.execPath, args: writeHome(outA) });
    await newSession(targetB, "/tmp", { command: process.execPath, args: writeHome(outB), env: { HOME: "/tmp/hive-driver-home" } });

    assert.equal(await waitForFile(outA), "/tmp/hive-real-user-home");
    assert.equal(await waitForFile(outB), "/tmp/hive-driver-home");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousRealHome === undefined) delete process.env.HIVE_REAL_HOME;
    else process.env.HIVE_REAL_HOME = previousRealHome;
    await tmuxKillSession(targetA).catch(() => undefined);
    await tmuxKillSession(targetB).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("local launcher scrubs inherited no-color env for interactive agents", { timeout: 30_000 }, async () => {
  const target = `hive-launch-color-env-${process.pid}`;
  const dir = await mkdtemp(join(tmpdir(), "hive-launch-color-"));
  const out = join(dir, "env.json");
  const previous = new Map<string, string | undefined>();
  for (const key of ["NO_COLOR", "FORCE_COLOR", "TERM", "CLICOLOR", "COLORTERM", "HIVE_PRESERVE_NO_COLOR"]) {
    previous.set(key, process.env[key]);
  }
  const writeEnv = [
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({
      NO_COLOR: process.env.NO_COLOR ?? null,
      FORCE_COLOR: process.env.FORCE_COLOR ?? null,
      TERM: process.env.TERM ?? null,
      CLICOLOR: process.env.CLICOLOR ?? null,
      COLORTERM: process.env.COLORTERM ?? null,
    }))`,
  ];
  try {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
    process.env.TERM = "dumb";
    delete process.env.CLICOLOR;
    delete process.env.COLORTERM;
    delete process.env.HIVE_PRESERVE_NO_COLOR;

    await newSession(target, "/tmp", { command: process.execPath, args: writeEnv });

    const captured = JSON.parse(await waitForFile(out)) as Record<string, string | null>;
    assert.equal(captured.NO_COLOR, null);
    assert.equal(captured.FORCE_COLOR, null);
    assert.notEqual(captured.TERM, "dumb");
    assert.equal(captured.CLICOLOR, "1");
    assert.equal(captured.COLORTERM, "truecolor");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await tmuxKillSession(target).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("local launcher applies requested tmux window options to the created pane", { timeout: 30_000 }, async () => {
  const target = `hive-launch-tmux-options-${process.pid}`;
  try {
    const { paneId } = await newSession(target, "/tmp", {
      command: "sleep",
      args: ["30"],
      tmuxOptions: { "allow-passthrough": "off" },
    });

    const shown = await tmux(["show-options", "-w", "-t", paneId, "allow-passthrough"]);
    assert.equal(shown.stdout.trim(), "allow-passthrough off");
  } finally {
    await tmuxKillSession(target).catch(() => undefined);
  }
});

test("local substrate applies tmux window options to an existing bee pane", { timeout: 30_000 }, async () => {
  const target = `hive-existing-tmux-options-${process.pid}`;
  const substrate = createLocalTmuxSubstrate();
  try {
    const { paneId } = await newSession(target, "/tmp", { command: "sleep", args: ["30"] });
    await substrate.setWindowOptions(target, { "allow-passthrough": "off" }, paneId);

    const shown = await tmux(["show-options", "-w", "-t", paneId, "allow-passthrough"]);
    assert.equal(shown.stdout.trim(), "allow-passthrough off");
  } finally {
    await tmuxKillSession(target).catch(() => undefined);
  }
});

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`timed out waiting for ${path}`);
}
