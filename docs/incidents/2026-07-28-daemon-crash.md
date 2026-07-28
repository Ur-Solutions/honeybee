# Hive daemon crash and buz delivery stall — 2026-07-28

## Summary

At 07:12:59Z the daemon abandoned a tick after its 120-second budget. The
tick never settled. Four later loop iterations correctly refused to overlap
that in-flight tick, and at 07:13:26Z the poisoned-runtime guard reached five
consecutive failures and deliberately sent the daemon `SIGKILL`.

The hard kill was the intended last-resort recovery action, but the installed
LaunchAgent used `KeepAlive.SuccessfulExit=false`. macOS launchd recorded this
self-sent `SIGKILL` as an internal exit code of zero. The conditional
`KeepAlive` therefore did not assert, launchd entered on-demand-only mode, and
the daemon stayed down until an operator started it at about 10:48Z. Buz sends
continued to write durable queue files, but daemon-mediated injection and
queue-to-inbox movement stopped during the outage.

The immediate terminating condition and failed respawn are known. The exact
operation inside the never-settling tick is unrecoverable from the pre-fix
logs: they record the last completed tick's stage timings, not the active
stage of an abandoned tick. Earlier completed ticks were slow in more than
one area, including pool sweeps, and separate chain-sync timeouts occurred;
none of that proves which operation hung at 07:10:59Z. This is an
observability gap, not evidence that account rotation or buz delivery caused
the hang.

## Evidence and timeline

- `07:12:59.698Z`: `tick timed out after 120000ms`.
- `07:13:05.269Z` through `07:13:26.248Z`: four skipped iterations reported
  that the previous tick was still running.
- `07:13:26.304Z`: `daemon.breach` reported
  `5 consecutive failed loop iterations (poisoned runtime)`, with
  `stalledMs=154685`.
- macOS unified launchd logs at local time `09:13:26.527` reported that the
  service exited due to `SIGKILL` sent by its own Node process, followed by
  `internal event: EXITED, code = 0` and
  `pending spawn, domain in on-demand-only mode`.
- The installed plist still contains
  `KeepAlive = { SuccessfulExit = false }`. Its launchd status retains
  `last terminating signal = Killed: 9`.
- The next daemon start appears around `10:48Z`; buz drain log entries resume
  on its first observations.

## Fix

### Respawn policy

Generated macOS plists now use unconditional `KeepAlive=true` with an
explicit 30-second `ThrottleInterval`. An unplanned watchdog, sentinel, or
process crash is therefore relaunched even when launchd normalizes the
signal death to exit code zero, while the throttle prevents a hot crash
loop.

A planned operator stop is now explicit service-manager intent:
`hive daemon stop` uses `launchctl bootout`. The plist remains on disk, and
`hive daemon start` bootstraps it again (falling back to `kickstart` for an
already loaded legacy service). This keeps planned stop separate from
process fate instead of overloading exit status.

The live LaunchAgent was deliberately not reinstalled or restarted during
this investigation. After this change is deployed, an operator must run
`hive daemon install --force` in a maintenance window for the new policy to
replace the currently loaded plist.

### Crash observability

Daemon state now carries an operator-only `activeTick` diagnostic with the
currently awaited stage and its start time. Supervisor breach,
uncaught-exception, and unhandled-rejection paths synchronously persist a
fatal diagnostic and append a `daemon.fatal` log entry with the stack,
unplanned exit intent, and active stage before termination. The hard-kill and
out-of-process sentinel logs also include exit intent and the best available
active-stage snapshot.

These fields are daemon diagnostics. They do not alter `BeeState`, process
fate, task result, turn state, or terminal-state classification.

### Delivery recovery and alarm

The existing delivery contract is retained: queue files are durable, and a
daemon tick drains an `idle_with_output` recipient even when there is no new
state transition. In particular, the daemon's first observation after a
restart drains already queued mail. Isolated test messages verified
queue-to-inbox movement and injection on that first observation; no live
session or production queue was mutated for testing.

Once per minute, the daemon now scans live recipients for queued mail at
least ten minutes old. Current warnings appear in daemon state/status and a
new or changed warning emits `buz.queue.stale`. The scan is best-effort and
isolated from normal delivery: a scan error emits
`buz.queue.scan.failed` without rejecting a successful drain.

`hive buz read --all --bee <ref>` provides a small recovery ergonomic by
bulk-consuming every inbox message into the read mailbox.

### Startup status

`hive daemon status` now consults launchd. When launchd has a running child
but that child has not acquired the Honeybee lock yet, status reports
`starting` and the launchd PID rather than the misleading `down` result.

## State-model coordination

The direction was sent to state-model owner `CL.df15` before state-semantic
implementation began. The design follows ADR 001's split:

- daemon process fate and diagnostics do not become task results;
- fatal exits are explicitly marked unplanned;
- planned stop intent is represented by unloading the launchd service; and
- buz staleness is an operator diagnostic, not a bee lifecycle state.

No response had arrived from `CL.df15` when this report was written.

## Validation

- `node --import tsx --test tests/daemon-watchdog.test.ts`
- `node --import tsx --test tests/daemon-buz-dispatch.test.ts tests/daemon-tick.test.ts`
- `node --import tsx --test tests/daemon-plist.test.ts tests/daemon-install.test.ts tests/daemon-status.test.ts`
- `node --import tsx --test --test-name-pattern='starts, writes state.json' tests/daemon-status.test.ts`
- `node --import tsx --test --test-name-pattern='bulk-consumes' tests/buz-cli.test.ts`
- generated candidate plist piped through `plutil -lint -`
- `npm run check`
- `npm run build`

One timing-sensitive child-process startup assertion missed its eight-second
poll window when run in the larger status bundle; it passed in isolation.
All newly added behavior tests passed.

## Follow-ups

1. Deploy the generated plist with `hive daemon install --force`; the
   currently loaded LaunchAgent still has the old conditional policy.
2. If another tick stops settling, use `activeTick` and `daemon.fatal` to
   identify the exact stage, then isolate or make that operation cancellable
   rather than guessing from the previous completed tick.
3. Monitor `buz.queue.stale` and crash-loop frequency after deployment. If a
   recipient remains live but undrainable, add alert routing on top of the
   now-machine-readable status field.
