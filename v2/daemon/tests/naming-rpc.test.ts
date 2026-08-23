import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NAMING_DEFAULTS } from "../src/config.ts";
import type { ConfigGetResult, ConfigPatchResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";

test("config.get returns naming defaults; config.patch merges onto disk", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const got = (await client.request("config.get", {})) as ConfigGetResult;
    assert.equal(got.naming.auto, false, "test dirs disable the titler so they never shell out");
    assert.equal(got.naming.backend, NAMING_DEFAULTS.backend);
    assert.equal(got.naming.tool, NAMING_DEFAULTS.tool);
    assert.equal(got.naming.model, NAMING_DEFAULTS.model);
    assert.equal(got.naming.effort, NAMING_DEFAULTS.effort);
    assert.equal(got.configPath, join(dir, "config.json"));

    const patched = (await client.request("config.patch", {
      naming: { auto: false, model: "gpt-5.6-terra", effort: "low" },
      idempotencyKey: "cfg-1",
    })) as ConfigPatchResult;
    assert.equal(patched.naming.auto, false);
    assert.equal(patched.naming.model, "gpt-5.6-terra");
    assert.equal(patched.naming.effort, "low");
    assert.equal(patched.naming.tool, NAMING_DEFAULTS.tool);
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
      naming: { model: string; effort: string };
    };
    assert.equal(onDisk.naming.model, "gpt-5.6-terra");
    assert.equal(onDisk.naming.effort, "low");

    const replay = (await client.request("config.patch", {
      naming: { model: "ignored" },
      idempotencyKey: "cfg-1",
    })) as ConfigPatchResult;
    assert.equal(replay.naming.model, "gpt-5.6-terra", "idempotent replay keeps the first write");

    const api = (await client.request("config.patch", {
      naming: { backend: "openai-api", apiKey: "sk-test-write-only", effort: "none" },
      idempotencyKey: "cfg-api",
    })) as ConfigPatchResult;
    assert.equal(api.naming.backend, "openai-api");
    assert.equal(api.naming.apiKeyConfigured, true);
    assert.doesNotMatch(JSON.stringify(api), /sk-test-write-only/);
    const apiOnDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
      naming: { apiKey: string };
    };
    assert.equal(apiOnDisk.naming.apiKey, "sk-test-write-only");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
