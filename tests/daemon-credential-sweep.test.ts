import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { AccountRecord } from "../src/accounts.js";
import { accountLockPath, withAccountLock } from "../src/accounts.js";
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
import type { SessionRecord } from "../src/store.js";

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

test("credential sweep plan collapses 3k records to 19 canonical pairs and current/newest evidence wins", () => {
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

  const plan = planCredentialSweep(records, accounts);
  assert.equal(plan.attemptedPairs, 3_001);
  assert.equal(plan.uniquePairs, 19);
  assert.equal(plan.duplicatePairs, 2_982);
  assert.equal(plan.extraPairs.length, 19);
  assert.equal(plan.skippedPairs, 2_982);
  assert.equal(plan.pairs.find((pair) => pair.account.id === "codex-0")?.evidence.name, "CO.current");
  assert.equal(plan.pairs.find((pair) => pair.account.id === "codex-0")?.homePath, resolve("/tmp/sweep-home-0"));
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
        return { auth: null, vaultUpdated: false };
      },
      now: (() => {
        let value = 100;
        return () => value++;
      })(),
      concurrency: 1,
    });

    assert.deepEqual(calls, [
      {},
      { home: historicalHome, trusted: true },
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
  killed: NodeJS.Signals[];
};

function fakeChild(
  pid: number,
  serve: (request: { id: number; root: string }, stdout: PassThrough) => void,
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
  return {
    pid,
    stdin,
    stdout,
    killed,
    kill: (signal?: NodeJS.Signals) => {
      killed.push(signal ?? "SIGTERM");
      setImmediate(() => emitter.emit("exit"));
    },
    on: (event, listener) => emitter.on(event, listener),
  };
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
    });
    const recoveredTelemetry = telemetry({ completedAccounts: 1, completedPairs: 2, durationMs: 4 });
    const healthy = fakeChild(workerPid + 1, (request, stdout) => {
      stdout.write(`${JSON.stringify({ id: request.id, kind: "result", ok: true, telemetry: recoveredTelemetry })}\n`);
    });
    let spawns = 0;
    const sweep = createIsolatedCredentialSweeper({
      timeoutMs: 30,
      killGraceMs: 100,
      root: () => root,
      spawnChild: () => (++spawns === 1 ? wedged : healthy),
    });

    await assert.rejects(
      () => sweep(),
      (error: unknown) => {
        assert.ok(error instanceof CredentialSweepTimeoutError);
        assert.equal(error.telemetry.attemptedPairs, 3_000);
        assert.equal(error.telemetry.uniquePairs, 19);
        assert.equal(error.telemetry.skippedPairs, 2_998);
        assert.equal(error.telemetry.timedOutPairs, 1);
        return true;
      },
    );
    assert.deepEqual(wedged.killed, ["SIGKILL"]);
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
