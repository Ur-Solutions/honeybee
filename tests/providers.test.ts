import assert from "node:assert/strict";
import { test } from "node:test";
import { hasProviderAdapter, providerAdapter, type ProviderId } from "../src/providers.js";

const ALL_IDS: ProviderId[] = [
  "anthropic",
  "openai",
  "xai",
  "moonshot",
  "minimax-coding-plan",
  "zai-coding-plan",
  "kimi-for-coding",
];

test("providerAdapter / hasProviderAdapter resolve all 7 registered ids", () => {
  for (const id of ALL_IDS) {
    assert.equal(hasProviderAdapter(id), true, `hasProviderAdapter(${id})`);
    const adapter = providerAdapter(id);
    assert.ok(adapter, `providerAdapter(${id}) defined`);
    assert.equal(adapter!.id, id, `adapter.id matches key for ${id}`);
  }
  // anthropic carries its baseURL in the scaffold.
  assert.equal(providerAdapter("anthropic")!.baseURL, "https://api.anthropic.com");
});

test("providerAdapter / hasProviderAdapter reject unknown and undefined ids", () => {
  assert.equal(hasProviderAdapter("nope"), false);
  assert.equal(providerAdapter("nope"), undefined);
  // opencode is a CLI, never a provider id.
  assert.equal(hasProviderAdapter("opencode"), false);
  assert.equal(providerAdapter("opencode"), undefined);
  // Guard against `undefined` provider (legacy/un-normalized opencode account).
  assert.equal(hasProviderAdapter(undefined), false);
  assert.equal(providerAdapter(undefined), undefined);
});

test("fetchLimits wired for every quota-bearing provider; isExhausted/login stay unwired", () => {
  // anthropic/openai route through the dedicated claude/codex paths in
  // limits/ (an explicit dispatch check, not a registry adapter); every other
  // provider with a reachable quota endpoint carries its own fetchLimits.
  const FETCH_PROVIDERS = new Set<ProviderId>([
    "zai-coding-plan",
    "minimax-coding-plan",
    "xai",
    "moonshot",
    "cursor",
    "kimi-for-coding",
  ]);
  for (const id of ALL_IDS) {
    const adapter = providerAdapter(id)!;
    if (FETCH_PROVIDERS.has(id)) {
      assert.equal(typeof adapter.fetchLimits, "function", `${id}.fetchLimits wired in S3`);
    } else {
      assert.equal(adapter.fetchLimits, undefined, `${id}.fetchLimits stays unsupported`);
    }
    // Pane signals stay on the DRIVER (CLI-keyed), not the provider adapter.
    assert.equal(adapter.isExhausted, undefined, `${id}.isExhausted unwired`);
    assert.equal(adapter.login, undefined, `${id}.login unwired`);
  }
});
