import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHsrSubstrate } from "../src/hsr/substrate.js";
import { ensureHsrRunDir, hsrMetaPath, readHsrMetaStrict, writeHsrMeta } from "../src/hsr/runDir.js";
import { transactionalKill, transactionalRetire } from "../src/kill.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";

const hostBirth = { pgid: 4101, startedAt: "Fri Aug  7 10:00:00 2026" };
const childBirth = { pgid: 4202, startedAt: "Fri Aug  7 10:00:01 2026" };

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-hsr-lifecycle-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function record(name: string): SessionRecord {
  return {
    name,
    agent: "stub",
    requestedAgent: "stub",
    cwd: "/tmp",
    command: "stub",
    tmuxTarget: name,
    substrate: "hsr",
    id: `${name}-identity`,
    runtimeGeneration: 7,
    brief: "preserve this record payload",
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
    status: "running",
  };
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
    startedAt: "2026-08-07T10:00:00.000Z",
    controlSocket: join("/tmp", `${name}-missing.sock`),
    status: "running",
  });
}

for (const operation of ["kill", "retire"] as const) {
  test(`transactional ${operation} stops a live HSR child even when the host is gone`, async () => {
    await withTempStore(async () => {
      const session = record(`host-gone-child-live-${operation}`);
      await saveSession(session);
      await writeRuntimeMeta(session.name);
      let childGroupLive = true;
      const signals: Array<[number, NodeJS.Signals | 0]> = [];
      const substrate = createHsrSubstrate({
        readProcessIdentity: async (pid) => pid === hostBirth.pgid ? null : childGroupLive ? childBirth : null,
        isProcessGroupAlive: () => childGroupLive,
        kill: (pid, signal) => {
          signals.push([pid, signal]);
          if (pid === -childBirth.pgid && signal === "SIGTERM") childGroupLive = false;
        },
        sleep: async () => undefined,
      });

      const outcome = operation === "kill"
        ? await transactionalKill(session, { substrate, pollIntervalMs: 0, emitLedger: false })
        : await transactionalRetire(session, { substrate, pollIntervalMs: 0, emitLedger: false });

      assert.equal(outcome.ok, true);
      assert.deepEqual(signals, [[-childBirth.pgid, "SIGTERM"]]);
      assert.equal(childGroupLive, false);
      if (operation === "kill") assert.equal(await loadSession(session.name), null);
      else assert.equal((await loadSession(session.name))?.status, "done");
    });
  });
}

test("confirmed exact HSR child absence permits retire without signalling", async () => {
  await withTempStore(async () => {
    const session = record("confirmed-child-absence");
    await saveSession(session);
    await writeRuntimeMeta(session.name);
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const substrate = createHsrSubstrate({
      readProcessIdentity: async () => null,
      isProcessGroupAlive: () => false,
      kill: (pid, signal) => signals.push([pid, signal]),
    });

    const outcome = await transactionalRetire(session, { substrate, pollIntervalMs: 0, emitLedger: false });
    assert.equal(outcome.ok, true);
    assert.deepEqual(signals, []);
    assert.equal((await loadSession(session.name))?.status, "done");
  });
});

test("exited legacy HSR metadata reconciles only from exact PID and group absence", async () => {
  await withTempStore(async () => {
    const session = record("legacy-exited-absence");
    await saveSession(session);
    await ensureHsrRunDir(session.name);
    await writeHsrMeta(session.name, {
      bee: session.name,
      harness: "stub",
      tier: "stream",
      hostPid: hostBirth.pgid,
      childPid: childBirth.pgid,
      childPgid: childBirth.pgid,
      startedAt: "2026-08-07T10:00:00.000Z",
      endedAt: "2026-08-07T10:00:05.000Z",
      controlSocket: join("/tmp", `${session.name}-missing.sock`),
      status: "exited",
    });
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const substrate = createHsrSubstrate({
      readProcessIdentity: async () => null,
      readProcessGroupPresence: async () => "absent",
      isProcessGroupAlive: () => false,
      kill: (pid, signal) => signals.push([pid, signal]),
    });

    const outcome = await transactionalRetire(session, { substrate, pollIntervalMs: 0, emitLedger: false });
    assert.equal(outcome.ok, true);
    assert.deepEqual(signals, [], "legacy absence reconciliation never signals numeric identities");
    assert.equal((await loadSession(session.name))?.status, "done");
  });
});

test("exited legacy HSR metadata remains fail-closed for reused or uncertain identities", async () => {
  for (const [label, leader, group] of [
    ["reused", { pgid: childBirth.pgid, startedAt: "Fri Aug  7 10:05:00 2026" }, "present"],
    ["partial", null, "present"],
    ["uncertain", null, "unverifiable"],
  ] as const) {
    await withTempStore(async () => {
      const session = record(`legacy-exited-${label}`);
      await saveSession(session);
      await ensureHsrRunDir(session.name);
      await writeHsrMeta(session.name, {
        bee: session.name,
        harness: "stub",
        tier: "stream",
        hostPid: hostBirth.pgid,
        childPid: childBirth.pgid,
        childPgid: childBirth.pgid,
        startedAt: "2026-08-07T10:00:00.000Z",
        endedAt: "2026-08-07T10:00:05.000Z",
        controlSocket: join("/tmp", `${session.name}-missing.sock`),
        status: "exited",
      });
      const signals: Array<[number, NodeJS.Signals | 0]> = [];
      const substrate = createHsrSubstrate({
        readProcessIdentity: async (pid) => pid === hostBirth.pgid ? null : leader,
        readProcessGroupPresence: async () => group,
        isProcessGroupAlive: () => group === "present",
        kill: (pid, signal) => signals.push([pid, signal]),
      });

      const outcome = await transactionalRetire(session, {
        substrate,
        pollAttempts: 1,
        pollIntervalMs: 0,
        emitLedger: false,
      });
      assert.equal(outcome.ok, false, label);
      assert.equal((await loadSession(session.name))?.status, "kill_failed", label);
      assert.deepEqual(signals, [], `${label} legacy evidence never authorizes a signal`);
    });
  }
});

for (const operation of ["kill", "retire"] as const) {
  test(`transactional ${operation} fails closed on malformed existing HSR metadata`, async () => {
    await withTempStore(async () => {
      const session = record(`malformed-meta-${operation}`);
      await saveSession(session);
      await ensureHsrRunDir(session.name);
      await writeFile(hsrMetaPath(session.name), "{\"childPid\":4202", { mode: 0o600 });
      const signals: Array<[number, NodeJS.Signals | 0]> = [];
      const substrate = createHsrSubstrate({
        readProcessIdentity: async () => childBirth,
        isProcessGroupAlive: () => true,
        kill: (pid, signal) => signals.push([pid, signal]),
      });

      const outcome = operation === "kill"
        ? await transactionalKill(session, { substrate, pollAttempts: 1, pollIntervalMs: 0, emitLedger: false })
        : await transactionalRetire(session, { substrate, pollAttempts: 1, pollIntervalMs: 0, emitLedger: false });
      assert.equal(outcome.ok, false);
      assert.match(outcome.lastError, /Invalid JSON in HSR metadata/);
      assert.deepEqual(signals, [], "untrusted locators never receive a signal");
      const persisted = await loadSession(session.name);
      assert.equal(persisted?.status, "kill_failed");
      assert.equal(persisted?.id, session.id);
      assert.equal(persisted?.runtimeGeneration, session.runtimeGeneration);
      assert.equal(persisted?.brief, session.brief);
      assert.match(await readFile(hsrMetaPath(session.name), "utf8"), /childPid/);
    });
  });
}

test("transactional kill distinguishes EACCES metadata from ENOENT and preserves the exact record", async () => {
  await withTempStore(async () => {
    const session = record("unreadable-meta");
    await saveSession(session);
    await writeRuntimeMeta(session.name);
    await chmod(hsrMetaPath(session.name), 0o000);
    await assert.rejects(readHsrMetaStrict(session.name), /Unable to read HSR metadata.*EACCES|permission denied/i);
    const outcome = await transactionalKill(session, {
      substrate: createHsrSubstrate(),
      pollAttempts: 1,
      pollIntervalMs: 0,
      emitLedger: false,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.lastError, /Unable to read HSR metadata.*EACCES|permission denied/i);
    const persisted = await loadSession(session.name);
    assert.equal(persisted?.status, "kill_failed");
    assert.equal(persisted?.id, session.id);
    assert.equal(persisted?.runtimeGeneration, 7);
  });
});

test("unverifiable live child identity preserves the record with exact failure status", async () => {
  await withTempStore(async () => {
    const session = record("child-identity-unverifiable");
    await saveSession(session);
    await writeRuntimeMeta(session.name);
    const outcome = await transactionalRetire(session, {
      substrate: createHsrSubstrate({
        readProcessIdentity: async (pid) => {
          if (pid === hostBirth.pgid) return null;
          throw new Error("process census denied");
        },
        isProcessGroupAlive: () => true,
      }),
      pollAttempts: 1,
      pollIntervalMs: 0,
      emitLedger: false,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.stillRunning, true);
    const persisted = await loadSession(session.name);
    assert.equal(persisted?.status, "kill_failed");
    assert.match(persisted?.lastError ?? "", /HSR stop unconfirmed/);
    assert.equal(persisted?.id, session.id);
    assert.equal(persisted?.runtimeGeneration, 7);
  });
});

test("missing HSR metadata is not child-absence proof for a recorded runtime", async () => {
  await withTempStore(async () => {
    const session = record("missing-meta-unresolved");
    await saveSession(session);
    const outcome = await transactionalKill(session, {
      substrate: createHsrSubstrate(),
      pollAttempts: 1,
      pollIntervalMs: 0,
      emitLedger: false,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.lastError, /metadata is absent and detached child absence is unproven/);
    const persisted = await loadSession(session.name);
    assert.equal(persisted?.status, "kill_failed");
    assert.equal(persisted?.id, session.id);
    assert.equal(persisted?.runtimeGeneration, 7);
  });
});
