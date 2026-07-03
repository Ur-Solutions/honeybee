# God File Refactor PRD

## 1. Summary

The `src/` tree has grown several "god files" — modules that accumulated too many responsibilities and became the default landing spot for unrelated code. The largest was `src/cli.ts`, which grew to ~9,600 lines (from ~5,000 when this PRD was first written), followed by `src/accounts.ts`, `src/limits.ts`, `src/buz.ts`, and a handful of others that mix provider-specific protocol logic with generic business logic.

This PRD defines a horizontal split of those files into focused submodules, while preserving the existing public API through barrel re-exports. No behavior changes; this is pure structural refactor.

> **Status (HIVE-15, done):** the `src/cli.ts` split described in §6.1 has been implemented. `src/cli.ts` is now a ~420-line entrypoint (argv parsing + top-level dispatch + `printHelp`); every command handler lives in `src/commands/*.ts`, reusable helpers in `src/cli/shared.ts`, and the HSR runner host in `src/hsr/runnerHost.ts`. The remaining god files (§6.2–§6.10) are still pending.

## 2. Motivation

- **Merge conflicts:** `src/cli.ts` is touched by almost every feature PR.
- **Parallel work:** Large files make it hard for multiple people to work on different commands/domains simultaneously.
- **Reasoning cost:** A 5,000-line file forces reviewers to load an entire CLI surface to understand one command.
- **Provider drift:** Claude/Codex/OpenCode/Grok adapters are repeated across transcripts, limits, and accounts without a consistent home.
- **Testing:** Command handlers and protocol logic buried in mega-files are harder to unit-test in isolation.

## 3. Goals

- Split `src/cli.ts` into a `src/commands/` directory of focused command modules (done — HIVE-15).
- Extract provider-specific code from `limits.ts`, `accounts.ts`, and `transcripts.ts` into `providers/` subdirectories.
- Separate transport/storage/daemon concerns in `buz.ts`.
- Split the loop driver, daemon run loop, completion tables, facade, and search engine into cohesive layers.
- Keep all existing imports working during the migration via barrel re-exports.
- Add or move tests to cover newly extracted modules without changing test behavior.

## 4. Non-goals

- No CLI behavior changes.
- no new features.
- No renaming of exported functions or types that external callers rely on.
- No change to the on-disk store layout, session record shape, or ledger format.
- No migration of `dist/` or build tooling unless required by import paths.

## 5. Current state

Ranked by severity (lines, fan-out, fan-in):

| File | Lines | Problem |
|------|-------|---------|
| `src/cli.ts` | ~9,600 → ~420 | Was the entire CLI surface (40+ commands, spawn orchestration, HSR plumbing, formatting, shared helpers). **Split in HIVE-15** into `src/commands/*`, `src/cli/shared.ts`, and `src/hsr/runnerHost.ts`; cli.ts is now dispatch-only. |
| `src/accounts.ts` | ~793 | Registry CRUD + home activation + Claude OAuth chain lifecycle |
| `src/limits.ts` | ~793 | Provider usage APIs + cache + auto-pick heuristics |
| `src/buz.ts` | ~712 | Messaging policy + transport + storage + daemon queue drain |
| `src/daemon/run.ts` | ~666 | `tick()` business logic + `runDaemon()` lifecycle + default wiring |
| `src/loop/flow.ts` | ~648 | Loop driver + boundary detection + summarizer + stop-menu |
| `src/transcripts.ts` | ~639 | Provider-specific transcript adapters aggregated |
| `src/completion.ts` | ~518 | Huge static tables mixed with completion logic |
| `src/flow/hive_facade.ts` | ~507 | Bee lifecycle + seals + buz + loops in one facade |
| `src/search.ts` | ~478 | Search engine + filesystem corpus reader + haystack builders |

`src/store.ts` (374 lines, fan-in 35) is the shared data model. It is already well-factored and should not absorb new concerns; ledger rotation and legacy-path handling may later move to `store/` submodules.

## 6. Target structure

### 6.1 `src/cli.ts` → `src/commands/` (implemented — HIVE-15)

`src/cli.ts` is now a thin entrypoint: `main(argv)` (the `__complete`/`__flow-exec`/`__hsr-run` intrinsics + the top-level command `switch`) and `printHelp`. Every command handler moved into `src/commands/*.ts`; cross-cutting helpers into `src/cli/shared.ts`; the HSR runner host into `src/hsr/runnerHost.ts`. cli.ts imports the handlers it dispatches to and re-exports the symbols the unit tests consume (`assertResumable`, `tmuxSessionSurvives`, `assertSingleBeeInvocation`, `resolveDefineArgs`, `resolvePromptArg`, `addBeeMember`, `seedWorkspaceMembers`, `emitLog`, `followFlag`, `logLinesFlag`, `resolveSpawnSubstrate`).

| Module | Responsibility |
|--------|---------------|
| `src/cli/shared.ts` | Reusable CLI helpers: flag/env parsing (`stringFlag`, `hasFlag`, `ageFlag`, `dangerousMode`, `safeTmuxTarget`, `sleep`, `ttlFlagMs`, log-flag helpers), session/pane resolution (`resolveSession`, `ensureLive`, `resolveBeeInCurrentPane`), spawn support (`resolveSpawnCwd`, `resolveSwarmIdHint`, `deliverBrief`, `confirmSpawnReady`), substrate resolution (`resolveSpawnSubstrate`/`Node`/`Colony`, `parseSubstrateAlias`), and per-bee state-context building (`buildStateContext`, `liveTargetsAcrossNodes`, `observeHsrLiveness`, `formatHiveStateCell`) |
| `src/hsr/runnerHost.ts` | Detached `hive __hsr-run` host + spawn-side fork (`runHsrHostFromPayload`, `spawnHsrHost`, `waitForHsrHost`) |
| `src/commands/spawn.ts` | `spawn`/`new`/`launch`: `spawnBee`, `spawnSingleBee`, `spawnHomogeneousSwarm`, `spawnFromFrame`, account/profile resolution |
| `src/commands/run.ts` | `run`, `x`, `xa`, `open` (spawn-and-prompt) |
| `src/commands/fork.ts` | `fork`, `split` (branch a bee into a fresh comb/pane) |
| `src/commands/migrate.ts` | `promote`, `demote`, `revive` (tmux↔HSR substrate migration + resume) |
| `src/commands/messaging.ts` | `send`, `answer`, `brief`, `seal`, `rename`, `tag`, `own`, `move` |
| `src/commands/observe.ts` | `list`/`ls`/`ps`, `bees`, `tail`, `transcript`, `last`, `wait`, `kill`, `urls`, `view`, `attach`, `next` |
| `src/commands/here.ts` | `here`, `spawn-picker` |
| `src/commands/clean.ts` | `clean` (dead/idle/interactive) + candidate collection |
| `src/commands/loop.ts` | `loop` subcommands + interactive launch + templates |
| `src/commands/flow.ts` | `flow` subcommands + `__flow-exec` runner |
| `src/commands/quest.ts` | `quest` workflows |
| `src/commands/workspace.ts` | `workspace`/`ws` + `restore` |
| `src/commands/colony.ts` | `colony` subcommands |
| `src/commands/frame.ts` | `frame` subcommands |
| `src/commands/swarm.ts` | `swarm` subcommands |
| `src/commands/node.ts` | `node` + `substrate` subcommands |
| `src/commands/daemon.ts` | `daemon` subcommands + `sessions`/`sync` maintenance |
| `src/commands/buz.ts` | `buz` subcommands |
| `src/commands/search.ts` | `search`, `seals` |
| `src/commands/account.ts` | `account`, `activate`, `login`, `swap-account`, `usage`, `limits` |
| `src/commands/config.ts` | `config` + `completion` |
| `src/commands/keys.ts` | `keys` (print/path/check) |

Tests import command modules directly from `src/commands/*.ts` or via the re-export surface on `src/cli.js`.

### 6.2 `src/accounts.ts` → `src/accounts/`

| Module | Responsibility |
|--------|---------------|
| `src/accounts/registry.ts` | `AccountRecord`, `listAccounts`, `addAccount`, `removeAccount`, `findAccount`, account dir paths |
| `src/accounts/resolve.ts` | `resolveSpawnAgent`, `SpawnAgentSpec`, `autoAccountTool`, tool shorthand parsing |
| `src/accounts/activation.ts` | `activateAccountIntoHome`, `captureAccountFromHome`, home seeding |
| `src/accounts/claudeChain.ts` | Claude OAuth chain parse/refresh/sync/persist/rotate/evacuate |
| `src/accounts/homes.ts` | `candidateHomes`, `claudeHomesForAccount`, `defaultHomeForAccount`, `homeBelongsToAccount`, `dedicatedHomesFor` |
| `src/accounts/utils.ts` | `accountEmail`, `mergeCredentialsJson`, `accountHasCredentials` |
| `src/accounts/index.ts` | Public barrel |

### 6.3 `src/limits.ts` → `src/limits/`

| Module | Responsibility |
|--------|---------------|
| `src/limits/core.ts` | `WindowUsage`, `AccountLimits`, `paceDelta`, `windowRolledOver` |
| `src/limits/providers/claude.ts` | Claude OAuth usage fetch, profile verification, credential candidates |
| `src/limits/providers/codex.ts` | Codex app-server RPC + on-disk snapshot reader |
| `src/limits/cache.ts` | `cachedAccountLimits`, `readLimitsCache`, `updateLimitsCache`, `limitsCachePath` |
| `src/limits/autoPick.ts` | `selectLeastLoadedAccount`, `pickLeastLoadedAccount`, `AUTO_FIVE_HOUR_SATURATION_PERCENT` |
| `src/limits/index.ts` | Public barrel |

Shrink `LimitsDeps` by injecting per-provider fetchers from the new provider modules.

### 6.4 `src/buz.ts` → `src/buz/`

| Module | Responsibility |
|--------|---------------|
| `src/buz/types.ts` | `BuzTier`, `BuzMessage`, `BuzSender`, `BuzSendInput`, `BuzSendResult`, constants |
| `src/buz/ids.ts` | `generateMessageId`, base32 encoding |
| `src/buz/policy.ts` | `resolveBuzAccept`, `downgradeTier`, `validateAcceptList`, `parseAcceptFlag` |
| `src/buz/paths.ts` | `buzRoot`, `beeMailboxDir`, `externalOutboxDir`, `inboxFilename`, `outboxFilename` |
| `src/buz/transport.ts` | `sendBuzMessage`, interrupt/queue/passive dispatch |
| `src/buz/storage.ts` | `writeMailbox`, `writeOutbox`, `listMessages`, `readMessageById`, `consumeMessage`, `purgeMailbox` |
| `src/buz/daemonDrain.ts` | `processQueueForBee`, `DrainResult`, retry/quarantine logic |
| `src/buz/index.ts` | Public barrel |

### 6.5 `src/daemon/run.ts` → `src/daemon/`

| Module | Responsibility |
|--------|---------------|
| `src/daemon/tick.ts` | Pure `tick()` and `TickDeps` |
| `src/daemon/probe.ts` | `defaultProbeNodes`, `defaultCapturePanes`, `ProbeResult` |
| `src/daemon/wiring.ts` | `buildDefaultDeps` |
| `src/daemon/run.ts` | Keep `runDaemon()` lifecycle only |
| `src/daemon/utils.ts` | `guard`, `toError`, `sleep`, `withTimeout` |

Inside `tick.ts`, split the long function into phase helpers: observe, transition, dispatch.

### 6.6 `src/loop/flow.ts` → `src/loop/`

| Module | Responsibility |
|--------|---------------|
| `src/loop/driver.ts` | `runLoop` only — thin state machine |
| `src/loop/boundary.ts` | `waitForIterationBoundary`, `captureBoundaryPane`, idle detection |
| `src/loop/helpers.ts` | `runSummarizerBee`, `judgeSaysStop`, helper spawn |
| `src/loop/stopMenu.ts` | Stop condition evaluation (`--until`, `--max`, `--max-duration`, sentinel, judge, seal status) |
| `src/loop/spawn.ts` | `spawnLoopBee`, `spawnIterationBee`, `trackSpawned` |

### 6.7 `src/transcripts.ts` → `src/transcripts/`

| Module | Responsibility |
|--------|---------------|
| `src/transcripts/index.ts` | Public API: `latestTranscript`, `renderTranscript`, `lastAssistantText`, `firstUserText` |
| `src/transcripts/core.ts` | Shared types, scoring, caching, `readJsonlCached`, `clearTranscriptCaches` |
| `src/transcripts/providers/claude.ts` | Claude project folder + JSONL parsing |
| `src/transcripts/providers/codex.ts` | Codex session tree + row normalization |
| `src/transcripts/providers/opencode.ts` | OpenCode storage tree + message/part reading |
| `src/transcripts/providers/grok.ts` | Grok summary/chat_history parsing |
| `src/transcripts/titles.ts` | `extractClaudeTitle`, `extractCodexTitle`, `firstUserPromptTitle`, `normalizeTitleCandidate` |
| `src/transcripts/render.ts` | `renderTranscript`, `textFromContent`, `stripCommandNoise` |

### 6.8 `src/completion.ts` → `src/completion/`

| Module | Responsibility |
|--------|---------------|
| `src/completion/data.ts` | All static tables (`COMMANDS`, `FLAGS_BY_COMMAND`, etc.) |
| `src/completion/candidates.ts` | `getCompletionsFromState`, `resolveFlagValueCandidates`, `nounCommandCandidates` |
| `src/completion/files.ts` | `fileCandidates`, `expandTilde` |
| `src/completion/shells.ts` | `shellScript`, `BASH_SCRIPT`, `ZSH_SCRIPT`, `FISH_SCRIPT` |
| `src/completion/index.ts` | `getCompletions` orchestrator |

Long term, consider deriving completion data from the new `src/cli/*.ts` command modules to prevent drift.

### 6.9 `src/flow/hive_facade.ts` → `src/flow/facade/`

| Module | Responsibility |
|--------|---------------|
| `src/flow/facade/core.ts` | `HiveFacade` core: spawn, send/brief, wait, kill, killAll, log, `resolveRecord` |
| `src/flow/facade/seals.ts` | `seal`, `collect`, `waitForSeal` |
| `src/flow/facade/buz.ts` | `buzSend`, `buzInbox`, `buzAwait` |
| `src/flow/facade/loop.ts` | `loop`, `loopStatus`, `loopStop` |
| `src/flow/facade/utils.ts` | `resolveNode`, `sleep`, `loopArgsFromSpec` |

Keep `HiveFacade` as a thin delegating wrapper, or split into focused facades if callers can tolerate it.

### 6.10 `src/search.ts` → `src/search/`

| Module | Responsibility |
|--------|---------------|
| `src/search/engine.ts` | `search`, `compileMatcher`, `scoreHit`, ranking |
| `src/search/snippets.ts` | `makeSnippet` |
| `src/search/readers/fs.ts` | Default `CorpusReader`, `listLedgerFiles`, `sessionMetaFor` |
| `src/search/filters.ts` | `passesLedgerFilters`, `sealHaystack`, `sessionHaystack` |
| `src/search/types.ts` | `SearchHit`, `SearchOptions`, `CorpusReader`, filters |
| `src/search/index.ts` | Public barrel |

## 7. Public API preservation

During and after each split, the original top-level file remains a **barrel re-export** so existing callers continue to work:

```ts
// src/cli.ts (HIVE-15): keeps main(argv) + dispatch + printHelp, imports the
// handlers from src/commands/*, and re-exports the unit-test surface, e.g.
export { assertResumable, tmuxSessionSurvives } from "./commands/migrate.js";
export { resolveDefineArgs } from "./commands/frame.js";
// ...
```

```ts
// src/accounts.ts
export * from "./accounts/index.js";
```

Migration order:
1. Create new modules and move code.
2. Update the original file to re-export from the new modules.
3. Run the full test suite.
4. In later cleanup PRs, migrate high-value callers to import directly from submodules.
5. Only remove the barrel files once all internal callers are migrated and tests pass.

## 8. Test strategy

- Run `npm test` (or the project's test command) after each module split.
- For each extracted module, move existing tests that exercise its functions into a matching test file (e.g. `tests/cli/spawn.test.ts`).
- Do not change test assertions; only update import paths.
- Add focused unit tests for helpers that were previously buried inside large files and had no direct coverage (e.g., `resolveSpawnCwd`, `downgradeTier`, `makeSnippet`).
- Keep at least one integration-style test that imports through the original barrel to verify the public API still works.

## 9. Rollout phases

### Phase 1 — CLI split (highest impact) — DONE (HIVE-15)
- Created `src/commands/` (one module per command cluster), `src/cli/shared.ts`, and `src/hsr/runnerHost.ts`.
- Moved all command handlers and shared helpers out of `src/cli.ts`.
- `src/cli.ts` is now dispatch-only (`main` + `printHelp`, ~420 lines) and re-exports the unit-test surface.
- All existing tests kept green (typecheck + touched test files).

### Phase 2 — Account identity layer
- Create `src/accounts/`.
- Extract `claudeChain.ts` first (most complex).
- Then `registry.ts`, `resolve.ts`, `activation.ts`, `homes.ts`, `utils.ts`.
- Convert `src/accounts.ts` to a barrel.

### Phase 3 — Limits providers
- Create `src/limits/`.
- Extract `providers/claude.ts` and `providers/codex.ts`.
- Extract `cache.ts` and `autoPick.ts`.
- Convert `src/limits.ts` to a barrel.

### Phase 4 — Buz layers
- Create `src/buz/`.
- Extract `policy.ts`, `transport.ts`, `storage.ts`, `daemonDrain.ts`.
- Convert `src/buz.ts` to a barrel.

### Phase 5 — Provider adapters and supporting files
- `src/transcripts.ts` → `src/transcripts/providers/`.
- `src/completion.ts` → `src/completion/`.
- `src/daemon/run.ts` → `src/daemon/{tick,probe,wiring,utils}.ts`.
- `src/loop/flow.ts` → `src/loop/{driver,boundary,helpers,stopMenu,spawn}.ts`.

### Phase 6 — Facade and search
- `src/flow/hive_facade.ts` → `src/flow/facade/`.
- `src/search.ts` → `src/search/`.

### Phase 7 — Store cleanup (optional)
- If `store.ts` grows further, move ledger rotation/pruning to `store/ledger.ts` and legacy paths to `store/legacy.ts`.

## 10. Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Import path churn breaks tests | Keep barrel re-exports until callers are migrated; run tests after every file move. |
| Circular imports between new modules | Move shared types to a `types.ts` leaf module; avoid modules importing their parent barrel. |
| Completion metadata drifts from CLI | After CLI split, generate or colocate completion tables with each command module. |
| Large PRs are hard to review | Split by phase; each phase should be one or more small PRs. |
| `store.ts` fan-in makes changes risky | Do not add new fields; give new cross-cutting metadata its own module. |

## 11. Success criteria

- `src/cli.ts` holds only `main`/dispatch + `printHelp` (~420 lines) and re-exports the test surface — no command handlers or business logic. *(Met by HIVE-15. The original "<200 lines, only re-exports main" target assumed `main` moving to a `router.ts`; the dispatch was kept in cli.ts as the `bin` entrypoint, which is why it is ~420 rather than <200.)*
- No file in `src/` exceeds ~500 lines after the refactor, except data/config tables. *(A few extracted command modules — spawn, workspace, quest, observe — remain 500–1,000 lines; each is a single cohesive command cluster and can be split further in a follow-up if warranted.)*
- `npm test` passes at each phase boundary.
- All existing top-level exports remain importable.
- New modules have a single, obvious responsibility.
