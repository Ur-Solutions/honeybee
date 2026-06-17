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

test("S1 provider adapters are scaffold-only: no fetchLimits/isExhausted/login wired", () => {
  for (const id of ALL_IDS) {
    const adapter = providerAdapter(id)!;
    assert.equal(adapter.fetchLimits, undefined, `${id}.fetchLimits unimplemented in S1`);
    assert.equal(adapter.isExhausted, undefined, `${id}.isExhausted unimplemented in S1`);
    assert.equal(adapter.login, undefined, `${id}.login unimplemented in S1`);
  }
});
