# macOS filesystem/process storm — deployment record

Date: 2026-08-16  
Deployed Honeybee runtime source: `09c10e8ee0a9ed598d5c601e1eb3eef62b2a898c`  
Installed runner artifact: `f33e5a6916387d3a3f23066d103e37a203c76b8fef13b3ba187068d3af70752f` (1,614,397 bytes)  
Final daemon PID: `73606`

## Root causes

1. A pre-deployment `hive bees --json` process was actually the persistent TUI. PID `71004` refreshed the full catalog about every three seconds for more than 20 minutes, retained about 735 MB RSS, and kept old event-integrity code loaded. Exact termination of that PID stopped the continuing fenced-row writer.
2. Repeated HSR integrity confirmation rewrote an unchanged receipt and canonical `kill_failed` row. That invalidated the active index and amplified one observation into hundreds of atomic file and ledger writes per minute.
3. Explicit kill/retire uncertainty had no durable action token. A `kill_failed` record could not safely distinguish retry-to-purge from retry-to-archive, so automatic teardown recovery had to remain disabled.
4. Pool discovery, terminal reprobe, and usage sampling ran O(N) work in the daemon tick. One measured tick reached 69.524 seconds: pool sweep 30.596 seconds and usage sampling 20.014 seconds.
5. Earlier integration fixtures could fail their unconfirmed non-TTY kill and remove recovery metadata while detached HSR process groups survived. Exact birth/PGID finalizers now cover those fixtures.
6. The separately fixed Raycast Hem menu command was another five-minute full-ledger producer. It is removed from its manifest and no Hem health process remains.

## Effective fixes

- `378e6e1e` preserves integrity fence timestamps on semantic no-ops.
- `13652764` makes repeated exact stop confirmation idempotent.
- `e4f0dccb` detaches and single-flights heavy maintenance; pool and terminal passes default to five minutes, terminal and usage passes are round-robin bounded to 25 records, and shutdown joins tracked lanes.
- `612a71dd`, `77cdff14`, and `852b248e` add versioned kill/retire stop intent, bounded exact recovery, shutdown joining, action/generation/attempt fencing through dispatch, settlement-vs-live classification, and archived-row refusal.
- `09c10e8e` makes `hive bees --json` authoritative, noninteractive, and one-shot by delegating to the established full list projection before any TUI/raw-mode setup.
- `7539f0af` guarantees exact test-runner cleanup; `378b819d` bounds prior fleet-maintenance scans.

An attempted hot cached display projection (`693408d2`, `b0795eea`) was rejected during deployment review because it could fabricate liveness, mislabel remote substrates, leak sealed rows, and erase Pro metadata. It was fully reverted by `011835f0` and `1badea68` before the final install. Interactive list/TUI semantics are unchanged.

## Verification

- `npm run check`: passed.
- 185 focused daemon, HSR lifecycle, maintenance, list, and TUI tests: passed.
- Corrective authoritative-list suite: 32/32 passed.
- `npm run build`: passed; local and installed runner hashes both equal `f33e5a…`.
- Final `hive bees --json`: 120 authoritative rows, 75,030 bytes, 1.34 seconds, then no matching process.
- Final `account:auto` Apiary launch: run `run-0e72732117f8e44e7a79238d36bc1c15`, session `xr-fef39ebe1e33`, response exactly `HIVE_FINAL_SMOKE_OK`; exact retirement archived it and left no host PID.
- Final daemon advanced from tick 1 through tick 16 with no recent errors. Latest tick: 847 ms total, 52 ms records, 1 ms usage launcher, 0 ms pool/terminal/stop-recovery launchers.
- Since the final restart baseline: 187 ledger rows, seven legitimate smoke lifecycle saves, zero `session.save` rows for fenced session `xr-f3d91184a54b`, and zero new integrity rows. Its canonical `updatedAt` remains `2026-08-16T06:16:49.551Z`.
- Load fell from a peak of 53 to 9.89/11.59/16.49 before the final smoke (13.11/12.15/16.36 immediately after it).
- `fseventsd` fell from 136% in the post-stop sample to about 97–103%, but remains near one core with about 5.1 GB RSS and is still draining historical backlog.

## Remaining process debt

One post-settle census found 1,672 total processes, 709 Node processes, 227 HSR runner roots, 225 adopted by launchd, and 156 roots older than three days. The same-process-group subset alone retained 228 processes and roughly 9.85 GB summed RSS. This retained forest was not bulk-killed because canonical live/ready work must be preserved.

Legacy `kill_failed` records without a versioned `stopIntent` remain manual-only. Their original kill-versus-retire intent is unknowable, so the daemon deliberately will not purge or archive them automatically.

## Safe one-time cleanup

1. Seal active work and snapshot the exact canonical session records.
2. Exclude every live/ready/working/needs-you session and every process whose PID, PGID, birth fingerprint, generation, or control socket does not exactly match its record.
3. Let the daemon converge only new versioned stop intents. Review legacy `kill_failed` rows individually and choose exact `hive retire <bee> --yes` or exact kill only after the intended terminal action is known.
4. For confirmed stale test generations, terminate only the recorded exact process group after birth validation; attempt every captured group, escalate TERM to KILL only for the same identity, and verify absence. Never use `pkill node` or a name-wide signal.
5. Retire selected stale records only after a dry run and preserve their seals/transcripts. Shut down unused simulators separately.
6. Restart macOS orderly after producer cleanup to release compressed memory and let `fseventsd` reset. Consider an FSEvents journal reset only if it still consumes a core after exact producer cleanup and reboot.

## Follow-up

- Replace the still-authoritative TUI full refresh loop with a daemon-published, truth-preserving snapshot that carries freshness, node/substrate authority, sealed visibility, and Pro metadata; never infer liveness from active-index membership.
- Add diagnostics for maintenance lane counts/durations, logical store writes, stop-recovery circuits, and runner-root age so a recurrence is visible before system services saturate.
- Continue Apiary workspace-switch work separately; renderer lifecycle changes require generation-scoped workspace leases and must not be mixed into this storm deployment.
