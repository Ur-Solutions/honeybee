import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  buildKimiSpawn,
  encodeKimiPermissionAnswer,
  kimiModeFromArgs,
  kimiModelFromArgs,
  kimiPermissionRequestToNeedsInput,
  normalizeKimiModel,
  startKimiRunner,
} from "../src/hsr/adapters/kimi.js";
import { ensureHsrRunDir, hsrEventsPath } from "../src/hsr/runDir.js";
import type { RunnerEvent, RunnerOpts, RunnerSession } from "../src/hsr/types.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "kimi-acp-stub.mjs");

function stringEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    ...extra,
  };
}

async function nextEvent(iterator: AsyncIterator<RunnerEvent>, timeoutMs = 2_000): Promise<RunnerEvent> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for Kimi event")), timeoutMs)),
  ]);
  assert.equal(result.done, false);
  return result.value;
}

async function until(
  iterator: AsyncIterator<RunnerEvent>,
  predicate: (event: RunnerEvent, events: RunnerEvent[]) => boolean,
): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  while (events.length < 50) {
    const event = await nextEvent(iterator);
    events.push(event);
    if (predicate(event, events)) return events;
  }
  throw new Error("Kimi event predicate was not reached");
}

type Running = { session: RunnerSession; dir: string; logPath: string; bee: string; previousStore?: string };

async function start(over: Partial<RunnerOpts> = {}): Promise<Running> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-kimi-adapter-"));
  const logPath = join(dir, "rpc.jsonl");
  const previousStore = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  const env = stringEnv({ KIMI_STUB_LOG: logPath, KIMI_CODE_HOME: join(dir, "kimi-home") });
  const bee = `KM-test-${Math.random().toString(16).slice(2)}`;
  const opts: RunnerOpts = {
    bee,
    cwd: dir,
    env,
    runDir: join(dir, "run"),
    command: "kimi",
    args: ["--yolo", "--model", "kimi-code/k3"],
    ...over,
  };
  await ensureHsrRunDir(bee);
  const session = await startKimiRunner(opts, {
    spawn: { command: process.execPath, args: [fixture], env },
    startTelemetry: () => ({ pollNow: async () => undefined, stop: async () => undefined }),
  });
  return { session, dir, logPath, bee, ...(previousStore ? { previousStore } : {}) };
}

async function cleanup(running: Running): Promise<void> {
  await running.session.stop().catch(() => undefined);
  if (running.previousStore === undefined) delete process.env.HIVE_STORE_ROOT;
  else process.env.HIVE_STORE_ROOT = running.previousStore;
  await rm(running.dir, { recursive: true, force: true });
}

async function rpcLog(path: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("Kimi ACP pure model, mode, spawn, permission, and answer mapping", () => {
  assert.equal(normalizeKimiModel("k3"), "kimi-code/k3");
  assert.equal(normalizeKimiModel("kimi-code/kimi-for-coding"), "kimi-code/kimi-for-coding");
  assert.throws(() => normalizeKimiModel("other/model"), /supported models/);
  assert.equal(kimiModelFromArgs(["--model", "kimi-for-coding-highspeed"]), "kimi-code/kimi-for-coding-highspeed");
  assert.equal(kimiModeFromArgs(["--plan", "--auto", "--yolo"]), "yolo");
  assert.deepEqual(buildKimiSpawn({ bee: "b", cwd: "/tmp", env: {}, runDir: "/tmp/r", command: "kimi", args: ["--model", "wrong", "--yolo"] }).args, ["acp"]);

  const params = {
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    toolCall: { toolCallId: "t", title: "Bash", content: [{ type: "content", content: { type: "text", text: "Run pwd?" } }] },
  };
  const event = kimiPermissionRequestToNeedsInput(7, params);
  assert.equal(event.type, "needs_input");
  if (event.type === "needs_input") {
    assert.equal(event.kind, "permission");
    assert.equal(event.question, "Run pwd?");
    assert.equal(event.requestId, "7");
  }
  assert.deepEqual(encodeKimiPermissionAnswer(params, "yes"), { outcome: { outcome: "selected", optionId: "allow" } });
  assert.deepEqual(encodeKimiPermissionAnswer(params, "no"), { outcome: { outcome: "selected", optionId: "reject" } });
  assert.deepEqual(encodeKimiPermissionAnswer(params, "cancel"), { outcome: { outcome: "cancelled" } });
});

test("Kimi ACP initializes, creates/resumes, then applies model and mode through session config", async () => {
  const running = await start({ model: "kimi-for-coding-highspeed", args: ["--plan", "--model", "kimi-code/k3"] });
  try {
    assert.equal(running.session.sessionId, "session_stub");
    assert.equal(running.session.tier, "stream");
    const log = await rpcLog(running.logPath);
    assert.deepEqual(log.slice(0, 5).map((entry) => entry.method), [
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
    ]);
    const config = log.filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params);
    assert.deepEqual(config, [
      { sessionId: "session_stub", configId: "model", value: "kimi-code/kimi-for-coding-highspeed" },
      { sessionId: "session_stub", configId: "mode", value: "plan" },
    ]);
  } finally {
    await cleanup(running);
  }

  const resumed = await start({ resume: true, sessionId: "session_existing", args: ["--yolo"] });
  try {
    assert.equal(resumed.session.sessionId, "session_existing");
    const log = await rpcLog(resumed.logPath);
    assert.ok(log.some((entry) => entry.method === "session/resume" && (entry.params as { sessionId?: string }).sessionId === "session_existing"));
    assert.ok(log.some((entry) => entry.method === "session/set_config_option" && (entry.params as { configId?: string; value?: string }).configId === "mode" && (entry.params as { value?: string }).value === "yolo"));
  } finally {
    await cleanup(resumed);
  }
});

test("Kimi ACP serializes sends and releases next-tool sends at a tool boundary", async () => {
  const running = await start();
  const iterator = running.session.events[Symbol.asyncIterator]();
  try {
    await running.session.send("queue-one");
    await running.session.send("queue-two");
    const queuedEvents = await until(iterator, (_event, events) => events.filter((event) => event.type === "turn_end").length === 2);
    assert.deepEqual(
      queuedEvents.filter((event) => event.type === "text").map((event) => (event as Extract<RunnerEvent, { type: "text" }>).text),
      ["reply:queue-one", "reply:queue-two"],
    );
    assert.equal(queuedEvents.filter((event) => event.type === "turn_start").length, 2);

    await running.session.send("tool-boundary");
    await nextEvent(iterator); // turn_start
    await running.session.send("after-boundary", { mode: "next-tool" });
    const toolEvents = await until(iterator, (_event, events) => events.filter((event) => event.type === "turn_end").length === 2);
    assert.equal(toolEvents.filter((event) => event.type === "tool_use").length, 1, "repeated ACP tool updates emit one boundary");
    assert.ok(toolEvents.some((event) => event.type === "text" && event.text === "reply:after-boundary"));
  } finally {
    await cleanup(running);
  }
});

test("Kimi ACP maps permissions/questions and answers ACP server requests", async () => {
  const running = await start();
  const iterator = running.session.events[Symbol.asyncIterator]();
  try {
    await running.session.send("permission");
    const permissionEvents = await until(iterator, (event) => event.type === "needs_input");
    const permission = permissionEvents.at(-1)!;
    assert.equal(permission.type, "needs_input");
    if (permission.type === "needs_input") {
      assert.equal(permission.kind, "permission");
      assert.equal(permission.tool, "Bash");
      await running.session.answer(permission.requestId!, "yes");
    }
    await until(iterator, (event) => event.type === "turn_end");

    await running.session.send("question");
    const questionEvents = await until(iterator, (event) => event.type === "needs_input");
    const question = questionEvents.at(-1)!;
    assert.equal(question.type, "needs_input");
    if (question.type === "needs_input") {
      assert.equal(question.kind, "question");
      assert.equal(question.question, "Which color?");
      assert.equal(question.questions?.[0]?.options?.[1]?.description, "Cool");
      await running.session.answer(question.requestId!, "Blue");
    }
    const completed = await until(iterator, (event) => event.type === "turn_end");
    assert.ok(completed.some((event) => event.type === "text" && event.text === "answered:q0_opt_1"));
    const log = await rpcLog(running.logPath);
    assert.ok(log.some((entry) => entry.id === 700 && (entry.result as { outcome?: { optionId?: string } })?.outcome?.optionId === "allow"));
    assert.ok(log.some((entry) => entry.id === 701 && (entry.result as { outcome?: { optionId?: string } })?.outcome?.optionId === "q0_opt_1"));
  } finally {
    await cleanup(running);
  }
});

test("Kimi ACP cancel is a notification and interrupt settles the active turn", async () => {
  const running = await start();
  const iterator = running.session.events[Symbol.asyncIterator]();
  try {
    await running.session.send("wait-for-cancel");
    assert.equal((await nextEvent(iterator)).type, "turn_start");
    await running.session.interrupt();
    assert.equal((await nextEvent(iterator)).type, "turn_end");
    const log = await rpcLog(running.logPath);
    const cancel = log.find((entry) => entry.method === "session/cancel");
    assert.ok(cancel);
    assert.equal("id" in cancel!, false, "ACP cancellation must be a notification, not a request");
  } finally {
    await cleanup(running);
  }
});

test("Kimi ACP classifies auth failures, snapshots text, persists durable events, and exits cleanly", async () => {
  const running = await start();
  const iterator = running.session.events[Symbol.asyncIterator]();
  try {
    await running.session.send("hello");
    await until(iterator, (event) => event.type === "turn_end");
    assert.match(running.session.snapshot(), /reply:hello/);
    await running.session.send("auth-fail");
    const failed = await until(iterator, (event) => event.type === "turn_end");
    assert.equal(failed.filter((event) => event.type === "auth_expired").length, 1);

    // appendHsrEvent is intentionally async; allow the per-bee append chain to drain.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const entries = (await readFile(hsrEventsPath(running.bee), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as RunnerEvent);
    assert.ok(entries.some((event) => event.type === "text" && event.text === "reply:hello"));
    assert.ok(entries.some((event) => event.type === "auth_expired"));
  } finally {
    const exitPromise = until(iterator, (event) => event.type === "exit");
    await running.session.stop();
    const exited = await exitPromise;
    assert.equal(exited.at(-1)?.type, "exit");
    await cleanup(running);
  }
});
