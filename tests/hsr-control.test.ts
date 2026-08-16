import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectRpcClient } from "../src/hsr/rpc.js";
import { runHsrHost } from "../src/hsr/host.js";
import { HsrDeliveryAmbiguousError } from "../src/hsr/pendingTurns.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { hsrRunDir, readHsrMetaStrict } from "../src/hsr/runDir.js";
import { acceptHsrMessage, startHsrControlServer } from "../src/daemon/hsrControl.js";
import { cancelQueuedBuzMessage, generateMessageId, listMessages, sendBuzMessageInAdmission } from "../src/buz.js";
import { needsInputRequestId } from "../src/requests/keys.js";
import { openRequest, readBeeRequests } from "../src/requests/store.js";
import { loadSession, saveSession, updateSession, type SessionRecord } from "../src/store.js";
import type { HsrAnswerHostIdentity } from "../src/answerReceipt.js";
import type { RunnerEvent, RunnerOpts } from "../src/hsr/types.js";
import type { SendTextOptions, Substrate } from "../src/substrates/types.js";
import { lifecycleCursor } from "./lifecycle-fixtures.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fakeSubstrate(impl: Partial<Substrate> = {}): Substrate {
  return {
    kind: "local-tmux",
    node: "local",
    probe: async () => ({ ok: true }),
    hasSession: async () => true,
    newSession: async () => ({ paneId: "%1" }),
    kill: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
    capture: async () => "",
    sendText: async () => undefined,
    sendEnter: async () => undefined,
    sendKey: async () => undefined,
    listSessions: async () => [],
    listPanes: async () => new Set(),
    listSessionStates: async () => new Map(),
    setUserOptions: async () => undefined,
    setWindowOptions: async () => undefined,
    renameWindow: async () => undefined,
    attachCommand: () => [],
    attachSession: async () => undefined,
    ...impl,
  };
}

/** Set HIVE_STORE_ROOT to a fresh mkdtemp dir for the duration of `fn`. */
async function withTempStore(fn: (root: string) => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-control-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
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

function optsFor(bee: string): RunnerOpts {
  return {
    bee,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    runDir: hsrRunDir(bee),
  };
}

test("hsr-control: liveness/list/observe-relay/send across the aggregate endpoint", async () => {
  await withTempStore(async () => {
    const bee = "ctltest";
    const server = await startHsrControlServer();
    const host = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee) });
    const meta = await readHsrMetaStrict(bee);
    assert.ok(meta);
    const now = new Date().toISOString();
    await saveSession({
      name: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      substrate: "hsr",
      runnerPid: meta.hostPid,
      ...(meta.hostFingerprint ? { runnerFingerprint: meta.hostFingerprint } : {}),
      createdAt: now,
      updatedAt: now,
      status: "running",
    });
    const client = await connectRpcClient(server.path);
    // Relayed bee events arrive as `hsr.event` { bee, event }.
    const relayed: Array<{ bee: string; event: RunnerEvent }> = [];
    client.on("hsr.event", (p) => relayed.push(p as { bee: string; event: RunnerEvent }));

    try {
      const capabilities = (await client.call("capabilities")) as Record<string, unknown>;
      assert.deepEqual(capabilities, {
        ok: true,
        spawn: 2,
        spawnEnv: 1,
        spawnParent: 1,
        message: 1,
        broker: 3,
        fork: 1,
        handoff: 1,
        execution: 1,
        executionAdmin: 1,
      });

      // liveness() includes the live bee.
      const liveness = (await client.call("liveness")) as Record<string, boolean>;
      assert.equal(liveness[bee], true, "liveness should show the bee alive");

      // list() carries the bee's tier / sessionId / controlSocket.
      await waitFor(async () => {
        const rows = (await client.call("list")) as Array<Record<string, unknown>>;
        const row = rows.find((r) => r.bee === bee);
        return !!row && row.sessionId === "stub-session";
      }, "list() shows learned sessionId");
      const rows = (await client.call("list")) as Array<Record<string, unknown>>;
      const row = rows.find((r) => r.bee === bee)!;
      assert.equal(row.live, true);
      assert.equal(row.tier, "stream");
      assert.equal(row.status, "running");
      assert.equal(typeof row.controlSocket, "string");
      assert.ok((row.controlSocket as string).length > 0, "controlSocket path present");

      // observe() then send() → the client receives the relayed text + turn_end.
      const observe = (await client.call("observe", { bee })) as { ok: boolean };
      assert.equal(observe.ok, true, "observe should succeed");

      const send = (await client.call("send", { bee, text: "hello" })) as { ok: boolean };
      assert.equal(send.ok, true, "send should succeed");

      await waitFor(
        () => relayed.some((r) => r.bee === bee && r.event.type === "text" && r.event.text === "echo:hello"),
        "relayed hsr.event text echo:hello",
      );
      await waitFor(
        () => relayed.some((r) => r.bee === bee && r.event.type === "turn_end"),
        "relayed hsr.event turn_end",
      );

      // Interrupting an already-idle runner is an idempotent success. The
      // structured result is preserved through host → daemon, and no fake
      // turn_end is emitted for clients to wait on.
      const idleEndCount = relayed.filter((r) => r.event.type === "turn_end").length;
      const idleInterrupt = (await client.call("interrupt", { bee })) as Record<string, unknown>;
      assert.deepEqual(idleInterrupt, {
        ok: true,
        result: { status: "already_idle" },
      });
      await sleep(30);
      assert.equal(
        relayed.filter((r) => r.event.type === "turn_end").length,
        idleEndCount,
        "idle interrupt must not synthesize a lifecycle boundary",
      );

      // A live turn reports that an interrupt was requested and then emits the
      // real turn_end boundary consumed by Apiary.
      await client.call("send", { bee, text: "hang forever" });
      await waitFor(
        () => relayed.some((r) => r.event.type === "text" && r.event.text === "hanging:hang forever"),
        "hanging turn started",
      );
      const activeInterrupt = (await client.call("interrupt", { bee })) as Record<string, unknown>;
      assert.deepEqual(activeInterrupt, {
        ok: true,
        result: { status: "interrupt_requested" },
      });
      await waitFor(
        () => relayed.filter((r) => r.event.type === "turn_end").length > idleEndCount,
        "interrupted turn ended",
      );

      await client.call("send", { bee, text: "ask me" });
      await waitFor(
        () => relayed.some((r) => r.bee === bee && r.event.type === "needs_input"),
        "relayed needs_input",
      );
      await waitFor(async () => {
        return (await client.call("pendingInput", { bee })) !== null;
      }, "pending input persisted");
      const pending = (await client.call("pendingInput", { bee })) as Record<string, unknown> | null;
      assert.ok(pending);
      assert.equal(pending.requestId, "r1");
      assert.equal(pending.question, "proceed?");
      assert.equal(pending.kind, "question");
      assert.equal((await client.call("answer", { bee, answer: "stale" }) as { ok: boolean }).ok, false);
      assert.equal(
        ((await client.call("pendingInput", { bee })) as Record<string, unknown> | null)?.requestId,
        "r1",
        "source-less aggregate answer must perform zero provider I/O",
      );
      assert.equal((await client.call("answer", {
        bee,
        requestId: "r1",
        source: pending.source,
        host: pending.host,
        answer: "yes",
      }) as { ok: boolean }).ok, true);

      // A later prompt on the same host must not be resolved when an accepted
      // r1 answer is replayed from its terminal receipt.
      await client.call("send", { bee, text: "ask different" });
      await waitFor(async () => {
        const next = await client.call("pendingInput", { bee }) as Record<string, unknown> | null;
        return next?.requestId === "r2";
      }, "second pending input persisted");
      const next = await client.call("pendingInput", { bee }) as Record<string, unknown> | null;
      assert.ok(next);
      const nextRequestId = needsInputRequestId(bee, {
        requestId: String(next.requestId),
        ts: Number(next.ts),
        host: next.host as HsrAnswerHostIdentity,
      });
      await openRequest(bee, {
        id: nextRequestId,
        kind: "question",
        scope: "turn",
        generation: 0,
        question: String(next.question),
        evidence: { grade: "structured", source: "test", detail: "second-pending" },
      });
      assert.equal((await client.call("answer", {
        bee,
        requestId: "r1",
        source: pending.source,
        host: pending.host,
        answer: "yes",
      }) as { ok: boolean }).ok, true);
      assert.equal(
        ((await client.call("pendingInput", { bee })) as Record<string, unknown> | null)?.requestId,
        "r2",
        "settled r1 replay performs zero provider I/O against r2",
      );
      assert.equal(
        (await readBeeRequests(bee)).find((request) => request.id === nextRequestId)?.status,
        "open",
        "settled r1 replay resolves only r1's request id",
      );

      // send to a non-existent bee → { ok:false } (no throw).
      const bad = (await client.call("send", { bee: "nope", text: "x" })) as { ok: boolean };
      assert.equal(bad.ok, false, "send to unknown bee should be ok:false");

      // After stopping the host, liveness flips to false.
      await host.stop();
      const after = (await client.call("liveness")) as Record<string, boolean>;
      assert.equal(after[bee], false, "liveness should show the bee not alive after stop");
    } finally {
      client.close();
      await host.stop().catch(() => undefined);
      await server.close();
    }
  });
});

test("hsr-control rejects a delayed predecessor-host answer when r1 is reused", async () => {
  await withTempStore(async () => {
    const bee = "ctl-answer-refresh";
    const server = await startHsrControlServer();
    let host = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee) });
    const now = new Date().toISOString();
    await saveSession({
      name: bee,
      agent: "stub",
      cwd: process.cwd(),
      command: "stub",
      tmuxTarget: bee,
      substrate: "hsr",
      createdAt: now,
      updatedAt: now,
      status: "running",
    });
    const aggregate = await connectRpcClient(server.path);
    try {
      let direct = await connectRpcClient(host.controlSocket);
      try {
        await direct.call("send", { text: "ask first" });
      } finally {
        direct.close();
      }
      await waitFor(async () => {
        const first = await aggregate.call("pendingInput", { bee }) as Record<string, unknown> | null;
        return first?.requestId === "r1";
      }, "first host aggregate pending");
      const first = await aggregate.call("pendingInput", { bee }) as Record<string, unknown> | null;
      assert.ok(first);
      assert.equal(first?.question, "proceed?");

      await host.stop();
      host = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee) });
      assert.equal(await aggregate.call("pendingInput", { bee }), null, "old unresolved r1 is not rebound during refresh");
      direct = await connectRpcClient(host.controlSocket);
      try {
        await direct.call("send", { text: "ask different" });
      } finally {
        direct.close();
      }
      await waitFor(async () => {
        const second = await aggregate.call("pendingInput", { bee }) as Record<string, unknown> | null;
        return second?.question === "different prompt?";
      }, "second host aggregate pending");
      const second = await aggregate.call("pendingInput", { bee }) as Record<string, unknown> | null;
      assert.ok(second);
      assert.equal(second?.requestId, "r1");

      const stale = await aggregate.call("answer", {
        bee,
        requestId: "r1",
        source: first!.source,
        host: first!.host,
        answer: "stale-a",
      }) as { ok: boolean };
      assert.equal(stale.ok, false);
      assert.equal(
        ((await aggregate.call("pendingInput", { bee })) as Record<string, unknown> | null)?.question,
        "different prompt?",
        "stale A envelope performs zero provider I/O against B",
      );
      assert.equal((await aggregate.call("answer", {
        bee,
        requestId: "r1",
        source: second!.source,
        host: second!.host,
        answer: "yes",
      }) as { ok: boolean }).ok, true);
    } finally {
      aggregate.close();
      await host.stop().catch(() => undefined);
      await server.close();
    }
  });
});

// NOTE: `spawn` now runs spawnSingleBee IN-PROCESS (no CLI shell-out). The
// happy path needs a real harness binary (resolveAgent/exec-check), which a
// store-only unit test cannot drive — verified manually via the daemon
// endpoint. The guarded error path IS exercised below: it must come back as
// { ok:false, error } over the socket, never a throw.
test("hsr control socket: spawn with an unknown kind returns ok:false", async () => {
  await withTempStore(async () => {
    const server = await startHsrControlServer();
    const client = await connectRpcClient(server.path);
    try {
      const missing = (await client.call("spawn", {})) as { ok: boolean; error?: string };
      assert.equal(missing.ok, false, "spawn without kind should be ok:false");
      const spoofedFlag = (await client.call("spawn", {
        kind: "definitely-not-a-harness",
        flags: { "spawned-by": "untrusted-parent" },
      })) as { ok: boolean; error?: string };
      assert.equal(spoofedFlag.ok, false);
      assert.doesNotMatch(spoofedFlag.error ?? "", /Unknown spawning bee/, "generic flags cannot enter the trusted parent seam");
      const unknownParent = (await client.call("spawn", {
        kind: "definitely-not-a-harness",
        spawnedById: "missing-parent",
      })) as { ok: boolean; error?: string };
      assert.equal(unknownParent.ok, false);
      assert.match(unknownParent.error ?? "", /Unknown spawning bee/, "top-level parent is validated before spawn");
      const unknown = (await client.call("spawn", { kind: "definitely-not-a-harness" })) as { ok: boolean; error?: string };
      assert.equal(unknown.ok, false, "spawn with an unknown kind should be ok:false");
      assert.ok((unknown.error ?? "").length > 0, "error message expected");
    } finally {
      client.close();
      await server.close();
    }
  });
});

test("hsr-control message durably accepts a cold idle bee and rejects an archived bee", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const cold: SessionRecord = {
      name: "cold-idle",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "cold-idle",
      substrate: "hsr",
      createdAt: now,
      updatedAt: now,
      status: "dead",
      providerSessionId: "provider-thread-cold-idle",
    };
    const archived: SessionRecord = { ...cold, name: "archived", tmuxTarget: "archived", status: "done" };
    await saveSession(cold);
    await saveSession(archived);

    const accepted = await acceptHsrMessage({
      bee: cold.name,
      text: "continue from here",
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.delivery, "queued");
    assert.equal(typeof accepted.messageId, "string");
    const queued = await listMessages(cold.name, "queue");
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.message.body, "continue from here");
    const recovering = (await loadSession(cold.name))!;
    assert.equal(recovering.status, "dead", "acceptance does not fabricate runtime lifecycle status");
    assert.equal(recovering.lastObservedState, undefined, "acceptance does not fabricate a daemon observation");
    assert.equal(recovering.recoveryMessageId, accepted.messageId);
    assert.equal(typeof recovering.recoveryRequestedAt, "string");

    const refused = await acceptHsrMessage({
      bee: archived.name,
      text: "do not revive archived work",
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.accepted, false, "archived is a positive pre-admission refusal");
    assert.match(String(refused.error), /archived/);
    assert.equal((await listMessages(archived.name, "queue")).length, 0);
  });
});

test("hsr-control message accepts canonical active lifecycle despite a stale done scalar", async () => {
  await withTempStore(async (root) => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "message-canonical-active",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "message-canonical-active",
      substrate: "hsr",
      providerSessionId: "thread-canonical-active",
      createdAt: now,
      updatedAt: now,
      status: "done",
      stateMachine: {
        lifecycle: "active",
        runtime: "parked",
        work: "done",
        revision: 1,
        transitionedAt: now,
        lastEventId: "event-message-canonical-active",
        lastTransition: {
          eventId: "event-message-canonical-active",
          type: "runtime.parked",
          cause: "idle-death",
          at: now,
          evidence: [{
            kind: "probe",
            probeId: "probe-message-canonical-active",
            observerId: "hsr-control-test",
            observedAt: now,
            outcome: "dead",
            target: { substrate: "hsr", tmuxTarget: "message-canonical-active" },
          }],
        },
      },
    };
    // Seed the mixed-version record exactly as an older writer could have
    // left it. Public writers correctly reject direct stateMachine mutation;
    // this regression exercises tolerant loading of already-durable bytes.
    const legacy = { ...record };
    delete legacy.stateMachine;
    await saveSession(legacy);
    await writeFile(
      join(root, "sessions", `${record.name}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600 },
    );
    const messageId = generateMessageId();

    const accepted = await acceptHsrMessage({
      bee: record.name,
      text: "canonical state remains live",
      messageId,
    });

    assert.equal(accepted.ok, true);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.messageId, messageId);
    assert.equal(accepted.delivery, "queued");
    assert.equal((await listMessages(record.name, "queue")).length, 1);
  });
});

test("hsr-control message fences canonical-active stop doubt and settles an exact queued replay undeliverable", async () => {
  await withTempStore(async (root) => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "message-canonical-stop-doubt",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "message-canonical-stop-doubt",
      substrate: "hsr",
      providerSessionId: "thread-canonical-stop-doubt",
      createdAt: now,
      updatedAt: now,
      status: "kill_failed",
      stateMachine: lifecycleCursor("message-canonical-stop-doubt", "active", now),
    };
    const legacy = { ...record };
    delete legacy.stateMachine;
    await saveSession(legacy);
    await writeFile(
      join(root, "sessions", `${record.name}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600 },
    );

    const refused = await acceptHsrMessage({ bee: record.name, text: "do not launch across stop doubt" });
    assert.equal(refused.ok, false);
    assert.equal(refused.accepted, false);
    assert.match(String(refused.error), /stop state unresolved/);
    assert.equal((await listMessages(record.name, "queue")).length, 0);

    const messageId = generateMessageId();
    await sendBuzMessageInAdmission({
      recipient: record,
      sender: { kind: "human", name: "apiary" },
      tier: "queue",
      body: "accepted before stop doubt",
      messageId,
    });
    const replay = await acceptHsrMessage({
      bee: record.name,
      text: "accepted before stop doubt",
      messageId,
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.accepted, true);
    assert.equal(replay.messageId, messageId);
    assert.equal(replay.delivery, "undeliverable");
    assert.equal(replay.outcome, "UNDELIVERABLE");
    assert.equal((await listMessages(record.name, "queue")).length, 0);
    assert.deepEqual(
      (await listMessages(record.name, "quarantine")).map((entry) => entry.message.id),
      [messageId],
      "a definitive terminal verdict must remove the exact id from future drain work",
    );
  });
});

test("hsr-control repairs a fault after queue persistence into an idempotent receipt", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "message-post-persist-repair",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "message-post-persist-repair",
      substrate: "hsr",
      providerSessionId: "thread-post-persist-repair",
      createdAt: now,
      updatedAt: now,
      status: "dead",
    };
    await saveSession(record);
    const messageId = generateMessageId();
    let failOnce = true;

    const accepted = await acceptHsrMessage(
      { bee: record.name, text: "persist exactly once", messageId },
      {
        beforeRecoveryCommit: () => {
          if (!failOnce) return;
          failOnce = false;
          throw new Error("injected cursor commit failure after queue persistence");
        },
      },
    );

    assert.deepEqual(
      {
        ok: accepted.ok,
        accepted: accepted.accepted,
        messageId: accepted.messageId,
        delivery: accepted.delivery,
        idempotent: accepted.idempotent,
      },
      { ok: true, accepted: true, messageId, delivery: "queued", idempotent: true },
    );
    assert.deepEqual(
      (await listMessages(record.name, "queue")).map((entry) => entry.message.id),
      [messageId],
      "the internal receipt repair must re-read, not enqueue a duplicate",
    );
    assert.equal((await loadSession(record.name))?.recoveryMessageId, messageId);
  });
});

test("hsr-control types persistent post-persist failure as keyed ambiguity until replay repairs it", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "message-post-persist-ambiguous",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "message-post-persist-ambiguous",
      substrate: "hsr",
      providerSessionId: "thread-post-persist-ambiguous",
      createdAt: now,
      updatedAt: now,
      status: "dead",
    };
    await saveSession(record);
    const messageId = generateMessageId();

    const ambiguous = await acceptHsrMessage(
      { bee: record.name, text: "retain my durable identity", messageId },
      {
        beforeRecoveryCommit: () => {
          throw new Error("injected persistent cursor store failure");
        },
      },
    );

    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.accepted, true, "recipient queue re-read proves durable admission");
    assert.equal(ambiguous.acceptanceAmbiguous, true);
    assert.equal(ambiguous.retryWithSameMessageId, true);
    assert.equal(ambiguous.messageId, messageId);
    assert.deepEqual((await listMessages(record.name, "queue")).map((entry) => entry.message.id), [messageId]);
    assert.equal((await loadSession(record.name))?.recoveryMessageId, undefined);

    const replay = await acceptHsrMessage({
      bee: record.name,
      text: "retain my durable identity",
      messageId,
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.messageId, messageId);
    assert.equal((await loadSession(record.name))?.recoveryMessageId, messageId);
    assert.equal((await listMessages(record.name, "queue")).length, 1);
  });
});

test("hsr-control propagates post-dispatch Buz ambiguity and opens manual action immediately", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "message-provider-ambiguous",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "message-provider-ambiguous",
      providerSessionId: "thread-provider-ambiguous",
      createdAt: now,
      updatedAt: now,
      status: "running",
    };
    await saveSession(record);
    const messageId = generateMessageId();
    const substrate = fakeSubstrate({
      supportsNextTool: true,
      sendText: async () => {
        throw new HsrDeliveryAmbiguousError(messageId, "provider dispatch reply was lost");
      },
    });

    const result = await acceptHsrMessage(
      { bee: record.name, text: "do not auto-land this", messageId },
      { substrateFor: () => substrate },
    );
    assert.equal(result.ok, false);
    assert.equal(result.accepted, true);
    assert.equal(result.acceptanceAmbiguous, true);
    assert.equal(result.messageId, messageId);
    assert.equal(result.delivery, undefined, "ambiguity is never mislabeled as an ordinary queued acceptance");
    assert.equal((await listMessages(record.name, "queue")).length, 1);
    assert.ok((await readBeeRequests(record.name)).some((request) =>
      request.status === "open" && request.evidence.detail === "delivery-ambiguous"));
  });
});

test("hsr-control recovery keeps A authoritative and promotes A if legacy B is cancelled", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "queued-a-b-cancel-b",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "queued-a-b-cancel-b",
      substrate: "hsr",
      providerSessionId: "thread-a-b",
      createdAt: now,
      updatedAt: now,
      status: "dead",
    };
    await saveSession(record);

    const a = await acceptHsrMessage({ bee: record.name, text: "A" });
    const b = await acceptHsrMessage({ bee: record.name, text: "B" });
    assert.equal((await loadSession(record.name))?.recoveryMessageId, a.messageId, "B cannot overwrite A's recovery cursor");

    // Recreate the legacy overwrite shape found in production. Cancelling B
    // must consult queue/ and promote A instead of clearing the only cursor.
    await updateSession(record.name, {
      recoveryRequestedAt: new Date().toISOString(),
      recoveryMessageId: String(b.messageId),
      recoveryAttemptCount: 3,
      recoveryNextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(await cancelQueuedBuzMessage(record.name, String(b.messageId)), true);

    const after = (await loadSession(record.name))!;
    assert.equal(after.recoveryMessageId, a.messageId, "settling B promotes the still-durable A");
    assert.equal(typeof after.recoveryRequestedAt, "string");
    assert.equal(after.recoveryAttemptCount, 0, "the promoted message gets its own retry budget");
    assert.equal(after.recoveryNextAttemptAt, undefined);
    assert.deepEqual((await listMessages(record.name, "queue")).map((entry) => entry.message.id), [a.messageId]);
  });
});

test("hsr-control message reports missing cwd as durable UNDELIVERABLE needs-action", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "missing-cwd-message",
      agent: "codex",
      cwd: join(tmpdir(), "definitely-missing-hsr-message-cwd-71f23a"),
      command: "codex",
      tmuxTarget: "missing-cwd-message",
      substrate: "hsr",
      providerSessionId: "thread-missing-cwd",
      createdAt: now,
      updatedAt: now,
      status: "dead",
    };
    await saveSession(record);

    const result = await acceptHsrMessage({ bee: record.name, text: "please continue" });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(result.outcome, "UNDELIVERABLE");
    assert.equal(result.delivery, "undeliverable");
    assert.equal((await listMessages(record.name, "queue")).length, 0, "terminal settlement removes doomed work from queue");
    assert.deepEqual(
      (await listMessages(record.name, "quarantine")).map((entry) => entry.message.id),
      [result.messageId],
      "the idempotency receipt remains durable after terminal settlement",
    );
    assert.equal((await loadSession(record.name))?.recoveryRequestedAt, undefined, "doomed work is explicitly failed, not left in the hot set");
    const request = (await readBeeRequests(record.name))[0]!;
    assert.equal(request.kind, "manual-action");
    assert.equal(request.scope, "bee");
    assert.equal(request.evidence.detail, "missing-cwd");
    assert.match(request.question ?? "", /Restore or recreate the working copy/);
  });
});

test("hsr-control delivers a live remote bee without locally statting its remote cwd and carries authority tokens", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "remote-cwd-message",
      agent: "codex",
      cwd: "/remote/node/only/working-copy",
      command: "codex",
      tmuxTarget: "remote-cwd-message",
      node: "cell-one",
      remoteLaunchId: "11111111-1111-4111-8111-111111111111",
      remoteIncarnation: "22222222-2222-4222-8222-222222222222",
      providerSessionId: "thread-remote",
      createdAt: now,
      updatedAt: now,
      status: "running",
    };
    await saveSession(record);
    let delivered: SendTextOptions | undefined;
    const substrate: Substrate = {
      kind: "remote-hsr",
      node: "cell-one",
      supportsNextTool: true,
      probe: async () => ({ ok: true }),
      hasSession: async () => true,
      newSession: async () => ({ paneId: "%1" }),
      kill: async () => ({ ok: true, stdout: "", stderr: "", exitCode: 0 }),
      capture: async () => "",
      sendText: async (_target, _text, _pane, options) => { delivered = options; },
      sendEnter: async () => undefined,
      sendKey: async () => undefined,
      listSessions: async () => [record.name],
      listPanes: async () => new Set(),
      listSessionStates: async () => new Map(),
      setUserOptions: async () => undefined,
      setWindowOptions: async () => undefined,
      renameWindow: async () => undefined,
      attachCommand: () => [],
      attachSession: async () => undefined,
    };
    const result = await acceptHsrMessage(
      { bee: record.name, text: "continue remotely" },
      { substrateFor: () => substrate },
    );
    assert.equal(result.ok, true);
    assert.equal(result.delivery, "delivered");
    assert.equal(delivered?.mode, "next-tool");
    assert.equal(delivered?.completionRequired, true);
    assert.match(delivered?.deliveryId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(delivered?.remoteLaunchId, record.remoteLaunchId);
    assert.equal(delivered?.remoteIncarnation, record.remoteIncarnation);
    assert.equal((await readBeeRequests(record.name)).length, 0);
  });
});

test("hsr-control message skips missing providerSessionId into needs-action without a wake loop", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "missing-provider-message",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "missing-provider-message",
      substrate: "hsr",
      createdAt: now,
      updatedAt: now,
      status: "dead",
    };
    await saveSession(record);
    const result = await acceptHsrMessage({ bee: record.name, text: "resume this" });
    assert.equal(result.outcome, "UNDELIVERABLE");
    assert.equal((await readBeeRequests(record.name))[0]?.evidence.detail, "missing-provider-session");
    assert.equal((await loadSession(record.name))?.recoveryRequestedAt, undefined);
  });
});

test("hsr-control messageId makes client retries idempotent", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "idempotent-message",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "idempotent-message",
      substrate: "hsr",
      providerSessionId: "thread-idempotent",
      createdAt: now,
      updatedAt: now,
      status: "dead",
    };
    await saveSession(record);
    const messageId = generateMessageId();
    const first = await acceptHsrMessage({ bee: record.name, text: "same operation", messageId });
    const retry = await acceptHsrMessage({ bee: record.name, text: "same operation", messageId });
    assert.equal(first.messageId, messageId);
    assert.equal(retry.messageId, messageId);
    assert.equal(retry.idempotent, true);
    assert.equal((await listMessages(record.name, "queue")).length, 1);

    const collision = await acceptHsrMessage({ bee: record.name, text: "different operation", messageId });
    assert.equal(collision.ok, false);
    assert.match(String(collision.error), /different payload/);
    assert.equal((await listMessages(record.name, "queue")).length, 1);
  });
});

test("hsr-control receipts an exact accepted id even if the bee archives before replay", async () => {
  await withTempStore(async () => {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      name: "accepted-then-archived",
      agent: "codex",
      cwd: process.cwd(),
      command: "codex",
      tmuxTarget: "accepted-then-archived",
      substrate: "hsr",
      providerSessionId: "thread-accepted-then-archived",
      createdAt: now,
      updatedAt: now,
      status: "dead",
    };
    await saveSession(record);
    const messageId = generateMessageId();
    const first = await acceptHsrMessage({ bee: record.name, text: "accepted before archive", messageId });
    assert.equal(first.ok, true);
    await updateSession(record.name, { status: "done", updatedAt: new Date().toISOString() });

    const replay = await acceptHsrMessage({ bee: record.name, text: "accepted before archive", messageId });
    assert.equal(replay.ok, true, "terminal lifecycle drift cannot rewrite durable acceptance as refusal");
    assert.equal(replay.accepted, true);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.messageId, messageId);
    assert.equal(replay.delivery, "undeliverable");
    assert.equal((await readBeeRequests(record.name))[0]?.evidence.detail, "archive-unresolved");
    assert.equal((await listMessages(record.name, "queue")).length, 0);
    assert.deepEqual(
      (await listMessages(record.name, "quarantine")).map((entry) => entry.message.id),
      [messageId],
      "revive cannot later drain an id already settled UNDELIVERABLE",
    );
  });
});
