import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { resolveAgent, stampBeeIdentityEnv } from "../src/agents.js";
import { resolveSpawnEnvFlag } from "../src/commands/spawn.js";
import { resetConfigCache } from "../src/config.js";
import { hsrSpawnEnvArgv } from "../src/daemon/hsrControl.js";
import { driverIdentityEnvKeys } from "../src/drivers.js";
import { resetGatewayCacheForTests } from "../src/gateways.js";
import { parse } from "../src/parse.js";
import { PROTECTED_SPAWN_ENV_KEYS, parseEnvAssignments } from "../src/spawnEnv.js";

let cleanStoreDir: string;
let previousStoreRoot: string | undefined;

before(async () => {
  previousStoreRoot = process.env.HIVE_STORE_ROOT;
  cleanStoreDir = await mkdtemp(join(tmpdir(), "honeybee-spawn-env-store-"));
  process.env.HIVE_STORE_ROOT = cleanStoreDir;
  resetConfigCache();
  resetGatewayCacheForTests();
});

after(async () => {
  if (previousStoreRoot === undefined) delete process.env.HIVE_STORE_ROOT;
  else process.env.HIVE_STORE_ROOT = previousStoreRoot;
  resetConfigCache();
  resetGatewayCacheForTests();
  await rm(cleanStoreDir, { recursive: true, force: true });
});

test("repeated --env parses with duplicate-last-wins and preserves equals in values", () => {
  const parsed = parse(["spawn", "codex", "--env", "A=first", "--env", "TOKEN=a=b=c", "--env", "A=last"]);
  assert.deepEqual(resolveSpawnEnvFlag(parsed), { A: "last", TOKEN: "a=b=c" });
});

test("spawn env rejects malformed assignments and every protected key", () => {
  assert.throws(() => parseEnvAssignments(["NO_EQUALS"]), /expected KEY=VALUE/);
  assert.throws(() => parseEnvAssignments(["9BAD=value"]), /Invalid spawn env key/);
  assert.throws(() => resolveSpawnEnvFlag(parse(["spawn", "codex", "--env"])), /requires KEY=VALUE/);
  for (const key of PROTECTED_SPAWN_ENV_KEYS) {
    assert.throws(() => parseEnvAssignments([`${key}=spoofed`]), new RegExp(key));
  }
  assert.deepEqual(driverIdentityEnvKeys(), [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "CURSOR_CONFIG_DIR",
    "GROK_HOME",
    "KIMI_CODE_HOME",
    "OPENCODE_CONFIG_DIR",
    "XDG_DATA_HOME",
  ]);
});

test("caller env follows home and activation env, then identity stamps win last", () => {
  const spec = resolveAgent("opencode", [], {
    home: "/tmp/opencode-home",
    identity: true,
    env: { FEATURE_FLAG: "on" },
  });
  assert.equal(spec.env.OPENCODE_CONFIG_DIR, "/tmp/opencode-home");
  assert.equal(spec.env.XDG_DATA_HOME, "/tmp/opencode-home/xdg-data");
  assert.equal(spec.env.FEATURE_FLAG, "on");
  assert.throws(
    () => resolveAgent("opencode", [], { home: "/tmp/opencode-home", identity: true, env: { XDG_DATA_HOME: "/caller/data" } }),
    /XDG_DATA_HOME/,
  );
  assert.throws(() => parseEnvAssignments(["CURSOR_API_KEY=spoofed"]), /CURSOR_API_KEY/);
  assert.throws(() => parseEnvAssignments(["CURSOR_AUTH_TOKEN=spoofed"]), /CURSOR_AUTH_TOKEN/);

  stampBeeIdentityEnv(spec.env, { name: "worker", id: "OC.stable", comb: "worker" });
  assert.equal(spec.env.HIVE_BEE, "worker");
  assert.equal(spec.env.HIVE_BEE_ID, "OC.stable");
});

test("daemon hsr-control spawn env becomes execFile-style repeated argv", () => {
  assert.deepEqual(hsrSpawnEnvArgv({ TOKEN: "a=b", FEATURE: "on" }), [
    "--env", "TOKEN=a=b",
    "--env", "FEATURE=on",
  ]);
  assert.throws(() => hsrSpawnEnvArgv({ TOKEN: 42 }), /must be a string/);
  assert.throws(() => hsrSpawnEnvArgv({ HIVE_BEE: "spoofed" }), /HIVE_BEE/);
});
