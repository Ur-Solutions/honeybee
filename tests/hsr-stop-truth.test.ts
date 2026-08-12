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
import { stopHsrIncarnation } from "../src/hsr/substrate.js";
import { ensureHsrRunDir, readHsrMetaStrict, writeHsrMeta, type HsrMeta } from "../src/hsr/runDir.js";

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

test("dead host pid with pending child admission is a proven stop and flips meta to exited", async () => {
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
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(signals, [], "a provably-dead host is never signalled");
    const after = await readHsrMetaStrict(bee);
    assert.equal(after?.status, "exited", "the proven stop is published onto the incarnation's meta");
    assert.ok(after?.endedAt, "endedAt records when the stop was proven");
  });
});

test("recycled pid with a different birth is a proven stop and never signals the replacement", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-recycled-pid";
    const meta = await seedRunningMeta(bee);
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
    assert.equal((await readHsrMetaStrict(bee))?.status, "exited");
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

test("missing host fingerprint: exact numeric pid absence still proves the stop", async () => {
  await withTempStore(async () => {
    const bee = "stop-truth-no-fingerprint";
    const meta = await seedRunningMeta(bee, { hostFingerprint: undefined });
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const result = await stopHsrIncarnation(bee, meta, {
      readProcessIdentity: async () => null,
      isProcessGroupAlive: () => false,
      kill: (pid, signal) => signals.push([pid, signal]),
      sleep: async () => undefined,
    });
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(signals, []);
    assert.equal((await readHsrMetaStrict(bee))?.status, "exited");
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
