import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { resolveAgent, stampBeeIdentityEnv } from "../src/agents.js";
import {
  gatewayPidIsLive,
  gatewaysWithLiveness,
  liveGatewayEnv,
  liveGateways,
  resetGatewayCacheForTests,
  type GatewayRecord,
} from "../src/gateways.js";

const execFileAsync = promisify(execFile);

function gateway(overrides: Partial<GatewayRecord> = {}): GatewayRecord {
  return {
    name: "apiary",
    protocol: "mcp",
    socketPath: "/tmp/apiary.sock",
    shim: { command: "/opt/apiary-mcp", args: [] },
    env: { APIARY_GATEWAY: "/tmp/apiary.json" },
    pid: process.pid,
    startedAt: "2026-07-22T09:00:00.000Z",
    gatewayRev: 1,
    ...overrides,
  };
}

async function withStore(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-gateways-"));
  const previousRoot = process.env.HIVE_STORE_ROOT;
  const previousDisable = process.env.HIVE_GATEWAYS_DISABLE;
  process.env.HIVE_STORE_ROOT = root;
  delete process.env.HIVE_GATEWAYS_DISABLE;
  resetGatewayCacheForTests();
  try {
    await fn(root);
  } finally {
    if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousRoot;
    if (previousDisable === undefined) delete process.env.HIVE_GATEWAYS_DISABLE;
    else process.env.HIVE_GATEWAYS_DISABLE = previousDisable;
    resetGatewayCacheForTests();
    await rm(root, { recursive: true, force: true });
  }
}

async function writeGateway(root: string, name: string, record: unknown): Promise<void> {
  const dir = join(root, "gateways");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.json`), typeof record === "string" ? record : `${JSON.stringify(record, null, 2)}\n`);
}

test("gateway registry tolerates malformed files and reports pid liveness", async () => {
  await withStore(async (root) => {
    await writeGateway(root, "live", gateway({ name: "live" }));
    await writeGateway(root, "dead", gateway({ name: "dead", pid: 2_147_483_647 }));
    await writeGateway(root, "broken", "{not json");
    await writeGateway(root, "relative", gateway({ name: "relative", socketPath: "relative.sock" }));

    const statuses = gatewaysWithLiveness();
    assert.deepEqual(statuses.map(({ name, live }) => ({ name, live })), [
      { name: "dead", live: false },
      { name: "live", live: true },
    ]);
    assert.deepEqual(liveGateways().map(({ name }) => name), ["live"]);
  });
});

test("gateway liveness is exactly kill(pid, 0)", () => {
  const calls: Array<[number, number]> = [];
  assert.equal(gatewayPidIsLive(42, (pid, signal) => { calls.push([pid, signal]); }), true);
  assert.equal(gatewayPidIsLive(43, () => { throw new Error("ESRCH"); }), false);
  assert.deepEqual(calls, [[42, 0]]);
});

test("registry cache notices file mtimes and the disable switch is immediate", async () => {
  await withStore(async (root) => {
    await writeGateway(root, "apiary", gateway({ env: { VERSION: "one" } }));
    assert.equal(liveGateways()[0]?.env.VERSION, "one");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeGateway(root, "apiary", gateway({ env: { VERSION: "two" } }));
    assert.equal(liveGateways()[0]?.env.VERSION, "two");
    process.env.HIVE_GATEWAYS_DISABLE = "1";
    assert.deepEqual(gatewaysWithLiveness(), []);
  });
});

test("gateway env merges before caller env and cannot shadow protected identity/home keys", async () => {
  await withStore(async (root) => {
    await writeGateway(root, "apiary", gateway({
      env: {
        SHARED: "gateway",
        GATEWAY_ONLY: "yes",
        HIVE_BEE: "spoofed",
        CODEX_HOME: "/spoofed/home",
        XDG_DATA_HOME: "/spoofed/auth",
        CURSOR_API_KEY: "spoofed-api-key",
        CURSOR_AUTH_TOKEN: "spoofed-auth-token",
      },
    }));
    assert.deepEqual(liveGatewayEnv(), { SHARED: "gateway", GATEWAY_ONLY: "yes" });
    const spec = resolveAgent("codex", [], { home: "/real/home", env: { SHARED: "caller", CALLER_ONLY: "yes" } });
    stampBeeIdentityEnv(spec.env, { name: "worker", id: "CO.stable", comb: "worker" });
    assert.equal(spec.env.CODEX_HOME, "/real/home");
    assert.equal(spec.env.GATEWAY_ONLY, "yes");
    assert.equal(spec.env.SHARED, "caller");
    assert.equal(spec.env.CALLER_ONLY, "yes");
    assert.equal(spec.env.HIVE_BEE, "worker");
  });
});

test("hive gateways lists valid live and stale advertisements", async () => {
  await withStore(async (root) => {
    await writeGateway(root, "live", gateway({ name: "live" }));
    await writeGateway(root, "dead", gateway({ name: "dead", pid: 2_147_483_647 }));
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "gateways"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: root, NO_COLOR: "1", TERM: "dumb" },
    });
    assert.match(stdout, /^dead\tdead\tmcp\t/m);
    assert.match(stdout, /^live\tlive\tmcp\t/m);
  });
});
