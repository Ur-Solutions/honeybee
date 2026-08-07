import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessDispatchError, hsrHarnessControl } from "../src/execution/harnessControl.js";
import { storeSessionEvidenceSource } from "../src/execution/service.js";
import { ensureHsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import { saveSession } from "../src/store.js";

async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const previous = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-execution-identity-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("harness control refuses a recycled host PID and fails closed on legacy identity", async () => {
  await withTempStore(async () => {
    const bee = "identity-control";
    const recorded = { pgid: 9191, startedAt: "Mon Aug  7 09:00:00 2026" };
    const replacement = { pgid: 9191, startedAt: "Mon Aug  7 09:01:00 2026" };
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: 9191,
      hostFingerprint: recorded,
      startedAt: new Date().toISOString(),
      runningAt: new Date().toISOString(),
      controlSocket: "/tmp/unrelated-replacement.sock",
      status: "running",
    });
    const control = hsrHarnessControl({ processIdentityReader: async () => replacement });
    await assert.rejects(
      control.send(bee, "must not deliver", "delivery-1"),
      (error: unknown) => error instanceof HarnessDispatchError && error.outcome === "failed" && /no live runner host/.test(error.message),
    );
    assert.deepEqual(await control.stop(bee), {
      stopped: true,
      detail: "recorded harness incarnation exited",
    });

    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: 9191,
      startedAt: new Date().toISOString(),
      runningAt: new Date().toISOString(),
      controlSocket: "/tmp/legacy.sock",
      status: "running",
    });
    assert.deepEqual(await control.stop(bee), {
      stopped: false,
      detail: "clean stop unconfirmed: runner host birth identity is unavailable",
    });
  });
});

test("production execution evidence never turns stale numeric readiness into running", async () => {
  await withTempStore(async () => {
    const bee = "identity-evidence";
    const now = new Date().toISOString();
    await saveSession({
      name: bee,
      agent: "claude",
      cwd: "/",
      command: "claude",
      tmuxTarget: bee,
      substrate: "hsr",
      createdAt: now,
      updatedAt: now,
      status: "running",
      id: "CO.canonical-identity",
      executionRunId: "run-identity",
    });
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, {
      bee,
      harness: "claude",
      tier: "stream",
      hostPid: process.pid,
      hostFingerprint: { pgid: process.pid, startedAt: "Mon Aug  7 01:00:00 2000" },
      startedAt: now,
      runningAt: now,
      controlSocket: "/tmp/stale-execution.sock",
      status: "running",
    });

    const sessions = storeSessionEvidenceSource();
    assert.deepEqual(await sessions.evidence(bee), {
      sessionExists: true,
      stampedRunId: "run-identity",
      sessionRef: "CO.canonical-identity",
      ready: false,
    });
    assert.deepEqual(await sessions.outcome(bee), { live: false, exitCode: null });
  });
});
