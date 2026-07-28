# State Model V2 Migration Specification

Status: Deferred — possible later convergence plan. Not the implementation plan.  
Date: 2026-07-27  
Architecture decision: [ADR 001](./adr/001-bee-runtime-turn-state-model.md)  
Primary goal: migrate Honeybee and Apiary to the V2 state model without losing
data, live runtimes, operator workflow, or UI behavior.

> **Deferred (operator decision, 2026-07-28).** This spec was written for a
> full storage cutover that is on hold. The active path is the forward-only
> plan in [STATE_MODEL_V2_ASSESSMENT.md §4](./STATE_MODEL_V2_ASSESSMENT.md):
> no history import, no SQLite, no daemon mutation authority. The legacy-state
> interpretation table (§8), the invariants, and the UI gate checklist (§11.4)
> remain useful references regardless of storage.

## 1. Purpose

This specification defines how to introduce the Bee/RuntimeGeneration/Turn/
InterventionRequest/ContractResult model into an existing Hive home.

It is intentionally stricter than a database backfill plan. Current user-visible
behavior is assembled from several independent stores and live sources:

- Honeybee session JSON
- tmux sessions and `@hive_*` options
- the Honeybee ledger and seals
- Buz mailboxes
- HSR run directories and remote mirrors
- provider transcripts and ownership claims
- flights, tasks, and flows
- Apiary's local agent Inbox ledger
- Apiary's transcript-tail and attention heuristics

A migration that copies session rows but ignores those surfaces will lose
history or change the UI.

## 2. Required outcomes

After cutover:

1. Every existing Bee remains addressable by every identifier that worked
   before migration.
2. No live tmux or HSR runtime is killed, relaunched, detached, or rebound merely
   because migration ran.
3. All existing session configuration, lineage, tags, transcripts, seals,
   messages, tasks, flows, flights, and Inbox dispositions remain available.
4. Apiary shows the same Bees, grouping, titles, metadata, transcript access,
   and actions.
5. `needs-reply` appears only for an open question or permission request.
6. Authentication, recovery, review, and manual action remain visibly distinct.
7. A response that ended remains reviewable without making its live Bee look
   retired.
8. Existing snoozes and Inbox admission order survive.
9. Older CLI and Apiary read contracts continue to work during the compatibility
   window.
10. Rollback restores the old reader and writer path without restoring a stale
    filesystem backup.

## 3. Non-goals

- Reconstructing a perfect historical Turn for every old transcript.
- Moving provider-owned transcript content into SQLite.
- Rewriting Buz, task, flight, flow, account, or spend storage as part of this
  migration.
- Automatically transferring Bee authority between nodes.
- Deleting legacy files at cutover.
- Changing Apiary visual design beyond consuming more accurate semantics.

## 4. Safety principles

### 4.1 Legacy stores are read-only migration inputs

The initial importer never rewrites or deletes legacy data. Before importing,
it records a manifest containing path, size, modification time, and SHA-256 for
every in-scope file and creates a recoverable snapshot.

Legacy cleanup is a separate, explicitly approved operation after the rollback
window.

### 4.2 Import is deterministic, idempotent, and restartable

Every imported event has a deterministic id derived from:

```text
migration run id
source store
source record identity
source content revision or stable semantic key
```

Re-running an interrupted import produces no duplicate events, requests,
results, or Inbox items.

### 4.3 Do not invent certainty

Legacy snapshots are incomplete. The importer records provenance and evidence
grade and creates only facts it can support.

It must not:

- infer success from `idle_with_output`, `ready`, `done`, or pane stability
- fabricate an open request from a stale `blocked` string
- infer exact historical Turn boundaries from transcript prose
- interpret keyless seals as verified contract results
- interpret observation timestamps as work-completion timestamps

### 4.4 Existing runtimes are adopted, not restarted

The migration reconciler identifies each live tmux pane or HSR host and creates
a RuntimeGeneration projection around it. It does not execute spawn, resume,
promote, demote, stop, kill, or retire.

### 4.5 Mixed-version mutation requires a bridge release

An old Honeybee binary can mutate session JSON and tmux without consulting a V2
daemon. Therefore a safe migration cannot begin by merely installing SQLite.

The release before V2 cutover must teach every mutating client to:

- participate in a store-wide mutation/version gate
- advertise its protocol and schema capabilities
- durably spool emitted events
- tolerate additive compatibility fields

Migration must refuse to enter shadow or cutover mode while any known local or
remote mutator is older than that bridge release.

Mixed-version reads are supported. Uncoordinated mixed-version mutations are
not.

## 5. Legacy data inventory and disposition

| Surface | Current role | V2 disposition |
| --- | --- | --- |
| `~/.hive/sessions/*.json` | Bee identity, configuration, lifecycle, latest observation, runtime hints | Import Bee and current-generation baseline; retain and compatibility-mirror during rollback window |
| `~/.hive/ledger.jsonl*` | Audit events, transitions, prompts, seals, daemon activity | Preserve byte-for-byte; import only events with reliable identity and semantics |
| `~/.hive/seals/<bee>/*.json` | Review artifacts and completion contracts | Preserve paths and hashes; create ContractResult only for correlatable turn/task seals |
| `~/.hive/buz/<bee>/**` | Durable Inbox/outbox/queue/read/quarantine messages | Keep as message store; do not reinterpret historical messages as Turns |
| `~/.hive/hsr/<bee>/meta.json` | Host/generation identity and liveness | Reconcile into current RuntimeGeneration with source provenance |
| `~/.hive/hsr/<bee>/events.jsonl` | Structured harness event stream or remote mirror | Keep as raw evidence/origin spool; ingest state-relevant events idempotently |
| `~/.hive/hsr/<bee>/ring.txt` | Bounded console output | Preserve as console evidence; never import into domain journal |
| `~/.hive/transcript-ownership/**` and session transcript fields | Provider transcript matching and ownership | Preserve claims and references; do not move provider transcript content |
| provider transcript stores | Full conversation history | Remain provider-owned and externally referenced |
| tmux sessions and `@hive_*` | Live process plus public compatibility metadata | Adopt live generation; continue one-way compatibility projection |
| `~/.hive/tasks/**` | Durable task queues and claims | Keep unchanged; new Turns link to task ids where available |
| `~/.hive/flights/**` | Attempts, slots, contract enforcement | Keep unchanged initially; map future attempts to Turn and ContractResult ids |
| `~/.hive/flows/**` | Flow templates and run records | Keep unchanged; future generated Turns retain flow/run attribution |
| nodes, accounts, pools, frames, colonies, identity index | Configuration and topology | Preserve unchanged; reference from Bee or RuntimeGeneration |
| Apiary `agent-inbox-state.json` | Completed-turn admission, archive/revive pins, snoozes | Import or bridge into V2 Inbox dispositions before Apiary cutover |
| Apiary workspace and pane state | Focus, layout, navigation, optimistic UI | Never reset or rewrite as part of Honeybee migration |

The migration manifest must discover actual configured Hive and Apiary roots. It
must not assume `~/.hive` when `HIVE_STORE_ROOT` or a workspace-specific data
directory is in use.

### 5.1 Proposed V2 storage layout

The exact names may change during implementation, but the responsibilities must
remain separate:

```text
<storeRoot>/state-v2/control.sqlite
<storeRoot>/state-v2/origins/<origin-id>/
<storeRoot>/migrations/state-v2/<run-id>/
```

`control.sqlite` contains:

| Table | Responsibility |
| --- | --- |
| `events` | Canonical immutable domain journal; unique on `(origin_id, origin_seq)` |
| `projection_meta` | Schema/reducer version, last projected position, rebuild status, and freshness |
| `bee` | Bee identity/configuration/lifecycle projection |
| `runtime_generation` | Process-generation projection |
| `turn` | Turn lifecycle and selected end-evidence projection |
| `intervention_request` | Durable open/resolved/cancelled request projection |
| `contract_result` | Verified task-contract outcomes |
| `inbox_item` | Rebuildable review/attention workflow projection |
| `origin_checkpoint` | Last durably ingested source sequence and spool checkpoint |
| `legacy_alias` | Record stem, canonical id, UUID, tmux target, and prior-name lookup |
| `migration_run` | Run identity, source manifest hash, phase, versions, and timestamps |
| `migration_source` | Per-source path, hash, import key, disposition, and error |

Projection tables are disposable. `events`, migration provenance, and retained
origin spools are sufficient to rebuild them.

Migration phase changes are append-only records, even if `migration_run` also
contains the latest phase for convenient inspection:

```text
planned
snapshotted
importing
shadowing
canary
read-cutover
mutation-cutover
rolled-back
complete
failed
```

An interrupted process cannot infer completion from the presence of a database
file; it resumes from the last recorded phase and source disposition.

### 5.2 Snapshot requirements

The migration snapshot lives under:

```text
<storeRoot>/migrations/state-v2/<run-id>/
```

It contains:

- the canonical manifest and its hash
- byte copies of in-scope Honeybee files
- a separately rooted copy of each Apiary `agent-inbox-state.json`
- CLI, daemon, remote-host, schema, and workspace version inventory
- validation, parity, cutover, restore, and rollback reports

Snapshot rules:

- acquire the mutation gate before hashing and copying mutable sources
- use byte copies, not hard links, for appendable JSONL files
- preserve relative paths and file modes
- make the migration directory owner-only
- never follow a symlink outside an inventoried root without explicit approval
- verify copied hashes before releasing the gate
- record missing files as missing rather than creating empty substitutes

A live SQLite database is backed up with SQLite's backup API or a coordinated
WAL checkpoint. Copying only the main database file is invalid because committed
pages may still exist in `-wal`.

## 6. Legacy `SessionRecord` field mapping

No `SessionRecord` field may disappear merely because it is not part of the new
state machines.

| Legacy field family | V2 owner |
| --- | --- |
| `id`, `uuid`, `prefix`, `name`, `title`, `titleSource` | Bee identity |
| `agent`, `requestedAgent`, `accountId`, `homePath`, `kitVersion`, `kitProfile` | Bee launch configuration |
| `cwd`, `command`, `launchArgv`, `model`, `modelExtraArgs`, preamble | Bee launch configuration; copied to each new generation at creation |
| `colony`, `swarmId`, `caste`, `tags`, `reportsToId`, `spawnedById`, fork lineage | Bee topology and lineage |
| `node`, `substrate`, `tmuxTarget`, `agentPaneId`, runner/launcher pids | RuntimeGeneration |
| `providerSessionId`, transcript path/ownership metadata | Conversation/thread reference, carried across generations when resuming |
| `runtimeGeneration`, created/updated timestamps | Generation baseline and provenance |
| `lastPrompt`, `lastPromptAt` | Latest legacy Turn baseline and compatibility projection |
| `contract`, `sealHighWaterFilename` | Turn/ContractResult correlation and migration high-water mark |
| `lastObservedState`, `lastObservedStateAt` | Legacy observation evidence only |
| `status` | Bee lifecycle or exit evidence after disambiguation |
| `lastError`, `terminalTranscriptDiscoveryAt` | Generation diagnostic/projection metadata |
| `buzAccept`, task supply, autoswap, pool, flow, run fields | Bee policy and external subsystem references |

Unknown keys continue to round-trip through the compatibility projection during
the entire rollback window.

## 7. Identity rules

### 7.1 Bee identity

Identity selection order:

1. existing UUID
2. existing canonical `id`
3. deterministic legacy id from controlling-node machine id plus session record
   stem

The record stem, visible name, canonical id, UUID, tmux target, and historical
aliases are stored as lookup aliases. A migration must not rename the session
file or tmux session.

### 7.2 Runtime generation identity

For a legacy current runtime, the imported generation id is deterministic from:

```text
bee id + legacy runtimeGeneration ordinal + incarnation evidence
```

If `runtimeGeneration` is missing, use ordinal zero and mark it
`source=legacy-baseline`.

Past generations are not fabricated from the ordinal alone. Their historical
evidence stays in ledger, seals, transcripts, and HSR archives.

### 7.3 Turn identity

The importer creates at most one synthetic legacy Turn per Bee unless a
structured source provides reliable boundaries.

If no prompt was delivered, it creates no Turn.

If a latest prompt exists:

- create `turn.accepted` with `source=legacy-baseline`
- bind it to the live generation only when positive delivery/liveness evidence
  exists
- use provider/hook end events when available
- otherwise use `observer-settled` only after a successful live reconciliation
- never create ContractResult success without correlating evidence

Historical transcript messages remain visible without being falsely promoted
to domain Turns.

## 8. Legacy-state interpretation

The importer uses both lifecycle and positive live evidence. Flat state strings
alone are insufficient.

| Legacy evidence | V2 interpretation |
| --- | --- |
| `status=done` or legacy `archived` | Bee lifecycle `retired` |
| live runtime plus seal-derived `done` | Runtime remains online/ready; seal becomes artifact or ContractResult; review Inbox item |
| `idle_with_output` after successful observation | Turn may end `settled-unverified`; Bee is `ready` |
| `ready` with no prompt | Online RuntimeGeneration, no Turn, Bee `ready` |
| `active`/`booting` with live runtime | Starting or online generation; latest delivered Turn may be running |
| fresh structured `needs_input` | Open question/permission request |
| pane-classified permission prompt from successful capture | Open observer-grade permission request |
| stale `blocked` without current prompt evidence | No open request is fabricated |
| `auth-needed` with current auth-expired evidence | Open generation-scoped authentication request |
| `kill_failed` with live process | Online generation, stop-failed diagnostic, manual-action request |
| dead runtime plus prior stop intent | Generation exited/stopped |
| dead runtime without stop intent | Generation exited/crashed |
| `node_unreachable` | Observation freshness/unreachable projection only |

`@hive_state=waiting` is never imported directly as `needs-reply`, because the
legacy value also represents `ready` and `auth-needed`.

## 9. Apiary compatibility contract

### 9.1 Stable read shape

During migration, Honeybee adds structured V2 fields without removing the
current `hive ps --json` fields:

```text
ref
name
id
title
agent
state
beeState
detail
colony
swarm
node
substrate
cwd
createdAt
updatedAt
```

Apiary continues receiving all current `HiveSession` metadata, including
lineage, account, model, reasoning, tags, prompt timestamps, transcript
references, and optimistic-spawn reconciliation keys.

The V2 consumer model adds:

```text
schemaVersion
beeLifecycle
runtimeState
runtimeGenerationId
turnId?
turnState?
turnOutcome?
turnEvidence?
contractResult?
openRequests[]
displayState
inboxItems[]
lastProjectedAt
sourceFreshness
```

Apiary must consume this through a Honeybee-owned reader/adapter. It must not
couple renderer code directly to SQLite tables.

### 9.2 Status mapping

Apiary's migration adapter uses V2 facts directly:

| V2 display/result | Apiary behavior |
| --- | --- |
| `working` | Running indicator and live-turn timer |
| `ready` | Ready/idle presentation; composer enabled |
| `needs-reply` | Needs Reply badge and structured request UI |
| `needs-auth` | Authentication recovery UI |
| `needs-action` | Manual recovery/action UI |
| `crashed` | Revive/recovery UI |
| `unreachable` | Node/source connectivity warning |
| `retired` | Filed/read-only visual treatment |
| ended Turn | Durable Inbox review item |
| verified ContractResult | Verified review/result treatment |
| `settled-unverified` | Inspect-result treatment, never verified success |

The composer remains visually neutral in `needs-reply`; attention belongs on
the request card, status badge, and Inbox row. The migration must not restore
the previous yellow composer glow.

### 9.3 Apiary Inbox migration

Before switching Apiary to Honeybee Inbox items:

1. Read each workspace's `agent-inbox-state.json`.
2. Match rows to Bees using session stem, canonical id, UUID, and aliases.
3. Map `admittedCompletionAt` to the corresponding imported review item when
   one exists.
4. Map snooze deadline and completion generation to `inbox.snoozed`.
5. Preserve archive/revive pins until a genuinely new Turn is accepted.
6. Place unmatched rows in a namespaced legacy table and keep the old ledger
   active for those rows.
7. Compare old and new Inbox membership, ordering, urgent-state wakeups, and
   snooze behavior before cutover.

During the rollback window, Apiary writes Inbox dispositions to both the V2
command API and its local ledger. This is a compatibility dual write, not
permanent ownership.

## 10. Rollout phases

### Phase A: Compatibility preparation

Ship without changing the source of truth:

- protocol/schema capability handshake
- store-wide mutation/version gate used by every mutating command
- durable origin ids and sequence allocation
- spool-first hook and adapter emitters
- V2 event and read-model types behind a feature flag
- additive CLI JSON fields only
- Apiary adapter capable of reading V1 or V2
- inventory, doctor, snapshot, and parity tooling

Gate:

- every local CLI, daemon, hook bundle, and remote runner host reports the bridge
  capability
- no unknown legacy mutator remains

### Phase B: Snapshot and baseline import

1. Acquire the migration gate.
2. Record daemon, CLI, remote-host, store-root, and Apiary workspace versions.
3. Build the checksum manifest and recoverable snapshot.
4. Run legacy-store validation.
5. Create the SQLite event journal and projections in a new versioned path.
6. Import deterministic baseline events.
7. Run SQLite `PRAGMA integrity_check`.
8. Rebuild projections from the event table into empty tables and compare them
   with the initially built projections.
9. Release the migration gate.

The phase aborts without cutover on any validation or parity failure.

### Phase C: Shadow projection

The V1 path remains authoritative.

The V2 daemon:

- ingests new origin spools
- watches bridge-era legacy writes
- maintains V2 projections
- emits no user-visible state changes

Parity tooling continuously compares normalized V1 and V2 views. Differences
are classified as:

```text
expected semantic correction
temporary observation skew
migration defect
unmappable legacy ambiguity
```

Expected corrections, such as `waiting` becoming `ready`, require explicit
fixtures and approval. They are not silently excluded from comparison.

### Phase D: Apiary canary

Enable V2 reads for an opt-in workspace or feature flag while preserving the
V1 adapter and local Inbox ledger.

Exercise:

- local tmux, local HSR, and remote HSR Bees
- new spawn, send, answer, steer, stop, retire, revive, fork, and handoff
- structured question and permission forms
- authentication expiry and recovery
- crash and stop-failure recovery
- seal before and after turn settlement
- Inbox admission, snooze, dismissal, and new-turn wakeup
- archived/retired groups and undo/revive

### Phase E: Read cutover

Make V2 the default reader only after all parity and UI gates pass.

Keep:

- V1 JSON compatibility projection
- one-way `@hive_state` projection
- V1 CLI JSON fields
- Apiary dual-written Inbox dispositions
- old reader feature flag

### Phase F: Mutation cutover

Make the daemon the sole command authority:

- CLI mutation uses RPC
- Apiary mutation uses the same RPC contract
- hooks and adapters remain spool-first
- direct session-file mutation is rejected by bridge-aware binaries
- compatibility projections remain enabled

### Phase G: End rollback window

After a successful backup-restore and rollback drill:

- stop Apiary Inbox dual writes
- stop translating V2 events back into legacy session state where no old
  consumer remains
- remove old-reader default, but keep an explicit diagnostic export
- retain the migration snapshot and legacy stores according to the approved
  retention policy

Removal of `@hive_state`, legacy JSON, or old Inbox files is a separate ADR and
explicit operation.

## 11. Parity gates

### 11.1 Data gates

All must pass:

- session-file count equals imported Bee count, excluding documented corrupt
  records that were quarantined rather than discarded
- identity and alias uniqueness checks pass
- every known non-state SessionRecord field round-trips
- seal file count, byte hash, Bee association, and task/attempt correlation
  match
- Buz message counts match per Bee, mailbox, and message id
- HSR meta/event/ring files remain present with unchanged hashes after import
- transcript ownership claims and paths are unchanged
- task, flight, flow, node, account, pool, frame, and colony stores are
  unchanged
- SQLite integrity and projection rebuild comparison pass
- origin-spool replay produces zero duplicate domain facts

### 11.2 Live-runtime gates

- live tmux session and pane ids match before and after snapshot import
- live HSR host pid and start identity match
- remote runner-host identity and version match
- no migration step sends input or control characters to a runtime
- no runtime generation changes solely because migration ran
- a daemon restart adopts every live runtime without duplicating Turns or
  requests

### 11.3 State gates

For every Bee, comparison records:

- V1 lifecycle and derived state
- V2 Bee lifecycle, RuntimeGeneration, current Turn, requests, and display
- evidence behind any intentional difference

There must be:

- zero `needs-reply` rows without an open question or permission request
- zero verified successes based only on observer evidence
- zero running Turns bound to exited generations
- zero open requests whose scope is closed
- zero stopped exits without stop intent
- zero duplicate request idempotency keys

### 11.4 Apiary UI gates

Automated model tests and a focused manual pass verify:

- Fleet and Inbox Bee counts
- active, ready, attention, crashed, unreachable, and retired grouping
- selected Bee identity and pane focus survive refresh
- titles, tags, lineage, account/model/reasoning, node, and substrate remain
  visible
- transcript and HSR Console history remain accessible
- structured questions retain every question, option description, ordering,
  and multi-select behavior
- completed results retain age and ordering
- snoozes remain snoozed and wake only for a new completion or urgent condition
- archive/retire followed by revive does not create a fake new completion
- an unprompted fork does not enter the Inbox
- optimistic spawns reconcile to the same Bee id
- composer remains enabled where appropriate and never gains a yellow
  needs-reply glow
- spawn, send, answer, steer, retire, revive, fork, handoff, and seal affordances
  remain available under the same conditions

Complex desktop interaction is tested manually; the migration should not add a
fragile end-to-end automation suite for pane focus or native window behavior.

## 12. Failure handling

### Corrupt legacy record

- Do not skip silently.
- Copy the raw file into the migration snapshot.
- Record a quarantine entry with parse error and path.
- Keep it visible through the V1 reader.
- Block cutover until explicitly resolved or accepted.

### Import interruption

- Leave V1 authoritative.
- Re-run using the same migration run id.
- Deterministic ids and unique constraints resume without duplicates.

### Daemon failure during shadow mode

- V1 remains authoritative.
- Emitters continue spooling.
- Restart daemon and resume ingestion from origin checkpoints.

### Projection mismatch

- Preserve event journal and both projection outputs.
- Stop promotion to the next phase.
- Produce a per-Bee explain trace showing source events and reducer decisions.

### Apiary mismatch

- Switch the workspace feature flag back to V1.
- Preserve V2 dispositions through dual write.
- Do not rewrite Apiary workspace layout or local state.

## 13. Rollback

Rollback is a normal supported path during Phases C through F.

Procedure:

1. Acquire the mutation gate.
2. Flush and checkpoint origin spools.
3. Snapshot SQLite, spool checkpoints, and parity reports.
4. Stop the V2 daemon.
5. Switch Apiary and CLI reads to the V1 compatibility projection.
6. Start the bridge-era daemon.
7. Verify live runtimes by identity without restarting them.
8. Release the mutation gate.

No legacy snapshot restore should be required because the V2 compatibility
projector and Apiary dual writes keep rollback stores current.

If a compatibility projection is not current, rollback is blocked until it is
replayed from the V2 journal. Restoring the pre-migration snapshot would discard
post-migration actions and is a last-resort forensic operation, not routine
rollback.

## 14. Required tooling

Proposed commands and diagnostics:

```text
hive state-v2 inventory --json
hive state-v2 snapshot --output <path>
hive state-v2 import --run <id>
hive state-v2 validate
hive state-v2 shadow start|status|stop
hive state-v2 parity [<bee>] --explain
hive state-v2 rebuild --verify
hive state-v2 rollback --dry-run
hive state-v2 rollback
hive state-v2 capabilities
```

Every mutating migration command supports `--dry-run` where meaningful and
prints exact source and destination roots.

`validate` includes:

- legacy JSON parsing
- identity and alias collision checks
- store manifest verification
- SQLite integrity
- projection rebuild equality
- request and Turn invariants
- active runtime reconciliation
- remote protocol/capability inventory
- Apiary Inbox matching summary

## 15. Test strategy

### Unit tests

- event validation and idempotency
- reducer transitions and forbidden transitions
- end-evidence compatibility and supersession
- scope-close consequence ids and replay
- legacy state mapping
- deterministic identity and Turn baselines
- Apiary status mapping
- Inbox disposition rebuild

### Fixture migration tests

Fixtures cover:

- never-prompted ready Bee
- active local tmux Turn
- observer-settled tmux Turn
- structured HSR Turn
- open structured question
- observer-grade permission prompt
- auth-expired generation
- stopped, crashed, and stop-failed generations
- sealed live Bee
- retired Bee
- unprompted fork
- archive/revive with held Inbox admission
- snoozed completion overtaken by a new Turn
- remote replay with duplicate origin events
- malformed session JSON and orphaned artifacts

For each fixture:

1. import twice
2. compare projections
3. rebuild from the journal
4. roll back to compatibility views
5. verify original files and hashes

### Integration tests

- daemon killed between event append and projection commit
- hook appends while daemon is down
- remote origin reconnect/replay
- CLI/daemon protocol mismatch
- bridge mutation gate with an old client
- Apiary V1/V2 dual-read and Inbox dual-write

### Manual verification

Use a disposable Hive home cloned from a real manifest and a separate Apiary
workspace. Verify the UI checklist in section 11.4 without activating or
modifying the operator's production sessions.

## 16. Cutover decision record

The person approving cutover records:

```text
migration run id
legacy manifest hash
SQLite schema version
Honeybee CLI/daemon version
remote runner-host versions
Apiary version
parity report hash
unresolved accepted differences
backup restore result
rollback drill result
approval timestamp
```

Cutover is prohibited while any data, runtime, state, or UI gate has an
unexplained failure.

## 17. Open questions

- Retention period for legacy stores, domain events, and raw generation spools
- Exact stable read transport used by Apiary
- Whether Inbox disposition is global per Hive home or workspace-specific
- How to represent a user intentionally dismissing one workspace's item while
  leaving it visible in another
- Whether historical flight attempts should be backfilled as Turns when
  task/attempt correlation is complete
- Authority-transfer protocol for adopting a Bee on another controlling node
