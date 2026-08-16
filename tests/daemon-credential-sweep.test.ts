import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AccountRecord } from "../src/accounts.js";
import {
  accountDir,
  accountLockPath,
  activationHomeOwnerPath,
  addAccount,
  canonicalActivationHomePath,
  syncAccountCredentialsToVault,
  withActivationHomeLock,
  withAccountLock,
  withReadyActivationHomeOwner,
} from "../src/accounts.js";
import { fileLockMutationGuardPath, readFileLockIdentity } from "../src/lock.js";
import {
  planCredentialSweep,
  runCredentialSweep,
  type CredentialSweepTelemetry,
} from "../src/daemon/credentialSweep.js";
import {
  createIsolatedCredentialSweeper,
  CredentialSweepTimeoutError,
  reapCredentialWorkerLocks,
  type CredentialSweepChild,
} from "../src/daemon/credentialSweepProcess.js";
import { createCredentialSyncController } from "../src/daemon/credentialSyncController.js";
import type { ProcessBirthFingerprint, ProcessIdentityReader } from "../src/hsr/processIdentity.js";
import type { SessionRecord } from "../src/store.js";
import { lifecycleCursor } from "./lifecycle-fixtures.js";

function account(id: string): AccountRecord {
  return {
    id,
    tool: "codex",
    provider: "openai",
    label: id,
    addedAt: "2026-08-01T00:00:00.000Z",
  };
}

function record(
  name: string,
  accountId: string,
  homePath: string,
  updatedAt: string,
  status: SessionRecord["status"] = "done",
): SessionRecord {
  return {
    name,
    agent: "codex",
    cwd: "/tmp",
    command: "codex",
    tmuxTarget: name,
    accountId,
    homePath,
    createdAt: updatedAt,
    updatedAt,
    status,
  };
}

function telemetry(overrides: Partial<CredentialSweepTelemetry> = {}): CredentialSweepTelemetry {
  return {
    durationMs: 0,
    attemptedAccounts: 1,
    completedAccounts: 0,
    failedAccounts: 0,
    attemptedPairs: 3_000,
    uniquePairs: 19,
    scheduledPairs: 2,
    skippedPairs: 2_998,
    duplicatePairs: 2_981,
    canonicalCoveredPairs: 17,
    unknownAccountPairs: 0,
    completedPairs: 0,
    failedPairs: 0,
    timedOutPairs: 0,
    vaultUpdates: 0,
    quarantinedItems: 0,
    completedQuarantinedItems: 0,
    retainedQuarantinedItems: 0,
    ...overrides,
  };
}

async function withTempStore<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "hive-credential-sweep-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function writeDated(path: string, text: string, timestamp: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  const when = new Date(timestamp);
  await utimes(path, when, when);
}

function genericAuth(token: string): string {
  return JSON.stringify({ "zai-coding-plan": { type: "api", key: token } });
}

test("credential sweep plan collapses 3k records to 19 canonical pairs and current/newest evidence wins", async () => {
  const accounts = Array.from({ length: 19 }, (_, index) => account(`codex-${index}`));
  const records = Array.from({ length: 3_000 }, (_, index) => {
    const pair = index % 19;
    return record(
      `CO.${String(index).padStart(4, "0")}`,
      `codex-${pair}`,
      pair === 0 && index === 19 ? "/tmp/sweep-home-0/../sweep-home-0" : `/tmp/sweep-home-${pair}`,
      new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
      "done",
    );
  });
  // A current record beats newer retired history for the same canonical pair.
  records.push(record("CO.current", "codex-0", "/tmp/sweep-home-0", "2026-07-01T00:00:00.000Z", "running"));

  const plan = await planCredentialSweep(records, accounts);
  assert.equal(plan.attemptedPairs, 3_001);
  assert.equal(plan.uniquePairs, 19);
  assert.equal(plan.duplicatePairs, 2_982);
  assert.equal(plan.extraPairs.length, 19);
  assert.equal(plan.skippedPairs, 2_982);
  assert.equal(plan.pairs.find((pair) => pair.account.id === "codex-0")?.evidence.name, "CO.current");
  assert.equal(plan.pairs.find((pair) => pair.account.id === "codex-0")?.homePath, await canonicalActivationHomePath("/tmp/sweep-home-0"));
});

test("credential evidence prefers canonical active records over archived records despite stale scalars", async () => {
  const acct = account("codex-lifecycle");
  const home = "/tmp/credential-lifecycle";
  const activeDone = record("CO.active-done", acct.id, home, "2026-07-01T00:00:01.000Z", "done");
  activeDone.stateMachine = lifecycleCursor(activeDone.name, "active", activeDone.updatedAt);
  const activeDead = record("CO.active-dead", acct.id, home, "2026-07-01T00:00:02.000Z", "dead");
  activeDead.stateMachine = lifecycleCursor(activeDead.name, "active", activeDead.updatedAt);
  const archivedRunning = record("CO.archived-running", acct.id, home, "2026-08-01T00:00:00.000Z", "running");
  archivedRunning.stateMachine = lifecycleCursor(archivedRunning.name, "archived", archivedRunning.updatedAt);

  const plan = await planCredentialSweep([activeDone, activeDead, archivedRunning], [acct]);
  assert.equal(plan.pairs[0]?.evidence.name, activeDead.name, "newest canonical-active evidence wins");
});

test("credential sweep runs canonical accounts once and skips their dedicated session pairs", async () => {
  await withTempStore(async (root) => {
    const acct = account("codex-primary");
    const canonicalHome = join(root, "homes", acct.id);
    const historicalHome = join(root, "old-homes", acct.id);
    const records = [
      record("CO.live", acct.id, canonicalHome, "2026-08-07T10:00:00.000Z", "running"),
      record("CO.old-duplicate", acct.id, canonicalHome, "2026-08-01T10:00:00.000Z"),
      record("CO.historical-home", acct.id, historicalHome, "2026-07-01T10:00:00.000Z"),
    ];
    const calls: Array<{ home?: string; trusted?: boolean }> = [];

    const result = await runCredentialSweep({
      listAccounts: async () => [acct],
      listSessions: async () => records,
      syncAccount: async (_account, home, options) => {
        calls.push({ ...(home ? { home } : {}), ...(options?.trustExtraHome ? { trusted: true } : {}) });
        return { auth: null, vaultUpdated: false, skipped: [] };
      },
      accountHomes: async () => [canonicalHome],
      now: (() => {
        let value = 100;
        return () => value++;
      })(),
      concurrency: 1,
    });

    assert.deepEqual(calls, [
      { home: await canonicalActivationHomePath(canonicalHome), trusted: true },
      { home: await canonicalActivationHomePath(historicalHome), trusted: true },
    ]);
    assert.equal(result.attemptedPairs, 3);
    assert.equal(result.uniquePairs, 2);
    assert.equal(result.canonicalCoveredPairs, 1);
    assert.equal(result.scheduledPairs, 1);
    assert.equal(result.skippedPairs, 2, "one duplicate + one account-sweep-covered pair");
    assert.equal(result.completedAccounts, 1);
    assert.equal(result.completedPairs, 1);
  });
});

test("periodic account scan skips a nominal home rebound to a foreign ready owner", async () => {
  await withTempStore(async (root) => {
    const original = await addAccount("opencode", "sweep-original", { provider: "zai-coding-plan" });
    const rebound = await addAccount("opencode", "sweep-rebound", { provider: "zai-coding-plan" });
    const relative = join("xdg-data", "opencode", "auth.json");
    const originalVault = join(accountDir(original), relative);
    const nominalHome = join(root, "homes", original.id);
    await writeDated(originalVault, genericAuth("account-a-vault"), "2026-08-07T08:00:00.000Z");
    await writeDated(join(nominalHome, relative), genericAuth("account-b-home"), "2026-08-07T08:10:00.000Z");
    const ownerPath = await activationHomeOwnerPath(nominalHome);
    await mkdir(dirname(ownerPath), { recursive: true });
    await writeFile(ownerPath, JSON.stringify({
      version: 1,
      homePath: await canonicalActivationHomePath(nominalHome),
      accountId: rebound.id,
      generation: "periodic-rebound-b",
      state: "ready",
      activatedAt: "2026-08-07T08:10:00.000Z",
      updatedAt: "2026-08-07T08:10:00.000Z",
    }));

    const sweep = () => runCredentialSweep({
      listAccounts: async () => [original],
      listSessions: async () => [record("CO.rebound", rebound.id, nominalHome, "2026-08-07T08:10:00.000Z", "running")],
      accountHomes: async () => [nominalHome],
      concurrency: 1,
    });
    await sweep();

    assert.match(await readFile(originalVault, "utf8"), /account-a-vault/);
    assert.doesNotMatch(await readFile(originalVault, "utf8"), /account-b-home/);

    await writeFile(ownerPath, JSON.stringify({
      version: 1,
      homePath: await canonicalActivationHomePath(nominalHome),
      accountId: original.id,
      generation: "periodic-incomplete-a",
      state: "activating",
      activatedAt: "2026-08-07T08:11:00.000Z",
      updatedAt: "2026-08-07T08:11:00.000Z",
    }));
    await sweep();
    assert.doesNotMatch(await readFile(originalVault, "utf8"), /account-b-home/, "activating never authorizes bytes");

    await writeFile(ownerPath, "{malformed");
    const malformed = await sweep();
    assert.equal(malformed.failedAccounts, 1, "malformed owner state fails the account scan closed");
    assert.doesNotMatch(await readFile(originalVault, "utf8"), /account-b-home/);
  });
});

test("unstamped nominal homes require affirmative legacy account evidence", async () => {
  await withTempStore(async (root) => {
    const original = await addAccount("opencode", "legacy-proof", { provider: "zai-coding-plan" });
    const relative = join("xdg-data", "opencode", "auth.json");
    const originalVault = join(accountDir(original), relative);
    const nominalHome = join(root, "homes", original.id);
    const syncExplicitly = (account: AccountRecord, home?: string, options = {}) =>
      syncAccountCredentialsToVault(account, home, { ...options, authorization: "explicit" });
    await writeDated(originalVault, genericAuth("legacy-a-vault"), "2026-08-07T08:00:00.000Z");
    await writeDated(join(nominalHome, relative), genericAuth("unattributed-b-home"), "2026-08-07T08:10:00.000Z");

    const unproven = await runCredentialSweep({
      listAccounts: async () => [original],
      listSessions: async () => [],
      syncAccount: syncExplicitly,
      accountHomes: async () => [nominalHome],
      concurrency: 1,
    });
    assert.match(await readFile(originalVault, "utf8"), /legacy-a-vault/);
    assert.doesNotMatch(await readFile(originalVault, "utf8"), /unattributed-b-home/);
    assert.equal(unproven.vaultUpdates, 0, "a dedicated pathname alone does not authorize credential bytes");

    await writeDated(join(nominalHome, relative), genericAuth("legacy-a-rotated"), "2026-08-07T08:20:00.000Z");
    const proven = await runCredentialSweep({
      listAccounts: async () => [original],
      listSessions: async () => [
        record("CO.legacy-a", original.id, nominalHome, "2026-08-07T08:20:00.000Z", "done"),
      ],
      syncAccount: syncExplicitly,
      accountHomes: async () => [nominalHome],
      concurrency: 1,
    });
    assert.match(await readFile(originalVault, "utf8"), /legacy-a-rotated/);
    assert.equal(proven.vaultUpdates, 1, "affirmative same-account legacy evidence permits recovery");
  });
});

test("a ready owner stamp yields to newer live mixed-version session evidence", async () => {
  await withTempStore(async (root) => {
    const original = await addAccount("opencode", "stamped-original", { provider: "zai-coding-plan" });
    const rebound = await addAccount("opencode", "stamped-rebound", { provider: "zai-coding-plan" });
    const relative = join("xdg-data", "opencode", "auth.json");
    const originalVault = join(accountDir(original), relative);
    const nominalHome = join(root, "homes", original.id);
    const syncExplicitly = (account: AccountRecord, home?: string, options = {}) =>
      syncAccountCredentialsToVault(account, home, { ...options, authorization: "explicit" });
    await writeDated(originalVault, genericAuth("stamped-a-vault"), "2026-08-07T08:00:00.000Z");
    await writeDated(join(nominalHome, relative), genericAuth("mixed-version-b-home"), "2026-08-07T08:10:00.000Z");
    const ownerPath = await activationHomeOwnerPath(nominalHome);
    await mkdir(dirname(ownerPath), { recursive: true });
    const owner = (updatedAt: string, generation: string) => ({
      version: 1 as const,
      homePath: nominalHome,
      accountId: original.id,
      generation,
      state: "ready" as const,
      activatedAt: updatedAt,
      updatedAt,
    });
    await writeFile(ownerPath, JSON.stringify(owner("2026-08-07T08:05:00.000Z", "before-old-writer")));

    const liveForeign = record("CO.mixed-b", rebound.id, nominalHome, "2026-08-07T08:10:00.000Z", "running");
    const rejected = await runCredentialSweep({
      listAccounts: async () => [original],
      listSessions: async () => [liveForeign],
      syncAccount: syncExplicitly,
      accountHomes: async () => [nominalHome],
      concurrency: 1,
    });
    assert.match(await readFile(originalVault, "utf8"), /stamped-a-vault/);
    assert.doesNotMatch(await readFile(originalVault, "utf8"), /mixed-version-b-home/);
    assert.equal(rejected.vaultUpdates, 0);

    await writeDated(join(nominalHome, relative), genericAuth("stamped-a-restored"), "2026-08-07T08:20:00.000Z");
    await writeFile(ownerPath, JSON.stringify(owner("2026-08-07T08:20:00.000Z", "after-old-writer")));
    const recovered = await runCredentialSweep({
      listAccounts: async () => [original],
      listSessions: async () => [{ ...liveForeign, status: "done", updatedAt: "2026-08-07T08:10:00.000Z" }],
      syncAccount: syncExplicitly,
      accountHomes: async () => [nominalHome],
      concurrency: 1,
    });
    assert.match(await readFile(originalVault, "utf8"), /stamped-a-restored/);
    assert.equal(recovered.vaultUpdates, 1, "a newer A restamp supersedes terminal older foreign evidence");
  });
});

test("periodic extra pair skips stale account evidence when a newer live foreign session owns the home", async () => {
  await withTempStore(async (root) => {
    const original = await addAccount("opencode", "extra-original", { provider: "zai-coding-plan" });
    const rebound = await addAccount("opencode", "extra-rebound", { provider: "zai-coding-plan" });
    const relative = join("xdg-data", "opencode", "auth.json");
    const originalVault = join(accountDir(original), relative);
    const sharedHome = join(root, "shared-extra-home");
    await writeDated(originalVault, genericAuth("extra-a-vault"), "2026-08-07T08:00:00.000Z");
    await writeDated(join(sharedHome, relative), genericAuth("extra-b-home"), "2026-08-07T08:10:00.000Z");
    const result = await runCredentialSweep({
      listAccounts: async () => [original],
      listSessions: async () => [
        record("CO.old-a", original.id, sharedHome, "2026-08-07T08:00:00.000Z", "done"),
        record("CO.live-b", rebound.id, sharedHome, "2026-08-07T08:10:00.000Z", "running"),
      ],
      accountHomes: async () => [],
      concurrency: 1,
    });

    assert.match(await readFile(originalVault, "utf8"), /extra-a-vault/);
    assert.doesNotMatch(await readFile(originalVault, "utf8"), /extra-b-home/);
    assert.equal(result.completedPairs, 0);
  });
});

test("periodic sweep physically deduplicates aliases and rejects their foreign binding", async () => {
  await withTempStore(async (root) => {
    const original = await addAccount("opencode", "alias-original", { provider: "zai-coding-plan" });
    const rebound = await addAccount("opencode", "alias-rebound", { provider: "zai-coding-plan" });
    const relative = join("xdg-data", "opencode", "auth.json");
    const originalVault = join(accountDir(original), relative);
    const physicalHome = join(root, "physical-alias-home");
    const aliasHome = join(root, "periodic-home-alias");
    await writeDated(originalVault, genericAuth("alias-a-vault"), "2026-08-07T08:00:00.000Z");
    await writeDated(join(physicalHome, relative), genericAuth("alias-b-home"), "2026-08-07T08:10:00.000Z");
    await symlink(physicalHome, aliasHome);
    const result = await runCredentialSweep({
      listAccounts: async () => [original],
      listSessions: async () => [
        record("CO.old-a-alias", original.id, aliasHome, "2026-08-07T08:00:00.000Z", "done"),
        record("CO.old-a-real", original.id, physicalHome, "2026-08-07T08:01:00.000Z", "done"),
        record("CO.live-b-real", rebound.id, physicalHome, "2026-08-07T08:10:00.000Z", "running"),
      ],
      accountHomes: async () => [],
      concurrency: 1,
    });

    assert.equal(result.attemptedPairs, 3);
    assert.equal(result.uniquePairs, 2, "real and alias spellings collapse to one physical pair per account");
    assert.equal(result.duplicatePairs, 1);
    assert.match(await readFile(originalVault, "utf8"), /alias-a-vault/);
    assert.doesNotMatch(await readFile(originalVault, "utf8"), /alias-b-home/);
  });
});

test("interactive pair sync rejects a rebound alias and holds its canonical owner lock through sync", async () => {
  await withTempStore(async (root) => {
    const physicalHome = join(root, "interactive-physical-home");
    const aliasHome = join(root, "interactive-home-alias");
    await mkdir(physicalHome, { recursive: true });
    await symlink(physicalHome, aliasHome);
    const canonicalHome = await canonicalActivationHomePath(physicalHome);
    const ownerPath = await activationHomeOwnerPath(aliasHome);
    await mkdir(dirname(ownerPath), { recursive: true });
    const writeOwner = (accountId: string) => writeFile(ownerPath, JSON.stringify({
      version: 1,
      homePath: canonicalHome,
      accountId,
      generation: `interactive-${accountId}`,
      state: "ready",
      activatedAt: "2026-08-07T09:00:00.000Z",
      updatedAt: "2026-08-07T09:00:00.000Z",
    }));

    await writeOwner("account-b");
    let syncCalls = 0;
    const rebound = await withReadyActivationHomeOwner("account-a", aliasHome, async () => {
      syncCalls += 1;
    });
    assert.deepEqual(rebound, { authorized: false });
    assert.equal(syncCalls, 0, "foreign ready owner prevents the interactive vault sync");

    await writeOwner("account-a");
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolveSync) => {
      releaseSync = resolveSync;
    });
    let enteredSync!: () => void;
    const syncEntered = new Promise<void>((resolveEntered) => {
      enteredSync = resolveEntered;
    });
    const guardedSync = withReadyActivationHomeOwner("account-a", aliasHome, async (lockedHomePath) => {
      assert.equal(lockedHomePath, canonicalHome, "sync receives the stable physical home identity");
      enteredSync();
      await syncGate;
      return "synced";
    });
    await syncEntered;

    let rebindAcquired = false;
    const rebind = withActivationHomeLock(physicalHome, async () => {
      rebindAcquired = true;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    assert.equal(rebindAcquired, false, "a concurrent rebind cannot enter while isolated sync reads the home");

    releaseSync();
    assert.deepEqual(await guardedSync, { authorized: true, value: "synced" });
    await rebind;
    assert.equal(rebindAcquired, true);
  });
});

test("credential sync controller never overlaps repeated intervals and explicitly reports late settlement", async () => {
  // Incident validation (2026-08-07): same-account activation at 06:56:00,
  // another bee hit /login at 06:56:28, and chain.sync timed out at 06:56:58.
  // Repeated scheduler intervals below model that abandoned overlap window:
  // no second sweep may start until the exact first promise settles.
  let calls = 0;
  let releaseFirst!: (value: CredentialSweepTelemetry) => void;
  const first = new Promise<CredentialSweepTelemetry>((resolveFirst) => {
    releaseFirst = resolveFirst;
  });
  const late: string[] = [];
  const controller = createCredentialSyncController(
    () => {
      calls += 1;
      return calls === 1 ? first : Promise.resolve(telemetry({ completedAccounts: 1 }));
    },
    {
      budgetMs: 20,
      onLateSettlement: (settlement) => late.push(settlement.status),
    },
  );

  assert.equal((await controller.run()).status, "timed-out");
  assert.equal((await controller.run()).status, "skipped-inflight");
  assert.equal((await controller.run()).status, "skipped-inflight");
  assert.equal(calls, 1, "repeated intervals do not start overlapping work");

  releaseFirst(telemetry({ completedAccounts: 1 }));
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.deepEqual(late, ["completed"]);
  assert.equal((await controller.run()).status, "completed", "the next run recovers after late settlement");
  assert.equal(calls, 2);
});

type FakeChild = CredentialSweepChild & {
  stdin: PassThrough;
  stdout: PassThrough;
  killed: NodeJS.Signals[];
  alive: boolean;
};

function fakeChild(
  pid: number,
  serve: (request: { id: number; root: string }, stdout: PassThrough) => void,
  options: { ignoreSigterm?: boolean } = {},
): FakeChild {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const killed: NodeJS.Signals[] = [];
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) serve(JSON.parse(line) as { id: number; root: string }, stdout);
  });
  const child: FakeChild = {
    pid,
    stdin,
    stdout,
    killed,
    alive: true,
    kill: (signal?: NodeJS.Signals) => {
      const delivered = signal ?? "SIGTERM";
      killed.push(delivered);
      if (delivered === "SIGTERM" && options.ignoreSigterm) return;
      child.alive = false;
      setImmediate(() => emitter.emit("exit"));
    },
    on: (event, listener) => emitter.on(event, listener),
  };
  return child;
}

function fakeWorkerFingerprint(pid: number): ProcessBirthFingerprint {
  return { pgid: pid, startedAt: `Mon Aug  7 10:00:${String(pid % 60).padStart(2, "0")} 2026` };
}

function fakeWorkerIdentityReader(children: Map<number, FakeChild>): ProcessIdentityReader {
  return async (pid) => children.get(pid)?.alive ? fakeWorkerFingerprint(pid) : null;
}

test("isolated credential sweep kills a never-settling sync, releases its account lock, and the next run recovers", async () => {
  await withTempStore(async (root) => {
    const workerPid = 424_242;
    const lockPath = accountLockPath("codex-stuck");
    await mkdir(join(root, "locks", "accounts"), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: workerPid, createdAt: new Date().toISOString(), token: "worker-token" }));
    const plan = telemetry();
    const wedged = fakeChild(workerPid, (request, stdout) => {
      stdout.write(`${JSON.stringify({ id: request.id, kind: "progress", progress: { type: "plan", telemetry: plan } })}\n`);
      stdout.write(`${JSON.stringify({ id: request.id, kind: "progress", progress: { type: "work-start", workId: 1, pairIds: [7] } })}\n`);
      // Never sends a result.
    }, { ignoreSigterm: true });
    const recoveredTelemetry = telemetry({ completedAccounts: 1, completedPairs: 2, durationMs: 4 });
    const healthy = fakeChild(workerPid + 1, (request, stdout) => {
      stdout.write(`${JSON.stringify({ id: request.id, kind: "result", ok: true, telemetry: recoveredTelemetry })}\n`);
    });
    let spawns = 0;
    const children = new Map<number, FakeChild>([[wedged.pid!, wedged], [healthy.pid!, healthy]]);
    const sweep = createIsolatedCredentialSweeper({
      timeoutMs: 30,
      killGraceMs: 100,
      root: () => root,
      spawnChild: () => (++spawns === 1 ? wedged : healthy),
      signalProcessGroup: (pgid, signal) => children.get(pgid)?.kill(signal),
      isProcessGroupAlive: (pgid) => children.get(pgid)?.alive ?? false,
      readProcessIdentity: fakeWorkerIdentityReader(children),
    });

    await assert.rejects(
      () => sweep(),
      (error: unknown) => {
        assert.ok(error instanceof CredentialSweepTimeoutError);
        assert.equal(error.telemetry.attemptedPairs, 3_000);
        assert.equal(error.telemetry.uniquePairs, 19);
        assert.equal(error.telemetry.skippedPairs, 2_998);
        assert.equal(error.telemetry.timedOutPairs, 1);
        assert.equal(error.terminationConfirmed, true);
        return true;
      },
    );
    assert.deepEqual(wedged.killed, ["SIGTERM", "SIGKILL"]);
    await assert.rejects(() => readFile(lockPath, "utf8"), { code: "ENOENT" });

    // Recovery is immediate rather than waiting for the ordinary 60s stale
    // lock horizon, and regular account work can acquire the same lock now.
    let acquired = false;
    await withAccountLock("codex-stuck", async () => {
      acquired = true;
    }, { timeoutMs: 100 });
    assert.equal(acquired, true);
    assert.deepEqual(await sweep(), recoveredTelemetry);
    assert.equal(spawns, 2);
    await sweep.close();
  });
});

test("credential lock reaper leaves a newly reacquired live generation in place", async () => {
  await withTempStore(async (root) => {
    const deadPid = 515_151;
    const accountId = "codex-reacquired";
    const lockPath = accountLockPath(accountId);
    await mkdir(join(root, "locks", "accounts"), { recursive: true });
    await writeFile(lockPath, JSON.stringify({
      pid: deadPid,
      createdAt: "2026-08-07T00:00:00.000Z",
      token: "dead-generation",
    }));

    let observed!: () => void;
    const staleOwnerObserved = new Promise<void>((resolve) => { observed = resolve; });
    let resumeReaper!: () => void;
    const reaperMayResume = new Promise<void>((resolve) => { resumeReaper = resolve; });
    const reaping = reapCredentialWorkerLocks(root, deadPid, {
      beforeRevalidate: async () => {
        observed();
        await reaperMayResume;
      },
    });
    await staleOwnerObserved;

    // Model another cleanup/acquisition winning after the reaper's first read.
    // The new holder is real withFileLock work, so it participates in the same
    // mutation gate as guarded revalidation.
    await rm(lockPath, { force: true });
    let liveEntered!: () => void;
    const liveWasEntered = new Promise<void>((resolve) => { liveEntered = resolve; });
    let releaseLive!: () => void;
    const liveMayRelease = new Promise<void>((resolve) => { releaseLive = resolve; });
    const liveHolder = withAccountLock(accountId, async () => {
      liveEntered();
      await liveMayRelease;
    });
    await liveWasEntered;

    resumeReaper();
    assert.equal(await reaping, 0, "exact owner revalidation rejected the replacement generation");
    const liveRaw = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown; token?: unknown };
    assert.equal(liveRaw.pid, process.pid);
    assert.notEqual(liveRaw.token, "dead-generation");

    let waiterEntered = false;
    const waiter = withAccountLock(accountId, async () => { waiterEntered = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(waiterEntered, false, "reaper did not create a parallel-acquisition window");
    releaseLive();
    await Promise.all([liveHolder, waiter]);
    assert.equal(waiterEntered, true);
  });
});

test("credential lock reaper recovers a worker killed while holding its generation guard", async () => {
  await withTempStore(async (root) => {
    const deadPid = 616_161;
    const accountId = "codex-guard-killed";
    const lockPath = accountLockPath(accountId);
    await mkdir(join(root, "locks", "accounts"), { recursive: true });
    await writeFile(lockPath, JSON.stringify({
      pid: deadPid,
      createdAt: "2026-08-07T00:00:00.000Z",
      token: "dead-lock-generation",
    }));
    const identity = await readFileLockIdentity(lockPath);
    assert.ok(identity);
    const guardPath = fileLockMutationGuardPath(lockPath, identity!);
    await writeFile(guardPath, JSON.stringify({
      pid: deadPid,
      hostname: hostname(),
      createdAt: "2026-08-07T00:00:01.000Z",
      token: "dead-guard-generation",
      lockFingerprint: identity!.fingerprint,
    }));

    assert.equal(await reapCredentialWorkerLocks(root, deadPid), 1);
    await assert.rejects(() => readFile(lockPath, "utf8"), { code: "ENOENT" });
    await assert.rejects(() => readFile(guardPath, "utf8"), { code: "ENOENT" });

    let acquired = false;
    await withAccountLock(accountId, async () => { acquired = true; }, { timeoutMs: 200 });
    assert.equal(acquired, true, "the dead generation guard cannot strand future activations");
  });
});

test("late partial stdout from a timed-out worker cannot corrupt its replacement's response", async () => {
  await withTempStore(async (root) => {
    const stale = fakeChild(425_000, () => undefined, { ignoreSigterm: true });
    const expected = telemetry({ completedAccounts: 1, completedPairs: 1, durationMs: 3 });
    let healthyReply: (() => void) | undefined;
    const healthy = fakeChild(425_001, (request, stdout) => {
      healthyReply = () => {
        stdout.write(`${JSON.stringify({ id: request.id, kind: "result", ok: true, telemetry: expected })}\n`);
      };
    });
    const children = new Map<number, FakeChild>([[stale.pid!, stale], [healthy.pid!, healthy]]);
    let spawns = 0;
    const sweep = createIsolatedCredentialSweeper({
      timeoutMs: 30,
      killGraceMs: 20,
      root: () => root,
      spawnChild: () => (++spawns === 1 ? stale : healthy),
      signalProcessGroup: (pgid, signal) => children.get(pgid)?.kill(signal),
      isProcessGroupAlive: (pgid) => children.get(pgid)?.alive ?? false,
      readProcessIdentity: fakeWorkerIdentityReader(children),
    });

    try {
      await assert.rejects(() => sweep(), CredentialSweepTimeoutError);
      const recovered = sweep();
      await new Promise((resolveReady) => setImmediate(resolveReady));
      assert.ok(healthyReply, "replacement received its request");

      // The stale generation publishes an unterminated JSON prefix after it
      // was detached and after the new generation exists. A shared decoder or
      // buffer would prepend this to the healthy response and lose it.
      stale.stdout.write('{"id":');
      healthyReply();
      assert.deepEqual(await recovered, expected);
      assert.equal(spawns, 2);
    } finally {
      await sweep.close().catch(() => undefined);
    }
  });
});

test("credential sweep timeout never signals or reaps after worker PID reuse before TERM", async () => {
  await withTempStore(async (root) => {
    const pid = 425_100;
    const worker = fakeChild(pid, () => undefined, { ignoreSigterm: true });
    const recorded = fakeWorkerFingerprint(pid);
    const replacement = { ...recorded, startedAt: "Mon Aug  7 10:05:00 2026" };
    const signals: Array<[number, NodeJS.Signals]> = [];
    let identityReads = 0;
    let lockReaps = 0;
    const sweep = createIsolatedCredentialSweeper({
      timeoutMs: 20,
      killGraceMs: 5,
      root: () => root,
      spawnChild: () => worker,
      readProcessIdentity: async () => (++identityReads === 1 ? recorded : replacement),
      signalProcessGroup: (pgid, signal) => signals.push([pgid, signal]),
      isProcessGroupAlive: () => true,
      cleanupLocks: async () => {
        lockReaps += 1;
        return 1;
      },
    });

    try {
      await assert.rejects(
        () => sweep(),
        (error: unknown) => {
          assert.ok(error instanceof CredentialSweepTimeoutError);
          assert.equal(error.terminationConfirmed, false);
          return true;
        },
      );
      assert.deepEqual(signals, [], "the replacement incarnation is not sent TERM or KILL");
      assert.equal(lockReaps, 0, "a recycled worker pid never authorizes lock cleanup");
      await assert.rejects(() => sweep(), /has not been confirmed stopped/);
      assert.equal(lockReaps, 0, "later reconciliation cannot reap by the compromised numeric pid");
    } finally {
      await sweep.close().catch(() => undefined);
    }
  });
});

test("credential sweep timeout fails closed when worker birth identity is unverifiable", async () => {
  await withTempStore(async (root) => {
    const pid = 425_150;
    const worker = fakeChild(pid, () => undefined, { ignoreSigterm: true });
    const signals: Array<[number, NodeJS.Signals]> = [];
    let lockReaps = 0;
    const sweep = createIsolatedCredentialSweeper({
      timeoutMs: 20,
      killGraceMs: 5,
      root: () => root,
      spawnChild: () => worker,
      readProcessIdentity: async () => null,
      signalProcessGroup: (pgid, signal) => signals.push([pgid, signal]),
      isProcessGroupAlive: () => true,
      cleanupLocks: async () => {
        lockReaps += 1;
        return 1;
      },
    });

    try {
      await assert.rejects(
        () => sweep(),
        (error: unknown) => {
          assert.ok(error instanceof CredentialSweepTimeoutError);
          assert.equal(error.terminationConfirmed, false);
          return true;
        },
      );
      assert.deepEqual(signals, []);
      assert.equal(lockReaps, 0);
      await assert.rejects(() => sweep(), /has not been confirmed stopped/);
      assert.equal(lockReaps, 0);
    } finally {
      await sweep.close().catch(() => undefined);
    }
  });
});

test("credential sweep timeout never SIGKILLs or reaps a replacement born during TERM grace", async () => {
  await withTempStore(async (root) => {
    const pid = 425_200;
    const worker = fakeChild(pid, () => undefined, { ignoreSigterm: true });
    const recorded = fakeWorkerFingerprint(pid);
    const replacement = { ...recorded, startedAt: "Mon Aug  7 10:06:00 2026" };
    const signals: Array<[number, NodeJS.Signals]> = [];
    let identityReads = 0;
    let lockReaps = 0;
    const sweep = createIsolatedCredentialSweeper({
      timeoutMs: 20,
      killGraceMs: 5,
      root: () => root,
      spawnChild: () => worker,
      // capture, pre-TERM revalidation, then the replacement before KILL
      readProcessIdentity: async () => (++identityReads <= 2 ? recorded : replacement),
      signalProcessGroup: (pgid, signal) => signals.push([pgid, signal]),
      isProcessGroupAlive: () => true,
      cleanupLocks: async () => {
        lockReaps += 1;
        return 1;
      },
    });

    try {
      await assert.rejects(
        () => sweep(),
        (error: unknown) => {
          assert.ok(error instanceof CredentialSweepTimeoutError);
          assert.equal(error.terminationConfirmed, false);
          return true;
        },
      );
      assert.deepEqual(signals, [[pid, "SIGTERM"]], "the replacement is never escalated to SIGKILL");
      assert.equal(lockReaps, 0, "replacement detection keeps worker-owned locks fenced");
      await assert.rejects(() => sweep(), /has not been confirmed stopped/);
      assert.equal(lockReaps, 0, "a replacement observed during grace permanently fences numeric lock reaping");
    } finally {
      await sweep.close().catch(() => undefined);
    }
  });
});

test("credential sweep timeout kills a SIGTERM-resistant helper grandchild before reaping the worker lock", { timeout: 10_000 }, async () => {
  await withTempStore(async (root) => {
    const marker = join(root, "helper-mutations.log");
    const lockPath = join(root, "locks", "accounts", "helper.lock");
    let worker: ChildProcess | undefined;
    const helperSource = String.raw`
      const fs = require("node:fs");
      const marker = process.argv[1];
      process.on("SIGTERM", () => {});
      fs.appendFileSync(marker, "started\n");
      setInterval(() => fs.appendFileSync(marker, "tick\n"), 10);
    `;
    const workerSource = String.raw`
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const path = require("node:path");
      process.on("SIGTERM", () => {});
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        const lockDir = path.join(request.root, "locks", "accounts");
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(path.join(lockDir, "helper.lock"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        const helper = ${JSON.stringify(helperSource)};
        spawn(process.execPath, ["--input-type=commonjs", "-e", helper, ${JSON.stringify(marker)}], { stdio: "ignore" });
        process.stdout.write(JSON.stringify({ id: request.id, kind: "progress", progress: { type: "plan", telemetry: ${JSON.stringify(telemetry())} } }) + "\n");
        process.stdout.write(JSON.stringify({ id: request.id, kind: "progress", progress: { type: "work-start", workId: 1, pairIds: [0] } }) + "\n");
      });
      process.stdout.write("ready\n");
      setInterval(() => {}, 1000);
    `;

    worker = spawn(process.execPath, ["--input-type=commonjs", "-e", workerSource], {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    await new Promise<void>((resolveReady, rejectReady) => {
      worker!.once("error", rejectReady);
      worker!.stdout!.once("data", (chunk) => {
        assert.match(chunk.toString("utf8"), /ready/);
        resolveReady();
      });
    });

    const sweep = createIsolatedCredentialSweeper({
      timeoutMs: 2_000,
      killGraceMs: 150,
      root: () => root,
      spawnChild: () => worker as unknown as CredentialSweepChild,
    });

    try {
      await assert.rejects(
        () => sweep(),
        (error: unknown) => {
          assert.ok(error instanceof CredentialSweepTimeoutError);
          assert.equal(error.terminationConfirmed, true, error.message);
          assert.equal(error.telemetry.timedOutPairs, 1);
          return true;
        },
      );
      await assert.rejects(() => readFile(lockPath, "utf8"), { code: "ENOENT" });
      const before = await readFile(marker, "utf8");
      assert.match(before, /started/, "the helper actually ran and mutated before timeout");
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      assert.equal(await readFile(marker, "utf8"), before, "no descendant mutates after group confirmation + lock reap");
    } finally {
      await sweep.close().catch(() => undefined);
      if (worker?.pid) {
        try {
          process.kill(-worker.pid, "SIGKILL");
        } catch {
          // Expected once the sweep has confirmed the group dead.
        }
      }
    }
  });
});
