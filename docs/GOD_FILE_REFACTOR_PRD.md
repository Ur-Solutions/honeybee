# God File Refactor PRD

## 1. Summary

The `src/` tree has grown several "god files" — modules that accumulated too many responsibilities and became the default landing spot for unrelated code. The largest is `src/cli.ts` at ~5,000 lines, followed by `src/accounts.ts`, `src/limits.ts`, `src/buz.ts`, and a handful of others that mix provider-specific protocol logic with generic business logic.

This PRD defines a horizontal split of those files into focused submodules, while preserving the existing public API through barrel re-exports. No behavior changes; this is pure structural refactor.

## 2. Motivation

- **Merge conflicts:** `src/cli.ts` is touched by almost every feature PR.
- **Parallel work:** Large files make it hard for multiple people to work on different commands/domains simultaneously.
- **Reasoning cost:** A 5,000-line file forces reviewers to load an entire CLI surface to understand one command.
- **Provider drift:** Claude/Codex/OpenCode/Grok adapters are repeated across transcripts, limits, and accounts without a consistent home.
- **Testing:** Command handlers and protocol logic buried in mega-files are harder to unit-test in isolation.

## 3. Goals

- Split `src/cli.ts` into a `src/cli/` directory of focused command modules.
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
| `src/cli.ts` | ~4,985 | Entire CLI surface: 35+ commands, spawn orchestration, formatting, shared helpers |
| `src/accounts.ts` | ~793 | Registry CRUD + home activation + Claude OAuth chain lifecycle |
| `src/limits.ts` | ~793 | Provider usage APIs + cache + auto-pick heuristics |
| `src/buz.ts` | ~712 | Messaging policy + transport + storage + daemon queue drain |
| `src/daemon/run.ts` | ~394 (was 1,050+; decomposed, see §6.5) | `runDaemon()` lifecycle + re-export barrel |
| `src/loop/flow.ts` | ~648 | Loop driver + boundary detection + summarizer + stop-menu |
| `src/transcripts.ts` | ~639 | Provider-specific transcript adapters aggregated |
| `src/completion.ts` | ~518 | Huge static tables mixed with completion logic |
| `src/flow/hive_facade.ts` | ~507 | Bee lifecycle + seals + buz + loops in one facade |
| `src/search.ts` | ~478 | Search engine + filesystem corpus reader + haystack builders |

`src/store.ts` (374 lines, fan-in 35) is the shared data model. It is already well-factored and should not absorb new concerns; ledger rotation and legacy-path handling may later move to `store/` submodules.

## 6. Target structure

### 6.1 `src/cli.ts` → `src/cli/`

`src/cli.ts` becomes a thin entry-point barrel. New modules:

| Module | Responsibility |
|--------|---------------|
| `src/cli/router.ts` | `main(argv)` and command dispatch map (`COMMANDS`) |
| `src/cli/spawn.ts` | `spawnBee`, `spawnSingleBee`, `spawnHomogeneousSwarm`, `spawnFromFrame`, readiness confirmation, `resolveSpawnCwd`, `resolveSwarmIdHint`, `deliverBrief`, `confirmSpawnReady` |
| `src/cli/clean.ts` | `clean` command + candidate collection logic |
| `src/cli/flow.ts` | `flow` and `loop` subcommands |
| `src/cli/account.ts` | `account`, `activate`, `login`, `swap-account`, `usage`, `limits` |
| `src/cli/buz.ts` | `buz` subcommands |
| `src/cli/daemon.ts` | `daemon` subcommands |
| `src/cli/frames.ts` | `colony`, `frame`, `swarm` subcommands |
| `src/cli/search.ts` | `search`, `seals find` |
| `src/cli/shared.ts` | Reusable CLI helpers: `stringFlag`, `ageFlag`, `hasFlag`, `defaultBootMs`, `dangerousMode`, `safeTmuxTarget` |
| `src/cli/formatting.ts` | Output helpers: `formatStateCell`, `formatHiveStateCell`, `limitCell`, `limitBar`, `corpusBadge` |

`src/cli.ts` re-exports only `main` for the `bin` entry. Tests may import command modules directly from `src/cli/*.ts`.

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

### 6.5 `src/daemon/run.ts` → `src/daemon/` — DONE (HIVE-18)

`run.ts` had grown to 1,050+ lines by the time this landed (the ~666 above was the
count when the PRD was written). Decomposed as follows; `run.ts` re-exports the
tick/probe/wiring/timeout surface so existing `./daemon/run.js` imports keep resolving.

| Module | Responsibility |
|--------|---------------|
| `src/daemon/tick.ts` | Pure `tick()`, `TickDeps`/`TickResult` and the tick types, the dispatcher registry (`tickDispatchers`, `emptyDispatcherOutcomes`), and `logTickResult()` |
| `src/daemon/probe.ts` | `defaultProbeNodes`, `defaultCapturePanes` (`ProbeResult` lives with the tick contract in `tick.ts`) |
| `src/daemon/wiring.ts` | `buildDefaultDeps` + throttled transcript-metadata refresh |
| `src/daemon/supervision.ts` | In-process watchdog + `breach`/hard-kill self-destruct + out-of-process sentinel spawn + `pushRecentError` (`createSupervisor()`) |
| `src/daemon/timeouts.ts` | `withTimeout`, `guard`, `toError`, `TickTimeouts`/`defaultTickTimeouts` |
| `src/daemon/run.ts` | `runDaemon()` lifecycle (lock, signals, loop) + backward-compat re-export barrel |

`sleep` stays inline in `run.ts` (a loop concern). The supervision defenses moved
into a `Supervisor` factory so the watchdog/breach state is no longer entangled
in `runDaemon()`, and the ~75-line result-logging fan-out is now `logTickResult()`.

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
// src/cli.ts
export { main } from "./cli/router.js";
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

### Phase 1 — CLI split (highest impact)
- Create `src/cli/`.
- Move command handlers and shared helpers.
- Convert `src/cli.ts` to a barrel exporting `main`.
- Update tests and run the suite.

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
- `src/daemon/run.ts` → `src/daemon/{tick,probe,wiring,supervision,timeouts}.ts` (DONE, HIVE-18).
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

- `src/cli.ts` is under 200 lines and only re-exports `main`.
- No file in `src/` exceeds ~500 lines after the refactor, except data/config tables.
- `npm test` passes at each phase boundary.
- All existing top-level exports remain importable.
- New modules have a single, obvious responsibility.
