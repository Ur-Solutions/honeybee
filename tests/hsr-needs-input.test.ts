import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectRpcClient } from "../src/hsr/rpc.js";
import { runHsrHost, type HsrHostHandle } from "../src/hsr/host.js";
import { stubAdapter } from "../src/hsr/adapters/stub.js";
import { hsrObservations, pendingNeedsInput } from "../src/hsr/observe.js";
import { ensureHsrRunDir, hsrEventsPath, hsrRunDir, readHsrMeta, writeHsrMeta, type HsrMeta } from "../src/hsr/runDir.js";
import { listMessages } from "../src/buz.js";
import { createNeedsInputDispatcher } from "../src/daemon/needsInput.js";
import { saveSession, type SessionRecord } from "../src/store.js";
import type { BeeState } from "../src/state.js";
import type { RunnerEvent, RunnerOpts } from "../src/hsr/types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Set HIVE_STORE_ROOT to a fresh mkdtemp dir for the duration of `fn`. */
async function withTempStore(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-needs-input-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

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

function liveMeta(bee: string): HsrMeta {
  return {
    bee,
    harness: "stub",
    tier: "stream",
    hostPid: process.pid,
    startedAt: new Date().toISOString(),
    controlSocket: "/tmp/unused.sock",
    status: "running",
  };
}

async function writeEvents(bee: string, events: RunnerEvent[]): Promise<void> {
  await ensureHsrRunDir(bee);
  await writeFile(hsrEventsPath(bee), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
}

function hsrRecord(name: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  const iso = new Date().toISOString();
  return {
    name,
    agent: "stub",
    cwd: process.cwd(),
    command: "stub",
    tmuxTarget: name,
    substrate: "hsr",
    createdAt: iso,
    updatedAt: iso,
    status: "running",
    ...extra,
  };
}

/** Drive a stub child to a blocked needs_input, returning its live host handle. */
async function spawnBlockedChild(bee: string): Promise<HsrHostHandle> {
  const handle = await runHsrHost({ bee, adapter: stubAdapter, opts: optsFor(bee) });
  const client = await connectRpcClient(handle.controlSocket);
  try {
    await client.call("send", { text: "ask me" });
  } finally {
    client.close();
  }
  await waitFor(async () => (await pendingNeedsInput(bee)) !== null, `${bee} pending needs-input`);
  await waitFor(async () => (await hsrObservations()).get(bee)?.state === "blocked", `${bee} observed blocked`);
  return handle;
}

test("needs-input dispatcher: routes to living parent, de-dupes, escalates when parentless", async () => {
  await withTempStore(async () => {
    const handles: HsrHostHandle[] = [];
    try {
      // --- child with a living parent -----------------------------------------
      const child = await spawnBlockedChild("child");
      handles.push(child);

      const childRecord = hsrRecord("child", { id: "child-id", parentId: "parent-id" });
      const parentRecord = hsrRecord("parent", { id: "parent-id" });
      await saveSession(childRecord);
      await saveSession(parentRecord);

      const dispatch = createNeedsInputDispatcher();

      // Parent is alive (a non-terminal observed state); child is blocked.
      const states = new Map<string, BeeState>([
        ["child", "blocked"],
        ["parent", "idle_with_output"],
      ]);
      const records = [childRecord, parentRecord];

      // 1. Route to the living parent.
      const first = await dispatch(records, states);
      assert.equal(first.length, 1, "one routing outcome");
      assert.equal(first[0]!.bee, "child");
      assert.equal(first[0]!.routedTo, "parent", "routed to the living parent");
      assert.equal(first[0]!.requestId, "r1", "stub's needs_input requestId");

      // A buz message landed in the parent's mailbox mentioning the child + question.
      // interrupt without a transport downgrades to queue, so look there.
      await waitFor(async () => (await listMessages("parent", "queue")).length > 0, "parent has a queued buz");
      const queued = await listMessages("parent", "queue");
      assert.equal(queued.length, 1, "exactly one buz for the parent");
      const body = queued[0]!.message.body;
      assert.match(body, /child/, "body names the child");
      assert.match(body, /proceed\?/, "body carries the question");
      assert.match(body, /hive answer child/, "body tells the parent how to answer");
      assert.equal(queued[0]!.message.to, "parent");

      // 2. De-dupe: the same still-pending request is NOT routed again.
      const second = await dispatch(records, states);
      assert.equal(second.length, 0, "no re-route for the same requestId");
      assert.equal((await listMessages("parent", "queue")).length, 1, "no duplicate buz written");

      // --- parentless child → escalate ----------------------------------------
      const orphan = await spawnBlockedChild("orphan");
      handles.push(orphan);
      const orphanRecord = hsrRecord("orphan", { id: "orphan-id" }); // no parentId
      await saveSession(orphanRecord);

      const states3 = new Map<string, BeeState>([
        ["child", "blocked"],
        ["parent", "idle_with_output"],
        ["orphan", "blocked"],
      ]);
      const third = await dispatch([...records, orphanRecord], states3);
      assert.equal(third.length, 1, "only the orphan produces a new outcome (child de-duped)");
      assert.equal(third[0]!.bee, "orphan");
      assert.equal(third[0]!.escalated, true, "parentless bee escalates to the user");
      assert.equal(third[0]!.routedTo, undefined, "escalation is not routed to a parent");

      // 3. `hive answer` path: answer the child directly over its control socket.
      const meta = await readHsrMeta("child");
      assert.ok(meta?.controlSocket, "child has a control socket");
      const answerClient = await connectRpcClient(meta!.controlSocket);
      try {
        const pending = await pendingNeedsInput("child");
        assert.ok(pending, "child still pending before answer");
        await answerClient.call("answer", { requestId: pending!.requestId, answer: "yes" });
      } finally {
        answerClient.close();
      }
      // The stub resolves the turn; the needs_input clears.
      await waitFor(async () => (await pendingNeedsInput("child")) === null, "child needs-input cleared after answer");
    } finally {
      for (const handle of handles) await handle.stop().catch(() => undefined);
    }
  });
});

test("needs-input dispatcher: routes later id-less requests instead of colliding on pending", async () => {
  await withTempStore(async () => {
    const childRecord = hsrRecord("idless-child", { id: "idless-child-id", parentId: "idless-parent-id" });
    const parentRecord = hsrRecord("idless-parent", { id: "idless-parent-id" });
    await saveSession(childRecord);
    await saveSession(parentRecord);
    await writeHsrMeta("idless-child", liveMeta("idless-child"));

    const dispatch = createNeedsInputDispatcher();
    const records = [childRecord, parentRecord];
    const states = new Map<string, BeeState>([
      ["idless-child", "blocked"],
      ["idless-parent", "idle_with_output"],
    ]);

    await writeEvents("idless-child", [
      { type: "turn_start", ts: 10 },
      { type: "needs_input", ts: 11, kind: "question", question: "first?" },
    ]);

    const firstPending = await pendingNeedsInput("idless-child");
    assert.equal(firstPending?.requestId, "pending");
    assert.equal(firstPending?.ts, 11);

    const first = await dispatch(records, states);
    assert.equal(first.length, 1, "first id-less request routes");
    assert.equal(first[0]!.requestId, "pending");
    assert.equal(first[0]!.routedTo, "idless-parent");

    const duplicate = await dispatch(records, states);
    assert.equal(duplicate.length, 0, "same id-less event is still de-duped");
    assert.equal((await listMessages("idless-parent", "queue")).length, 1, "no duplicate buz for same event");

    await writeEvents("idless-child", [
      { type: "turn_start", ts: 10 },
      { type: "needs_input", ts: 11, kind: "question", question: "first?" },
      { type: "turn_end", ts: 12 },
      { type: "turn_start", ts: 20 },
      { type: "needs_input", ts: 21, kind: "question", question: "second?" },
    ]);

    const secondPending = await pendingNeedsInput("idless-child");
    assert.equal(secondPending?.requestId, "pending");
    assert.equal(secondPending?.ts, 21);

    const second = await dispatch(records, states);
    assert.equal(second.length, 1, "later id-less request with new event ts routes");
    assert.equal(second[0]!.requestId, "pending");
    assert.equal(second[0]!.routedTo, "idless-parent");

    const messages = await listMessages("idless-parent", "queue");
    assert.equal(messages.length, 2, "parent receives both distinct questions");
    assert.ok(messages.some((entry) => entry.message.body.includes("first?")));
    assert.ok(messages.some((entry) => entry.message.body.includes("second?")));
  });
});
