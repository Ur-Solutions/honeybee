import { resolve } from "node:path";
import { listAccounts, type AccountRecord } from "../accounts.js";
import {
  readClaudeRotationStrandedMarker,
  removeClaudeRotationStrandedHome,
  type ClaudeRotationStrandedMarker,
} from "../accounts/claudeChain.js";
import {
  planClaudeRecoveryCredentials,
  type ClaudeRecoveryCredentialPlan,
} from "../accounts/credentialHealth.js";
import { canonicalAgentKind } from "../agents.js";
import { recoverAuthNeededBee } from "../commands/migrate.js";
import { rotationResumeEnabled } from "../config.js";
import type { HsrObservation } from "../hsr/observe.js";
import type { BeeState } from "../state.js";
import { appendLedger } from "../store.js";
import type { SessionRecord } from "../store.js";
import {
  planAuthRecovery,
  readAttemptStateFile,
  writeAttemptStateFile,
  type AuthRecoveryAttemptState,
} from "./authRecovery.js";

const STATE_FILE = "rotation-auto-resume.json";

export type RotationResumeOutcome = {
  bee: string;
  account: string;
  action: "resumed" | "blocked" | "failed" | "hard-stop";
  attempt?: number;
  generation: number;
  replayedPrompts?: number;
  reason?: string;
  error?: string;
};

export type RotationResumeDeps = {
  enabled?: () => boolean;
  listClaudeAccounts?: () => Promise<AccountRecord[]>;
  readMarker?: (account: AccountRecord) => Promise<ClaudeRotationStrandedMarker | null>;
  removeMarkerHome?: (account: AccountRecord, homePath: string) => Promise<void>;
  readState?: (bee: string) => Promise<AuthRecoveryAttemptState | null>;
  writeState?: (bee: string, state: AuthRecoveryAttemptState) => Promise<void>;
  planCredentials?: (
    account: AccountRecord,
    homePath: string,
    options?: { now?: () => number },
  ) => Promise<ClaudeRecoveryCredentialPlan>;
  recover?: typeof recoverAuthNeededBee;
  ledger?: typeof appendLedger;
  backoffMs?: number;
  maxAttempts?: number;
};

// A bee is only resumed between turns. Mid-turn bees keep the marker pending;
// auth-needed bees belong to the classifier-driven authRecovery lane.
const IDLE_STATES: ReadonlySet<BeeState> = new Set(["idle_with_output", "ready"]);

/**
 * Post-rotation resume for stranded homes (2026-08-10 incident, root cause 3):
 * a central chain rotation that could NOT advance a home's keychain copy
 * leaves any live claude booted on that home holding a rotated-away refresh
 * token — its next refresh fails (and replaying the old token risks
 * provider-side family revocation, the 2026-08-08 shape). The distribution
 * records those homes in a per-account rotation-stranded marker; this
 * dispatcher auth-resumes idle live bees bound to them so the failure never
 * has to surface as an error at all. Scoped deliberately: fully-propagated
 * homes need no restart (claude picks the fresh chain from its keychain), so
 * restarting their bees would be pure churn.
 */
export function createRotationResumeDispatcher(deps: RotationResumeDeps = {}): (
  records: SessionRecord[],
  currentStates: Map<string, BeeState>,
  hsrObservations: ReadonlyMap<string, HsrObservation>,
  nowMs: number,
) => Promise<RotationResumeOutcome[]> {
  const enabled = deps.enabled ?? rotationResumeEnabled;
  const listClaudeAccounts = deps.listClaudeAccounts
    ?? (async () => (await listAccounts()).filter((account) => account.tool === "claude"));
  const readMarker = deps.readMarker ?? readClaudeRotationStrandedMarker;
  const removeMarkerHome = deps.removeMarkerHome ?? removeClaudeRotationStrandedHome;
  const readState = deps.readState ?? ((bee: string) => readAttemptStateFile(bee, STATE_FILE));
  const writeState = deps.writeState ?? ((bee: string, state: AuthRecoveryAttemptState) => writeAttemptStateFile(bee, STATE_FILE, state));
  const planCredentials = deps.planCredentials ?? planClaudeRecoveryCredentials;
  const recover = deps.recover ?? recoverAuthNeededBee;
  const ledger = deps.ledger ?? appendLedger;

  return async (records, currentStates, hsrObservations, nowMs) => {
    const outcomes: RotationResumeOutcome[] = [];
    if (!enabled()) return outcomes;
    let accounts: AccountRecord[];
    try {
      accounts = await listClaudeAccounts();
    } catch {
      return outcomes;
    }
    for (const account of accounts) {
      const marker = await readMarker(account).catch(() => null);
      if (!marker || marker.strandedHomes.length === 0) continue;
      const strandedHomes = new Set(marker.strandedHomes.map((home) => resolve(home)));
      for (const record of records) {
        if (record.substrate !== "hsr") continue;
        if (canonicalAgentKind(record.agent).toLowerCase() !== "claude") continue;
        if (record.accountId !== account.id) continue;
        if (!record.homePath || !strandedHomes.has(resolve(record.homePath))) continue;
        if (!record.providerSessionId) continue;
        const observation = hsrObservations.get(record.name);
        if (!observation?.live) continue;
        const state = currentStates.get(record.name);
        if (state === undefined || !IDLE_STATES.has(state)) continue;
        const generation = record.runtimeGeneration ?? 0;
        const events = observation.eventSnapshot?.events ?? [];

        let existing = await readState(record.name);
        // A rotation marker has no matching runner event, so planAuthRecovery's
        // intervening-turn reset can never fire from event inspection. Reset
        // here instead: any completed turn after the last resume proves the bee
        // came back healthy, so a later rotation starts a fresh incident
        // instead of inheriting a stale attempt count toward the cap.
        if (
          existing?.lastAttemptAt !== undefined &&
          events.some((event) => event.type === "turn_end" && event.ts > existing!.lastAttemptAt!)
        ) {
          existing = null;
        }
        if (existing?.status === "stopped" && existing.incidentAuthTs === marker.rotatedAt) continue;

        const plan = planAuthRecovery({
          state: existing,
          events,
          authEventTs: marker.rotatedAt,
          generation,
          nowMs,
          backoffMs: deps.backoffMs,
          maxAttempts: deps.maxAttempts,
        });
        if (plan.action === "defer") continue;
        if (plan.action === "hard-stop") {
          await writeState(record.name, plan.state);
          await ledger({
            type: "bee.rotation_resume",
            action: "hard-stop",
            session: record.name,
            account: account.id,
            generation,
            attempts: plan.state.attempts,
            reason: plan.reason,
          });
          outcomes.push({ bee: record.name, account: account.id, action: "hard-stop", generation, reason: plan.reason });
          continue;
        }

        const stop = async (reason: string, action: "blocked" | "failed", error?: string): Promise<void> => {
          await writeState(record.name, { ...plan.state, status: "stopped", stopReason: reason });
          await ledger({
            type: "bee.rotation_resume",
            action,
            session: record.name,
            account: account.id,
            generation,
            attempt: plan.attempt,
            reason,
            ...(error ? { error } : {}),
          });
          outcomes.push({
            bee: record.name,
            account: account.id,
            action,
            generation,
            attempt: plan.attempt,
            reason,
            ...(error ? { error } : {}),
          });
        };

        const credentialPlan = await planCredentials(account, record.homePath, { now: () => nowMs });
        if (!credentialPlan.ready) {
          await stop(
            `credentials-${credentialPlan.reason}:home-${credentialPlan.homeReason}:vault-${credentialPlan.vaultReason}`,
            "blocked",
          );
          continue;
        }

        // Count the attempt before the restart — a daemon crash mid-resume
        // must not turn into an unbounded restart loop.
        await writeState(record.name, plan.state);
        await ledger({
          type: "bee.rotation_resume",
          action: "attempt",
          session: record.name,
          account: account.id,
          generation,
          attempt: plan.attempt,
        });
        try {
          // Always activate: the point is a stale KEYCHAIN entry, and only
          // activation re-stamps it (a merely-ready home file is not enough —
          // claude prefers the keychain).
          const result = await recover(record, account, {
            source: "auto",
            attempt: plan.attempt,
            events,
            activateCredentials: true,
          });
          await writeState(record.name, { ...plan.state, status: "recovered" });
          // Swallowed removal failure is safe but not free: the marker keeps
          // the home, and once the resumed bee completes a turn the turn_end
          // reset above re-arms its attempt budget, so it can be resumed
          // again. Bounded by rotation cadence (the next full propagation
          // clears the marker), so accepted over failing a successful resume.
          await removeMarkerHome(account, record.homePath).catch(() => undefined);
          await ledger({
            type: "bee.rotation_resume",
            action: "resumed",
            session: record.name,
            account: account.id,
            generation,
            attempt: plan.attempt,
            replayedPrompts: result.replayedPrompts,
          });
          outcomes.push({
            bee: record.name,
            account: account.id,
            action: "resumed",
            generation,
            attempt: plan.attempt,
            replayedPrompts: result.replayedPrompts,
          });
        } catch (error) {
          await stop("resume-operation-failed", "failed", error instanceof Error ? error.message : String(error));
        }
      }
    }
    return outcomes;
  };
}
