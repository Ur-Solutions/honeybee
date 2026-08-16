// enqueueTurnForBootingHsrHost — the no-wait spawn's first-prompt path.
// spawnBee returns before the detached host cold-starts, so the first turn is
// persisted against the forked host PID before meta.json exists and must be
// drained by the host's queued→running transition.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deliverPromptText } from "../src/cli/shared.js";
import { reconcileAmbiguousBuzDelivery } from "../src/buz.js";
import { resolveBuzReconcileBeeName } from "../src/commands/buz.js";
import { deliverSessionText } from "../src/delivery.js";
import { runHsrHost } from "../src/hsr/host.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import {
  enqueuePendingHsrTurn,
  enqueueTurnForBootingHsrHost,
  createPendingHsrDeliveryGate,
  claimPendingHsrTurnOnHost,
  clearPendingHsrTurns,
  drainStagedPendingHsrTurns,
  HsrDeliveryAmbiguousError,
  markPendingHsrTurnAmbiguous,
  markPendingHsrTurnAccepted,
  markPendingHsrTurnAuthFailed,
  markPendingHsrTurnStarted,
  markAmbiguousPendingHsrTurnReceiptCompleted,
  preservePendingHsrTurnReceiptsForPurge,
  readPendingHsrTurns,
  readStagedPendingHsrTurns,
  restorePendingHsrTurnsAfterRecovery,
  stagePendingHsrTurnsForRecovery,
  settlePendingHsrTurnsForIntentionalStop,
  withHsrTurnDeliveryLock,
} from "../src/hsr/pendingTurns.js";
import { hsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import { startRpcServer } from "../src/hsr/rpc.js";
import { hsrSubstrate } from "../src/hsr/substrate.js";
import { captureProcessBirthFingerprint } from "../src/hsr/processIdentity.js";
import type { RunnerAdapter, RunnerOpts } from "../src/hsr/types.js";
import { reviveHsrForAutomaticRecovery } from "../src/recovery/revive.js";
import { readBeeRequests } from "../src/requests/store.js";
import { deleteSession, saveSession, type SessionRecord } from "../src/store.js";
import { purgeSessionData } from "../src/kill.js";

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

test("caller-identified direct delivery to a queued host succeeds at durable handoff", async () => {
  await withTempStore(async () => {
    const bee = "queued-caller-id";
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
    const deliveryId = "018f47ea-6f4a-7b89-8abc-7123456789ab";
    await hsrSubstrate().sendText(bee, "durable before cold start", undefined, { deliveryId });
    const pending = (await readPendingHsrTurns(bee))[0]!;
    assert.equal(pending.id, deliveryId);
    assert.equal(pending.phase, "queued");
  });
});

test("central direct/Flow delivery commits against a cold host after durable queued handoff", async () => {
  await withTempStore(async () => {
    const bee = "queued-central-delivery";
    const identity = await captureProcessBirthFingerprint(process.pid);
    assert.ok(identity);
    const record: SessionRecord = {
      name: bee,
      id: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      substrate: "hsr",
      runnerPid: process.pid,
      runnerFingerprint: identity,
      preamble: { text: "EXACT PREAMBLE", channel: "message" },
      createdAt: "2026-08-15T09:00:00.000Z",
      updatedAt: "2026-08-15T09:00:00.000Z",
      status: "running",
    };
    await saveSession(record);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      hostFingerprint: identity,
      startedAt: "2026-08-15T09:00:00.000Z",
      controlSocket: join(hsrRunDir(bee), "control.sock"),
      status: "queued",
    });

    const delivered = await deliverSessionText(record, "cold direct work", {
      deliver: deliverPromptText,
      makeActionId: () => "cold-action",
    });
    assert.equal(delivered.record.lastPrompt, "cold direct work");
    await deliverSessionText(delivered.record, "cold direct work", {
      deliver: deliverPromptText,
      deliveryId: `delivery:${bee}:cold-action`,
    });
    const turn = (await readPendingHsrTurns(bee))[0]!;
    assert.equal(turn.id, `delivery:${bee}:cold-action`);
    assert.equal(turn.phase, "queued");
    assert.match(turn.text, /EXACT PREAMBLE/);
    assert.equal((await readPendingHsrTurns(bee)).length, 1, "same effect and preamble converge on one cold-turn journal");
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
      await waitFor(async () => (await readPendingHsrTurns(bee))[0]?.phase === "completed", "successful turn receipt");
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
        async () => (await readPendingHsrTurns(bee))[0]?.phase === "auth_failed",
        "auth-failed turn retained",
      );
      const pending = await readPendingHsrTurns(bee);
      assert.equal(pending[0]!.text, "authfail exact operator prompt");
      assert.equal(pending[0]!.phase, "auth_failed");
    } finally {
      await handle.stop();
    }
  });
});

test("a live HSR send retains a completed tombstone after successful turn_end", async () => {
  await withTempStore(async () => {
    const bee = "success-journal";
    const handle = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee), queueStartup: true });
    try {
      await hsrSubstrate().sendText(bee, "successful exact operator prompt");
      await waitFor(async () => (await readPendingHsrTurns(bee))[0]?.phase === "completed", "live turn journal completion");
      assert.equal((await readPendingHsrTurns(bee)).length, 1, "completed identity remains until explicit run purge");
      await clearPendingHsrTurns(bee);
      assert.deepEqual(await readPendingHsrTurns(bee), [], "explicit run purge removes the durable receipt");
    } finally {
      await handle.stop();
    }
  });
});

test("a post-RPC direct retry with the same caller id observes the receipt without a second provider send", async () => {
  await withTempStore(async () => {
    const bee = "rpc-reply-crash";
    const deliveryId = "018f47ea-6f4a-7b89-8abc-4123456789ab";
    const handle = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee), queueStartup: true });
    try {
      const sub = hsrSubstrate();
      await sub.sendText(bee, "one provider turn", undefined, { deliveryId });
      await waitFor(async () => (await readPendingHsrTurns(bee))[0]?.phase === "completed", "first delivery completion");
      await sub.sendText(bee, "one provider turn", undefined, { deliveryId });
      await sleep(50);
      const capture = await sub.capture(bee, 100);
      assert.equal(capture.split("echo:one provider turn").length - 1, 1, "same-id replay never reaches the provider twice");
      const receipt = (await readPendingHsrTurns(bee))[0]!;
      assert.equal(receipt.id, deliveryId);
      assert.equal(receipt.phase, "completed");
    } finally {
      await handle.stop();
    }
  });
});

test("next-tool remains dispatching until session.send returns, then writes one completed receipt", async () => {
  await withTempStore(async () => {
    const bee = "next-tool-receipt";
    const deliveryId = "018f47ea-6f4a-7b89-8abc-5123456789ab";
    let signalSend!: () => void;
    let releaseSend!: () => void;
    const sendEntered = new Promise<void>((resolve) => { signalSend = resolve; });
    const sendRelease = new Promise<void>((resolve) => { releaseSend = resolve; });
    const delayedAdapter: RunnerAdapter = {
      harness: "stub-delayed",
      tier: () => stubAdapter.tier(),
      start: async (opts) => {
        const session = await stubAdapter.start(opts);
        return {
          ...session,
          send: async (text, sendOpts) => {
            signalSend();
            await sendRelease;
            await session.send(text, sendOpts);
          },
        };
      },
    };
    const handle = await runHsrHost({ bee, adapter: delayedAdapter, opts: optsFor(bee), queueStartup: true });
    try {
      const pending = hsrSubstrate().sendText(bee, "hold until tool boundary", undefined, {
        mode: "next-tool",
        deliveryId,
      });
      await sendEntered;
      assert.equal((await readPendingHsrTurns(bee))[0]?.phase, "dispatching");
      releaseSend();
      await pending;
      assert.equal((await readPendingHsrTurns(bee))[0]?.phase, "completed");
    } finally {
      releaseSend();
      await handle.stop();
    }
  });
});

test("recovery staging preserves original pending turn identities and restores idempotently", async () => {
  await withTempStore(async () => {
    const bee = "recovery-stage";
    const deliveryId = "018f47ea-6f4a-7b89-8abc-6123456789ab";
    const original = await withHsrTurnDeliveryLock(bee, () =>
      enqueuePendingHsrTurn(bee, "resume this exact turn", { deliveryId }));

    const staged = await stagePendingHsrTurnsForRecovery(bee, "episode-1");
    assert.deepEqual(staged.turns, [{ id: original.id, filename: original.filename, queuedAt: original.queuedAt }]);
    assert.deepEqual(await readPendingHsrTurns(bee), []);

    const restored = await restorePendingHsrTurnsAfterRecovery(bee);
    assert.equal(restored?.episodeId, "episode-1");
    assert.deepEqual(await readPendingHsrTurns(bee), [original]);
    assert.equal((await readPendingHsrTurns(bee))[0]?.id, deliveryId, "auth/runtime recovery preserves caller identity");

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

test("caller delivery ids map to one tombstone and reject content reuse", async () => {
  await withTempStore(async () => {
    const bee = "stable-delivery-id";
    const deliveryId = "018f47ea-6f4a-7b89-8abc-0123456789ab";
    const first = await withHsrTurnDeliveryLock(bee, () =>
      enqueuePendingHsrTurn(bee, "one exact prompt", { deliveryId }));
    const replay = await withHsrTurnDeliveryLock(bee, () =>
      enqueuePendingHsrTurn(bee, "one exact prompt", { deliveryId }));
    assert.equal(replay.filename, first.filename);
    assert.equal(replay.id, deliveryId);
    await assert.rejects(
      withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, "different prompt", { deliveryId })),
      /different content or delivery mode/,
    );
    assert.equal((await readPendingHsrTurns(bee)).length, 1);
  });
});

test("old-host dispatch is fenced ambiguous while auth_failed rebinds the same id", async () => {
  await withTempStore(async () => {
    const bee = "host-bound-delivery";
    const hostA = { hostPid: 7001, startedAt: "2026-08-15T10:00:00.000Z", hostFingerprint: { pgid: 7001, startedAt: "birth-a" } };
    const hostB = { hostPid: 7002, startedAt: "2026-08-15T10:01:00.000Z", hostFingerprint: { pgid: 7002, startedAt: "birth-b" } };
    for (const [suffix, advance] of [
      ["1", async (_id: string) => undefined],
      ["2", (id: string) => markPendingHsrTurnAccepted(bee, id, hostA)],
      ["3", (id: string) => markPendingHsrTurnStarted(bee, id, hostA)],
    ] as const) {
      const id = `018f47ea-6f4a-7b89-8abc-${suffix}123456789ab`;
      await withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, `phase-${suffix}`, { deliveryId: id }));
      await claimPendingHsrTurnOnHost(bee, id, `phase-${suffix}`, "turn", hostA);
      await advance(id);
      await assert.rejects(
        claimPendingHsrTurnOnHost(bee, id, `phase-${suffix}`, "turn", hostB),
        (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
      );
      assert.equal((await readPendingHsrTurns(bee)).find((turn) => turn.id === id)?.phase, "ambiguous");
    }

    const authId = "018f47ea-6f4a-7b89-8abc-4123456789ab";
    await withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, "auth retry", { deliveryId: authId }));
    await claimPendingHsrTurnOnHost(bee, authId, "auth retry", "turn", hostA);
    await markPendingHsrTurnAuthFailed(bee, authId, hostA);
    const rebound = await claimPendingHsrTurnOnHost(bee, authId, "auth retry", "turn", hostB);
    assert.equal(rebound.action, "dispatch");
    assert.equal(rebound.turn.id, authId);
    assert.deepEqual(rebound.turn.host, hostB);
  });
});

test("an ambiguous delivery fences a fresh id before it creates any later journal", async () => {
  await withTempStore(async () => {
    const bee = "ordered-ambiguity";
    const firstId = "018f47ea-6f4a-7b89-8abc-8123456789ab";
    const secondId = "018f47ea-6f4a-7b89-8abc-9123456789ab";
    const host = { hostPid: 7201, startedAt: "2026-08-15T12:00:00.000Z", hostFingerprint: { pgid: 7201, startedAt: "birth" } };
    await withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, "uncertain first", { deliveryId: firstId }));
    await claimPendingHsrTurnOnHost(bee, firstId, "uncertain first", "turn", host);
    await markPendingHsrTurnAmbiguous(bee, firstId, host, "provider outcome unknown");

    await assert.rejects(
      hsrSubstrate().sendText(bee, "must not overtake", undefined, { deliveryId: secondId }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    assert.deepEqual((await readPendingHsrTurns(bee)).map((turn) => turn.id), [firstId]);
  });
});

test("RPC refusal before host claim cancels the offer so a fresh direct retry cannot duplicate", async () => {
  await withTempStore(async () => {
    const bee = "rpc-no-host-claim";
    const deliveryId = "018f47ea-6f4a-7b89-8abc-a123456789ab";
    const identity = await captureProcessBirthFingerprint(process.pid);
    assert.ok(identity);
    const socketDir = await mkdtemp("/tmp/hb-rpc-");
    const socketPath = join(socketDir, "control.sock");
    let server = await startRpcServer({
      socketPath,
      methods: { send: () => { throw new Error("request reached server but host claim failed"); } },
    });
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      hostFingerprint: identity,
      startedAt: "2026-08-15T12:30:00.000Z",
      controlSocket: socketPath,
      status: "running",
    });
    try {
      await assert.rejects(
        hsrSubstrate().sendText(bee, "uncertain request write", undefined, { deliveryId }),
        /request reached server but host claim failed/,
      );
      assert.deepEqual(await readPendingHsrTurns(bee), [], "definite pre-claim failure removes the latent direct offer");

      await server.close();
      const host = {
        hostPid: process.pid,
        startedAt: "2026-08-15T12:30:00.000Z",
        hostFingerprint: identity,
      };
      let providerCalls = 0;
      server = await startRpcServer({
        socketPath,
        methods: {
          send: async (params) => {
            const body = params as { text: string; deliveryId: string };
            await claimPendingHsrTurnOnHost(bee, body.deliveryId, body.text, "turn", host);
            providerCalls += 1;
            await markPendingHsrTurnAccepted(bee, body.deliveryId, host);
          },
        },
      });
      const retryId = `${deliveryId}-retry`;
      await hsrSubstrate().sendText(bee, "uncertain request write", undefined, { deliveryId: retryId });
      assert.equal(providerCalls, 1, "a fresh direct retry dispatches only once after the old offer was cancelled");
      assert.deepEqual((await readPendingHsrTurns(bee)).map(({ id, phase }) => ({ id, phase })), [
        { id: retryId, phase: "accepted" },
      ]);
    } finally {
      await server.close();
      await rm(socketDir, { recursive: true, force: true });
    }
  });
});

test("control-socket connect failure cancels the unclaimed offer before a fresh-id retry", async () => {
  await withTempStore(async () => {
    const bee = "rpc-connect-no-host-claim";
    const firstId = "018f47ea-6f4a-7b89-8abc-a223456789ab";
    const identity = await captureProcessBirthFingerprint(process.pid);
    assert.ok(identity);
    const startedAt = "2026-08-15T12:35:00.000Z";
    const host = { hostPid: process.pid, startedAt, hostFingerprint: identity };
    const socketDir = await mkdtemp("/tmp/hb-rpc-");
    const socketPath = join(socketDir, "control.sock");
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      hostFingerprint: identity,
      startedAt,
      controlSocket: socketPath,
      status: "running",
    });
    await assert.rejects(
      hsrSubstrate().sendText(bee, "connect retry", undefined, { deliveryId: firstId }),
      /no socket at path|connection refused/,
    );
    assert.deepEqual(await readPendingHsrTurns(bee), [], "failed connect leaves no latent direct turn");

    let providerCalls = 0;
    const server = await startRpcServer({
      socketPath,
      methods: {
        send: async (params) => {
          const body = params as { text: string; deliveryId: string };
          await claimPendingHsrTurnOnHost(bee, body.deliveryId, body.text, "turn", host);
          providerCalls += 1;
          await markPendingHsrTurnAccepted(bee, body.deliveryId, host);
        },
      },
    });
    try {
      await hsrSubstrate().sendText(bee, "connect retry", undefined, { deliveryId: `${firstId}-retry` });
      assert.equal(providerCalls, 1);
      assert.equal((await readPendingHsrTurns(bee)).length, 1);
    } finally {
      await server.close();
      await rm(socketDir, { recursive: true, force: true });
    }
  });
});

test("lost RPC reply after exact host acceptance settles direct delivery and never re-sends", async () => {
  await withTempStore(async () => {
    const bee = "rpc-accepted-no-reply";
    const deliveryId = "018f47ea-6f4a-7b89-8abc-b123456789ab";
    const identity = await captureProcessBirthFingerprint(process.pid);
    assert.ok(identity);
    const startedAt = "2026-08-15T12:40:00.000Z";
    const host = { hostPid: process.pid, startedAt, hostFingerprint: identity };
    const socketDir = await mkdtemp("/tmp/hb-rpc-");
    const socketPath = join(socketDir, "control.sock");
    let calls = 0;
    const server = await startRpcServer({
      socketPath,
      methods: {
        send: async (params, context) => {
          calls += 1;
          const body = params as { text: string; deliveryId: string };
          await claimPendingHsrTurnOnHost(bee, body.deliveryId, body.text, "turn", host);
          await markPendingHsrTurnAccepted(bee, body.deliveryId, host);
          context.close();
        },
      },
    });
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      hostFingerprint: identity,
      startedAt,
      controlSocket: socketPath,
      status: "running",
    });
    try {
      await hsrSubstrate().sendText(bee, "accepted once", undefined, { deliveryId });
      await hsrSubstrate().sendText(bee, "accepted once", undefined, { deliveryId });
      assert.equal(calls, 1, "same accepted delivery id is a receipt lookup, not another RPC");
      assert.equal((await readPendingHsrTurns(bee))[0]?.phase, "accepted");
    } finally {
      await server.close();
      await rm(socketDir, { recursive: true, force: true });
    }
  });
});

test("completion-required delivery retains its external queue after accepted RPC loss", async () => {
  await withTempStore(async () => {
    const bee = "rpc-accepted-queue-held";
    const deliveryId = "018f47ea-6f4a-7b89-8abc-c123456789ab";
    const identity = await captureProcessBirthFingerprint(process.pid);
    assert.ok(identity);
    const startedAt = "2026-08-15T12:50:00.000Z";
    const host = { hostPid: process.pid, startedAt, hostFingerprint: identity };
    const socketDir = await mkdtemp("/tmp/hb-rpc-");
    const socketPath = join(socketDir, "control.sock");
    let calls = 0;
    const server = await startRpcServer({
      socketPath,
      methods: {
        send: async (params, context) => {
          calls += 1;
          const body = params as { text: string; deliveryId: string };
          await claimPendingHsrTurnOnHost(bee, body.deliveryId, body.text, "turn", host);
          await markPendingHsrTurnAccepted(bee, body.deliveryId, host);
          context.close();
        },
      },
    });
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      hostFingerprint: identity,
      startedAt,
      controlSocket: socketPath,
      status: "running",
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          hsrSubstrate().sendText(bee, "mailbox waits", undefined, { deliveryId, completionRequired: true }),
          (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_IN_FLIGHT",
        );
      }
      assert.equal(calls, 1);
      assert.equal((await readPendingHsrTurns(bee))[0]?.phase, "accepted");
    } finally {
      await server.close();
      await rm(socketDir, { recursive: true, force: true });
    }
  });
});

test("delivery storage enumeration and malformed replay manifests fail closed", async () => {
  await withTempStore(async () => {
    const unreadableBee = "journal-enumeration-error";
    await mkdir(hsrRunDir(unreadableBee), { recursive: true });
    await writeFile(join(hsrRunDir(unreadableBee), "pending-turns"), "not a directory");
    await assert.rejects(readPendingHsrTurns(unreadableBee), /could not enumerate pending HSR turn journals/);
    await assert.rejects(
      enqueuePendingHsrTurn(unreadableBee, "must not overwrite ownership", { deliveryId: "same-id" }),
      /could not enumerate pending HSR turn journals/,
    );

    const malformedBee = "malformed-replay-manifest";
    const replayDir = join(hsrRunDir(malformedBee), "recovery-replay");
    await mkdir(replayDir, { recursive: true });
    await writeFile(join(replayDir, "manifest.json"), "{broken-json");
    await assert.rejects(readStagedPendingHsrTurns(malformedBee), /malformed HSR recovery replay manifest/);
    await assert.rejects(
      stagePendingHsrTurnsForRecovery(malformedBee, "competing-episode"),
      /malformed HSR recovery replay manifest/,
    );
  });
});

test("unknown present phase or mode never defaults to a replayable legacy value", async () => {
  await withTempStore(async () => {
    for (const [bee, malformed] of [
      ["unknown-phase", { phase: "provider-maybe-accepted", mode: "turn" }],
      ["unknown-mode", { phase: "queued", mode: "someday" }],
    ] as const) {
      const dir = join(hsrRunDir(bee), "pending-turns");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "corrupt.json"), `${JSON.stringify({
        id: `${bee}-id`,
        text: "ownership evidence",
        queuedAt: "2026-08-15T13:00:00.000Z",
        updatedAt: "2026-08-15T13:00:00.000Z",
        ...malformed,
      })}\n`);
      await assert.rejects(readPendingHsrTurns(bee), /malformed pending HSR turn/);
      await assert.rejects(
        enqueuePendingHsrTurn(bee, "new work", { deliveryId: "new-id" }),
        /malformed pending HSR turn/,
      );
    }
  });
});

test("old-host accepted recovery becomes visible ambiguity and retains replay ownership", async () => {
  await withTempStore(async () => {
    const bee = "recovery-visible-ambiguity";
    const deliveryId = "018f47ea-6f4a-7b89-8abc-d123456789ab";
    const hostA = { hostPid: 7301, startedAt: "2026-08-15T13:10:00.000Z", hostFingerprint: { pgid: 7301, startedAt: "birth-a" } };
    const hostB = { hostPid: 7302, startedAt: "2026-08-15T13:11:00.000Z", hostFingerprint: { pgid: 7302, startedAt: "birth-b" } };
    const record: SessionRecord = {
      name: bee,
      id: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      substrate: "hsr",
      createdAt: "2026-08-15T13:00:00.000Z",
      updatedAt: "2026-08-15T13:00:00.000Z",
      status: "running",
    };
    await saveSession(record);
    await withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, "accepted before host death", { deliveryId }));
    await claimPendingHsrTurnOnHost(bee, deliveryId, "accepted before host death", "turn", hostA);
    await markPendingHsrTurnAccepted(bee, deliveryId, hostA);

    await assert.rejects(
      reviveHsrForAutomaticRecovery(record, "episode-ambiguity", {
        revive: async (current) => current,
        drain: async () => {
          await claimPendingHsrTurnOnHost(bee, deliveryId, "accepted before host death", "turn", hostB);
          return 0;
        },
      }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    assert.equal((await readPendingHsrTurns(bee))[0]?.phase, "ambiguous");
    assert.ok(await readStagedPendingHsrTurns(bee), "ambiguous recovery never clears replay ownership");
    assert.ok((await readBeeRequests(bee)).some((request) =>
      request.status === "open" && request.evidence.source === "hsr-recovery"));
  });
});

test("explicit purge preserves accepted ownership outside hsrRoot and a same-name generation cannot redeliver", async () => {
  await withTempStore(async () => {
    const bee = "purged-delivery-ownership";
    const deliveryId = "018f47ea-6f4a-7b89-8abc-e123456789ab";
    const text = "provider may already own this Buz turn";
    const host = { hostPid: 7401, startedAt: "2026-08-15T14:00:00.000Z", hostFingerprint: { pgid: 7401, startedAt: "birth-old" } };
    const oldRecord: SessionRecord = {
      name: bee,
      id: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      substrate: "hsr",
      createdAt: "2026-08-15T14:00:00.000Z",
      updatedAt: "2026-08-15T14:00:00.000Z",
      status: "running",
    };
    await saveSession(oldRecord);
    await withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, text, { deliveryId }));
    await claimPendingHsrTurnOnHost(bee, deliveryId, text, "turn", host);
    await markPendingHsrTurnAccepted(bee, deliveryId, host);
    await settlePendingHsrTurnsForIntentionalStop(bee);

    assert.equal(await purgeSessionData(oldRecord, {
      emitLedger: false,
      finalCredentialSync: async () => undefined,
    }), true);
    const retained = await readPendingHsrTurns(bee);
    assert.equal(retained[0]?.phase, "ambiguous");
    assert.equal(retained[0]?.id, deliveryId);

    const replacement: SessionRecord = {
      ...oldRecord,
      createdAt: "2026-08-15T14:05:00.000Z",
      updatedAt: "2026-08-15T14:05:00.000Z",
      runtimeGeneration: 1,
    };
    await saveSession(replacement);
    await assert.rejects(
      deliverSessionText(replacement, text, { deliveryId, completionRequired: true }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
    assert.ok((await readBeeRequests(bee)).some((request) =>
      request.status === "open" && request.evidence.detail === "delivery-ambiguous"));
    assert.equal((await readPendingHsrTurns(bee)).length, 1, "replacement creates no second delivery journal");
  });
});

test("operator delivery verdict reconciles a retained direct turn without a Buz mailbox", async () => {
  await withTempStore(async () => {
    const bee = "direct-delivery-reconcile";
    const deliveryId = "018f47ea-6f4a-7b89-8abc-e223456789ab";
    const text = "direct provider turn with no mailbox";
    const host = { hostPid: 7411, startedAt: "2026-08-15T14:10:00.000Z", hostFingerprint: { pgid: 7411, startedAt: "birth-direct" } };
    const record: SessionRecord = {
      name: bee,
      id: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      substrate: "hsr",
      createdAt: "2026-08-15T14:10:00.000Z",
      updatedAt: "2026-08-15T14:10:00.000Z",
      status: "running",
    };
    await saveSession(record);
    await withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, text, { deliveryId }));
    await claimPendingHsrTurnOnHost(bee, deliveryId, text, "turn", host);
    await markPendingHsrTurnAccepted(bee, deliveryId, host);
    await settlePendingHsrTurnsForIntentionalStop(bee);
    await preservePendingHsrTurnReceiptsForPurge(bee);
    await rm(hsrRunDir(bee), { recursive: true, force: true });
    await deleteSession(bee);

    assert.equal(await resolveBuzReconcileBeeName(bee, deliveryId), bee, "recordless command repair uses exact retained identity");
    assert.deepEqual(await reconcileAmbiguousBuzDelivery(bee, deliveryId, "delivered"), {
      verdict: "delivered",
      mailbox: "absent",
    });
    assert.equal((await readPendingHsrTurns(bee))[0]?.phase, "completed");

    let laterSends = 0;
    await saveSession(record);
    await deliverSessionText(record, "later direct work", {
      deliveryId: "018f47ea-6f4a-7b89-8abc-e323456789ab",
      deliver: async () => { laterSends += 1; },
    });
    assert.equal(laterSends, 1, "completed direct tombstone releases later work without redriving the old id");
  });
});

test("operator discard leaves a terminal direct tombstone that rejects delayed exact-id replay", async () => {
  await withTempStore(async () => {
    const bee = "direct-delivery-discard";
    const deliveryId = "018f47ea-6f4a-7b89-8abc-e423456789ab";
    const text = "direct provider turn explicitly discarded";
    const host = { hostPid: 7421, startedAt: "2026-08-15T14:20:00.000Z", hostFingerprint: { pgid: 7421, startedAt: "birth-discard" } };
    const record: SessionRecord = {
      name: bee,
      id: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      substrate: "hsr",
      createdAt: "2026-08-15T14:20:00.000Z",
      updatedAt: "2026-08-15T14:20:00.000Z",
      status: "running",
    };
    await saveSession(record);
    await withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, text, { deliveryId }));
    await claimPendingHsrTurnOnHost(bee, deliveryId, text, "turn", host);
    await markPendingHsrTurnAccepted(bee, deliveryId, host);
    await settlePendingHsrTurnsForIntentionalStop(bee);
    await preservePendingHsrTurnReceiptsForPurge(bee);
    await rm(hsrRunDir(bee), { recursive: true, force: true });

    assert.deepEqual(await reconcileAmbiguousBuzDelivery(bee, deliveryId, "discard"), {
      verdict: "discard",
      mailbox: "absent",
    });
    assert.equal((await readPendingHsrTurns(bee))[0]?.phase, "discarded");
    await assert.rejects(
      deliverSessionText(record, text, { deliveryId }),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_DISCARDED",
    );
  });
});

test("a retry heals an active-completed plus retained-ambiguous reconciliation crash", async () => {
  await withTempStore(async () => {
    const bee = "dual-copy-reconcile";
    const deliveryId = "018f47ea-6f4a-7b89-8abc-e523456789ab";
    const text = "one immutable turn";
    const host = { hostPid: 7431, startedAt: "2026-08-15T14:30:00.000Z", hostFingerprint: { pgid: 7431, startedAt: "birth-dual" } };
    await withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, text, { deliveryId }));
    await claimPendingHsrTurnOnHost(bee, deliveryId, text, "turn", host);
    await markPendingHsrTurnAccepted(bee, deliveryId, host);
    await settlePendingHsrTurnsForIntentionalStop(bee);
    await preservePendingHsrTurnReceiptsForPurge(bee);

    const activeDir = join(hsrRunDir(bee), "pending-turns");
    const filename = (await readdir(activeDir)).find((entry) => entry.endsWith(".json"));
    assert.ok(filename);
    const activePath = join(activeDir, filename);
    const active = JSON.parse(await readFile(activePath, "utf8")) as Record<string, unknown>;
    active.phase = "completed";
    delete active.error;
    await writeFile(activePath, `${JSON.stringify(active)}\n`);

    const retainedDir = join(
      process.env.HIVE_STORE_ROOT!,
      "hsr-delivery-receipts",
      createHash("sha256").update(bee).digest("hex"),
    );
    assert.equal(JSON.parse(await readFile(join(retainedDir, filename), "utf8")).phase, "ambiguous");
    assert.equal((await readPendingHsrTurns(bee))[0]?.phase, "completed", "monotonic merge selects the terminal verdict");

    await markAmbiguousPendingHsrTurnReceiptCompleted(bee, deliveryId);
    assert.equal(JSON.parse(await readFile(join(retainedDir, filename), "utf8")).phase, "completed");
    assert.equal(JSON.parse(await readFile(activePath, "utf8")).phase, "completed");
  });
});

test("started/auth phases never regress when caller acceptance lands later", async () => {
  await withTempStore(async () => {
    const bee = "monotonic-delivery";
    const id = "018f47ea-6f4a-7b89-8abc-3123456789ab";
    const host = { hostPid: 7101, startedAt: "2026-08-15T11:00:00.000Z", hostFingerprint: { pgid: 7101, startedAt: "birth" } };
    await withHsrTurnDeliveryLock(bee, () => enqueuePendingHsrTurn(bee, "race", { deliveryId: id }));
    await claimPendingHsrTurnOnHost(bee, id, "race", "turn", host);
    await markPendingHsrTurnStarted(bee, id, host);
    await markPendingHsrTurnAccepted(bee, id, host);
    assert.equal((await readPendingHsrTurns(bee))[0]?.phase, "started");
    await markPendingHsrTurnAuthFailed(bee, id, host);
    await markPendingHsrTurnAccepted(bee, id, host);
    assert.equal((await readPendingHsrTurns(bee))[0]?.phase, "auth_failed");
  });
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
