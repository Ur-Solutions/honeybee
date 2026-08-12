import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnBee } from "../src/commands/spawn.js";
import type { AccountRecord } from "../src/accounts.js";
import type { NodeRecord } from "../src/node.js";
import { remoteHarnessPolicyError } from "../src/hsr/remoteHost.js";

// APIA-93 flip: Kimi is now remote-HSR capable (credentials/kimi-code.json
// shipped with the rotating refresh token blanked). The old local-only policy
// gate no longer fires; an account-bound spawn now reaches ephemeral minting.
test("Kimi remote HSR is past the local-only gate; an account-bound spawn reaches minting", async () => {
  assert.equal(remoteHarnessPolicyError("kimi"), undefined, "kimi is no longer rejected at the local-only policy gate");
  assert.equal(remoteHarnessPolicyError("codex"), undefined);
  const root = await mkdtemp(join(tmpdir(), "honeybee-kimi-remote-policy-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = root;
  const node: NodeRecord = {
    name: "remote-kimi",
    kind: "remote-hsr",
    endpoint: "unreachable.invalid",
    capabilities: ["kimi"],
    authPolicy: "ephemeral-token",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // No vaulted credential → minting fails HERE (fast, local), proving the spawn
  // got PAST the harness policy gate rather than reaching the unreachable node.
  const account: AccountRecord = {
    id: "kimi-acct",
    tool: "kimi",
    label: "x",
    provider: "moonshot",
    addedAt: new Date().toISOString(),
  };
  try {
    await assert.rejects(
      spawnBee({ agent: "kimi", node, account, extraArgs: [], cwd: root, yolo: true }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /local-only/, "the local-only gate must no longer fire for kimi");
        assert.match(error.message, /could not mint an ephemeral credential|no primary credential/);
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
