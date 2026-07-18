import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  findKimiWirePath,
  kimiErrorToRunnerEvent,
  parseKimiWireRecord,
  startKimiWireTelemetry,
} from "../src/hsr/adapters/kimiTelemetry.js";
import type { RunnerEvent } from "../src/hsr/types.js";

const usage = (inputOther: number, output: number) => JSON.stringify({
  type: "usage.record",
  model: "kimi-code/k3",
  usage: { inputOther, output, inputCacheRead: 20, inputCacheCreation: 3 },
  usageScope: "turn",
});

test("Kimi wire parser emits usage and structured failures but never transcript content", () => {
  assert.deepEqual(parseKimiWireRecord(usage(7, 5)), [{
    type: "usage",
    ts: 0,
    inputTokens: 30,
    outputTokens: 5,
    totalTokens: 35,
  }]);
  assert.deepEqual(parseKimiWireRecord(JSON.stringify({ type: "context.append_message", message: { content: "do not duplicate" } })), []);
  assert.deepEqual(parseKimiWireRecord(JSON.stringify({ type: "context.append_loop_event", event: { type: "content.part", text: "also ignored" } })), []);
  assert.equal(parseKimiWireRecord(JSON.stringify({ type: "turn.ended", error: { code: "auth.login_required", message: "Login required" } }))[0]?.type, "auth_expired");
  assert.deepEqual(parseKimiWireRecord("not-json"), []);

  assert.equal(kimiErrorToRunnerEvent({ code: "auth.login_required", message: "Login required" }).type, "auth_expired");
  const rate = kimiErrorToRunnerEvent({ code: "provider.rate_limit", message: "Rate limit reached; retry in 30s", statusCode: 429 });
  assert.equal(rate.type, "exhausted");
  if (rate.type === "exhausted") assert.match(rate.resetHint ?? "", /retry/i);
  assert.deepEqual(kimiErrorToRunnerEvent({ code: "provider.api_error", message: "upstream broke" }), {
    type: "error",
    ts: 0,
    message: "[provider.api_error] upstream broke",
  });
});

test("Kimi telemetry skips historical resume records and tails only appended records", async () => {
  const home = await mkdtemp(join(tmpdir(), "honeybee-kimi-wire-existing-"));
  const sessionId = "session_existing";
  const wire = join(home, "sessions", "cwd-bucket", sessionId, "agents", "main", "wire.jsonl");
  await mkdir(join(wire, ".."), { recursive: true });
  await writeFile(wire, `${usage(1, 1)}\n`, "utf8");
  const events: RunnerEvent[] = [];
  const tail = startKimiWireTelemetry({ home, sessionId, onEvent: (event) => events.push(event), pollMs: 60_000 });
  try {
    await tail.pollNow();
    assert.deepEqual(events, [], "existing usage is historical and must not replay on resume");
    await appendFile(wire, `${JSON.stringify({ type: "context.append_message", text: "ignored" })}\n${usage(9, 4)}\n`, "utf8");
    await tail.pollNow();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { type: "usage", ts: 0, inputTokens: 32, outputTokens: 4, totalTokens: 36 });
    assert.equal(await findKimiWirePath(home, sessionId), wire);
    assert.equal(await findKimiWirePath(home, "../escape"), undefined);
  } finally {
    await tail.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("Kimi telemetry reads a newly-created session wire from byte zero", async () => {
  const home = await mkdtemp(join(tmpdir(), "honeybee-kimi-wire-new-"));
  const sessionId = "session_new";
  const events: RunnerEvent[] = [];
  const tail = startKimiWireTelemetry({ home, sessionId, onEvent: (event) => events.push(event), pollMs: 60_000 });
  try {
    await tail.pollNow(); // establish that the file did not exist at startup
    const wire = join(home, "sessions", "cwd-bucket", sessionId, "agents", "main", "wire.jsonl");
    await mkdir(join(wire, ".."), { recursive: true });
    await writeFile(
      wire,
      `${usage(2, 3)}\n${JSON.stringify({ type: "turn.error", error: { code: "provider.rate_limit", message: "quota exceeded", statusCode: 429 } })}\n`,
      "utf8",
    );
    await tail.pollNow();
    assert.deepEqual(events.map((event) => event.type), ["usage", "exhausted"]);
  } finally {
    await tail.stop();
    await rm(home, { recursive: true, force: true });
  }
});
