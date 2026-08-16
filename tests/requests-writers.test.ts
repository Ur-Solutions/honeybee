import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { cmdAnswer } from "../src/commands/messaging.js";
import { createRequestReconciler } from "../src/daemon/requestSweep.js";
import { resolveAuthRequestsAfterResume } from "../src/commands/migrate.js";
import { runHsrHost, type HsrHostHandle } from "../src/hsr/host.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { hsrObservations, pendingNeedsInput } from "../src/hsr/observe.js";
import { hsrEventsPath, hsrRunDir } from "../src/hsr/runDir.js";
import { readHsrEventIntegrityReceipt } from "../src/hsr/eventIntegrity.js";
import { transactionalKill, transactionalRetire } from "../src/kill.js";
import type { Parsed } from "../src/parse.js";
import { authRequestId, needsInputRequestId, stopFailedRequestId } from "../src/requests/keys.js";
import { listBeesWithRequests, openRequest, readBeeRequests, type OpenRequestInput } from "../src/requests/store.js";
import { saveSession, type SessionRecord } from "../src/store.js";
import { setTmuxSocket, tmux } from "../src/substrates/local-tmux.js";
import type { KillResult, Substrate } from "../src/substrates/types.js";
import type { RunnerOpts } from "../src/hsr/types.js";

const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-requests-writers-"));
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

function record(name: string, over: Partial<SessionRecord> = {}): SessionRecord {
  const iso = new Date().toISOString();
  return {
    name,
    agent: "stub",
    cwd: process.cwd(),
    command: "stub",
    tmuxTarget: name,
    createdAt: iso,
    updatedAt: iso,
    status: "running",
    ...over,
  };
}

function openInput(over: Partial<OpenRequestInput> = {}): OpenRequestInput {
  return {
    id: "req_x",
    kind: "permission",
    scope: "turn",
    generation: 0,
    question: "Run it?",
    evidence: { grade: "structured", source: "hsr-events", detail: "needs_input" },
    ...over,
  };
}

function parsed(args: string[]): Parsed {
  return { command: args[0]!, args: args.slice(1), flags: new Map(), rest: [] };
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

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// ---------------------------------------------------------------------------
// hive answer, daemon down: the RPC lands AND a resolved record appears under
// the exact id the live view derivation would emit.
// ---------------------------------------------------------------------------

test("cmdAnswer (no daemon) backfills a resolved record under the view-derived id", async () => {
  await withTempStore(async () => {
    const previousHiveBee = process.env.HIVE_BEE;
    delete process.env.HIVE_BEE;
    let handle: HsrHostHandle | undefined;
    try {
      const bee = "answer-bee";
      const opts: RunnerOpts = { bee, cwd: process.cwd(), env: process.env as Record<string, string>, runDir: hsrRunDir(bee) };
      handle = await runHsrHost({ bee, adapter: stubAdapter, opts });
      const { connectRpcClient } = await import("../src/hsr/rpc.js");
      const client = await connectRpcClient(handle.controlSocket);
      try {
        await client.call("send", { text: "ask me" });
      } finally {
        client.close();
      }
      await waitFor(async () => (await pendingNeedsInput(bee)) !== null, "pending needs-input");
      await waitFor(async () => (await hsrObservations()).get(bee)?.state === "blocked", "observed blocked");

      const pendingBefore = await pendingNeedsInput(bee);
      assert.ok(pendingBefore);
      const expectedId = needsInputRequestId(bee, pendingBefore!);
      await saveSession(record(bee, { substrate: "hsr", runtimeGeneration: 2 }));

      // NO daemon is running anywhere in this test — the CLI verb alone must
      // land the durable resolution.
      await cmdAnswer(parsed(["answer", bee, "approve", "it"]));

      const requests = await readBeeRequests(bee);
      assert.equal(requests.length, 1);
      const stored = requests[0]!;
      assert.equal(stored.id, expectedId, "store id is byte-identical to the view-derived id");
      assert.equal(stored.status, "resolved");
      assert.equal(stored.resolvedBy, "hive-answer");
      assert.equal(stored.resolution, "approve it");
      assert.equal(stored.generation, 2);
      assert.equal(stored.kind, pendingBefore!.kind);
      assert.equal(stored.question, pendingBefore!.question);
      assert.ok(stored.openedAt, "openedAt always present");

      // The answer really landed on the runner too.
      await waitFor(async () => (await pendingNeedsInput(bee)) === null, "needs-input cleared after answer");
    } finally {
      if (previousHiveBee !== undefined) process.env.HIVE_BEE = previousHiveBee;
      await handle?.stop().catch(() => undefined);
    }
  });
});

test("cmdAnswer attributes the resolution to the calling bee via HIVE_BEE", async () => {
  await withTempStore(async () => {
    const previousHiveBee = process.env.HIVE_BEE;
    process.env.HIVE_BEE = "parent-orchestrator";
    let handle: HsrHostHandle | undefined;
    try {
      const bee = "attributed-bee";
      const opts: RunnerOpts = { bee, cwd: process.cwd(), env: process.env as Record<string, string>, runDir: hsrRunDir(bee) };
      handle = await runHsrHost({ bee, adapter: stubAdapter, opts });
      const { connectRpcClient } = await import("../src/hsr/rpc.js");
      const client = await connectRpcClient(handle.controlSocket);
      try {
        await client.call("send", { text: "ask me" });
      } finally {
        client.close();
      }
      await waitFor(async () => (await pendingNeedsInput(bee)) !== null, "pending needs-input");
      await saveSession(record(bee, { substrate: "hsr" }));

      await cmdAnswer(parsed(["answer", bee, "yes"]));

      const stored = (await readBeeRequests(bee))[0]!;
      assert.equal(stored.resolvedBy, "hive-answer:parent-orchestrator");
    } finally {
      if (previousHiveBee === undefined) delete process.env.HIVE_BEE;
      else process.env.HIVE_BEE = previousHiveBee;
      await handle?.stop().catch(() => undefined);
    }
  });
});

test("cmdAnswer detects a holed local source log before offering or sending a provider answer", async () => {
  await withTempStore(async () => {
    const bee = "answer-source-history-hole";
    const opts: RunnerOpts = {
      bee,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      runDir: hsrRunDir(bee),
    };
    const handle = await runHsrHost({ bee, adapter: stubAdapter, opts });
    const { connectRpcClient } = await import("../src/hsr/rpc.js");
    const client = await connectRpcClient(handle.controlSocket);
    let answered = 0;
    client.on("event", (value) => {
      const event = value as { type?: unknown; text?: unknown };
      if (event.type === "text" && typeof event.text === "string" && event.text.startsWith("answered:")) answered += 1;
    });
    try {
      await client.call("send", { text: "ask me" });
      await waitFor(async () => (await pendingNeedsInput(bee)) !== null, "pending answer before corruption");
      await saveSession(record(bee, { substrate: "hsr", runtimeGeneration: 1 }));
      const lines = (await readFile(hsrEventsPath(bee), "utf8")).split("\n").filter(Boolean);
      const events = lines.map((line) => JSON.parse(line) as { seq?: number; type?: string });
      const internal = events.find((event, index) => index > 0 && index < events.length - 1 && event.seq !== undefined);
      assert.ok(internal?.seq);
      await writeFile(
        hsrEventsPath(bee),
        `${lines.filter((line) => (JSON.parse(line) as { seq?: number }).seq !== internal!.seq).join("\n")}\n`,
        { mode: 0o600 },
      );

      await assert.rejects(cmdAnswer(parsed(["answer", bee, "yes"])), /unresolved HSR event history/);
      assert.equal(answered, 0, "strict source admission rejects before provider answer I/O");
      assert.equal((await readHsrEventIntegrityReceipt(bee))?.phase, "unresolved");
      await handle.done;
    } finally {
      client.close();
      await handle.stop().catch(() => undefined);
    }
  });
});

test("host refresh reuses r1 without reopening or resolving the predecessor request", async () => {
  await withTempStore(async () => {
    const previousHiveBee = process.env.HIVE_BEE;
    delete process.env.HIVE_BEE;
    const bee = "answer-host-refresh";
    const current = record(bee, { substrate: "hsr", runtimeGeneration: 4 });
    await saveSession(current);
    const opts: RunnerOpts = {
      bee,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      runDir: hsrRunDir(bee),
    };
    const reconcile = createRequestReconciler();
    let handle: HsrHostHandle | undefined;
    const openFromCurrentObservation = async () => reconcile({
      records: [current],
      currentStates: new Map(),
      hsrObservations: await hsrObservations({ bees: [bee], includeEvents: true }),
      hsrUnavailable: new Set(),
    });
    try {
      handle = await runHsrHost({ bee, adapter: stubAdapter, opts });
      let client = await (await import("../src/hsr/rpc.js")).connectRpcClient(handle.controlSocket);
      try {
        await client.call("send", { text: "ask first" });
      } finally {
        client.close();
      }
      await waitFor(async () => (await pendingNeedsInput(bee))?.question === "proceed?", "first host pending r1");
      const firstPending = (await pendingNeedsInput(bee))!;
      const firstId = needsInputRequestId(bee, firstPending);
      assert.deepEqual((await openFromCurrentObservation()).map((row) => row.action), ["open"]);
      await cmdAnswer(parsed(["answer", bee, "yes"]));
      assert.equal((await readBeeRequests(bee)).find((row) => row.id === firstId)?.status, "resolved");

      await handle.stop();
      handle = await runHsrHost({ bee, adapter: stubAdapter, opts });
      assert.equal(await pendingNeedsInput(bee), null, "old r1 is absent before the refreshed host asks");
      client = await (await import("../src/hsr/rpc.js")).connectRpcClient(handle.controlSocket);
      try {
        await client.call("send", { text: "ask different" });
      } finally {
        client.close();
      }
      await waitFor(async () => (await pendingNeedsInput(bee))?.question === "different prompt?", "refreshed host pending r1");
      const secondPending = (await pendingNeedsInput(bee))!;
      assert.equal(secondPending.requestId, "r1");
      const secondId = needsInputRequestId(bee, secondPending);
      assert.notEqual(secondId, firstId, "request identity includes the exact host epoch");
      assert.deepEqual((await openFromCurrentObservation()).map((row) => row.action), ["open"]);
      let stored = await readBeeRequests(bee);
      assert.equal(stored.find((row) => row.id === firstId)?.status, "resolved", "closed A stays closed");
      assert.equal(stored.find((row) => row.id === secondId)?.status, "open", "B opens independently");
      assert.equal(stored.find((row) => row.id === secondId)?.question, "different prompt?");

      await cmdAnswer(parsed(["answer", bee, "yes"]));
      stored = await readBeeRequests(bee);
      assert.equal(stored.find((row) => row.id === firstId)?.status, "resolved");
      assert.equal(stored.find((row) => row.id === secondId)?.status, "resolved", "answer closes only B's exact request");
    } finally {
      if (previousHiveBee !== undefined) process.env.HIVE_BEE = previousHiveBee;
      await handle?.stop().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// auth-resume: open auth requests resolve by "auth-resume" (daemon down).
// ---------------------------------------------------------------------------

test("resolveAuthRequestsAfterResume resolves open auth requests only, by auth-resume", async () => {
  await withTempStore(async () => {
    const bee = "auth-bee";
    await openRequest(bee, openInput({ id: authRequestId(bee, 111), kind: "auth", scope: "runtime-generation" }));
    await openRequest(bee, openInput({ id: authRequestId(bee, 222), kind: "auth", scope: "runtime-generation" }));
    await openRequest(bee, openInput({ id: "question-still-open", kind: "question" }));

    await resolveAuthRequestsAfterResume(bee);

    const byId = new Map((await readBeeRequests(bee)).map((r) => [r.id, r]));
    assert.equal(byId.get(authRequestId(bee, 111))!.status, "resolved");
    assert.equal(byId.get(authRequestId(bee, 111))!.resolvedBy, "auth-resume");
    assert.equal(byId.get(authRequestId(bee, 222))!.status, "resolved");
    assert.equal(byId.get("question-still-open")!.status, "open", "non-auth requests untouched");
  });
});

// ---------------------------------------------------------------------------
// kill/retire (daemon down, fake substrate).
// ---------------------------------------------------------------------------

test("a failed kill opens the durable stop-failed request for the current generation", async () => {
  await withTempStore(async () => {
    const rec = record("stubborn", { runtimeGeneration: 3 });
    await saveSession(rec);
    const outcome = await transactionalKill(rec, {
      substrate: fakeSubstrate({ hasSession: async () => true }),
      pollAttempts: 2,
      pollIntervalMs: 0,
    });
    assert.equal(outcome.ok, false);

    const requests = await readBeeRequests("stubborn");
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.equal(request.id, stopFailedRequestId("stubborn", 3));
    assert.equal(request.kind, "manual-action");
    assert.equal(request.scope, "runtime-generation");
    assert.equal(request.status, "open");
    assert.equal(request.grade, "structured");
    assert.equal(request.generation, 3);
  });
});

test("a failed retire also opens stop-failed; the later successful retire resolves it by stop-succeeded and cancels other opens as retired", async () => {
  await withTempStore(async () => {
    const rec = record("eventually-retired");
    await saveSession(rec);

    // First attempt fails → stop-failed opens.
    const failed = await transactionalRetire(rec, {
      substrate: fakeSubstrate({ hasSession: async () => true }),
      pollAttempts: 2,
      pollIntervalMs: 0,
    });
    assert.equal(failed.ok, false);
    assert.equal((await readBeeRequests("eventually-retired"))[0]!.status, "open");

    // An unrelated open request rides along to be scope-closed by the retire.
    await openRequest("eventually-retired", openInput({ id: "pending-question", kind: "question" }));

    // Second attempt succeeds → stop-failed RESOLVES (stop-succeeded), the
    // rest cancels scope-closed "retired", and the file survives (revivable
    // history — retire keeps it).
    const ok = await transactionalRetire({ ...rec, status: "kill_failed" }, {
      substrate: fakeSubstrate({ hasSession: async () => false }),
      pollIntervalMs: 0,
    });
    assert.equal(ok.ok, true);

    const byId = new Map((await readBeeRequests("eventually-retired")).map((r) => [r.id, r]));
    const stopFailed = byId.get(stopFailedRequestId("eventually-retired", 0))!;
    assert.equal(stopFailed.status, "resolved");
    assert.equal(stopFailed.resolvedBy, "stop-succeeded");
    const question = byId.get("pending-question")!;
    assert.equal(question.status, "cancelled");
    assert.equal(question.cancelReason, "scope-closed");
    assert.equal(question.cancelDetail, "retired");
  });
});

test("a successful kill deletes the bee's request file outright (kill is PURGE)", async () => {
  await withTempStore(async () => {
    const rec = record("purged");
    await saveSession(rec);
    await openRequest("purged", openInput({ id: "will-vanish" }));
    assert.equal((await listBeesWithRequests()).length, 1);

    const outcome = await transactionalKill(rec, { substrate: fakeSubstrate({}), pollIntervalMs: 0 });
    assert.equal(outcome.ok, true);
    assert.deepEqual(await readBeeRequests("purged"), []);
    assert.deepEqual(await listBeesWithRequests(), []);
  });
});

// ---------------------------------------------------------------------------
// revive: a new incarnation cancels earlier-generation requests as superseded.
// Full CLI + real tmux (the cli-revive.test.ts rig), daemon down throughout.
// ---------------------------------------------------------------------------

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("hive revive cancels open requests from the previous generation as superseded", { skip: !tmuxAvailable() }, async () => {
  const socketDir = await mkdtemp(join(tmpdir(), "hive-requests-revive-tmux-"));
  const socket = join(socketDir, "sock");
  const store = await mkdtemp(join(tmpdir(), "hive-requests-revive-store-"));
  setTmuxSocket(socket);
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = store;
  try {
    const bee = "CO.superseded";
    const now = "2026-07-28T00:00:00.000Z";
    await mkdir(join(store, "sessions"), { recursive: true });
    await writeFile(
      join(store, "sessions", `${bee}.json`),
      `${JSON.stringify({
        name: bee,
        agent: "codex",
        requestedAgent: "codex",
        cwd: store,
        launchArgv: ["sh", "-c", "sleep 120"],
        command: "sh -c 'sleep 120'",
        tmuxTarget: "CO-superseded",
        id: bee,
        createdAt: now,
        updatedAt: now,
        status: "dead",
        runtimeGeneration: 1,
      }, null, 2)}\n`,
    );
    await openRequest(bee, openInput({ id: "stale-question", kind: "question", generation: 1 }));

    await execFileAsync(process.execPath, ["tests/cli-entry.mjs", "revive", bee, "--fresh", "--no-wait"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HIVE_STORE_ROOT: store,
        HIVE_TMUX_SOCKET: socket,
        HIVE_CODEX_CMD: "sh -c 'sleep 120' --",
        HIVE_NO_KEYCHAIN: "1",
        NO_COLOR: "1",
        TERM: "dumb",
      },
    });

    const stored = (await readBeeRequests(bee)).find((r) => r.id === "stale-question")!;
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.cancelReason, "superseded");
    assert.equal(stored.cancelDetail, "superseded by generation 2");
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await tmux(["kill-server"], { reject: false }).catch(() => undefined);
    setTmuxSocket(undefined);
    await rm(socketDir, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
});
