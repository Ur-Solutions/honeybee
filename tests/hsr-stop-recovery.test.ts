import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHsrSubstrate } from "../src/hsr/substrate.js";
import { ensureHsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import {
  createHsrStopRecoveryDispatcher,
  runHsrStopRecoverySweep,
} from "../src/daemon/hsrStopRecovery.js";
import { transactionalKill, transactionalRetire } from "../src/kill.js";
import { loadSession, saveSession, type HsrEventIntegrityDoubt, type SessionRecord } from "../src/store.js";
import type { KillResult, Substrate } from "../src/substrates/types.js";

const NOW = Date.parse("2026-08-16T10:00:00.000Z");
const hostBirth = { pgid: 5101, startedAt: "Fri Aug 16 10:00:00 2026" };
const childBirth = { pgid: 5202, startedAt: "Fri Aug 16 10:00:01 2026" };

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-hsr-stop-recovery-"));
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

function record(name: string, action: "kill" | "retire", generation = 3): SessionRecord {
  return {
    name,
    agent: "stub",
    requestedAgent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: name,
    substrate: "hsr",
    createdAt: "2026-08-16T09:00:00.000Z",
    updatedAt: "2026-08-16T09:00:00.000Z",
    status: "kill_failed",
    runtimeGeneration: generation,
    stopIntent: {
      version: 1,
      action,
      generation,
      requestedAt: "2026-08-16T09:00:00.000Z",
      attempts: 0,
      nextAttemptAt: "2026-08-16T09:59:00.000Z",
    },
  };
}

function killResult(ok: boolean, stderr = ""): KillResult {
  return { ok, stdout: "", stderr, exitCode: ok ? 0 : 1 };
}

function fakeSubstrate(overrides: Partial<Substrate>): Substrate {
  return {
    kind: "hsr",
    node: "local",
    hasSession: async () => false,
    kill: async () => killResult(true),
    ...overrides,
  } as Substrate;
}

async function writeRuntimeMeta(name: string): Promise<void> {
  await ensureHsrRunDir(name);
  await writeHsrMeta(name, {
    bee: name,
    harness: "stub",
    tier: "stream",
    hostPid: hostBirth.pgid,
    hostFingerprint: hostBirth,
    childPid: childBirth.pgid,
    childPgid: childBirth.pgid,
    childFingerprint: childBirth,
    childAdmission: "admitted",
    startedAt: "2026-08-16T10:00:00.000Z",
    controlSocket: join("/tmp", `${name}-missing.sock`),
    status: "running",
  });
}

test("HSR stop recovery retries after cooldown and purges a kill intent after exact stop proof", async () => {
  await withTempStore(async () => {
    const session = record("retry-kill", "kill");
    await saveSession(session);
    let live = true;
    let stops = 0;
    const substrate = fakeSubstrate({
      hasSession: async () => live,
      kill: async () => {
        stops += 1;
        if (stops === 1) return killResult(false, "fixture stop still live");
        live = false;
        return killResult(true);
      },
    });

    const first = await runHsrStopRecoverySweep([session], {
      now: () => NOW,
      baseDelayMs: 10_000,
      killRecord: (candidate) => transactionalKill(candidate, { substrate, pollIntervalMs: 0, emitLedger: false }),
    });
    assert.equal(first[0]?.action, "failed");
    assert.equal(first[0]?.attempt, 1);
    assert.equal(stops, 1);
    const afterFirst = (await loadSession(session.name))!;
    assert.equal(afterFirst.stopIntent?.attempts, 1);
    assert.equal(afterFirst.stopIntent?.nextAttemptAt, "2026-08-16T10:00:10.000Z");

    const cooledDown = await runHsrStopRecoverySweep([afterFirst], {
      now: () => NOW + 5_000,
      killRecord: async () => {
        throw new Error("cooldown should skip stop retry");
      },
    });
    assert.deepEqual(cooledDown, []);
    assert.equal(stops, 1);

    const second = await runHsrStopRecoverySweep([afterFirst], {
      now: () => NOW + 11_000,
      baseDelayMs: 10_000,
      killRecord: (candidate) => transactionalKill(candidate, { substrate, pollIntervalMs: 0, emitLedger: false }),
    });
    assert.equal(second[0]?.action, "killed");
    assert.equal(second[0]?.attempt, 2);
    assert.equal(await loadSession(session.name), null);
  });
});

test("HSR stop recovery refuses a stale snapshot after the canonical generation changes", async () => {
  await withTempStore(async () => {
    const stale = record("stale-generation", "kill", 3);
    const current: SessionRecord = {
      ...stale,
      status: "running",
      runtimeGeneration: 4,
      stopIntent: undefined,
    };
    await saveSession(current);
    let stops = 0;

    const outcomes = await runHsrStopRecoverySweep([stale], {
      now: () => NOW,
      killRecord: async () => {
        stops += 1;
        return { ok: true, alreadyGone: false, attempts: 1 };
      },
    });

    assert.equal(outcomes[0]?.action, "skipped");
    assert.equal(stops, 0);
    assert.equal((await loadSession(stale.name))?.runtimeGeneration, 4);
  });
});

test("HSR stop recovery blocks non-retryable event-integrity fences without signalling", async () => {
  await withTempStore(async () => {
    const integrity: HsrEventIntegrityDoubt = {
      version: 1,
      integrityId: "integrity-1",
      source: {
        hostPid: hostBirth.pgid,
        startedAt: "2026-08-16T10:00:00.000Z",
        hostFingerprint: hostBirth,
      },
      createdAt: "2026-08-16T10:00:01.000Z",
      fenceError: "HSR event history integrity is unresolved (integrity-1)",
    };
    const session: SessionRecord = { ...record("integrity-fenced", "retire"), eventIntegrityDoubt: integrity };
    await saveSession(session);
    let stops = 0;

    const outcomes = await runHsrStopRecoverySweep([session], {
      now: () => NOW,
      retireRecord: async () => {
        stops += 1;
        return { ok: true, alreadyGone: false, attempts: 1 };
      },
    });

    assert.equal(outcomes[0]?.action, "integrity");
    assert.equal(stops, 0);
    const persisted = await loadSession(session.name);
    assert.equal(persisted?.stopIntent?.blockedReason, "event-integrity");
    assert.equal(persisted?.stopIntent?.nextAttemptAt, undefined);
  });
});

test("HSR stop recovery persists cooldown across daemon restarts", async () => {
  await withTempStore(async () => {
    const session = record("restart-idempotent", "kill");
    await saveSession(session);
    let stops = 0;
    const substrate = fakeSubstrate({
      hasSession: async () => true,
      kill: async () => {
        stops += 1;
        return killResult(false, "still live");
      },
    });

    await runHsrStopRecoverySweep([session], {
      now: () => NOW,
      baseDelayMs: 30_000,
      killRecord: (candidate) => transactionalKill(candidate, { substrate, pollAttempts: 1, pollIntervalMs: 0, emitLedger: false }),
    });
    const afterRestart = (await loadSession(session.name))!;
    await runHsrStopRecoverySweep([afterRestart], {
      now: () => NOW + 1_000,
      killRecord: async () => {
        stops += 1;
        return { ok: true, alreadyGone: false, attempts: 1 };
      },
    });

    assert.equal(stops, 1, "second daemon pass respects the persisted nextAttemptAt");
    assert.equal((await loadSession(session.name))?.stopIntent?.attempts, 1);
  });
});

test("HSR stop recovery dispatcher does not overlap background sweeps", async () => {
  const session = record("single-flight", "kill");
  let starts = 0;
  const dispatcher = createHsrStopRecoveryDispatcher({
    startBackground: () => {
      starts += 1;
    },
    now: () => NOW,
  });

  assert.deepEqual(await dispatcher([session]), []);
  assert.deepEqual(await dispatcher([session]), []);
  assert.equal(starts, 1);
});

test("HSR stop recovery dispatcher joins its tracked sweep during shutdown", async () => {
  await withTempStore(async () => {
    const session = record("shutdown-join", "kill");
    await saveSession(session);
    let run: (() => Promise<void>) | undefined;
    let finished = false;
    const dispatcher = createHsrStopRecoveryDispatcher({
      startBackground: (job) => {
        run = job;
      },
      now: () => NOW,
      killRecord: async () => {
        finished = true;
        return { ok: false, lastError: "still live", stillRunning: true, attempts: 1 };
      },
      appendEvent: async () => undefined,
    });

    await dispatcher([session]);
    let closed = false;
    const closing = dispatcher.close?.().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false, "shutdown remains fenced while the retry is pending");
    await run?.();
    await closing;
    assert.equal(finished, true);
    assert.equal(closed, true);
  });
});

test("HSR stop recovery never signals a replaced host or child process group", async () => {
  await withTempStore(async () => {
    const session = record("replacement-refusal", "retire");
    await saveSession(session);
    await writeRuntimeMeta(session.name);
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const substrate = createHsrSubstrate({
      readProcessIdentity: async (pid) => {
        if (pid === hostBirth.pgid) return { pgid: hostBirth.pgid, startedAt: "replacement host birth" };
        if (pid === childBirth.pgid) return { pgid: childBirth.pgid, startedAt: "replacement child birth" };
        return null;
      },
      readProcessGroupPresence: async () => "present",
      isProcessGroupAlive: () => true,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
      },
      sleep: async () => undefined,
    });

    const outcomes = await runHsrStopRecoverySweep([session], {
      now: () => NOW,
      retireRecord: (candidate) => transactionalRetire(candidate, {
        substrate,
        pollAttempts: 1,
        pollIntervalMs: 0,
        emitLedger: false,
      }),
    });

    assert.equal(outcomes[0]?.action, "failed");
    assert.deepEqual(signals, [], "replacement PID/PGID evidence never authorizes a signal");
    assert.equal((await loadSession(session.name))?.status, "kill_failed");
  });
});
