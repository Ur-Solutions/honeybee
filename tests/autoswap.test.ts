import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountRecord } from "../src/accounts.js";
import { dispatchAutoswaps, selectSwapTarget, type AutoswapCandidate } from "../src/daemon/autoswap.js";
import type { UsageTickOutcome } from "../src/daemon/usageSampler.js";
import type { SessionRecord } from "../src/store.js";
import type { UsageSummary } from "../src/usage.js";

const NOW = Date.parse("2026-06-10T12:00:00.000Z");

function account(id: string, addedAt: string, tool = "claude"): AccountRecord {
  return { id, tool, label: id, addedAt };
}

function summary(accountId: string, lastExhaustedAt?: string): UsageSummary {
  return {
    account: accountId,
    sampleCount: 0,
    windowInputTokens: 0,
    windowOutputTokens: 0,
    ...(lastExhaustedAt ? { lastExhaustedAt } : {}),
  };
}

test("selectSwapTarget prefers never-exhausted accounts, then least-recently-exhausted", () => {
  const candidates: AutoswapCandidate[] = [
    { account: account("a-old", "2026-01-02T00:00:00Z"), summary: summary("a-old", "2026-06-09T00:00:00Z") },
    { account: account("a-fresh", "2026-01-03T00:00:00Z"), summary: summary("a-fresh") },
    { account: account("a-fresh-older-reg", "2026-01-01T00:00:00Z"), summary: summary("a-fresh-older-reg") },
  ];
  // Never-exhausted first, oldest registration breaking the tie.
  assert.equal(selectSwapTarget(candidates, NOW)!.id, "a-fresh-older-reg");

  // All exhausted outside the cool-off: pick the least recent.
  const exhausted: AutoswapCandidate[] = [
    { account: account("b1", "2026-01-01T00:00:00Z"), summary: summary("b1", "2026-06-09T10:00:00Z") },
    { account: account("b2", "2026-01-01T00:00:00Z"), summary: summary("b2", "2026-06-09T08:00:00Z") },
  ];
  assert.equal(selectSwapTarget(exhausted, NOW)!.id, "b2");

  // Inside the cool-off window: excluded entirely.
  const cooling: AutoswapCandidate[] = [
    { account: account("c1", "2026-01-01T00:00:00Z"), summary: summary("c1", new Date(NOW - 60_000).toISOString()) },
  ];
  assert.equal(selectSwapTarget(cooling, NOW), null);
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
    homePath: "/tmp/home",
    accountId: "claude-current",
    autoswap: true,
    ...overrides,
  };
}

function outcome(bee: string, exhausted = true): UsageTickOutcome {
  return { bee, account: "claude-current", sampled: false, exhausted };
}

test("dispatchAutoswaps swaps an opted-in exhausted bee to the deterministic next account", async () => {
  const swaps: string[] = [];
  const accounts = [
    account("claude-current", "2026-01-01T00:00:00Z"),
    account("claude-spare", "2026-01-02T00:00:00Z"),
    account("codex-other", "2026-01-01T00:00:00Z", "codex"),
  ];
  const outcomes = await dispatchAutoswaps([record()], [outcome("CL.a")], {
    listAccounts: async () => accounts,
    accountHasCredentials: async () => true,
    usageSummary: async (id) => summary(id),
    swapAccount: async (target, next) => {
      swaps.push(`${target.name}->${next.id}`);
      return { ...target, accountId: next.id };
    },
    now: () => NOW,
  });

  assert.deepEqual(swaps, ["CL.a->claude-spare"]);
  assert.deepEqual(outcomes, [{ bee: "CL.a", from: "claude-current", to: "claude-spare", ok: true }]);
});

test("dispatchAutoswaps never rotates a bee onto a paused account", async () => {
  const outcomes = await dispatchAutoswaps([record()], [outcome("CL.a")], {
    listAccounts: async () => [
      account("claude-current", "2026-01-01T00:00:00Z"),
      { ...account("claude-spare", "2026-01-02T00:00:00Z"), pausedAt: "2026-06-01T00:00:00Z" },
    ],
    accountHasCredentials: async () => true,
    usageSummary: async (id) => summary(id),
    swapAccount: async () => {
      throw new Error("should not swap onto a paused account");
    },
    now: () => NOW,
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.ok, false);
  assert.match(outcomes[0]!.skipped ?? "", /no non-exhausted account/);
});

test("dispatchAutoswaps skips bees without opt-in and reports no-candidate cases", async () => {
  // Not opted in: no outcome at all.
  const ignored = await dispatchAutoswaps([record({ autoswap: undefined })], [outcome("CL.a")], {
    listAccounts: async () => [],
    now: () => NOW,
  });
  assert.deepEqual(ignored, []);

  // Opted in, but every alternative lacks creds or is cooling off.
  const outcomes = await dispatchAutoswaps([record()], [outcome("CL.a")], {
    listAccounts: async () => [account("claude-current", "2026-01-01T00:00:00Z"), account("claude-dry", "2026-01-02T00:00:00Z")],
    accountHasCredentials: async (candidate) => candidate.id !== "claude-dry",
    usageSummary: async (id) => summary(id),
    swapAccount: async () => {
      throw new Error("should not swap");
    },
    now: () => NOW,
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.ok, false);
  assert.match(outcomes[0]!.skipped ?? "", /no non-exhausted account/);

  // Swap errors surface in the outcome instead of throwing.
  const failing = await dispatchAutoswaps([record()], [outcome("CL.a")], {
    listAccounts: async () => [account("claude-current", "2026-01-01T00:00:00Z"), account("claude-spare", "2026-01-02T00:00:00Z")],
    accountHasCredentials: async () => true,
    usageSummary: async (id) => summary(id),
    swapAccount: async () => {
      throw new Error("tmux exploded");
    },
    now: () => NOW,
  });
  assert.equal(failing[0]!.ok, false);
  assert.equal(failing[0]!.error, "tmux exploded");
});

function providerAccount(id: string, addedAt: string, provider: string): AccountRecord {
  return { id, tool: "opencode", label: id, addedAt, provider };
}

test("dispatchAutoswaps narrows candidates to the bee's provider (glm stays within zai)", async () => {
  const swaps: string[] = [];
  // A glm (zai) bee on opencode; the pool has another zai account + a minimax
  // account that shares the opencode CLI. Only the zai one is a valid target.
  const accounts: AccountRecord[] = [
    providerAccount("zai-current", "2026-01-01T00:00:00Z", "zai-coding-plan"),
    providerAccount("zai-spare", "2026-01-02T00:00:00Z", "zai-coding-plan"),
    providerAccount("mm-other", "2026-01-01T00:00:00Z", "minimax-coding-plan"),
  ];
  const beeRecord = record({ name: "OC.a", agent: "opencode", accountId: "zai-current" });
  const outcomes = await dispatchAutoswaps([beeRecord], [{ bee: "OC.a", account: "zai-current", sampled: false, exhausted: true }], {
    listAccounts: async () => accounts,
    accountHasCredentials: async () => true,
    usageSummary: async (id) => summary(id),
    swapAccount: async (target, next) => {
      swaps.push(`${target.name}->${next.id}`);
      return { ...target, accountId: next.id };
    },
    now: () => NOW,
  });
  // minimax must be excluded; only the same-provider zai spare is chosen.
  assert.deepEqual(swaps, ["OC.a->zai-spare"]);
  assert.equal(outcomes[0]!.to, "zai-spare");
});

test("dispatchAutoswaps tolerates undefined provider (legacy claude account still swaps)", async () => {
  const swaps: string[] = [];
  // Legacy accounts carry no provider; the narrowing must fall back to
  // tool-only so claude bees keep swapping exactly as before.
  const accounts = [
    account("claude-current", "2026-01-01T00:00:00Z"),
    account("claude-spare", "2026-01-02T00:00:00Z"),
  ];
  const outcomes = await dispatchAutoswaps([record()], [outcome("CL.a")], {
    listAccounts: async () => accounts,
    accountHasCredentials: async () => true,
    usageSummary: async (id) => summary(id),
    swapAccount: async (target, next) => {
      swaps.push(`${target.name}->${next.id}`);
      return { ...target, accountId: next.id };
    },
    now: () => NOW,
  });
  assert.deepEqual(swaps, ["CL.a->claude-spare"]);
  assert.equal(outcomes[0]!.to, "claude-spare");
});
