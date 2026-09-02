# agy program review, HB1 and HB2

Adversarial review by the program root. Plan at `docs/AGY_HARNESS_PLAN.md`. Implementation by two gpt-5.6-sol xhigh codex bees in isolated cells. Review method: full diff read, independent gate re-runs, and live lanes on scratch daemons built from the PR heads plus a merged integration branch.

## HB1, agy HSR adapter (feat/agy-adapter, head 95aef748)

Eight commits, 17 files, about 650 net lines with tests.

### Verified live, scratch daemons at the PR head and the HB1+HB2 integration merge

- Smoke `npm run v2:smoke -- agy`: 11/11 checks pass with a real agy 1.1.24 process.
- Lane 1 spawn to idle, `hive last` renders the reply after the renderer fix. Pass.
- Lane 2 three FIFO mailbox turns in one generation. Pass.
- Lane 3 stop, revive on message, `--conversation` resume recalled turn-1 content in generation 2. Pass.
- Lane 4 harness args after bare `--` reach the child argv after the separator fix. Pass at the head CLI.
- Lane 5 `--arg` form model and effort in child argv. Pass.
- Lane 6 unauthenticated home lands `auth_needed`, no silent hang. Pass.
- Lane 7 SIGKILL mid-turn records `stopped(crashed)`, revive boots generation 2 cleanly. Pass.
- Lane 8 interrupt reports unsupported, no SIGINT fallback. Pass.
- Lane 10 two concurrent agy bees, distinct conversations, no cross-bleed. Pass.
- Lane 9 cell substrate: see the pending block at the end.

### Findings

1. Renderer mis-scope, found by lane 1, fixed in the v2 seal. The transcript renderer registry was planned into HB3 but serves every substrate. The owner added the renderer, an explicit projector case, and 332 lines of projection tests. Resolved.
2. Pre-existing trunk bug, found by lane 4: `cmdSpawn` silently dropped harness args after bare `--`, same silent-drop class as the 2026-08-19 incident documented in the same function. Fixed in HB1 as its own commit with a CLI test. Resolved.
3. Minor, open: the agy text renderer emits assistant text for both the streamed `text_delta` and the final `result.response`, which shows as a stray indented blank continuation line after each assistant turn in `hive transcript`. The projector already de-duplicates via `sawAssistantText`; the stateless renderer cannot. Claude's renderer skips result rows for exactly this reason per the comment at `transcripts.ts:314`. Proposed fix for the owner: skip result-row text in the renderer, accepting the theoretical loss of a no-delta turn's text, matching the claude convention.
4. Not a finding, checked and cleared: repeated `turn_started` per `agent_response` step update is the same phase-deduplicated idiom claude uses and is required for self-woken turns. CANCELED results map to a turn edge without contrary flag clears, honest per the captured cancellation semantics.

### Gate verification, independent re-runs

- Pristine origin/main (66fe2410) fails `v2:check` at `v2/core/tests/accounts.test.ts:458` TS2353. The claimed pre-existing failure is real. HB2 repaired it.
- `v2:driver` and `v2:test` re-run by the root in the cell: green.
- Three `v2:daemon` failures reproduce as claimed: one broken committed fixture on trunk, two environment-inheritance effects of running inside a codex cell bee. None touch the HB1 diff.

## HB2, agy account recipe (feat/agy-accounts, head 746f80e1)

Three commits, 5 files, about 216 net lines with tests.

### Verified live

- `hive account add agy lane` creates the account with `auth_needed`, `creds=absent`. Pass.
- Token file landing flips the probe to `creds=unverified`, deliberate present-but-unproven semantics. Pass.
- `hive account limits` and `hive usage` render the accepted unsupported-limits state without breaking other rows. Pass.
- `account.add` on a pre-populated home refuses with the `importExisting` guidance and the refresh-token rotation warning. That warning proved literally true in this session: copied agy tokens die when the source lineage refreshes. Pass, and validated.
- With HB1 merged, an uncredentialed agy account makes accountless `spawn --agent agy` refuse with clear guidance, consistent with other harnesses' account selection; `--account none` bypasses. Pass.

### Findings

1. Open question sent to the owner: after an imported token lands, the account status column stayed `auth_needed` while `creds` showed `unverified`, including after a limits refresh. Either the refresh path was not triggered by this sequence, or status is stale. Owner to prove convergence with a test or fix it.
2. Good judgment, recorded: `RESUME_CAPABLE_HARNESSES` deliberately untouched because it governs frozen old-world imports and no legacy agy lane exists. The trunk test repair was kept as its own commit and fixed the cause (store clock injection) rather than suppressing the type error.
3. The recipe encodes the two probed constraints faithfully: PTY-only login (pipe stdin makes agy refuse headless login) and the `BROWSER=true` no-op browser trick for headless URL capture.

## Cross-cutting

- Both PR heads merge cleanly, disjoint files except the trunk test repair.
- Fixture provenance is honest: all agy fixtures derive from real captured 1.1.24 sessions, sanitized, with shapes preserved.
- Auth lineage lesson for operators, to fold into HB2 docs or SMOKE.md: agy OAuth tokens rotate on use; copying a token file between homes works at most once and dies when the source refreshes. Per-account logins are the only durable path.

## Closures

- Lane 9 cell substrate: pass. An agy cell bee committed `lane9.txt` in its provisioned checkout; `cell capture --onto lane9-landed` landed the commit with correct content, and the checked-out-branch capture guard refused `main` correctly first.
- Integration branch (HB1+HB2 merged): `v2:check` clean across all eight projects (HB2's trunk repair), `v2:test` 150/150.
- Perf: `v2:driver` median 31.0s at head vs 88.3s at trunk baseline. Rule is head within +20 percent; pass. Absolute spread is machine-load noise from live lanes during trunk runs; no regression signal.
- HB1 finding 3 closed by seal "HB1 ready v3" (head f350b6d7): renderer treats result rows as noise, regression test added test-first, driver2 and typecheck green.
- New fact from lane 4's transcript, probed and confirmed: agy rejects a suffixed model id combined with a conflicting `--effort` (`gemini-3.6-flash-low` + `--effort medium` errors; base id + `--effort` works; matching suffix works). Honeybee passes argv through and renders the error faithfully; no honeybee change. The rule binds AP1: the apiary model catalog must list BASE gemini ids with effort as the reasoning control and never emit suffixed ids alongside `--effort`.

## Pending before merge verdicts

- HB2 finding 1: owner tracing the imported-token status refresh transition; reseal expected.
- Operator-side: a real login for the `agy-lane` account, then the account-bound spawn lane re-run.
- Final verdict swarm audit lane at the exact merge-ready heads after HB2 reseals.

## Bot-review triage round (PRs #5 and #6)

Nine automated inline comments, all triaged: seven real, fixed and verified; one real but its suggested fix was falsified live; zero rebutted without evidence.

- Fixed and verified on HB1: follow-mode projector state loss (also repaired pre-existing codex/grok cross-line state loss), repeatable `--add-dir` composition, per-step assistant fragment folding, tool-error output fallback, per-turn duration deltas from cumulative `duration_seconds`.
- Fixed and verified on HB2: explicit `account.verify` now persists `auth_needed` on missing credentials; probe kinds are truthful (`credential_file` vs `limits` vs `none`); and the keyring finding resolved empirically. agy prefers the OS keychain, and the recipe now sets `SSH_CONNECTION` so agy selects its documented file-storage fallback ("SSH session detected") in every managed home. Verified live end to end.
- Falsified: the P1 suggestion to emit boot evidence on pre-init auth errors. Implemented, then disproven on a live integration build: an unauthenticated bee reached generation 11 in 75 seconds because synthetic boot evidence reset the spawn-failure budget each cycle, disabling the contract's churn suppressor. Reverted in full; a deterministic regression now pins the three-generation budget settle (`auth_needed` + `spawn_failed`, mail-driven starts suppressed, fresh budget after login + revive). The revert was proven by replaying the reverted hunk against the new test. Final live lane confirms settle at bootFailures=2-3 with no runaway.

## Final verdict

HB1 merge-ready at 6c4d04a3 (PR #5, 17 commits). HB2 merge-ready at 42f449ff (PR #6, 8 commits). One named dropout stands: the real-OAuth login-flow live lane awaits an operator login (test evidence covers it; `SSH_CONNECTION` file-storage landing is probed but not yet proven against Google's real flow).
