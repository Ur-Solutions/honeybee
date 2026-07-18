import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnBee } from "../src/commands/spawn.js";
import { remoteHarnessPolicyError } from "../src/hsr/remoteHost.js";
import type { NodeRecord } from "../src/node.js";

test("Grok remote HSR is rejected before transport or credential handling", async () => {
  assert.match(remoteHarnessPolicyError("grok") ?? "", /local-only/);
  assert.equal(remoteHarnessPolicyError("codex"), undefined);
  const root = await mkdtemp(join(tmpdir(), "honeybee-grok-remote-policy-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = root;
  const node: NodeRecord = {
    name: "remote-grok",
    kind: "remote-hsr",
    endpoint: "unreachable.invalid",
    capabilities: ["grok"],
    authPolicy: "ephemeral-token",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    await assert.rejects(
      spawnBee({ agent: "grok", node, extraArgs: [], cwd: root, yolo: true }),
      /grok HSR is local-only: remote credential delivery is not implemented or tested/,
    );
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
