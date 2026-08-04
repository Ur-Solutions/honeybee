import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { accountEmail, findAccount, homeClaudeEmail, type AccountRecord } from "../accounts.js";
import {
  planClaudeRecoveryCredentials,
  type ClaudeRecoveryCredentialPlan,
} from "../accounts/credentialHealth.js";
import { canonicalAgentKind } from "../agents.js";
import { recoverAuthNeededBee } from "../commands/migrate.js";
import type { HsrObservation } from "../hsr/observe.js";
import { ensureHsrRunDir, hsrRunDir } from "../hsr/runDir.js";
import type { RunnerEvent } from "../hsr/types.js";
import type { BeeState } from "../state.js";
import { atomicWriteFile } from "../fsx.js";
import { appendLedger } from "../store.js";
import type { SessionRecord } from "../store.js";
import { lastAuthNeededEvent } from "../view/requests.js";

export const DEFAULT_AUTH_RECOVERY_BACKOFF_MS = 2_000;
export const DEFAULT_AUTH_RECOVERY_MAX_ATTEMPTS = 2;

export type AuthRecoveryAttemptState = {
  version: 1;
  incidentAuthTs: number;
  attempts: number;
  lastAttemptAt?: number;
  lastAttemptGeneration?: number;
  status: "ready" | "attempting" | "recovered" | "stopped";
  stopReason?: string;
};

export type AuthRecoveryPlan =
  | { action: "defer"; dueAt: number; state: AuthRecoveryAttemptState }
  | { action: "attempt"; attempt: number; state: AuthRecoveryAttemptState }
  | { action: "hard-stop"; reason: string; state: AuthRecoveryAttemptState };

export type AuthRecoveryOutcome = {
  bee: string;
  action: "recovered" | "blocked" | "failed" | "hard-stop";
  attempt?: number;
  generation: number;
  promptSource?: "journal" | "legacy-last-prompt" | "unrecoverable";
  replayedPrompts?: number;
  credentialSource?: "home" | "vault";
  reason?: string;
  error?: string;
};

function statePath(bee: string): string {
  return join(hsrRunDir(bee), "auth-auto-recovery.json");
}

export async function readAuthRecoveryState(bee: string): Promise<AuthRecoveryAttemptState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(bee), "utf8")) as Partial<AuthRecoveryAttemptState>;
    if (
      parsed.version !== 1 ||
      typeof parsed.incidentAuthTs !== "number" ||
      typeof parsed.attempts !== "number" ||
      !Number.isSafeInteger(parsed.attempts) ||
      parsed.attempts < 0 ||
      !["ready", "attempting", "recovered", "stopped"].includes(String(parsed.status))
    ) return null;
    return parsed as AuthRecoveryAttemptState;
  } catch {
    return null;
  }
}

export async function writeAuthRecoveryState(bee: string, state: AuthRecoveryAttemptState): Promise<void> {
  await ensureHsrRunDir(bee);
  await atomicWriteFile(statePath(bee), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** A completed turn strictly between the prior recovery and this auth turn resets the incident. */
export function hadSuccessfulInterveningTurn(
  events: RunnerEvent[],
  lastAttemptAt: number,
  authEventTs: number,
): boolean {
  let authIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      event.ts === authEventTs &&
      (event.type === "error" || (event.type === "auth_expired" && event.requiresLogin === true))
    ) {
      authIndex = index;
      break;
    }
  }
  if (authIndex < 0) return false;
  let currentTurnStart = authIndex;
  for (let index = authIndex; index >= 0; index -= 1) {
    if (events[index]!.type === "turn_start") {
      currentTurnStart = index;
      break;
    }
  }
  return events.some((event, index) => (
    index < currentTurnStart && event.type === "turn_end" && event.ts > lastAttemptAt
  ));
}

/** Pure guard/backoff planner, separated so every crash-loop condition is unit-testable. */
export function planAuthRecovery(input: {
  state: AuthRecoveryAttemptState | null;
  events: RunnerEvent[];
  authEventTs: number;
  generation: number;
  nowMs: number;
  backoffMs?: number;
  maxAttempts?: number;
}): AuthRecoveryPlan {
  const backoffMs = input.backoffMs ?? DEFAULT_AUTH_RECOVERY_BACKOFF_MS;
  const maxAttempts = input.maxAttempts ?? DEFAULT_AUTH_RECOVERY_MAX_ATTEMPTS;
  let state = input.state ?? {
    version: 1,
    incidentAuthTs: input.authEventTs,
    attempts: 0,
    status: "ready",
  };

  if (state.incidentAuthTs !== input.authEventTs) {
    const reset = state.lastAttemptAt !== undefined && hadSuccessfulInterveningTurn(
      input.events,
      state.lastAttemptAt,
      input.authEventTs,
    );
    state = reset
      ? { version: 1, incidentAuthTs: input.authEventTs, attempts: 0, status: "ready" }
      : { ...state, incidentAuthTs: input.authEventTs, status: "ready", stopReason: undefined };
  }

  if (state.attempts >= maxAttempts) {
    return {
      action: "hard-stop",
      reason: `attempt cap reached (${maxAttempts})`,
      state: { ...state, status: "stopped", stopReason: "attempt-cap" },
    };
  }
  if (state.lastAttemptGeneration === input.generation) {
    return {
      action: "hard-stop",
      reason: `generation ${input.generation} already attempted`,
      state: { ...state, status: "stopped", stopReason: "generation-attempted" },
    };
  }

  const anchor = Math.max(input.authEventTs, state.lastAttemptAt ?? 0);
  const dueAt = anchor + backoffMs * (2 ** state.attempts);
  if (input.nowMs < dueAt) return { action: "defer", dueAt, state };
  const attempt = state.attempts + 1;
  return {
    action: "attempt",
    attempt,
    state: {
      ...state,
      attempts: attempt,
      lastAttemptAt: input.nowMs,
      lastAttemptGeneration: input.generation,
      status: "attempting",
      stopReason: undefined,
    },
  };
}

export type AuthRecoveryDeps = {
  readState?: typeof readAuthRecoveryState;
  writeState?: typeof writeAuthRecoveryState;
  planCredentials?: (
    account: AccountRecord,
    homePath: string,
    options?: { now?: () => number },
  ) => Promise<ClaudeRecoveryCredentialPlan>;
  resolveAccount?: (id: string, tool: string) => Promise<AccountRecord>;
  homeEmail?: (homePath: string) => Promise<string | null>;
  recover?: typeof recoverAuthNeededBee;
  ledger?: typeof appendLedger;
  backoffMs?: number;
  maxAttempts?: number;
};

/**
 * Daemon-side cure for Claude's stale in-memory OAuth chain. Only local Claude
 * HSR bees with structured auth evidence are eligible; every ambiguity stops
 * closed and leaves the durable auth request visible to a human.
 */
export function createAuthRecoveryDispatcher(deps: AuthRecoveryDeps = {}): (
  records: SessionRecord[],
  currentStates: Map<string, BeeState>,
  hsrObservations: ReadonlyMap<string, HsrObservation>,
  nowMs: number,
) => Promise<AuthRecoveryOutcome[]> {
  const readState = deps.readState ?? readAuthRecoveryState;
  const writeState = deps.writeState ?? writeAuthRecoveryState;
  const planCredentials = deps.planCredentials ?? planClaudeRecoveryCredentials;
  const resolveAccount = deps.resolveAccount ?? findAccount;
  const readHomeEmail = deps.homeEmail ?? homeClaudeEmail;
  const recover = deps.recover ?? recoverAuthNeededBee;
  const ledger = deps.ledger ?? appendLedger;

  return async (records, currentStates, hsrObservations, nowMs) => {
    const outcomes: AuthRecoveryOutcome[] = [];
    for (const record of records) {
      if (record.substrate !== "hsr" || currentStates.get(record.name) !== "auth-needed") continue;
      if (canonicalAgentKind(record.agent).toLowerCase() !== "claude") continue;
      const observation = hsrObservations.get(record.name);
      const events = observation?.live ? observation.eventSnapshot?.events : undefined;
      const authEvent = events ? lastAuthNeededEvent(events) : undefined;
      if (!events || !authEvent) continue; // structured evidence only; ambiguity stays human-owned
      const generation = record.runtimeGeneration ?? 0;

      const existing = await readState(record.name);
      // A persisted stop is intentionally sticky for this exact auth event,
      // including across daemon restarts. A later successful-turn incident can
      // reset it through planAuthRecovery below.
      if (existing?.status === "stopped" && existing.incidentAuthTs === authEvent.ts) continue;

      const plan = planAuthRecovery({
        state: existing,
        events,
        authEventTs: authEvent.ts,
        generation,
        nowMs,
        backoffMs: deps.backoffMs,
        maxAttempts: deps.maxAttempts,
      });
      if (plan.action === "defer") continue;
      if (plan.action === "hard-stop") {
        await writeState(record.name, plan.state);
        await ledger({
          type: "bee.auth_auto_recovery",
          action: "hard-stop",
          session: record.name,
          generation,
          attempts: plan.state.attempts,
          reason: plan.reason,
        });
        outcomes.push({ bee: record.name, action: "hard-stop", generation, reason: plan.reason });
        continue;
      }

      const stop = async (reason: string, action: "blocked" | "failed", error?: string): Promise<void> => {
        const stopped = { ...plan.state, status: "stopped" as const, stopReason: reason };
        await writeState(record.name, stopped);
        await ledger({
          type: "bee.auth_auto_recovery",
          action,
          session: record.name,
          generation,
          attempt: plan.attempt,
          reason,
          ...(error ? { error } : {}),
        });
        outcomes.push({
          bee: record.name,
          action,
          generation,
          attempt: plan.attempt,
          reason,
          ...(error ? { error } : {}),
        });
      };

      if (!record.accountId || !record.homePath || !record.providerSessionId) {
        await stop("missing-bound-account-home-or-session", "blocked");
        continue;
      }
      let account: AccountRecord;
      try {
        account = await resolveAccount(record.accountId, "claude");
      } catch (error) {
        await stop("bound-account-not-found", "blocked", error instanceof Error ? error.message : String(error));
        continue;
      }
      const expectedEmail = accountEmail(account)?.toLowerCase();
      const actualEmail = (await readHomeEmail(record.homePath).catch(() => null))?.toLowerCase();
      if (expectedEmail && actualEmail && expectedEmail !== actualEmail) {
        await stop("home-account-identity-mismatch", "blocked");
        continue;
      }
      const credentialPlan = await planCredentials(account, record.homePath, { now: () => nowMs });
      if (!credentialPlan.ready) {
        await stop(
          `credentials-${credentialPlan.reason}:home-${credentialPlan.homeReason}:vault-${credentialPlan.vaultReason}`,
          "blocked",
        );
        continue;
      }

      // Count the attempt before stop/revive. A daemon crash cannot erase an
      // already-started restart and turn it into an unbounded retry loop.
      await writeState(record.name, plan.state);
      await ledger({
        type: "bee.auth_auto_recovery",
        action: "attempt",
        session: record.name,
        generation,
        attempt: plan.attempt,
        credentialSource: credentialPlan.source,
      });
      try {
        const result = await recover(record, account, {
          source: "auto",
          attempt: plan.attempt,
          events,
          activateCredentials: credentialPlan.source === "vault",
        });
        await writeState(record.name, { ...plan.state, status: "recovered" });
        await ledger({
          type: "bee.auth_auto_recovery",
          action: "recovered",
          session: record.name,
          generation,
          attempt: plan.attempt,
          credentialSource: credentialPlan.source,
          replayedPrompts: result.replayedPrompts,
          promptSource: result.promptSource,
        });
        outcomes.push({
          bee: record.name,
          action: "recovered",
          generation,
          attempt: plan.attempt,
          credentialSource: credentialPlan.source,
          replayedPrompts: result.replayedPrompts,
          promptSource: result.promptSource,
        });
      } catch (error) {
        await stop("recovery-operation-failed", "failed", error instanceof Error ? error.message : String(error));
      }
    }
    return outcomes;
  };
}
