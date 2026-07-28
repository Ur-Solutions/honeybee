# ADR 002: Event Journal, SQLite Storage, and Daemon Mutation Authority

Status: Experimental — not accepted. Do not implement without a new decision.  
Date: 2026-07-28  
Decision owners: Honeybee maintainers  
Related documents: [ADR 001](./001-bee-runtime-turn-state-model.md) (accepted domain semantics),
[State Model V2 Migration Specification](../STATE_MODEL_MIGRATION_SPEC.md) (deferred),
[State Model V2 Assessment](../STATE_MODEL_V2_ASSESSMENT.md) (active plan)

## Context

This material was split out of
[ADR 001](./001-bee-runtime-turn-state-model.md) on 2026-07-28. The operator
accepted ADR 001's domain semantics — Bee, RuntimeGeneration, Turn,
TurnEndEvidence, ContractResult, InterventionRequest, InboxItem, and the
derived BeeDisplayState — but not the storage and writer topology that
originally accompanied them: an append-only SQLite event journal with a single
supervised daemon as the sole mutation authority.

That architecture is preserved here verbatim as an experimental design so a
future decision can adopt, revise, or retire it. The active implementation
path is forward-only and does not depend on it; see the
[State Model V2 Assessment](../STATE_MODEL_V2_ASSESSMENT.md) §4.

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

## Storage invariants

These invariants moved here from ADR 001 because they only make sense with an
event journal:

1. Event ingestion is idempotent on `(originId, originSeq)`.
2. Events are immutable; projections are rebuildable.
3. Hooks and adapters emit facts; only the daemon validates transitions.
4. Reads remain available without the daemon.

## Consequences

Positive consequences:

- Daemon restarts cannot duplicate needs-input routing or resurrect dismissed
  Inbox items.
- Remote replay is idempotent.

Costs and risks:

- The daemon becomes a required mutation authority.
- SQLite, RPC versioning, origin spools, and rebuild tooling add infrastructure.
- Event and spool retention needs a separate archival policy.

## Alternatives rejected

### Treat JSONL as the canonical multi-writer journal

Rejected for the clean target because every process would need locking,
deduplication, validation, and corruption recovery. JSONL remains appropriate
for origin spools, raw harness evidence, export, and debugging.

## Evidence that would justify adoption

Adopt this ADR only when concrete symptoms demand it:

- The needs-input dispatcher's dedupe is in-memory and forgets on daemon
  restart (`src/daemon/needsInput.ts`), so a restart can re-route the same
  needs-input condition.
- The remote event mirror replays events on reconnect with no idempotent
  ingest, duplicating facts.
- Apiary's inbox dispositions are not rebuildable from durable events.
- Any future multi-writer corruption incident.

If the forward-only steps in the assessment — BeeView read API,
InterventionRequest slice, Turn ids for new work — solve the felt pain, this
ADR may be retired unimplemented.
