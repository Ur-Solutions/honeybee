// enqueueTurnForBootingHsrHost — the no-wait spawn's first-prompt path.
// spawnBee returns before the detached host cold-starts, so the first turn is
// persisted against the forked host PID before meta.json exists and must be
// drained by the host's queued→running transition.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHsrHost } from "../src/hsr/host.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import {
  enqueuePendingHsrTurn,
  enqueueTurnForBootingHsrHost,
  createPendingHsrDeliveryGate,
  drainStagedPendingHsrTurns,
  readPendingHsrTurns,
  readStagedPendingHsrTurns,
  restorePendingHsrTurnsAfterRecovery,
  stagePendingHsrTurnsForRecovery,
  withHsrTurnDeliveryLock,
} from "../src/hsr/pendingTurns.js";
import { hsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import { hsrSubstrate } from "../src/hsr/substrate.js";
import { captureProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import type { RunnerOpts } from "../src/hsr/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Set HIVE_STORE_ROOT to a fresh mkdtemp dir for the duration of `fn`. */
async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-pending-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function optsFor(bee: string): RunnerOpts {
  return {
    bee,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    runDir: hsrRunDir(bee),
  };
}

/** A PID that is certainly not alive (past kernel pid ranges on macOS/Linux). */
const DEAD_PID = 2 ** 30;

test("enqueueTurnForBootingHsrHost: persists a turn before meta exists when the host pid is alive", async () => {
  await withTempStore(async () => {
    const bee = "preboot";
    const identity = await captureProcessBirthFingerprint(process.pid);
    assert.ok(identity);
    assert.equal(await enqueueTurnForBootingHsrHost(bee, process.pid, "hello", identity), true);
    const files = await readdir(join(hsrRunDir(bee), "pending-turns"));
    assert.equal(files.filter((name) => name.endsWith(".json")).length, 1);
  });
});

test("enqueueTurnForBootingHsrHost: refuses when the host pid is dead or missing", async () => {
  await withTempStore(async () => {
    assert.equal(await enqueueTurnForBootingHsrHost("deadhost", DEAD_PID, "hello"), false);
    assert.equal(await enqueueTurnForBootingHsrHost("nohost", undefined, "hello"), false);
  });
});

test("enqueueTurnForBootingHsrHost: refuses on a running or exited meta (caller uses the live path)", async () => {
  await withTempStore(async () => {
    const bee = "poststartup";
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      startedAt: new Date().toISOString(),
      controlSocket: join(hsrRunDir(bee), "control.sock"),
      status: "running",
    });
    assert.equal(await enqueueTurnForBootingHsrHost(bee, process.pid, "hello"), false);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      startedAt: new Date().toISOString(),
      controlSocket: join(hsrRunDir(bee), "control.sock"),
      status: "exited",
      exitCode: 0,
      endedAt: new Date().toISOString(),
    });
    assert.equal(await enqueueTurnForBootingHsrHost(bee, process.pid, "hello"), false);
  });
});

test("enqueueTurnForBootingHsrHost: accepts against a queued meta with a live host", async () => {
  await withTempStore(async () => {
    const bee = "queuedhost";
    const identity = await captureProcessBirthFingerprint(process.pid);
    assert.ok(identity);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      hostFingerprint: identity,
      startedAt: new Date().toISOString(),
      controlSocket: join(hsrRunDir(bee), "control.sock"),
      status: "queued",
    });
    assert.equal(await enqueueTurnForBootingHsrHost(bee, process.pid, "hello"), true);
    // ...but not when the recorded host pid is dead (crashed pre-drain).
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: DEAD_PID,
      startedAt: new Date().toISOString(),
      controlSocket: join(hsrRunDir(bee), "control.sock"),
      status: "queued",
    });
    assert.equal(await enqueueTurnForBootingHsrHost(bee, process.pid, "hello"), false);
  });
});

test("a turn enqueued before host boot is drained into the harness at queued→running", async () => {
  await withTempStore(async () => {
    const bee = "drainer";
    const identity = await captureProcessBirthFingerprint(process.pid);
    assert.ok(identity);
    assert.equal(await enqueueTurnForBootingHsrHost(bee, process.pid, "hello-from-before-boot", identity), true);
    const handle = await runHsrHost({
      bee,
      adapter: stubAdapter,
      opts: optsFor(bee),
      queueStartup: true,
      processBirthCapture: {
        timeoutMs: 0,
        capture: async (pid) => ({ pgid: pid, startedAt: `test-birth:${pid}` }),
      },
    });
    try {
      const sub = hsrSubstrate();
      await waitFor(
        async () => (await sub.capture(bee, 50)).includes("echo:hello-from-before-boot"),
        "pre-boot turn echoed by the harness",
      );
      await waitFor(async () => (await readPendingHsrTurns(bee)).length === 0, "successful turn journal ack");
    } finally {
      await handle.stop();
    }
  });
});

test("queued-turn handoff refuses a recycled host PID before meta publication", async () => {
  await withTempStore(async () => {
    const recorded = { pgid: 8181, startedAt: "Mon Aug  7 09:00:00 2026" };
    const replacement = { pgid: 8181, startedAt: "Mon Aug  7 09:01:00 2026" };
    assert.equal(
      await enqueueTurnForBootingHsrHost("reused-preboot", 8181, "must-not-queue", recorded, async () => replacement),
      false,
    );
    assert.deepEqual(await readPendingHsrTurns("reused-preboot"), []);
  });
});

test("a live HSR send stays journaled through a login-required auth failure", async () => {
  await withTempStore(async () => {
    const bee = "auth-journal";
    const handle = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee), queueStartup: true });
    try {
      await hsrSubstrate().sendText(bee, "authfail exact operator prompt");
      await waitFor(
        async () => (await readPendingHsrTurns(bee)).length === 1,
        "auth-failed turn retained",
      );
      const pending = await readPendingHsrTurns(bee);
      assert.equal(pending[0]!.text, "authfail exact operator prompt");
    } finally {
      await handle.stop();
    }
  });
});

test("a live HSR send is removed only after a successful turn_end", async () => {
  await withTempStore(async () => {
    const bee = "success-journal";
    const handle = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee), queueStartup: true });
    try {
      await hsrSubstrate().sendText(bee, "successful exact operator prompt");
      await waitFor(async () => (await readPendingHsrTurns(bee)).length === 0, "live turn journal ack");
    } finally {
      await handle.stop();
    }
  });
});

test("recovery staging preserves original pending turn identities and restores idempotently", async () => {
  await withTempStore(async () => {
    const bee = "recovery-stage";
    const original = await withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, "resume this exact turn"));

    const staged = await stagePendingHsrTurnsForRecovery(bee, "episode-1");
    assert.deepEqual(staged.turns, [{ id: original.id, filename: original.filename, queuedAt: original.queuedAt }]);
    assert.deepEqual(await readPendingHsrTurns(bee), []);

    const restored = await restorePendingHsrTurnsAfterRecovery(bee);
    assert.equal(restored?.episodeId, "episode-1");
    assert.deepEqual(await readPendingHsrTurns(bee), [original]);

    await restorePendingHsrTurnsAfterRecovery(bee);
    assert.deepEqual(await readPendingHsrTurns(bee), [original], "a repeated restore never copies the turn");
    assert.equal((await readStagedPendingHsrTurns(bee))?.turns.length, 1);
  });
});

test("a live host accepts a recovered delivery id once until its journal acknowledgement", () => {
  const gate = createPendingHsrDeliveryGate();
  assert.equal(gate.claim("turn-file-1.json"), true);
  assert.equal(gate.claim("turn-file-1.json"), false, "daemon retry on the same host is idempotent");
  assert.equal(gate.claim("turn-file-2.json"), true, "distinct queued work is independent");
  gate.release("turn-file-1.json");
  assert.equal(gate.claim("turn-file-1.json"), true, "an acked id may be reclaimed only after release");
});

test("the replay marker clears only after replacement-host drain acceptance", async () => {
  await withTempStore(async () => {
    const bee = "recovery-drain-marker";
    const original = await withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, "keep until accepted"));
    await stagePendingHsrTurnsForRecovery(bee, "episode-marker");

    await assert.rejects(
      drainStagedPendingHsrTurns(bee, async () => { throw new Error("replacement socket not ready"); }),
      /replacement socket not ready/,
    );
    assert.ok(await readStagedPendingHsrTurns(bee), "failed drain retains its replay marker");
    assert.deepEqual(await readPendingHsrTurns(bee), [original], "restored journal remains durable");

    let offered = 0;
    assert.equal(await drainStagedPendingHsrTurns(bee, async () => {
      offered = (await readPendingHsrTurns(bee)).length;
      return offered;
    }), 1);
    assert.equal(offered, 1);
    assert.equal(await readStagedPendingHsrTurns(bee), null);
  });
});
