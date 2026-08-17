/**
 * Spec 04 behavior 7 (config, Q1 = json) + behavior 5 (policy-aware I1
 * deadline floor) unit tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, DEFAULTS, defaultDataDir, loadNodeConfig } from "../src/config.ts";

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
