import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountRecord } from "../src/accounts.js";
import type { ClaudeRotationStrandedMarker } from "../src/accounts/claudeChain.js";
import type { AuthRecoveryAttemptState } from "../src/daemon/authRecovery.js";
import { createRotationResumeDispatcher } from "../src/daemon/rotationResume.js";
import { pendingNeedsInputFromEvents, type HsrObservation } from "../src/hsr/observe.js";
import type { RunnerEvent } from "../src/hsr/types.js";
import type { BeeState } from "../src/state.js";
import type { SessionRecord } from "../src/store.js";

const NOW = Date.parse("2026-08-10T10:00:00.000Z");
const ROTATED_AT = NOW - 60_000;

const account: AccountRecord = {
  id: "claude-test",
  tool: "claude",
  label: "test@example.com",
  addedAt: new Date(NOW - 100_000).toISOString(),
};

function record(name: string, homePath: string): SessionRecord {
  return {
    name,
    agent: "claude",
    requestedAgent: "claude",
    cwd: "/tmp",
    command: "claude",
    tmuxTarget: name,
    createdAt: new Date(NOW - 600_000).toISOString(),
    updatedAt: new Date(NOW - 1_000).toISOString(),
    status: "running",
    substrate: "hsr",
    accountId: account.id,
    homePath,
    providerSessionId: "provider-session",
    runtimeGeneration: 4,
  };
}

function idleTurn(ts: number): RunnerEvent[] {
  return [
    { type: "turn_start", ts: ts - 1_000 },
    { type: "turn_end", ts },
  ];
}

function observation(events: RunnerEvent[]): HsrObservation {
  return {
    live: true,
    state: "ready",
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

type Harness = {
  states: Map<string, AuthRecoveryAttemptState>;
  ledger: Record<string, unknown>[];
  removedHomes: string[];
  recoveries: Array<{ bee: string; activateCredentials: boolean | undefined }>;
  dispatch: ReturnType<typeof createRotationResumeDispatcher>;
};

function harness(marker: ClaudeRotationStrandedMarker | null, overrides: Parameters<typeof createRotationResumeDispatcher>[0] = {}): Harness {
  const states = new Map<string, AuthRecoveryAttemptState>();
  const ledger: Record<string, unknown>[] = [];
  const removedHomes: string[] = [];
  const recoveries: Array<{ bee: string; activateCredentials: boolean | undefined }> = [];
  const dispatch = createRotationResumeDispatcher({
    enabled: () => true,
    backoffMs: 1,
    listClaudeAccounts: async () => [account],
    readMarker: async () => marker,
    removeMarkerHome: async (_account, homePath) => { removedHomes.push(homePath); },
    readState: async (name) => states.get(name) ?? null,
    writeState: async (name, state) => { states.set(name, state); },
    planCredentials: async () => ({ ready: true, source: "vault", expiresAt: NOW + 60_000, reason: "vault-newer" }),
    recover: async (bee, _account, options) => {
      recoveries.push({ bee: bee.name, activateCredentials: options.activateCredentials });
      return { record: bee, replayedPrompts: 0, promptSource: "journal" };
    },
    ledger: async (row) => { ledger.push(row); },
    ...overrides,
  });
  return { states, ledger, removedHomes, recoveries, dispatch };
}

test("rotation resume restarts an idle live bee on a stranded home and heals the marker", async () => {
  const home = "/tmp/homes/claude-test";
  const bee = record("CL.rot-idle", home);
  const h = harness({ version: 1, rotatedAt: ROTATED_AT, strandedHomes: [home] });

  const outcomes = await h.dispatch(
    [bee],
    new Map<string, BeeState>([[bee.name, "idle_with_output"]]),
    new Map([[bee.name, observation(idleTurn(ROTATED_AT - 10_000))]]),
    NOW,
  );

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.action, "resumed");
  assert.equal(outcomes[0]?.attempt, 1);
  assert.deepEqual(h.recoveries, [{ bee: bee.name, activateCredentials: true }], "resume always re-activates (the stale copy is the keychain)");
  assert.deepEqual(h.removedHomes, [home], "a successful resume drops the home from the marker");
  assert.equal(h.states.get(bee.name)?.status, "recovered");
  assert.deepEqual(
    h.ledger.map((row) => row.action),
    ["attempt", "resumed"],
  );
});

test("rotation resume never touches mid-turn, auth-needed, or unrelated-home bees", async () => {
  const strandedHome = "/tmp/homes/claude-test";
  const busy = record("CL.rot-busy", strandedHome);
  const authNeeded = record("CL.rot-auth", strandedHome);
  const elsewhere = record("CL.rot-elsewhere", "/tmp/homes/other-home");
  const h = harness({ version: 1, rotatedAt: ROTATED_AT, strandedHomes: [strandedHome] });

  const events = idleTurn(ROTATED_AT - 10_000);
  const outcomes = await h.dispatch(
    [busy, authNeeded, elsewhere],
    new Map<string, BeeState>([
      [busy.name, "active"],
      [authNeeded.name, "auth-needed"],
      [elsewhere.name, "idle_with_output"],
    ]),
    new Map([
      [busy.name, observation(events)],
      [authNeeded.name, observation(events)],
      [elsewhere.name, observation(events)],
    ]),
    NOW,
  );

  assert.deepEqual(outcomes, [], "mid-turn bees keep the marker pending; auth-needed is the classifier lane's; other homes are not at risk");
  assert.equal(h.recoveries.length, 0);
  assert.equal(h.states.size, 0, "no attempt state is burned for skipped bees");
});

test("rotation resume attempts are capped per incident and sticky once stopped", async () => {
  const home = "/tmp/homes/claude-test";
  const bee = record("CL.rot-cap", home);
  const h = harness({ version: 1, rotatedAt: ROTATED_AT, strandedHomes: [home] }, {
    maxAttempts: 1,
    recover: async () => {
      throw new Error("activation exploded");
    },
  });
  const states = new Map<string, BeeState>([[bee.name, "idle_with_output"]]);
  const observations = new Map([[bee.name, observation(idleTurn(ROTATED_AT - 10_000))]]);

  const first = await h.dispatch([bee], states, observations, NOW);
  assert.equal(first[0]?.action, "failed");
  assert.equal(h.states.get(bee.name)?.status, "stopped");

  const second = await h.dispatch([bee], states, observations, NOW + 10_000);
  assert.deepEqual(second, [], "a stopped incident is sticky for this rotation");
});

test("rotation resume resets the attempt budget after a completed post-resume turn", async () => {
  const home = "/tmp/homes/claude-test";
  const bee = record("CL.rot-reset", home);
  const h = harness({ version: 1, rotatedAt: ROTATED_AT, strandedHomes: [home] });
  // Exhausted state from an OLDER rotation incident…
  h.states.set(bee.name, {
    version: 1,
    incidentAuthTs: ROTATED_AT - 600_000,
    attempts: 2,
    lastAttemptAt: ROTATED_AT - 500_000,
    lastAttemptGeneration: 3,
    status: "stopped",
    stopReason: "attempt-cap",
  });
  // …but the bee completed a turn since that attempt, proving it came back
  // healthy: the new rotation starts a fresh incident.
  const outcomes = await h.dispatch(
    [bee],
    new Map<string, BeeState>([[bee.name, "idle_with_output"]]),
    new Map([[bee.name, observation(idleTurn(ROTATED_AT - 1_000))]]),
    NOW,
  );
  assert.equal(outcomes[0]?.action, "resumed");
  assert.equal(outcomes[0]?.attempt, 1, "attempt count restarted for the new incident");
});

test("rotation resume honors the daemon config kill switch and empty markers", async () => {
  const home = "/tmp/homes/claude-test";
  const bee = record("CL.rot-off", home);
  const states = new Map<string, BeeState>([[bee.name, "idle_with_output"]]);
  const observations = new Map([[bee.name, observation(idleTurn(ROTATED_AT - 10_000))]]);

  const disabled = harness({ version: 1, rotatedAt: ROTATED_AT, strandedHomes: [home] }, { enabled: () => false });
  assert.deepEqual(await disabled.dispatch([bee], states, observations, NOW), []);
  assert.equal(disabled.recoveries.length, 0);

  const noMarker = harness(null);
  assert.deepEqual(await noMarker.dispatch([bee], states, observations, NOW), []);
});
