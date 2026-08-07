import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ensureHsrRunDir, hsrEventsPath, hsrMetaPath, hsrRingPath } from "../src/hsr/runDir.js";
import { transactionalKill, transactionalRetire } from "../src/kill.js";
import { recordSeal, sealsRoot, validateSealArtifact } from "../src/seal.js";
import { deriveState } from "../src/state.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import type { KillResult, Substrate } from "../src/substrates/types.js";

const execFileAsync = promisify(execFile);

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
    ...(record.accountId ? { accountId: record.accountId } : {}),
    ...(record.homePath ? { homePath: record.homePath } : {}),
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
    const record = { ...seed({ name: "retire-me", tmuxTarget: "retire-me", lastError: "stale kill error" }), substrate: "hsr" as const };
    await saveSession(record);
    await recordSeal(record.name, validateSealArtifact({ status: "done", summary: "keep me" }));
    await ensureHsrRunDir(record.name);
    await writeFile(hsrEventsPath(record.name), '{"type":"text","ts":1,"text":"history"}\n');
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
    assert.equal(stored!.status, "done");
    assert.equal(stored!.lastError, undefined, "stale lastError is cleared on retire");
    assert.match(await readFile(hsrEventsPath(record.name), "utf8"), /history/, "retire keeps HSR history");
    const [sealFile] = await readdir(join(sealsRoot(), record.name));
    assert.match(await readFile(join(sealsRoot(), record.name, sealFile!), "utf8"), /keep me/);
  });
});

test("hive retire --compact compacts HSR events but preserves metadata, seals, meta, and ring", async () => {
  await withTempStore(async (dir) => {
    const record = { ...seed({ name: "compact-me", tmuxTarget: "compact-me" }), substrate: "hsr" as const };
    await saveSession(record);
    await recordSeal(record.name, validateSealArtifact({ status: "done", summary: "retained seal" }));
    await ensureHsrRunDir(record.name);
    await writeFile(hsrMetaPath(record.name), JSON.stringify({
      bee: record.name,
      harness: "codex",
      tier: "turn",
      hostPid: 0,
      startedAt: "2026-08-01T00:00:00.000Z",
      controlSocket: "/tmp/missing.sock",
      status: "exited",
    }));
    await writeFile(hsrRingPath(record.name), "rendered tail\n");
    const events = Array.from({ length: 600 }, (_, index) => JSON.stringify({ type: "text", ts: index, text: `line ${index}` })).join("\n") + "\n";
    await writeFile(hsrEventsPath(record.name), events);

    await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "retire", record.name, "--compact"], {
      cwd: process.cwd(),
      env: { ...process.env, HIVE_STORE_ROOT: dir, NO_COLOR: "1", TERM: "dumb" },
    });

    assert.equal((await loadSession(record.name))?.status, "done");
    assert.match(await readFile(hsrMetaPath(record.name), "utf8"), /compact-me/);
    assert.equal(await readFile(hsrRingPath(record.name), "utf8"), "rendered tail\n");
    assert.ok((await readFile(hsrEventsPath(record.name), "utf8")).split("\n").filter(Boolean).length <= 401);
    assert.ok((await readdir(join(sealsRoot(), record.name))).length > 0);
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

test("retire and purge stay bounded when their post-exit credential harvest never settles", async () => {
  await withTempStore(async () => {
    const retireRecord = seed({
      name: "retire-wedged-sync",
      tmuxTarget: "retire-wedged-sync",
      accountId: "codex-a",
      homePath: "/tmp/codex-a",
    });
    const purgeRecord = seed({
      name: "purge-wedged-sync",
      tmuxTarget: "purge-wedged-sync",
      accountId: "codex-a",
      homePath: "/tmp/codex-a",
    });
    await saveSession(retireRecord);
    await saveSession(purgeRecord);
    const neverSync = async (): Promise<void> => new Promise<void>(() => undefined);
    const options = {
      substrate: fakeSubstrate({}),
      pollIntervalMs: 0,
      emitLedger: false,
      finalCredentialSync: neverSync,
      finalCredentialSyncBudgetMs: 20,
    };

    const startedAt = Date.now();
    assert.equal((await transactionalRetire(retireRecord, options)).ok, true);
    assert.equal((await transactionalKill(purgeRecord, options)).ok, true);
    assert.ok(Date.now() - startedAt < 500, "both lifecycle operations honor the short final-sync budget");
    assert.equal((await loadSession("retire-wedged-sync"))?.status, "done");
    assert.equal(await loadSession("purge-wedged-sync"), null);
  });
});

test("successful retire harvests credentials only after the runtime is confirmed gone", async () => {
  await withTempStore(async () => {
    const target = seed({
      name: "retire-final-harvest",
      tmuxTarget: "retire-final-harvest",
      accountId: "codex-a",
      homePath: "/tmp/codex-a",
    });
    await saveSession(target);
    let live = true;
    const order: string[] = [];
    const substrate = fakeSubstrate({
      kill: async () => {
        order.push("kill");
        live = false;
        return killOk();
      },
      hasSession: async () => live,
    });

    const outcome = await transactionalRetire(target, {
      substrate,
      pollIntervalMs: 0,
      emitLedger: false,
      finalCredentialSync: async () => {
        assert.equal(live, false, "credential harvest starts after teardown confirmation");
        order.push("sync");
      },
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(order, ["kill", "sync"]);
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
  const retired = seed({ name: "filed", tmuxTarget: "filed", status: "done" });
  const derived = deriveState(retired, { liveTargets: new Set<string>() });
  assert.equal(derived.state, "done");
});

test("an hsr record that is not live derives crashed when still marked running", () => {
  const record = { ...seed({ name: "hsr-bee", tmuxTarget: "hsr-bee", status: "running" }), substrate: "hsr" as const };
  const derived = deriveState(record, { liveTargets: new Set<string>(), hsrLive: new Set<string>() });
  assert.equal(derived.state, "crashed");
});
