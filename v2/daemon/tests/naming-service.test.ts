import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ResolvedNamingConfig } from "../src/config.ts";
import { TitleGeneratorService } from "../src/namingService.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = join(HERE, "fixtures", "fake-naming-codex.mjs");

function config(overrides: Partial<ResolvedNamingConfig> = {}): ResolvedNamingConfig {
  return {
    auto: true,
    backend: "codex-app-server",
    tool: "codex",
    model: "gpt-5.6-luna",
    effort: "none",
    generatorCwd: tmpdir(),
    ...overrides,
  };
}

test("naming service keeps one Codex app-server warm and isolates titles in ephemeral threads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-naming-service-"));
  const logPath = join(dir, "rpc.jsonl");
  const previous = process.env.FAKE_NAMING_CODEX_LOG;
  process.env.FAKE_NAMING_CODEX_LOG = logPath;
  const service = new TitleGeneratorService({
    codexCommand: process.execPath,
    codexArgs: [FAKE_CODEX],
    timeoutMs: 5_000,
  });
  try {
    const generatorCwd = join(dir, "fresh-generator-cwd");
    assert.equal(await service.generate({ userMessages: ["Fix auto naming"] }, config({ generatorCwd })), "Warm Naming Service");
    assert.equal(await service.generate({ userMessages: ["Fix another title"] }, config({ generatorCwd })), "Warm Naming Service");
    assert.equal(existsSync(generatorCwd), true);
    const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call.method === "initialize").length, 1);
    const threads = calls.filter((call) => call.method === "thread/start");
    assert.equal(threads.length, 2);
    assert.ok(threads.every((call) => call.params.ephemeral === true));
    assert.ok(threads.every((call) => call.params.baseInstructions && call.params.developerInstructions));
    const turns = calls.filter((call) => call.method === "turn/start");
    assert.equal(turns.length, 2);
    assert.ok(turns.every((call) => call.params.effort === "none"));
  } finally {
    service.close();
    if (previous === undefined) delete process.env.FAKE_NAMING_CODEX_LOG;
    else process.env.FAKE_NAMING_CODEX_LOG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("naming service calls Responses API without exposing the configured key in output", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const service = new TitleGeneratorService({
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: "Direct Luna Naming" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const apiKey = "sk-test-write-only";
  try {
    const title = await service.generate(
      { userMessages: ["Name this through the API"] },
      config({ backend: "openai-api", apiKey }),
    );
    assert.equal(title, "Direct Luna Naming");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://api.openai.com/v1/responses");
    assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, `Bearer ${apiKey}`);
    const body = JSON.parse(String(requests[0]?.init?.body));
    assert.equal(body.model, "gpt-5.6-luna");
    assert.equal(body.reasoning.effort, "none");
    assert.equal(body.store, false);
    assert.doesNotMatch(JSON.stringify({ title }), /sk-test-write-only/);
  } finally {
    service.close();
  }
});

test("naming service restarts the warm app-server after an unexpected exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-naming-restart-"));
  const logPath = join(dir, "rpc.jsonl");
  const previousLog = process.env.FAKE_NAMING_CODEX_LOG;
  const previousExit = process.env.FAKE_NAMING_CODEX_EXIT_AFTER_TURN;
  process.env.FAKE_NAMING_CODEX_LOG = logPath;
  process.env.FAKE_NAMING_CODEX_EXIT_AFTER_TURN = "1";
  const service = new TitleGeneratorService({
    codexCommand: process.execPath,
    codexArgs: [FAKE_CODEX],
    timeoutMs: 5_000,
  });
  try {
    assert.equal(await service.generate({ userMessages: ["First title"] }, config()), "Warm Naming Service");
    await new Promise((resolve) => setTimeout(resolve, 30));
    delete process.env.FAKE_NAMING_CODEX_EXIT_AFTER_TURN;
    assert.equal(await service.generate({ userMessages: ["Second title"] }, config()), "Warm Naming Service");
    const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call.method === "initialize").length, 2);
  } finally {
    service.close();
    if (previousLog === undefined) delete process.env.FAKE_NAMING_CODEX_LOG;
    else process.env.FAKE_NAMING_CODEX_LOG = previousLog;
    if (previousExit === undefined) delete process.env.FAKE_NAMING_CODEX_EXIT_AFTER_TURN;
    else process.env.FAKE_NAMING_CODEX_EXIT_AFTER_TURN = previousExit;
    rmSync(dir, { recursive: true, force: true });
  }
});
