# Swap-revived idle bees stuck "working" — incident record

Date: 2026-09-02  
Affected: `CL.60c9` (gen 10), `CL.e72f` (gen 2); same path taken by `CL.8c1f`, `CL.aaef` (recovered because mail arrived later)  
Trigger: the 04:56Z operator herd swap off `claude-tormod-thto.no` (11 swaps; 3 were `stop_then_revive`)

## What the operator saw

Apiary showed the bees as running/working for over 80 minutes with no output.
`hive ls` agreed (`running  working`). The claude processes were alive, idle at
their stream-json prompt, at ~0% CPU. `lastOutputAt` predated the generation's
`startedAt`.

## Root cause

`bee.swapAccount` on a live bee is `stop` → `revive after_stop` with
`--resume <seed> --fork-session`. The bees were idle with an empty mailbox, so
nothing was injected after the revive. claude stream-json emits no line until
its first stdin message.

The HSR driver's readyAtSpawn path set its own phase to `idle` (accept point
open) but pushed only a synthetic `booted` observation. The daemon folds
`booted` as `running`. Nothing ever closed that turn:

- the driver drops the late `init`/`result` edges while its phase is idle
  (correct: they must not close a real in-flight turn), so the self-woken
  zero-turn `result` CL.60c9 did emit at 04:57:20Z was ignored;
- the daemon restart at 05:26Z adopted both runtimes with
  `lastKnownState = running` (rows-are-truth), carrying the stale phase forward;
- elapsed time never changes phase, by design.

Two state models disagreed about the same process: driver `idle`, store
`running`. Every surface downstream (`view.working`, Apiary) faithfully showed
the store.

## Why the recent robustness work did not catch it

- `66fe2410` (transcript carry) made cross-account swaps *succeed*. Before it,
  every swapped claude died on turn one (`No conversation found`), which was
  visible as a crash. The stall is the shape that success uncovered: a revive
  whose runtime lives silently.
- The 2026-08-19 rule (`urgency.d6`) already treats synthetic-boot `running`
  as provisional — but only for delivery eligibility and the I1 clock. The
  read model still answered `working: true`.
- The 2026-08-21 adoption rule fixed the mirror-image case (known-idle bees
  adopted as running) but keeps `running` as the conservative claim, so a
  restart cannot repair this.
- Every other revive path carries mail (`send_wake`) or dies; only
  `thenRevive` (swap) and a bare `hive revive` produce a revive with nothing
  to inject, so no test exercised the silent-idle revive.

## Fix

- `v2/driver-hsr/src/driver.ts`: when the runner-host status confirms the
  agent pid and the driver's phase is still `idle` (nothing injected yet),
  the synthetic `booted` is paired with a synthetic `turn_ended` — the
  "boots straight to ready" edge the claude adapter would have parsed. A
  delivery that already opened the turn suppresses it; the real `result`
  closes that turn.
- `v2/daemon/src/loops.ts`: a synthetic `turn_ended` moves `running → idle`
  without `recordOutput` (no output fact behind it) and logs as
  `obs.turn_ended … synthetic`. Boot evidence stays `synthetic`, so the
  spawn-failure budget is unchanged.
- Contract docs on `DriverObservation.turn_ended` and `readyAtSpawn` updated.

Tests: two new HSR driver tests (silent revive → idle; delivery-before-status
race → no synthetic edge), the self-woken test now counts real edges only, and
a daemon loops test for the synthetic fold (idle, no output fact, evidence
synthetic, `view.working === false`, later real turn still records output).

## Recovery of the stuck generations

The fix applies to new generations. The two stuck generations were
`hive stop`ped (what the 60-minute idle window would have done had the state
been honest); both now show stopped / waiting-for-you and any send revives
them. Sending mail would also have worked: delivery there is allowed because
synthetic-boot `running` is provisional.

Verification note: the in-process daemon tests and the deterministic
poll-edge driver test pass. The real-process driver tests (`v2:driver`) and
`budget.11` could not be verified on the 2026-09-02 machine: the 1-minute
load average sat at 45–66 (bare `node -e 0` took 7 s) and the identical tests
fail on a clean checkout of the parent commit. Rerun `npm run v2:driver` and
`npm run v2:daemon` on a quiet machine before `hive deploy`.

## Follow-up worth considering

A swap of an idle bee could `rebind_only` and stop instead of `stop_then_revive`;
send already revives stopped bees transparently. That would avoid holding a
warm claude process per swapped idle bee. Not changed here.
