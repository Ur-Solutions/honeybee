# BeeView Read API — V1 Design

Status: Approved for implementation (forward-only plan, step 3)
Date: 2026-07-28
Related: [ADR 001](./adr/001-bee-runtime-turn-state-model.md) (consumer
contract), [Assessment](./STATE_MODEL_V2_ASSESSMENT.md) (§4 steps 3-6)

BeeView is a versioned, Honeybee-owned read model: a pure projection of
current stores (SessionRecord JSON, the bounded state cursor, derived `BeeState`, tmux `@hive_state`,
HSR run dirs, seals) into structured facts. Library-first with a CLI mirror
(`hive state explain` / `hive state ls`). The read path performs no writes and
has no daemon requirement; staleness is surfaced, never hidden. Runtime replacement
provenance is a persisted safety fact owned by lifecycle admission, not a
BeeView write. The 2026-08-11
bounded-state extension is additive within schemaVersion 1: existing fields
retain their spelling and meaning.

### 2026-08-17 event-history integrity projection

- An HSR event-history fence is independent from runtime stop ownership. An
  exact unresolved receipt with `stopState: "confirmed"` proves the provider
  host stopped; it therefore projects as ordinary `ready` (parked) or
  `offline` (lost), not `stop-failed` or `crashed`.
- The fence remains visible as `eventIntegrity` and keeps
  `interactionState: "blocked"`. Compatibility fields deliberately retain
  `kill_failed`, so older writers and all mutation paths continue to fail
  closed until an operator explicitly reconciles the history.
- A missing, mismatched, acknowledged, pending, or doubtful receipt never
  supplies stop authority. Those cases retain the existing `stop-failed`
  presentation. Receipt identity includes the marker's complete local or
  remote host identity, not only its integrity id.

### 2026-08-16 runtime-replacement provenance

- The crash-safe replacement path keeps its durable, non-runnable internal
  fence, but `latestRuntime.replacement` now distinguishes a replacement that
  is still `pending` from a genuine `stop-failed` result. The internal launch
  reservation id is deliberately not part of BeeView.
- A pending `lazy-wake` projects as `latestRuntime.state: "starting"`,
  `displayState: "recovering"`, and `interactionState: "working"`; it never
  sets `latestRuntime.stopFailed` or creates a stop-failed request. The bounded
  runtime axis may remain `parked` until successor publication.
- Both pending and failed replacement fences remain mutation-closed. A true
  teardown failure projects `stopFailed: true`, `displayState: "stop-failed"`,
  and `interactionState: "blocked"`. Successful successor publication clears
  replacement provenance in the same generation commit.

### 2026-08-11 bounded-state extension

- Internal lifecycle (`active | archived`) and runtime
  (`live | parked | recovering | lost`) facts are exposed as
  `bee.lifecycleState` and `latestRuntime.runtimeState`. They do not create a
  second consumer vocabulary: attention remains `displayState` plus
  `openRequests`.
- `displayState` adds `recovering`, presented as working-flavoured. A parked
  runtime projects as ordinary `ready`; parking is visible only in the runtime
  diagnostic axis.
- Recovery-budget exhaustion projects a `manual-action` request under the
  transition's durable request id. A request-store row under that id remains
  authoritative; the transition cursor is the daemon-down fallback.
- Every projection carries `verification.unverified`. An observer-offline or
  stale-cursor marker includes `unverifiedSince`, the scheduled probe time,
  and optional observer details. It never changes lifecycle, runtime,
  displayState, or requests.

## Decisions folded into this design (2026-07-28)

1. **Probe cost**: `listBeeViews` runs a full observation pass per call (same
   cost as `hive ls`). Accept that with Apiary's existing TTL first; measure;
   add injected-probe-result support only if it shows up in practice.
2. **`wedged`/`error` project as `needs-action`** with a synthesized
   observer-grade manual-action request (the ADR has no `failed` display
   state; a runner error is a recovery condition, not a lifecycle).
3. **`inboxSummary` ships derived-only** (open-request counts + latest
   result), clearly documented as disposition-blind until the InboxItem slice
   exists. Apiary must not treat it as read/dismiss/snooze-aware.
4. **`hive next` may switch to BeeView displayState** — operator confirmed no
   byte-compatibility requirement.
5. **Package identity**: the library exports from the existing `honeybee`
   package root; the `view` surface (`src/view/index.ts` re-exported via
   `src/index.ts`) is the only supported import contract.

## Packaging facts the design rests on

- Honeybee is ESM (`"type": "module"`, NodeNext), builds with `tsc` to
  `dist/`, has **zero runtime dependencies**, and currently exposes only
  `bin` entries. A library entry needs only an `exports` map,
  `"declaration": true`, and a root `src/index.ts`.
- The operator's global `hive` is an npm link to this working tree; Apiary
  already couples to the tree via `hiveBin.ts` subprocesses and raw `~/.hive`
  reads. A pnpm `link:` dependency makes library coupling identical to the
  existing CLI coupling.
- Neither repo has CI; both honor `HIVE_STORE_ROOT` (the test seam).

## 1. Types (contract)

To live in `src/view/types.ts`. Everything here is derivable today; fields
the ADR promises but current data cannot support are typed and documented as
absent. Additive fills (Turn ids, durable requests) stay within
schemaVersion 1; only a field removal bumps the version.

```ts
import type { BeeState } from "../state.js";
import type { SealStatus, SealType } from "../seal.js";
import type { BeeContract } from "../contract.js";

export const BEE_VIEW_SCHEMA_VERSION = 1 as const;

/**
 * Evidence grade attached to every projected fact, ordered by trust:
 *   structured — HSR events.jsonl (turn_start/turn_end/needs_input/auth), seals
 *   hook       — agent Stop/Notification hooks via @hive_state (waiting/done)
 *   observer   — pane captures, ring snapshots, pid/session liveness, node probes
 *   legacy     — persisted caches (lastObservedState, SessionRecord.status)
 */
export type EvidenceGrade = "structured" | "hook" | "observer" | "legacy";

export type BeeViewEvidence = {
  grade: EvidenceGrade;
  /** Machine-readable origin, e.g. "hsr-events", "pane-capture",
   *  "hive-state-option", "seal", "session-record", "node-probe",
   *  "hsr-meta", "daemon-observation". */
  source: string;
  /** ISO timestamp of the underlying observation, when the source carries
   *  one. @hive_state notably carries none. */
  observedAt?: string;
  /** Free-text pointer for debugging (event type, filename, matched rule). */
  detail?: string;
};

/** Durable identity + lifecycle (ADR "Bee"). */
export type BeeViewBee = {
  /** Canonical id (record.id ?? name). */
  id: string;
  name: string;
  uuid?: string;
  title?: string;
  agent: string;
  cwd: string;
  colony?: string;
  swarmId?: string;
  tags: string[];
  node: string;               // LOCAL_NODE_NAME when unset
  /**
   * active  — record.status "running" | "dead" | "kill_failed"
   * retired — record.status "done" (filed via retire / quest done)
   * A SEALED but un-filed bee is NOT retired — completion never changes
   * lifecycle (ADR invariant 10). Its seal appears in latestContractResult.
   */
  lifecycle: "active" | "retired";
  /** Bounded axis. lifecycle above is retained for compatibility. */
  lifecycleState: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  contract?: BeeContract;
  spawnedById?: string;
  taskAttribution?: { runId?: string; flowName?: string };
};

export type BeeViewRuntimeReplacement = {
  operation: string;
  sourceGeneration: number;
  state: "pending" | "stop-failed";
  startedAt: string;
  updatedAt: string;
  detail?: string;
};

/** Latest runtime incarnation (ADR "RuntimeGeneration", projected). */
export type BeeViewRuntime = {
  /** record.runtimeGeneration ?? 0 — monotonic across revive/promote/demote. */
  generation: number;
  /**
   * starting — booting | queued
   * online   — live target/pane/host-pid confirmed
   * exited   — liveness probe negative
   * unknown  — node unreachable or observation unavailable this pass
   */
  state: "starting" | "online" | "exited" | "unknown";
  /** Bounded runtime axis; parked never becomes a display state. */
  runtimeState: "live" | "parked" | "recovering" | "lost";
  substrate: "local-tmux" | "hsr";
  tmuxTarget?: string;
  agentPaneId?: string;
  runnerPid?: number;
  runnerTier?: string;
  providerSessionId?: string;
  /** Current generation-bound replacement provenance; no internal reservation id. */
  replacement?: BeeViewRuntimeReplacement;
  /**
   * Only derivable for exited runtimes, from recorded intent:
   *   stopped — record.status "dead"/"done" (a retire/kill was recorded)
   *   crashed — record.status still "running" (exit without stop intent)
   * "clean" (exit-contract completion) is not derivable until Turn ids land.
   */
  exitClass?: "stopped" | "crashed";
  /** kill_failed: the stop failed and the runtime may still be alive. */
  stopFailed?: boolean;
  evidence: BeeViewEvidence;   // what liveness was concluded from
};

/**
 * RESERVED — always undefined in schemaVersion 1. Honeybee has no Turn ids
 * yet (assessment §4 step 5); the field exists so consumers can bind to the
 * shape without a schema bump when Turn stamping lands.
 */
export type BeeViewTurn = {
  id: string;
  state: "queued" | "running";
  acceptedAt?: string;
  boundGeneration?: number;
  evidence: BeeViewEvidence;
};

/**
 * ADR "InterventionRequest". Structured-grade requests come from the durable
 * request store (src/requests/store.ts, docs/INTERVENTION_REQUESTS.md —
 * authoritative when a record exists); live derivation remains the
 * daemon-down fallback under the SAME ids (src/requests/keys.ts), and
 * observer-grade requests stay live-derived only:
 *   - `id` is the durable idempotency key shared with the store
 *     (structured requestId, or scope+kind+fingerprint for observer grade)
 *   - `status`: openRequests carries "open" only; resolved/cancelled appear
 *     in recentClosedRequests (additive within schemaVersion 1)
 *   - `turnId` stays absent until Turn ids exist.
 */
export type BeeViewRequest = {
  id: string;
  kind: "question" | "permission" | "auth" | "manual-action";
  status: "open" | "resolved" | "cancelled";
  scope: "turn" | "runtime-generation" | "bee";
  grade: "structured" | "observer";
  /** ISO — always present on store-backed requests; observer-grade live
   *  derivation may omit it (projection time is not persisted). */
  openedAt?: string;
  question?: string;
  tool?: string;
  options?: string[];
  /** Pass-through of the structured needs_input payload (hsr/observe.ts
   *  PendingNeedsInput) so `hive answer` UIs need no second read. */
  optionDetails?: unknown;
  questions?: unknown;
  multiSelect?: boolean;
  input?: unknown;
  /** Store-backed resolved requests: "hive-answer[:caller]" | "auth-resume" | "stop-succeeded". */
  resolvedBy?: string;
  /** Store-backed cancelled requests. */
  cancelReason?: "scope-closed" | "superseded";
  turnId?: string;             // absent until Turn ids land
  evidence: BeeViewEvidence;
};

/** ADR "TurnEndEvidence" projection for the latest settled response. */
export type BeeViewTurnResult = {
  /**
   * responded          — structured turn_end (or hook Stop "done")
   * settled-unverified — observer-only pane/ring settling (idle_with_output)
   * interrupted        — runtime exited mid-turn (crashed while running)
   * failed             — runner error event
   * "cancelled" is not derivable in v1 (no cancellation record exists).
   */
  outcome: "responded" | "settled-unverified" | "interrupted" | "failed";
  endedAt?: string;
  turnId?: string;             // absent in v1
  evidence: BeeViewEvidence;
};

/** ADR "ContractResult": latest seal of the CURRENT incarnation
 *  (sealHighWaterFilename-gated). */
export type BeeViewContractResult = {
  verdict: "success" | "failed" | "blocked";  // seal done→success; needs_input→blocked
  sealStatus: SealStatus;
  sealType: SealType;
  sealedAt: string;
  taskId?: string;
  attempt?: number;
  /**
   * true  — seal satisfies the bee's contract correlation keys
   * false — contract demands keys the seal lacks/mismatches (keyless seal:
   *         reviewable artifact, NOT contract completion — ADR rule)
   * undefined — the bee has no contract to correlate against.
   */
  matchesContract?: boolean;
  evidence: BeeViewEvidence;   // grade "structured", source "seal"
};

/**
 * Derived-only summary. Honeybee stores NO inbox dispositions in v1 —
 * read/dismiss/snooze remain Apiary-owned until the InboxItem slice exists.
 */
export type BeeViewInboxSummary = {
  openRequestCounts: { needsReply: number; needsAuth: number; needsAction: number };
  /** latestContractResult or latestTurnResult present on a non-retired bee. */
  hasUnretiredResult: boolean;
  latestResultAt?: string;
};

/** ADR BeeDisplayState precedence, post-rename vocabulary. */
export type BeeDisplayState =
  | "retired"
  | "needs-auth"
  | "needs-reply"
  | "needs-action"
  | "stop-failed"
  | "crashed"
  | "unreachable"
  | "starting"
  | "recovering"
  | "working"
  | "ready"
  | "offline";

export type ObservationSourceFreshness = {
  source: "hsr-events" | "pane-capture" | "hive-state-option"
    | "daemon-observation" | "node-probe";
  status: "fresh" | "stale" | "missing" | "untimed";
  observedAt?: string;
  ageMs?: number;
  /** e.g. "lastObservedStateAt is a fleet-wide sweep stamp; do not use for
   *  turn timing", "HSR observation batch failed this pass — state held",
   *  "@hive_state carries no timestamp". */
  caveat?: string;
};

export type BeeViewObservationFreshness = {
  /** True when this projection pass itself observed live substrate. */
  observedLive: boolean;
  /** The daemon is NOT required; this reports whether its cache was current. */
  sources: ObservationSourceFreshness[];
};

export type BeeViewEventIntegrity = {
  integrityId: string;
  phase: "unresolved" | "acknowledged" | "unknown";
  stopState: "pending" | "confirmed" | "doubt" | "unknown";
  /** Absent when no exact receipt owns the current runtime. */
  deliveryIds?: string[];
  deliveryScanError?: string;
  deliveryVerdicts?: Record<string, "delivered" | "discarded">;
  reason: string;
  stopDetail?: string;
  receiptReadError?: string;
  createdAt: string;
  updatedAt?: string;
  evidence: BeeViewEvidence;
};

export type BeeViewVerification = {
  unverified: boolean;
  unverifiedSince?: string;
  reason?: "stale-cursor" | "observer-offline";
  probeScheduledAt?: string;
  lastVerifiedAt?: string;
  observerOffline?: {
    observerId: string;
    offlineSince: string;
    lastSeenAt?: string;
    reason: string;
  };
};

/** Verbatim legacy fields so consumers migrate additively. */
export type BeeViewCompatibilityFields = {
  beeState: BeeState;              // deriveState output, post-rename vocabulary
  beeStateDetail: string;
  sessionStatus: "running" | "dead" | "kill_failed" | "done";
  hiveStateOption?: string;        // raw @hive_state
  effectiveHiveState?: string;     // hiveState.ts effectiveHiveState()
  lastObservedState?: string;      // persisted daemon cache, unnormalized
  lastObservedStateAt?: string;
};

export type BeeViewV1 = {
  schemaVersion: typeof BEE_VIEW_SCHEMA_VERSION;
  bee: BeeViewBee;
  latestRuntime: BeeViewRuntime;
  currentTurn?: BeeViewTurn;                    // always undefined in v1
  openRequests: BeeViewRequest[];
  /** Newest-first resolved/cancelled requests from the durable store (cap 5). */
  recentClosedRequests?: BeeViewRequest[];
  latestTurnResult?: BeeViewTurnResult;
  latestContractResult?: BeeViewContractResult;
  inboxSummary: BeeViewInboxSummary;
  interactionState: "working" | "idle" | "blocked" | "archived";
  displayState: BeeDisplayState;
  /** The precedence rule that produced displayState (for `state explain`). */
  displayStateReason: string;
  observationFreshness: BeeViewObservationFreshness;
  verification: BeeViewVerification;
  /** Present while an HSR event-history receipt remains canonically fenced. */
  eventIntegrity?: BeeViewEventIntegrity;
  lastProjectedAt: string;
  compatibilityFields: BeeViewCompatibilityFields;
};

export type BeeViewListV1 = {
  schemaVersion: typeof BEE_VIEW_SCHEMA_VERSION;
  generatedAt: string;
  node: string;
  unreachableNodes: string[];
  bees: BeeViewV1[];
};
```

### Derivation honesty rules

- `displayState` is recomposed from facts per ADR precedence — not a rename
  of `BeeState`. Two deliberate divergences from `deriveState`:
  - a **sealed-but-live** bee (`deriveState` → `done`, "seal recorded")
    projects as `ready` + `latestContractResult` — completion never changes
    display state;
  - `idle_with_output` projects as `ready` + `latestTurnResult`
    (`settled-unverified` observer-grade, or `responded` when structured/hook
    evidence exists).
  `wedged`/`error` → `needs-action` with a synthesized observer-grade
  manual-action request (id `manual:<bee>:<gen>:wedged`); a genuine
  `kill_failed` stop result → `stop-failed`, while a generation-bound pending
  replacement fence → `recovering`; `node_unreachable` → `unreachable` (with the caveat that
   today's node probe is not a heartbeat contract — graded observer).
  A bounded runtime in `recovering` projects as `recovering`; `parked`
  projects as `ready` and is intentionally absent from displayState.
- `openRequests` sources, STORE-FIRST (docs/INTERVENTION_REQUESTS.md):
  0. durable request-store records with status `open` and the CURRENT
     generation project verbatim (authoritative). An
     answered-but-events-trailing `needs_input` has a RESOLVED record, so it
     is NOT open even while the tail still shows `pendingNeedsInput`;
  1. unresolved structured `needs_input` (`pendingNeedsInput` / event
     snapshot) → `question`/`permission`, grade structured, id = requestId
     (or `ni:<bee>:<ts>` when the adapter sent none) — LIVE FALLBACK only,
     applied when no store record exists under that id (daemon down);
  2. pane-detected permission/trust/MCP prompts (`readiness.ts` predicates)
     → `permission`, grade observer, id =
     `obs:<bee>:<gen>:permission:<fingerprint(pane block)>` — suppressed by a
     same-id store record or an open store-backed needs-reply request;
  3. auth: `auth-needed` from events (bounded by `auth_resume`) → structured
     (store record wins under the same id), or from held/pane state →
     observer; scope `runtime-generation`.
- Scope closure: explicit resolved/cancelled records in the durable store
  (hive answer / auth-resume / retire / kill / revive / daemon reconciler),
  with live re-derivation still closing fallback-derived requests naturally
  (a `turn_end` after a `needs_input`, a dead runtime). Ids are byte-shared
  via `src/requests/keys.ts`. `recentClosedRequests` exposes the last 5
  closed records, newest first.
- Library calls never write: no `touchSession`, no `@hive_state` mirroring,
  no ledger appends. The daemon remains the only observer that persists.
- Missing observation is not a state transition. `stateUnverified` is copied
  into `verification` on every projection while the window remains open; the
  last-known axes and display state are held until a conclusive probe clears
  the marker.

## 2. Honeybee module layout

New files:

```text
src/view/types.ts        types above + schema constant
src/view/context.ts      ONE honest StateContext assembler (node probe, pane
                         captures, seals, HSR observations with mirrorOf →
                         hsrMirrors and batch-failure → hsrUnavailable, and
                         previousStates from parseBeeState(lastObservedState),
                         graded legacy). Closes the CLI/daemon asymmetry.
src/view/requests.ts     openRequests derivation + stable observer keys
src/view/project.ts      projectBeeView(record, gathered) → BeeViewV1 (pure)
src/view/index.ts        getBeeView(selector) / listBeeViews() /
                         projectBeeViewFromSources() (pure, for tests)
src/index.ts             library root (the only supported import surface)
src/commands/state.ts    cmdState — `hive state explain|ls`
```

Touched: `package.json` (exports map + types), `tsconfig.json`
(declaration), `src/state.ts` (export `parseBeeState`; also used to fix the
`flight.ts:355` unchecked cast), `src/cli/shared.ts` (`buildStateContext`
delegates to `view/context.ts`; daemon keeps its in-memory `previousStates`
layered on top), `src/cli.ts`, `src/completion/tables.ts`,
`docs/HIVE_CLI_REFERENCE.md`.

## 3. Apiary consumption

pnpm `link:` to the sibling path in `packages/adapters/package.json`:

```json
"dependencies": { "honeybee": "link:../../../../../honeybee/repos/honeybee" }
```

plus `'honeybee'` added to the `externalizeDepsPlugin({ exclude: [...] })`
list in `apps/desktop/electron.vite.config.ts` so the packaged app bundles
honeybee's `dist/` (viable: zero runtime deps). Rejected: published private
package (publish-per-change dev loop), git dep (reinstall churn), vendored
copy (silent drift). Caveat to document: the library is consumed from
`dist/`, so honeybee edits need `npm run build` — keep `tsc --watch` running
during joint work.

Migration seam: new `packages/adapters/src/hiveView.ts` wrapping
`listBeeViews`/`getBeeView` with a `schemaVersion === 1` assert and graceful
fallback to the legacy path. Replacement order (assessment §4 step 6):

1. `mapStatus` + `ATTENTION_TO_STATUS` fold — `HiveSession.status` from
   `displayState`; retire `lastObservedState` freshness guessing.
2. `HiveStateProbe` — poll loop stays, but polls `listBeeViews` instead of
   raw `tmux list-sessions`; hook facts arrive pre-arbitrated.
3. `attention.ts`/`needsInput.ts` tail promotion/demotion → `openRequests`;
   the tail probe survives only as the demotion check until Turn ids land.
4. Seal probing + `hasDirectCompletionEvidence` admission evidence →
   `latestTurnResult`/`latestContractResult` grades.

The `sessions/*.json` fs-watch in `subscribe()` stays as the notification
trigger; what changes is what a notification reads.

## 4. CLI mirror

```text
hive state ls [selector] [--state <display>] [--colony c] [--node n] [--done] [--json]
    STATE(display, glyph-colored)  REF  NAME  REQS  RESULT  FRESH  DETAIL
    REQS = "1 reply" / "auth" / "-"; RESULT = "responded 3m" / "seal ok" / "-"
    FRESH = worst source status ("live" / "stale 2d" / "held" /
            "unverified 3m")
    --json = BeeViewListV1 verbatim.

hive state explain <bee> [--json]
    Identity header; "display: needs-reply — open permission request
    (structured, id=req_abc, 3m ago)"; Runtime / Turn result / Requests /
    Contract / Freshness / Compat sections, every fact annotated
    [structured|hook|observer|legacy].
    --json = single BeeViewV1 verbatim.
```

Both read-only, daemon-free, thin printers over `view/index.ts` — CLI and
library return byte-identical JSON.

## 5. Implementation steps (PR-sized)

0. Wait for the operator's pending commits (`done`-collapse + buz-inject in
   honeybee; cluster commits in apiary). Everything below rebases on them.
1. Library plumbing: exports map, declaration, `src/index.ts`, export
   `parseBeeState`. No behavior change. Test: import-surface test.
2. `view/types.ts` + `view/project.ts` — pure projection. Tests: fixture
   table for the precedence rules, sealed-but-live → ready+contractResult,
   `idle_with_output` → settled-unverified, crashed-mid-turn → interrupted,
   wedged → manual-action, legacy `sealed`/`archived` strings.
3. `view/context.ts` — unified assembler; `buildStateContext` delegates.
   Tests: CLI/daemon asymmetry regression (mirror/unavailable/held cases);
   failed HSR batch marks `hsrUnavailable`, not empty-map death.
4. `view/requests.ts`. Tests: structured needs_input round-trip incl.
   payload; needs_input then turn_end → none (scope closure); stable
   observer fingerprints; auth bounded by `auth_resume`.
5. CLI `hive state explain|ls` + completion + CLI reference. Tests in the
   style of `cli-list-facets.test.ts`. `hive next` may switch to
   displayState here (operator-approved).
6. Apiary adoption, read-only: `link:` dep, vite exclude, `hiveView.ts`
   wrapper, debug affordance. Tests: adapters vitest on fabricated
   `HIVE_STORE_ROOT`; typecheck; packaged-app bundle check.
7. Apiary cutover: one PR per compensation layer in §3 order, each a
   test-guarded deletion; old-vs-new parity diffs over recorded fixtures
   before deleting. The `remote/attention.ts` byte-copy table and the four
   is-retired predicates go last.
8. Later slices (separate): the durable InterventionRequest store SHIPPED
   2026-07-28 (fills resolved/cancelled + `recentClosedRequests`;
   store-backed `openedAt` always present — see
   [INTERVENTION_REQUESTS.md](./INTERVENTION_REQUESTS.md)). Turn ids remain
   (fill `currentTurn`, `turnId`, `exitClass: "clean"`, outcome
   `cancelled`). Additive within schemaVersion 1.
