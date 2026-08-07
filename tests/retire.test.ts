import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { activationHomeOwnerPath } from "../src/accounts.js";
import { ensureHsrRunDir, hsrEventsPath, hsrMetaPath, hsrRingPath } from "../src/hsr/runDir.js";
import { purgeSessionData, transactionalKill, transactionalRetire } from "../src/kill.js";
import { recordSeal, sealsRoot, validateSealArtifact } from "../src/seal.js";
import { deriveState } from "../src/state.js";
import { ledgerPath, loadSession, saveSession, type SessionRecord } from "../src/store.js";
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

test("direct clean purge harvests credentials before deleting artifacts/metadata and remains bounded", async () => {
  await withTempStore(async () => {
    const ordered = seed({
      name: "clean-final-harvest",
      tmuxTarget: "clean-final-harvest",
      accountId: "codex-a",
      homePath: "/tmp/test-only-codex-a",
    });
    await saveSession(ordered);
    await recordSeal(ordered.name, validateSealArtifact({ status: "done", summary: "temporary test seal" }));
    await ensureHsrRunDir(ordered.name);
    await writeFile(hsrEventsPath(ordered.name), "temporary test events\n");

    await purgeSessionData(ordered, {
      emitLedger: false,
      finalCredentialSync: async (record) => {
        assert.equal(record.name, ordered.name);
        assert.ok(await loadSession(ordered.name), "metadata is still the credential binding during harvest");
        assert.ok((await readdir(join(sealsRoot(), ordered.name))).length > 0, "seals still exist during harvest");
        assert.match(await readFile(hsrEventsPath(ordered.name), "utf8"), /temporary test events/);
      },
    });
    assert.equal(await loadSession(ordered.name), null);
    await assert.rejects(readdir(join(sealsRoot(), ordered.name)), /ENOENT/);
    await assert.rejects(readFile(hsrEventsPath(ordered.name), "utf8"), /ENOENT/);

    const bounded = seed({
      name: "clean-wedged-harvest",
      tmuxTarget: "clean-wedged-harvest",
      accountId: "codex-a",
      homePath: "/tmp/test-only-codex-a",
    });
    await saveSession(bounded);
    const startedAt = Date.now();
    await purgeSessionData(bounded, {
      emitLedger: false,
      finalCredentialSync: async () => new Promise<void>(() => undefined),
      finalCredentialSyncBudgetMs: 20,
    });
    assert.ok(Date.now() - startedAt < 500, "destructive clean cannot wedge on credential harvest");
    assert.equal(await loadSession(bounded.name), null);
  });
});

test("clean skips stale-account harvest when a newer live record owns the shared custom home", async () => {
  await withTempStore(async (dir) => {
    const homePath = join(dir, "shared-custom-home");
    const stale = seed({
      name: "old-account-record",
      tmuxTarget: "old-account-record",
      accountId: "account-a",
      homePath,
      status: "dead",
      updatedAt: "2026-08-07T08:00:00.000Z",
    });
    const current = seed({
      name: "new-account-record",
      tmuxTarget: "new-account-record",
      accountId: "account-b",
      homePath,
      status: "running",
      updatedAt: "2026-08-07T08:05:00.000Z",
    });
    await saveSession(stale);
    await saveSession(current);
    let harvests = 0;

    await purgeSessionData(stale, {
      finalCredentialSync: async () => { harvests += 1; },
    });

    assert.equal(harvests, 0, "account B bytes must never be trusted as account A's final rotation");
    assert.equal(await loadSession(stale.name), null);
    assert.equal((await loadSession(current.name))?.accountId, "account-b", "clean deletes only the stale record");
    const ledger = (await readFile(ledgerPath(), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(ledger.some((event) =>
      event.type === "account.final-sync" &&
      event.session === stale.name &&
      event.skipped === "home-rebound" &&
      event.ownerAccount === "account-b"));
  });
});

test("clean honors a rebind activation stamp before the new session record is published", async () => {
  await withTempStore(async (dir) => {
    const homePath = join(dir, "activation-gap-home");
    const stale = seed({
      name: "pre-activation-account-a",
      tmuxTarget: "pre-activation-account-a",
      accountId: "account-a",
      homePath,
      status: "dead",
    });
    await saveSession(stale);
    const ownerPath = activationHomeOwnerPath(homePath);
    await mkdir(dirname(ownerPath), { recursive: true });
    await writeFile(ownerPath, JSON.stringify({
      version: 1,
      homePath,
      accountId: "account-b",
      generation: "activation-b-generation",
      state: "ready",
      activatedAt: "2026-08-07T08:05:00.000Z",
      updatedAt: "2026-08-07T08:05:00.000Z",
    }));
    let harvests = 0;

    await purgeSessionData(stale, {
      emitLedger: false,
      finalCredentialSync: async () => { harvests += 1; },
    });

    assert.equal(harvests, 0, "account B's lock-serialized claim closes the activation-to-record gap");
    assert.equal(await loadSession(stale.name), null);

    const failedHomePath = join(dir, "failed-activation-home");
    const failed = seed({
      name: "failed-activation-account-a",
      tmuxTarget: "failed-activation-account-a",
      accountId: "account-a",
      homePath: failedHomePath,
      status: "dead",
    });
    await saveSession(failed);
    const failedOwnerPath = activationHomeOwnerPath(failedHomePath);
    await mkdir(dirname(failedOwnerPath), { recursive: true });
    await writeFile(failedOwnerPath, JSON.stringify({
      version: 1,
      homePath: failedHomePath,
      accountId: "account-a",
      generation: "failed-account-a-generation",
      state: "activating",
      activatedAt: "2026-08-07T08:10:00.000Z",
      updatedAt: "2026-08-07T08:10:00.000Z",
    }));
    await purgeSessionData(failed, {
      emitLedger: false,
      finalCredentialSync: async () => { harvests += 1; },
    });
    assert.equal(
      harvests,
      0,
      "a matching but incomplete activation cannot authorize possibly-foreign bytes",
    );
  });
});

test("clean honors a ready foreign owner stamp on the nominal dedicated home", async () => {
  await withTempStore(async (dir) => {
    const homePath = join(dir, "homes", "account-a");
    const stale = seed({
      name: "dedicated-home-account-a",
      tmuxTarget: "dedicated-home-account-a",
      accountId: "account-a",
      homePath,
      status: "dead",
    });
    await saveSession(stale);
    const ownerPath = activationHomeOwnerPath(homePath);
    await mkdir(dirname(ownerPath), { recursive: true });
    await writeFile(ownerPath, JSON.stringify({
      version: 1,
      homePath,
      accountId: "account-b",
      generation: "explicit-dedicated-home-rebind-b",
      state: "ready",
      activatedAt: "2026-08-07T08:15:00.000Z",
      updatedAt: "2026-08-07T08:15:00.000Z",
    }));
    let harvests = 0;

    await purgeSessionData(stale, {
      finalCredentialSync: async () => { harvests += 1; },
    });

    assert.equal(harvests, 0, "a nominal dedicated path can be explicitly rebound to another account");
    assert.equal(await loadSession(stale.name), null);
    const ledger = (await readFile(ledgerPath(), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(ledger.some((event) =>
      event.type === "account.final-sync" &&
      event.session === stale.name &&
      event.skipped === "home-rebound" &&
      event.ownerAccount === "account-b"));
  });
});

test("transactional kill revalidates shared-home ownership immediately after stop", async () => {
  await withTempStore(async (dir) => {
    const homePath = join(dir, "post-stop-shared-home");
    const stale = seed({
      name: "stopping-account-a",
      tmuxTarget: "stopping-account-a",
      accountId: "account-a",
      homePath,
      updatedAt: "2026-08-07T08:00:00.000Z",
    });
    const rebound = seed({
      name: "started-account-b",
      tmuxTarget: "started-account-b",
      accountId: "account-b",
      homePath,
      updatedAt: "2026-08-07T08:05:00.000Z",
    });
    await saveSession(stale);
    let live = true;
    const substrate = fakeSubstrate({
      hasSession: async () => live,
      kill: async () => {
        live = false;
        await saveSession(rebound);
        return killOk();
      },
    });
    let harvests = 0;

    const outcome = await transactionalKill(stale, {
      substrate,
      pollIntervalMs: 0,
      emitLedger: false,
      finalCredentialSync: async () => { harvests += 1; },
    });

    assert.equal(outcome.ok, true);
    assert.equal(harvests, 0, "post-stop binding re-read observes the account B rebind before harvesting");
    assert.equal(await loadSession(stale.name), null);
    assert.equal((await loadSession(rebound.name))?.accountId, "account-b");
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
