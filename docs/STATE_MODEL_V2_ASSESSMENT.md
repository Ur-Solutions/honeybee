# State Model V2 — Takeover Assessment

Status: Research / recommendation
Date: 2026-07-28
Author: CL.df15 (taking over from CO.e8c0)
Reviews: [ADR 001](./adr/001-bee-runtime-turn-state-model.md), [Migration spec](./STATE_MODEL_MIGRATION_SPEC.md)

## Decisions (2026-07-28)

The operator answered the §6 questions on 2026-07-28. This section is the
decision record; §6 keeps the questions with each answer appended inline.

1. **Forward-only approved.** ADR 001's domain semantics are accepted; the
   storage/daemon material is frozen as
   [ADR 002](./adr/002-event-journal-daemon-authority.md), status
   Experimental — not accepted. The migration spec is deferred as a possible
   later convergence plan.
2. **BeeView is a library with a CLI mirror** (`hive state explain`) for
   debugging; Apiary links the library directly.
3. **The operator commits the dirty trees himself.** Implementation work
   happens in custom worktrees via subagents, on both repos.
4. **`hive next` is nearly unused** — it is free to change its behavior; no
   byte-compatibility requirement.

## 1. Where this stands

Timeline of the CO.e8c0 session (2026-07-27):

1. Operator asked why "waiting" is inconsistent. Root causes found: Apiary's
   trailing-`?` heuristic, and Honeybee's `@hive_state=waiting` covering
   `ready`, `blocked`, and `auth-needed` at once.
2. Apiary-side fix landed as commits `5dfc3b81`, `e6c9ca8a`, `7325198e`
   (heuristic removed, fresh `ready` clears the coarse waiting hook,
   "Waiting" → "Needs reply"). This part is done and committed.
3. A Fable+Kimi consultation rejected persisted `phase`/`attention` fields.
4. A clean-rewrite debate with a second Fable bee (CL.04f) converged on the
   Bee/RuntimeGeneration/Turn/InterventionRequest/ContractResult model —
   ADR 001 and the 776-line migration spec were written.
5. After the operator expressed doubt, CO.e8c0 itself concluded the migration
   spec should **not** be executed as written and recommended a forward-only,
   shadow-projection approach.

**No migration code exists.** The only artifacts are the two documents.

My verdict after independently mapping both codebases: the domain model in
ADR 001 is right and well-evidenced; the migration spec is the wrong next
step. CO.e8c0's final step-back recommendation was correct, and this document
sharpens it into a concrete plan.

## 2. What the code actually says (the uncleanliness inventory)

Two read-only code maps were produced (Honeybee and Apiary). Highlights that
should drive the decision:

### 2.1 Honeybee

- **Three copies of "how is this bee doing", no owner.** Derived `BeeState`
  (recomputed per read), the persisted `lastObservedState` cache
  (`store.ts:172`, an untyped `string`), and the coarse tmux `@hive_state`
  projection (`hiveState.ts:24`).
- **Two independent `BeeState → coarse` mappings that already drift.**
  `hiveStateFor` (`hiveState.ts:26`) maps `wedged → "failed"`;
  `coarseHiveState` (`substrates/remote-hsr.ts:183`, inlined to dodge an
  import cycle) has no `wedged` case.
- **`"done"` means six different things**: `BeeState.done`, coarse
  `@hive_state "done"` (which also covers `idle_with_output`), seal status,
  flight-slot state, `SessionRecord.status`, loop stop status.
- **`hive list --json` emits `state` in two vocabularies**: coarse
  `@hive_state` when tmux answers, fine `BeeState` otherwise
  (`commands/observe.ts:151-153`). `--state` accepts three vocabularies
  (`observe.ts:131-138`).
- **`hive next` reads only `@hive_state`** (`next.ts:14-19`), so its queue
  treats "idle and fine", "stuck on a permission prompt", and "logged out"
  identically — the original complaint, still live in the CLI.
- **Stale-hook masking**: `effectiveHiveState` (`hiveState.ts:70-78`) treats
  hook-written `waiting`/`done` as authoritative forever; a stale `waiting`
  masks a genuinely active bee — the same race it was written to fix for
  `working`/`failed`.
- **No freshness contract on `lastObservedState` at read sites**:
  `commands/flight.ts:355` casts it unchecked (`as BeeState`, no
  `parseBeeState`, no timestamp check); `limits/commitments.ts:43` matches
  `"working"` against it — a coarse-vocabulary value that can never appear
  there (dead code born of vocabulary confusion).
- **Write races**: hook vs daemon last-writer-wins on `@hive_state`;
  `hive wait` writes `done` from a pane heuristic while the daemon derives
  `active` (`wait.ts:117`); `sessionMetadata.markRunning` can resurrect a
  terminal record (`sessionMetadata.ts:85`); `saveSession` full-overwrite vs
  daemon `touchSession` merge (HIVE-49 note, `store.ts:239-246`).
- **CLI vs daemon derivation asymmetry**: `buildStateContext`
  (`cli/shared.ts:477`) omits `previousStates`/`hsrMirrors`/`hsrUnavailable`,
  so `hive ls` and the daemon can disagree about the same bee at the same
  instant.
- **`flight/machine.ts` has privately reinvented Turn** (attempt ids,
  attempt-scoped seals, stall clocks) — the strongest evidence that the Turn
  aggregate belongs in the core.

### 2.2 Apiary

- **Apiary does not consume a Honeybee API at all.** There is no
  `hive ps --json` call anywhere; it reads `~/.hive/sessions/*.json` directly
  (`packages/adapters/src/hive.ts:1275`), polls tmux for `@hive_state`
  itself (`tmuxState.ts`), and tails provider transcripts. Every Honeybee
  storage change is therefore an Apiary breaking change. This single fact is
  why the migration spec had to grow parity gates, bridge releases, and dual
  writes.
- **Seven parallel state vocabularies** in the desktop app:
  `HiveSessionStatus` (with two vestigial members nothing produces:
  `'review'`, `'blocked'` — `core/hive.ts:6`), `SessionAttention`,
  `InboxAgentState` (renderer-only `'completed'`), `AgentRunState` (adds
  `'interrupted'`/`'loading'`), inbox priority bands, list-view keys, plus a
  deliberate byte-copy of the attention→status table kept honest only by a
  test (`remote/attention.ts:156`).
- **Four copies of the "is retired" predicate** (`core/hive.ts:234`,
  `agentInboxState.ts:115`, `inboxModel.ts:37`, `optimisticArchives.ts:41`).
- **The Inbox ledger deliberately overrides Honeybee facts** in documented
  places: `lastObservedStateAt` is never used for timing (it's a fleet-wide
  sweep stamp — 2026-07-24 census: ~1.8k records sharing one sweep minute);
  a fresh `ready` observation overrides the coarse waiting hook; a brand-new
  record's `idle` is not completion without hook/settled corroboration (the
  current uncommitted `hasDirectCompletionEvidence` change).
- The snooze-overtake logic exists in three places (main ledger, renderer
  `activeSnooze`, optimistic snooze marker).

Every one of these Apiary layers is a compensation for information Honeybee
discards or a coupling to storage Honeybee never promised. ADR 001's context
section is accurate.

## 3. Assessment of the migration spec

The spec is internally rigorous — and that is the problem. It is an
enterprise-grade zero-downtime migration plan (checksum manifests, mutation
gates, bridge releases, shadow parity classification, canary workspaces,
dual-write windows, rollback drills, cutover decision records) for a
single-operator internal tool whose entire fleet of binaries the operator
controls and can update in one sitting.

Specific objections:

1. **It migrates ambiguity.** Sections 7-8 spend enormous effort importing
   legacy history into synthetic Turns and evidence-graded baselines while
   simultaneously (§4.3) forbidding invented certainty. The honest version of
   "don't invent certainty" is: don't import history at all. Legacy records
   stay readable as legacy; the new model applies to new work.
2. **It couples four rewrites** — semantics, storage (SQLite event journal),
   authority (daemon-as-sole-mutator), and consumer API — into one
   operation, so they fail together. The Fable round-1 critique said exactly
   this ("do not couple the domain rewrite to a storage rewrite; they fail
   independently") and the consensus overrode it without new evidence.
3. **The daemon becomes a hard dependency for every mutation.** Today every
   command works with the daemon stopped. That availability property is worth
   keeping until an event journal has proven it pays for itself.
4. **Most of its Apiary machinery exists only because Apiary reads raw files.**
   A stable read API removes the need for the majority of the parity/dual-write
   apparatus — which means the API should come *first*, not mid-migration.

What the spec gets right and we should keep regardless: the legacy-state
interpretation table (§8) as *display* semantics, the invariants (never infer
success from idle; stale `blocked` opens no request; `waiting` never imports
as `needs-reply`), and the UI gate checklist (§11.4) as a manual QA list.

## 4. Recommended path (forward-only, no storage migration)

The governing rule (CO.e8c0's, endorsed): **do not migrate ambiguity —
preserve it as legacy evidence and create clean truth going forward.**

Ordered steps, each independently shippable and abortable:

1. **Land the pending hygiene work.** The honeybee tree's uncommitted
   `sealed`+`archived` → `done` collapse is coherent, typechecks, and its
   test updates pass (see §5). Commit it (with the `flight.ts:355` fix
   below) and the buz-inject change separately, so the tree is clean before
   any model work starts.
2. **Re-status the documents.** ADR 001: keep the domain records and
   invariants, mark the SQLite/daemon/event-journal sections as a separate
   ADR 002 with status Experimental. Migration spec: restate as a possible
   later convergence plan, explicitly not the implementation plan.
3. **Ship the `BeeView` read API first.** A versioned, Honeybee-owned reader
   (library + `hive state explain <bee> --json`) that projects *current*
   stores into the ADR's consumer shape (`beeLifecycle`, `runtimeState`,
   `openRequests[]`, `displayState`, `observationFreshness`, evidence per
   fact). Pure function over existing data; no new writes, no SQLite, no
   daemon requirement. Apiary switches its adapter to consume it and stops
   reading `~/.hive/sessions/*.json` directly. This is the single
   highest-leverage decoupling step and is valuable under every possible
   future storage decision.
4. **Implement one vertical slice: InterventionRequest.** A durable request
   record (JSON file per bee, like everything else) opened by structured
   `needs_input` / auth-expiry / detected permission prompts, resolved by
   `hive answer` or scope closure, with the idempotency key and
   scope-closure-cancels invariants from the ADR. `needs-reply` in BeeView
   derives solely from open requests. This kills the worst live ambiguity
   (the original "waiting" complaint) and fixes `hive next`'s conflation
   without touching `@hive_state`.
   **SHIPPED 2026-07-28** — see
   [INTERVENTION_REQUESTS.md](./INTERVENTION_REQUESTS.md) (approved design)
   and `src/requests/` (store + shared id builders), `src/daemon/
   requestSweep.ts` (reconciler stage), the store-backed needs-input router,
   and BeeView's store-first `openRequests` + `recentClosedRequests`.
   Scoping note: the durable store persists STRUCTURED-grade requests plus
   the stop-failed manual action; purely observer-grade requests stay
   live-derived (their ids legitimately recur within a generation).
   Retention: opens never pruned; closed history bounded by
   `HIVE_REQUESTS_KEEP_CLOSED` (default 50 per bee) plus a 24h floor.
5. **Turn ids for new work only.** `hive send` stamps a turn id; hooks and
   HSR events attach evidence; seals may correlate. No reconstruction of
   historical turns.
6. **Retire Apiary's compensations gradually** as BeeView facts replace them
   (attention heuristics first, inbox admission evidence second, the
   vocabulary zoo last). Each deletion is a test-guarded PR.
7. **Only then re-open ADR 002** (event journal / SQLite / daemon authority)
   if remaining problems actually demand it. The concrete symptoms that
   would justify it: needs-input dedupe forgetting on daemon restart, remote
   mirror replay duplication, rebuild-ability of the inbox. If steps 3-6
   solve the felt pain, ADR 002 may never be needed.

Explicitly rejected for now: SQLite journal, daemon RPC mutation authority,
any import/backfill of legacy history, bridge releases, parity tooling.

## 5. State of the working trees (hygiene)

### honeybee (uncommitted, predates CO.e8c0's session)

The `sealed`/`archived` → `done` collapse (~29 src files, 20 test files)
plus new `src/buz/inject.ts` (bee-sent buz messages get a marker + JSON meta
envelope; `hive buz send` sender defaults to the calling bee).

- `npm run check` passes; test suite 2107/2118 pass.
- The 2 failures (`tests/agents.test.ts` tmux identity-option stamping,
  `tests/beesSidebar.test.ts` root-left split) are in files the diff does
  not touch and look environment-sensitive (run inside a hive tmux session);
  verify once from a clean terminal before committing.
- One real gap the diff leaves: `src/commands/flight.ts:355` still does
  `record.lastObservedState as BeeState` with no `parseBeeState`
  normalization — a legacy `"sealed"` value silently falls to the stall
  path. Fix alongside the commit.
- Behavioral deltas to accept knowingly: `--state sealed|archived` now both
  mean the whole `done` class (sealed vs filed no longer CLI-distinguishable;
  the discriminator `status` isn't in `--json`); filed bees now get a coarse
  `@hive_state` write per transition tick; filed bees sort with idle bees in
  `hive bees`; bee→bee buz bodies gain a two-line envelope prefix (any
  consumer pattern-matching raw bodies sees new bytes).

### apiary (uncommitted, ~68 files, mixed work from ≥5 bees)

Clusters: PdfReader→FileReader migration (largest), transcript file links,
the `hasDirectCompletionEvidence` inbox-admission guard (+tests), product
unregister confirm, processOutputGuard, agentComposerFocus/Tab-summon,
border-diet screenshots. `pnpm typecheck` passes across all 7 projects.
These should be committed as separate cluster commits before more state work
lands in this repo.

## 6. Open questions for the operator

All answered 2026-07-28; see the Decisions section at the top. The questions
stay for the record with each answer appended.

1. Agree to freeze ADR 002 (storage/daemon) as Experimental and proceed
   forward-only? (Recommendation: yes.)
   **Answered: yes.** ADR 002 is frozen as Experimental — not accepted; the
   path is forward-only.
2. Should the BeeView read API be a library import for Apiary (fast, same
   machine) or a `hive` CLI/JSON boundary? (Recommendation: library with a
   CLI mirror for debugging — Apiary already links adapter code.)
   **Answered: library with a CLI mirror** (`hive state explain`).
3. Who commits the two dirty trees, and in what cluster order? The honeybee
   `done`-collapse looks ready; the apiary tree needs per-cluster commits by
   their owning bees or one sweep by a single bee.
   **Answered: the operator commits the dirty trees himself.** Implementation
   work happens in custom worktrees via subagents on both repos.
4. Is `hive next` allowed to change behavior now (read fine state /
   open-request facts instead of `@hive_state`), or must it stay
   byte-compatible until BeeView lands?
   **Answered: free to change now** — `hive next` is nearly unused.
