import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AccountRecord } from "../src/accounts.js";
import type { ClaudeChain } from "../src/accounts/claudeChain.js";
import {
  inspectClaudeDiskCredentials,
  planClaudeRecoveryCredentials,
} from "../src/accounts/credentialHealth.js";
import { collectAuthRecoveryPrompts, legacyPromptForAuthFailure } from "../src/commands/migrate.js";
import {
  createAuthRecoveryDispatcher,
  hadSuccessfulInterveningTurn,
  planAuthRecovery,
  type AuthRecoveryAttemptState,
} from "../src/daemon/authRecovery.js";
import { pendingNeedsInputFromEvents, type HsrObservation } from "../src/hsr/observe.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import type { BeeState } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";

const NOW = Date.parse("2026-08-02T10:00:00.000Z");
const AUTH_MESSAGE = "Not logged in · Please run /login";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hive-auth-recovery-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function credentials(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "access-redacted-test-value",
      refreshToken: "refresh-redacted-test-value",
      expiresAt: NOW + 60_000,
      ...overrides,
    },
  });
}

function chain(name: string, expiresAt: number): ClaudeChain {
  const oauth = {
    accessToken: `access-${name}`,
    refreshToken: `refresh-${name}`,
    expiresAt,
  };
  return {
    raw: JSON.stringify({ claudeAiOauth: oauth }),
    oauth,
    refreshToken: oauth.refreshToken,
    expiresAt,
    source: name,
  };
}

test("inspectClaudeDiskCredentials requires a well-formed future access+refresh chain", async () => {
  await withTempDir(async (home) => {
    assert.deepEqual(await inspectClaudeDiskCredentials(home, { now: () => NOW }), { valid: false, reason: "missing" });

    await writeFile(join(home, ".credentials.json"), "not-json\n");
    assert.deepEqual(await inspectClaudeDiskCredentials(home, { now: () => NOW }), {
      valid: false,
      reason: "malformed-or-incomplete",
    });

    await writeFile(join(home, ".credentials.json"), credentials({ accessToken: "" }));
    assert.deepEqual(await inspectClaudeDiskCredentials(home, { now: () => NOW }), {
      valid: false,
      reason: "missing-access-token",
    });

    await writeFile(join(home, ".credentials.json"), credentials({ refreshToken: "" }));
    assert.deepEqual(await inspectClaudeDiskCredentials(home, { now: () => NOW }), {
      valid: false,
      reason: "missing-refresh-token",
    });

    await writeFile(
      join(home, ".credentials.json"),
      '{"claudeAiOauth":{"accessToken":"test","refreshToken":"test","expiresAt":1e309}}\n',
    );
    assert.deepEqual(await inspectClaudeDiskCredentials(home, { now: () => NOW }), {
      valid: false,
      reason: "invalid-expiry",
    });

    await writeFile(join(home, ".credentials.json"), credentials({ expiresAt: NOW }));
    assert.deepEqual(await inspectClaudeDiskCredentials(home, { now: () => NOW }), {
      valid: false,
      reason: "expired",
    });

    await writeFile(join(home, ".credentials.json"), credentials());
    assert.deepEqual(await inspectClaudeDiskCredentials(home, { now: () => NOW }), {
      valid: true,
      expiresAt: NOW + 60_000,
    });
  });
});

test("credential recovery chooses a newer rotated vault chain over a structurally valid home", async () => {
  const account: AccountRecord = {
    id: "claude-test",
    tool: "claude",
    label: "test@example.com",
    addedAt: new Date(NOW - 100_000).toISOString(),
  };
  const home = chain("superseded-home", NOW + 60_000);
  const vault = chain("fresh-login", NOW + 120_000);
  assert.deepEqual(
    await planClaudeRecoveryCredentials(account, "/unused", {
      now: () => NOW,
      readHome: async () => home,
      readVault: async () => vault,
    }),
    { ready: true, source: "vault", expiresAt: NOW + 120_000, reason: "vault-newer" },
  );
});

test("credential recovery preserves a newer home chain and falls back to a valid vault", async () => {
  const account: AccountRecord = {
    id: "claude-test",
    tool: "claude",
    label: "test@example.com",
    addedAt: new Date(NOW - 100_000).toISOString(),
  };
  const newerHome = chain("rotated-home", NOW + 180_000);
  const olderVault = chain("old-vault", NOW + 120_000);
  assert.deepEqual(
    await planClaudeRecoveryCredentials(account, "/unused", {
      now: () => NOW,
      readHome: async () => newerHome,
      readVault: async () => olderVault,
    }),
    { ready: true, source: "home", expiresAt: NOW + 180_000, reason: "home-current" },
  );
  assert.deepEqual(
    await planClaudeRecoveryCredentials(account, "/unused", {
      now: () => NOW,
      readHome: async () => null,
      readVault: async () => olderVault,
    }),
    { ready: true, source: "vault", expiresAt: NOW + 120_000, reason: "vault-only" },
  );
});

function authTurn(start = NOW - 500): RunnerEvent[] {
  return [
    { type: "turn_start", ts: start },
    { type: "error", ts: start + 300, message: AUTH_MESSAGE },
    { type: "turn_end", ts: start + 301 },
    { type: "usage", ts: start + 302, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ];
}

test("legacy prompt recovery is strict to the auth-failed turn", () => {
  const events = authTurn();
  assert.equal(
    legacyPromptForAuthFailure(
      { lastPrompt: "exact prompt", lastPromptAt: new Date(NOW - 450).toISOString() },
      events,
    ),
    "exact prompt",
  );
  assert.equal(
    legacyPromptForAuthFailure(
      { lastPrompt: "older unrelated prompt", lastPromptAt: new Date(NOW - 20_000).toISOString() },
      events,
    ),
    undefined,
  );
  assert.equal(legacyPromptForAuthFailure({ lastPrompt: "missing timestamp" }, events), undefined);
});

test("a staged auth replay survives the stop/revive gap and outranks legacy fallback", async () => {
  await withTempDir(async (store) => {
    const previous = process.env.HIVE_STORE_ROOT;
    process.env.HIVE_STORE_ROOT = store;
    try {
      const bee = "CL.staged-replay";
      const runDir = join(store, "hsr", bee);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "auth-replay.json"), `${JSON.stringify({
        version: 1,
        prompts: ["durable exact prompt"],
        source: "journal",
        authEventTs: NOW - 200,
        stagedAt: new Date(NOW).toISOString(),
      })}\n`);
      const recovered = await collectAuthRecoveryPrompts({
        ...record(join(store, "home")),
        name: bee,
        lastPrompt: "wrong legacy prompt",
        lastPromptAt: new Date(NOW - 450).toISOString(),
      }, authTurn());
      assert.deepEqual(recovered, {
        prompts: ["durable exact prompt"],
        source: "journal",
        authEventTs: NOW - 200,
      });
    } finally {
      if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
      else process.env.HIVE_STORE_ROOT = previous;
    }
  });
});

test("auth recovery planner applies backoff, one attempt per generation, and an incident cap", () => {
  const events = authTurn();
  const authTs = events[1]!.ts;
  assert.equal(planAuthRecovery({ state: null, events, authEventTs: authTs, generation: 3, nowMs: authTs + 1_999 }).action, "defer");
  const first = planAuthRecovery({ state: null, events, authEventTs: authTs, generation: 3, nowMs: authTs + 2_000 });
  assert.equal(first.action, "attempt");
  if (first.action !== "attempt") return;
  assert.equal(first.attempt, 1);

  const sameGeneration = planAuthRecovery({
    state: first.state,
    events,
    authEventTs: authTs,
    generation: 3,
    nowMs: authTs + 20_000,
  });
  assert.deepEqual(
    { action: sameGeneration.action, reason: sameGeneration.action === "hard-stop" ? sameGeneration.reason : undefined },
    { action: "hard-stop", reason: "generation 3 already attempted" },
  );

  const secondAuth = authTurn(NOW + 10_000);
  const secondTs = secondAuth[1]!.ts;
  const second = planAuthRecovery({
    state: { ...first.state, status: "recovered" },
    events: [...events, { type: "auth_resume", ts: NOW + 1_000, source: "auto" }, ...secondAuth],
    authEventTs: secondTs,
    generation: 4,
    nowMs: secondTs + 4_000,
  });
  assert.equal(second.action, "attempt");
  if (second.action !== "attempt") return;
  assert.equal(second.attempt, 2);

  const thirdAuth = authTurn(NOW + 20_000);
  const thirdTs = thirdAuth[1]!.ts;
  const capped = planAuthRecovery({
    state: { ...second.state, status: "recovered" },
    events: [...secondAuth, ...thirdAuth],
    authEventTs: thirdTs,
    generation: 5,
    nowMs: thirdTs + 10_000,
  });
  assert.equal(capped.action, "hard-stop");
  if (capped.action === "hard-stop") assert.equal(capped.reason, "attempt cap reached (2)");
});

test("a completed turn between recovery and a later auth failure resets the incident", () => {
  const laterAuth = authTurn(NOW + 20_000);
  const events: RunnerEvent[] = [
    { type: "auth_resume", ts: NOW, source: "auto" },
    { type: "turn_start", ts: NOW + 1_000 },
    { type: "text", ts: NOW + 1_100, text: "worked" },
    { type: "turn_end", ts: NOW + 1_200 },
    ...laterAuth,
  ];
  const authTs = laterAuth[1]!.ts;
  assert.equal(hadSuccessfulInterveningTurn(events, NOW, authTs), true);
  const old: AuthRecoveryAttemptState = {
    version: 1,
    incidentAuthTs: NOW - 1_000,
    attempts: 2,
    lastAttemptAt: NOW,
    lastAttemptGeneration: 8,
    status: "recovered",
  };
  const plan = planAuthRecovery({ state: old, events, authEventTs: authTs, generation: 9, nowMs: authTs + 2_000 });
  assert.equal(plan.action, "attempt");
  if (plan.action === "attempt") assert.equal(plan.attempt, 1);
});

function record(homePath: string): SessionRecord {
  return {
    name: "CL.auth-auto",
    agent: "claude",
    requestedAgent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: "CL.auth-auto",
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 1_000).toISOString(),
    status: "running",
    substrate: "hsr",
    accountId: "claude-test",
    homePath,
    providerSessionId: "provider-session",
    runtimeGeneration: 4,
  };
}

function observation(events: RunnerEvent[]): HsrObservation {
  return {
    live: true,
    state: "auth-needed",
    snapshot: "",
    eventSnapshot: {
      events,
      tailEvents: events,
      activity: null,
      usage: { totals: null },
      pendingNeedsInput: pendingNeedsInputFromEvents(events),
    },
  };
}

test("daemon recovery uses valid disk credentials once and persists the attempt before recover", async () => {
  await withTempDir(async (home) => {
    const bee = record(home);
    const events = authTurn(NOW - 10_000);
    const states = new Map<string, AuthRecoveryAttemptState>();
    const writes: AuthRecoveryAttemptState[] = [];
    const ledger: Record<string, unknown>[] = [];
    let recovered = 0;
    const account: AccountRecord = {
      id: "claude-test",
      tool: "claude",
      label: "test@example.com",
      addedAt: new Date(NOW - 100_000).toISOString(),
    };
    const dispatch = createAuthRecoveryDispatcher({
      backoffMs: 1,
      readState: async (name) => states.get(name) ?? null,
      writeState: async (name, state) => {
        states.set(name, state);
        writes.push(state);
      },
      planCredentials: async () => ({
        ready: true,
        source: "home",
        expiresAt: NOW + 60_000,
        reason: "home-current",
      }),
      resolveAccount: async () => account,
      recover: async (_record, _account, options) => {
        recovered += 1;
        assert.equal(states.get(bee.name)?.status, "attempting", "attempt is durable before restart");
        assert.equal(options.source, "auto");
        assert.equal(options.activateCredentials, false);
        return { record: bee, replayedPrompts: 1, promptSource: "journal" };
      },
      ledger: async (row) => { ledger.push(row); },
    });

    const outcomes = await dispatch(
      [bee],
      new Map<string, BeeState>([[bee.name, "auth-needed"]]),
      new Map([[bee.name, observation(events)]]),
      NOW,
    );
    assert.equal(recovered, 1);
    assert.equal(writes.at(-1)?.status, "recovered");
    assert.deepEqual(outcomes, [{
      bee: bee.name,
      action: "recovered",
      generation: 4,
      attempt: 1,
      credentialSource: "home",
      replayedPrompts: 1,
      promptSource: "journal",
    }]);
    assert.deepEqual(ledger.map((row) => row.action), ["attempt", "recovered"]);
    assert.equal(JSON.stringify(ledger).includes("access-redacted"), false);
  });
});

test("daemon recovery stops closed on invalid credentials and never calls recover", async () => {
  await withTempDir(async (home) => {
    const bee = record(home);
    const events = authTurn(NOW - 10_000);
    let saved: AuthRecoveryAttemptState | null = null;
    let recovered = false;
    const dispatch = createAuthRecoveryDispatcher({
      backoffMs: 1,
      readState: async () => saved,
      writeState: async (_name, state) => { saved = state; },
      planCredentials: async () => ({
        ready: false,
        reason: "no-valid-home-or-vault",
        homeReason: "expired",
        vaultReason: "expired",
      }),
      resolveAccount: async () => ({ id: "claude-test", tool: "claude", label: "test", addedAt: "now" }),
      recover: async () => {
        recovered = true;
        throw new Error("must not run");
      },
      ledger: async () => undefined,
    });
    const args: [SessionRecord[], Map<string, BeeState>, Map<string, HsrObservation>, number] = [
      [bee],
      new Map([[bee.name, "auth-needed"]]),
      new Map([[bee.name, observation(events)]]),
      NOW,
    ];
    const first = await dispatch(...args);
    const second = await dispatch(...args);
    assert.equal(recovered, false);
    const stopped = saved as AuthRecoveryAttemptState | null;
    assert.equal(stopped?.status, "stopped");
    assert.equal(stopped?.stopReason, "credentials-no-valid-home-or-vault:home-expired:vault-expired");
    assert.equal(first[0]?.action, "blocked");
    assert.deepEqual(second, [], "persisted hard stop suppresses daemon-restart/tick retry loops");
  });
});

test("daemon recovery activates a newer vault chain before replay", async () => {
  await withTempDir(async (home) => {
    const bee = record(home);
    const events = authTurn(NOW - 10_000);
    const account: AccountRecord = {
      id: "claude-test",
      tool: "claude",
      label: "test@example.com",
      addedAt: new Date(NOW - 100_000).toISOString(),
    };
    let saved: AuthRecoveryAttemptState | null = null;
    let activated = false;
    const dispatch = createAuthRecoveryDispatcher({
      backoffMs: 1,
      readState: async () => saved,
      writeState: async (_name, state) => { saved = state; },
      planCredentials: async () => ({
        ready: true,
        source: "vault",
        expiresAt: NOW + 120_000,
        reason: "vault-newer",
      }),
      resolveAccount: async () => account,
      recover: async (_record, _account, options) => {
        activated = options.activateCredentials === true;
        return { record: bee, replayedPrompts: 1, promptSource: "journal" };
      },
      ledger: async () => undefined,
    });

    const outcomes = await dispatch(
      [bee],
      new Map<string, BeeState>([[bee.name, "auth-needed"]]),
      new Map([[bee.name, observation(events)]]),
      NOW,
    );
    assert.equal(activated, true);
    assert.equal(outcomes[0]?.credentialSource, "vault");
  });
});
