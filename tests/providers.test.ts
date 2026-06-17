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

test("S3 wires fetchLimits for zai/minimax only; isExhausted/login stay unwired", () => {
  // S3: the two opencode-hosted providers with documented quota endpoints get
  // a fetchLimits; everyone else stays unsupported (degrades gracefully).
  const FETCH_PROVIDERS = new Set<ProviderId>(["zai-coding-plan", "minimax-coding-plan"]);
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
