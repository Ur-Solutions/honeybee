# ADR 001: Separate Bee Lifecycle, Runtime, Turn, Human Request, and Review State

Status: Proposed  
Date: 2026-07-27  
Decision owners: Honeybee maintainers  
Related specification: [State Model V2 Migration Specification](../STATE_MODEL_MIGRATION_SPEC.md)

## Context

Honeybee currently presents lifecycle, process liveness, work activity, human
attention, observation confidence, and completion through overlapping fields:

- `SessionRecord.status`
- `SessionRecord.lastObservedState`
- the derived `BeeState` union in [`src/state.ts`](../../src/state.ts)
- tmux's public `@hive_state` option in
  [`src/hiveState.ts`](../../src/hiveState.ts)
- seals and flight contracts
- HSR events and pane/transcript heuristics
- Apiary's independently derived `HiveSessionStatus` and Inbox admission ledger

The overlap makes ordinary questions surprisingly difficult:

- Is a bee alive?
- Is it currently executing a turn?
- Has its latest response ended?
- Did it actually satisfy its task contract?
- Does it require a reply, authentication, recovery, or only review?
- Is the observer uncertain, or is the runtime itself in an uncertain state?

The current `BeeState` vocabulary answers several of these questions at once.
For example:

- `done` can mean a retired bee or a sealed result.
- `idle_with_output` means a response appears settled, but not necessarily that
  its task succeeded.
- `blocked` means human input may be required, but the durable request is held
  elsewhere or inferred from a pane.
- `node_unreachable` describes an observer's knowledge, not the runtime.
- `@hive_state=waiting` currently covers `ready`, `blocked`, and `auth-needed`.

Apiary consequently maintains additional rules for observation freshness,
transcript-tail evidence, lifecycle disambiguation, completed-turn admission,
snoozing, and archive/revive behavior. Those rules are valuable evidence about
the product semantics, but they should not remain a second state machine.

## Decision

Honeybee will stop persisting one composite bee state. It will model separate
domain records with small state machines and expose a versioned read model for
consumers.

The authoritative distinctions are:

```text
Bee lifecycle
Runtime process lifecycle
Turn execution lifecycle
Turn-end evidence
Task-contract result
Human intervention requests
Review Inbox projection
Observer freshness
```

No record may duplicate another record's authoritative fact.

## Domain records

### Bee

A Bee is durable identity, configuration, lineage, and lifecycle.

```text
lifecycle: active | retired
```

A Bee retains current non-state `SessionRecord` data, including:

- canonical id, UUID, name, title, agent, and account
- cwd, launch configuration, model, reasoning, and preamble
- colony, swarm, tags, lineage, and task/flow attribution
- substrate preference and controlling node
- transcript and artifact references

Retirement does not delete the Bee, turns, requests, seals, messages,
transcripts, or review history.

### RuntimeGeneration

Every initial spawn, revive, promote, demote, or process replacement creates a
new RuntimeGeneration.

```text
state: starting | online | exited
```

The generation owns process-specific facts:

- substrate, node, tmux target, pane id, host pid, and launcher pid
- generation ordinal
- provider thread/session id
- start, online, stop-request, and exit timestamps
- observation heartbeat contract
- exit classification

Exit classification is derived:

```text
clean    process completed under an explicit exit contract
stopped  an exit followed a stop-requested event for this generation
crashed  an exit occurred without a matching stop request
```

`stop-failed` is not a RuntimeGeneration state. A failed stop leaves the
generation online, records a `generation.stop_failed` event, and opens a
manual-action request.

Authentication is not a RuntimeGeneration state. It is an open authentication
InterventionRequest scoped to the generation.

Observer uncertainty is not a RuntimeGeneration state. It is represented by
observation metadata and derived staleness.

### Turn

A Turn is one accepted unit of interaction.

```text
state: queued | running | ended
```

Rules:

- A queued Turn binds to a Bee.
- Delivery binds it permanently to one RuntimeGeneration and makes it running.
- Input delivered while a Turn is running is a `turn.input` event on that Turn.
  Answers, steering messages, deterministic nudges, and mid-turn Buz injections
  do not create additional Turns.
- Input delivered to a ready composer creates a new Turn.
- A retry after interruption creates a new Turn linked by task, work, or parent
  id. An ended Turn is never rebound to another generation.
- A queued Turn may survive a runtime crash and be delivered to a later
  generation because it was never bound to the failed generation.

Honeybee Turns are not provider/harness turns. Provider `turn_start` and
`turn_end` messages are evidence about a Honeybee Turn.

### TurnEndEvidence

Turn ending and task success are separate facts.

One Turn may receive multiple immutable end-evidence events. The projection
selects the strongest compatible evidence:

| Evidence | Typical source | Projected outcome |
| --- | --- | --- |
| `provider-turn-end` | Structured harness protocol | `responded` or `failed` |
| `hook-turn-end` | Claude Stop/Notification-style hook | `responded` |
| `runtime-exit` | Bound generation exited mid-turn | `interrupted` |
| `observer-settled` | Stable pane/transcript fingerprint | `settled-unverified` |
| operator cancellation | Explicit command | `cancelled` |

Projected outcomes are:

```text
responded | settled-unverified | interrupted | failed | cancelled
```

Evidence selection is outcome-aware, not a blind numeric maximum:

- A late provider or hook end may supersede an earlier observer-settled event.
- A runtime exit interrupts only a still-running Turn.
- Runtime exit never overwrites an accepted provider or hook end.
- Missing observations and timeouts never end a Turn.
- All evidence remains in the journal after projection supersession.

For an unstructured tmux/PTY agent, `settled-unverified` is an honest terminal
outcome. The system must not translate pane idleness into success.

### ContractResult

A ContractResult records semantic task completion independently of Turn ending.

```text
verdict: success | failed | blocked
evidence: turn-bound seal | explicit contract result
```

Rules:

- Observer-only evidence can never verify contract success.
- A seal must correlate to the Turn's task id and attempt when the contract
  requires those keys.
- A keyless seal remains a reviewable artifact but is not contract completion.
- A late seal may add verified success to an already ended Turn without
  rewriting its TurnEndEvidence.

This preserves the flight invariant that idle without a matching seal is a
stall, not task completion.

### InterventionRequest

An InterventionRequest is the sole owner of human-attention truth.

```text
kind: question | permission | auth | manual-action
status: open | resolved | cancelled
scope: turn | runtime-generation | bee
grade: structured | observer
```

Each request has a durable idempotency key. Structured provider request ids are
preferred. Observer-grade requests use a stable key derived from scope, kind,
payload fingerprint, and a bounded observation occurrence.

Scope closure is transactional:

- ending a Turn cancels its open requests with reason `scope-closed`
- exiting a RuntimeGeneration cancels requests scoped to it and its running
  Turns
- cancellation is an event, so a rebuild cannot resurrect stale requests

Labeling and blocking are separate:

| Open request | Display label |
| --- | --- |
| question or permission | `needs-reply` |
| authentication | `needs-auth` |
| manual action | `needs-action` |

A manual action may block work, but it never becomes `needs-reply`. If the
required interaction is a structured answer, it is a question or permission
request instead.

### InboxItem

InboxItem is a stored, rebuildable projection, not an independent source of
task or attention truth.

Inbox sources include:

- verified ContractResults
- ended Turns requiring review
- open authentication and manual-action requests
- crashes and recovery conditions

Inbox item ids are deterministic from the source fact. Read, dismiss, and
snooze actions append disposition events keyed to that id. Rebuilding folds
source events and disposition events, so dismissed or snoozed items do not
reappear accidentally.

Review items distinguish at least:

```text
verified-result
inspect-response
inspect-settled-unverified
```

## Derived BeeDisplayState

BeeDisplayState is a pure read-model projection. It is never persisted as
domain truth.

The precedence is:

```text
retired
needs-auth
needs-reply
needs-action
stop-failed
crashed
unreachable
starting
working
ready
offline
```

Definitions:

- `retired`: Bee lifecycle is retired.
- `needs-auth`: an authentication request is open.
- `needs-reply`: a question or permission request is open.
- `needs-action`: a manual-action request is open.
- `stop-failed`: the latest stop request failed and the generation remains
  online.
- `crashed`: the latest generation exited without stop intent.
- `unreachable`: an explicit heartbeat contract has been violated.
- `starting`: the latest generation is starting.
- `working`: the latest generation is online with a running Turn.
- `ready`: the latest generation is online without a running Turn.
- `offline`: the Bee is active but has no online generation and is revivable.

Completion and review never change BeeDisplayState. A Bee can be `ready` while
its latest result is in the Inbox.

Unreachable requires a source-specific heartbeat contract. Silence from a
source that does not promise heartbeats is not evidence of unreachability.

## Event journal and writer topology

The canonical domain journal is an append-only SQLite event table owned by one
supervised daemon per Hive home.

The daemon:

- is the single transition authority
- is autostarted and watchdogged
- holds no state required for restart
- validates commands and appends events plus projections transactionally
- ingests source events idempotently
- can be killed at any instruction boundary and recover from SQLite plus origin
  spools

Commands such as spawn, send, answer, stop, retire, and snooze use versioned
daemon RPC and fail closed with a clear error.

Event emitters such as hooks, harness adapters, observers, and remote hosts are
spool-first and fail open. They durably append to a per-origin spool before
attempting ingestion. Short-lived hooks never depend on a live RPC round trip.

The journal deduplicates on:

```text
(originId, originSeq)
```

Every event carries:

```text
position       local canonical ingest order
originId       durable emitter identity
originSeq      emitter-owned monotonic sequence
beeId
generationId? 
turnId?
type
payload
occurredAt     origin clock
ingestedAt     controlling-node clock
source
grade
```

Ordering is guaranteed only within an origin stream. Cross-origin order is
projection order, not a claim about wall-clock causality.

The token/text/thought/tool/usage firehose remains in generation spools.
Domain events may carry checkpoint references into those files. Raw spools are
evidence archives and transport outboxes, not competing domain truth.

Reads do not require a healthy daemon. Honeybee opens SQLite read-only and
surfaces `lastProjectedAt` and source freshness. Consumers use a stable
Honeybee read API rather than depending on table layout.

Each Bee has exactly one controlling node in v1. Remote nodes emit facts to
that authority and do not maintain a competing canonical projection.
Cross-node authority transfer is a later decision.

## Minimum event vocabulary

```text
bee.created
bee.retired

generation.starting
generation.online
generation.observed
generation.stop_requested
generation.stop_failed
generation.exited

turn.accepted
turn.delivered
turn.input
turn.end_evidence
turn.cancelled

request.opened
request.resolved
request.cancelled

contract.result

inbox.read
inbox.dismissed
inbox.snoozed
```

When `generation.exited` is ingested, the daemon appends deterministic
daemon-origin consequence events in the same transaction:

- `turn.end_evidence(interrupted)` for bound running Turns
- `request.cancelled(scope-closed)` for affected open requests

Reducers must not silently create projection facts that are absent from the
event journal.

## Consumer contract

Honeybee will expose a versioned `BeeViewV2`-style read model. Exact transport
is specified separately, but the contract must provide structured facts rather
than ask consumers to reverse-engineer a label:

```text
schemaVersion
bee
latestRuntime
currentTurn?
openRequests[]
latestTurnResult?
latestContractResult?
inboxSummary
displayState
observationFreshness
lastProjectedAt
compatibilityFields
```

During migration, existing `hive ps --json` and Apiary fields remain available.
New fields are additive until every consumer has moved.

## Compatibility policy for `@hive_state`

`@hive_state` remains a one-way, projector-owned compatibility cache during
migration:

- hooks emit events; they do not write authoritative state
- reducers never read `@hive_state`
- the compatibility projector may continue writing the existing four values
  for tmux status bars and older Apiary versions
- after all consumers use the V2 read model, `@hive_state` is removed

The target architecture has one domain truth even while it temporarily
supports old read contracts.

## Invariants

1. Verified success never comes from observer-only evidence.
2. Missing observation is never a state transition.
3. Awaiting human is derived solely from open InterventionRequests.
4. A generation exit transactionally interrupts bound running Turns and
   cancels scoped requests through logged consequence events.
5. `exitClass=stopped` requires prior stop intent for that generation.
6. Event ingestion is idempotent on `(originId, originSeq)`.
7. Events are immutable; projections are rebuildable.
8. End-evidence supersession is compatible with the projected outcome.
9. Hooks and adapters emit facts; only the daemon validates transitions.
10. Completion and review never alter Bee lifecycle or runtime state.
11. Retrying work creates a new Turn; history is never rebound or rewritten.
12. Reads expose staleness and remain available without the daemon.

## Consequences

Positive consequences:

- “Needs reply” has one exact, inspectable cause.
- A completed response no longer makes a live Bee appear retired.
- Pane idleness no longer masquerades as task success.
- Apiary can remove duplicated attention and completion heuristics.
- Daemon restarts cannot duplicate needs-input routing or resurrect dismissed
  Inbox items.
- Remote replay is idempotent.
- State history becomes explainable from immutable evidence.

Costs and risks:

- The daemon becomes a required mutation authority.
- SQLite, RPC versioning, origin spools, and rebuild tooling add infrastructure.
- Existing files and Apiary's local Inbox ledger require a staged migration.
- Pane-based observers remain heuristic and must retain their evidence grade.
- Event and spool retention needs a separate archival policy.

## Alternatives rejected

### Keep extending `BeeState`

Rejected because it continues mixing lifecycle, work, attention, completion,
failure, and observer knowledge in one enum.

### Persist orthogonal `phase` and `attention` fields

Rejected because independently writable fields can still describe impossible
combinations and duplicate request/result records. The domain split provides
the same query power with explicit ownership.

### Persist `awaiting-human` on Turn

Rejected because it duplicates an open InterventionRequest. It remains a
derived presentation only.

### Treat JSONL as the canonical multi-writer journal

Rejected for the clean target because every process would need locking,
deduplication, validation, and corruption recovery. JSONL remains appropriate
for origin spools, raw harness evidence, export, and debugging.

### Treat idle as success

Rejected because unstructured tmux agents can prove only that output settled.
Semantic success requires contract evidence.

### Put observer uncertainty in RuntimeGeneration state

Rejected because uncertainty describes knowledge, not the process.

## Deferred decisions

- Event and spool retention after Bee retirement
- Cross-node transfer of controlling authority
- Whether repeated retry chains eventually justify a first-class Work aggregate
- Final transport shape for the stable read API
