// Durable InterventionRequest reconciler (docs/INTERVENTION_REQUESTS.md).
//
// Runs immediately before credential-aware auth recovery and needs-input
// routing: it folds
// this tick's TRUSTED observations into the request store so the dispatcher
// (and BeeView) read durable records instead of re-deriving. Per tick it:
//
//   opens    — structured needs_input / unbounded auth for LIVE observed HSR
//              (or mirrored) bees; the stop-failed manual action for records
//              persisted as kill_failed (recorded stop intent is a fact);
//   resolves — open auth requests whose grounding event is now bounded by an
//              auth_resume in the events tail;
//   cancels  — turn-scope requests whose turn ended without an answer
//              ("turn ended"), everything from generations the runtime
//              trustedly exited ("generation exited"), earlier-generation
//              opens after an incarnation bump ("superseded ..."), and all
//              opens on a retired record ("retired") — the backstops for CLI
//              verbs that ran while the daemon was down.
//
// Guard rails (ADR 001 invariant 2): a bee in this tick's hsrUnavailable set
// is skipped entirely (ZERO writes — a failed observation batch is unknown,
// not evidence); the registry entry only runs the stage when the sessions
// snapshot is trusted; and a missing observation never drives a transition —
// generation-exit is concluded only from an actually-read run dir (obs
// present, host pid dead). tmux runtimes deliberately have no reconciler exit
// signal: an empty liveTargets set is indistinguishable from a failed probe,
// so their closures land via retire/kill/revive or the backstops above.
//
// Stateful across ticks (build once per daemon run): a boot-tick readdir
// seeds an ADVISORY cache (bee → open ids + oldest open generation) so
// steady-state ticks touch a bee only when evidence or the cache says there
// is something to do — every actual mutation re-reads under the store lock.
// Never throws; per-bee errors are captured into the outcome array
// (needsInput.ts style). Restart-safe by construction: openRequest's
// idempotency-across-all-statuses means a fresh reconciler re-deriving the
// same evidence cannot re-open anything a human or a scope change closed.

import type { HsrObservation } from "../hsr/observe.js";
import { isArchivedSessionLifecycle } from "../stateMachine.js";
import { authRequestId, needsInputRequestId, stopFailedRequestId } from "../requests/keys.js";
import {
  cancelOpenRequests,
  cancelRequest,
  listBeesWithRequests,
  openRequest,
  readBeeRequests,
  resolveRequest,
  type InterventionRequestRecord,
  type OpenRequestInput,
} from "../requests/store.js";
import { lastAuthNeededEvent } from "../view/requests.js";
import type { BeeState } from "../state.js";
import type { SessionRecord } from "../store.js";

export type RequestReconcileOutcome = {
  bee: string;
  id: string;
  action: "open" | "resolve" | "cancel" | "error";
  /** Cancel reason / resolve by / open kind — one word for the daemon log. */
  detail?: string;
  error?: string;
};

export type RequestReconcileInput = {
  records: SessionRecord[];
  /** This tick's freshly derived state per bee (authoritative current state). */
  currentStates: Map<string, BeeState>;
  hsrObservations: ReadonlyMap<string, HsrObservation>;
  /** Bees whose observation batch failed this tick — skipped with ZERO writes. */
  hsrUnavailable: ReadonlySet<string>;
};

export type RequestReconciler = (input: RequestReconcileInput) => Promise<RequestReconcileOutcome[]>;

type CacheEntry = {
  openIds: Set<string>;
  /** Oldest generation among the open records (steady-state skip condition d). */
  minOpenGeneration: number;
};

function cacheEntryFor(requests: InterventionRequestRecord[]): CacheEntry {
  const open = requests.filter((request) => request.status === "open");
  return {
    openIds: new Set(open.map((request) => request.id)),
    minOpenGeneration: open.reduce((min, request) => Math.min(min, request.generation), Number.POSITIVE_INFINITY),
  };
}

function isoFromEpochMs(ts: number): string | undefined {
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : undefined;
}

export function createRequestReconciler(): RequestReconciler {
  // Advisory only — seeded from one readdir on the boot tick; every mutation
  // re-reads under the store's file lock.
  let cache: Map<string, CacheEntry> | null = null;

  async function seedCache(): Promise<Map<string, CacheEntry>> {
    const seeded = new Map<string, CacheEntry>();
    for (const stem of await listBeesWithRequests()) {
      // The stem is safeName(bee); the records carry the true bee name.
      const requests = await readBeeRequests(stem).catch(() => [] as InterventionRequestRecord[]);
      if (requests.length === 0) continue;
      seeded.set(requests[0]!.bee, cacheEntryFor(requests));
    }
    return seeded;
  }

  async function reconcileBee(
    record: SessionRecord,
    obs: HsrObservation | undefined,
    outcomes: RequestReconcileOutcome[],
    knownCache: Map<string, CacheEntry>,
  ): Promise<void> {
    const bee = record.name;
    const generation = record.runtimeGeneration ?? 0;
    const cached = knownCache.get(bee);
    const snapshot = obs?.eventSnapshot;
    const live = obs?.live === true;
    const pending = live ? snapshot?.pendingNeedsInput ?? null : null;
    const authEvent = live ? lastAuthNeededEvent(snapshot?.events ?? []) : undefined;

    // Steady-state zero-IO skip: touch a bee only when (a) the snapshot shows
    // pending needs_input or unbounded auth, (b) the cache says open records
    // exist, or (c) the record is kill_failed. (A generation moved past a
    // cached open record is covered by (b).)
    const shouldTouch =
      pending !== null ||
      authEvent !== undefined ||
      (cached !== undefined && cached.openIds.size > 0) ||
      record.status === "kill_failed";
    if (!shouldTouch) return;

    let requests = await readBeeRequests(bee);
    let mutated = false;
    const byId = () => new Map(requests.map((request) => [request.id, request]));

    const emit = (id: string, action: "open" | "resolve" | "cancel", detail?: string) => {
      outcomes.push({ bee, id, action, ...(detail !== undefined ? { detail } : {}) });
      mutated = true;
    };

    // 1. Retired backstop: a filed record closes everything; nothing re-opens.
    if (isArchivedSessionLifecycle(record)) {
      for (const cancelled of await cancelOpenRequests(bee, {}, "scope-closed", "retired")) {
        emit(cancelled.id, "cancel", "retired");
      }
      knownCache.set(bee, { openIds: new Set(), minOpenGeneration: Number.POSITIVE_INFINITY });
      return;
    }

    // 2. Superseded backstop: an incarnation bump that happened while the
    //    daemon was down (record.runtimeGeneration moved past open records).
    for (const cancelled of await cancelOpenRequests(
      bee,
      { beforeGeneration: generation, scopes: ["turn", "runtime-generation"] },
      "superseded",
      `superseded by generation ${generation}`,
    )) {
      emit(cancelled.id, "cancel", "superseded");
    }

    // 3. Opens — only from this tick's LIVE observation (a dead runner's stale
    //    events must not open anything), except stop-failed, whose source is
    //    the persisted record itself.
    if (pending !== null) {
      const openedAt = isoFromEpochMs(pending.ts);
      const input: OpenRequestInput = {
        id: needsInputRequestId(bee, pending),
        kind: pending.kind,
        scope: "turn",
        grade: "structured",
        generation,
        ...(openedAt !== undefined ? { openedAt } : {}),
        question: pending.question,
        ...(pending.tool !== undefined ? { tool: pending.tool } : {}),
        ...(pending.options !== undefined ? { options: pending.options } : {}),
        ...(pending.optionDetails !== undefined ? { optionDetails: pending.optionDetails } : {}),
        ...(pending.questions !== undefined ? { questions: pending.questions } : {}),
        ...(pending.multiSelect !== undefined ? { multiSelect: pending.multiSelect } : {}),
        ...(pending.input !== undefined ? { input: pending.input } : {}),
        evidence: { grade: "structured", source: "hsr-events", ...(openedAt !== undefined ? { observedAt: openedAt } : {}), detail: "needs_input" },
      };
      if ((await openRequest(bee, input)).created) emit(input.id, "open", pending.kind);
    }
    if (authEvent !== undefined) {
      const openedAt = isoFromEpochMs(authEvent.ts);
      const input: OpenRequestInput = {
        id: authRequestId(bee, authEvent.ts),
        kind: "auth",
        scope: "runtime-generation",
        grade: "structured",
        generation,
        ...(openedAt !== undefined ? { openedAt } : {}),
        question: authEvent.type === "error" ? authEvent.message : "login required",
        evidence: { grade: "structured", source: "hsr-events", ...(openedAt !== undefined ? { observedAt: openedAt } : {}), detail: authEvent.type },
      };
      if ((await openRequest(bee, input)).created) emit(input.id, "open", "auth");
    }
    if (record.status === "kill_failed") {
      const input: OpenRequestInput = {
        id: stopFailedRequestId(bee, generation),
        kind: "manual-action",
        scope: "runtime-generation",
        grade: "structured",
        generation,
        question: `stop failed: ${record.lastError ?? "session still exists after kill"}`,
        evidence: { grade: "structured", source: "session-record", detail: "kill_failed" },
      };
      if ((await openRequest(bee, input)).created) emit(input.id, "open", "manual-action");
    }

    if (mutated) requests = await readBeeRequests(bee);

    // 4. Resolve auth bounded by auth_resume in this tick's events tail.
    if (snapshot !== undefined) {
      const resumes = snapshot.events.filter((event) => event.type === "auth_resume");
      for (const request of byId().values()) {
        if (request.status !== "open" || request.kind !== "auth") continue;
        const groundedAt = Date.parse(request.openedAt);
        if (!Number.isFinite(groundedAt)) continue;
        if (!resumes.some((event) => event.ts >= groundedAt)) continue;
        if (await resolveRequest(bee, request.id, { by: "auth-resume" })) emit(request.id, "resolve", "auth-resume");
      }
    }

    // 5. Turn-scope closure: the request is open but the LIVE snapshot no
    //    longer derives it as pending (a turn_end bounded it, unanswered).
    if (live && snapshot !== undefined) {
      const pendingId = pending !== null ? needsInputRequestId(bee, pending) : null;
      for (const request of byId().values()) {
        if (request.status !== "open" || request.scope !== "turn") continue;
        if (request.kind !== "question" && request.kind !== "permission") continue;
        if (request.generation !== generation) continue; // older gens close as superseded/exited
        if (request.id === pendingId) continue;
        if (await cancelRequest(bee, request.id, "scope-closed", "turn ended")) emit(request.id, "cancel", "turn ended");
      }
    }

    // 6. Generation exit, TRUSTED: the run dir was actually read this tick and
    //    the host pid is dead. Cancels everything up to and including the
    //    exited generation (stop-failed included — the stop took effect).
    if (obs !== undefined && !obs.live) {
      for (const cancelled of await cancelOpenRequests(
        bee,
        { beforeGeneration: generation + 1, scopes: ["turn", "runtime-generation"] },
        "scope-closed",
        "generation exited",
      )) {
        emit(cancelled.id, "cancel", "generation exited");
      }
    }

    if (mutated) requests = await readBeeRequests(bee);
    knownCache.set(bee, cacheEntryFor(requests));
  }

  return async ({ records, hsrObservations, hsrUnavailable }) => {
    const outcomes: RequestReconcileOutcome[] = [];
    if (cache === null) {
      cache = await seedCache().catch(() => new Map<string, CacheEntry>());
    }
    for (const record of records) {
      // ADR invariant 2: an unavailable observation batch is unknown, not
      // evidence — ZERO reads or writes for the bee this tick.
      if (hsrUnavailable.has(record.name)) continue;
      try {
        await reconcileBee(record, hsrObservations.get(record.name), outcomes, cache);
      } catch (error) {
        outcomes.push({
          bee: record.name,
          id: "",
          action: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcomes;
  };
}
