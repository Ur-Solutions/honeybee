// Terminal-cursor re-probe (cell-smoothness Phase 2): a de-indexed record
// whose stale crashed/dead cursor contradicts a verifiably-live HSR host
// self-heals within one sweep; anything less than birth-fingerprint proof of
// life leaves the cursor alone (a genuinely dead runner never resurrects).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTerminalReprobeSweeper, reprobeTerminalCursors } from "../src/daemon/terminalReprobe.js";
import { ensureHsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import { isActiveSessionRecord, loadSession, saveSession, type SessionRecord } from "../src/store.js";

const hostBirth = { pgid: 4747, startedAt: "Fri Aug  7 10:00:00 2026" };

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-terminal-reprobe-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function record(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: name,
    substrate: "hsr",
    runnerPid: hostBirth.pgid,
    id: name,
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
    status: "running",
    lastObservedState: "crashed",
    lastObservedStateAt: "2026-08-10T08:00:00.000Z",
    ...overrides,
  };
}

async function seedMeta(bee: string, status: "running" | "exited" = "running"): Promise<void> {
  await ensureHsrRunDir(bee);
  await writeHsrMeta(bee, {
    bee,
    harness: "stub",
    tier: "stream",
    hostPid: hostBirth.pgid,
    hostFingerprint: hostBirth,
    childAdmission: "none",
    startedAt: "2026-08-07T10:00:00.000Z",
    controlSocket: join("/tmp", `${bee}.sock`),
    status,
  });
}

test("a live runner behind a stale crashed cursor self-heals within one sweep", async () => {
  await withTempStore(async () => {
    const bee = "reprobe-heals";
    await saveSession(record(bee));
    await seedMeta(bee);
    assert.equal(isActiveSessionRecord((await loadSession(bee))!), false, "the seeded record is de-indexed");

    const outcomes = await reprobeTerminalCursors({
      isHostAlive: () => true,
      inspectHost: async () => "match",
    });

    assert.deepEqual(outcomes, [{ bee, action: "healed", clearedState: "crashed" }]);
    const healed = await loadSession(bee);
    assert.equal(healed?.lastObservedState, undefined, "the stale cursor is cleared");
    assert.equal(healed?.lastObservedStateAt, undefined);
    assert.equal(isActiveSessionRecord(healed!), true, "the record re-enters the active index");
  });
});

test("a genuinely dead runner does not resurrect", async () => {
  await withTempStore(async () => {
    const bee = "reprobe-dead-host";
    await saveSession(record(bee));
    await seedMeta(bee);

    const outcomes = await reprobeTerminalCursors({
      isHostAlive: () => false,
      inspectHost: async () => { throw new Error("must not fingerprint-probe a dead pid"); },
    });

    assert.deepEqual(outcomes, []);
    const untouched = await loadSession(bee);
    assert.equal(untouched?.lastObservedState, "crashed", "the terminal cursor stands");
    assert.equal(isActiveSessionRecord(untouched!), false);
  });
});

test("a recycled pid (birth mismatch) or uncertain census is not proof of life", async () => {
  await withTempStore(async () => {
    for (const [bee, verdict] of [
      ["reprobe-mismatch", "mismatch"],
      ["reprobe-unverifiable", "unverifiable"],
    ] as const) {
      await saveSession(record(bee));
      await seedMeta(bee);
      const outcomes = await reprobeTerminalCursors({
        isHostAlive: () => true,
        inspectHost: async () => verdict,
      });
      assert.deepEqual(outcomes, [], `${verdict} must not heal`);
      assert.equal((await loadSession(bee))?.lastObservedState, "crashed");
    }
  });
});

test("only the false-crash class heals: deliberate terminal cursors and exited metas stand", async () => {
  await withTempStore(async () => {
    // A sealed/done cursor is a deliberate outcome, not a mislabel.
    await saveSession(record("reprobe-done", { lastObservedState: "done" }));
    await seedMeta("reprobe-done");
    // An exited meta agrees with the crashed cursor — nothing to heal.
    await saveSession(record("reprobe-exited-meta"));
    await seedMeta("reprobe-exited-meta", "exited");
    // A record already held in the work set (recovery obligation) is the
    // ordinary tick's to re-observe, not this sweep's.
    await saveSession(record("reprobe-active", { recoveryRequestedAt: "2026-08-10T08:00:00.000Z" }));
    await seedMeta("reprobe-active");

    const outcomes = await reprobeTerminalCursors({
      isHostAlive: () => true,
      inspectHost: async () => "match",
    });

    assert.deepEqual(outcomes, []);
    assert.equal((await loadSession("reprobe-done"))?.lastObservedState, "done");
    assert.equal((await loadSession("reprobe-exited-meta"))?.lastObservedState, "crashed");
    assert.equal((await loadSession("reprobe-active"))?.lastObservedState, "crashed");
  });
});

test("the tick-wired sweeper throttles to one pass per interval", async () => {
  await withTempStore(async () => {
    const bee = "reprobe-throttle";
    await saveSession(record(bee));
    await seedMeta(bee);
    let sweeps = 0;
    let nowMs = 1_000_000;
    const sweeper = createTerminalReprobeSweeper({
      isHostAlive: () => { sweeps += 1; return false; },
      intervalMs: 60_000,
      now: () => nowMs,
    });

    await sweeper();
    assert.equal(sweeps, 1, "the first eligible tick sweeps");
    await sweeper();
    assert.equal(sweeps, 1, "a tick inside the interval is a no-op");
    nowMs += 60_000;
    await sweeper();
    assert.equal(sweeps, 2, "the next interval sweeps again");
  });
});
