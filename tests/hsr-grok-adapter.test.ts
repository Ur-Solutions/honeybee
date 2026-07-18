import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  buildGrokSpawn,
  encodeGrokPermissionAnswer,
  encodeGrokQuestionAnswer,
  grokModeFromArgs,
  grokPermissionRequestToNeedsInput,
  grokPromptErrorToEvents,
  grokQuestionRequestToNeedsInput,
  grokReasoningFromArgs,
  grokSessionUpdateToEvents,
  grokUsageEvent,
  startGrokRunner,
} from "../src/hsr/adapters/grok.js";
import { AcpRpcError } from "../src/hsr/adapters/acpRpc.js";
import { structuredStateFromEvents } from "../src/hsr/observe.js";
import { ensureHsrRunDir, hsrEventsPath } from "../src/hsr/runDir.js";
import type { RunnerEvent, RunnerOpts, RunnerSession } from "../src/hsr/types.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "grok-acp-stub.mjs");

function stringEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    ...extra,
  };
}

async function nextEvent(iterator: AsyncIterator<RunnerEvent>, timeoutMs = 2_000): Promise<RunnerEvent> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for Grok event")), timeoutMs)),
  ]);
  assert.equal(result.done, false);
  return result.value;
}

async function until(
  iterator: AsyncIterator<RunnerEvent>,
  predicate: (event: RunnerEvent, events: RunnerEvent[]) => boolean,
): Promise<RunnerEvent[]> {
  const events: RunnerEvent[] = [];
  while (events.length < 80) {
    const event = await nextEvent(iterator);
    events.push(event);
    if (predicate(event, events)) return events;
  }
  throw new Error("Grok event predicate was not reached");
}

type Running = { session: RunnerSession; dir: string; logPath: string; bee: string; previousStore?: string };

async function start(over: Partial<RunnerOpts> = {}): Promise<Running> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-grok-adapter-"));
  const logPath = join(dir, "rpc.jsonl");
  const previousStore = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = dir;
  const env = stringEnv({ GROK_STUB_LOG: logPath, GROK_HOME: join(dir, "grok-home") });
  const bee = `GR-test-${Math.random().toString(16).slice(2)}`;
  const opts: RunnerOpts = {
    bee,
    cwd: dir,
    env,
    runDir: join(dir, "run"),
    command: "grok",
    args: ["--always-approve"],
    ...over,
  };
  await ensureHsrRunDir(bee);
  const session = await startGrokRunner(opts, {
    spawn: { command: process.execPath, args: [fixture], env },
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

test("Grok ACP pure spawn, update, usage, permission, question, and error mapping", () => {
  const subscription = buildGrokSpawn({
    bee: "b",
    cwd: "/tmp",
    env: { XAI_API_KEY: "secret", GROK_CODE_XAI_API_KEY: "legacy", KEEP: "1" },
    runDir: "/tmp/r",
    command: "grok",
    args: [
      "--permission-mode", "bypassPermissions",
      "--model=grok-4.5", "--effort", "low",
      "--tools=", "--disable-web-search", "--no-subagents",
      "--plugin-dir", "/plugins/one",
    ],
  });
  assert.deepEqual(subscription.args, [
    "--no-auto-update", "agent", "--no-leader", "--plugin-dir", "/plugins/one",
    "--model", "grok-4.5", "--reasoning-effort", "low", "--always-approve", "stdio",
  ]);
  assert.equal(subscription.env.XAI_API_KEY, undefined);
  assert.equal(subscription.env.GROK_CODE_XAI_API_KEY, undefined);
  assert.equal(subscription.env.KEEP, "1");

  const apiKey = buildGrokSpawn({
    bee: "b", cwd: "/tmp", env: { XAI_API_KEY: "secret" }, runDir: "/tmp/r", authKind: "api-key",
  });
  assert.equal(apiKey.env.XAI_API_KEY, "secret");
  assert.equal(grokReasoningFromArgs(["--reasoning-effort=medium", "--effort", "high"]), "high");
  assert.equal(grokReasoningFromArgs(["--effort=low"]), "low");
  assert.equal(grokModeFromArgs(["--permission-mode", "plan"]), "plan");

  assert.deepEqual(grokSessionUpdateToEvents({
    sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" },
  }), [{ type: "thought", ts: 0, text: "thinking" }]);
  assert.deepEqual(grokUsageEvent({ _meta: { usage: {
    inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedReadTokens: 50, reasoningTokens: 4,
  } } }), {
    type: "usage", ts: 0, inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 50, reasoningTokens: 4,
  });

  const permissionParams = {
    options: [
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    toolCall: { toolCallId: "t", title: "Run command" },
  };
  assert.equal(grokPermissionRequestToNeedsInput(7, permissionParams).type, "needs_input");
  assert.deepEqual(encodeGrokPermissionAnswer(permissionParams, "yes"), { outcome: { outcome: "selected", optionId: "allow" } });
  assert.deepEqual(encodeGrokPermissionAnswer(permissionParams, "no"), { outcome: { outcome: "selected", optionId: "reject" } });

  const questionParams = {
    questions: [
      { question: "Color?", options: [{ label: "Red" }, { label: "Blue", preview: "preview" }], multiSelect: false },
      { question: "Checks?", options: [{ label: "Lint" }, { label: "Tests" }], multiSelect: true },
    ],
  };
  const question = grokQuestionRequestToNeedsInput("q", questionParams);
  assert.equal(question.type, "needs_input");
  if (question.type === "needs_input") {
    assert.equal(question.questions?.length, 2);
    assert.equal(question.questions?.[0]?.options?.[1]?.preview, "preview");
    assert.equal(question.questions?.[1]?.multiSelect, true);
  }
  assert.deepEqual(encodeGrokQuestionAnswer(questionParams, JSON.stringify({ q0: "2", q1: ["Lint", "Tests"] })), {
    outcome: "accepted",
    answers: { "Color?": "Blue", "Checks?": "Lint, Tests" },
    annotations: {},
  });
  assert.deepEqual(encodeGrokQuestionAnswer(questionParams, "cancel"), { outcome: "cancelled" });

  const rateEvents = grokPromptErrorToEvents(new AcpRpcError("session/prompt", "limited", -32003, {
    resetAt: 1784383200,
    _meta: { usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 4, reasoningTokens: 1 } },
  }));
  assert.deepEqual(rateEvents.map((event) => event.type), ["usage", "exhausted"]);
  const authEvents = grokPromptErrorToEvents(new AcpRpcError("session/prompt", "Authentication required", -32000, {
    code: "auth.refresh.permanent_failure",
  }));
  assert.equal(authEvents[0]?.type, "auth_expired");
  assert.match((authEvents[0] as Extract<RunnerEvent, { type: "auth_expired" }>).detail ?? "", /grok login/);
});

test("Grok ACP initializes/authenticates, creates or loads, and applies model, reasoning, and mode", async () => {
  const running = await start({ model: "grok-4.5", args: ["--reasoning-effort", "low", "--permission-mode", "plan"] });
  try {
    assert.equal(running.session.sessionId, "grok_session_stub");
    assert.equal(running.session.tier, "stream");
    const log = await rpcLog(running.logPath);
    assert.deepEqual(log.slice(0, 5).map((entry) => entry.method), [
      "initialize", "authenticate", "session/new", "session/set_model", "session/set_mode",
    ]);
    assert.deepEqual(log.find((entry) => entry.method === "authenticate")?.params, { methodId: "cached_token" });
    assert.deepEqual(log.find((entry) => entry.method === "session/set_model")?.params, {
      sessionId: "grok_session_stub", modelId: "grok-4.5", _meta: { reasoningEffort: "low" },
    });
    assert.deepEqual(log.find((entry) => entry.method === "session/set_mode")?.params, {
      sessionId: "grok_session_stub", modeId: "plan",
    });
  } finally {
    await cleanup(running);
  }

  const resumed = await start({ resume: true, sessionId: "grok_existing", authKind: "api-key", args: [] });
  try {
    assert.equal(resumed.session.sessionId, "grok_existing");
    const log = await rpcLog(resumed.logPath);
    assert.deepEqual(log.find((entry) => entry.method === "authenticate")?.params, { methodId: "xai.api_key" });
    assert.ok(log.some((entry) => entry.method === "session/load" && (entry.params as { sessionId?: string }).sessionId === "grok_existing"));
  } finally {
    await cleanup(resumed);
  }
});

test("Grok ACP serializes multi-turn sends and emits exact per-prompt usage", async () => {
  const running = await start();
  const iterator = running.session.events[Symbol.asyncIterator]();
  try {
    await running.session.send("queue-one");
    await running.session.send("queue-two");
    const events = await until(iterator, (_event, all) => all.filter((event) => event.type === "turn_end").length === 2);
    assert.deepEqual(events.filter((event) => event.type === "text").map((event) => event.text), ["reply:queue-one", "reply:queue-two"]);
    assert.equal(events.filter((event) => event.type === "turn_start").length, 2);
    assert.deepEqual(events.filter((event) => event.type === "usage").map((event) => [
      event.inputTokens, event.outputTokens, event.totalTokens, event.cacheReadTokens, event.reasoningTokens,
    ]), [[300, 30, 330, 120, 9], [100, 10, 110, 40, 3]]);
    const log = await rpcLog(running.logPath);
    assert.deepEqual(log.filter((entry) => entry.method === "session/prompt").map((entry) =>
      ((entry.params as { prompt?: Array<{ text?: string }> }).prompt?.[0]?.text)), ["queue-one", "queue-two"]);
  } finally {
    await cleanup(running);
  }
});

test("Grok ACP delivers next-tool sends through the next real tool boundary", async () => {
  const running = await start();
  const iterator = running.session.events[Symbol.asyncIterator]();
  try {
    await running.session.send("tool-boundary");
    assert.equal((await nextEvent(iterator)).type, "turn_start");
    await running.session.send("steer-at-tool", { mode: "next-tool" });
    const events = await until(iterator, (event) => event.type === "turn_end");
    assert.equal(events.filter((event) => event.type === "thought").length, 1);
    assert.equal(events.filter((event) => event.type === "tool_use").length, 1, "tool_call_update is not a second boundary");
    assert.ok(events.some((event) => event.type === "text" && event.text === "interjected:steer-at-tool"));
    const log = await rpcLog(running.logPath);
    assert.ok(log.some((entry) => entry.method === "_x.ai/interject" && (entry.params as { text?: string }).text === "steer-at-tool"));
    assert.equal(log.filter((entry) => entry.method === "session/prompt").length, 1, "interjection is not serialized as a later turn");
  } finally {
    await cleanup(running);
  }
});

test("Grok ACP maps standard permissions and structured multi-question answers", async () => {
  const running = await start();
  const iterator = running.session.events[Symbol.asyncIterator]();
  try {
    await running.session.send("permission");
    const permissionEvents = await until(iterator, (event) => event.type === "needs_input");
    const permission = permissionEvents.at(-1)!;
    assert.equal(permission.type, "needs_input");
    if (permission.type === "needs_input") {
      assert.equal(permission.kind, "permission");
      assert.equal(permission.tool, "Run command");
      await running.session.answer(permission.requestId!, "yes");
    }
    await until(iterator, (event) => event.type === "turn_end");

    await running.session.send("question");
    const questionEvents = await until(iterator, (event) => event.type === "needs_input");
    const question = questionEvents.at(-1)!;
    assert.equal(question.type, "needs_input");
    if (question.type === "needs_input") {
      assert.equal(question.kind, "question");
      assert.equal(question.questions?.length, 2);
      assert.equal(question.questions?.[0]?.options?.[1]?.preview, "A blue preview");
      assert.equal(question.questions?.[1]?.multiSelect, true);
      await assert.rejects(
        running.session.answer(question.requestId!, [["Blue"], ["Lint", "Tests"]]),
        /answer matrices are only supported by OpenCode/,
      );
      await running.session.answer(question.requestId!, JSON.stringify({ q0: "Blue", q1: ["Lint", "Tests"] }));
    }
    const completed = await until(iterator, (event) => event.type === "turn_end");
    assert.ok(completed.some((event) => event.type === "text" && event.text === "question:accepted:Blue|Lint, Tests"));

    const log = await rpcLog(running.logPath);
    assert.deepEqual(log.find((entry) => entry.id === 800)?.result, { outcome: { outcome: "selected", optionId: "allow" } });
    assert.deepEqual(log.find((entry) => entry.id === 801)?.result, {
      outcome: "accepted",
      answers: { "Which color?": "Blue", "Which checks?": "Lint, Tests" },
      annotations: {},
    });
  } finally {
    await cleanup(running);
  }
});

test("Grok ACP cancel is a notification and interrupt settles the active turn", async () => {
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

    await running.session.send("permission");
    await until(iterator, (event) => event.type === "needs_input");
    await running.session.interrupt();
    await until(iterator, (event) => event.type === "turn_end");
    const interruptedLog = await rpcLog(running.logPath);
    assert.deepEqual(interruptedLog.find((entry) => entry.id === 800)?.result, {
      outcome: { outcome: "cancelled" },
    }, "interrupt must settle a pending reverse permission request");
  } finally {
    await cleanup(running);
  }
});

test("Grok ACP preserves error usage, rate/auth state, fallback usage, durable events, and safe stop", async () => {
  const running = await start();
  const iterator = running.session.events[Symbol.asyncIterator]();
  try {
    await running.session.send("rate-limit");
    const limited = await until(iterator, (event) => event.type === "turn_end");
    assert.deepEqual(limited.filter((event) => event.type === "usage").map((event) => event.inputTokens), [500]);
    const exhausted = limited.find((event) => event.type === "exhausted");
    assert.equal(exhausted?.type, "exhausted");
    if (exhausted?.type === "exhausted") assert.equal(exhausted.resetHint, "2026-07-18T14:00:00.000Z");

    await running.session.send("auth-fail");
    const authFailed = await until(iterator, (event) => event.type === "turn_end");
    const auth = authFailed.find((event) => event.type === "auth_expired");
    assert.equal(auth?.type, "auth_expired");
    if (auth?.type === "auth_expired") {
      assert.equal(auth.requiresLogin, true);
      assert.match(auth.detail ?? "", /resume the bee/);
    }
    assert.equal(structuredStateFromEvents(authFailed), "auth-needed");

    await running.session.send("prompt-error-usage");
    const errored = await until(iterator, (event) => event.type === "turn_end");
    assert.deepEqual(errored.filter((event) => event.type === "usage").map((event) => event.inputTokens), [700]);
    assert.equal(errored.filter((event) => event.type === "error").length, 1);

    await running.session.send("usage-fallback");
    const fallback = await until(iterator, (event) => event.type === "turn_end");
    assert.deepEqual(fallback.filter((event) => event.type === "usage").map((event) => [event.inputTokens, event.cacheReadTokens]), [[900, 360]]);
    assert.match(running.session.snapshot(), /fallback-done/);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const durable = (await readFile(hsrEventsPath(running.bee), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as RunnerEvent);
    assert.ok(durable.some((event) => event.type === "exhausted"));
    assert.ok(durable.some((event) => event.type === "auth_expired" && event.requiresLogin));
    assert.ok(durable.some((event) => event.type === "usage" && event.reasoningTokens === 27));

    const exitPromise = until(iterator, (event) => event.type === "exit");
    await running.session.stop();
    const exited = await exitPromise;
    assert.equal(exited.at(-1)?.type, "exit");
  } finally {
    await cleanup(running);
  }
});

test("Grok ACP stop does not wait for an unanswered interject request", async () => {
  const running = await start();
  const iterator = running.session.events[Symbol.asyncIterator]();
  try {
    await running.session.send("tool-boundary");
    assert.equal((await nextEvent(iterator)).type, "turn_start");
    await running.session.send("hang-interject", { mode: "next-tool" });
    await until(iterator, (event) => event.type === "tool_use");
    const startedAt = Date.now();
    await running.session.stop();
    assert.ok(Date.now() - startedAt < 5_000, "stop must dispose a stuck reverse interjection before its RPC timeout");
  } finally {
    await cleanup(running);
  }
});
