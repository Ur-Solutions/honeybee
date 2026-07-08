import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { transactionalRetire } from "../src/kill.js";
import { deriveState } from "../src/state.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import type { KillResult, Substrate } from "../src/substrates/types.js";

async function withTempStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hive-retire-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function seed(record: Partial<SessionRecord> & { name: string; tmuxTarget: string }): SessionRecord {
  return {
    name: record.name,
    agent: record.agent ?? "codex",
    cwd: record.cwd ?? "/tmp",
    command: record.command ?? "codex",
    tmuxTarget: record.tmuxTarget,
    createdAt: record.createdAt ?? "2026-05-28T11:00:00.000Z",
    updatedAt: record.updatedAt ?? "2026-05-28T11:00:00.000Z",
    status: record.status ?? "running",
    ...(record.lastError ? { lastError: record.lastError } : {}),
  };
}

function killOk(): KillResult {
  return { ok: true, stdout: "", stderr: "", exitCode: 0 };
}

function fakeSubstrate(overrides: Partial<Substrate>): Substrate {
  return {
    kill: async () => killOk(),
    hasSession: async () => false,
    ...overrides,
  } as Substrate;
}

test("transactionalRetire archives the record instead of deleting it", async () => {
  await withTempStore(async () => {
    const record = seed({ name: "retire-me", tmuxTarget: "retire-me", lastError: "stale kill error" });
    await saveSession(record);
    let killed = 0;
    const substrate = fakeSubstrate({
      kill: async () => {
        killed += 1;
        return killOk();
      },
      hasSession: async () => killed === 0,
    });

    const outcome = await transactionalRetire(record, { substrate, pollIntervalMs: 0 });
    assert.equal(outcome.ok, true);

    const stored = await loadSession("retire-me");
    assert.ok(stored, "record must survive retire");
    assert.equal(stored!.status, "archived");
    assert.equal(stored!.lastError, undefined, "stale lastError is cleared on retire");
  });
});

test("transactionalRetire marks kill_failed when the session survives", async () => {
  await withTempStore(async () => {
    const record = seed({ name: "stubborn", tmuxTarget: "stubborn" });
    await saveSession(record);
    const substrate = fakeSubstrate({ hasSession: async () => true });

    const outcome = await transactionalRetire(record, { substrate, pollAttempts: 2, pollIntervalMs: 0 });
    assert.equal(outcome.ok, false);

    const stored = await loadSession("stubborn");
    assert.ok(stored);
    assert.equal(stored!.status, "kill_failed");
  });
});

test("a running record with no live session derives crashed; an explicit dead record derives dead", () => {
  const crashedRecord = seed({ name: "was-running", tmuxTarget: "was-running", status: "running" });
  const deadRecord = seed({ name: "marked-dead", tmuxTarget: "marked-dead", status: "dead" });
  const context = { liveTargets: new Set<string>() };

  const crashed = deriveState(crashedRecord, context);
  assert.equal(crashed.state, "crashed");
  assert.match(crashed.detail, /without retire\/kill/);

  const dead = deriveState(deadRecord, context);
  assert.equal(dead.state, "dead");
});

test("an archived (retired) record derives archived even without a live session", () => {
  const retired = seed({ name: "filed", tmuxTarget: "filed", status: "archived" });
  const derived = deriveState(retired, { liveTargets: new Set<string>() });
  assert.equal(derived.state, "archived");
});

test("an hsr record that is not live derives crashed when still marked running", () => {
  const record = { ...seed({ name: "hsr-bee", tmuxTarget: "hsr-bee", status: "running" }), substrate: "hsr" as const };
  const derived = deriveState(record, { liveTargets: new Set<string>(), hsrLive: new Set<string>() });
  assert.equal(derived.state, "crashed");
});
