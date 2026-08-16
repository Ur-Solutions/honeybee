import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileLock } from "../src/lock.js";
import { connectRpcClient } from "../src/hsr/rpc.js";
import { runHsrHost } from "../src/hsr/host.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { startStreamRunner, type StreamRunnerConfig } from "../src/hsr/streamRunner.js";
import { createHsrAnswerOperation, markHsrAnswerOperationSending, offerHsrAnswerOperation } from "../src/answerReceipt.js";
import { hsrAnswerHostFromMeta } from "../src/hsr/answer.js";
import { readHsrEventIntegrityReceipt } from "../src/hsr/eventIntegrity.js";
import {
  enqueuePendingHsrTurn,
  readPendingHsrTurn,
} from "../src/hsr/pendingTurns.js";
import { hsrLiveness, hsrObservations, reapDeadHosts } from "../src/hsr/observe.js";
import {
  appendHsrEvent,
  ackHsrEvents,
  ensureHsrRunDir,
  hsrControlSocketPath,
  hsrEventsPath,
  hsrEventAuthorityLockPath,
  hsrRingPath,
  hsrRunDir,
  readHsrMeta,
  readHsrEventsAfterSeqStrict,
  readHsrSeqState,
  removeConfirmedStoppedHsrRunDir,
  markHsrConsumerSubscribedStrict,
  verifyHsrEventStreamClosure,
  writeHsrMeta,
} from "../src/hsr/runDir.js";
import type { RunnerAdapter, RunnerEvent, RunnerOpts } from "../src/hsr/types.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Set HIVE_STORE_ROOT to a fresh mkdtemp dir for the duration of `fn`. */
async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-host-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Poll `cond` on a short interval until true, or throw after `timeoutMs`. */
async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

async function readEventLog(bee: string): Promise<RunnerEvent[]> {
  let raw: string;
  try {
    raw = await readFile(hsrEventsPath(bee), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RunnerEvent);
}

function optsFor(bee: string): RunnerOpts {
  return {
    bee,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    runDir: hsrRunDir(bee),
  };
}

const EXIT_BEFORE_STDIO_CLOSE_SCRIPT = `
const { spawn } = require("node:child_process");
const frame = Buffer.from(JSON.stringify({ type: "late-result", text: "durable-tail-after-exit" })).toString("base64");
const tail = spawn(process.execPath, [
  "-e",
  "setTimeout(() => process.stdout.write(Buffer.from(process.argv[1], 'base64')), 200)",
  frame,
], { stdio: ["ignore", 1, "ignore"] });
tail.unref();
`;

const exitBeforeStdioCloseConfig: StreamRunnerConfig = {
  harness: "exit-before-stdio-close",
  tier: "stream",
  command: process.execPath,
  args: ["-e", EXIT_BEFORE_STDIO_CLOSE_SCRIPT],
  parseLine(line) {
    const parsed = JSON.parse(line) as { type?: string; text?: string };
    if (parsed.type !== "late-result") return [];
    return [
      { type: "text", ts: 0, text: parsed.text ?? "" },
      { type: "turn_end", ts: 0 },
    ];
  },
  encodeUserTurn(text) {
    return `${text}\n`;
  },
};

const exitBeforeStdioCloseAdapter: RunnerAdapter = {
  harness: "exit-before-stdio-close",
  tier: () => "stream",
  start: (opts) => startStreamRunner(exitBeforeStdioCloseConfig, opts),
};

test("host-epoch append failure publishes no-child exit before adapter start and permits exact retry", async () => {
  await withTempStore(async () => {
    const bee = "host-epoch-pre-adapter-failure";
    await ensureHsrRunDir(bee);
    await writeFile(hsrEventsPath(bee), "{malformed-pre-adapter\n", { mode: 0o600 });
    let adapterStarts = 0;
    const adapter = {
      ...stubAdapter,
      async start(opts: RunnerOpts) {
        adapterStarts += 1;
        return stubAdapter.start(opts);
      },
    };
    const capture = {
      timeoutMs: 0,
      capture: async (pid: number) => ({ pgid: pid, startedAt: `test-birth:${pid}` }),
    };
    await assert.rejects(
      runHsrHost({ bee, adapter, opts: optsFor(bee), processBirthCapture: capture }),
      /malformed record/,
    );
    assert.equal(adapterStarts, 0, "provider adapter is never entered before a durable host epoch");
    const failed = await readHsrMeta(bee);
    assert.equal(failed?.status, "exited");
    assert.equal(failed?.childAdmission, "none", "failed pre-adapter launch is durable no-child proof");
    assert.equal(failed?.startupFailure?.code, "HIVE_HSR_HOST_EPOCH_PERSISTENCE");
    assert.ok(failed?.hostFingerprint);

    await removeConfirmedStoppedHsrRunDir(bee, failed!.hostPid, failed!.hostFingerprint);
    const retry = await runHsrHost({ bee, adapter, opts: optsFor(bee), processBirthCapture: capture });
    assert.equal(adapterStarts, 1, "fresh exact retry starts once after confirmed cleanup");
    await retry.stop();
  });
});

test("runner-host: spawn+turn, sessionId, needs_input, snapshot, liveness, stop", async () => {
  await withTempStore(async () => {
    const bee = "betatest";
    const sessionRecord: SessionRecord = {
      name: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      createdAt: "2026-08-15T10:00:00.000Z",
      updatedAt: "2026-08-15T10:00:00.000Z",
      status: "running",
      substrate: "hsr",
      runtimeGeneration: 1,
      id: "betatest-id",
      uuid: "betatest-uuid",
    };
    await saveSession(sessionRecord);
    const handle = await runHsrHost({
      bee,
      adapter: stubAdapter,
      opts: optsFor(bee),
      processBirthCapture: {
        timeoutMs: 0,
        capture: async (pid) => ({ pgid: pid, startedAt: `test-birth:${pid}` }),
      },
    });
    const admittedMeta = await readHsrMeta(bee);
    assert.ok(admittedMeta?.hostFingerprint);
    await saveSession({
      ...sessionRecord,
      runnerPid: admittedMeta!.hostPid,
      runnerFingerprint: admittedMeta!.hostFingerprint,
    });
    const client = await connectRpcClient(handle.controlSocket);
    const events: RunnerEvent[] = [];
    client.on("event", (p) => events.push(p as RunnerEvent));

    try {
      // 1. spawn + turn: a text echo and a following turn_end, over the socket.
      await client.call("send", { text: "hello" });
      await waitFor(
        () => events.some((e) => e.type === "text" && e.text === "echo:hello"),
        "text echo:hello broadcast",
      );
      await waitFor(() => events.some((e) => e.type === "turn_end"), "turn_end broadcast");

      // events.jsonl contains them (runner is the sole writer).
      await waitFor(async () => {
        const log = await readEventLog(bee);
        return (
          log.some((e) => e.type === "text" && e.text === "echo:hello") &&
          log.some((e) => e.type === "turn_end")
        );
      }, "events.jsonl has echo:hello + turn_end");

      // ring.txt contains the echoed output (written after a short debounce).
      await waitFor(async () => {
        try {
          return (await readFile(hsrRingPath(bee), "utf8")).includes("echo:hello");
        } catch {
          return false;
        }
      }, "ring.txt has echo:hello");

      // 2. sessionId learned into meta.json (the stub's fixed id).
      await waitFor(async () => {
        const meta = await readHsrMeta(bee);
        return meta?.sessionId === "stub-session";
      }, "meta.sessionId learned");

      // 3. needs_input round-trip.
      const beforeAsk = events.length;
      await client.call("send", { text: "ask me" });
      await waitFor(
        () => events.slice(beforeAsk).some((e) => e.type === "needs_input" && e.requestId === "r1"),
        "needs_input r1",
      );
      const needs = events.slice().reverse().find((event) => event.type === "needs_input") as Extract<RunnerEvent, { type: "needs_input" }>;
      const pendingMeta = await readHsrMeta(bee);
      assert.ok(pendingMeta);
      assert.deepEqual(await client.call("pendingInput"), {
        requestId: "r1",
        ts: needs.ts,
        kind: "question",
        question: "proceed?",
        host: hsrAnswerHostFromMeta(pendingMeta!),
      });
      const beforeAnswer = events.length;
      const answerMeta = await readHsrMeta(bee);
      assert.ok(answerMeta);
      const firstOperation = createHsrAnswerOperation(sessionRecord, "r1", "yes", hsrAnswerHostFromMeta(answerMeta!));
      await offerHsrAnswerOperation(bee, firstOperation);
      await markHsrAnswerOperationSending(bee, firstOperation);
      await client.call("answer", { operation: firstOperation, answer: "yes" });
      await waitFor(
        () => events.slice(beforeAnswer).some((e) => e.type === "text" && e.text === "answered:yes"),
        "answered:yes text",
      );

      // The host preserves OpenCode's native multi-question matrix over RPC;
      // legacy string-only adapters receive its JSON compatibility form.
      const beforeStructuredAsk = events.length;
      await client.call("send", { text: "ask structured" });
      await waitFor(
        () => events.slice(beforeStructuredAsk).some((e) => e.type === "needs_input" && e.requestId === "r2"),
        "structured needs_input r2",
      );
      const beforeStructuredAnswer = events.length;
      const structuredAnswer = [["core", "cli"], ["safe"]];
      const secondOperation = createHsrAnswerOperation(
        sessionRecord,
        "r2",
        structuredAnswer,
        hsrAnswerHostFromMeta(answerMeta!),
      );
      await offerHsrAnswerOperation(bee, secondOperation);
      await markHsrAnswerOperationSending(bee, secondOperation);
      await client.call("answer", { operation: secondOperation, answer: structuredAnswer });
      await waitFor(
        () => events.slice(beforeStructuredAnswer).some(
          (e) => e.type === "text" && e.text === 'answered:[["core","cli"],["safe"]]',
        ),
        "structured answer preserved over host RPC",
      );

      // 4. snapshot returns the echoed output tail.
      const snap = (await client.call("snapshot", { lines: 5 })) as string;
      assert.match(snap, /echo:hello/);

      // The socket reports the host-owned incarnation, independently of a
      // stale external disk stamp. Boot re-adoption needs two witnesses to
      // heal the 2026-08-10 false-exited incident safely.
      const ownedMeta = (await client.call("meta")) as Awaited<ReturnType<typeof readHsrMeta>>;
      assert.equal(ownedMeta?.status, "running");
      await writeHsrMeta(bee, {
        ...ownedMeta!,
        status: "exited",
        endedAt: new Date().toISOString(),
      });
      assert.equal(
        ((await client.call("meta")) as Awaited<ReturnType<typeof readHsrMeta>>)?.status,
        "running",
        "a foreign disk cursor cannot rewrite the live host's testimony",
      );
      assert.equal(
        ((await client.call("reassertMeta")) as Awaited<ReturnType<typeof readHsrMeta>>)?.status,
        "running",
        "the host re-publishes its own current testimony",
      );
      assert.equal((await readHsrMeta(bee))?.status, "running", "the false exit stamp is healed on disk");

      // 5. liveness + stop.
      const liveBefore = await hsrLiveness();
      assert.equal(liveBefore.get(bee), true, "bee should be alive before stop");

      await client.call("stop");
      await handle.done;

      const liveAfter = await hsrLiveness();
      assert.equal(liveAfter.get(bee), false, "bee should not be alive after stop");

      const meta = await readHsrMeta(bee);
      assert.equal(meta?.status, "exited");
      assert.ok(meta?.endedAt, "meta.endedAt should be set");
      assert.ok(meta?.eventStreamClosure, "clean exit publishes a terminal event high-water proof");
      assert.equal(await verifyHsrEventStreamClosure(bee, meta!), true);
    } finally {
      client.close();
      await handle.stop().catch(() => undefined);
    }
  });
});

test("runner-host seals exit only after delayed final stdout is durable and replayable", async () => {
  await withTempStore(async () => {
    const bee = "host-exit-before-stdio-close";
    const handle = await runHsrHost({
      bee,
      adapter: exitBeforeStdioCloseAdapter,
      opts: optsFor(bee),
      processBirthCapture: {
        timeoutMs: 0,
        capture: async (pid) => ({ pgid: pid, startedAt: `test-birth:${pid}` }),
      },
    });
    await handle.done;

    const events = await readEventLog(bee);
    const tailIndex = events.findIndex((event) => event.type === "text" && event.text === "durable-tail-after-exit");
    const exitIndex = events.findIndex((event) => event.type === "exit");
    assert.ok(tailIndex >= 0, "the frame written after process exit is durable");
    assert.ok(exitIndex > tailIndex, "the stamped exit follows every drained provider frame");
    assert.equal(events[exitIndex]!.seq, events.at(-1)!.seq, "exit is the source high-water");

    const meta = await readHsrMeta(bee);
    assert.equal(meta?.status, "exited");
    assert.equal(meta?.eventStreamClosure?.lastSeq, events[exitIndex]!.seq);
    assert.equal(await verifyHsrEventStreamClosure(bee, meta!), true);

    const consumerId = "late-terminal-replay";
    await markHsrConsumerSubscribedStrict(bee, consumerId);
    const replay = await readHsrEventsAfterSeqStrict(bee, 0, consumerId);
    assert.equal(replay.gap, undefined);
    assert.deepEqual(
      replay.events.slice(-3).map((event) => event.type),
      ["text", "turn_end", "exit"],
      "terminal replay includes the delayed tail before exit",
    );
    const highWater = Number(replay.events.at(-1)!.seq);
    assert.equal(await ackHsrEvents(bee, highWater, consumerId), highWater);
    assert.equal((await readHsrSeqState(bee))?.consumers?.[consumerId]?.ackedSeq, highWater);
  });
});

test("runner-host source append failure publishes a purge-surviving fence and ambiguates the exact provider turn", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-real-host";
    const sessionRecord: SessionRecord = {
      name: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      createdAt: "2026-08-15T19:50:00.000Z",
      updatedAt: "2026-08-15T19:50:00.000Z",
      status: "running",
      substrate: "hsr",
      runtimeGeneration: 1,
      id: "event-integrity-real-host-id",
      uuid: "event-integrity-real-host-uuid",
    };
    await saveSession(sessionRecord);
    const handle = await runHsrHost({
      bee,
      adapter: stubAdapter,
      opts: optsFor(bee),
      processBirthCapture: {
        timeoutMs: 0,
        capture: async (pid) => ({ pgid: pid, startedAt: `test-birth:${pid}` }),
      },
    });
    const admittedMeta = await readHsrMeta(bee);
    assert.ok(admittedMeta?.hostFingerprint);
    await saveSession({
      ...sessionRecord,
      runnerPid: admittedMeta!.hostPid,
      runnerFingerprint: admittedMeta!.hostFingerprint,
    });
    const client = await connectRpcClient(handle.controlSocket);
    const deliveryId = "event-integrity-provider-turn";
    await enqueuePendingHsrTurn(bee, "provider effect before append fault", { deliveryId });
    // The host_epoch is already durable. Replacing only events.jsonl with a
    // directory deterministically fails the provider's next append while
    // leaving meta, pending receipts, and the outside authority writable.
    await rm(hsrEventsPath(bee), { force: true });
    await mkdir(hsrEventsPath(bee));

    try {
      await client.call("send", { text: "provider effect before append fault", deliveryId }).catch(() => undefined);
      await waitFor(
        async () => (await readHsrEventIntegrityReceipt(bee))?.deliveryIds.includes(deliveryId) === true,
        "outside event-integrity head includes the dispatched turn",
      );
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          handle.done,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("event-integrity host stop timed out")), 5_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }

      const integrity = await readHsrEventIntegrityReceipt(bee);
      assert.ok(integrity);
      assert.equal(integrity!.phase, "unresolved");
      assert.equal(integrity!.stopState, "doubt", "adapter stop alone is not controller child-group proof");
      assert.ok(integrity!.deliveryIds.includes(deliveryId));
      assert.equal((await readPendingHsrTurn(bee, deliveryId))?.phase, "ambiguous");
      const canonical = await loadSession(bee);
      assert.equal(canonical?.status, "kill_failed");
      assert.equal(canonical?.eventIntegrityDoubt?.integrityId, integrity!.integrityId);
      assert.equal((await readHsrMeta(bee))?.status, "exited", "provider is stopped but canonical work remains fenced");
    } finally {
      client.close();
      await handle.stop().catch(() => undefined);
    }
  });
});

test("source append failure publishes outside authority even when pending-turn storage is unreadable", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-corrupt-pending-scan";
    const sessionRecord: SessionRecord = {
      name: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      createdAt: "2026-08-15T20:10:00.000Z",
      updatedAt: "2026-08-15T20:10:00.000Z",
      status: "running",
      substrate: "hsr",
    };
    await saveSession(sessionRecord);
    const handle = await runHsrHost({
      bee,
      adapter: stubAdapter,
      opts: optsFor(bee),
      processBirthCapture: {
        timeoutMs: 0,
        capture: async (pid) => ({ pgid: pid, startedAt: `test-birth:${pid}` }),
      },
    });
    const admittedMeta = await readHsrMeta(bee);
    assert.ok(admittedMeta?.hostFingerprint);
    await saveSession({
      ...sessionRecord,
      runnerPid: admittedMeta!.hostPid,
      runnerFingerprint: admittedMeta!.hostFingerprint,
    });
    const deliveryId = "event-integrity-corrupt-pending-delivery";
    await enqueuePendingHsrTurn(bee, "provider output races corrupt delivery storage", { deliveryId });
    const client = await connectRpcClient(handle.controlSocket);
    let releaseWriter!: () => void;
    let writerLocked!: () => void;
    const locked = new Promise<void>((resolve) => { writerLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const holder = withFileLock(hsrEventAuthorityLockPath(bee), async () => {
      writerLocked();
      await release;
    }, { timeoutMs: 5_000 });
    await locked;
    const send = client.call("send", {
      text: "provider output races corrupt delivery storage",
      deliveryId,
    }).catch(() => undefined);

    const pendingDir = join(hsrRunDir(bee), "pending-turns");
    const malformed = join(pendingDir, "unknown-provider-ownership.json");
    try {
      await waitFor(async () => {
        const phase = (await readPendingHsrTurn(bee, deliveryId))?.phase;
        return phase === "accepted" || phase === "started";
      }, "provider send crosses pending-turn admission while append is locked");
      await writeFile(malformed, "{malformed", { mode: 0o600 });
      await rm(hsrEventsPath(bee), { force: true });
      await mkdir(hsrEventsPath(bee));
      releaseWriter();
      await holder;
      await send;

      await waitFor(
        async () => {
          const current = await readHsrEventIntegrityReceipt(bee);
          return typeof current?.deliveryScanError === "string" && current.stopState === "doubt";
        },
        "outside receipt records unreadable pending authority and stop doubt",
      );
      const receipt = await readHsrEventIntegrityReceipt(bee);
      assert.equal(receipt?.phase, "unresolved");
      assert.match(receipt?.deliveryScanError ?? "", /pending HSR delivery authority could not be enumerated/);
      assert.equal((await loadSession(bee))?.status, "kill_failed");
      assert.equal((await loadSession(bee))?.eventIntegrityDoubt?.integrityId, receipt?.integrityId);
      assert.equal(receipt?.stopState, "doubt");
    } finally {
      releaseWriter();
      await holder.catch(() => undefined);
      await rm(malformed, { force: true });
      await rm(hsrEventsPath(bee), { recursive: true, force: true });
      await writeFile(hsrEventsPath(bee), "", { mode: 0o600 });
      // The first settlement deliberately fails while pending authority is
      // unreadable. Once repaired, an explicit stop must retry that same head,
      // close the control authority, and resolve `done`; swallowing a retry
      // failure here would leave a listening socket and mask a production
      // teardown wedge.
      await handle.stop();
      await handle.done;
      client.close();
    }
  });
});

test("idle strict observation isolates a corrupted source Bee while a healthy Bee remains observable", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-idle-hole";
    const sessionRecord: SessionRecord = {
      name: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      createdAt: "2026-08-15T20:10:00.000Z",
      updatedAt: "2026-08-15T20:10:00.000Z",
      status: "running",
      substrate: "hsr",
      runtimeGeneration: 1,
    };
    await saveSession(sessionRecord);
    const handle = await runHsrHost({
      bee,
      adapter: stubAdapter,
      opts: optsFor(bee),
      processBirthCapture: {
        timeoutMs: 0,
        capture: async (pid) => ({ pgid: pid, startedAt: `test-birth:${pid}` }),
      },
    });
    const admittedMeta = await readHsrMeta(bee);
    assert.ok(admittedMeta?.hostFingerprint);
    await saveSession({
      ...sessionRecord,
      runnerPid: admittedMeta!.hostPid,
      runnerFingerprint: admittedMeta!.hostFingerprint,
    });
    const healthyBee = "event-integrity-idle-healthy";
    const healthyHandle = await runHsrHost({
      bee: healthyBee,
      adapter: stubAdapter,
      opts: optsFor(healthyBee),
      processBirthCapture: {
        timeoutMs: 0,
        capture: async (pid) => ({ pgid: pid, startedAt: `test-birth:${pid}` }),
      },
    });
    const healthyClient = await connectRpcClient(healthyHandle.controlSocket);
    const client = await connectRpcClient(handle.controlSocket);
    try {
      await client.call("send", { text: "seed strict history" });
      await waitFor(async () => (await readEventLog(bee)).length >= 4, "seeded stamped source history");
      const lines = (await readFile(hsrEventsPath(bee), "utf8")).split("\n").filter(Boolean);
      const stamped = lines.map((line) => JSON.parse(line) as RunnerEvent);
      const removable = stamped.find((event, index) => index > 0 && index < stamped.length - 1 && event.seq !== undefined);
      assert.ok(removable?.seq);
      await writeFile(
        hsrEventsPath(bee),
        `${lines.filter((line) => (JSON.parse(line) as RunnerEvent).seq !== removable!.seq).join("\n")}\n`,
        { mode: 0o600 },
      );

      const observations = await hsrObservations({ includeEvents: true, bees: [bee, healthyBee] });
      assert.equal(observations.get(bee)?.unavailable?.kind, "integrity");
      assert.equal(observations.get(healthyBee)?.live, true);
      assert.equal(observations.get(healthyBee)?.unavailable, undefined);
      await healthyClient.call("send", { text: "healthy observer remains operational" });
      await waitFor(async () => (await readHsrEventIntegrityReceipt(bee))?.phase === "unresolved", "outside idle-corruption fence");
      await handle.done;

      const receipt = await readHsrEventIntegrityReceipt(bee);
      assert.equal(receipt?.stopState, "doubt");
      assert.equal((await loadSession(bee))?.eventIntegrityDoubt?.integrityId, receipt?.integrityId);
      assert.equal((await readHsrMeta(bee))?.status, "exited");
    } finally {
      client.close();
      healthyClient.close();
      await handle.stop().catch(() => undefined);
      await healthyHandle.stop().catch(() => undefined);
    }
  });
});

test("idle observation promotes an exact meta-only persistence marker into manual integrity authority", async () => {
  await withTempStore(async () => {
    const bee = "event-integrity-meta-only";
    const startedAt = "2026-08-15T20:20:00.000Z";
    await ensureHsrRunDir(bee);
    await appendHsrEvent(bee, { type: "text", ts: 1, text: "durable prefix" });
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: process.pid,
      childAdmission: "none",
      startedAt,
      controlSocket: "",
      status: "running",
      eventIntegrityFailure: "provider event append failed before outside receipt publication",
    });
    await saveSession({
      name: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      createdAt: startedAt,
      updatedAt: startedAt,
      status: "running",
      substrate: "hsr",
      runnerPid: process.pid,
    });
    assert.equal(await readHsrEventIntegrityReceipt(bee), null, "fixture starts in the marker-before-head crash window");

    const observation = (await hsrObservations({ includeEvents: true, bees: [bee] })).get(bee);
    assert.equal(observation?.unavailable?.kind, "integrity");
    const receipt = await readHsrEventIntegrityReceipt(bee);
    assert.equal(receipt?.phase, "unresolved");
    assert.equal(receipt?.stopState, "doubt");
    const canonical = await loadSession(bee);
    assert.equal(canonical?.status, "kill_failed");
    assert.equal(canonical?.eventIntegrityDoubt?.integrityId, receipt?.integrityId);
  });
});

test("reapDeadHosts: stale running meta with a dead host pid flips to exited", async () => {
  await withTempStore(async () => {
    const bee = "ghost";
    await ensureHsrRunDir(bee);
    // A pid that cannot exist — INT32_MAX. Host is "running" but dead.
    const deadPid = 2 ** 31 - 1;
    await writeHsrMeta(bee, {
      bee,
      harness: "stub",
      tier: "stream",
      hostPid: deadPid,
      hostFingerprint: { pgid: deadPid, startedAt: "Mon Aug  7 09:00:00 2026" },
      childAdmission: "none",
      startedAt: new Date().toISOString(),
      controlSocket: hsrControlSocketPath(bee),
      status: "running",
    });

    const live = await hsrLiveness();
    assert.equal(live.get(bee), false, "dead host should read as not alive");

    const reaped = await reapDeadHosts({ readProcessIdentity: async () => null });
    assert.deepEqual(reaped, [bee]);

    const meta = await readHsrMeta(bee);
    assert.equal(meta?.status, "exited");
    assert.ok(meta?.endedAt, "reaped meta.endedAt should be set");

    // Idempotent: a second reap finds nothing to do.
    assert.deepEqual(await reapDeadHosts({ readProcessIdentity: async () => null }), []);
  });
});
