# Flights, completion contracts, and the event surface

Implementation of the CL.701 reliability research (Honeybee-side fixes for the
"miscounted idle_with_output as productive" incident class). Staged per that
report: phase 0 hardened the daemon, phase 1 made completion a contract and the
ledger an event surface, phase 2 added the deterministic Flight Controller.

## Phase 0 — daemon reliability

- **Per-stage tick timing.** Every tick stage (listSessions, probeNodes,
  capturePanes, hsrObservations, the per-record loop, each dispatcher) is
  timed; the last completed tick's `stageMs` map is persisted in
  `state.json` as `lastTickStageMs` and shown by `hive daemon status`
  (`--json` for the full map). A slow or timing-out stage is diagnosable from
  status output alone.
- **Chain sync off the tick path.** `syncChains` (keychain + multi-home
  credential sweeps) now runs on its own interval inside `runDaemon`
  (`HIVE_DAEMON_CHAIN_SYNC_INTERVAL_MS`, default 5m), never inside the tick's
  sequential budget.
- **Isolated observation I/O.** The HSR run-dir sweep runs in a disposable
  child process (`hive daemon hsr-observe-worker`, managed by
  `src/daemon/observerProcess.ts`). A request that blows its deadline gets the
  child SIGKILLed — orphaned wedged fs calls die with it instead of poisoning
  the daemon's libuv threadpool (the root of the listSessions-timeout breach
  cycle). Opt out with `HIVE_DAEMON_ISOLATED_OBSERVER=0`.
- **UV_THREADPOOL_SIZE=16** burned into the LaunchAgent plist (interim
  mitigation; reinstall with `hive daemon install --force` to pick it up).

## Phase 1 — completion contract + events

- **Seal v2** (additive): `taskId` (correlation key), `attempt` (lease
  attempt), `evidence { filesChanged, testsRun, artifacts[{kind: branch|diff|
  url|fixture, ref}] }`. `hive seal --help` documents the full contract.
- **Full transition ledgering.** The daemon ledgers `state.transition` for
  EVERY transition (previously only into `idle_with_output`), so
  wedged/crashed/blocked/sealed edges are observable events.
- **`hive events`** — a file-backed tail over the ledger:
  `hive events -f --type 'flight.*' --session CL.9fe --since 15m --json`.
  Works with the daemon down; rotation-safe; `--since` reaches into rotated
  ledger files. This is the substrate for Pollinate scouts and Flightboard.
- **`hive spawn --contract`** —
  `--contract completion=seal[,sealType=<t>][,taskId=<id>][,attempt=<n>]`
  persists a completion contract on the SessionRecord and appends a
  deterministic (templated, never LLM-generated) postscript to the brief:
  "your final message is not your deliverable; seal with these keys".
  `completion=exit` is the weaker contract for harnesses that cannot seal.

## Phase 2 — Flight Controller

A **flight** is a maintained capacity invariant: N slots, a declared model
mix, a completion contract with deadlines, and evidence-driven replacement.
LLMs are out of the liveness loop entirely: the controller escalates
exceptions; it never judges.

```
hive flight start --name parity-07 --cwd ~/repo \
  --mix "fable=claude/claude-fable-5@auto:5" --mix "codex=codex@auto:5" \
  --seal-type implementation
hive flight enqueue parity-07 --task-id shard-01 --brief-file packets/shard-01.md --cwd ~/wt/shard-01
hive flight enqueue parity-07 --from-dir ./packets     # bulk: one packet per file
hive flight queue parity-07         # pending/leased/done/failed buckets
hive flight status parity-07        # disk-derived; works with the daemon down
hive flight sweep parity-07         # one inline reconcile pass (live-observed, lock-safe vs the daemon)
hive flight resolve parity-07 s3 --retry|--abandon|--accept   # operator verdict on an escalated slot/task
hive events -f --type 'flight.*'    # the live feed
hive flight drain|close parity-07
```

### v1.1 — the lane-keeper (durable task queue + slot generations)

A flight with queue work is a **lane-keeper**, not a fixed batch: it keeps N
lanes productive over the queue until `pending/` is empty — the chronic-
underpopulation goal from the original parity incident. Mechanics:

- Packets live in `flights/<id>/queue/{pending,leased,done,failed}/`, one
  JSON file each (`taskId`, `brief`, optional per-task `cwd` for its
  worktree). Content is project-authored; enqueue is the manager API.
- A lane claims the oldest pending packet DURABLY (under the flight lock,
  before the slot prepare) — lease identity is (slotId, generation, attempt),
  so evidence and idempotency never bleed across tasks. The packet's taskId
  becomes the lane's completion-contract key.
- On a contract-matching done seal the packet is filed to `done/` (with the
  seal ref), the lane bumps its generation, and the spawn phase claims the
  next packet — replace-before-collect: the finished bee stays alive for the
  manager to collect and retire at leisure.
- Attempt exhaustion fails the TASK (`failed/`), never the lane: one poisoned
  packet cannot kill lane capacity. `resolve --accept|--abandon` files the
  current packet and recycles the lane; `--retry` re-runs the same packet.
- Queue empty → lanes park as `drained`; enqueueing new work revives them on
  the next sweep. The flight completes (and closes) only when pending and
  leased are both empty and every lane is drained/done/abandoned.
- Flights never enqueued behave exactly as v1 fixed batches.
- Events: `flight.task.{enqueued,claimed,done,failed}`, `flight.slot.drained`,
  plus the v1 vocabulary; `flight.complete` reports task totals.

- The activation rule (durable attempt claims, evidence scoped to
  `attemptStartedAt`, stale = none / key-mismatch = escalate) lives in the
  claimant-generic `src/activation.ts` — adopted verbatim by the upcoming
  comb-run engine (apiary orchestration-graphs concept §6.1); flight code
  delegates to it.
- Store: `<storeRoot>/flights/<FL.id>/flight.json` + `slots/<sN>.json`
  (atomic writes; everything derivable from disk + session records + seals).
- Slot states: `vacant → provisioning → booting → working → done`, with
  `stalled` (violation, never completion), `blocked`, `escalated`,
  `abandoned`. **Productive = working with first evidence** — never derived
  from `idle_with_output`.
- Completion: a seal CARRYING the slot's `taskId` (`FL.x/sN`) and current
  `attempt`, recorded at/after the attempt started, of the demanded sealType.
  Stale or keyless seals never count; mismatched keys or type escalate.
  Contract postscripts are injected into every slot bee's brief automatically
  (and onto the argv-prompt delivery path).
- Replacement: prepare (durably claim `attempt+1` + idempotency key
  `FL.x:sN:a`) → execute (spawn, HSR substrate, deterministic bee name
  `<flightId>-<slot>-a<attempt>`) → confirm. A controller crash
  mid-replacement is recovered by ADOPTING the deterministically-named
  orphan, never double-spawning; a claimed slot with no session record yet is
  held (not written off) until the readiness deadline. Sweeps take a
  per-flight file lock, the daemon skips a tick's sweep while the previous
  one still runs, and HSR spawns refuse to overwrite a running record — so
  the invariant holds across processes, not just within one.
  `maxConcurrentBoots` (default 3) is the backpressure valve; a wedged
  replacement best-effort retires the written-off bee.
- Stalls: deadline → `flight.slot.stalled` event + the deterministic
  interrupt-tier buz nudge (retried until delivered; `nudgedAt` is stamped
  only on successful delivery, so an undelivered nudge never escalates as
  "unanswered"). Attempt exhaustion → `abandoned` + `flight.mix.violation`
  (never silent substitution). Escalated slots are resolved by the operator
  via `hive flight resolve` — the controller never judges.
- Capacity reconciliation: missing/corrupt slot files are re-created as
  vacant each sweep; completion requires the FULL declared slot set
  (`target.slots`) terminal. Under `draining`, vacancies count as terminal so
  a drained flight can complete.
- `node_unreachable` holds every clock (mirror staleness must not fire stall
  deadlines).
- Daemon: the reconciler runs as a tick dispatcher stage (`sweepFlights`),
  consuming the tick's already-derived records/states.

## Event vocabulary

`flight.created`, `flight.draining`, `flight.closed`, `flight.complete`,
`flight.vacancy`, `flight.mix.violation`, `flight.slot.{provisioning,booting,
working,stalled,blocked,done,escalated,abandoned,crashed,wedged,
spawn_failed}`, plus `state.transition` (all edges) and `seal` (now with
taskId/attempt).

## Not yet implemented (follow-ups from CL.701)

- Hot spares (pre-booted, un-briefed bees per mixKey).
- Brief gate (project-supplied route-packet validator command).
- Manager-bee watching (manager down → `flight.manager.down` + packet).
- Collection validation of `evidence.artifacts` before `collected`.
- Flightboard TUI / Apiary pane; session-store index; Comb convergence
  (phase 3).
