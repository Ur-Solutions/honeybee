// Buz queue dispatcher (tier-B drain).
//
// Every tick, queued mail drains into an idle runtime. Runtime recovery is a
// separate detached dispatcher (buzRecovery.ts): credential activation and
// provider spawn must never run inline with queue draining or the tick budget.
//
// Triggering on the current state (not just the active->idle_with_output
// transition) matters: a message queued while the recipient is ALREADY idle
// must not wait for the bee to become active again, and after a daemon
// restart the first observation (from === undefined) must still drain idle
// bees with queued messages.
//
// Drain behavior is implemented in buz.processQueueForBee. This module is
// the thin daemon seam: it selects the bees to drain, resolves substrates
// from the daemon substrate cache (substrateFor), and calls
// processQueueForBee with stopOnFirstFailure so a broken substrate cannot
// burn through every queued message in a single tick.
//
// Per-bee locking is enforced inside processQueueForBee (withFileLock on
// the per-bee delivery lock), so racing drains for the same bee serialize
// safely without blocking concurrent senders' mailbox writes.

import { readdir } from "node:fs/promises";
import {
  beeMailboxDir,
  clearMessageRecovery,
  listMessages,
  processQueueForBee,
  type DrainResult,
} from "../buz.js";
import { withRunnableSessionAdmission } from "../delivery.js";
import type { BeeState } from "../state.js";
import { isRunnableSessionRecord } from "../stateMachine.js";
import type { SessionRecord } from "../store.js";
import { substrateFor, type Substrate } from "../substrates/index.js";
import { envConcurrency, mapWithConcurrency } from "./concurrency.js";
import type { TickTransition } from "./tick.js";
import { envMs } from "./timeouts.js";

const DEFAULT_BUZ_MAILBOX_CONCURRENCY = 16;
const DEFAULT_BUZ_DRAIN_CONCURRENCY = 8;
const DEFAULT_BUZ_STALE_AFTER_MS = 10 * 60_000;
const DEFAULT_BUZ_STALE_SCAN_INTERVAL_MS = 60_000;
export const DEFAULT_BUZ_ILLEGAL_TRANSITION_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

export type BuzDispatchTrigger = {
  record: SessionRecord;
  action: "drain" | "ensure";
  /** The transition that accompanied this tick's observation, if any. */
  transition?: TickTransition;
};

export type BuzDispatchOutcome = {
  recipient: string;
  result: DrainResult;
  /** Present only on the actual failed attempt; suppressed ticks emit nothing. */
  illegalTransitionBackoff?: { attempt: number; retryAt: string };
  /** Operator diagnostic; deliberately separate from bee/task state. */
  staleQueue?: StaleBuzQueue & { newlyStale: boolean };
  /** A best-effort staleness scan failure must never fail normal delivery. */
  diagnosticError?: string;
};

export type StaleBuzQueue = {
  recipient: string;
  count: number;
  oldestSentAt: string;
  ageMs: number;
};

export type BuzDispatchDeps = {
  /**
   * Resolve a substrate for the given session record. Defaults to
   * substrateFor (the daemon-shared substrate cache). Injectable for tests.
   */
  resolveSubstrate?: (record: SessionRecord) => Substrate;
  /**
   * Run a single drain. Defaults to processQueueForBee. Injectable for
   * tests that want to observe drain inputs without exercising the buz
   * storage layer.
   */
  drain?: typeof processQueueForBee;
  /**
   * Probe whether a bee has queued messages. Defaults to a readdir on the
   * bee's queue/ mailbox. Injectable for tests.
   */
  hasQueuedMessages?: (record: SessionRecord) => Promise<boolean>;
  /**
   * This tick's freshly derived state per bee (the daemon's `observed` map).
   * When provided it is the authoritative current state — the persisted
   * `record.lastObservedState` is only a fallback, because that field is the
   * PREVIOUS tick's value and goes stale whenever its touchSession write
   * failed (those errors are deliberately non-fatal in the tick loop).
   */
  currentStates?: ReadonlyMap<string, string>;
  /** Maximum concurrent queue readdir probes. */
  mailboxConcurrency?: number;
  /** Maximum concurrent per-bee drain attempts. Per-bee locks still serialize same-bee drains. */
  drainConcurrency?: number;
};

export type BuzStalenessDeps = {
  now?: () => number;
  staleAfterMs?: number;
  scanIntervalMs?: number;
  mailboxConcurrency?: number;
  listQueue?: (record: SessionRecord) => ReturnType<typeof listMessages>;
  /** @internal deterministic schedule override for tests. */
  illegalTransitionBackoffMs?: readonly number[];
};

type IllegalTransitionBackoff = {
  attempt: number;
  retryAtMs: number;
  signature: string;
};

function illegalTransitionError(result: DrainResult): DrainResult["errors"][number] | undefined {
  return result.errors.find((error) => error.code === "ILLEGAL_BEE_TRANSITION");
}

function illegalTransitionDelayMs(attempt: number, schedule: readonly number[]): number {
  const fallback = DEFAULT_BUZ_ILLEGAL_TRANSITION_BACKOFF_MS;
  const bounded = schedule.length > 0 ? schedule : fallback;
  return bounded[Math.min(Math.max(0, attempt - 1), bounded.length - 1)]!;
}

/**
 * Stateful daemon-facing dispatcher: normal queue draining plus a throttled
 * scan for old queued mail. Warnings
 * remain in every TickResult (so daemon status can surface them), while
 * `newlyStale` only fires on an edge/change to avoid log spam.
 */
export function createBuzDrainDispatcher(
  deps: BuzDispatchDeps & BuzStalenessDeps = {},
): (
  records: SessionRecord[],
  transitions: TickTransition[],
  currentStates: Map<string, BeeState>,
) => Promise<BuzDispatchOutcome[]> {
  const now = deps.now ?? (() => Date.now());
  const staleAfterMs =
    deps.staleAfterMs ??
    envMs("HIVE_BUZ_STALE_AFTER_MS", DEFAULT_BUZ_STALE_AFTER_MS);
  const scanIntervalMs =
    deps.scanIntervalMs ??
    envMs("HIVE_BUZ_STALE_SCAN_INTERVAL_MS", DEFAULT_BUZ_STALE_SCAN_INTERVAL_MS);
  let lastScanAt = Number.NEGATIVE_INFINITY;
  let warnings: StaleBuzQueue[] = [];
  let previousKeys = new Map<string, string>();
  // Daemon-lifetime recipient circuit breaker. transitionSession already
  // audits the rejected edge; suppressing identical drain attempts between
  // these bounded retries keeps that ledger proof to one row per attempt,
  // rather than one row per daemon tick.
  const illegalBackoffs = new Map<string, IllegalTransitionBackoff>();
  const illegalSchedule = deps.illegalTransitionBackoffMs ?? DEFAULT_BUZ_ILLEGAL_TRANSITION_BACKOFF_MS;
  return async (records, transitions, currentStates) => {
    const present = new Set(records.map((record) => record.name));
    for (const recipient of illegalBackoffs.keys()) {
      if (!present.has(recipient)) illegalBackoffs.delete(recipient);
    }
    const drainNowMs = now();
    const drainableRecords = records.filter((record) => {
      const backoff = illegalBackoffs.get(record.name);
      return !backoff || backoff.retryAtMs <= drainNowMs;
    });
    const drained = await dispatchBuzDrains(drainableRecords, transitions, {
      ...deps,
      currentStates,
    });
    const attempted = new Set(drained.map((outcome) => outcome.recipient));
    for (const outcome of drained) {
      const illegal = illegalTransitionError(outcome.result);
      if (!illegal) {
        illegalBackoffs.delete(outcome.recipient);
        continue;
      }
      const signature = `${illegal.code}:${illegal.message}`;
      const previous = illegalBackoffs.get(outcome.recipient);
      const attempt = previous?.signature === signature ? previous.attempt + 1 : 1;
      const retryAtMs = drainNowMs + illegalTransitionDelayMs(attempt, illegalSchedule);
      illegalBackoffs.set(outcome.recipient, { attempt, retryAtMs, signature });
      outcome.illegalTransitionBackoff = { attempt, retryAt: new Date(retryAtMs).toISOString() };
    }
    for (const record of drainableRecords) {
      if (!attempted.has(record.name)) illegalBackoffs.delete(record.name);
    }
    const nowMs = now();
    let newlyStale = new Set<string>();
    if (nowMs - lastScanAt >= scanIntervalMs) {
      lastScanAt = nowMs;
      try {
        warnings = await findStaleBuzQueues(records, {
          now: () => nowMs,
          staleAfterMs,
          mailboxConcurrency: deps.mailboxConcurrency,
          listQueue: deps.listQueue,
        });
        const nextKeys = new Map<string, string>();
        newlyStale = new Set(
          warnings
            .filter((warning) => {
              const key = `${warning.count}:${warning.oldestSentAt}`;
              nextKeys.set(warning.recipient, key);
              return previousKeys.get(warning.recipient) !== key;
            })
            .map((warning) => warning.recipient),
        );
        previousKeys = nextKeys;
      } catch (error) {
        return [
          ...drained,
          ...warnings.map((warning) => ({
            recipient: warning.recipient,
            result: { delivered: [], quarantined: [], errors: [] },
            staleQueue: { ...warning, newlyStale: false },
          })),
          {
            recipient: "<staleness-scan>",
            result: { delivered: [], quarantined: [], errors: [] },
            diagnosticError: error instanceof Error ? error.message : String(error),
          },
        ];
      }
    }

    return [
      ...drained,
      ...warnings.map((warning) => ({
        recipient: warning.recipient,
        result: { delivered: [], quarantined: [], errors: [] },
        staleQueue: {
          ...warning,
          newlyStale: newlyStale.has(warning.recipient),
        },
      })),
    ];
  };
}

export async function findStaleBuzQueues(
  records: SessionRecord[],
  deps: Pick<
    BuzStalenessDeps,
    "now" | "staleAfterMs" | "mailboxConcurrency" | "listQueue"
  > = {},
): Promise<StaleBuzQueue[]> {
  const nowMs = (deps.now ?? (() => Date.now()))();
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_BUZ_STALE_AFTER_MS;
  const listQueue =
    deps.listQueue ??
    ((record: SessionRecord) => listMessages(record.name, "queue"));
  const candidates = records.filter(buzRecipientIsSendable);
  const scanned = await mapWithConcurrency(
    candidates,
    deps.mailboxConcurrency ??
      envConcurrency("HIVE_BUZ_MAILBOX_CONCURRENCY", DEFAULT_BUZ_MAILBOX_CONCURRENCY),
    async (record): Promise<StaleBuzQueue | null> => {
      const queued = await listQueue(record);
      if (queued.length === 0) return null;
      const oldestSentAt = queued.at(-1)!.message.sentAt;
      const oldestMs = Date.parse(oldestSentAt);
      if (!Number.isFinite(oldestMs)) return null;
      const ageMs = Math.max(0, nowMs - oldestMs);
      if (ageMs < staleAfterMs) return null;
      return {
        recipient: record.name,
        count: queued.length,
        oldestSentAt,
        ageMs,
      };
    },
  );
  return scanned
    .filter((warning): warning is StaleBuzQueue => warning !== null)
    .sort((a, b) => b.ageMs - a.ageMs || a.recipient.localeCompare(b.recipient));
}

function buzRecipientIsSendable(record: SessionRecord): boolean {
  // `kill_failed` carries unresolved explicit stop intent. Exact observation
  // may continue elsewhere, but queue draining is new work admission and must
  // remain fenced regardless of apparent liveness.
  return isRunnableSessionRecord(record);
}

/**
 * Select sendable bees with queued mail. Ready/idle runtimes drain directly;
 * terminal-looking and kill_failed records get one explicit liveness check.
 *
 * The current state is taken from `currentStates` (this tick's derived
 * states) when supplied; otherwise the transition target when the bee
 * transitioned this tick (including first observations, where from ===
 * undefined), otherwise the lastObservedState persisted by the previous
 * tick. The non-empty-queue check keeps the steady state cheap: one readdir
 * per idle bee per tick, and only bees with pending messages take the
 * per-bee drain lock.
 */
export async function selectBuzDispatchTriggers(
  records: SessionRecord[],
  transitions: TickTransition[],
  hasQueuedMessages: (record: SessionRecord) => Promise<boolean> = defaultHasQueuedMessages,
  currentStates?: ReadonlyMap<string, string>,
  mailboxConcurrency = envConcurrency("HIVE_BUZ_MAILBOX_CONCURRENCY", DEFAULT_BUZ_MAILBOX_CONCURRENCY),
): Promise<BuzDispatchTrigger[]> {
  const byName = new Map<string, TickTransition>();
  for (const transition of transitions) byName.set(transition.name, transition);
  const candidates: BuzDispatchTrigger[] = [];
  for (const record of records) {
    const transition = byName.get(record.name);
    const current = currentStates?.has(record.name)
      ? currentStates.get(record.name)
      : transition
        ? transition.to
        : record.lastObservedState;
    if (!buzRecipientIsSendable(record)) continue;
    let action: BuzDispatchTrigger["action"] | undefined;
    if (current === "idle_with_output" || current === "ready") action = "drain";
    // A seal ends work but does not archive the Bee. Its process may be hot or
    // cold, so the dispatcher probes before choosing drain/wake.
    else if (current === "done") action = "ensure";
    if (!action) continue;
    candidates.push({ record, action, ...(transition ? { transition } : {}) });
  }
  const checked = await mapWithConcurrency(candidates, mailboxConcurrency, async (trigger) => (
    await hasQueuedMessages(trigger.record) ? trigger : null
  ));
  return checked.filter((trigger): trigger is BuzDispatchTrigger => trigger !== null);
}

async function defaultHasQueuedMessages(record: SessionRecord): Promise<boolean> {
  // ENOENT means the bee has never received queued mail — legitimately empty.
  // Any other fs error must surface (the tick captures it into recentErrors)
  // instead of silently reading as "no messages" and stalling deliveries.
  const entries = await readdir(beeMailboxDir(record.name, "queue")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [] as string[];
    throw error;
  });
  return entries.some((name) => name.endsWith(".md"));
}

/**
 * Drain every sendable live bee with actionable queued mail. Errors
 * from a single recipient do not abort the dispatcher —
 * each bee's drain runs independently and any thrown error is captured into
 * the returned outcomes (via a synthetic empty DrainResult with errors[]).
 */
export async function dispatchBuzDrains(
  records: SessionRecord[],
  transitions: TickTransition[],
  deps: BuzDispatchDeps = {},
): Promise<BuzDispatchOutcome[]> {
  const triggers = await selectBuzDispatchTriggers(records, transitions, deps.hasQueuedMessages, deps.currentStates, deps.mailboxConcurrency);
  if (triggers.length === 0) return [];

  const resolveSubstrate = deps.resolveSubstrate ?? substrateFor;
  const drain = deps.drain ?? processQueueForBee;
  const drainConcurrency = deps.drainConcurrency ?? envConcurrency("HIVE_BUZ_DRAIN_CONCURRENCY", DEFAULT_BUZ_DRAIN_CONCURRENCY);

  return mapWithConcurrency(triggers, drainConcurrency, async (trigger) => {
    const { record } = trigger;
    try {
      const result = await withRunnableSessionAdmission(record, async (_lifecycle, current) => {
        const substrate = resolveSubstrate(current);
        if (trigger.action === "ensure" && !(await substrate.hasSession(current.tmuxTarget))) {
          return { delivered: [], quarantined: [], errors: [] };
        }
        return drain(current, {
          transport: { substrate, tmuxTarget: current.tmuxTarget, agentPaneId: current.agentPaneId },
          stopOnFirstFailure: true,
          deferRecoveryClear: true,
          // One message per idle observation: the delivered message starts a new
          // turn; the rest of the queue waits for the next idle_with_output tick.
          deliverLimit: 1,
        });
      });
      // Recovery settlement acquires lifecycle itself, so do it only after the
      // admission lock above has released.
      for (const messageId of result.delivered) {
        await clearMessageRecovery(record.name, messageId, { resolveRequestBy: "buz-delivery" }).catch(() => undefined);
      }
      return { recipient: record.name, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof (error as { code?: unknown } | null)?.code === "string"
        ? (error as { code: string }).code
        : undefined;
      return {
        recipient: record.name,
        result: {
          delivered: [],
          quarantined: [],
          errors: [{ id: record.name, message, ...(code ? { code } : {}) }],
        },
      };
    }
  });
}
