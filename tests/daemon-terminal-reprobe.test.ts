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
import { ensureHsrRunDir, readHsrMetaStrict, writeHsrMeta, type HsrMeta } from "../src/hsr/runDir.js";
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

async function saveTerminalRecord(value: SessionRecord): Promise<void> {
  await saveSession(value, {
    probeEvidence: {
      kind: "probe",
      probeId: `fixture:${value.name}`,
      observerId: "terminal-reprobe-fixture",
      observedAt: value.lastObservedStateAt ?? value.updatedAt,
      outcome: value.lastObservedState === "done" ? "alive" : "dead",
      target: { substrate: "hsr", runnerPid: value.runnerPid },
      detail: "test fixture terminal observation",
    },
  });
}

async function seedMeta(
  bee: string,
  status: "running" | "exited" = "running",
  overrides: Partial<HsrMeta> = {},
): Promise<void> {
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
    ...overrides,
  });
}

test("a live runner behind a stale crashed cursor self-heals within one sweep", async () => {
  await withTempStore(async () => {
    const bee = "reprobe-heals";
    await saveTerminalRecord(record(bee));
    await seedMeta(bee);
    assert.equal(isActiveSessionRecord((await loadSession(bee))!), true, "the terminal cursor stays in the probe set");

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
    await saveTerminalRecord(record(bee));
    await seedMeta(bee);

    const outcomes = await reprobeTerminalCursors({
      isHostAlive: () => false,
      inspectHost: async () => { throw new Error("must not fingerprint-probe a dead pid"); },
    });

    assert.deepEqual(outcomes, []);
    const untouched = await loadSession(bee);
    assert.equal(untouched?.lastObservedState, "crashed", "the terminal cursor stands");
    assert.equal(isActiveSessionRecord(untouched!), true, "absence of a live probe does not de-index active lifecycle");
  });
});

test("a recycled pid (birth mismatch) or uncertain census is not proof of life", async () => {
  await withTempStore(async () => {
    for (const [bee, verdict] of [
      ["reprobe-mismatch", "mismatch"],
      ["reprobe-unverifiable", "unverifiable"],
    ] as const) {
      await saveTerminalRecord(record(bee));
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
    await saveTerminalRecord(record("reprobe-done", { lastObservedState: "done" }));
    await seedMeta("reprobe-done");
    // An exited meta agrees with the crashed cursor — nothing to heal.
    await saveTerminalRecord(record("reprobe-exited-meta"));
    await seedMeta("reprobe-exited-meta", "exited");
    // A record already held in the work set (recovery obligation) is the
    // ordinary tick's to re-observe, not this sweep's.
    await saveTerminalRecord(record("reprobe-active", { recoveryRequestedAt: "2026-08-10T08:00:00.000Z" }));
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

test("a mis-reaped exited meta with a verifiably live host restores to running, cursor and all, in one sweep", async () => {
  await withTempStore(async () => {
    const bee = "reprobe-meta-restore";
    await saveTerminalRecord(record(bee));
    const nowMs = Date.parse("2026-08-10T12:00:00.000Z");
    await seedMeta(bee, "exited", {
      endedAt: "2026-08-10T11:58:00.000Z", // two minutes ago — past the grace
      exitCode: null,
    });

    const outcomes = await reprobeTerminalCursors({
      isHostAlive: () => true,
      inspectHost: async () => "match",
      now: () => nowMs,
    });

    assert.deepEqual(outcomes, [
      { bee, action: "meta-restored" },
      { bee, action: "healed", clearedState: "crashed" },
    ]);
    const meta = await readHsrMetaStrict(bee);
    assert.equal(meta?.status, "running", "the exited stamp is restored");
    assert.equal(meta?.endedAt, undefined, "the reap's endedAt is removed");
    assert.equal(meta?.exitCode, undefined);
    const healed = await loadSession(bee);
    assert.equal(healed?.lastObservedState, undefined, "the record cursor heals in the same pass");
    assert.equal(isActiveSessionRecord(healed!), true);
  });
});

test("a recycled pid never restores an exited meta: birth mismatch is pid reuse", async () => {
  await withTempStore(async () => {
    const nowMs = Date.parse("2026-08-10T12:00:00.000Z");
    for (const [bee, verdict] of [
      ["reprobe-meta-pid-reuse", "mismatch"],
      ["reprobe-meta-uncertain", "unverifiable"],
      ["reprobe-meta-gone", "gone"],
    ] as const) {
      await saveTerminalRecord(record(bee));
      await seedMeta(bee, "exited", { endedAt: "2026-08-10T11:00:00.000Z", exitCode: null });
      const outcomes = await reprobeTerminalCursors({
        isHostAlive: () => true,
        inspectHost: async () => verdict,
        now: () => nowMs,
      });
      assert.deepEqual(outcomes, [], `${verdict} must not restore`);
      const meta = await readHsrMetaStrict(bee);
      assert.equal(meta?.status, "exited", `${verdict}: the exited stamp stands`);
      assert.equal(meta?.endedAt, "2026-08-10T11:00:00.000Z");
      assert.equal((await loadSession(bee))?.lastObservedState, "crashed");
    }
  });
});

test("the inverse meta heal fails closed: dead pid, fresh exit, missing endedAt, startup failure", async () => {
  await withTempStore(async () => {
    const nowMs = Date.parse("2026-08-10T12:00:00.000Z");
    // A genuinely dead host is reap territory, not restore territory.
    await seedMeta("meta-dead-pid", "exited", { hostPid: 9999, endedAt: "2026-08-10T11:00:00.000Z" });
    // A just-written exited stamp may be a clean shutdown mid-exit.
    await seedMeta("meta-fresh-exit", "exited", { endedAt: "2026-08-10T11:59:55.000Z" });
    // No endedAt: uncertainty, never proof of a mis-reap.
    await seedMeta("meta-no-endedat", "exited");
    // The host's own startup-failure testimony is not a reap artifact.
    await seedMeta("meta-startup-failure", "exited", {
      endedAt: "2026-08-10T11:00:00.000Z",
      startupFailure: { stage: "adapter-start", message: "harness failed during startup" },
    });
    for (const bee of ["meta-dead-pid", "meta-fresh-exit", "meta-no-endedat", "meta-startup-failure"]) {
      await saveTerminalRecord(record(bee));
    }

    const outcomes = await reprobeTerminalCursors({
      isHostAlive: (pid) => pid === hostBirth.pgid,
      inspectHost: async (meta) => {
        if (meta.hostPid !== hostBirth.pgid) throw new Error("must not fingerprint-probe a dead pid");
        return "match";
      },
      now: () => nowMs,
    });

    assert.deepEqual(outcomes, []);
    for (const bee of ["meta-dead-pid", "meta-fresh-exit", "meta-no-endedat", "meta-startup-failure"]) {
      assert.equal((await readHsrMetaStrict(bee))?.status, "exited", `${bee}: the exited stamp stands`);
    }
  });
});

test("the tick-wired sweeper throttles to one pass per interval", async () => {
  await withTempStore(async () => {
    const bee = "reprobe-throttle";
    await saveTerminalRecord(record(bee));
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
