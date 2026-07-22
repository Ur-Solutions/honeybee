import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { seedGatewayMcp, type GatewayMcpStamp } from "../src/accounts/gatewayMcp.js";
import type { GatewayRecord } from "../src/gateways.js";

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

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "hive-gateway-mcp-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("claude seeder merges, updates, stays idempotent, and reconciles dead gateways", async () => {
  await withHome(async (home) => {
    const settingsPath = join(home, "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      theme: "dark",
      mcpServers: { user: { command: "/usr/bin/user-mcp", args: ["--safe"] } },
    }));

    const first = await seedGatewayMcp(home, "claude", { gateways: [gateway()] });
    assert.deepEqual(first.written, ["settings.json", ".hive-gateways.json"]);
    let settings = await json(settingsPath) as { theme?: string; mcpServers?: Record<string, unknown> };
    assert.equal(settings.theme, "dark");
    assert.deepEqual(settings.mcpServers?.user, { command: "/usr/bin/user-mcp", args: ["--safe"] });
    assert.deepEqual(settings.mcpServers?.apiary, { command: "/opt/apiary-mcp", args: [] });

    const stamp = await json(join(home, ".hive-gateways.json")) as GatewayMcpStamp;
    assert.deepEqual(stamp.files["settings.json"]?.apiary, { command: "/opt/apiary-mcp", args: [] });
    assert.deepEqual((await seedGatewayMcp(home, "claude", { gateways: [gateway()] })).written, []);

    await seedGatewayMcp(home, "claude", { gateways: [gateway({ shim: { command: "/opt/apiary-mcp-v2", args: ["serve"] } })] });
    settings = await json(settingsPath) as { theme?: string; mcpServers?: Record<string, unknown> };
    assert.deepEqual(settings.mcpServers?.apiary, { command: "/opt/apiary-mcp-v2", args: ["serve"] });

    await seedGatewayMcp(home, "claude", { gateways: [] });
    settings = await json(settingsPath) as { theme?: string; mcpServers?: Record<string, unknown> };
    assert.equal(settings.mcpServers?.apiary, undefined);
    assert.deepEqual(settings.mcpServers?.user, { command: "/usr/bin/user-mcp", args: ["--safe"] });
    const reconciledStamp = await json(join(home, ".hive-gateways.json")) as GatewayMcpStamp;
    assert.deepEqual(reconciledStamp.files["settings.json"], {});
  });
});

test("reconcile preserves a stamped entry that someone changed and relinquishes ownership", async () => {
  await withHome(async (home) => {
    await seedGatewayMcp(home, "claude", { gateways: [gateway()] });
    const settingsPath = join(home, "settings.json");
    const settings = await json(settingsPath) as { mcpServers: Record<string, unknown> };
    settings.mcpServers.apiary = { command: "/user/replacement", args: [] };
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    await seedGatewayMcp(home, "claude", { gateways: [] });
    const after = await json(settingsPath) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(after.mcpServers.apiary, { command: "/user/replacement", args: [] });
    const stamp = await json(join(home, ".hive-gateways.json")) as GatewayMcpStamp;
    assert.deepEqual(stamp.files["settings.json"], {});
  });
});

test("a live gateway upserts a colliding unowned entry, then stamps the write", async () => {
  await withHome(async (home) => {
    const settingsPath = join(home, "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      mcpServers: { apiary: { command: "/old/unowned", args: ["legacy"] } },
    }));
    await seedGatewayMcp(home, "claude", { gateways: [gateway()] });
    const settings = await json(settingsPath) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(settings.mcpServers.apiary, { command: "/opt/apiary-mcp", args: [] });
    const stamp = await json(join(home, ".hive-gateways.json")) as GatewayMcpStamp;
    assert.deepEqual(stamp.files["settings.json"]?.apiary, { command: "/opt/apiary-mcp", args: [] });
  });
});

test("codex seeder merges named TOML tables and removes only stamped tables", async () => {
  await withHome(async (home) => {
    const configPath = join(home, "config.toml");
    await writeFile(configPath, [
      'model = "gpt-5.5"',
      "trusted_paths = [",
      '  "/tmp/one",',
      '  "/tmp/two",',
      "]",
      "",
      "[mcp_servers.user]",
      'command = "/usr/bin/user-mcp"',
      "args = []",
      "",
    ].join("\n"));

    await seedGatewayMcp(home, "codex", { gateways: [gateway()] });
    let config = await readFile(configPath, "utf8");
    assert.match(config, /model = "gpt-5\.5"/);
    assert.match(config, /\[mcp_servers\.user\]/);
    assert.match(config, /\[mcp_servers\.apiary\]\ncommand = "\/opt\/apiary-mcp"\nargs = \[\]/);
    assert.deepEqual((await seedGatewayMcp(home, "codex", { gateways: [gateway()] })).written, []);

    await seedGatewayMcp(home, "codex", { gateways: [] });
    config = await readFile(configPath, "utf8");
    assert.doesNotMatch(config, /mcp_servers\.apiary/);
    assert.match(config, /mcp_servers\.user/);
  });
});

test("malformed target configs and stamps are untouched", async () => {
  await withHome(async (home) => {
    const settingsPath = join(home, "settings.json");
    await writeFile(settingsPath, "{broken json\n");
    const result = await seedGatewayMcp(home, "claude", { gateways: [gateway()] });
    assert.equal(result.status, "skipped");
    assert.equal(await readFile(settingsPath, "utf8"), "{broken json\n");
    assert.equal(await stat(join(home, ".hive-gateways.json")).catch(() => null), null);
  });

  await withHome(async (home) => {
    const configPath = join(home, "config.toml");
    await writeFile(configPath, "this is not toml\n");
    const result = await seedGatewayMcp(home, "codex", { gateways: [gateway()] });
    assert.equal(result.status, "skipped");
    assert.equal(await readFile(configPath, "utf8"), "this is not toml\n");
  });

  await withHome(async (home) => {
    const stampPath = join(home, ".hive-gateways.json");
    await writeFile(stampPath, "{broken stamp\n");
    const result = await seedGatewayMcp(home, "claude", { gateways: [gateway()] });
    assert.equal(result.status, "skipped");
    assert.equal(await readFile(stampPath, "utf8"), "{broken stamp\n");
    assert.equal(await stat(join(home, "settings.json")).catch(() => null), null);
  });
});

test("kit ownership manifest makes honeybee defer the whole target file", async () => {
  for (const [harness, target] of [["claude", "settings.json"], ["codex", "config.toml"]] as const) {
    await withHome(async (home) => {
      const targetPath = join(home, target);
      const original = harness === "claude" ? '{"theme":"dark"}\n' : 'model = "gpt-5.5"\n';
      await writeFile(targetPath, original);
      await mkdir(join(home, ".kit"), { recursive: true });
      await writeFile(join(home, ".kit", "manifest.json"), JSON.stringify({
        schema: 1,
        entries: [{ kind: "json-keys", path: target, keys: ["mcpServers.kit"], artifact: "mcp" }],
      }));
      const result = await seedGatewayMcp(home, harness, { gateways: [gateway()] });
      assert.equal(result.status, "skipped");
      assert.match(result.reason ?? "", /kit owns/);
      assert.equal(await readFile(targetPath, "utf8"), original);
      assert.equal(await stat(join(home, ".hive-gateways.json")).catch(() => null), null);
    });
  }
});

test("empty registry is a no-op and unsupported harnesses skip", async () => {
  await withHome(async (home) => {
    assert.deepEqual(await seedGatewayMcp(home, "claude", { gateways: [] }), { status: "seeded", written: [] });
    assert.equal(await stat(join(home, ".hive-gateways.json")).catch(() => null), null);
    const unsupported = await seedGatewayMcp(home, "opencode", { gateways: [gateway()] });
    assert.equal(unsupported.status, "skipped");
    assert.match(unsupported.reason ?? "", /no MCP config dialect/);
  });
});
