import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "../src/parse.js";
import { resolveSpawnSubstrate } from "../src/cli.js";
import { configPath, resetConfigCache, spawnDefaultSubstrate } from "../src/config.js";
import { saveSession, type SessionRecord } from "../src/store.js";

// Drives the origin-based substrate resolver (HSR_EXPLORATION.md §5) purely
// through env + config — no tmux server, no HSR host. resolveSpawnSubstrate
// reads origin from resolveBeeInCurrentPane (HIVE_BEE/TMUX) and the config knob
// via spawnDefaultSubstrate.

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prevStore = process.env.HIVE_STORE_ROOT;
  const prevBee = process.env.HIVE_BEE;
  const prevTmux = process.env.TMUX;
  const prevPane = process.env.TMUX_PANE;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-default-"));
  process.env.HIVE_STORE_ROOT = dir;
  // Neutral origin by default; each case sets HIVE_BEE explicitly.
  delete process.env.HIVE_BEE;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  resetConfigCache();
  try {
    await fn();
  } finally {
    if (prevStore === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prevStore;
    if (prevBee === undefined) delete process.env.HIVE_BEE;
    else process.env.HIVE_BEE = prevBee;
    if (prevTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = prevTmux;
    if (prevPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = prevPane;
    resetConfigCache();
    await rm(dir, { recursive: true, force: true });
  }
}

function stubRecord(name: string, extra?: Partial<SessionRecord>): SessionRecord {
  const now = new Date().toISOString();
  return {
    name,
    agent: "claude",
    cwd: process.cwd(),
    command: "stub",
    tmuxTarget: name,
    createdAt: now,
    updatedAt: now,
    status: "running",
    ...extra,
  };
}

function spawnArgs(...extra: string[]) {
  return parse(["spawn", "claude", ...extra]);
}

test("agent origin (HIVE_BEE resolves to a live bee) defaults to HSR", async () => {
  await withTempStore(async () => {
    const parent = "parentbee";
    await saveSession(stubRecord(parent));
    process.env.HIVE_BEE = parent;
    const { useHsr, node } = await resolveSpawnSubstrate(spawnArgs(), "claude");
    assert.equal(useHsr, true, "agent-context spawn should default to HSR");
    assert.equal(node, undefined, "HSR resolves no node");
  });
});

test("agent-origin Kimi spawn defaults to its now-registered HSR runner", async () => {
  await withTempStore(async () => {
    await saveSession(stubRecord("parentbee"));
    process.env.HIVE_BEE = "parentbee";
    const { useHsr, node } = await resolveSpawnSubstrate(parse(["spawn", "kimi"]), "kimi");
    assert.equal(useHsr, true);
    assert.equal(node, undefined);
  });
});

test("agent-origin Grok spawn defaults to its registered HSR runner", async () => {
  await withTempStore(async () => {
    await saveSession(stubRecord("parentbee"));
    process.env.HIVE_BEE = "parentbee";
    const { useHsr, node } = await resolveSpawnSubstrate(parse(["spawn", "grok"]), "grok");
    assert.equal(useHsr, true);
    assert.equal(node, undefined);
  });
});

test("agent-origin OpenCode spawn defaults to its server-tier HSR runner", async () => {
  await withTempStore(async () => {
    await saveSession(stubRecord("parentbee"));
    process.env.HIVE_BEE = "parentbee";
    const { useHsr, node } = await resolveSpawnSubstrate(parse(["spawn", "opencode"]), "opencode");
    assert.equal(useHsr, true);
    assert.equal(node, undefined);
  });
});

test("user origin (no HIVE_BEE/TMUX) defaults to local-tmux node", async () => {
  await withTempStore(async () => {
    const { useHsr, node } = await resolveSpawnSubstrate(spawnArgs(), "claude");
    assert.equal(useHsr, false, "human-context spawn should default to local-tmux");
    assert.ok(node, "local-tmux resolves a node");
    assert.equal(node?.name, "local");
    assert.equal(node?.kind, "local-tmux");
  });
});

test("TMUX_PANE matching a bee's agent pane is agent origin (defaults to HSR)", async () => {
  await withTempStore(async () => {
    await saveSession(stubRecord("parentbee", { agentPaneId: "%7" }));
    process.env.TMUX = "/tmp/fake-tmux-socket,1,0";
    process.env.TMUX_PANE = "%7";
    const { useHsr } = await resolveSpawnSubstrate(spawnArgs(), "claude");
    assert.equal(useHsr, true, "a subprocess inside the bee's own pane is an agent spawn");
  });
});

test("TMUX without a bee-pane anchor is user origin (popup / operator pane in a comb)", async () => {
  await withTempStore(async () => {
    // A bee session exists (its tmuxTarget could match the client's session
    // name), but the spawning process carries no direct anchor: no HIVE_BEE
    // and — like a display-popup command — no TMUX_PANE. This is `hive new`
    // from cmd+shift+n over a bee's session; it must stay a user spawn.
    await saveSession(stubRecord("parentbee", { agentPaneId: "%7" }));
    process.env.TMUX = "/tmp/fake-tmux-socket,1,0";
    delete process.env.TMUX_PANE;
    const { useHsr, node } = await resolveSpawnSubstrate(spawnArgs(), "claude");
    assert.equal(useHsr, false, "session-name proximity alone must not classify as agent");
    assert.equal(node?.kind, "local-tmux");

    // Same story for a pane that exists but is not any bee's agent pane (an
    // operator shell split inside the comb).
    process.env.TMUX_PANE = "%9";
    const shellPane = await resolveSpawnSubstrate(spawnArgs(), "claude");
    assert.equal(shellPane.useHsr, false, "a non-agent pane in the comb is a user spawn");
  });
});

test("HIVE_BEE naming no live record is user origin", async () => {
  await withTempStore(async () => {
    process.env.HIVE_BEE = "ghostbee";
    const { useHsr } = await resolveSpawnSubstrate(spawnArgs(), "claude");
    assert.equal(useHsr, false, "a stale HIVE_BEE stamp must not route to HSR");
  });
});

test("explicit --substrate tmux beats the agent default (override wins)", async () => {
  await withTempStore(async () => {
    const parent = "parentbee";
    await saveSession(stubRecord(parent));
    process.env.HIVE_BEE = parent;
    const { useHsr, node } = await resolveSpawnSubstrate(spawnArgs("--substrate", "tmux"), "claude");
    assert.equal(useHsr, false, "explicit --substrate tmux forces tmux even for an agent");
    assert.equal(node?.name, "local");
    assert.equal(node?.kind, "local-tmux");
  });
});

test("explicit --substrate hsr with no HIVE_BEE forces HSR", async () => {
  await withTempStore(async () => {
    const { useHsr, node } = await resolveSpawnSubstrate(spawnArgs("--substrate", "hsr"), "claude");
    assert.equal(useHsr, true);
    assert.equal(node, undefined);
  });
});

test("spawnDefaultSubstrate honors a config override for agent origin", async () => {
  await withTempStore(async () => {
    // Baseline defaults with no config.
    assert.equal(spawnDefaultSubstrate("agent"), "hsr");
    assert.equal(spawnDefaultSubstrate("user"), "local-tmux");

    await writeFile(
      configPath(),
      JSON.stringify({ spawn: { defaultSubstrate: { agent: "local-tmux" } } }),
      "utf8",
    );
    resetConfigCache();
    assert.equal(spawnDefaultSubstrate("agent"), "local-tmux", "config override should flip the agent default");
    assert.equal(spawnDefaultSubstrate("user"), "local-tmux", "unset user falls back to default");

    // And the resolver follows the override: agent origin now lands on tmux.
    const parent = "parentbee";
    await saveSession(stubRecord(parent));
    process.env.HIVE_BEE = parent;
    const { useHsr, node } = await resolveSpawnSubstrate(spawnArgs(), "claude");
    assert.equal(useHsr, false, "agent default overridden to local-tmux");
    assert.equal(node?.name, "local");
  });
});
