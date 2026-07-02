# Honeybee Multi-Agent Code Review - 2026-06-19

Swarm: `@honeybee-mixed-code-review-20260619T0830Z`  
Colony: `honeybee`

## Review Coverage

The first 25-agent Codex-only swarm was stopped and destroyed because it used the default Codex home. The replacement swarm used 33 read-only workers weighted toward lower-usage accounts:

- 12 OpenCode workers: 6 `opencode-minimax`, 6 `opencode-glm`
- 10 Claude workers: 5 `claude-tormod-ursolutions.no`, 3 `claude-tormod-thto.no`, 2 `claude-tormod.haugland-gmail.com`
- 5 Codex workers: 3 `codex-tormod.haugland-gmail.com`, 1 `codex-tormod-thto.no`, 1 `codex-tormod-ursolutions.no`
- 3 Grok workers and 3 Kimi workers

Grok workers blocked on browser OAuth approval and Kimi workers started without a configured provider/model, so their panes produced no code review. Several OpenCode/Claude/Codex workers produced wrapped or partial JSON blocks; the findings below are the concrete, deduplicated results that could be parsed or verified from final output. No worker code writes were observed in `git status`; the only new repo artifact from this orchestration is under `docs/reviews/`.

Follow-up swarm: `@honeybee-review-followup-20260619T0835Z`

The follow-up pass launched 9 read-only workers for failed or malformed shards: 6 Claude workers and 3 Grok workers. All Claude follow-ups used `claude --dangerously-skip-permissions`; the earlier Claude permission prompts were caused by the relaunch command explicitly passing `--no-yolo`, not by Hive defaults. Five Claude shards produced usable final review output after recovering one wrapped transcript, yielding 29 follow-up findings. The Grok Hive sessions still opened browser approval prompts even after a direct Grok login test succeeded, so no Grok follow-up findings were collected. Kimi follow-ups were skipped because the Hive Kimi home still has no provider/default model configured.

Kimi yolo rerun swarm: `@honeybee-kimi-yolo-rerun-20260619T084945Z`

After fixing the Kimi home/provider setup and making Hive spawn Kimi with `kimi --yolo` by default, 3 Kimi read-only follow-up workers ran successfully and produced 30 parsed findings. Those findings are folded below. Grok is still pending a persistent xAI browser authorization fix.

## Highest Priority Findings

### 1. Flow and loop spawn resolution bypasses thin profile account overlays

Severity: High  
Category: Correctness  
Evidence: `src/spawnResolve.ts:32`, `src/flow/hive_facade.ts:164`, `src/loop/flow.ts:491`, `src/cli.ts:619`

CLI spawns resolve config-backed thin profiles through `resolveProfileOverlay`, applying account, model, args, cwd, and yolo overrides. Flow and loop spawns now use `resolveSpawnSpec`, which handles `<tool>-auto` and account shorthands but does not apply `bees.<name>.account` profile overlays. A profile that works via `hive spawn` can therefore fail in a flow/loop or run under the wrong identity.

Recommendation: move thin-profile overlay resolution into a shared spawn resolver used by CLI, flow, and loop paths, or reject account-backed profile names clearly in flow/loop until parity exists.

### 2. Loop readiness timeout still keys off the unresolved bee token

Severity: Medium  
Category: Correctness  
Evidence: `src/loop/flow.ts:204`, `src/loop/flow.ts:550`, `src/loop/flow.ts:590`

The loop runner can now accept aliases such as `codex-auto` or account ids, but readiness waits still call `bootMs(cfg.bee)`. For resolved Codex accounts, that can fall back to the generic 10s timeout instead of Codex's longer startup budget.

Recommendation: after spawning, use `bootMs(record.agent)` for iteration, summarizer, and judge readiness waits.

### 3. Short loop ID allocation is not atomic

Severity: Medium  
Category: Correctness  
Evidence: `src/loop/state.ts:126`, `src/cli.ts:6277`, `src/flow/hive_facade.ts:394`

`generateLoopId` reads existing loop ids and returns a short `LP.<suffix>` before the loop directory is created. Two concurrent loop starts can choose the same suffix before either writes its state.

Recommendation: allocate under a loop-id lock, or claim the candidate with exclusive directory creation and retry on `EEXIST`.

### 4. Ledger `--bee` search drops `bee:`-keyed events

Severity: Medium  
Category: Correctness  
Evidence: `src/search.ts:318`

`passesLedgerFilters` only checks ledger `session` and `name` fields for `--bee`. Ledger events that use `bee` as their target key, such as tag/relationship/buz configuration events, are silently filtered out.

Recommendation: include `parsed.bee` in the bee filter and add a search test for a `bee:`-keyed ledger event.

### 5. Shipped tmux config references base bindings that were removed

Severity: Medium  
Category: Docs / UX  
Evidence: `docs/honeybee.tmux.conf:3`, `docs/honeybee.tmux.conf:21`, `src/keybindings.ts:18`

`docs/honeybee.tmux.conf` says the current block adds to base bindings already in the file, including `M-b`, `M-n`, attention queue, rename, and needs-me bindings. The file now starts at the affordance block, so those referenced base bindings are absent.

Recommendation: restore the base bindings or update the docs/tests so this file is explicitly only the affordance layer.

### 6. Account-bound flow spawn guards are not tested

Severity: Medium  
Category: Test gap  
Evidence: `src/agents.ts:319`, `src/agents.ts:336`, `tests/agents.test.ts:199`

`spawnBeeForFlow` now rejects unresolved auto aliases, rejects account-bound remote-node spawns, activates credentials, and stamps `accountId`. Existing tests only cover a bare no-account spawn.

Recommendation: add tests for unresolved `<tool>-auto`, remote-node account rejection, and a happy path that asserts `accountId`, home, model/provider behavior.

### 7. `<tool>-auto` resolver branch lacks deterministic flow/loop coverage

Severity: Medium  
Category: Test gap  
Evidence: `src/spawnResolve.ts:36`, `tests/spawnResolve.unit.test.ts:4`

The resolver file was introduced to close the `hive loop launch codex-auto` failure mode, but the unit test explicitly defers the auto branch to elsewhere and no flow/loop test appears to cover it.

Recommendation: add an injectable picker seam or an integration test that proves `<tool>-auto` becomes a concrete account in the flow/loop spawn path.

### 8. Claude home default-model seeding is not asserted

Severity: Medium  
Category: Test gap  
Evidence: `src/accounts.ts:496`, `tests/accounts.test.ts:186`

`withClaudeSettingsDefaults` now seeds `opus[1m]` when a Claude home settings file lacks a model, preventing fallback to retired defaults. The no-model test hits this branch but does not assert the resulting `settings.model`.

Recommendation: assert `model === "opus[1m]"` for missing/blank model, and assert explicit models are preserved.

### 9. Loop docs still show the retired id format

Severity: Medium  
Category: Docs  
Evidence: `docs/HIVE_CLI_REFERENCE.md:1647`, `src/loop/state.ts:122`, `src/cli.ts:6277`

Loop ids are now `LP.<hex>` and resolvable by full id, suffix, or unambiguous prefix. `HIVE_CLI_REFERENCE.md` still shows dated ids such as `20260612-abcdef12`, and loop `--bee` docs still imply only plain kinds even though account ids and `<tool>-auto` are supported.

Recommendation: update loop docs and examples to the new `LP.<hex>` format and document account/auto bee tokens.

### 10. Published package would ship missing binaries

Severity: High  
Category: Best practice  
Evidence: `package.json:6`, `.gitignore:2`

`package.json` maps the `hive` and `ap` binaries to `dist/cli.js`, but `dist/` is ignored and there is no `files` whitelist, `.npmignore`, or `prepare` script to guarantee build output lands in a published tarball. An installed package can therefore expose broken bin entries.

Recommendation: add a package publication policy: either include built `dist` via `files`, generate it in `prepare/prepack`, or mark the package private until publishing is intentionally supported.

### 11. `swapAccount` can leave records and credentials inconsistent on partial failure

Severity: Medium  
Category: Correctness  
Evidence: `src/swap.ts:92`

The swap flow kills the old session, activates the new account into the home, then relaunches and only records the new `accountId` after `newSession` succeeds. If activation or relaunch fails, the home can contain new credentials while the session record still says the old account is running.

Recommendation: make swap failure explicit and recoverable: write a `swap_failed`-style status or error field under the lock, emit a failure ledger event, and add a test where `newSession` rejects after credential activation.

### 12. Bulk recovery commands abort on the first per-bee failure

Severity: Medium  
Category: Correctness / Recovery  
Evidence: `src/cli.ts:3391`, `src/cli.ts:4489`

`hive revive --all` and `restore --all` call per-record recovery paths without isolating failures. One missing executable, stale home, or relaunch error can stop the sweep after partial side effects, leaving later bees or workspaces untouched and summary output missing.

Recommendation: collect per-bee/per-workspace failures, continue the sweep, print a structured summary, and return non-zero when any item failed.

### 13. Usage and search paths do unbounded full-file reads

Severity: Medium  
Category: Performance  
Evidence: `src/search.ts:439`, `src/usage.ts:94`, `src/daemon/usageSampler.ts:92`

Search reads complete ledger/rotation files and accumulates all hits before truncating. Usage summaries re-read full append-only usage logs, and the daemon sampler re-reads full transcripts each interval. These paths will get slower and more memory-heavy as long-running Hive installations accumulate history.

Recommendation: stream ledger/search inputs, stop once enough ranked candidates are available where possible, rotate or compact usage logs, and persist incremental sampler cursors or totals.

### 14. Account limit checks fan out without concurrency limits

Severity: Medium  
Category: Performance  
Evidence: `src/limits.ts:121`, `src/limits.ts:504`

`accountLimits` maps every account through `Promise.all`. For Codex accounts this can spawn multiple `codex app-server` child processes, while Claude accounts can issue parallel OAuth profile/usage requests. On a machine with many registered homes, `hive usage` can create avoidable local and provider pressure.

Recommendation: cap concurrent account probes by provider/tool and reuse in-flight account usage checks within a short TTL.

### 15. `src/cli.ts` is now large enough to block safe change

Severity: High  
Category: Clean code  
Evidence: `src/cli.ts:170`, `src/cli.ts:181`, `docs/GOD_FILE_REFACTOR_PRD.md:40`

The CLI file is over 8,200 lines and still mixes dispatch, spawn orchestration, workspace/quest workflows, recovery commands, formatting, parsing helpers, and many command handlers. The existing god-file refactor PRD is stale and omits a large part of the current command surface.

Recommendation: refresh the refactor plan against the current command list, then extract cohesive command groups behind shared command context helpers rather than continuing to grow `cli.ts`.

### 16. Frame spawn cannot bind accounts or resolve account-aware bee tokens

Severity: High  
Category: Correctness  
Evidence: `src/cli.ts:1010`, `src/cli.ts:634`, `src/cli.ts:1030`

`spawnFromFrame` resolves each caste directly through `resolveAgent(caste.bee, ...)` and calls `spawnBee` without the account/model/provider path used by single, homogeneous swarm, flow, and loop spawns. Frame castes such as `claude-auto`, `codex-work`, or account ids can therefore launch as bare kinds or miss account credentials.

Recommendation: make frame caste resolution use the same shared account/profile resolver as other spawn paths, or reject account-aware frame bee specs explicitly until parity exists.

### 17. Search returns raw session, seal, and ledger objects without redaction

Severity: High  
Category: Security / Privacy  
Evidence: `src/search.ts:127`, `src/search.ts:148`, `src/search.ts:175`, `src/search.ts:291`

Search hits preserve raw session records, seal objects, and ledger lines. The indexed session haystack includes command, cwd, last prompt, brief, and notes, so any token, secret, or private prompt text in those fields can be returned verbatim to search consumers.

Recommendation: add a redaction layer for search `raw` payloads and snippets, and add tests for prompts/briefs/commands containing token-like values.

### 18. Session records persist sensitive operational data without classification

Severity: High  
Category: Security / Privacy  
Evidence: `src/store.ts:12`, `src/store.ts:70`, `src/store.ts:132`, `src/store.ts:206`

Session records persist fields such as command, cwd, last prompt, brief, notes, provider session ids, account ids, and transcript paths into the local store. This is useful for orchestration but currently has no explicit sensitivity classification, encryption, or scrub-on-display policy.

Recommendation: classify sensitive fields, redact by default in search/list/export surfaces, and document the local-store trust boundary.

### 19. Flow facade spawn cannot request yolo workers

Severity: Medium  
Category: Correctness / Parity  
Evidence: `src/flow/hive_facade.ts:170`, `src/flow/index.ts:80`, `src/flow/json.ts:25`

The public flow spawn facade hardcodes `yolo: false`, and `FlowSpawnInput` / JSON flow spawn operations have no `yolo` field. The built-in loop flow works around this through a separate path, but user-authored flows cannot request permissionless workers.

Recommendation: add `yolo?: boolean` to flow spawn input and JSON schema, then pipe it through `HiveFacade.spawn` to `spawnBeeForFlow`.

### 20. Keychain bridge passes OAuth credentials via process arguments

Severity: Medium  
Category: Security  
Evidence: `src/keychain.ts:52`, `src/keychain.ts:66`, `src/accounts.ts:427`, `src/accounts.ts:429`

The macOS `security` CLI bridge passes credential material through argv when storing or retrieving generic passwords. On multi-user systems, process arguments can be observable by local tooling during the command lifetime.

Recommendation: prefer stdin-based secret passing where available, or document the local-machine exposure and keep the command lifetime minimal.

## Lower Priority Findings

- `src/seal.ts:208`: same-millisecond seals for one bee can overwrite the earlier seal file. Low severity but worth fixing with a suffix/counter.
- `src/search.ts:382`: search reads seal JSON directly instead of validating through the seal module's normal validation path.
- `src/search.ts:255`: snippet highlighting can mark the first repeated term rather than the actual matched occurrence.
- `src/search.ts:265`: ranking comments describe per-corpus age decay, but the implementation uses absolute epoch arithmetic.
- `src/beesTui.ts:578`: group-mode refresh can regroup/render while a kill-confirm modal is open.
- `src/beesTui.ts:364`: `moveCursor` computes `pos` and immediately overwrites it.
- `src/beesTui.ts:504`: a filter query cannot begin with `q` because it is swallowed as quit when the query is empty.
- `src/swarm.ts:51`: swarm id listing reads and parses every swarm file even though ids are filename-derived.
- `src/completion.ts:18`: `cat` and `tx` exist as CLI aliases but are missing from top-level completions.
- `src/kill.ts:141`: kill ledger attempts are `0` for already-gone sessions, which is only clear if consumers also inspect the outcome fields.
- `docs/HIVE_CLI_REFERENCE.md:1527` and `docs/HIVE_CLI_REFERENCE.md:1651`: loop and flow examples still show id formats that do not match the current generators.
- `src/cli.ts:1030`: frame spawn applies the same trailing args to every caste, which is brittle for mixed-agent frames.
- `tests/frame.test.ts:1`: account-aware frame spawn and `--account --frame` behavior have no coverage.
- `src/reconcile.ts:36`: sync manifest includes ledger/session-index artifacts that can carry local paths and PII.
- `src/seal.ts:16`: seal metadata accepts arbitrary strings and becomes searchable without redaction.
- `src/transcripts.ts:233`: transcript rendering can export provider rows verbatim, including secret-bearing payloads.
- `src/config.ts:122`: config loader silently drops unknown or misspelled fields.
- `src/config.ts:57`: `briefFooter` function name shadows `DEFAULT_BRIEF_FOOTER`.
- `src/cli.ts:421`: `--count` validation accepts `>= 1`, but the error says `>= 2`.
- `src/cli.ts:7576`: `codex-auto` yolo special case can outrank a thin-profile `yolo: false` override.
- `src/cli.ts:2698`: `hive here --json` output diverges from the documented fields.
- `docs/HIVE_CLI_REFERENCE.md:1788`: `hive account add` docs omit supported `--provider` and `--model`.
- `src/completion.ts:296`: account completions omit account labels and shorthand label aliases.
- `src/beesTui.ts:554`: TUI message truncation is not ANSI/multibyte aware.
- `src/cli.ts:167`: CLI version is hardcoded instead of derived from `package.json`.
- `src/cli.ts:1876`: `pro.kind as ProSlotKind` relies on a slot/kind invariant not represented in the type.
- `src/beesTui.ts:661`: pro slot names are captured and searchable but not rendered, so two same-title bees in different slots can still look identical.
- `src/keybindings.ts:57` and `src/cli.ts:6317`: loop launcher help still points at old `M-L` while current bindings use `M-l`.
- `src/loop/state.ts:122`: `generateLoopId` docs overstate the no-prefix ambiguity guarantee relative to the implementation.
- `docs/README.md:13`: `cursor` is a supported preset/completion entry but absent from the documented bee list.

## Suggested Fix Order

1. Fix flow/loop spawn resolver parity for thin profile overlays.
2. Fix loop readiness timeouts to use the resolved agent.
3. Make loop id allocation atomic.
4. Fix package publication so installed bins cannot point at missing `dist` files.
5. Make `swapAccount`, `revive --all`, and `restore --all` failure handling resumable.
6. Add backpressure and streaming to usage/search hot paths.
7. Fix frame spawn account/profile parity.
8. Add redaction for search/session/seal/transcript outputs.
9. Restore or correct shipped tmux keybinding docs.
10. Fix ledger `--bee` filtering.
11. Add focused tests around account-bound flow/frame spawns and `<tool>-auto` resolution.
