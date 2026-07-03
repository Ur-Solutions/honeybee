import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createUsageSampler } from "../src/daemon/usageSampler.js";
import { exhaustionForAgent } from "../src/drivers.js";
import type { SessionRecord } from "../src/store.js";
import {
  appendUsageEvent,
  isRecentlyExhausted,
  readUsageEvents,
  transcriptTokenTotals,
  usageSummary,
  type UsageEvent,
} from "../src/usage.js";

async function withTempStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const oldRoot = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-usage-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    return await fn(dir);
  } finally {
    if (oldRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = oldRoot;
    await rm(dir, { recursive: true, force: true });
  }
}

test("usage events append and read back; summary computes window deltas", async () => {
  await withTempStore(async () => {
    const now = Date.parse("2026-06-10T12:00:00.000Z");
    const sample = (ts: string, input: number, output: number): UsageEvent => ({
      ts,
      kind: "sample",
      account: "acct",
      bee: "CL.a",
      agent: "claude",
      inputTokens: input,
      outputTokens: output,
    });

    await appendUsageEvent(sample("2026-06-10T10:00:00.000Z", 100, 10));
    await appendUsageEvent(sample("2026-06-10T11:00:00.000Z", 300, 40));
    await appendUsageEvent({ ts: "2026-06-10T11:30:00.000Z", kind: "exhausted", account: "acct", bee: "CL.a", agent: "claude", resetHint: "resets at 7pm" });

    assert.equal((await readUsageEvents("acct")).length, 3);

    const summary = await usageSummary("acct", now);
    assert.equal(summary.sampleCount, 2);
    // First sample seeds the window; second contributes the cumulative delta.
    assert.equal(summary.windowInputTokens, 300);
    assert.equal(summary.windowOutputTokens, 40);
    assert.equal(summary.lastExhaustedAt, "2026-06-10T11:30:00.000Z");
    assert.equal(summary.lastResetHint, "resets at 7pm");
    assert.equal(isRecentlyExhausted(summary, now), true);
    assert.equal(isRecentlyExhausted(summary, now + 6 * 60 * 60 * 1000), false);
  });
});

test("transcriptTokenTotals sums claude usage and reads codex token_count", () => {
  const claude = transcriptTokenTotals("claude", [
    { type: "assistant", message: { role: "assistant", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 } } } as never,
    { type: "assistant", message: { role: "assistant", usage: { input_tokens: 20, output_tokens: 7 } } } as never,
    { type: "user", message: { role: "user", content: "hi" } },
  ]);
  assert.deepEqual(claude, { inputTokens: 120, outputTokens: 12 });

  const codex = transcriptTokenTotals("codex", [
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 100, output_tokens: 9 } } } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 80, cached_input_tokens: 200, output_tokens: 21 } } } },
  ]);
  assert.deepEqual(codex, { inputTokens: 280, outputTokens: 21 });

  assert.equal(transcriptTokenTotals("opencode", []), null);
  assert.equal(transcriptTokenTotals("claude", [{ type: "user" }]), null);
});

test("driver exhaustion matchers detect provider limit messages with reset hints", () => {
  const claudeHit = exhaustionForAgent("claude", "❯ ...\nClaude usage limit reached. Your limit will reset at 7pm (Europe/Oslo).");
  assert.ok(claudeHit);
  assert.match(claudeHit!.resetHint ?? "", /reset at 7pm/);

  const codexHit = exhaustionForAgent("codex", "You've hit your usage limit. Try again in 2 hours 13 minutes.");
  assert.ok(codexHit);
  assert.match(codexHit!.resetHint ?? "", /Try again in 2 hours/i);

  assert.equal(exhaustionForAgent("claude", "❯ all good here"), null);
  assert.equal(exhaustionForAgent("pi", "rate limit reached"), null);
});

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "CL.a",
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: "CL-a",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    status: "running",
    accountId: "acct",
    ...overrides,
  };
}

test("usage sampler emits exhaustion on the rising edge only and samples token deltas", async () => {
  await withTempStore(async () => {
    const events: UsageEvent[] = [];
    const ledger: Record<string, unknown>[] = [];
    let totals = { input_tokens: 100, output_tokens: 10 };
    const sampler = createUsageSampler({
      appendUsageEvent: async (event) => {
        events.push(event);
      },
      appendLedger: async (event) => {
        ledger.push(event);
      },
      readTranscriptRows: async () => ({
        provider: "claude",
        rows: [{ type: "assistant", message: { role: "assistant", usage: totals } } as never],
      }),
      sampleIntervalMs: 0,
    });

    const records = [record(), record({ name: "no-account", tmuxTarget: "x", accountId: undefined })];
    const exhaustedPane = "Claude usage limit reached. Your limit will reset at 7pm.";

    const first = await sampler(records, new Map([["CL-a", exhaustedPane]]), 1_000);
    assert.equal(first.length, 1); // account-less bees are ignored
    assert.equal(first[0]!.exhausted, true);
    assert.equal(first[0]!.sampled, true);
    assert.equal(ledger.filter((event) => event.type === "account.exhausted").length, 1);

    // Same pane next tick: no duplicate event, no duplicate sample (totals unchanged).
    const second = await sampler(records, new Map([["CL-a", exhaustedPane]]), 2_000);
    assert.equal(second[0]!.exhausted, false);
    assert.equal(second[0]!.sampled, false);

    // Unknown capture is not a factual recovery; it must not re-arm exhaustion.
    const unknown = await sampler(records, new Map<string, string | undefined>([["CL-a", undefined]]), 2_500);
    assert.equal(unknown.length, 0);

    const stillExhausted = await sampler(records, new Map([["CL-a", exhaustedPane]]), 2_750);
    assert.equal(stillExhausted[0]!.exhausted, false);

    // Recovered pane re-arms the edge detector; new totals append a sample.
    totals = { input_tokens: 250, output_tokens: 25 };
    const third = await sampler(records, new Map([["CL-a", "❯ ready"]]), 3_000);
    assert.equal(third[0]!.exhausted, false);
    assert.equal(third[0]!.sampled, true);

    const fourth = await sampler(records, new Map([["CL-a", exhaustedPane]]), 4_000);
    assert.equal(fourth[0]!.exhausted, true);

    const samples = events.filter((event) => event.kind === "sample");
    assert.deepEqual(samples.map((sample) => (sample.kind === "sample" ? sample.inputTokens : 0)), [100, 250]);
    assert.equal(events.filter((event) => event.kind === "exhausted").length, 2);
  });
});
