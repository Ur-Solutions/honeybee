# WP3 manual smoke — real harnesses (run before WP4 lands)

CI proves the driver against the stub agent only. This checklist verifies the real
adapters against live harness streams once, manually. Budget: one short turn each.

Setup: none — the runner is checked in. From the repo root:

```
npm run v2:smoke -- stub     # wiring proof, no tokens (run first)
npm run v2:smoke -- claude   # real claude from PATH   [--model <m>]
npm run v2:smoke -- codex    # real codex from PATH    [--model <m>]
npm run v2:smoke -- grok     # real grok agent stdio   [--model <m>]
npm run v2:smoke -- agy      # real agy print mode     [--model <m>]
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

## Per harness (claude, then codex, then grok, then agy)

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

## agy print-mode checks

agy 1.1.24 emits an `init` line before accepting input, so delivery during
boot must return `not_ready`; it is not a synthetic-ready harness. Confirm
that each `agent_response` step opens a turn and every terminal `result`,
including `CANCELED`, closes it. Run the authenticated check with
`--dangerously-skip-permissions` so tool requests do not wait for approval.

For the auth check, use a fresh HOME and inspect both streams. agy prints the
"Authentication required" stanza on stderr, emits an `ERROR` result containing
"authentication failed or timed out" on stdout, and may exit 0. The result
event, not the exit code, must set `auth_needed`.

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
| 2026-08-20 | grok | trmd | ALL 11 PASS | grok 1.0.5 ACP stdio; grok-4.6; 82 log lines; authMethods cached_token+grok.com; loadSession=true; step 6 still manual |
| | agy | | | pending live smoke after deployment; fixture protocol captured from agy 1.1.24 on 2026-09-02 |

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
| 2026-08-17 | codex (tmux) | trmd | ALL 18 PASS | echo-verified delivery; transcript+notify phases 12-13s |
| 2026-08-17 | grok (tmux) | trmd | ALL 9 PASS | FIRST LIVE VALIDATION of the fixture-derived parser; typed delivery |
| 2026-08-17 | claude (tmux) | trmd | ALL 18 PASS | trust-dialog fix verified; transcript 14.7s, hooks 11.0s; events contract 2/2 |

---

# WP5 manual smoke — cell driver (a real agent inside real confinement)

CI proves the cell driver's pieces (provisioning matrix, capture, sandbox
profile, delete guards) in isolation against the stub. This runner
(`v2/driver-cell/smoke.ts`) walks the whole lifecycle in one piece — the one
thing CI cannot: a real agent doing real work INSIDE the real sandbox, then its
work landing through the native exit path.

```
npm run v2:smoke:cell -- stub                 # wiring proof, no tokens (run first)
npm run v2:smoke:cell -- claude [--model m]   # real claude from PATH (HSR mode)
```

## What one run covers

Everything happens against a THROWAWAY origin the runner builds in a fresh OS
temp dir (a tiny node project, a few commits) — never `~/.hive`, never a user
repository. ONE bee, ONE cell, sandbox ON by explicit per-cell override
(Seatbelt on darwin; A4's workstation default stays OFF):

1. **Provision** — via the real `CellDriver.ensureCell`: `copy_mode` printed
   honestly (CoW expected on APFS), `cell.json` ledger valid, layout shape
   `-space-` + `box/`, checkout byte-clean at the pinned sha.
2. **Spawn** — inner HSR driver, pid + exact start-time identity, `lsof`-verified
   cwd = the space, Seatbelt profile materialized in `box/`.
3. **Agent writes** — prompt: create `SMOKE_CELL.txt` containing `CELL_OK`,
   reply DONE. The file must exist in the space (cwd + write access proven from
   inside confinement). The stub variant runs the same write through `/bin/sh`
   inside the sandboxed child (`@sh` directive of
   `v2/driver-cell/test-agent/agent.mjs`) — same cwd, same confinement.
4. **Confinement probe** — smoke-side, not the agent: the SAME wrapped command
   (the driver-generated profile) must allow a write inside the cell and DENY
   one outside it. The outside target lives in `$HOME` (user-writable without
   the sandbox, not on any allow-list) because tmp is scratch-allowed by design
   and would lie.
5. **Agent commits** — `git add -A && git commit -m smoke`; cell HEAD advances,
   worktree clean.
6. **Capture** — `driver.capture()` onto NEW branch `smoke/landed` (merge mode):
   landed sha on the branch, transient ref gone, origin otherwise bit-identical
   (fingerprint: ref set + HEAD + porcelain status + current branch; exactly one
   new ref), fsck clean — the A1 zero-artifact guarantee, live.
7. **Delete guards + stop** — live runtime blocks `removeCell`; stop clean
   (exited with stopped cause); dirty delete refused without force (A2); forced
   removal deletes the wrapper. Session log is verbatim native jsonl.

Fails fast (a dead prerequisite skips its dependents), prints per-section wall
time, keeps run-dir artifacts (origin, logs, a copy of `cell.json`), exit code
is the verdict.

## claude-mode notes

- claude runs in HSR mode (`-p --input-format stream-json --output-format
  stream-json --verbose`) from PATH with its REAL home — auth just works (the
  WP3 readyAtSpawn path); no tmux, no isolated home.
- The sandbox profile keeps `~/.claude`, `~/.claude.json`, caches and OS scratch
  writable (`defaultWritablePaths`), so the real agent runs confined without
  losing its own state dirs. Every other write outside the cell is denied.
- The throwaway origin sets a local git identity, and a CoW-provisioned cell
  inherits it — the in-cell commit works even without a global gitconfig.

Result log (cell smokes):

| date | harness | operator | result | notes |
|---|---|---|---|---|
| 2026-08-17 | stub | (runner proof) | ALL 24 PASS | copy_mode=cow on APFS; sandboxed stub wrote + committed in-cell; outside write denied; total 0.9s |
| | claude | | | (operator runs `npm run v2:smoke:cell -- claude`) |
| 2026-08-17 | claude (cell) | trmd/CL.7920 | ALL 24 PASS | 10.4s; real claude wrote+committed inside Seatbelt, capture landed, origin bit-identical; fixed late-init phantom turn_ended + added -p permission bypass |
