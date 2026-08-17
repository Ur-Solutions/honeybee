# WP3 manual smoke — real harnesses (run before WP4 lands)

CI proves the driver against the stub agent only. This checklist verifies the two real
adapters against live claude/codex streams once, manually. Budget: one short turn each.

Setup: a scratch script that wires `HsrDriver` + the claude/codex adapter + a temp
`CoreStore`, mirroring `tests/harness/real.test.ts`'s wiring minus faults.

## Per harness (claude, then codex)

1. **Spawn** — `start()` a bee running the real CLI with a trivial prompt.
   - [ ] `booted` observation arrives; pid + start-time recorded at spawn
   - [ ] session log contains the verbatim native jsonl (no rewriting)
2. **Turn** — the prompt runs.
   - [ ] `turn_started` then `turn_ended` observations, in order, exactly once each
3. **Deliver** — send a follow-up message mid-idle.
   - [ ] accepted; a second turn runs; response reflects the message
4. **Deliver while booting** — restart with a slow model; deliver during boot.
   - [ ] refused `not_ready` (daemon-retry contract), accepted after boot
5. **Stop** — `stop()` the idle runtime.
   - [ ] TERM suffices (no KILL escalation); `exited` observation with stopped cause;
         process gone; `hadProcess: true`
6. **Flag evidence** — run once with credentials removed/invalid.
   - [ ] adapter emits `auth_needed` evidence; restoring credentials + successful turn
         emits the contrary-evidence clear

## Format-confidence items (from adapter implementation)

Anything the old `src/hsr/adapters/` left ambiguous is listed in the adapter source as
`// SMOKE:` comments — grep them before running and confirm each against the live
stream. Record surprises here, fix the adapter fixtures to match reality, and re-run
`npm run v2:driver`.

Result log:

| date | harness | operator | result | notes |
|---|---|---|---|---|
