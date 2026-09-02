# agy harness program plan

Honeybee gains `agy` (the Antigravity CLI, Gemini models) as a first-class harness beside claude, codex, and grok. Apiary then surfaces it in compose, onboarding, doctor, and transcripts. The rule the program enforces is the v2 contract. Adapters parse harness events, drivers own substrate effects, the daemon validates transitions, closed vocabularies stay closed, and no canonical state ever derives from silence or glyphs. PR order is HB1, HB2, HB3 in the honeybee repo, then AP1, AP2 in the apiary repo.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a transcript, a test run, or a SHA. The body is a how-to. The appendices explain and record.

Each PR owner runs `skills/astack-mode/playbooks/feature.md` for its PR and `skills/astack-mode/playbooks/landing.md` at its end. The autopilot execution playbooks are absent from this installation, so the root coordinates PR sequencing by hand against this checklist. Every PR stops at merge-ready. The operator merges.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] On the operator's go, write the program objective into the standing orders and the todo list with this exact text. "Plan docs/AGY_HARNESS_PLAN.md. PRs HB1, HB2, HB3, then AP1, AP2. Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. The operator merges. Done when all five PRs are merged and `hive spawn agy` plus an agy transcript pane in Apiary both work on a deployed node."
- [ ] Read these from the installed plugin at program start. Re-read them at every tick.
  - [ ] `skills/astack-mode/playbooks/feature.md`
  - [ ] `skills/swarm/SKILL.md`
  - [ ] `skills/hive-usage/SKILL.md`
  - [ ] `skills/astack-mode/playbooks/landing.md`
  - [ ] `.agents/skills/honeybee-core-work/SKILL.md` in the honeybee repo, and `.agents/skills/apiary-core-work/SKILL.md` in the apiary repo for AP PRs.
- [ ] Arm the 30-minute audit tick as a real cadence. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from the installed plugin and the standing orders. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a lane only on affirmative failure evidence, and dispatch its replacement in the same tick. Then send the operator a status message, whether or not anything changed, with the queue table of PR, owner, state, and head SHA, the verdicts since the last tick, what merged, open operator gates, and blockers."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR as a hive bee in an isolated Cell with the full lifecycle the execution playbook names. `hive spawn <name> --substrate cell --origin <repo>` per the dispatch reference.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges.
  - [ ] HB1 and HB2 are independent and first. Both branch from honeybee `main`.
  - [ ] HB3 after HB1.
  - [ ] AP1 after HB1 and HB2 are merged and deployed to the local node with `hive deploy`.
  - [ ] AP2 after AP1.
- [ ] Hold the file boundaries. HB1 touches only `v2/adapters/**`, `v2/daemon/src/{config,daemon}.ts`, `v2/driver-cell/src/sandbox.ts`, `v2/cli/**`, `src/completion/tables.ts`, `v2/driver-hsr/SMOKE.md`, and test files. HB2 touches only `v2/core/src/{accountRecipes,import-frozen}.ts`, `v2/daemon/src/{accountsService,providerLimits,loginFlows,activation}.ts`, and test files. HB3 touches only `v2/daemon/src/tmuxHarness.ts`, `v2/driver-tmux/**`, and test files. AP1 touches only `packages/core/src/{modelCatalog,hive}.ts`, `apps/desktop/src/shared/{onboarding,capabilityDoctor}.ts`, `apps/desktop/src/main/{capabilityDoctor.ts,gateway/tools/agentTools.ts}`, `packages/adapters/src/{composerCapabilities,identityEnv}.ts`, and test files. AP2 touches only `packages/core/src/transcript.ts`, `packages/adapters/src/transcripts/**`, `packages/adapters/src/capture/resolve.ts`, `packages/adapters/fixtures/transcripts/agy/**`, `apps/desktop/src/main/hiveMirrorTranscriptResolver.ts`, `apps/desktop/src/renderer/src/{modelMark.tsx,icons.tsx}`, `docs/transcripts.md`, and test files.
- [ ] Hold the review gate. AP1 and AP2 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge. HB1, HB2, and HB3 are CLI and daemon changes with no interaction change.

### PR mechanics, for every PR

- [ ] Open the PR ready, never draft, with `gh pr create` and `draft: false`.
- [ ] Run the repo's typecheck and tests once before the PR-facing push. Honeybee PRs run `npm run v2:check` and the tiered suites named in their verify boxes. Apiary PRs run `pnpm typecheck`, `pnpm lint`, and the targeted `vitest` runs named in their verify boxes. Push with hooks on.
- [ ] Run an unslop and no-stray-comments pass over the diff before review.
- [ ] Triage every automated reviewer comment. Fix real findings, answer false ones on the PR.
- [ ] Rebase onto current trunk before the verdict swarm and again before the merge-ready report.

### Verdict and merge, for every PR

- [ ] At the merge-ready head SHA, run the swarm per `skills/swarm/SKILL.md`. One gates lane running the PR's named test commands. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. One audit lane that reads the diff and the receipts and distrusts the PR body.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner. A new head gets a fresh swarm and a fresh verdict.
- [ ] The owner reports merge-ready with the verdict receipts. The operator merges. Honeybee changes reach the live node only through `hive deploy` after merge.

### Boot recipe, for every live lane

Each live lane is one worker lane at the PR head, resolved through provider dispatch, in its own worktree or output directory, with its own receipt. Drive honeybee only through the `hive` CLI per `skills/hive-usage/SKILL.md`. Drive apiary through its dev app.

- [ ] `git fetch origin <head-branch> && git worktree add <lane-dir> <head SHA>` in the PR's repo.
- [ ] Honeybee lanes build with `npm run build` in the lane worktree and run the daemon against a scratch data dir, `HIVE_V2_DATA_DIR=<lane-dir>/.hive-v2` or the harness rig the tests provide. Never point a lane at the live `~/.hive/v2`. Apiary lanes run the dev app from the lane worktree.
- [ ] Deliver input only through `hive` commands or the app surface. Read state only through `hive status`, `hive tail`, `hive transcript`, `hive last`, and the app.
- [ ] Save every artifact to `/tmp/agy-swarm/<pr-id>/worker-<n>/<slug>.txt` for CLI evidence or `<slug>.png` for app screenshots, and return the paths with the receipt path.

## Build the agy HSR adapter and registry entry (HB1)

**Depends on.** None.

**Files.**

- [ ] Create `v2/adapters/src/agy.ts`.
- [ ] Create `v2/adapters/tests/agy.test.ts`.
- [ ] Edit `v2/adapters/src/args.ts`.
- [ ] Edit `v2/adapters/src/index.ts`.
- [ ] Edit `v2/adapters/tests/args.test.ts`.
- [ ] Edit `v2/daemon/src/config.ts`.
- [ ] Edit `v2/daemon/src/daemon.ts`.
- [ ] Edit `v2/driver-cell/src/sandbox.ts`.
- [ ] Edit `v2/cli/src/main.ts`.
- [ ] Edit `v2/cli/src/help.ts`.
- [ ] Edit `src/completion/tables.ts`.
- [ ] Edit `v2/daemon/tests/config.test.ts`, `v2/daemon/tests/bee-args.test.ts`, `v2/daemon/tests/node-harnesses.test.ts`.
- [ ] Edit `v2/driver-hsr/SMOKE.md`.

**Build.**

- [ ] Add `agyAdapter` in `v2/adapters/src/agy.ts` implementing `HarnessAdapter` from `types.ts`. Set `harness: "agy"`, `readyAtSpawn: false`, `acceptsMidTurn: false`, `confirmsDelivery: false`. `parseLine` maps the `init` event to `booted` and records `conversation_id` as the provider session id, maps the first `agent_response` step_update of a turn to `turn_started`, maps the `result` event to `turn_ended` with ok on `SUCCESS` and error text on `ERROR`. Route result error text through `isAuthNeededMessage` and `isResourceBlockedMessage`, extending those classifiers in `types.ts` with the agy cue "Authentication required" if they do not already match it. Do not trust the exit code. Appendix A shows agy exits 0 on auth failure.
- [ ] `encodeMessage` emits one NDJSON line, event `user`, message content list with one text block, per the probed shape in Appendix A. Omit `encodeInterrupt` so interrupt reports unsupported. Omit `forkArgs`. `resumeArgs(sessionId)` returns `["--conversation", sessionId]`.
- [ ] Add `agyArgGrammar` in `v2/adapters/src/args.ts` declaring the value-taking flags `--model`, `--effort`, `--conversation`, `--print-timeout`, `--agent`, `--project`, `--log-file`, `--add-dir`, `--mode`, and export both from `index.ts`. No spawn plan. agy honors argv flags in print mode, Appendix A.
- [ ] Add `BUILTIN_AGENTS.agy` in `v2/daemon/src/config.ts` with command `agy`, adapter `agy`, and args `--print=`, `--input-format stream-json`, `--output-format stream-json`, `--dangerously-skip-permissions`, `--print-timeout 12h`, and `AGY_CLI_DISABLE_AUTO_UPDATE=1` in `env`. Update the adapter list comment at `config.ts:25`.
- [ ] Register `"agy"` in `ADAPTER_NAMES` at `v2/daemon/src/daemon.ts:193`, add a case to `adapterFor` and to `grammarFor`.
- [ ] Add `.gemini` to the harness home path list in `v2/driver-cell/src/sandbox.ts:54`.
- [ ] Extend `templateHarnessArgs` at `v2/cli/src/main.ts:2061` so yolo on agy maps to `--dangerously-skip-permissions`, and extend `grammarForAgent` at `main.ts:2979` with the agy grammar. Effort already maps to `--effort` for non-codex harnesses. Add agy to the harness line in `v2/cli/src/help.ts:142` and the legacy completion list in `src/completion/tables.ts:67`.
- [ ] Add an agy section to `v2/driver-hsr/SMOKE.md` and an agy row to its result log.
- [ ] Capture real agy stream-json output as fixtures for `v2/adapters/tests/agy.test.ts`, covering boot init, a two-turn exchange, an auth failure, and a mid-stream `step_update` with `text_delta`, following the claude and grok fixture test style.

**You see.**

- [ ] `hive spawn agy-smoke --agent agy` on a scratch daemon reaches idle, `hive send` runs a turn, and `hive status` shows the turn end with no flags. `hive tail` shows the verbatim agy NDJSON in the session log.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `v2/adapters/tests/agy.test.ts` covers every `parseLine` mapping and both classifiers. Run `npm run v2:check && npm run v2:driver && npm run v2:daemon && npm run v2:test`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured swarm worker role at the PR head, per the boot recipe.

- [ ] Lane 1. Spawn an agy bee, send one prompt, wait for idle. Save `spawn-idle.txt`. Pass when the bee reaches idle and `hive last` holds the reply.
- [ ] Lane 2. Send three sequential messages through the mailbox. Save `multi-turn.txt`. Pass when three turns complete in order in one runtime generation.
- [ ] Lane 3. Stop the bee, revive it, ask what the first message was. Save `revive-resume.txt`. Pass when the revived bee answers with the first message's content, proving `--conversation` resume.
- [ ] Lane 4. Spawn with `--model gemini-3.8-flash-low` via template args. Save `model-flag.txt`. Pass when the turn completes and the spawn argv in `hive show` carries the flag.
- [ ] Lane 5. Spawn with effort set through a template. Save `effort-flag.txt`. Pass when argv carries `--effort` and the turn completes.
- [ ] Lane 6. Spawn an agy bee in a home with no agy credentials. Save `auth-needed.txt`. Pass when the bee lands the `auth_needed` flag, not a silent hang and not a clean idle.
- [ ] Lane 7. Kill the agy child process mid-turn. Save `crash-exit.txt`. Pass when the daemon records a crashed runtime with a real exit cause and the bee revives cleanly.
- [ ] Lane 8. Send `hive interrupt` to a running agy turn. Save `interrupt-unsupported.txt`. Pass when the command reports unsupported and the turn is left to finish.
- [ ] Lane 9. Spawn an agy bee on the cell substrate, run a file-writing task, capture the cell. Save `cell-capture.txt`. Pass when the capture lands the diff onto the target branch.
- [ ] Lane 10. Run two agy bees concurrently in one daemon. Save `concurrent.txt`. Pass when both reach idle with distinct conversation ids and neither's transcript bleeds into the other.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Stub bee spawn-to-idle latency under `v2:harness:real`, and `npm run v2:driver` wall time.
- [ ] Probe. Run both at trunk and at the head, interleaved, three times each.
- [ ] Baseline. Record the trunk medians first.
- [ ] Rule. Head median more than 20 percent above trunk median fails.

**Review gate.** None. HB1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Automated reviewer triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator merges. Deploy with `hive deploy` afterward and run `npm run v2:smoke -- agy`, signing the SMOKE.md log row.

## Add the agy account recipe and probes (HB2)

**Depends on.** None.

**Files.**

- [ ] Edit `v2/core/src/accountRecipes.ts`.
- [ ] Edit `v2/core/src/import-frozen.ts`.
- [ ] Edit `v2/daemon/src/accountsService.ts`.
- [ ] Edit `v2/core/tests/accounts.test.ts`, `v2/daemon/tests/accounts-service.test.ts`, `v2/daemon/tests/login-flows.test.ts`.

**Build.**

- [ ] Add `ACCOUNT_RECIPES.agy` per the extension-point note at `accountRecipes.ts:81`. Credential files put `.gemini/antigravity-cli/antigravity-oauth-token` first, config files carry `.gemini/antigravity/antigravity_state.pbtxt`, vendor home is `.gemini`. agy has no home env var, Appendix A, so home selection rides the account home itself like the vault spec's default. Write the conformance fixture the file demands.
- [ ] Add the login flow with one `cli` method that runs `agy` under the PTY worker, cueing on the probed stanza "Authentication required. Please visit the URL to log in" and on the pasted-code prompt, landing when the token file appears.
- [ ] Add `agy` to `PROBE_CAPABLE_HARNESSES` at `accountsService.ts:178` with a credential probe on the token file. Leave `providerLimits` untouched so `hive usage` reports the accepted `unsupported` state for agy. A quota fetcher is Appendix A unproven and lands later if a source exists.
- [ ] Leave `RESUME_CAPABLE_HARNESSES` in `import-frozen.ts` unchanged unless HB1's resume lane proves import-time resume matters for agy. Record the decision in the PR body either way.

**You see.**

- [ ] `hive account add agy personal` then `hive account login` completes the OAuth flow, and `hive usage` lists the agy account with credentialed state and unsupported limits.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Recipe conformance fixture plus probe and login-flow cases. Run `npm run v2:check && npm run v2:test && npm run v2:daemon`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured swarm worker role at the PR head, per the boot recipe.

- [ ] Lane 1. Add an agy account on a scratch daemon. Save `account-add.txt`. Pass when the account lists with the agy harness.
- [ ] Lane 2. Run the login flow with real OAuth in a fresh home. Save `login-flow.txt`. Pass when the token file exists and the probe reports credentialed.
- [ ] Lane 3. Run the login flow and abandon it before the browser step. Save `login-abandon.txt`. Pass when the flow times out with a clean error and no partial credential state.
- [ ] Lane 4. Spawn an agy bee bound to the new account. Save `account-spawn.txt`. Pass when the turn completes under that home.
- [ ] Lane 5. Spawn with `agy-auto` selection. Save `auto-pick.txt`. Pass when selection picks the credentialed account and the spawn succeeds.
- [ ] Lane 6. Spawn with `agy-rr` round-robin with one account. Save `round-robin.txt`. Pass when selection degrades to the single account without error.
- [ ] Lane 7. `hive usage` with the agy account present. Save `usage-table.txt`. Pass when the table renders the unsupported limits state without breaking other rows.
- [ ] Lane 8. Swap an agy bee between two credentialed accounts. Save `account-swap.txt`. Pass when the swap lands with transcript mode none and the next turn runs on the new account.
- [ ] Lane 9. Delete the credential file and probe. Save `probe-lapsed.txt`. Pass when the account reports uncredentialed and a spawn lands `auth_needed`.
- [ ] Lane 10. Add an account for a harness with no recipe alongside agy. Save `recipe-optional.txt`. Pass when both accounts coexist, proving the recipe layer stayed optional.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `npm run v2:daemon` wall time.
- [ ] Probe. Run at trunk and at the head, interleaved, three times each.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Head median more than 20 percent above trunk median fails.

**Review gate.** None. HB2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Automated reviewer triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator merges.

## Support agy on the tmux substrate or document the boundary (HB3)

**Depends on.** HB1.

**Files.**

- [ ] Edit `v2/daemon/src/tmuxHarness.ts`.
- [ ] Edit `v2/driver-tmux/src/transcripts.ts`.
- [ ] Create `v2/driver-tmux/src/agy-projection.ts`.
- [ ] Create `v2/driver-tmux/tests/agy-projection.test.ts`.
- [ ] Edit `v2/driver-tmux/tests/eq-matrix.test.ts`, `v2/driver-tmux/tests/parsers.test.ts`.
- [ ] Edit `v2/cli/src/help.ts` if the boundary is documented instead.

**Build.**

- [ ] First box is discovery. Run the agy TUI in a scratch home, locate where it persists conversation history on disk, and record path pattern, format, and update cadence in the PR body. This is the go or no-go fact for the substrate.
- [ ] On go. Add the agy arm to `tmuxObservationFor`, `tmuxDeliveryMode`, and `tmuxArgsFor` in `tmuxHarness.ts` with unattended permission defaults. Add the agy parser, renderer, and projector arm in `transcripts.ts`, replacing the silent claude-shaped default for agy with a real projector in `agy-projection.ts`. Ship hooks-style, notify-style or transcript-only fixtures and the eq-matrix entries. The reset-05 A3 rule applies, identical automation outcomes across observation styles, no degraded tier.
- [ ] On no-go, when the TUI writes no parseable transcript. Make `hive spawn --agent agy --substrate tmux` refuse with a clear error at spawn validation instead of failing at boot, and document the HSR-only boundary in `help.ts`.

**You see.**

- [ ] On go, `hive spawn agy-tui --agent agy --substrate tmux` reaches idle, `hive attach` shows the TUI, and `hive transcript` renders the conversation. On no-go, the spawn refusal names the boundary in one line.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Projection and parser fixtures plus the eq-matrix entries, or the refusal test. Run `npm run v2:check && npm run v2:driver2 && npm run v2:daemon`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured swarm worker role at the PR head, per the boot recipe. On no-go, lanes 2 through 9 collapse to refusal and HSR-regression checks and the plan records that narrowing here before the swarm runs.

- [ ] Lane 1. Spawn an agy tmux bee and send one prompt. Save `tmux-spawn.txt`. Pass when the bee reaches idle from transcript observation alone.
- [ ] Lane 2. Attach to the running TUI. Save `tmux-attach.txt`. Pass when the pane shows the live session.
- [ ] Lane 3. Deliver a message while the TUI sits at its input. Save `tmux-deliver.txt`. Pass when the message lands and a turn starts, proving the delivery mode choice.
- [ ] Lane 4. Compare `hive transcript` output against the same exchange on HSR. Save `parity.txt`. Pass when both render the same turns.
- [ ] Lane 5. Kill the tmux pane mid-turn. Save `tmux-crash.txt`. Pass when the daemon records the exit with a real cause.
- [ ] Lane 6. Revive the tmux bee. Save `tmux-revive.txt`. Pass when generation N+1 boots and history is intact or the fresh-runtime rule is reported.
- [ ] Lane 7. Run the transcript-only observation style against recorded fixtures. Save `eq-transcript.txt`. Pass when automation outcomes equal the other styles.
- [ ] Lane 8. Long turn past the quiesce window. Save `quiesce.txt`. Pass when no false idle is derived from pane silence.
- [ ] Lane 9. Two agy tmux bees in parallel. Save `tmux-concurrent.txt`. Pass when observations never cross wires.
- [ ] Lane 10. Regression lane, claude tmux bee at the head. Save `claude-tmux-regression.txt`. Pass when claude tmux behavior is unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `npm run v2:driver2` wall time.
- [ ] Probe. Run at trunk and at the head, interleaved, three times each.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Head median more than 20 percent above trunk median fails.

**Review gate.** None. HB3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Automated reviewer triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator merges.

## Plumb agy availability through Apiary (AP1)

**Depends on.** HB1 and HB2, merged and deployed.

**Files.**

- [ ] Edit `packages/core/src/modelCatalog.ts`.
- [ ] Edit `packages/core/src/hive.ts`.
- [ ] Edit `apps/desktop/src/shared/onboarding.ts`.
- [ ] Edit `apps/desktop/src/shared/capabilityDoctor.ts`.
- [ ] Edit `apps/desktop/src/main/capabilityDoctor.ts`.
- [ ] Edit `apps/desktop/src/main/gateway/tools/agentTools.ts`.
- [ ] Edit `packages/adapters/src/composerCapabilities.ts`.
- [ ] Edit `packages/core/src/modelCatalogArgs.test.ts`, `packages/core/src/modelCatalogDefault.test.ts`, `apps/desktop/src/main/gateway/tools/agentTools.test.ts`.

**Build.**

- [ ] Add the agy entry to `HARNESS_CATALOG` with the Gemini model list from Appendix A, `--model` flag args, and effort as a reasoning control mapped to `--effort`. Add the agy arm to `harnessPermissionArgs`. Leave `DEFAULT_HARNESS_PRIORITY` unchanged.
- [ ] Add `agy` to `HSR_CAPABLE_HARNESSES` and `REMOTE_HSR_CAPABLE_HARNESSES` in `packages/core/src/hive.ts`.
- [ ] Add `agy` to `LOCAL_RUN_HARNESSES`, the onboarding union and `ONBOARDING_HARNESSES` with executable `agy`, version args, install hint, and credential path `.gemini/antigravity-cli/antigravity-oauth-token`, and the doctor label.
- [ ] Replace the two duplicated harness enums in `agentTools.ts` with one shared list that includes `agy`. This is the subtract-before-add step the duplication invites.
- [ ] Add the agy home dir arm to `composerCapabilities.ts`. Skip `identityEnv.ts`. agy has no home env var to scrub, record that in the PR body.

**You see.**

- [ ] Compose lists agy with its Gemini models, the doctor reports the harness present with a version, Accounts can add an agy account, and `agent_spawn` accepts `harness: "agy"`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Catalog args, defaults, and both spawn-tool schemas gain agy cases. Run `pnpm typecheck && pnpm lint && pnpm --filter @apiary/core test && pnpm --filter @apiary/desktop exec vitest run src/main/gateway/tools/agentTools.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured swarm worker role at the PR head, per the boot recipe.

- [ ] Lane 1. Compose an agy bee from the compose pane. Save `compose-spawn.png`. Pass when the bee spawns and appears in the swarm view.
- [ ] Lane 2. Open the model picker on an agy compose. Save `model-picker.png`. Pass when the Gemini models render with effort control.
- [ ] Lane 3. Capability doctor with agy installed. Save `doctor-present.png`. Pass when the harness row shows present with version.
- [ ] Lane 4. Capability doctor with the agy binary renamed away. Save `doctor-absent.png`. Pass when the row shows absent and compose gates it.
- [ ] Lane 5. Add an agy account from Settings. Save `account-add.png`. Pass when the dialog lists agy and the account appears.
- [ ] Lane 6. `agent_spawn` MCP call with `harness: "agy"` on a fresh cell. Save `agent-spawn.txt`. Pass when the child spawns and lands work.
- [ ] Lane 7. `agent_spawn` with an unknown harness name. Save `agent-spawn-reject.txt`. Pass when the schema rejects it with a clear error.
- [ ] Lane 8. Respawn an existing bee to agy from the session composer. Save `respawn.png`. Pass when the harness switch spawns under agy.
- [ ] Lane 9. Template composer with an agy template including model and effort. Save `template.png`. Pass when the template spawns with the composed argv.
- [ ] Lane 10. Regression lane, compose a claude and a codex bee. Save `regression.png`. Pass when both flows are unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `pnpm --filter @apiary/core test` wall time.
- [ ] Probe. Run at trunk and at the head, interleaved, three times each.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Head median more than 20 percent above trunk median fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, 3, and 5 screenshots into the review message.
- [ ] Record a 30 to 60 second video of composing and running an agy bee. Save it as `/tmp/agy-swarm/AP1/review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Automated reviewer triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator merges.

## Render agy transcripts in Apiary (AP2)

**Depends on.** AP1.

**Files.**

- [ ] Edit `packages/core/src/transcript.ts`.
- [ ] Create `packages/adapters/src/transcripts/agy.ts`.
- [ ] Edit `packages/adapters/src/transcripts/index.ts`.
- [ ] Create `packages/adapters/fixtures/transcripts/agy/small.jsonl` and `edge-cases.jsonl` with golden JSON.
- [ ] Edit `packages/adapters/src/capture/resolve.ts`.
- [ ] Edit `apps/desktop/src/main/hiveMirrorTranscriptResolver.ts`.
- [ ] Edit `apps/desktop/src/renderer/src/modelMark.tsx` and `icons.tsx`.
- [ ] Edit `docs/transcripts.md`.
- [ ] Edit `packages/adapters/src/transcripts/__tests__/golden.test.ts`, `packages/core/src/transcript.test.ts`, `apps/desktop/src/main/hiveMirrorTranscriptResolver.test.ts`.

**Build.**

- [ ] Widen the `Harness` union with `agy` and add the agy normalizer mapping init, step_update, and result events onto `AgentEvent`, one normalizer per harness per `docs/transcripts.md`. Build fixtures from real captured sessions, sanitized with the sibling `sanitize.py`.
- [ ] Register agy in `FACTORIES`, `FEED_HARNESSES`, and the `resolve.ts` capture switch.
- [ ] Add a Gemini model mark family and SVG, keyed off the `gemini-` model prefix and the agy harness.
- [ ] Add the agy section to `docs/transcripts.md` with the path and format registry entry honeybee publishes.

**You see.**

- [ ] An agy bee's pane in Apiary renders structured turns with tool calls and usage instead of raw `hive tail` text, and the bee row wears the Gemini mark.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Golden fixtures for small and edge cases pass, resolver maps agy, transcript type checks. Run `pnpm typecheck && pnpm --filter @apiary/adapters test && pnpm --filter @apiary/desktop exec vitest run src/main/hiveMirrorTranscriptResolver.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured swarm worker role at the PR head, per the boot recipe.

- [ ] Lane 1. Open a live agy bee's pane. Save `pane-live.png`. Pass when turns render structured, not raw.
- [ ] Lane 2. A turn with a tool call. Save `pane-tool.png`. Pass when the tool step renders as a tool event.
- [ ] Lane 3. A multi-turn session with usage. Save `pane-usage.png`. Pass when per-turn usage shows.
- [ ] Lane 4. An auth-failed agy session. Save `pane-auth-error.png`. Pass when the error turn renders and the bee wears `auth_needed`.
- [ ] Lane 5. Scrollback through a long transcript. Save `pane-scroll.png`. Pass when history loads without gaps.
- [ ] Lane 6. A revived bee's pane. Save `pane-revive.png`. Pass when generations render continuously.
- [ ] Lane 7. The swarm card with an agy bee. Save `swarm-mark.png`. Pass when the Gemini mark shows on the row.
- [ ] Lane 8. An unknown future agy event in the log. Save `pane-unknown-event.txt`. Pass when the normalizer degrades that event gracefully without dropping the pane.
- [ ] Lane 9. Regression lane, a claude pane and a codex pane. Save `pane-regression.png`. Pass when both render unchanged.
- [ ] Lane 10. Mirror check. Save `mirror.txt`. Pass when `hive_bees.agent` carries `agy` verbatim through the mirror and waggle mutations pass through untouched.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Golden transcript suite wall time in `pnpm --filter @apiary/adapters test`.
- [ ] Probe. Run at trunk and at the head, interleaved, three times each.
- [ ] Baseline. Record the trunk median first.
- [ ] Rule. Head median more than 20 percent above trunk median fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 7 screenshots into the review message.
- [ ] Record a 30 to 60 second video of an agy session rendering live. Save it as `/tmp/agy-swarm/AP2/review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Automated reviewer triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator merges.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

All probes ran 2026-09-02 on kontrol with agy 1.1.24 from `~/.local/bin/agy`.

- Headless single-shot. `agy -p="…" --output-format stream-json` emits `init` with conversation id, cwd, tool list, and permission mode, then `step_update` events, then `result` with status, response, turn count, and token usage. Conversation `dc4439ca`.
- Persistent multi-turn. `agy --print= --input-format stream-json --output-format stream-json` emits `init` at boot before any input, then runs one turn per NDJSON input line of shape `{"event":"user","message":{"content":[{"type":"text","text":"…"}]}}`, each turn closed by its own `result`. Conversation `f84fb331`, two turns in one process.
- Resume. `agy -p="…" --conversation f84fb331…` in a new process recalled the first turn's content, `num_turns` continued at 3.
- Model flag. `--model gemini-3.8-flash-low` accepted on argv in print mode, turn completed.
- Auth isolation. With `HOME=/tmp/agy-iso-home`, agy created a fresh `.gemini`, printed "Authentication required. Please visit the URL to log in", waited for a pasted code, then emitted a `result` with status `ERROR` and error "authentication failed or timed out", and exited 0. The exit code lies. The stanza and the result error are the detection surface. Token path is `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`.
- No data-dir env var. `GEMINI_DIR`, `GEMINI_HOME`, and `GEMINI_CONFIG_DIR` were all ignored. Home selection is `HOME` itself.
- Models. `agy models` lists gemini-3.8-flash high, medium, and low, 3.7-flash and 3.6-flash likewise, gemini-3.1-pro high and low, plus claude-sonnet-4-6, claude-opus-4-6-thinking, and gpt-oss-120b-medium.
- Fallback dirs. `~/.local/bin` is already in `executableFallbackDirs`, no change needed.

Unproven, and where each lands.

- Whether a quota or limits endpoint exists for `hive usage`. HB2 ships without a fetcher, the unsupported state is accepted.
- Where the agy TUI persists conversations, and in what format. HB3's discovery box, its go or no-go fact.
- Whether `--print-timeout` bounds a whole wait or each turn, and whether `12h` is accepted. HB1's lane 2 exercises multi-turn life beyond the 5 minute default.
- Whether headless request-review mode stalls on tool approvals without `--dangerously-skip-permissions`. HB1 ships the flag, matching the unattended posture of the other harnesses.
- Whether `battle mode`, subagents, or hooks in agy offer a cheaper events-file integration. Noted for later, not load-bearing.

## Appendix B. Alternatives rejected

- An ACP adapter modeled on grok. No ACP stdio mode surfaced in the agy help or binary strings. The probed print mode with stream-json in and out matches the claude adapter model exactly, so claude is the template.
- tmux-first integration. The TUI path needs a transcript locator and parser that are still undiscovered, while the headless path is proven and is the default substrate. HSR leads, tmux follows in HB3.
- Driving the `gemini` CLI instead of agy. The operator named agy, agy fronts the Antigravity model set including Gemini 3.1 pro, and one harness per CLI keeps the adapter honest.
- Gemini via API keys in an opencode account. Already possible today through the opencode google provider and orthogonal to a real agy harness.
- One combined honeybee PR. The adapter, the accounts layer, and the tmux layer have disjoint files and separate verification surfaces, so they sequence as verifiable units.

## Appendix C. Risks

- agy auto-updates and its stream shapes are unversioned. HB1 pins `AGY_CLI_DISABLE_AUTO_UPDATE=1` in the agent spec env, and the adapter treats unknown events as noise, never as state.
- Exit code 0 on auth failure. HB1's adapter reads the result error, lane 6 proves the flag lands.
- `--print-timeout` semantics. If the default 5 minutes bounds each turn silently, long turns die as false crashes. HB1 sets it long and lane 2 watches for it.
- HOME-only isolation means one agy account per home. That matches the accounts model where the home is the account, but concurrent multi-account agy inside a single shared home is impossible. Accepted, recorded in HB2.
- The tmux projector default silently renders unknown harnesses claude-shaped. HB3 replaces the default for agy or blocks the substrate, so no bee ships on the degraded path.
- Antigravity quota exhaustion strings are unknown. Until real `resource_blocked` cues are captured, exhaustion may surface as generic turn errors. Owners watch HB1 lane logs and extend the classifier when a real string appears.

## Appendix D. Links and reading list

- Honeybee contract. `.agents/skills/honeybee-core-work/SKILL.md`, `docs/HONEYBEE_V2_SPEC.md` section 16 on provider profiles and agent drivers, ADRs 001 and 002.
- Reset specs in the apiary repo. `docs/design/specs/reset-03-hsr-driver.md` harness adapters and test tiers, `reset-05-cell-tmux.md` tmux driver and the A3 equal-treatment rule, `reset-08-accounts.md` accounts model.
- Apiary contract. `.agents/skills/apiary-core-work/SKILL.md`, `docs/transcripts.md`, `docs/design/first-run-onboarding.md`.
- In-code contracts. `v2/adapters/src/types.ts` preamble, `v2/adapters/src/args.ts` precedence rule, `v2/core/src/accountRecipes.ts` extension-point note, `v2/core/src/executables.ts` resolution rule.
- Smoke procedure. `v2/driver-hsr/SMOKE.md`.
- HB1 and AP2 owners read `skills/how/SKILL.md` before starting. AP1's enum unification gets `skills/interrogate/SKILL.md` if contested. The decision trail runs per `skills/show-me-your-work/SKILL.md` at `docs/review/agy-program-log.tsv` in each repo.
