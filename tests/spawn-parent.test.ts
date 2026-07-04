import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSpawningBeeId } from "../src/spawnParent.js";

// Snapshot + restore the env keys the resolver reads.
function snapshotEnv() {
  const keys = ["HIVE_STORE_ROOT", "HIVE_BEE", "TMUX", "TMUX_PANE"] as const;
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  return () => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  };
}

test("resolveSpawningBeeId: HIVE_BEE anchors to the bee's id; no anchor → undefined", async () => {
  const store = await mkdtemp(join(tmpdir(), "hb-store-"));
  const restore = snapshotEnv();
  try {
    process.env.HIVE_STORE_ROOT = store;
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    await mkdir(join(store, "sessions"), { recursive: true });
    await writeFile(
      join(store, "sessions", "orch.json"),
      JSON.stringify({
        name: "orch",
        agent: "claude",
        cwd: "/x",
        command: "claude",
        tmuxTarget: "orch",
        createdAt: "2026-07-04T00:00:00Z",
        updatedAt: "2026-07-04T00:00:00Z",
        status: "running",
        id: "CL.orch",
      }),
    );

    process.env.HIVE_BEE = "orch";
    assert.equal(await resolveSpawningBeeId(), "CL.orch");

    // Unknown bee name → no match → undefined.
    process.env.HIVE_BEE = "ghost";
    assert.equal(await resolveSpawningBeeId(), undefined);

    // No anchor at all (operator/daemon root) → undefined, no store read needed.
    delete process.env.HIVE_BEE;
    assert.equal(await resolveSpawningBeeId(), undefined);
  } finally {
    restore();
    await rm(store, { recursive: true, force: true });
  }
});
