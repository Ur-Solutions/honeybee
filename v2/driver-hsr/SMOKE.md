# WP3 manual smoke — real harnesses (run before WP4 lands)

CI proves the driver against the stub agent only. This checklist verifies the two real
adapters against live claude/codex streams once, manually. Budget: one short turn each.

Setup: none — the runner is checked in. From the repo root:

```
npm run v2:smoke -- stub     # wiring proof, no tokens (run first)
npm run v2:smoke -- claude   # real claude from PATH   [--model <m>]
npm run v2:smoke -- codex    # real codex from PATH    [--model <m>]
```

The runner automates steps 1–5 below and prints a ✓/✗ checklist plus the session-log
path; step 6 (auth-failure evidence) remains manual.

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
| 2026-08-17 | claude | trmd | ALL 11 PASS | after readyAtSpawn fix (4a8c6c42); 6 log lines |
| 2026-08-17 | codex | trmd | ALL 11 PASS | codex-cli app-server; 53 log lines |
