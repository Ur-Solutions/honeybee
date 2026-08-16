import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessDispatchError, hsrHarnessControl } from "../src/execution/harnessControl.js";
import { storeSessionEvidenceSource } from "../src/execution/service.js";
import { ensureHsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import { saveSession, transitionSession, updateSession } from "../src/store.js";

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

test("record-only execution outcomes obey canonical lifecycle over stale status scalars", async () => {
  await withTempStore(async () => {
    const at = new Date().toISOString();
    const base = (name: string) => ({
      name,
      agent: "claude",
      cwd: "/",
      command: "claude",
      tmuxTarget: name,
      substrate: "hsr" as const,
      createdAt: at,
      updatedAt: at,
      status: "running" as const,
    });

    const active = base("execution-active-stale-done");
    await saveSession(active);
    await transitionSession(active.name, {
      type: "turn.started",
      eventId: "execution-active",
      at,
      cause: "first-turn",
      evidence: { kind: "hook", hookId: "execution-active", observedAt: at, hook: "turn-start" },
    });
    await updateSession(active.name, { status: "done" });

    const archived = base("execution-archived-stale-running");
    await saveSession(archived);
    await transitionSession(archived.name, {
      type: "bee.archived",
      eventId: "execution-archived",
      at,
      cause: "retire",
      evidence: { kind: "operator", actionId: "execution-archived", observedAt: at, action: "retire" },
      probe: {
        kind: "probe",
        probeId: "execution-archived",
        observerId: "execution-test",
        observedAt: at,
        outcome: "dead",
        target: { substrate: "hsr" },
      },
    });
    await updateSession(archived.name, { status: "running" });

    const sessions = storeSessionEvidenceSource();
    assert.equal(await sessions.outcome(active.name), null, "active record-only HSR liveness stays unknown");
    assert.deepEqual(await sessions.outcome(archived.name), { live: false, exitCode: null });
  });
});

test("legacy failed-stop evidence is unknown, while legacy dead and done remain terminal proof", async () => {
  await withTempStore(async () => {
    const at = new Date().toISOString();
    const base = (name: string, status: "kill_failed" | "dead" | "done") => ({
      name,
      agent: "claude",
      cwd: "/",
      command: "claude",
      tmuxTarget: name,
      substrate: "hsr" as const,
      createdAt: at,
      updatedAt: at,
      status,
    });
    await saveSession(base("execution-legacy-stop-doubt", "kill_failed"));
    await saveSession(base("execution-legacy-dead", "dead"));
    await saveSession(base("execution-legacy-done", "done"));

    const sessions = storeSessionEvidenceSource();
    assert.equal(await sessions.outcome("execution-legacy-stop-doubt"), null);
    assert.deepEqual(await sessions.outcome("execution-legacy-dead"), { live: false, exitCode: null });
    assert.deepEqual(await sessions.outcome("execution-legacy-done"), { live: false, exitCode: null });
  });
});

test("SessionRecord lifecycle and stop doubt outrank contradictory HSR process meta", async () => {
  await withTempStore(async () => {
    const at = new Date().toISOString();
    const save = async (name: string, status: "running" | "dead" | "done" | "kill_failed") => {
      await saveSession({
        name,
        agent: "claude",
        cwd: "/",
        command: "claude",
        tmuxTarget: name,
        substrate: "hsr",
        createdAt: at,
        updatedAt: at,
        status,
      });
    };
    const meta = async (name: string, status: "running" | "exited") => {
      await ensureHsrRunDir(name);
      await writeHsrMeta(name, {
        bee: name,
        harness: "claude",
        tier: "stream",
        hostPid: 0,
        startedAt: at,
        ...(status === "running" ? { runningAt: at } : { endedAt: at, exitCode: 0 }),
        controlSocket: "/tmp/execution-meta-precedence.sock",
        status,
        mirrorOfNode: "fixture-node",
      });
    };

    await save("execution-archived-live-meta", "running");
    await transitionSession("execution-archived-live-meta", {
      type: "bee.archived",
      eventId: "execution-archived-live-meta",
      at,
      cause: "retire",
      evidence: { kind: "operator", actionId: "execution-archived-live-meta", observedAt: at, action: "retire" },
      probe: {
        kind: "probe",
        probeId: "execution-archived-live-meta",
        observerId: "execution-test",
        observedAt: at,
        outcome: "dead",
        target: { substrate: "hsr" },
      },
    });
    await meta("execution-archived-live-meta", "running");

    await save("execution-stop-doubt-exited-meta", "running");
    await transitionSession("execution-stop-doubt-exited-meta", {
      type: "turn.started",
      eventId: "execution-stop-doubt-active",
      at,
      cause: "first-turn",
      evidence: { kind: "hook", hookId: "execution-stop-doubt-active", observedAt: at, hook: "turn-start" },
    });
    await updateSession("execution-stop-doubt-exited-meta", { status: "kill_failed" });
    await meta("execution-stop-doubt-exited-meta", "exited");

    await save("execution-legacy-done-live-meta", "done");
    await meta("execution-legacy-done-live-meta", "running");

    const sessions = storeSessionEvidenceSource();
    assert.deepEqual(await sessions.outcome("execution-archived-live-meta"), { live: false, exitCode: null });
    assert.equal(await sessions.outcome("execution-stop-doubt-exited-meta"), null);
    assert.deepEqual(await sessions.outcome("execution-legacy-done-live-meta"), { live: false, exitCode: null });
  });
});
