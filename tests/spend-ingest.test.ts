import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractClaudeEvents, extractCodexEvents, type RowWithOffset } from "../src/spend/extract.js";
import { ingest } from "../src/spend/ingest.js";
import { readAllEvents } from "../src/spend/ledger.js";
import type { Seat, SpendEvent } from "../src/spend/types.js";
import type { TranscriptRow } from "../src/transcripts/types.js";

// ── Real-shaped fixtures (copied verbatim from SPEND_SPEC verified formats) ──

// Claude assistant row WITH the ephemeral 5m/1h cache-write split.
const claudeSplitRow = {
  requestId: "req_001",
  uuid: "uuid-001",
  timestamp: "2026-07-03T10:00:00Z",
  session_id: "sess-a",
  sessionId: "sess-a",
  isSidechain: false,
  type: "assistant",
  message: {
    model: "claude-opus-4-8",
    id: "msg_001",
    role: "assistant",
    content: [
      { type: "text", text: "hi" },
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ],
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 9722,
      cache_read_input_tokens: 19962,
      output_tokens: 242,
      cache_creation: { ephemeral_1h_input_tokens: 9722, ephemeral_5m_input_tokens: 0 },
    },
  },
};

// Subagent (isSidechain) row with NO cache_creation object → folds into 5m.
const claudeSubagentRow = {
  requestId: "req_002",
  uuid: "uuid-002",
  timestamp: "2026-07-03T10:05:00Z",
  session_id: "sess-a",
  sessionId: "sess-a",
  isSidechain: true,
  type: "assistant",
  message: {
    model: "claude-haiku-4-5",
    id: "msg_002",
    role: "assistant",
    content: [{ type: "text", text: "sub" }],
    usage: {
      input_tokens: 5,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 0,
      output_tokens: 20,
    },
  },
};

function codexLines(): string {
  const rows = [
    { timestamp: "2026-07-03T09:00:00Z", type: "session_meta", payload: { id: "sess-codex", cwd: "/x", model_provider: "openai" } },
    { timestamp: "2026-07-03T09:00:01Z", type: "turn_context", payload: { model: "gpt-5.4" } },
    // rate-limit-only token_count (info:null) must be ignored.
    { timestamp: "2026-07-03T09:00:02Z", type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 8 }, plan_type: "pro" } } },
    { timestamp: "2026-07-03T09:01:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 } } } },
    { timestamp: "2026-07-03T09:02:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 3000, cached_input_tokens: 900, output_tokens: 120, reasoning_output_tokens: 30, total_tokens: 3120 } } } },
  ];
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function claudeLines(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-spend-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Fixture = { dir: string; seats: Seat[]; eventsFile: string; stateFile: string; claudeFile: string; codexFile: string };

async function scaffold(dir: string): Promise<Fixture> {
  const claudeCfg = join(dir, "dotclaude");
  const codexCfg = join(dir, "dotcodex");
  const claudeFile = join(claudeCfg, "projects", "proj-key", "sess-a.jsonl");
  const codexFile = join(codexCfg, "sessions", "2026", "07", "03", "rollout-x.jsonl");
  await mkdir(join(claudeCfg, "projects", "proj-key"), { recursive: true });
  await mkdir(join(codexCfg, "sessions", "2026", "07", "03"), { recursive: true });
  await writeFile(claudeFile, claudeLines([claudeSplitRow, claudeSubagentRow]));
  await writeFile(codexFile, codexLines());
  return {
    dir,
    seats: [
      { id: "claude:default", harness: "claude", configDir: claudeCfg },
      { id: "codex:default", harness: "codex", configDir: codexCfg },
    ],
    eventsFile: join(dir, "events.jsonl"),
    stateFile: join(dir, "ingest-state.json"),
    claudeFile,
    codexFile,
  };
}

const rowsWithOffsets = (rows: unknown[]): RowWithOffset[] =>
  rows.map((row, offset) => ({ row: row as TranscriptRow, offset }));

const seat = (id: string, harness: "claude" | "codex"): Seat => ({ id, harness, configDir: "/n/a" });

// ── Unit: extractors map tiers / deltas exactly ──

test("extractClaudeEvents maps all five tiers, the 5m/1h split, and isSubagent", () => {
  const events = extractClaudeEvents(rowsWithOffsets([claudeSplitRow, claudeSubagentRow]), "/tr/claude.jsonl", seat("claude:default", "claude"));
  assert.equal(events.length, 2);

  const [primary, sub] = events;
  assert.equal(primary!.id, "claude:req_001");
  assert.equal(primary!.model, "claude-opus-4-8");
  assert.equal(primary!.isSubagent, false);
  assert.equal(primary!.sessionId, "sess-a");
  assert.equal(primary!.toolUseCount, 1);
  assert.equal(primary!.sourceOffset, 0);
  assert.deepEqual(primary!.tokens, {
    input: 10,
    output: 242,
    cacheRead: 19962,
    cacheWrite5m: 0,
    cacheWrite1h: 9722,
  });

  // No cache_creation object → whole cache write folds into the 5m tier.
  assert.equal(sub!.id, "claude:req_002");
  assert.equal(sub!.isSubagent, true);
  assert.equal(sub!.toolUseCount, 0);
  assert.equal(sub!.sourceOffset, 1);
  assert.deepEqual(sub!.tokens, { input: 5, output: 20, cacheRead: 0, cacheWrite5m: 100, cacheWrite1h: 0 });
});

test("extractCodexEvents derives per-turn deltas from cumulative token_count totals", () => {
  const rows = codexLines().trim().split("\n").map((line) => JSON.parse(line));
  const events = extractCodexEvents(rowsWithOffsets(rows), "/tr/rollout-x.jsonl", seat("codex:default", "codex"));
  // The info:null row is skipped; two cumulative rows → two turn deltas.
  assert.equal(events.length, 2);

  assert.equal(events[0]!.id, "codex:sess-codex:0");
  assert.equal(events[0]!.model, "gpt-5.4");
  assert.equal(events[0]!.sessionId, "sess-codex");
  // input_tokens is total (cached included) → input = 1000-200, cacheRead = 200.
  assert.deepEqual(events[0]!.tokens, { input: 800, output: 50, cacheRead: 200, cacheWrite5m: 0, cacheWrite1h: 0 });

  assert.equal(events[1]!.id, "codex:sess-codex:1");
  // delta: input 2000, cached 700, output 70 → input = 1300, cacheRead = 700.
  assert.deepEqual(events[1]!.tokens, { input: 1300, output: 70, cacheRead: 700, cacheWrite5m: 0, cacheWrite1h: 0 });
});

// ── Integration: ingest, idempotence, incremental ──

test("ingest writes the full ledger, then a re-ingest appends nothing (idempotent)", async () => {
  await withTempDir(async (dir) => {
    const fx = await scaffold(dir);

    const first = await ingest({ seats: fx.seats, eventsFile: fx.eventsFile, stateFile: fx.stateFile });
    assert.equal(first.filesScanned, 2);
    assert.equal(first.eventsAppended, 4); // 2 claude + 2 codex
    assert.equal(first.duplicatesSkipped, 0);

    const ledger1 = await readAllEvents(fx.eventsFile);
    assert.equal(ledger1.length, 4);
    const ids = new Set(ledger1.map((event: SpendEvent) => event.id));
    assert.ok(ids.has("claude:req_001"));
    assert.ok(ids.has("claude:req_002"));
    assert.ok(ids.has("codex:sess-codex:0"));
    assert.ok(ids.has("codex:sess-codex:1"));

    // unknownModels: no knownModel predicate → every distinct model surfaced.
    assert.deepEqual([...new Set(first.unknownModels)].sort(), ["claude-haiku-4-5", "claude-opus-4-8", "gpt-5.4"]);

    // Full re-ingest re-extracts every row and dedups against the ledger.
    const second = await ingest({ seats: fx.seats, eventsFile: fx.eventsFile, stateFile: fx.stateFile, full: true });
    assert.equal(second.eventsAppended, 0);
    assert.ok(second.duplicatesSkipped > 0, "re-ingest must observe the events and skip them as duplicates");
    assert.equal(second.duplicatesSkipped, 4);

    const ledger2 = await readAllEvents(fx.eventsFile);
    assert.equal(ledger2.length, 4, "ledger length must be unchanged after a re-ingest");
  });
});

test("ingest is incremental: a newly appended transcript line yields exactly one new event", async () => {
  await withTempDir(async (dir) => {
    const fx = await scaffold(dir);
    await ingest({ seats: fx.seats, eventsFile: fx.eventsFile, stateFile: fx.stateFile });
    assert.equal((await readAllEvents(fx.eventsFile)).length, 4);

    // Append a brand-new assistant row to the claude transcript and bump mtime
    // so the mtime fast-path re-reads the grown file.
    const newRow = {
      ...claudeSplitRow,
      requestId: "req_003",
      uuid: "uuid-003",
      timestamp: "2026-07-03T11:00:00Z",
      message: { ...claudeSplitRow.message, id: "msg_003" },
    };
    await writeFile(fx.claudeFile, `${JSON.stringify(newRow)}\n`, { flag: "a" });
    const future = new Date(Date.now() + 5000);
    await utimes(fx.claudeFile, future, future);

    const result = await ingest({ seats: fx.seats, eventsFile: fx.eventsFile, stateFile: fx.stateFile });
    assert.equal(result.eventsAppended, 1);
    assert.ok(result.duplicatesSkipped >= 2, "the two prior claude rows are re-seen and skipped");

    const ledger = await readAllEvents(fx.eventsFile);
    assert.equal(ledger.length, 5);
    assert.ok(ledger.some((event: SpendEvent) => event.id === "claude:req_003"));
  });
});

test("ingest honors `since`, dropping events strictly before the cutoff", async () => {
  await withTempDir(async (dir) => {
    const fx = await scaffold(dir);
    // Cutoff between the two codex turns (09:01 vs 09:02): codex turn 0 is
    // dropped; codex turn 1 and both later claude rows survive.
    const cutoff = "2026-07-03T09:01:30Z";
    const result = await ingest({ seats: fx.seats, eventsFile: fx.eventsFile, stateFile: fx.stateFile, since: cutoff });
    assert.equal(result.eventsAppended, 3);

    const ledger = await readAllEvents(fx.eventsFile);
    const ids = ledger.map((event: SpendEvent) => event.id).sort();
    assert.deepEqual(ids, ["claude:req_001", "claude:req_002", "codex:sess-codex:1"]);
    assert.ok(ledger.every((event: SpendEvent) => Date.parse(event.ts) >= Date.parse(cutoff)));
  });
});
