import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clearPendingHsrTurns,
  enqueuePendingHsrTurn,
  readPendingHsrTurns,
  readStagedPendingHsrTurns,
  withHsrTurnDeliveryLock,
} from "../src/hsr/pendingTurns.js";
import { reviveHsrForAutomaticRecovery } from "../src/recovery/revive.js";
import type { SessionRecord } from "../src/store.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-runtime-revive-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = root;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function record(bee: string): SessionRecord {
  return {
    name: bee,
    agent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: bee,
    substrate: "hsr",
    providerSessionId: "provider-thread",
    runtimeGeneration: 2,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    status: "running",
  };
}

test("automatic revive stages before ordinary stop clears pending turns, then restores exact ids", async () => {
  await withTempStore(async () => {
    const bee = "CO.auto-revive";
    const original = await withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, "resume exact work"));
    let sawStagedBeforeRevive = false;
    let drained: Awaited<ReturnType<typeof readPendingHsrTurns>> = [];
    const result = await reviveHsrForAutomaticRecovery(record(bee), "episode-1", {
      revive: async (candidate) => {
        sawStagedBeforeRevive = (await readStagedPendingHsrTurns(bee))?.turns[0]?.id === original.id;
        await clearPendingHsrTurns(bee); // ordinary stop behavior
        return { ...candidate, runtimeGeneration: 3 };
      },
      drain: async () => {
        drained = await readPendingHsrTurns(bee);
        return drained.length;
      },
    });

    assert.equal(sawStagedBeforeRevive, true);
    assert.deepEqual(drained, [original]);
    assert.equal(result.replayedTurns, 1);
    assert.equal(result.record.runtimeGeneration, 3);
    assert.equal(await readStagedPendingHsrTurns(bee), null);
  });
});
