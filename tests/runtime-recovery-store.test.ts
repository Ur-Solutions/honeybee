import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  beginRuntimeRecovery,
  claimRuntimeRecoveryAttempt,
  finishRuntimeRecoveryAttempt,
  readRuntimeRecovery,
  resetRuntimeRecovery,
  runtimeRecoveryBackoffMs,
} from "../src/recovery/store.js";
import { recoveryFailedRequestId } from "../src/requests/keys.js";

const START = Date.parse("2026-08-11T12:00:00.000Z");
const noJitter = () => 0.5;

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-runtime-recovery-"));
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

test("runtime recovery uses the contracted backoff schedule with bounded jitter", () => {
  assert.deepEqual(
    Array.from({ length: 10 }, (_, index) => runtimeRecoveryBackoffMs(index + 1, noJitter)),
    [15_000, 60_000, 300_000, 900_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000],
  );
  assert.equal(runtimeRecoveryBackoffMs(1, () => 0), 13_500);
  assert.equal(runtimeRecoveryBackoffMs(1, () => 1), 16_500);
});

test("recovery backoff and attempt budget survive a simulated daemon restart", async () => {
  await withTempStore(async () => {
    const started = await beginRuntimeRecovery({
      bee: "CO.recover",
      generation: 4,
      probeId: "probe-dead-1",
      episodeId: "episode-1",
      nowMs: START,
      random: noJitter,
    });
    assert.equal(started.nextAttemptAt, new Date(START + 15_000).toISOString());

    assert.equal((await claimRuntimeRecoveryAttempt({ bee: "CO.recover", nowMs: START + 14_999 })).action, "deferred");
    const first = await claimRuntimeRecoveryAttempt({
      bee: "CO.recover",
      nowMs: START + 15_000,
      random: noJitter,
      attemptId: "attempt-1",
    });
    assert.equal(first.action, "claimed");
    if (first.action !== "claimed") return;
    await finishRuntimeRecoveryAttempt({
      bee: "CO.recover",
      attemptId: first.attempt.attemptId,
      outcome: "failed",
      error: "provider still unavailable",
      nowMs: START + 16_000,
      random: noJitter,
    });

    // A new supervisor instance has no memory, but the store still enforces
    // attempt two's one-minute boundary and carries attempt one's history.
    const afterRestart = await readRuntimeRecovery("CO.recover");
    assert.equal(afterRestart?.attempts.length, 1);
    assert.equal(afterRestart?.nextAttemptAt, new Date(START + 76_000).toISOString());
    assert.equal((await claimRuntimeRecoveryAttempt({ bee: "CO.recover", nowMs: START + 75_999 })).action, "deferred");
    assert.equal((await claimRuntimeRecoveryAttempt({
      bee: "CO.recover",
      nowMs: START + 76_000,
      random: noJitter,
      attemptId: "attempt-2",
    })).action, "claimed");
  });
});

test("an attempt lease fences overlap across restart and consumes budget when abandoned", async () => {
  await withTempStore(async () => {
    await beginRuntimeRecovery({
      bee: "CO.lease",
      generation: 1,
      probeId: "probe-dead",
      nowMs: START,
      random: noJitter,
    });
    const claimed = await claimRuntimeRecoveryAttempt({
      bee: "CO.lease",
      nowMs: START + 15_000,
      leaseMs: 10_000,
      attemptId: "leased-attempt",
      random: noJitter,
    });
    assert.equal(claimed.action, "claimed");
    assert.equal((await claimRuntimeRecoveryAttempt({ bee: "CO.lease", nowMs: START + 20_000 })).action, "deferred");

    const expired = await claimRuntimeRecoveryAttempt({
      bee: "CO.lease",
      nowMs: START + 25_000,
      random: noJitter,
    });
    assert.equal(expired.action, "deferred");
    if (expired.action === "deferred") assert.equal(expired.reason, "attempt-lease-expired");
    assert.equal(expired.record.attempts[0]?.outcome, "failed");
    assert.equal(expired.record.nextAttemptAt, new Date(START + 85_000).toISOString());
  });
});

test("ten failed attempts exhaust once, and explicit reset clears the persisted budget", async () => {
  await withTempStore(async () => {
    await beginRuntimeRecovery({
      bee: "CO.exhaust",
      generation: 2,
      probeId: "probe-dead",
      episodeId: "episode-exhaust",
      nowMs: START,
      random: noJitter,
    });
    let now = START;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const current = await readRuntimeRecovery("CO.exhaust");
      now = Date.parse(current!.nextAttemptAt!);
      const claim = await claimRuntimeRecoveryAttempt({
        bee: "CO.exhaust",
        nowMs: now,
        attemptId: `attempt-${attempt}`,
        random: noJitter,
      });
      assert.equal(claim.action, "claimed");
      await finishRuntimeRecoveryAttempt({
        bee: "CO.exhaust",
        attemptId: `attempt-${attempt}`,
        outcome: "failed",
        error: `failure ${attempt}`,
        nowMs: now + 1,
        random: noJitter,
      });
    }
    const exhausted = await readRuntimeRecovery("CO.exhaust");
    assert.equal(exhausted?.status, "failed");
    assert.equal(exhausted?.attempts.length, 10);
    assert.equal((await claimRuntimeRecoveryAttempt({ bee: "CO.exhaust", nowMs: now + 10_000 })).action, "exhausted");
    assert.equal(
      recoveryFailedRequestId("CO.exhaust", exhausted!.episodeId),
      "manual:CO.exhaust:recovery-failed:episode-exhaust",
    );

    await resetRuntimeRecovery("CO.exhaust");
    assert.equal(await readRuntimeRecovery("CO.exhaust"), null);
  });
});
