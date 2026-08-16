// Meta/stop truth hardening (cell-smoothness Phase 2): a `running` meta whose
// recorded host incarnation is PROVABLY gone (birth mismatch, or no such pid)
// must confirm the stop and flip meta to exited instead of wedging every
// kill/revive behind "HSR stop unconfirmed". Fingerprint uncertainty and live
// matching hosts keep the conservative fail-closed behavior.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claimPendingHsrTurnOnHost,
  enqueuePendingHsrTurn,
  markPendingHsrTurnAccepted,
  markPendingHsrTurnCompleted,
  readPendingHsrTurns,
  withHsrTurnDeliveryLock,
} from "../src/hsr/pendingTurns.js";
import { readHsrEventIntegrityReceipt } from "../src/hsr/eventIntegrity.js";
import { stopHsrIncarnation } from "../src/hsr/substrate.js";
import {
  appendHsrEvent,
  ensureHsrRunDir,
  readHsrMetaStrict,
  verifyHsrEventStreamClosure,
  writeHsrMeta,
  type HsrMeta,
} from "../src/hsr/runDir.js";

const hostBirth = { pgid: 4101, startedAt: "Fri Aug  7 10:00:00 2026" };
const childBirth = { pgid: 4202, startedAt: "Fri Aug  7 10:00:01 2026" };

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-stop-truth-"));
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

async function seedRunningMeta(bee: string, overrides: Partial<HsrMeta> = {}): Promise<HsrMeta> {
  await ensureHsrRunDir(bee);
  await writeHsrMeta(bee, {
    bee,
    harness: "stub",
    tier: "stream",
    hostPid: hostBirth.pgid,
    hostFingerprint: hostBirth,
    childAdmission: "pending",
    startedAt: "2026-08-07T10:00:00.000Z",
    controlSocket: join("/tmp", `${bee}-missing.sock`),
    status: "running",
    ...overrides,
  });
  return (await readHsrMetaStrict(bee))!;
}

test("dead host pid with pending child admission and no locator remains unconfirmed", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-dead-pid";
    const meta = await seedRunningMeta(bee);
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const result = await stopHsrIncarnation(bee, meta, {
      readProcessIdentity: async () => null, // pid absent: incarnation gone
      isProcessGroupAlive: () => false,
      kill: (pid, signal) => signals.push([pid, signal]),
      sleep: async () => undefined,
    });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /HSR stop unconfirmed/);
    assert.deepEqual(signals, [], "a provably-dead host is never signalled");
    const after = await readHsrMetaStrict(bee);
    assert.equal(after?.status, "running", "pending admission never claims that an escaped child is absent");
  });
});

test("dead host pid with no terminal event is stopped but remains event-history doubt", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-no-child";
    const meta = await seedRunningMeta(bee, { childAdmission: "none" });
    const result = await stopHsrIncarnation(bee, meta, {
      readProcessIdentity: async () => null,
      isProcessGroupAlive: () => false,
      kill: () => { throw new Error("a completed no-child admission never signals"); },
      sleep: async () => undefined,
    });
    assert.equal(result.ok, true, result.stderr);
    assert.equal((await readHsrMetaStrict(bee))?.status, "running", "physical death cannot synthesize a clean exit");
    assert.equal((await readHsrEventIntegrityReceipt(bee))?.stopState, "confirmed");
  });
});

test("dead host with an exact terminal high-water heals a clean closure", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-terminal-proof";
    const meta = await seedRunningMeta(bee, { childAdmission: "none" });
    const host = {
      hostPid: meta.hostPid,
      startedAt: meta.startedAt,
      hostFingerprint: meta.hostFingerprint!,
    };
    await appendHsrEvent(bee, { type: "host_epoch", ts: 1, host });
    await appendHsrEvent(bee, { type: "exit", ts: 2, code: 0, host });

    const result = await stopHsrIncarnation(bee, meta, {
      readProcessIdentity: async () => null,
      isProcessGroupAlive: () => false,
      kill: () => { throw new Error("a dead host is never signalled"); },
      sleep: async () => undefined,
    });
    assert.equal(result.ok, true, result.stderr);
    const healed = await readHsrMetaStrict(bee);
    assert.equal(healed?.status, "exited");
    assert.ok(healed?.eventStreamClosure);
    assert.equal(await verifyHsrEventStreamClosure(bee, healed!), true);
    assert.equal(await readHsrEventIntegrityReceipt(bee), null);
  });
});

test("a meta-only append failure outranks a later contiguous terminal exit", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-marker-before-exit";
    const meta = await seedRunningMeta(bee, {
      childAdmission: "none",
      eventIntegrityFailure: "provider effect was observed but its event append failed",
    });
    const host = {
      hostPid: meta.hostPid,
      startedAt: meta.startedAt,
      hostFingerprint: meta.hostFingerprint!,
    };
    await appendHsrEvent(bee, { type: "host_epoch", ts: 1, host });
    await appendHsrEvent(bee, { type: "exit", ts: 2, code: 0, host });

    const result = await stopHsrIncarnation(bee, meta, {
      readProcessIdentity: async () => null,
      isProcessGroupAlive: () => false,
      sleep: async () => undefined,
    });
    assert.equal(result.ok, true, result.stderr);
    const receipt = await readHsrEventIntegrityReceipt(bee);
    assert.equal(receipt?.stopState, "confirmed");
    assert.match(receipt?.reason ?? "", /provider effect was observed/);
    assert.equal((await readHsrMetaStrict(bee))?.eventStreamClosure, undefined, "terminal contiguity never launders known loss");
  });
});

test("intentional stop cancels only queued turns and retains provider receipts across the next host", async () => {
  await withTempStore(async () => {
    const bee = "stop-preserves-delivery-receipts";
    const meta = await seedRunningMeta(bee, { childAdmission: "none" });
    const host = {
      hostPid: meta.hostPid,
      startedAt: meta.startedAt,
      hostFingerprint: meta.hostFingerprint,
    };
    await withHsrTurnDeliveryLock(bee, async () => {
      await enqueuePendingHsrTurn(bee, "never claimed", { deliveryId: "queued-id" });
      await enqueuePendingHsrTurn(bee, "provider may own", { deliveryId: "accepted-id" });
      await enqueuePendingHsrTurn(bee, "provider completed", { deliveryId: "completed-id" });
    });
    await claimPendingHsrTurnOnHost(bee, "accepted-id", "provider may own", "turn", host);
    await markPendingHsrTurnAccepted(bee, "accepted-id", host);
    await claimPendingHsrTurnOnHost(bee, "completed-id", "provider completed", "turn", host);
    await markPendingHsrTurnCompleted(bee, "completed-id", host);

    const result = await stopHsrIncarnation(bee, meta, {
      readProcessIdentity: async () => null,
      isProcessGroupAlive: () => false,
      sleep: async () => undefined,
    });
    assert.equal(result.ok, true, result.stderr);
    const retained = await readPendingHsrTurns(bee);
    assert.deepEqual(retained.map(({ id, phase }) => ({ id, phase })), [
      { id: "accepted-id", phase: "ambiguous" },
      { id: "completed-id", phase: "completed" },
    ]);
    assert.match(retained[0]?.error ?? "", /intentionally stopped/);

    const replacementHost = {
      hostPid: 5102,
      startedAt: "2026-08-07T10:05:00.000Z",
      hostFingerprint: { pgid: 5102, startedAt: "replacement-birth" },
    };
    await assert.rejects(
      claimPendingHsrTurnOnHost(bee, "accepted-id", "provider may own", "turn", replacementHost),
      (error: unknown) => (error as { code?: unknown }).code === "HIVE_HSR_DELIVERY_AMBIGUOUS",
    );
  });
});

test("recycled pid proves physical stop but unclosed history remains fenced", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-recycled-pid";
    const meta = await seedRunningMeta(bee, { childAdmission: "none" });
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const result = await stopHsrIncarnation(bee, meta, {
      // Same pid number is alive, but it was born as a different process.
      readProcessIdentity: async () => ({ pgid: 9999, startedAt: "Sun Aug  9 09:09:09 2026" }),
      isProcessGroupAlive: () => false,
      kill: (pid, signal) => signals.push([pid, signal]),
      sleep: async () => undefined,
    });
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(signals, [], "a birth-mismatched pid owner is never ours to signal");
    assert.equal((await readHsrMetaStrict(bee))?.status, "running");
    assert.equal((await readHsrEventIntegrityReceipt(bee))?.stopState, "confirmed");
  });
});

test("a gone detached child leader does not prove its surviving process group stopped", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-gone-child-live-group";
    const meta = await seedRunningMeta(bee, {
      childAdmission: "admitted",
      childPid: childBirth.pgid,
      childPgid: childBirth.pgid,
      childFingerprint: childBirth,
    });
    const result = await stopHsrIncarnation(bee, meta, {
      readProcessIdentity: async () => null,
      isProcessGroupAlive: (pgid) => pgid === childBirth.pgid,
      kill: () => { throw new Error("a leader-gone group is not safe to signal"); },
      sleep: async () => undefined,
    });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /HSR stop unconfirmed/);
    assert.equal((await readHsrMetaStrict(bee))?.status, "running");
  });
});

test("a gone child group proves physical stop but not clean event closure", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-gone-child-absent-group";
    const meta = await seedRunningMeta(bee, {
      childAdmission: "admitted",
      childPid: childBirth.pgid,
      childPgid: childBirth.pgid,
      childFingerprint: childBirth,
    });
    const result = await stopHsrIncarnation(bee, meta, {
      readProcessIdentity: async () => null,
      isProcessGroupAlive: () => false,
      kill: () => { throw new Error("an absent group is never signalled"); },
      sleep: async () => undefined,
    });
    assert.equal(result.ok, true, result.stderr);
    assert.equal((await readHsrMetaStrict(bee))?.status, "running");
    assert.equal((await readHsrEventIntegrityReceipt(bee))?.stopState, "confirmed");
  });
});

test("an exited meta still stops its exact lingering host before replacement", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-exited-host-lingering";
    const meta = await seedRunningMeta(bee, {
      status: "exited",
      endedAt: "2026-08-07T10:00:05.000Z",
      childAdmission: "none",
    });
    let hostAlive = true;
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const result = await stopHsrIncarnation(bee, meta, {
      readProcessIdentity: async () => hostAlive ? hostBirth : null,
      isProcessGroupAlive: () => false,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid === hostBirth.pgid && signal === "SIGTERM") hostAlive = false;
      },
      sleep: async () => undefined,
    });
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(signals, [[hostBirth.pgid, "SIGTERM"]]);
    assert.equal((await readHsrMetaStrict(bee))?.status, "exited");
  });
});

test("a live matching host still refuses the blind provably-stopped shortcut", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-live-match";
    const meta = await seedRunningMeta(bee);
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const result = await stopHsrIncarnation(bee, meta, {
      // The recorded incarnation is genuinely alive and ignores signals.
      readProcessIdentity: async () => hostBirth,
      isProcessGroupAlive: () => true,
      kill: (pid, signal) => signals.push([pid, signal]),
      sleep: async () => undefined,
    });
    assert.equal(result.ok, false, "an unconfirmed live host must not report stopped");
    assert.match(result.stderr, /HSR stop unconfirmed/);
    // The graceful path escalates SIGTERM → SIGKILL against the VERIFIED
    // incarnation only; it never invents a success.
    assert.deepEqual(signals, [[hostBirth.pgid, "SIGTERM"], [hostBirth.pgid, "SIGKILL"]]);
    assert.equal((await readHsrMetaStrict(bee))?.status, "running", "meta is never flipped without proof");
  });
});

test("missing host fingerprint: numeric absence proves stop but not clean history", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-no-fingerprint";
    const meta = await seedRunningMeta(bee, { hostFingerprint: undefined, childAdmission: "none" });
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const result = await stopHsrIncarnation(bee, meta, {
      readProcessIdentity: async () => null,
      isProcessGroupAlive: () => false,
      kill: (pid, signal) => signals.push([pid, signal]),
      sleep: async () => undefined,
    });
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(signals, []);
    assert.equal((await readHsrMetaStrict(bee))?.status, "running");
    assert.equal((await readHsrEventIntegrityReceipt(bee))?.stopState, "confirmed");
  });
});

test("missing host fingerprint with an unreadable census stays fail-closed", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-unverifiable";
    const meta = await seedRunningMeta(bee, { hostFingerprint: undefined });
    const result = await stopHsrIncarnation(bee, meta, {
      readProcessIdentity: async () => { throw new Error("ps census unavailable"); },
      isProcessGroupAlive: () => false,
      kill: () => { throw new Error("must not signal on uncertainty"); },
      sleep: async () => undefined,
    });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /HSR stop unconfirmed/);
    assert.equal((await readHsrMetaStrict(bee))?.status, "running");
  });
});

test("a recorded-but-unverifiable child group still fails closed even with a dead host", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-partial-child";
    // Legacy shape: child pids recorded without a birth fingerprint. The
    // group's identity can never be re-verified, so absence stays unproven.
    const meta = await seedRunningMeta(bee, {
      childAdmission: undefined,
      childPid: childBirth.pgid,
      childPgid: childBirth.pgid,
    });
    const result = await stopHsrIncarnation(bee, meta, {
      readProcessIdentity: async (pid) => (pid === hostBirth.pgid ? null : childBirth),
      isProcessGroupAlive: () => true,
      kill: () => { throw new Error("must not signal an unverifiable group"); },
      sleep: async () => undefined,
    });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /HSR stop unconfirmed/);
    assert.equal((await readHsrMetaStrict(bee))?.status, "running");
  });
});
