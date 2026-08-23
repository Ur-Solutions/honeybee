import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SCHEMA_VERSION } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

test("v14 naming usage keeps immutable priced and unpriced attempts with an all-time aggregate", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "named");
    const first = store.recordNamingUsage({
      beeId: bee.id,
      backend: "openai-api",
      provider: "openai",
      model: "gpt-5.6-luna",
      status: "succeeded",
      latencyMs: 980,
      inputTokens: 120,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      outputTokens: 6,
      reasoningTokens: 0,
      totalTokens: 126,
      inputRateNanoUsd: 200,
      cachedInputRateNanoUsd: 20,
      cacheWriteRateNanoUsd: 250,
      outputRateNanoUsd: 1_200,
      estimatedCostNanoUsd: 28_100,
      responseId: "resp_1",
      requestId: "req_1",
      recordedAt: 1_000,
    });
    store.recordNamingUsage({
      beeId: bee.id,
      backend: "openai-api",
      provider: "openai",
      model: "gpt-5.6-luna",
      status: "failed",
      latencyMs: 300,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      estimatedCostNanoUsd: 4_400,
      error: "no usable title",
      recordedAt: 2_000,
    });
    store.recordNamingUsage({
      beeId: bee.id,
      backend: "codex-app-server",
      provider: "openai",
      model: "gpt-5.6-luna",
      status: "succeeded",
      latencyMs: 750,
      recordedAt: 3_000,
    });

    assert.equal(first.requestId, "req_1");
    assert.deepEqual(store.listNamingUsage().map((row) => row.recordedAt), [3_000, 2_000, 1_000]);
    const summary = store.namingUsageSummary();
    assert.deepEqual(
      {
        requests: summary.requests,
        succeeded: summary.succeeded,
        failed: summary.failed,
        pricedRequests: summary.pricedRequests,
        unpricedRequests: summary.unpricedRequests,
        estimatedCostNanoUsd: summary.estimatedCostNanoUsd,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        averageLatencyMs: summary.averageLatencyMs,
        firstRecordedAt: summary.firstRecordedAt,
        lastRecordedAt: summary.lastRecordedAt,
      },
      {
        requests: 3,
        succeeded: 2,
        failed: 1,
        pricedRequests: 2,
        unpricedRequests: 1,
        estimatedCostNanoUsd: 32_500,
        inputTokens: 130,
        outputTokens: 8,
        averageLatencyMs: 2030 / 3,
        firstRecordedAt: 1_000,
        lastRecordedAt: 3_000,
      },
    );
    assert.deepEqual(summary.byModel.map((row) => [row.backend, row.requests, row.estimatedCostNanoUsd]), [
      ["openai-api", 2, 32_500],
      ["codex-app-server", 1, 0],
    ]);

    store.deleteBee(bee.id);
    assert.equal(store.listNamingUsage().length, 3, "bee deletion retains historical spend");
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v14 migration creates naming_usage without inventing historical spend", () => {
  const h = harness();
  try {
    const initial = h.open();
    initial.close();
    const old = new DatabaseSync(h.path);
    old.prepare("UPDATE meta SET value = '13' WHERE key = 'schema_version'").run();
    old.exec("DROP TABLE naming_usage");
    old.close();

    const migrated = h.open();
    assert.equal(migrated.namingUsageSummary().requests, 0);
    migrated.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const table = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'naming_usage'").get();
      assert.ok(table);
      assert.equal(
        (check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
        String(SCHEMA_VERSION),
      );
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});
