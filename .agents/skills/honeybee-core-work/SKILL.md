---
name: honeybee-core-work
description: Apply the mandatory Honeybee v2 core architecture contract. Use for every task in the Honeybee repository, especially work involving the store, daemon, RPC/CLI, mailbox, urgency, commands, runtime drivers, harness adapters, lifecycle, generations, recovery, Cells, tmux, accounts, deployment, or Apiary integration.
---

# Honeybee Core Work

Read this before planning or editing. Preserve these boundaries unless the operator makes
a new architecture decision and the governing spec/tests change with the code.

## Authority and storage

- Use one SQLite authority and serialized daemon/core writer per node.
- Route mutations through versioned daemon RPC; keep the CLI thin.
- Permit read-only fallback only without the daemon and label it stale.
- Keep session logs as append-only harness evidence, not lifecycle truth.
- Publish snapshots plus seq-numbered deltas; require a snapshot after any gap.
- Keep audit rows append-only and semantic no-ops quiet/idempotent.
- Keep closed vocabularies closed; an unmatched condition is a software bug.

## Durable state model

Lifecycle is `active <-> archived -> deleted`.

- `stop` ends a runtime and preserves the active bee.
- `archive` files the bee; sending auto-unarchives it.
- `delete` immediately removes the bee and owned durable data.
- A message is accepted whenever lifecycle is not `deleted`.

Runtime is `booting -> running <-> idle -> stopped`, with `booting -> stopped` legal.

- Nothing leaves `stopped`; revive creates generation N+1.
- Exit causes: `clean`, `crashed`, `stopped_by_user`, `stopped_by_system`,
  `machine_restart`.
- A restart may reconcile runtimes to `stopped(machine_restart)` but creates no failure.
- Fence runtime commands by generation; stale intent audits and settles as a no-op.

Condition flags are only `auth_needed`, `resource_blocked`, `spawn_failed`, and
`node_unreachable`.

Flags describe explicit boundaries, never substitute for runtime state.

## BeeView contract

Derive, never persist as competing truth:

- `reachable`: lifecycle is not deleted; `working`: runtime is booting/running.
- `waitingForYou`/`blocked`: current explicit turn, output, request, or flag facts.
- `lastOutputAt`: raw evidence for consumer read cursors.

A stopped bee remains reachable. Never require “revive” or expose `crashed` as user state.
Silence and time passage never prove idle, completion, crash, or unreachability.

## Mailbox and delivery

- Make `send` a transactional mailbox insert, independent of process health.
- Enqueue wake intent in the same transaction when no usable runtime exists.
- Keep per-bee FIFO among eligible messages.
- Preserve undelivered mail across runtime/daemon crashes.
- Record the consuming generation and never silently lose or logically double-deliver mail.

- `now`: interrupt, then deliver; `next`: next accept point/default; `idle`: runtime idle.

Urgency controls eligibility, never FIFO order or whether a stopped bee wakes. Map buz
compatibility onto this mailbox. Allow `mail.cancel`/`mail.expedite` only before delivery.
Measure every accepted message with invariant-1 telemetry: deliver within the policy bound
or record a durable structured violation.

## Commands and recovery

- Use `queued -> running -> done | failed`; replay interrupted commands as `queued` on boot.
- Claim/settle idempotently with finite backoff and typed failures.
- Preserve caller idempotency keys; duplicates return the original effect.
- Count pre-real-boot exits against one per-bee budget; synthetic readiness is not proof.
- Reset only on real output/operator revive; exhaust to `spawn_failed` and suppress churn.

## Daemon, adapters, and drivers

- Boot: replay store, snapshot exact live identities, reconcile/reap, sweep mail, resume loops.
- Adapters parse harness events; drivers own substrate/process effects; the daemon validates
  transitions and policy; the core persists and derives views.
- Treat assistant output on an idle self-woken runtime as a turn edge; deduplicate it.
- Never derive canonical state from tmux glyphs, pane silence, or transcript text.
- Keep Cell provisioning/maintenance/sampling off the RPC accept hot path.
- Signal only exact PID/PGID plus birth identity; bound/single-flight maintenance.

The daemon currently owns HSR child stdio, so daemon restart stops those runtimes. Reconcile
them and rely on revive-on-message; do not fabricate liveness or add another state store.

## Deployment and compatibility

- Change the live runtime only with `hive deploy` and its versioned atomic `runtime/current`.
- Keep `hive deploy --rollback`; never deploy from or symlink to a mutable working tree.
- Keep removed internals removed: no swarms, colonies, old buz store, `kill`, `retire`,
  state-file authority, or multi-path daemon control.
- Keep compatibility aliases only at documented CLI edges mapping to v2 primitives.

## Working rules

1. Inspect `git status`; preserve concurrent work.
2. Update schema, types, mirror, RPC, CLI, migrations, and tests coherently.
3. Test crashes, restarts, fencing, replay, urgency, duplicate keys, and budgets.
4. Use deterministic clocks and assert bounded outcomes, not one race ordering.
5. Run targeted/applicable gates and real smokes; deploy only when honestly green.

For architecture changes, consult the Apiary reset specs and current v2 source.
