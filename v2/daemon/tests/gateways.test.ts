import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveGateways, parseGatewayRecord } from "../src/gateways.ts";

test("gateway reader accepts a live-registry shape and strips identity overrides", () => {
  assert.deepEqual(parseGatewayRecord(JSON.stringify({
    name: "apiary",
    protocol: "mcp",
    socketPath: "/tmp/apiary.sock",
    shim: { command: "/opt/apiary-mcp", args: [] },
    env: { APIARY_GATEWAY: "/tmp/apiary.json", HIVE_BEE_ID: "spoofed" },
    pid: 42,
    startedAt: "2026-08-21T00:00:00.000Z",
    gatewayRev: 1,
  })), {
    name: "apiary",
    shim: { command: "/opt/apiary-mcp", args: [] },
    env: { APIARY_GATEWAY: "/tmp/apiary.json" },
    pid: 42,
  });
});

test("gateway reader rejects malformed commands, arguments, and environment", () => {
  const base = {
    name: "apiary",
    protocol: "mcp",
    shim: { command: "/opt/apiary-mcp", args: [] },
    env: {},
    pid: 42,
    startedAt: "2026-08-21T00:00:00.000Z",
    gatewayRev: 1,
  };
  assert.equal(parseGatewayRecord(JSON.stringify({ ...base, shim: { command: "relative", args: [] } })), null);
  assert.equal(parseGatewayRecord(JSON.stringify({ ...base, shim: { command: "/opt/apiary-mcp", args: [3] } })), null);
  assert.equal(parseGatewayRecord(JSON.stringify({ ...base, env: { "BAD-KEY": "x" } })), null);
});

test("live gateway discovery reads the Honeybee store root, not the v2 daemon data dir", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-gateways-"));
  try {
    const shim = join(root, "apiary-mcp");
    writeFileSync(shim, "#!/bin/sh\n");
    chmodSync(shim, 0o755);
    mkdirSync(join(root, "gateways"));
    writeFileSync(join(root, "gateways", "apiary.json"), JSON.stringify({
      name: "apiary",
      protocol: "mcp",
      socketPath: join(root, "apiary.sock"),
      shim: { command: shim, args: [] },
      env: { APIARY_GATEWAY: join(root, "gateways", "apiary.json") },
      pid: process.pid,
      startedAt: "2026-08-21T00:00:00.000Z",
      gatewayRev: 1,
    }));

    assert.deepEqual(liveGateways(root).map((gateway) => gateway.name), ["apiary"]);
    assert.deepEqual(liveGateways(join(root, "v2")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
