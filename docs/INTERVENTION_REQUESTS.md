# Durable InterventionRequest store — approved design (2026-07-28)

Status: Approved for implementation (forward-only plan, assessment §4 step 4)
Decisions folded in: kill deletes the request file (kill is PURGE, consistent with seals/run data); retire keeps it (revivable history, like seals). Escalation is record-only in this slice (no notification wiring). Retention defaults: keep open always; closed = newest 50 per bee plus anything closed <24h, env-tunable via HIVE_REQUESTS_KEEP_CLOSED.

## Scoping decision
The store durably persists STRUCTURED-grade requests plus the one durable-fact manual action (stop-failed). Purely observer-grade requests (pane permission fingerprints, held, wedged) stay live-derived exactly as today in view/requests.ts. Rationale: observer ids legitimately recur within a generation; a durable resolved record with that id would wrongly suppress recurrence. Keeps "stale blocked opens no request" trivially true.

## Storage
~/.hive/requests/<safeName(bee)>.json  (one doc per bee: open + bounded closed history)
~/.hive/requests/.<safeName(bee)>.lock (withFileLock guard for mutations)
New modules: src/requests/store.ts (types + locked CRUD), src/requests/keys.ts (id builders shared with the view — the SINGLE source of request ids; view/requests.ts switches to these).

Key builders (must produce byte-identical ids to what view/requests.ts emits today):
- needsInputRequestId(bee, pending): pending.requestId unless empty/"pending", else `ni:${bee}:${pending.ts}`
- authRequestId(bee, eventTs): `auth:${bee}:${eventTs}`
- stopFailedRequestId(bee, generation): `manual:${bee}:${generation}:stop-failed`

Record schema (src/requests/store.ts):
REQUEST_STORE_VERSION = 1. InterventionRequestRecord = { id, bee, kind: question|permission|auth|manual-action, status: open|resolved|cancelled, scope: turn|runtime-generation|bee, grade: structured|observer (this slice writes structured only), generation (record.runtimeGeneration ?? 0 at open), openedAt (ISO, ALWAYS present: event ts when source carries one else write time), updatedAt, payload pass-through (question/tool/options/optionDetails/questions/multiSelect/input), evidence {grade, source, observedAt?, detail?}, routedTo?/routedAt?, escalated?/escalatedAt?, resolvedAt?, resolvedBy? ("hive-answer" | "hive-answer:<caller-bee>" | "auth-resume" | "stop-succeeded"), resolution? (answer text ~500 chars), cancelledAt?, cancelReason? (scope-closed|superseded), cancelDetail? }.
BeeRequestFile = { version: 1, bee, requests: [] }.

API (every mutation = lock → read → mutate → prune → atomicWriteFile → compact ledger row request.open/request.resolve/request.cancel; reads lock-free, tolerant of missing/corrupt file):
readBeeRequests(bee) → [] on missing; listBeesWithRequests() (one readdir); openRequest(bee, input) IDEMPOTENT on id — existing record in ANY status is a no-op (created:false) = the no-resurrection rule; resolveRequest(bee, id, {by, resolution?}) open→resolved only, no-op on closed/missing; openAndResolveRequest (one locked write, for daemon-down hive answer); cancelRequest(bee, id, reason, detail?); cancelOpenRequests(bee, {beforeGeneration?, kinds?, scopes?}, reason, detail?); markRequestRouted(bee, id, {routedTo}|{escalated:true}) only while open; removeBeeRequests(bee).

Retention pruned inside every locked write: opens never pruned; closed keep newest HIVE_REQUESTS_KEEP_CLOSED (default 50) per bee AND anything closed within 24h. removeBeeRequests on deleteSession (kill); retire keeps the file.

## Semantics per source
Guard rails (ADR invariant 2): reconciler NEVER cancels for a bee in hsrUnavailable; never acts on untrusted listSessions snapshot; only acts on this tick's trusted observation.

Structured needs_input (question/permission) — scope turn, id needsInputRequestId:
- Open: daemon reconcile sees eventSnapshot.pendingNeedsInput for live HSR/mirrored bee → openRequest with openedAt = pending.ts, full payload. Re-seen per tick → idempotent no-op. Daemon-down: no durable record, BeeView live fallback shows same id; hive answer backfills.
- Resolve: cmdAnswer after successful control-socket answer RPC → resolveRequest (or openAndResolveRequest if absent), by "hive-answer" or "hive-answer:<HIVE_BEE>". Important asymmetry: after answer, events tail still shows pendingNeedsInput until turn_end — the resolved record is what flips BeeView out of needs-reply immediately; idempotent openRequest stops next tick re-opening.
- Cancel: reconcile sees request open but pendingNeedsInput gone (turn_end bounded, no answer) → cancel scope-closed "turn ended". Plus all generation/lifecycle closures.

Structured auth — scope runtime-generation, id authRequestId(bee, event.ts):
- Open: reconcile sees lastAuthNeededEvent unbounded by auth_resume → open with openedAt = event ts.
- Resolve: (a) cmdAuthResume (migrate.ts ~:739) right after appending the auth_resume marker resolves all open auth for the bee, by "auth-resume" (daemon-down safe); (b) reconcile observes auth bounded by auth_resume with request still open → resolve by "auth-resume".
- Cancel: generation exit / new incarnation / retire → scope-closed.

Pane permission/trust/MCP (observer) — NOT persisted; stays re-derived in view/requests.ts, suppressed when a same-id store record exists or structured pending covers the bee.

Manual action:
- stop-failed (durable, structured-grade — recorded stop intent is a fact), scope runtime-generation, id stopFailedRequestId(bee, gen): Open in transactionalKill/transactionalRetire (kill.ts ~:150/205) right after writing status kill_failed (CLI-side locked write); daemon reconcile also opens when observing a kill_failed record without one. Resolve: later successful retire resolves by "stop-succeeded" before filing; successful kill deletes the file via removeBeeRequests. Cancel: reconcile trusted-observes runtime actually exited → scope-closed "generation exited".
- wedged/error — NOT persisted; stays synthesized observer request.

Scope-closure triggers:
| Root turn_end after needs_input | daemon reconcile | cancel scope-closed "turn ended" |
| Generation exit observed (trusted) | daemon reconcile | cancel ALL open with generation <= exited gen, scope-closed "generation exited" |
| New incarnation (revive/promote/demote/swap) | CLI helper closeRequestsForNewIncarnation(bee, newGen) called next to every nextRuntimeIncarnationPatch application (swap.ts ~:109, migrate.ts x5); reconcile backstop (request.generation < record.runtimeGeneration) | cancel superseded "superseded by generation N" |
| Retire (status done) | transactionalRetire; reconcile backstop | cancel all open scope-closed "retired" |
| Kill (record deleted) | transactionalKill → removeBeeRequests next to dropPoolClaimsForBee (kill.ts ~:174) | file removed |

Idempotency/restart safety: openRequest no-ops on existing id in any status; closed records retained (bounded) so restarted daemon re-deriving same evidence cannot re-open. Pruning only removes records whose source evidence is already bounded (turn_end/auth_resume in events) or older than the events tail.

## Writer wiring
Daemon: new registry stage in src/daemon/tick.ts, key "requestReconciles", name "reconcileRequests", timeoutKey "dispatchMs", in the SAFETY-CRITICAL front group IMMEDIATELY BEFORE dispatchNeedsInput. Implementation src/daemon/requestSweep.ts, createRequestReconciler() — stateful across ticks, built in wiring.ts next to createNeedsInputDispatcher(). Boot tick: listBeesWithRequests() readdir + read seeds cache bee → {openIds, generation}. Steady state: touch a bee only when (a) snapshot shows pending needs_input or unbounded auth, (b) cache says open records exist, (c) record is kill_failed, (d) runtimeGeneration moved past a cached open record; else zero-IO skip. Cache advisory only — every mutation re-reads under lock. Runs only when sessionsSnapshotTrusted; per-bee skip for hsrUnavailable; never throws (outcome array, needsInput.ts style); log request.open/resolve/cancel rows via registry log().

hive answer (cmdAnswer in src/commands/messaging.ts): resolve/backfill after RPC succeeds only. hive auth-resume, kill/retire, incarnation appliers: direct locked CLI writes, all daemon-down functional.

Daemon-down invariant: nothing opens structured records, BeeView fallback keeps needs-reply correct under same ids; CLI verbs still land closures; daemon catches up idempotently on restart.

## BeeView / hive state integration
- view/types.ts: widen BeeViewRequest.status to open|resolved|cancelled; add optional resolvedBy?, cancelReason? on BeeViewRequest; add optional BeeViewV1.recentClosedRequests?: BeeViewRequest[] (last 5, newest first). Additive within schemaVersion 1.
- Gathering (view/index.ts projectRecord + list path): readBeeRequests(record.name) gated by listBeesWithRequests() readdir for lists; thread as BeeViewProjectionSources.storedRequests. view/* never-writes preserved (reads only).
- view/requests.ts deriveOpenRequests becomes store-first: (1) store records status open && generation === current project verbatim (authoritative — an answered-but-events-trailing needs_input is NOT open, the improvement); (2) live structured derivation only when NO store record with that id exists (daemon-down fallback, ids identical via requests/keys.ts); (3) observer-grade derivation unchanged, suppressed by same-id store record + existing guards. Keep the retired/exited → openRequests:[] guard in project.ts.
- hive state explain: Requests section gains a Recent history block (resolved/cancelled, capped 5). hive state ls unchanged. hive next unchanged.

## needsInput.ts dispatcher migration
Drop the in-memory handled Set. Per candidate: (1) look up needsInputRequestId in readBeeRequests (reconcile ran just before; if absent, dispatcher calls openRequest itself — ordering is fast path not correctness); (2) skip when not open, or routedAt/escalated set; (3) route interrupt buz to living parent as today then markRequestRouted(routedTo), parentless/dead-parent → markRequestRouted(escalated:true); (4) NeedsInputOutcome shape unchanged. Restart: relaunched daemon reads routedAt from disk — no duplicate routing, resolved-while-down never routed. ni:<bee>:<ts> preserves unblock-then-reblock routing.

## Implementation steps (PR-sized, commit per step)
1. src/requests/keys.ts + src/requests/store.ts (+ re-export from src/index.ts); view/requests.ts switches inline id construction to keys helpers (behavior-identical). Tests: id parity fixtures vs view emissions; open idempotent (created:false, payload not clobbered); resolve→open no-op; resolve/cancel only from open; cancelOpenRequests beforeGeneration; markRequestRouted only while open; prune rules; corrupt file tolerated; ledger rows.
2. CLI writers: cmdAnswer resolve/backfill; cmdAuthResume resolves auth; kill.ts opens stop-failed on kill_failed, retire cancels-all + resolves stop-failed before filing, kill deletes file; closeRequestsForNewIncarnation helper at nextRuntimeIncarnationPatch sites (swap.ts, migrate.ts x5). Tests: answer-daemon-down produces resolved record under the view-derived id; retire cancels scope-closed "retired"; revive cancels superseded; kill removes file.
3. Daemon reconcile stage: src/daemon/requestSweep.ts, TickDeps.reconcileRequests, registry entry before dispatchNeedsInput, wiring. Tests (injected-deps daemon-tick style): open on pending; steady-state no duplicate/rewrite; turn_end cancels "turn ended"; auth_resume resolves; observed gen exit cancels; gen bump cancels superseded; hsrUnavailable/untrusted → zero writes; fresh reconciler (restart) does not re-open resolved; kill_failed record → stop-failed opened.
4. Dispatcher migration per above. Tests: routed once across two dispatcher INSTANCES (restart sim); escalation persisted; resolved never routed; missing record self-heals.
5. BeeView store-first + CLI history: types widening, storedRequests threading, merge/suppression, recentClosedRequests, explain Recent block, update docs/BEEVIEW_READ_API.md + docs/HIVE_CLI_REFERENCE.md. Tests: store-open beats live derivation under one id; answered-but-trailing NOT needs-reply; daemon-down fallback still needs-reply; pane-permission suppressed by same-id record; explain snapshot.
6. Docs re-status: ADR 001 implementation-strategy note + assessment §4 step 4 shipped; document HIVE_REQUESTS_KEEP_CLOSED. Copy this design file into docs/INTERVENTION_REQUESTS.md (first commit).
