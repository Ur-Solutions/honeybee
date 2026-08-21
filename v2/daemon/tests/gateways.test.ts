import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGatewayRecord } from "../src/gateways.ts";

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
