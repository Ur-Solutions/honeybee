import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  buildOpenCodeSpawn,
  openCodeAssistantUsage,
  openCodeErrorToRunnerEvent,
  openCodePermissionNeedsInput,
  openCodeQuestionNeedsInput,
  openCodeSelection,
  parseOpenCodeStartupUrl,
  startOpenCodeRunner,
} from "../src/hsr/adapters/opencode.js";
import type { RunnerEvent, RunnerOpts, RunnerSession } from "../src/hsr/types.js";

const fixture = resolve("tests/fixtures/fake-opencode-server.mjs");

type FixtureState = {
  url: string;
  passwordConfigured: boolean;
  username: string;
  promptBeforeSubscription: boolean;
  healthUnauthorizedAttempts: number;
  sseClients: number;
  descendantPid?: number;
  sessions: Array<Record<string, unknown>>;
  requests: Array<{
    method: string;
    path: string;
    authorized: boolean;
    body?: unknown;
    subscriptionCount?: number;
  }>;
};

type Rig = {
  session: RunnerSession;
  events: RunnerEvent[];
  url: string;
  root: string;
  stopFile: string;
  state(): Promise<FixtureState>;
  emit(event: unknown): Promise<void>;
  set(value: unknown): Promise<void>;
  disconnect(): Promise<void>;
  cleanup(): Promise<void>;
};

function envRecord(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
  return { ...env, ...extra };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`timed out waiting for ${message}`);
}

async function startRig(input: {
  args?: string[];
  env?: Record<string, string>;
  resume?: boolean;
  sessionId?: string;
  cwd?: string;
} = {}): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "hive-opencode-adapter-"));
  const cwd = input.cwd ?? root;
  const urlFile = join(root, "url.json");
  const stopFile = join(root, "stopped.txt");
  const previousStore = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = join(root, "store");
  const opts: RunnerOpts = {
    bee: `OP.test-${root.slice(-6)}`,
    cwd,
    env: envRecord({
      FAKE_OPENCODE_URL_FILE: urlFile,
      FAKE_OPENCODE_STOP_FILE: stopFile,
      ...(input.env ?? {}),
    }),
    runDir: join(root, "run"),
    command: process.execPath,
    args: [fixture, ...(input.args ?? [])],
    ...(input.resume ? { resume: true } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };

  let session: RunnerSession;
  try {
    session = await startOpenCodeRunner(opts, {
      startupTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      reconnectBaseMs: 10,
    });
  } catch (error) {
    if (previousStore === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousStore;
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const url = (JSON.parse(await readFile(urlFile, "utf8")) as { url: string }).url;
  const events: RunnerEvent[] = [];
  const collector = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  let cleaned = false;

  async function control(path: string, value?: unknown): Promise<Response> {
    return fetch(`${url}${path}`, {
      method: value === undefined ? "POST" : "POST",
      ...(value === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }),
    });
  }

  return {
    session,
    events,
    url,
    root,
    stopFile,
    async state(): Promise<FixtureState> {
      const response = await fetch(`${url}/__test/state`);
      assert.equal(response.ok, true);
      return await response.json() as FixtureState;
    },
    async emit(event): Promise<void> {
      assert.equal((await control("/__test/emit", event)).ok, true);
    },
    async set(value): Promise<void> {
      assert.equal((await control("/__test/set", value)).ok, true);
    },
    async disconnect(): Promise<void> {
      assert.equal((await control("/__test/disconnect")).ok, true);
    },
    async cleanup(): Promise<void> {
      if (cleaned) return;
      cleaned = true;
      await session.stop().catch(() => undefined);
      await collector;
      if (previousStore === undefined) delete process.env.HIVE_STORE_ROOT;
      else process.env.HIVE_STORE_ROOT = previousStore;
      await rm(root, { recursive: true, force: true });
    },
  };
}

function promptRequests(state: FixtureState) {
  return state.requests.filter((request) => request.path.endsWith("/prompt_async"));
}

test("startup URL parsing accepts only authenticated loopback HTTP endpoints", () => {
  assert.equal(parseOpenCodeStartupUrl("opencode server listening on http://127.0.0.1:4096")?.port, "4096");
  assert.equal(parseOpenCodeStartupUrl("log opencode server listening on http://localhost:52111")?.hostname, "localhost");
  assert.equal(parseOpenCodeStartupUrl("opencode server listening on https://127.0.0.1:4096"), undefined);
  assert.equal(parseOpenCodeStartupUrl("opencode server listening on http://0.0.0.0:4096"), undefined);
  assert.equal(parseOpenCodeStartupUrl("opencode server listening on http://127.0.0.1:0"), undefined);
  assert.equal(parseOpenCodeStartupUrl("opencode server listening on http://attacker@127.0.0.1:4096"), undefined);
  assert.equal(parseOpenCodeStartupUrl("opencode server listening on http://127.0.0.1:4096/proxy"), undefined);
});

test("spawn/model configuration strips TUI flags and maps qualified model + reasoning variant", () => {
  const opts: RunnerOpts = {
    bee: "OP.model",
    cwd: "/tmp",
    env: { OPENCODE_SERVER_PASSWORD: "caller-secret" },
    runDir: "/tmp/run",
    command: "opencode",
    args: ["--mini", "--auto", "--model", "zai-coding-plan/glm-5", "--variant", "high"],
  };
  assert.deepEqual(openCodeSelection(opts), {
    model: { providerID: "zai-coding-plan", modelID: "glm-5" },
    variant: "high",
  });
  const spawn = buildOpenCodeSpawn(opts, "random-password");
  assert.deepEqual(spawn.args, ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
  assert.equal(spawn.env.OPENCODE_SERVER_PASSWORD, "random-password");
  assert.equal(spawn.args.includes("caller-secret"), false);
  assert.throws(() => openCodeSelection({ model: "unqualified", args: [] }), /provider\/model/);
  assert.throws(
    () => openCodeSelection({ model: "zai-coding-plan/glm-5", args: ["--model", "unqualified"] }),
    /provider\/model/,
  );

  const isolated = buildOpenCodeSpawn({
    ...opts,
    env: { XDG_DATA_HOME: "/tmp/opencode-account-data" },
  }, "random-password");
  assert.ok(isolated.env.MISE_DATA_DIR, "isolated XDG auth must retain the parent mise installation registry");
  const explicitMise = buildOpenCodeSpawn({
    ...opts,
    env: { XDG_DATA_HOME: "/tmp/opencode-account-data", MISE_DATA_DIR: "/custom/mise" },
  }, "random-password");
  assert.equal(explicitMise.env.MISE_DATA_DIR, "/custom/mise");
});

test("telemetry preserves exact cache/reasoning/cost usage and classifies rate/auth errors", () => {
  assert.deepEqual(openCodeAssistantUsage({
    role: "assistant",
    tokens: { input: 11, output: 7, reasoning: 5, total: 31, cache: { read: 6, write: 2 } },
    cost: 0.0125,
  }), {
    type: "usage",
    ts: 0,
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 31,
    cacheReadTokens: 6,
    cacheWriteTokens: 2,
    reasoningTokens: 5,
    cost: 0.0125,
  });
  assert.deepEqual(openCodeErrorToRunnerEvent({
    name: "APIError",
    data: { message: "Too many requests", statusCode: 429, responseHeaders: { "retry-after": "42" } },
  }), { type: "exhausted", ts: 0, resetHint: "retry-after 42" });
  const auth = openCodeErrorToRunnerEvent({ name: "ProviderAuthError", data: { providerID: "zai", message: "token expired" } });
  assert.equal(auth.type, "auth_expired");
  assert.match(auth.type === "auth_expired" ? auth.detail ?? "" : "", /token expired/);
  assert.deepEqual(openCodeErrorToRunnerEvent({ name: "UnknownError", data: { message: "boom" } }), {
    type: "error", ts: 0, message: "UnknownError: boom",
  });
});

test("permission/question conversion retains every question, option description, and multi-select flag", () => {
  const permission = openCodePermissionNeedsInput({
    id: "per_1", sessionID: "ses_1", permission: "bash", patterns: ["npm test"], metadata: {}, always: ["npm *"],
  });
  assert.equal(permission?.type, "needs_input");
  assert.deepEqual(permission?.type === "needs_input" ? permission.options : [], ["once", "always", "reject"]);
  const oneShot = openCodePermissionNeedsInput({
    id: "per_2", sessionID: "ses_1", permission: "bash", patterns: ["rm file"], metadata: {}, always: [],
  });
  assert.deepEqual(oneShot?.type === "needs_input" ? oneShot.options : [], ["once", "reject"]);

  const question = openCodeQuestionNeedsInput({
    id: "que_1",
    sessionID: "ses_1",
    questions: [
      { header: "Scope", question: "Which packages?", multiple: true, options: [
        { label: "core", description: "Core package" },
        { label: "cli", description: "CLI package" },
      ] },
      { header: "Mode", question: "Which mode?", options: [{ label: "safe", description: "No writes" }] },
    ],
  });
  assert.equal(question?.type, "needs_input");
  if (question?.type !== "needs_input") throw new Error("expected needs_input");
  assert.equal(question.questions?.length, 2);
  assert.equal(question.questions?.[0]?.multiSelect, true);
  assert.equal(question.questions?.[0]?.options?.[1]?.description, "CLI package");
});

test("startup uses random Basic auth, subscribes before prompt, filters sessions, and strictly queues turns", async () => {
  const rig = await startRig({ args: ["--model", "zai-coding-plan/glm-5", "--variant", "high"] });
  try {
    const initial = await rig.state();
    assert.equal(initial.passwordConfigured, true);
    assert.equal(initial.username, "opencode");
    assert.equal(initial.healthUnauthorizedAttempts, 0);
    assert.ok(initial.requests.every((request) => request.authorized));

    await rig.session.send("first");
    await waitFor(async () => promptRequests(await rig.state()).length === 1, "first prompt");
    await rig.session.send("second");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal(promptRequests(await rig.state()).length, 1, "active turn holds the second prompt");

    await rig.emit({
      type: "message.updated",
      properties: { sessionID: "ses_other", info: { id: "msg_other", sessionID: "ses_other", role: "assistant" } },
    });
    await rig.emit({
      type: "message.part.updated",
      properties: { sessionID: "ses_other", part: { id: "prt_other", messageID: "msg_other", sessionID: "ses_other", type: "text", text: "leak" } },
    });
    await rig.emit({
      type: "message.updated",
      properties: { sessionID: rig.session.sessionId, info: { id: "msg_1", sessionID: rig.session.sessionId, role: "assistant" } },
    });
    await rig.emit({
      type: "message.part.updated",
      properties: { sessionID: rig.session.sessionId, part: { id: "prt_1", messageID: "msg_1", sessionID: rig.session.sessionId, type: "text", text: "" } },
    });
    await rig.emit({
      type: "message.part.delta",
      properties: { sessionID: rig.session.sessionId, messageID: "msg_1", partID: "prt_1", field: "text", delta: "hello" },
    });
    await waitFor(() => rig.session.snapshot() === "hello\n", "assistant text delta");
    assert.equal(rig.session.snapshot().includes("leak"), false);

    // OpenCode publishes both events in this order. The status event must not
    // close the newly released queued turn when session.idle follows it.
    await rig.emit({ type: "session.status", properties: { sessionID: rig.session.sessionId, status: { type: "idle" } } });
    await rig.emit({ type: "session.idle", properties: { sessionID: rig.session.sessionId } });
    await waitFor(async () => promptRequests(await rig.state()).length === 2, "queued second prompt");
    const state = await rig.state();
    assert.equal(state.promptBeforeSubscription, false);
    const prompts = promptRequests(state);
    assert.ok(prompts.every((request) => (request.subscriptionCount ?? 0) > 0));
    assert.deepEqual(prompts[0]?.body, {
      parts: [{ type: "text", text: "first" }],
      model: { providerID: "zai-coding-plan", modelID: "glm-5" },
      variant: "high",
    });
    assert.equal(rig.events.filter((event) => event.type === "turn_start").length, 2);
    assert.equal(rig.events.filter((event) => event.type === "turn_end").length, 1);
  } finally {
    await rig.cleanup();
  }
});

test("next-tool steering waits for a real tool boundary and tool/usage updates stay exact", async () => {
  const rig = await startRig();
  try {
    await rig.session.send("work");
    await waitFor(async () => promptRequests(await rig.state()).length === 1, "work prompt");
    await rig.session.send("steer at tool", { mode: "next-tool" });
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    assert.equal(promptRequests(await rig.state()).length, 1);

    await rig.emit({
      type: "message.updated",
      properties: { sessionID: rig.session.sessionId, info: { id: "msg_tool", sessionID: rig.session.sessionId, role: "assistant" } },
    });
    const toolBase = {
      id: "prt_tool", callID: "call_1", messageID: "msg_tool", sessionID: rig.session.sessionId, type: "tool", tool: "bash",
    };
    await rig.emit({ type: "message.part.updated", properties: {
      sessionID: rig.session.sessionId,
      part: { ...toolBase, state: { status: "pending", input: { command: "npm test" }, raw: "" } },
    } });
    await waitFor(async () => promptRequests(await rig.state()).length === 2, "next-tool prompt");
    await rig.emit({ type: "message.part.updated", properties: {
      sessionID: rig.session.sessionId,
      part: { ...toolBase, state: { status: "running", input: { command: "npm test" }, time: { start: 1 } } },
    } });
    await rig.emit({ type: "message.part.updated", properties: {
      sessionID: rig.session.sessionId,
      part: { ...toolBase, state: { status: "completed", input: { command: "npm test" }, output: "ok", title: "test", metadata: {}, time: { start: 1, end: 2 } } },
    } });
    await rig.emit({ type: "message.part.updated", properties: {
      sessionID: rig.session.sessionId,
      part: { id: "prt_reason", messageID: "msg_tool", sessionID: rig.session.sessionId, type: "reasoning", text: "" },
    } });
    await rig.emit({ type: "message.part.delta", properties: {
      sessionID: rig.session.sessionId, messageID: "msg_tool", partID: "prt_reason", field: "text", delta: "checking",
    } });
    await rig.emit({ type: "message.updated", properties: {
      sessionID: rig.session.sessionId,
      info: {
        id: "msg_tool", sessionID: rig.session.sessionId, role: "assistant", time: { created: 1, completed: 2 },
        tokens: { input: 10, output: 4, reasoning: 3, total: 22, cache: { read: 4, write: 1 } }, cost: 0.002,
      },
    } });
    await waitFor(() => rig.events.some((event) => event.type === "usage"), "usage event");
    assert.equal(rig.events.filter((event) => event.type === "tool_use").length, 1);
    assert.deepEqual(
      rig.events.filter((event): event is Extract<RunnerEvent, { type: "tool_update" }> => event.type === "tool_update").map((event) => event.status),
      ["running", "completed"],
    );
    assert.deepEqual(rig.events.find((event) => event.type === "reasoning"), {
      type: "reasoning", ts: (rig.events.find((event) => event.type === "reasoning") as { ts: number }).ts, text: "checking",
    });
    assert.deepEqual(rig.events.find((event) => event.type === "usage"), {
      type: "usage", ts: (rig.events.find((event) => event.type === "usage") as { ts: number }).ts,
      inputTokens: 10, outputTokens: 4, totalTokens: 22, cacheReadTokens: 4, cacheWriteTokens: 1,
      reasoningTokens: 3, cost: 0.002,
    });
  } finally {
    await rig.cleanup();
  }
});

test("permissions and native string[][] questions round-trip without flattening", async () => {
  const rig = await startRig();
  try {
    await rig.emit({ type: "permission.asked", properties: {
      id: "per_1", sessionID: rig.session.sessionId, permission: "bash", patterns: ["npm test"], metadata: {}, always: ["npm *"],
    } });
    await waitFor(() => rig.events.some((event) => event.type === "needs_input" && event.requestId === "per_1"), "permission input");
    await rig.session.answer("per_1", "yes");
    await waitFor(async () => (await rig.state()).requests.some((request) => request.path === "/permission/per_1/reply"), "permission reply");
    const permissionRequest = (await rig.state()).requests.find((request) => request.path === "/permission/per_1/reply");
    assert.deepEqual(permissionRequest?.body, { reply: "once" });

    await rig.emit({ type: "permission.asked", properties: {
      id: "per_2", sessionID: rig.session.sessionId, permission: "edit", patterns: ["src/**"], metadata: {}, always: ["src/**"],
    } });
    await waitFor(() => rig.events.some((event) => event.type === "needs_input" && event.requestId === "per_2"), "persistent permission input");
    await rig.session.answer("per_2", "always");
    await waitFor(async () => (await rig.state()).requests.some((request) => request.path === "/permission/per_2/reply"), "persistent permission reply");
    assert.deepEqual(
      (await rig.state()).requests.find((request) => request.path === "/permission/per_2/reply")?.body,
      { reply: "always" },
    );

    await rig.emit({ type: "permission.asked", properties: {
      id: "per_3", sessionID: rig.session.sessionId, permission: "bash", patterns: ["rm file"], metadata: {}, always: [],
    } });
    await waitFor(() => rig.events.some((event) => event.type === "needs_input" && event.requestId === "per_3"), "rejected permission input");
    await rig.session.answer("per_3", "reject");
    await waitFor(async () => (await rig.state()).requests.some((request) => request.path === "/permission/per_3/reply"), "rejected permission reply");
    assert.deepEqual(
      (await rig.state()).requests.find((request) => request.path === "/permission/per_3/reply")?.body,
      { reply: "reject" },
    );

    await rig.emit({ type: "question.asked", properties: {
      id: "que_1", sessionID: rig.session.sessionId,
      questions: [
        { header: "Scope", question: "Which packages?", multiple: true, options: [
          { label: "core", description: "Core" }, { label: "cli", description: "CLI" },
        ] },
        { header: "Mode", question: "Mode?", options: [{ label: "safe", description: "Safe" }] },
      ],
      tool: { messageID: "msg_1", callID: "call_q" },
    } });
    await waitFor(() => rig.events.some((event) => event.type === "needs_input" && event.requestId === "que_1"), "question input");
    await rig.session.answer("que_1", [["core", "cli"], ["safe"]]);
    await waitFor(async () => (await rig.state()).requests.some((request) => request.path === "/question/que_1/reply"), "question reply");
    const questionRequest = (await rig.state()).requests.find((request) => request.path === "/question/que_1/reply");
    assert.deepEqual(questionRequest?.body, { answers: [["core", "cli"], ["safe"]] });

    await rig.emit({ type: "question.asked", properties: {
      id: "que_2", sessionID: rig.session.sessionId,
      questions: [{ header: "Stop", question: "Continue?", options: [{ label: "yes", description: "Continue" }] }],
    } });
    await waitFor(() => rig.events.some((event) => event.type === "needs_input" && event.requestId === "que_2"), "rejectable question");
    await rig.session.answer("que_2", "reject");
    await waitFor(async () => (await rig.state()).requests.some((request) => request.path === "/question/que_2/reject"), "question rejection");
  } finally {
    await rig.cleanup();
  }
});

test("SSE reconnect backfills missing text/usage/idle and pending questions exactly once", async () => {
  const rig = await startRig();
  try {
    await rig.session.send("reconnect");
    await waitFor(async () => promptRequests(await rig.state()).length === 1, "reconnect prompt");
    await rig.emit({ type: "message.updated", properties: {
      sessionID: rig.session.sessionId,
      info: { id: "msg_reconnect", sessionID: rig.session.sessionId, role: "assistant", time: { created: 1 } },
    } });
    await rig.emit({ type: "message.part.updated", properties: {
      sessionID: rig.session.sessionId,
      part: { id: "prt_reconnect", messageID: "msg_reconnect", sessionID: rig.session.sessionId, type: "text", text: "" },
    } });
    await rig.emit({ type: "message.part.delta", properties: {
      sessionID: rig.session.sessionId, messageID: "msg_reconnect", partID: "prt_reconnect", field: "text", delta: "hello ",
    } });
    await waitFor(() => rig.session.snapshot() === "hello \n", "pre-disconnect text");

    const completedInfo = {
      id: "msg_reconnect", sessionID: rig.session.sessionId, role: "assistant", time: { created: 1, completed: 2 },
      tokens: { input: 5, output: 2, reasoning: 1, total: 10, cache: { read: 2, write: 0 } }, cost: 0.001,
    };
    await rig.set({
      messages: [{
        info: completedInfo,
        parts: [{ id: "prt_reconnect", messageID: "msg_reconnect", sessionID: rig.session.sessionId, type: "text", text: "hello world", time: { start: 1, end: 2 } }],
      }],
      status: {},
      questions: [{
        id: "que_reconnect", sessionID: rig.session.sessionId,
        questions: [{ header: "Resume", question: "Continue?", options: [{ label: "yes", description: "Continue" }] }],
      }],
    });
    await rig.disconnect();
    await waitFor(() => rig.session.snapshot() === "hello \nworld\n", "reconnected text backfill");
    await waitFor(() => rig.events.some((event) => event.type === "turn_end"), "reconnected idle");
    await waitFor(() => rig.events.some((event) => event.type === "needs_input" && event.requestId === "que_reconnect"), "reconnected question");
    assert.equal(rig.events.filter((event) => event.type === "usage").length, 1);
    assert.equal(rig.events.filter((event) => event.type === "text").map((event) => event.type === "text" ? event.text : "").join(""), "hello world");
    assert.ok((await rig.state()).requests.filter((request) => request.path === "/event").length >= 2);
  } finally {
    await rig.cleanup();
  }
});

test("provider session errors and retry statuses become actionable error, exhausted, and auth states", async () => {
  const rig = await startRig();
  try {
    await rig.emit({ type: "session.error", properties: {
      sessionID: rig.session.sessionId,
      error: { name: "APIError", data: { message: "Too many requests", statusCode: 429, responseHeaders: { "retry-after": "30" } } },
    } });
    await rig.emit({ type: "session.error", properties: {
      sessionID: rig.session.sessionId,
      error: { name: "ProviderAuthError", data: { message: "API token expired", providerID: "zai-coding-plan" } },
    } });
    await rig.emit({ type: "session.error", properties: {
      sessionID: rig.session.sessionId,
      error: { name: "UnknownError", data: { message: "provider exploded" } },
    } });
    await rig.emit({ type: "session.status", properties: {
      sessionID: rig.session.sessionId,
      status: { type: "retry", attempt: 2, message: "Rate limit reached; try again in 10 seconds", next: Date.now() + 10_000 },
    } });
    await waitFor(
      () => rig.events.filter((event) => event.type === "exhausted").length === 2 &&
        rig.events.some((event) => event.type === "auth_expired") &&
        rig.events.some((event) => event.type === "error" && event.message.includes("provider exploded")),
      "provider state classification",
    );
    assert.ok(rig.events.some((event) => event.type === "exhausted" && event.resetHint === "retry-after 30"));
    assert.ok(rig.events.some((event) => event.type === "auth_expired" && event.detail?.includes("API token expired")));
  } finally {
    await rig.cleanup();
  }
});

test("resume validates cwd/ownership, claims an unowned session, and aborts through REST", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-opencode-resume-cwd-"));
  const sessionId = "ses_resume";
  const rig = await startRig({
    cwd: root,
    resume: true,
    sessionId,
    env: { FAKE_OPENCODE_RESUME_ID: sessionId, FAKE_OPENCODE_RESUME_DIR: root },
  });
  try {
    assert.equal(rig.session.sessionId, sessionId);
    const patch = (await rig.state()).requests.find((request) => request.method === "PATCH" && request.path === `/session/${sessionId}`);
    const metadata = (patch?.body as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    assert.equal(typeof (metadata?.honeybee as { bee?: unknown } | undefined)?.bee, "string");
    await rig.session.send("abort me");
    await waitFor(async () => promptRequests(await rig.state()).length === 1, "abort prompt");
    await rig.session.interrupt();
    await waitFor(async () => (await rig.state()).requests.some((request) => request.path === `/session/${sessionId}/abort`), "abort endpoint");
    await waitFor(() => rig.events.some((event) => event.type === "turn_end"), "abort idle event");
  } finally {
    await rig.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("resume refuses a session owned by another bee and startup rejects bad Basic auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-opencode-resume-reject-"));
  const previousStore = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = join(root, "store");
  const base: RunnerOpts = {
    bee: "OP.owner",
    cwd: root,
    env: envRecord({
      FAKE_OPENCODE_URL_FILE: join(root, "owner-url.json"),
      FAKE_OPENCODE_RESUME_ID: "ses_owned",
      FAKE_OPENCODE_RESUME_DIR: root,
      FAKE_OPENCODE_RESUME_METADATA: JSON.stringify({ honeybee: { bee: "OP.someone-else", cwd: root } }),
    }),
    runDir: join(root, "run"),
    command: process.execPath,
    args: [fixture],
    resume: true,
    sessionId: "ses_owned",
  };
  try {
    await assert.rejects(
      () => startOpenCodeRunner(base, { startupTimeoutMs: 1_500, requestTimeoutMs: 1_500 }),
      /owned by bee OP\.someone-else/,
    );
    await assert.rejects(
      () => startOpenCodeRunner({
        ...base,
        bee: "OP.auth",
        resume: false,
        sessionId: undefined,
        env: { ...base.env, FAKE_OPENCODE_URL_FILE: join(root, "auth-url.json"), FAKE_OPENCODE_FORCE_401: "1" },
      }, { startupTimeoutMs: 1_500, requestTimeoutMs: 1_500 }),
      /health failed.*HTTP 401/,
    );
  } finally {
    if (previousStore === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previousStore;
    await rm(root, { recursive: true, force: true });
  }
});

test("stop is idempotent and terminates the whole OpenCode process group", async () => {
  const rig = await startRig({ env: { FAKE_OPENCODE_SPAWN_DESCENDANT: "1" } });
  const descendantPid = (await rig.state()).descendantPid;
  assert.equal(typeof descendantPid, "number");
  await rig.session.stop();
  await rig.session.stop();
  await waitFor(async () => {
    try {
      await readFile(rig.stopFile, "utf8");
      return true;
    } catch {
      return false;
    }
  }, "fixture SIGTERM marker");
  await waitFor(() => {
    try {
      process.kill(descendantPid!, 0);
      return false;
    } catch {
      return true;
    }
  }, "descendant process exit");
  await rig.cleanup();
});
