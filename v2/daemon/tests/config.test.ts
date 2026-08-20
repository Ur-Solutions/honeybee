/**
 * Spec 04 behavior 7 (config, Q1 = json) + behavior 5 (policy-aware I1
 * deadline floor) unit tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, DEFAULTS, NAMING_DEFAULTS, defaultDataDir, loadNodeConfig, patchNamingConfig } from "../src/config.ts";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-cfg-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config.1: absent file resolves to pure defaults (the file may be absent)", () => {
  withDir((dir) => {
    const cfg = loadNodeConfig(dir);
    assert.equal(cfg.idleWindowMs, DEFAULTS.idleWindowMs);
    assert.equal(cfg.tickMs, DEFAULTS.tickMs);
    assert.equal(cfg.maxAttempts, DEFAULTS.maxAttempts);
    assert.equal(cfg.socketPath, join(dir, "hived.sock"));
    assert.equal(cfg.storePath, join(dir, "core.sqlite3"));
    assert.equal(cfg.telemetryPath, join(dir, "telemetry.sqlite3"));
    assert.ok(cfg.agents.claude, "builtin agent table present");
    assert.ok(cfg.agents.codex);
    assert.ok(cfg.agents.grok);
  });
});

test("config.2: file values override defaults; unknown keys are ignored", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        idleWindowMs: 1234,
        tickMs: 25,
        retry: { maxAttempts: 9 },
        socketPath: "/tmp/custom.sock",
        agents: { stub: { command: "node", args: ["agent.mjs"], env: { A: "1" } } },
        someFutureKey: true,
      }),
    );
    const cfg = loadNodeConfig(dir);
    assert.equal(cfg.idleWindowMs, 1234);
    assert.equal(cfg.tickMs, 25);
    assert.equal(cfg.maxAttempts, 9);
    assert.equal(cfg.backoffBaseMs, DEFAULTS.backoffBaseMs);
    assert.equal(cfg.socketPath, "/tmp/custom.sock");
    assert.deepEqual(cfg.agents.stub, { command: "node", args: ["agent.mjs"], env: { A: "1" } });
    assert.ok(cfg.agents.claude, "builtins survive user agents");
  });
});

test("config.3: I1 deadline is clamped UP to the policy-aware floor (hang + boot + turn allowances)", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        bootHangTimeoutMs: 500,
        turnHangTimeoutMs: 800,
        bootAllowanceMs: 100,
        turnAllowanceMs: 200,
        i1DeadlineMs: 1, // below floor: measuring nothing — clamp
      }),
    );
    const cfg = loadNodeConfig(dir);
    assert.equal(cfg.i1FloorMs, 800 + 100 + 200);
    assert.equal(cfg.i1DeadlineMs, cfg.i1FloorMs);
  });
});

test("config.4: an above-floor deadline override is honored", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ bootHangTimeoutMs: 100, turnHangTimeoutMs: 100, bootAllowanceMs: 10, turnAllowanceMs: 10, i1DeadlineMs: 99_999 }),
    );
    const cfg = loadNodeConfig(dir);
    assert.equal(cfg.i1DeadlineMs, 99_999);
  });
});

test("config.5: malformed json and wrongly-typed values fail loudly", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "config.json"), "{not json");
    assert.throws(() => loadNodeConfig(dir), ConfigError);
  });
  withDir((dir) => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ tickMs: "fast" }));
    assert.throws(() => loadNodeConfig(dir), ConfigError);
  });
  withDir((dir) => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ agents: { bad: {} } }));
    assert.throws(() => loadNodeConfig(dir), ConfigError);
  });
});

test("config.6: HIVE_V2_DATA_DIR overrides the default data dir (test isolation hook)", () => {
  assert.equal(defaultDataDir({ HIVE_V2_DATA_DIR: "/tmp/x" }), "/tmp/x");
  assert.ok(defaultDataDir({}).endsWith(join(".hive", "v2")));
});

test("config.7: nodeKind (WP5) defaults to workstation and validates the closed list", () => {
  withDir((dir) => {
    assert.equal(loadNodeConfig(dir).nodeKind, "workstation");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ nodeKind: "satellite" }));
    assert.equal(loadNodeConfig(dir).nodeKind, "satellite");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ nodeKind: "mainframe" }));
    assert.throws(() => loadNodeConfig(dir), ConfigError);
  });
});

test("config.8: cells (WP5) — root default, sandbox override tri-state, warm map validation", () => {
  withDir((dir) => {
    const bare = loadNodeConfig(dir);
    assert.equal(bare.cellsRoot, join(dir, "cells"));
    assert.equal(bare.cellSandbox, null); // null = node-kind default (A4)
    assert.deepEqual(bare.cellWarm, {});

    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        cells: {
          root: "/data/cells",
          sandbox: false,
          warm: { "/repos/app": ["node_modules", ".turbo"] },
        },
      }),
    );
    const cfg = loadNodeConfig(dir);
    assert.equal(cfg.cellsRoot, "/data/cells");
    assert.equal(cfg.cellSandbox, false);
    assert.deepEqual(cfg.cellWarm, { "/repos/app": ["node_modules", ".turbo"] });

    writeFileSync(join(dir, "config.json"), JSON.stringify({ cells: { warm: { "/r": [1] } } }));
    assert.throws(() => loadNodeConfig(dir), ConfigError);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ cells: { sandbox: "yes" } }));
    assert.throws(() => loadNodeConfig(dir), ConfigError);
  });
});

test("config.6 (spec 08): accounts settings default (vault/homes under ~/.hive, 1h stale, 15 min sweep, 5h cool-off, no tmux socket) and validate; agents.<a>.login parses", () => {
  withDir((dir) => {
    const defaults = loadNodeConfig(dir);
    assert.equal(defaults.accounts.vaultDir, join(homedir(), ".hive", "vault"));
    assert.equal(defaults.accounts.homesDir, join(homedir(), ".hive", "homes"));
    assert.equal(defaults.accounts.limitsStaleMs, 60 * 60 * 1000);
    assert.equal(defaults.accounts.limitsRefreshMs, 15 * 60 * 1000);
    assert.equal(defaults.accounts.limitsFetchTimeoutMs, 15_000);
    assert.equal(defaults.accounts.loginTimeoutMs, 10 * 60 * 1000);
    assert.equal(defaults.accounts.exhaustionCoolOffMs, 5 * 60 * 60 * 1000);
    assert.equal(defaults.accounts.tmuxSocket, null);
    assert.equal(defaults.agents.claude?.login, undefined);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        accounts: { vaultDir: "/v", homesDir: "/h", limitsStaleMs: 5, limitsRefreshMs: 0, tmuxSocket: "s" },
        agents: { claude: { command: "claude", login: { command: "claude", args: ["auth", "login"] } } },
      }),
    );
    const cfg = loadNodeConfig(dir);
    assert.equal(cfg.accounts.vaultDir, "/v");
    assert.equal(cfg.accounts.homesDir, "/h");
    assert.equal(cfg.accounts.limitsStaleMs, 5);
    assert.equal(cfg.accounts.limitsRefreshMs, 0);
    assert.equal(cfg.accounts.tmuxSocket, "s");
    assert.deepEqual(cfg.agents.claude?.login, { command: "claude", args: ["auth", "login"] });
    for (const bad of [
      { accounts: [] },
      { accounts: { vaultDir: "" } },
      { accounts: { limitsStaleMs: "1h" } },
      { accounts: { tmuxSocket: "" } },
      { agents: { claude: { command: "claude", login: "claude" } } },
      { agents: { claude: { command: "claude", login: { command: "claude", args: [1] } } } },
    ]) {
      writeFileSync(join(dir, "config.json"), JSON.stringify(bad));
      assert.throws(() => loadNodeConfig(dir), ConfigError, JSON.stringify(bad));
    }
  });
});

test("config.naming: absent file defaults to auto Codex GPT-5.6 Luna medium", () => {
  withDir((dir) => {
    const cfg = loadNodeConfig(dir);
    assert.deepEqual(cfg.naming, {
      auto: true,
      tool: NAMING_DEFAULTS.tool,
      model: NAMING_DEFAULTS.model,
      effort: NAMING_DEFAULTS.effort,
      generatorCwd: join(dir, "naming"),
    });
  });
});

test("config.naming: file values override; patchNamingConfig merges and preserves unknown keys", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ someFutureKey: true, naming: { auto: false, tool: "claude", model: "haiku" } }),
    );
    const cfg = loadNodeConfig(dir);
    assert.equal(cfg.naming.auto, false);
    assert.equal(cfg.naming.tool, "claude");
    assert.equal(cfg.naming.model, "haiku");
    assert.equal(cfg.naming.effort, NAMING_DEFAULTS.effort);
    const patched = patchNamingConfig(join(dir, "config.json"), dir, { auto: true, effort: "low" });
    assert.equal(patched.auto, true);
    assert.equal(patched.tool, "claude");
    assert.equal(patched.effort, "low");
    const round = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(round.someFutureKey, true);
    assert.deepEqual(round.naming, { auto: true, tool: "claude", model: "haiku", effort: "low" });
  });
});

test("config.naming: invalid tool/effort fail loudly", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ naming: { tool: "grok" } }));
    assert.throws(() => loadNodeConfig(dir), ConfigError);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ naming: { effort: "ludicrous" } }));
    assert.throws(() => loadNodeConfig(dir), ConfigError);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ naming: { auto: "yes" } }));
    assert.throws(() => loadNodeConfig(dir), ConfigError);
  });
});
