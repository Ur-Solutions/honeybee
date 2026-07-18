/**
 * HIVE-20: the harness registry is the single registration point for HSR —
 * these tests enforce the cross-module consistency that used to rely on
 * remembering four separate edits (adapterFor switch, ALLOWANCES table,
 * EPHEMERAL_POLICY, drivers recipes). A new harness whose descriptor is
 * incoherent, or whose adapter/driver pieces are missing, fails here instead
 * of silently misbehaving at spawn.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTH_KINDS,
  ephemeralHarnesses,
  ephemeralPolicyFor,
  harnessAllowance,
  harnessDescriptor,
  harnessNames,
  harnessSupportsRemoteHsr,
  validateHarnessRegistry,
} from "../src/hsr/harness.js";
import { adapterFor } from "../src/hsr/adapters/index.js";
import { allowanceFor, bestTier, scrubEnvFor } from "../src/hsr/allowance.js";

test("validateHarnessRegistry reports no problems", async () => {
  assert.deepEqual(await validateHarnessRegistry(), []);
});

test("every runner harness has a registered adapter (and only those)", () => {
  for (const name of harnessNames()) {
    const desc = harnessDescriptor(name)!;
    const adapter = adapterFor(name);
    if (desc.runner) {
      assert.ok(adapter, `${name}: descriptor declares runner:true but adapterFor returns undefined`);
      assert.equal(adapter.harness, name, `${name}: adapter self-reports a different harness name`);
    } else {
      assert.equal(adapter, undefined, `${name}: no runner declared but an adapter is registered`);
    }
  }
});

test("adapter tier matches the descriptor's best permitted tier", () => {
  for (const name of harnessNames()) {
    const desc = harnessDescriptor(name)!;
    if (!desc.runner || !desc.allowance) continue; // stub: test-only, no allowance
    const adapter = adapterFor(name)!;
    assert.equal(
      adapter.tier(),
      desc.allowance.subscription.permittedTiers[0],
      `${name}: adapter tier diverges from the registry's allowance policy`,
    );
  }
});

test("allowance.ts serves rows derived from the registry", () => {
  for (const name of harnessNames()) {
    for (const authKind of AUTH_KINDS) {
      const row = allowanceFor(name, authKind);
      const policy = harnessAllowance(name, authKind);
      if (!policy) {
        assert.equal(row, undefined, `${name}/${authKind}: no policy but a row is served`);
        continue;
      }
      assert.ok(row, `${name}/${authKind}: policy registered but no row served`);
      assert.deepEqual(row.permittedTiers, [...policy.permittedTiers]);
      assert.deepEqual(row.requiredFlags, [...policy.requiredFlags]);
      assert.deepEqual(row.scrubEnv, [...policy.scrubEnv]);
      assert.deepEqual(row.fingerprints, [...policy.fingerprints]);
    }
  }
});

test("legacy allowance behavior is preserved by the registry view", () => {
  assert.equal(bestTier("claude", "subscription"), "stream");
  assert.equal(bestTier("codex", "subscription"), "server");
  assert.equal(bestTier("opencode", "subscription"), "server");
  assert.equal(bestTier("kimi", "subscription"), "stream");
  assert.equal(bestTier("grok", "subscription"), "stream");
  assert.deepEqual(allowanceFor("opencode", "subscription")?.requiredFlags, [
    "serve", "--hostname", "127.0.0.1", "--port", "0",
  ]);
  assert.deepEqual(allowanceFor("kimi", "subscription")?.requiredFlags, ["acp"]);
  assert.deepEqual(allowanceFor("grok", "subscription")?.requiredFlags, ["--no-auto-update", "agent", "--no-leader", "stdio"]);
  assert.deepEqual(scrubEnvFor("grok", "subscription"), ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]);
  assert.deepEqual(scrubEnvFor("grok", "api-key"), []);
  assert.deepEqual(scrubEnvFor("claude", "subscription"), ["ANTHROPIC_API_KEY"]);
  assert.deepEqual(scrubEnvFor("claude", "api-key"), []);
  assert.equal(allowanceFor("stub", "subscription"), undefined, "stub is test-only: no allowance rows");
  assert.equal(allowanceFor("nope", "subscription"), undefined);
});

test("OpenCode, Kimi, and Grok HSR are explicitly local-only while filtered-credential runners remain allowed", () => {
  assert.equal(harnessSupportsRemoteHsr("opencode"), false);
  assert.equal(harnessSupportsRemoteHsr("kimi"), false);
  assert.equal(harnessSupportsRemoteHsr("grok"), false);
  assert.equal(harnessSupportsRemoteHsr("claude"), true);
  assert.equal(harnessSupportsRemoteHsr("codex"), true);
});

test("ephemeral policy: claude mints a token, codex ships an access-token-only auth.json", () => {
  assert.deepEqual(ephemeralHarnesses(), ["claude", "codex"]);
  assert.equal(ephemeralPolicyFor("claude")?.strategy, "mint-token");
  assert.equal(ephemeralPolicyFor("claude")?.tokenEnv, "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(ephemeralPolicyFor("codex")?.strategy, "ship-access-token");
  assert.equal(ephemeralPolicyFor("grok"), undefined, "grok has no ephemeral delivery wired");
  assert.equal(ephemeralPolicyFor("stub"), undefined);
});
