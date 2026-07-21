# CL.701 implementation — four-agent review panel (2026-07-21)

Review of the uncommitted CL.701 reliability implementation (flights,
completion contracts, events surface, daemon hardening — see
`docs/FLIGHTS_AND_CONTRACTS.md`). Panel: **codex** (`CO.8d237`, conf 0.88),
**claude fable** (`CL.ce7`, conf 0.85), **kimi** (`KI.f48`, conf 0.80),
**grok** (`GR.7fa`, conf 0.86), colony `cl701-review`, each sealed
`taskId=cl701-review`. All ran `npm run check` (clean) and the new test
suites (green).

**Panel verdict (unanimous):** the single-controller core is sound — the
headline invariants (no `done` without current-attempt evidence, stale seals
scoped out, idle-never-done, clock-hold on `node_unreachable`, backpressure,
crash-adoption) survived adversarial probing. The defects cluster at the
**seams**: cross-process concurrency, contract enforcement leniency, and
delivery/lifecycle edges.

## Consensus findings (multiple reviewers, ranked)

### CR-1. Concurrent sweepers break the no-double-spawn invariant — Critical (all 4)
No cross-process lock on slot files (`withFileLock` exists but the flight
store never uses it); `hive flight sweep` racing the daemon's `sweepFlights`
(a pairing the `flight start` output itself suggests) both prepare and spawn
the same slot. Compounding it:
- `planSlot` treats a missing session record as **death** even for
  `provisioning`/`booting` slots (`machine.ts` beeDead check runs before the
  readiness branch), so a sweeper that runs mid-spawn insta-vacates a live
  claim, burns the attempt, and respawns.
- A `sweepFlights` that blows its 60 s `dispatchMs` budget is abandoned but
  keeps running; the next tick starts a second sweep over the same slots
  (`withTimeout` never cancels). One slot fill can legitimately take >90 s
  (HSR host boot + brief delivery retry window).
- The HSR branch of `spawnBee` has **no name-exists guard** (tmux has one),
  so the duplicate deterministic name silently overwrites the session record
  and orphans a live runner host.
**Fix:** per-flight `withFileLock` around `sweepOneFlight`; single-flight
mutex in the daemon stage (skip if previous sweep still running); grace
window for claimed-but-recordless slots until `readinessDeadlineMs`;
name-exists refusal + adopt in HSR `spawnBee`.

### CR-2. Keyless seals satisfy the contract; sealType never enforced — Critical (all 4)
`judgeSeal`/`judgeActivationEvidence` only mismatch on keys the seal
*carries*: a bare `{status:"done"}` seal recorded after `attemptStartedAt`
completes the slot, contradicting the postscript's "a seal without them does
not count". `SlotSealObservation` also drops the seal's `type`, so
`--seal-type implementation` is satisfied by any seal.
**Fix:** flights demand strict matching — carried-and-equal `taskId` and
`attempt` required (missing ⇒ `none`, or escalate), and check the demanded
sealType; add keyless-seal cases to the machine and property tests.

### CR-3. Contract postscript heredoc is broken shell — Major (fable, verified by execution)
`contract.ts` indents every snippet line **including the `SEAL` terminator**;
bash requires the delimiter at column 0, so the heredoc never terminates and
the `hive seal` command is swallowed into the artifact file. A bee following
the deterministic instructions verbatim can never seal → every slot degrades
stall → nudge → escalated. **Fix:** emit the snippet unindented; add a test
that actually executes the postscript in a shell.

### CR-4. `slotBeeName` keyed on non-unique flight *name* — Major (codex, fable)
Two flights named the same (or a restart under the same name) produce
byte-identical bee names → record overwrite (via CR-1's missing guard) and
cross-flight mis-adoption. **Fix:** key on `flight.id`.

### CR-5. Nudge delivery is unreliable but still escalates — Major (codex, fable)
`nudgedAt` is persisted before the send; a failed/downgraded nudge
(bee-origin `interrupt` without transport downgrades to queue) is never
retried, and a stall budget later the slot escalates as "nudge-unanswered"
for a nudge that never arrived. **Fix:** authorized sender/transport, mark
`nudgedAt` on confirmed delivery, retry state otherwise.

### CR-6. Missing/corrupt slot files silently shrink the flight — Major (all 4)
Corrupt slot files are skipped and never re-created (the store comment claims
otherwise); completion checks `every(terminal)` over *existing* files, so a
4-slot flight with one lost file can close as `flight.complete 3/3`.
**Fix:** reconcile `target.slots` each sweep — re-create missing slots as
vacant; report totals from `target.slots`.

### CR-7. Escalated/blocked lifecycle gaps — Major (fable, grok, kimi)
(a) The blocked branch lacks the escalated guard `stall()` has: a
still-blocked bee flaps blocked↔escalated every `stallMs`, spamming ledger
events (verified live). (b) `escalated` is non-terminal with no resolution
CLI (`resolve|retry|abandon-slot`), so any escalated slot blocks
`flight.complete` forever. (c) A draining flight with a vacated slot can
never complete (vacant isn't terminal, draining never spawns).
**Fix:** early-return for already-escalated in the blocked branch; add slot
resolution subcommands; treat `vacant` as terminal under `draining`.

### CR-8. CLI `flight sweep` acts on stale `lastObservedState` — Major (codex, grok)
With the daemon down (the very scenario inline sweep exists for), stored
states lag reality: false stalls, missed deaths, and `lastActivityAt`
refreshed off a stale `active`. **Fix:** run a live observation pass for the
flight's bees in the CLI sweep (the isolated observer makes this cheap), or
refuse when the daemon is healthy.

### CR-9. `--contract` postscript not delivered on the argv-prompt path — Major (codex, fable)
`hive spawn codex --contract … "do task"` delivers only the argv prompt;
the postscript lives only in `record.brief`. The bee is never told to seal.
**Fix:** append the postscript to the first delivered prompt when a seal
contract is present.

### CR-10. Exit-contract semantics wrong in both directions — Major (fable, kimi-adjacent)
`crashed`/`error`/`kill_failed` after first evidence count as `done`; a fast
clean exit between sweeps (no observed `active` tick) counts as `crashed` and
burns attempts until abandonment. **Fix:** exclude crash-flavored states from
exit-completion; use the HSR exit disposition rather than sweep-sampled
activity.

### CR-11. Events surface edges — Minor→Major (codex, fable, grok)
(a) The documented `--session <bee>` filter never matches `flight.slot.*`
events (they carry `bee`/`flight`, not `session`). (b) Backlog→follow gap in
`hive events -f`: lines appended between collect and the follow's initial
`stat` are lost. (c) Rotation detection is size-only — a fast-growing fresh
file can be read from mid-file, and tail-of-old-file lines are lost.
**Fix:** match `bee`/`flight` keys (or emit `session`); carry the collect
offset into follow; add inode/generation check.

### CR-12. Observer child robustness — Major (fable) / Minor (codex)
No `'error'` listener on the ChildProcess or its stdin: async spawn failure
(EMFILE/ENOENT) or EPIPE is an **unhandled 'error' event that can crash the
daemon** the isolation was built to protect; the sync-throw fallback never
engages. Also drops `process.execArgv` (tsx dev runs). **Fix:** error
handlers routing into teardown + in-process fallback; preserve loader args.

## Notable single-reviewer findings

- **kimi:** spawn-succeeds-but-brief-delivery-fails orphans a live bee
  forever (attempt burned, adoption only checks `provisioning`); stale
  `lastActivityAt` can silently un-escalate a mismatch-escalated slot.
- **grok:** replacement never kills/retires the vacated bee — process/token
  leak per replacement; suggested `hive flight` slot-resolution CLI.
- **codex:** `hive events -f` startup gap; generic seal example includes
  making missing-key tests explicit.

## What the panel could NOT break (explicitly probed)

Stale-seal scoping; carried-key mismatch → escalate; idle-without-seal never
`done` (property test + independent walks); `node_unreachable` clock hold;
single-process prepare→execute→confirm idempotency incl. crash adoption;
`maxConcurrentBoots` accounting incl. refund on spawn failure; chain-sync
loop shutdown; ledger rotation reach-back math; stage timing under timeouts;
hsrUnavailable hold semantics.

## Suggested fix order

1. CR-3 (one-line, breaks every contract bee today) and CR-2 (strict seal
   matching + sealType).
2. CR-1 (per-flight lock + provisioning grace + HSR name guard + sweep
   mutex) — the whole multi-controller story.
3. CR-4, CR-6, CR-7 (identity, capacity reconciliation, lifecycle).
4. CR-5, CR-8, CR-9, CR-10, CR-11, CR-12.

Test gaps to close alongside: concurrent-sweeper interleavings, shell-executed
postscript, keyless/typed seal matching, flight-name collision, missing-slot
recovery, draining completion, observer async-error path.

---

## Fix outcomes (2026-07-21, applied after the panel)

All consensus findings and the notable single-reviewer finds are fixed;
`npm run check` clean, all flight/contract/events/observer/daemon suites green
(150+ tests including the new regressions).

- **CR-1 fixed.** Per-flight file lock around every sweep (daemon + CLI share
  it, `flights/<id>/.sweep.lock`, staleMs 10 m); in-process single-flight
  guard in the daemon sweeper (a budget-abandoned sweep blocks the next tick's
  entry); a claimed slot with no session record is HELD until the readiness
  deadline instead of read as death; HSR/remote-HSR `spawnBee` refuses to
  overwrite a running record.
- **CR-2 fixed.** `judgeActivationEvidence` gained `requireKeys` (flights set
  it): keyless seals are "none", never completion. `SlotSealObservation` now
  carries the seal `type`; a matching seal of the wrong demanded sealType
  escalates (`seal-type-mismatch`).
- **CR-3 fixed.** Postscript snippet emitted unindented; a test executes it
  in bash against a fake `hive` and asserts the seal call + artifact keys.
- **CR-4 fixed.** `slotBeeName` keyed on `flight.id`.
- **CR-5 fixed.** The machine only *requests* the nudge; the controller
  stamps `nudgedAt` after the send succeeds. Failed nudges retry every sweep
  and can never escalate as "unanswered".
- **CR-6 fixed.** Sweeps re-create missing slot files as vacant (ledgered
  `flight.vacancy reason=slot-file-missing`); completion requires
  `target.slots` files all terminal.
- **CR-7 fixed.** Blocked branch early-returns for escalated slots (no flap);
  `hive flight resolve <flight> <slot> --retry|--abandon|--accept` added
  (retire of the written-off bee on retry/abandon); draining flights treat
  `vacant` as terminal and can complete.
- **CR-8 fixed.** `hive flight sweep` overlays a live `hsrObservations` pass
  over persisted `lastObservedState` for all slot bees.
- **CR-9 fixed.** The argv-prompt HSR delivery path appends the contract
  postscript.
- **CR-10 fixed.** Exit contracts: crash-flavored evidence
  (crashed/error/kill_failed) is never completion; a clean `dead` record
  completes even without a sweep-observed active tick (fast workers).
- **CR-11 fixed.** `--session` matches `bee`/`flight` keys; `hive events -f`
  hands the backlog read's byte offset to the follower (no gap, no dupes);
  rotation detection also checks the inode.
- **CR-12 fixed.** Observer child + stdio have `error` handlers routing into
  teardown (no more unhandled 'error' crash path); stdin writes guarded;
  `process.execArgv` preserved for tsx/dev daemons.
- **kimi find fixed.** Brief-delivery failure after a successful spawn no
  longer burns the attempt/orphans the bee — the slot keeps its bee and the
  stall path surfaces it (`flight.slot.brief_failed` ledgered).
- **grok M2 fixed.** Wedged replacements best-effort `transactionalRetire`
  the written-off bee.

Not addressed (accepted for now): fable m10 (0-values fall back to defaults —
no way to express "pause spawning" via maxConcurrentBoots=0), kimi's note
that cross-process concurrency is covered by in-process fakes rather than a
true two-process chaos test, and `close --purge` remains unimplemented
(mentioned only in a store comment).
