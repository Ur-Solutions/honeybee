# ADR 001: Separate Bee Lifecycle, Runtime, Turn, Human Request, and Review State

Status: Accepted (domain semantics). Storage and writer topology moved to ADR 002 (experimental).  
Date: 2026-07-27  
Decision owners: Honeybee maintainers  
Related specification: [State Model V2 Migration Specification](../STATE_MODEL_MIGRATION_SPEC.md) (deferred)  
Related documents: [ADR 002](./002-event-journal-daemon-authority.md) (experimental),
[State Model V2 Assessment](../STATE_MODEL_V2_ASSESSMENT.md) (active plan)

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

## Storage and writer topology

The event journal, single-daemon writer topology, and minimum event vocabulary
that originally accompanied this decision were split into
[ADR 002](./002-event-journal-daemon-authority.md) on 2026-07-28. ADR 002 is
experimental and not accepted. The domain semantics in this ADR do not depend
on that storage architecture.

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
6. End-evidence supersession is compatible with the projected outcome.
7. Completion and review never alter Bee lifecycle or runtime state.
8. Retrying work creates a new Turn; history is never rebound or rewritten.
9. Reads expose staleness.

The remaining original invariants — event ingestion idempotent on
`(originId, originSeq)`; events immutable and projections rebuildable; hooks
and adapters emit facts while only the daemon validates transitions; reads
that remain available without the daemon — only make sense with an event
journal. If an event journal is adopted, see
[ADR 002](./002-event-journal-daemon-authority.md).

## Consequences

Positive consequences:

- “Needs reply” has one exact, inspectable cause.
- A completed response no longer makes a live Bee appear retired.
- Pane idleness no longer masquerades as task success.
- Apiary can remove duplicated attention and completion heuristics.
- State history becomes explainable from immutable evidence.

Costs and risks:

- Existing files and Apiary's local Inbox ledger require a staged migration.
- Pane-based observers remain heuristic and must retain their evidence grade.

Storage-specific consequences (daemon as required mutation authority; SQLite,
RPC versioning, origin spools, and rebuild tooling; idempotent remote replay;
restart-safe needs-input routing; event and spool retention) moved to
[ADR 002](./002-event-journal-daemon-authority.md).

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

### Treat idle as success

Rejected because unstructured tmux agents can prove only that output settled.
Semantic success requires contract evidence.

### Put observer uncertainty in RuntimeGeneration state

Rejected because uncertainty describes knowledge, not the process.

The storage-specific alternative (treat JSONL as the canonical multi-writer
journal) moved to [ADR 002](./002-event-journal-daemon-authority.md).

## Implementation strategy

Adoption is forward-only, per the operator decision of 2026-07-28:

- A `BeeView` read model — a library with a CLI mirror
  (`hive state explain`) — projects the current stores into this ADR's
  consumer contract first. No new writes, no SQLite, no daemon requirement.
- An InterventionRequest vertical slice follows: durable request records with
  the idempotency-key and scope-closure invariants above, from which
  `needs-reply` derives solely.
- Turn ids are stamped for new work only. Historical state is not migrated;
  legacy records stay readable as legacy evidence.
- The full storage cutover in the
  [migration specification](../STATE_MODEL_MIGRATION_SPEC.md) is deferred.

See the [State Model V2 Assessment](../STATE_MODEL_V2_ASSESSMENT.md) §4 for
the ordered, independently shippable steps.

## Deferred decisions

- Event and spool retention after Bee retirement
- Cross-node transfer of controlling authority
- Whether repeated retry chains eventually justify a first-class Work aggregate
- Final transport shape for the stable read API
