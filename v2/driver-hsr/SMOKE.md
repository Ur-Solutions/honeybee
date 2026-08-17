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

## Echo-verified delivery (2026-08-17 hardening)

The tmux driver now PROVES injected text is visible in the input line before it
presses Enter (paste or typed), retypes once on mismatch, and otherwise surfaces an
immediate `echo_mismatch` unconfirmed note instead of submitting blind. Live evidence
that forced this: grok ignores the tmux paste buffer entirely (now `deliveryMode:
"type"`), grok eats the first keystrokes of an unpaced burst, and codex swallows a
paste during its post-turn redraw. Claude's transcript locator now realpaths the cwd
(`/var` → `/private/var`), matching where claude actually writes.

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

---

# WP5 manual smoke — tmux driver against real TUIs

CI proves the tmux driver against the pane stub only. This runner
(`v2/driver-tmux/smoke.ts`) verifies the two surfaces that need a live harness:
the per-harness **transcript formats** (the whole point for grok, whose parser is
fixture-derived) and the **events-file hook/notify contract** against real hook
invocations. One command per harness; each spawns real TUIs via the real
`TmuxDriver` on a private per-run socket — the ambient tmux server and `~/.hive`
are never touched.

```
npm run v2:smoke:tmux -- stub               # wiring proof, no tokens (run first)
npm run v2:smoke:tmux -- claude [--model m] # transcript phase + hooks phase
npm run v2:smoke:tmux -- codex  [--model m] # transcript phase + notify phase
npm run v2:smoke:tmux -- grok               # transcript phase only
```

## Phases and checklist

Every phase spawns ONE bee and walks: spawn + exact pid identity → booted →
TUI ready in pane → first delivered prompt produces `turn_started`/`turn_ended`
→ follow-up turn → delivery confirmed (no unconfirmed note) → stop clean. The
runner fails fast (a dead prerequisite skips its dependents) and prints the
transcript/events paths plus a `tmux -S <socket> attach` command for watching
the live TUI.

- **transcript phase** — observation source 2, the mandatory A3 baseline. The
  turn boundary must come from the harness's transcript file; the bound path is
  printed and checked.
- **hooks phase (claude)** — the runner prepares an ISOLATED temp
  `CLAUDE_CONFIG_DIR` whose `settings.json` wires `UserPromptSubmit`/`Stop`/
  `Notification` hooks to append their stdin payload to the driver's events
  file (the `events-file.ts` contract, verbatim). The driver runs with NO
  transcript source, so the boundary pair can only come from real hook
  invocations; the raw events file is additionally re-parsed and checked.
- **notify phase (codex)** — same idea with an ISOLATED temp `CODEX_HOME` whose
  `config.toml` points `notify` at a helper that appends codex's
  `agent-turn-complete` payload to the events file. Only end-of-turn evidence
  exists, so the driver's pending-confirm synthesis supplies `turn_started`.
- The contrary-evidence flag-clear path is NOT covered here: the tmux driver
  has no evidence channel (flags are an adapter-stream concern, HSR smoke
  step 6) — nothing to test on this surface.

## Auth + home isolation caveats

- The runner **never modifies the real `~/.claude` / `~/.codex`** — it only
  copies credential files INTO the isolated homes (claude
  `.credentials.json` when present; codex `auth.json`) and shreds the copies at
  teardown. On macOS claude authenticates via the shared Keychain, so the
  isolated home usually works as-is (approve the Keychain prompt if one
  appears).
- If a harness cannot run unauthenticated from the temp home, the runner prints
  exact copy-in instructions instead of silently failing.
- grok has no home-relocation env var: it runs against the real `~/.grok`, and
  the runner only TAILS the transcript grok itself writes there (read-only; no
  grok config touched).
- Run-dir artifacts (transcripts, events files, isolated homes minus the
  credential copies) are kept under the printed temp dir for inspection.

Result log (tmux smokes):

| date | harness | operator | result | notes |
|---|---|---|---|---|
| 2026-08-17 | stub | (runner proof) | ALL 27 PASS | 3 phases: transcript (grok fmt) + hooks (claude shape) + notify (codex shape) |
