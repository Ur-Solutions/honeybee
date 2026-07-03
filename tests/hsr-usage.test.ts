import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildClaudeStreamConfig } from "../src/hsr/adapters/claude.js";
import { codexNotificationToEvents } from "../src/hsr/adapters/codex.js";
import { ensureHsrRunDir, hsrEventsPath } from "../src/hsr/runDir.js";
import type { RunnerEvent, RunnerOpts } from "../src/hsr/types.js";
import { createUsageSampler } from "../src/daemon/usageSampler.js";
import type { HsrObservation } from "../src/hsr/observe.js";
import type { SessionRecord } from "../src/store.js";
import { readUsageEvents, type UsageEvent } from "../src/usage.js";

/** Point HIVE_STORE_ROOT at a fresh temp dir for the duration of `fn`. */
async function withTempStore<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp(join(tmpdir(), "honeybee-hsr-usage-"));
  process.env.HIVE_STORE_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write a bee's events.jsonl (one RunnerEvent per line) into its run dir. */
async function writeEvents(bee: string, events: RunnerEvent[]): Promise<void> {
  await ensureHsrRunDir(bee);
  await writeFile(hsrEventsPath(bee), events.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "CL.hsr",
    agent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: "CL-hsr",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    status: "running",
    accountId: "acct-hsr",
    substrate: "hsr",
    ...overrides,
  };
}

function optsFor(over: Partial<RunnerOpts> = {}): RunnerOpts {
  return { bee: "test", cwd: "/tmp", env: {}, runDir: "/tmp/run", ...over };
}

test("HSR sampler appends cumulative token totals from usage events", async () => {
  await withTempStore(async () => {
    // usage events carry PER-TURN counts → the cumulative is their sum.
    await writeEvents("CL.hsr", [
      { type: "turn_start", ts: 1 },
      { type: "usage", ts: 2, inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      { type: "turn_end", ts: 3 },
      { type: "usage", ts: 4, inputTokens: 50, outputTokens: 5, totalTokens: 55 },
    ]);

    const ledger: Record<string, unknown>[] = [];
    const sampler = createUsageSampler({ appendLedger: async (e) => void ledger.push(e), sampleIntervalMs: 0 });

    const out = await sampler([record()], new Map(), 1_000);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.sampled, true);
    assert.equal(out[0]!.exhausted, false);

    const samples = (await readUsageEvents("acct-hsr")).filter((e): e is Extract<UsageEvent, { kind: "sample" }> => e.kind === "sample");
    assert.equal(samples.length, 1);
    assert.equal(samples[0]!.inputTokens, 150);
    assert.equal(samples[0]!.outputTokens, 15);

    // A second tick with unchanged totals appends nothing new (dedupe).
    const again = await sampler([record()], new Map(), 2_000);
    assert.equal(again[0]!.sampled, false);
    assert.equal((await readUsageEvents("acct-hsr")).filter((e) => e.kind === "sample").length, 1);
  });
});

test("HSR sampler fires exhaustion on the rising edge of an exhausted event", async () => {
  await withTempStore(async () => {
    await writeEvents("CL.hsr", [
      { type: "turn_start", ts: 1 },
      { type: "exhausted", ts: 5_000, resetHint: "2026-07-03T14:00:00.000Z" },
    ]);

    const ledger: Record<string, unknown>[] = [];
    const sampler = createUsageSampler({ appendLedger: async (e) => void ledger.push(e), sampleIntervalMs: 0 });

    const first = await sampler([record()], new Map(), 1_000);
    assert.equal(first[0]!.exhausted, true);
    assert.equal(first[0]!.resetHint, "2026-07-03T14:00:00.000Z");
    assert.equal(ledger.filter((e) => e.type === "account.exhausted").length, 1);
    assert.equal((await readUsageEvents("acct-hsr")).filter((e) => e.kind === "exhausted").length, 1);

    // Same log next tick: the exhausted event persists but is NOT re-fired.
    const second = await sampler([record()], new Map(), 2_000);
    assert.equal(second[0]!.exhausted, false);
    assert.equal(ledger.filter((e) => e.type === "account.exhausted").length, 1);

    // A strictly-newer exhausted event re-arms the edge and fires again.
    await writeEvents("CL.hsr", [
      { type: "exhausted", ts: 5_000, resetHint: "2026-07-03T14:00:00.000Z" },
      { type: "exhausted", ts: 9_000, resetHint: "2026-07-03T19:00:00.000Z" },
    ]);
    const third = await sampler([record()], new Map(), 3_000);
    assert.equal(third[0]!.exhausted, true);
    assert.equal(third[0]!.resetHint, "2026-07-03T19:00:00.000Z");
    assert.equal(ledger.filter((e) => e.type === "account.exhausted").length, 2);
  });
});

test("HSR sampler uses the per-tick event snapshot when provided", async () => {
  await withTempStore(async () => {
    const ledger: Record<string, unknown>[] = [];
    const sampler = createUsageSampler({
      appendLedger: async (e) => void ledger.push(e),
      readHsrUsage: async () => {
        throw new Error("snapshot should avoid a second HSR event read");
      },
      sampleIntervalMs: 0,
    });
    const observation: HsrObservation = {
      live: true,
      state: "idle_with_output",
      snapshot: "",
      eventSnapshot: {
        events: [],
        tailEvents: [],
        usage: {
          totals: { inputTokens: 33, outputTokens: 7 },
          latestExhausted: { ts: 10, resetHint: "soon" },
        },
        pendingNeedsInput: null,
      },
    };

    const out = await sampler([record()], new Map(), 1_000, new Map([["CL.hsr", observation]]));

    assert.equal(out[0]!.sampled, true);
    assert.equal(out[0]!.exhausted, true);
    assert.equal(out[0]!.resetHint, "soon");
    assert.equal(ledger.filter((e) => e.type === "account.exhausted").length, 1);
    const samples = (await readUsageEvents("acct-hsr")).filter((e): e is Extract<UsageEvent, { kind: "sample" }> => e.kind === "sample");
    assert.deepEqual(samples.map((sample) => [sample.inputTokens, sample.outputTokens]), [[33, 7]]);
  });
});

test("claude parseLine maps rate_limit_event: [] when allowed, exhausted when rejected", () => {
  const { config } = buildClaudeStreamConfig(optsFor());

  // Real captured envelope (status "allowed") → benign, no event.
  const allowed = JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", resetsAt: 1783034400, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false },
    uuid: "f9dd531d",
    session_id: "816376d3",
  });
  assert.deepEqual(config.parseLine(allowed), []);

  // "allowed_warning" (approaching the cap) is also benign.
  const warning = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1783034400 } });
  assert.deepEqual(config.parseLine(warning), []);

  // A rejected status → one exhausted event carrying the ISO reset hint.
  const rejected = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1783034400, rateLimitType: "five_hour" } });
  const events = config.parseLine(rejected).map((e) => {
    const { ts: _ts, ...rest } = e as RunnerEvent & { ts: number };
    return rest;
  });
  assert.deepEqual(events, [{ type: "exhausted", resetHint: new Date(1783034400 * 1000).toISOString() }]);
});

test("codex account/rateLimits/updated maps to exhausted only when a limit is reached", () => {
  // Benign rolling update: rateLimitReachedType null → no event.
  const benign = codexNotificationToEvents("account/rateLimits/updated", {
    rateLimits: { limitId: "codex", primary: { usedPercent: 42, resetsAt: 1783034400 }, rateLimitReachedType: null },
  });
  assert.deepEqual(benign, []);

  // Reached → one exhausted event with the primary window's reset hint.
  const reached = codexNotificationToEvents("account/rateLimits/updated", {
    rateLimits: { limitId: "codex", primary: { usedPercent: 100, resetsAt: 1783034400 }, rateLimitReachedType: "rate_limit_reached" },
  });
  assert.deepEqual(reached, [{ type: "exhausted", ts: 0, resetHint: new Date(1783034400 * 1000).toISOString() }]);
});

test("non-HSR (tmux) records still exhaust from the pane, unchanged by the HSR branch", async () => {
  await withTempStore(async () => {
    const ledger: Record<string, unknown>[] = [];
    const sampler = createUsageSampler({
      appendLedger: async (e) => void ledger.push(e),
      // A tmux bee has no HSR events; guard that the HSR reader is never consulted.
      readHsrUsage: async () => {
        throw new Error("HSR reader must not run for a tmux record");
      },
      readTranscriptRows: async () => null,
      sampleIntervalMs: 0,
    });

    const tmux = record({ name: "CL.tmux", tmuxTarget: "CL-tmux", substrate: "local-tmux", accountId: "acct-tmux" });
    const pane = "Claude usage limit reached. Your limit will reset at 7pm.";
    const out = await sampler([tmux], new Map([["CL-tmux", pane]]), 1_000);
    assert.equal(out[0]!.exhausted, true);
    assert.match(out[0]!.resetHint ?? "", /reset at 7pm/);
    assert.equal(ledger.filter((e) => e.type === "account.exhausted").length, 1);
  });
});
