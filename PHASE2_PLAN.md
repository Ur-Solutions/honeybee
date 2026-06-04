# Honeybee v2 — Phase 2 Plan

**Status: COMPLETE.** All 14 patches landed. Test suite at 387 (385 pass, 2
skipped behind `SSH_LOCALHOST_AVAILABLE`). `npm run check` and `npm run build`
clean. See `PHASE2_TEST_CHECKLIST.md` for the end-to-end dogfood walkthrough.

## Final patch ledger

| # | Status | Name |
|---|--------|------|
|  1 | shipped | Shared foundations — `atomicWriteFile`/`storeRoot`, `ledgerPath`/`sealsRoot` exports, `tsLoader`, long-held PID lock, parser BOOLEAN_FLAGS additions |
|  2 | shipped | Substrate interface + LocalTmuxSubstrate (tmux.ts is now a shim); `tail.ts`, `wait.ts`, `readiness.ts` routed via substrate |
|  3 | shipped | Node registry + SshTmuxSubstrate + `hive node` + `hive substrate list`; NodeRecord carries `capabilities`/`status`/`lastSeen`; live ssh test gated by `SSH_LOCALHOST_AVAILABLE` |
|  4 | shipped | BeeState `node_unreachable`; multi-node `hive list/ps` aggregator with `--node` filter + `--wide`; remote `hive attach --print`; spawnBee refactored to a pure function (folded forward) |
|  5 | shipped | Transactional kill via substrate (`cmdKill`, `cleanupRunSession`, `swarmDestroy`); `kill_failed` persists with `lastError` for remote bees |
|  6 | shipped | Daemon core: pure `tick(deps, prev)` + `runDaemon` + PID file + `state.json` + log rotation; per-session `withFileLock` around touchSession/saveSession |
|  7 | shipped | Daemon installation: plist generator, `install|uninstall|start|stop|restart|status|logs|run` subcommands; Linux prints a systemd snippet (no auto-install) |
|  8 | shipped | Buz module: `~/.hive/buz/<bee>/{inbox,outbox,queue,read,quarantine}/`; three-tier with default `buzAccept = ['queue','passive']`; strict `--sender` / `--sender-human`; `hive buz <send|inbox|outbox|queue|read|purge|config>` |
|  9 | shipped | Buz daemon dispatcher: tier-B queue drain on any transition into `idle_with_output`; quarantine after 3 substrate failures |
| 10 | shipped | Flow registry + JSON parser/compiler + TS SDK barrel (`defineFlow`) |
| 11 | shipped | Flow runtime: HiveFacade, `executeFlow`, run dirs under `~/.hive/flows/<name>/runs/<runId>/`, foreground SIGINT handler |
| 12 | shipped | Flow background runs: detached fork, cancel-by-pgid, hidden `__flow-exec` entrypoint |
| 13 | shipped | Search engine over seals + rotated ledger + session records; `hive search` + `hive seals find`; per-command FLAG_VALUE_KINDS scoping |
| 14 | shipped | This patch — help screen finalization, `PHASE2_TEST_CHECKLIST.md`, README Phase 2 section, `HONEYBEE_V2_SPEC.md` bus→buz rename, Phase 3 candidates ledger |

## Phase 3 candidates (deferred work)

These were either explicitly out of scope for Phase 2 or surfaced by the critic
and not folded in. Capturing them here keeps later phases from renumbering
ledger event keys or rediscovering closed decisions.

- **Level 2 resumability** — checkpointed flow steps. The forward-compatible
  reservation is already in place: `~/.hive/flows/<name>/runs/<runId>/checkpoints/`
  is a reserved directory name; Phase 2 code does not write into it.
- **Transcript search** — Phase 2 explicitly excludes transcripts from the
  search corpus. Adding them requires a stable transcript-fragment shape and a
  per-provider redaction story.
- **Docker / Modal / Kubernetes substrates** — the Substrate interface is
  already abstracted enough to add these without touching `wait.ts`,
  `readiness.ts`, or `tail.ts`. Each needs its own `probe()` + `attachCommand()`
  + load-buffer transport.
- **Fork / replay** (`hive fork <bee> --at msg:N`) — depends on stable
  transcript export per spec §13.
- **Sparse notifications** — the daemon dispatcher seam is the natural host.
  Reserved ledger event keys for the future notifier (so v3 doesn't churn them):
  - `notify.sealed` — bee transitioned into `sealed`
  - `notify.blocked` — bee transitioned into `blocked`
  - `notify.needs_input` — bee asked for input (provider-specific detection)
  - `notify.flow_completed` — `flow.end` with `status: 'ok' | 'failed'`
  - `notify.substrate_offline` — node transitioned into `node_unreachable`
  Phase 2 emits the underlying transitions (`session.save`, `flow.end`,
  `buz.queue.drain`, etc.); a Phase 3 notifier subscribes and dispatches to
  whatever sink the user configures.
- **Manager bees** (spec §14) — recursive permission boundaries; out of scope
  until the buz + flow + seal triangle is exercised under load.
- **`hive ps --watch`** — the daemon already writes `lastObservedState` /
  `lastObservedStateAt` on every tick, so `--watch` is a cheap consumer.
  Deferred only because UX polish (terminal redraw + diff highlighting) wasn't
  worth blocking Phase 2 on.
- **`hive artifacts list`** (spec §12) — sibling to `hive search`. Either ships
  as a fourth search corpus or as a dedicated noun. Deferred because Phase 2
  search already covers the seals → ledger → sessions triangle.
- **Search pagination** — current `--limit N` (default 30; `--limit 0` for
  unlimited). Programmatic consumers will eventually want `--offset` or a
  cursor; ship when an actual user hits the ceiling.

## Locked decisions (supersedes open questions below)

1. **Naming — `buz` everywhere.** Code, command, storage layout, and spec all use `buz`. Storage: `~/.hive/buz/<bee>/{inbox,outbox,queue,read,quarantine}/`. Patch #14 updates HONEYBEE_V2_SPEC.md §10/§19 to say `buz`.
2. **Buz sender attribution — strict.** `--sender` must resolve to a registered bee id. Humans use `--sender-human "name"`, which routes the message into `_external/` so audit trails distinguish bee-from-bee from human-from-bee traffic.
3. **Background flow runs — independent process trees.** Forked detached children (`detached:true`, `child.unref()`), stored under `~/.hive/flows/<name>/runs/<runId>/`. `hive flow runs` inventories by scanning. Cancel via SIGTERM to pgid. Daemon stays a dispatcher (buz tier-B + future notifications).
4. **Implicit `local` node.** `hive node list` synthesizes a virtual `local` (kind=`local-tmux`, endpoint=`localhost`) when none is registered. Fresh installs Just Work; explicit `hive node register local` is optional.
5. **Flow cleanup — keep alive by default.** Failed/cancelled flows leave their bees inspectable in tmux. Flows opt into teardown via flow-level `cleanup: 'kill-on-end'` field or `ctx.hive.killAll()` call.

---

## Historical planning notes (pre-implementation)

Produced by the `phase2-plan` workflow (5 parallel module designs, adversarial verify, synthesis, completeness critique). 12 agents, ~845k tokens.

**Critic verdict at planning time: `has-gaps`** — see Gaps section below; required additions folded into the patch queue before implementation started. All gaps were either resolved during implementation or moved into Phase 3 candidates above.

## Folded amendments (from critic; supersede the patch queue below where conflicting)

Before patch #1 starts:

- **#2 add `tail.ts`** to modifiedFiles so `hive tail <remote-bee>` routes through the substrate.
- **#3 NodeRecord** gains `capabilities: string[]`, `status: 'online'|'offline'|'unknown'`, `lastSeen?: string`. Wire `hive spawn --node mini01` to fail early on capability mismatch (e.g. node lacks `codex`). Add capability-mismatch test.
- **#3 live ssh test** gated by `SSH_LOCALHOST_AVAILABLE=1`. Skips on CI by default but exercises real `ssh localhost tmux …` when set, keeping the "ssh-tmux supported" claim honest.
- **#4 move spawnBee refactor here** (was queued for #11). Patches #5, #8, and #11 then build on the stable pure-function signature.
- **#4 multi-node `hive list`**: TSV stays backwards-compatible (Phase 1 contract). New `node` column is added in pretty mode only, and only shown when more than one node is registered. `--wide` flag forces the column.
- **#6 substrate cache lifecycle**: one substrate instance per node, evicted on N consecutive failures, reset on `hive node update/unregister`. Specified in src/substrates/index.ts.
- **#6 per-session `withFileLock`** around daemon `touchSession` and CLI `saveSession` for the same record. Prevents torn writes between daemon ticks and CLI ops.
- **#8 default `buzAccept`** when the field is absent on a SessionRecord: `['queue', 'passive']` (interrupts require opt-in). Closes the undefined-policy spoof/DoS vector. Stated in patch #8 + documented in help.
- **#11 pin flow run layout**: `~/.hive/flows/<name>/runs/<runId>/{meta.json,log.txt,result.json}`. `hive flow runs` lists across flow names.
- **#8 + #14 buz GC story**: `hive buz purge <selector> [--read|--older-than 30d]` lands in #8; retention guidance documented in #14.

## Summary

Honeybee v2 Phase 2 delivers five integrated modules: (1) a Substrate abstraction that refactors local tmux behind a typed interface and adds an ssh-tmux substrate with a node registry, making `hive` a multi-node control plane; (2) a general launchctl-managed daemon (`hive daemon ...`) that ticks every ~2s, derives state, detects active->idle_with_output transitions, and runs dispatchers; (3) a `buz` three-tier addressed messaging system (interrupt/queue/passive) with per-bee acceptance policy, file-backed under ~/.hive/bus/, where the daemon is the tier-B drainer; (4) a `flow` orchestration layer with TS SDK (`defineFlow`) and JSON authoring, foreground+background runs, `hive flow run|runs|logs|status|cancel`, exposing a substrate-neutral HiveFacade with buz primitives; (5) `hive search <query>` (and `hive seals find`) over seals + rotated ledger + session records, with substring/regex modes and filter flags. Cross-cutting work: SessionRecord gains node/runId/flowName/buzAccept/lastObservedState fields; BeeState gains `node_unreachable`; new noun commands (node, daemon, buz, flow, search, seals) flow through cli.ts dispatcher, printHelp, and completion.ts; shared utilities (atomicWriteFile, ledgerPath/sealsRoot exports, tsLoader, substrate-neutral Substrate type, longheld PID lock) are extracted. Transcripts remain excluded from search; Level 2 resumability and remote-fs reads are out of scope.

**Estimated total LoC:** ~10100

## Patch queue

Execution order (foundation first):

| # | Size | LoC | Depends | Name |
|---|------|-----|---------|------|
| 1 | M | ~350 | — | Shared foundations: atomicWriteFile, ledgerPath/sealsRoot exports, tsLoader extraction, long-held PID lock primitive, parse.ts BOOLEAN_FLAGS additions |
| 2 | L | ~700 | 1 | Substrate interface + LocalTmuxSubstrate refactor (tmux.ts becomes shim) |
| 3 | L | ~950 | 2 | Node registry + SshTmuxSubstrate + cli `hive node` + cli `hive substrate list` |
| 4 | L | ~600 | 3 | BeeState: node_unreachable + multi-node `hive list/ps` aggregator + --node spawn/run flag + remote attach |
| 5 | M | ~250 | 4 | Transactional kill via substrate (cmdKill, cleanupRunSession, swarmDestroy) + kill_failed persistence for remote bees |
| 6 | L | ~900 | 1,2,4 | Daemon core: pure tick() + runDaemon + PID file + state.json + log rotation |
| 7 | L | ~700 | 6 | Daemon installation: plist generator, install/uninstall/start/stop/restart/status/logs/run subcommands |
| 8 | XL | ~1500 | 2,3 | Buz module: storage layout, types, message YAML, send/inbox/outbox/queue/read/policy, CLI `hive buz` |
| 9 | M | ~350 | 6,8 | Buz daemon dispatcher: tier-B queue drain on active->idle_with_output transition |
| 10 | L | ~800 | 1 | Flow registry + JSON parser/compiler + TS SDK barrel (defineFlow) |
| 11 | XL | ~1400 | 2,5,8,10 | Flow runtime: HiveFacade, executeFlow, run dirs, run inventory, foreground SIGINT handler |
| 12 | M | ~400 | 11 | Flow background runs: detached fork, cancel-by-pgid, __flow-exec hidden command |
| 13 | L | ~900 | 1,4 | Search module: pure search engine + rotated-ledger enumeration + per-command completion scoping |
| 14 | M | ~300 | 3,4,7,8,11,12,13 | Help screen, PHASE2_TEST_CHECKLIST, README/PRD updates for all new commands |

### Per-patch detail

#### Patch 1 — Shared foundations: atomicWriteFile, ledgerPath/sealsRoot exports, tsLoader extraction, long-held PID lock primitive, parse.ts BOOLEAN_FLAGS additions
- **Size:** M (~350 LoC)
- **Depends on:** none
- **New files:** src/fsx.ts, src/tsLoader.ts, tests/fsx.test.ts, tests/lock.longheld.test.ts
- **Modified files:** src/store.ts, src/seal.ts, src/colony.ts, src/swarm.ts, src/frame.ts, src/ids.ts, src/lock.ts, src/parse.ts
- **Rationale:** Every downstream module (substrate, daemon, buz, flow, search) needs atomic writes, canonical store paths, TS dynamic-import, a long-held PID lock different from the existing 60s-mtime-stale heuristic, and new boolean flags (--regex, --case, --foreground, --background, --follow). Extracting these first removes duplication and avoids surprise refactors mid-phase. Exports ledgerPath() and sealsRoot() so search.ts and daemon can reach them.
- **Tests:** fsx atomic write durability and same-fs guarantees; lock long-held mode: refresh mtime on heartbeat, preserves liveness past 60s, releases on process exit

#### Patch 2 — Substrate interface + LocalTmuxSubstrate refactor (tmux.ts becomes shim)
- **Size:** L (~700 LoC)
- **Depends on:** #1
- **New files:** src/substrates/types.ts, src/substrates/index.ts, src/substrates/local-tmux.ts, tests/substrates/local-tmux.parity.test.ts
- **Modified files:** src/tmux.ts, src/wait.ts, src/readiness.ts
- **Rationale:** Establishes the Substrate interface (kind/node/endpoint, probe, spawn, kill, hasSession, capture, sendText, sendEnter, sendKey, listSessions, attachCommand, attachSession, isLive). Refactors src/tmux.ts into LocalTmuxSubstrate while keeping src/tmux.ts as a re-export shim so existing imports work unchanged. Updates wait.ts and readiness.ts (which today import capture/sendEnter/sendKey directly from tmux.ts) to accept a Substrate or resolve via substrateForRecord — this is mandatory because Phase 2 ships ssh-tmux. Also adds buildLocalSubstrate() helper for buz/flow consumers. Real-tmux parity test under TMUX_TMPDIR.
- **Tests:** Real-tmux parity: spawn -> hasSession -> sendText -> capture -> kill round-trip in isolated TMUX_TMPDIR; wait.ts and readiness.ts route through substrate (mocked) for a remote-flagged record

#### Patch 3 — Node registry + SshTmuxSubstrate + cli `hive node` + cli `hive substrate list`
- **Size:** L (~950 LoC)
- **Depends on:** #2
- **New files:** src/node.ts, src/substrates/ssh-tmux.ts, tests/substrates/ssh-tmux.mock.test.ts, tests/node.crud.test.ts, tests/cli.node.test.ts, tests/cli.substrate.test.ts
- **Modified files:** src/cli.ts, src/completion.ts, src/store.ts
- **Rationale:** Adds NodeRecord CRUD under ~/.hive/nodes/<name>.json (atomic, ledger events node.register/update/unregister), implicit local node synth. SshTmuxSubstrate wraps `ssh <endpoint> tmux ...` using load-buffer over stdin (avoid argv ARG_MAX). Reserved node name 'local'. cli exposes `hive node list|register|inspect|unregister` and the trivial `hive substrate list` (closes spec §15 gap). completion.ts adds nodes, node-subcommands, --node flag value, --substrate alias parser. SessionRecord gains optional node?: string (additive, undefined ↔ 'local').
- **Tests:** Exact ssh argv for spawn/kill/hasSession/capture/sendText/listSessions; load-buffer over stdin for long payloads; probe() cache TTL; exit 255 surfaces unreachable; custom sshCommand/sshArgs honored; Node CRUD validates names, rejects literal 'local' for ssh kind

#### Patch 4 — BeeState: node_unreachable + multi-node `hive list/ps` aggregator + --node spawn/run flag + remote attach
- **Size:** L (~600 LoC)
- **Depends on:** #3
- **New files:** tests/state.node_unreachable.test.ts, tests/cli.list.multinode.test.ts, tests/cli.attach.remote.test.ts
- **Modified files:** src/state.ts, src/cli.ts, src/format.ts, src/completion.ts
- **Rationale:** Adds `node_unreachable` to BeeState union (non-terminal), StateContext.unreachableNodes?: Set<string>, precedence kill_failed > node_unreachable > sealed > dead. Updates formatStateCell exhaustively. cli.cmdList does Promise.allSettled across nodes with per-node timeout (HIVE_NODE_PROBE_MS, default probe 1.5s parallel with list 3s). cli.cmdSpawn/cmdRun honor --node; spawnBee dispatches via substrateForRecord; cmdAttach for remote yields `ssh <endpoint> -t tmux attach-session -t <target>`. Adds `hive list --node <name>` filter. Adds --substrate parser as alias of --node (supports `ssh:mini01` shorthand). node field propagated into session.save/prompt.send/session.delete ledger payloads.
- **Tests:** deriveState precedence with unreachableNodes; list aggregator: parallel nodes, one unreachable doesn't block another beyond timeout; --print attach yields exact ssh -t string; non-print dispatches substrate.attachSession

#### Patch 5 — Transactional kill via substrate (cmdKill, cleanupRunSession, swarmDestroy) + kill_failed persistence for remote bees
- **Size:** M (~250 LoC)
- **Depends on:** #4
- **New files:** tests/cli.kill.transactional.test.ts
- **Modified files:** src/cli.ts, src/store.ts
- **Rationale:** Spec §17 debt is best paid while substrate seam is fresh: substrate.kill -> poll substrate.hasSession briefly -> only then deleteSession. On failure, saveSession with status='kill_failed' + lastError. Mirrors in cleanupRunSession and swarmDestroy. Catches the gap noted in the substrate review.
- **Tests:** Successful kill removes session record only after !hasSession; Substrate kill failure persists kill_failed + lastError; next attempt resolves

#### Patch 6 — Daemon core: pure tick() + runDaemon + PID file + state.json + log rotation
- **Size:** L (~900 LoC)
- **Depends on:** #1, #2, #4
- **New files:** src/daemon/index.ts, src/daemon/run.ts, src/daemon/log.ts, src/daemon/dispatch.ts, tests/daemon-tick.test.ts, tests/daemon-status.test.ts
- **Modified files:** src/state.ts, src/store.ts, src/seal.ts
- **Rationale:** Pure dependency-injected tick(deps, prev) for testability; outer runDaemon owns timer/signals/PID lock/log writes. TickDeps takes substrate-routable capturePane (not raw tmux target) so the daemon is multi-node ready. enteredIdleWithOutput predicate generalised (any prev !== idle_with_output && next === idle_with_output). Exports touchSession() on store.ts: atomic update WITHOUT ledger emission for lastObservedState/lastObservedStateAt fields (avoids per-tick ledger spam). seal.ts: rename or alias to sealedBeeNames consistently. Dispatcher registry seam (no dispatchers wired yet — buz dispatcher lands in patch 9).
- **Tests:** tick: no-op on empty sessions; detects active->idle and ready->idle_with_output; dispatcher exception isolation; deps.now determinism; Status round-trip; runDaemon refuses second invocation when PID file is held

#### Patch 7 — Daemon installation: plist generator, install/uninstall/start/stop/restart/status/logs/run subcommands
- **Size:** L (~700 LoC)
- **Depends on:** #6
- **New files:** src/daemon/plist.ts, tests/daemon-plist.test.ts, tests/daemon-install.test.ts
- **Modified files:** src/cli.ts, src/completion.ts, package.json
- **Rationale:** renderPlist (golden-file test) + renderSystemdUnit (documentation only). install/uninstall idempotent, uses `launchctl bootstrap/bootout gui/$UID`. Plist embeds process.argv[1] realpath at install time; refuses if dist/cli.js missing (suggests `npm run build`). hive daemon run --foreground is the launchctl ProgramArguments target. cli wires cmdDaemon with subcommands including logs (tail/follow) and status (--json schema documented, exit codes 0/3/4). Adds `hive ps` banner when daemon is down. Non-Darwin: install prints recovery for systemd snippet, no auto-install. Explicitly mechanical (no autonomous policy decisions).
- **Tests:** Plist golden fixture; refuses non-absolute paths; install/uninstall idempotency with shimmed launchctl on PATH; status JSON shape stable across runs

#### Patch 8 — Buz module: storage layout, types, message YAML, send/inbox/outbox/queue/read/policy, CLI `hive buz`
- **Size:** XL (~1500 LoC)
- **Depends on:** #2, #3
- **New files:** src/buz-types.ts, src/buz.ts, tests/buz.test.ts, tests/buz-cli.test.ts
- **Modified files:** src/store.ts, src/cli.ts, src/completion.ts, src/state.ts
- **Rationale:** Resolves the naming and clarifies bus->buz in HONEYBEE_V2_SPEC.md (spec edit included). Storage under ~/.hive/bus/<bee>/{inbox,outbox,queue,read,quarantine}/. Three tiers: interrupt/queue/passive with per-bee buzAccept policy. sendMessage/sendCohort take a required BuzTransportContext for tier=interrupt (substrate-neutral; built from buildLocalSubstrate for local bees, ssh-tmux substrate for remote). Long bodies use substrate load-buffer-over-stdin path. Spoof-resistant --sender (separate flag — avoids the --from collision with `hive seal --from <file>`). cli adds send|inbox|read|outbox|queue|purge|cancel|accept subcommands. completion.ts adds per-command FLAG_VALUE_KINDS scoping (refactor) so --tier completion only fires for buz. Cohort fan-out: bounded concurrency 8, per-recipient timeout 5s (HIVE_BUZ_INTERRUPT_TIMEOUT_MS). Cohort ledger events batched (buz.cohort.send {to[],ids[],byTier}).
- **Tests:** Tier dispatch + policy downgrade chain; interrupt without transport context errors; Cohort: one substrate failure doesn't abort broadcast; concurrency limit and timeout honored; YAML frontmatter roundtrip incl. CRLF and body-with-fence; Per-command FLAG_VALUE_KINDS does not pollute other commands

#### Patch 9 — Buz daemon dispatcher: tier-B queue drain on active->idle_with_output transition
- **Size:** M (~350 LoC)
- **Depends on:** #6, #8
- **New files:** tests/daemon-buz-dispatch.test.ts
- **Modified files:** src/daemon/dispatch.ts, src/buz.ts
- **Rationale:** Wires the only Phase 2 dispatcher: buzQueueDispatcher matches state transitions into idle_with_output and calls buz.processQueueForBee(record, transportContext). Drain protocol: under per-bee lock, rewrite YAML to set deliveredAt, then atomic rename queue/<file> -> inbox/<file> preserving filename. Quarantine after 3 substrate failures. Emits buz.queue.drain ledger event with ids[]. Daemon writes heartbeat.json at known path (exported constants from src/daemon/index.ts that buz.ts imports — single source of truth).
- **Tests:** Drains queue/ in mtime order on transition; idempotent on retry; Quarantine after N failures; subsequent messages still drain

#### Patch 10 — Flow registry + JSON parser/compiler + TS SDK barrel (defineFlow)
- **Size:** L (~800 LoC)
- **Depends on:** #1
- **New files:** src/flow/index.ts, src/flow/json.ts, src/hive.ts, tests/flow/registry.test.ts, tests/flow/json.test.ts
- **Modified files:** package.json
- **Rationale:** Storage under ~/.hive/flows/<name>.{json,ts} + <name>.source provenance (mirrors frame.ts; reuses src/tsLoader.ts from patch 1). JSON compiles to a Flow with sequential ops (spawn/send/brief/waitForSeal/wait/kill/seal/log/return). {{var}} substitution supports dot-paths into BeeHandle (.id/.name/.agent/.cwd) and arg refs. Reject parallel/loops/sub-flows in JSON. src/hive.ts is the published SDK barrel exporting defineFlow + types. package.json exports condition for dist/hive.js. No runtime work yet — pure data + compiler.
- **Tests:** registry: TS + JSON load, source provenance, helpful error when run outside tsx; JSON: parse rejects unknown ops; substitute resolves dotted paths; seal artifact pass-through documented

#### Patch 11 — Flow runtime: HiveFacade, executeFlow, run dirs, run inventory, foreground SIGINT handler
- **Size:** XL (~1400 LoC)
- **Depends on:** #2, #5, #8, #10
- **New files:** src/flow/sdk.ts, src/flow/run.ts, src/flow/runs.ts, tests/flow/run.test.ts
- **Modified files:** src/cli.ts, src/store.ts
- **Rationale:** HiveFacade exposes spawn/send/brief/wait/waitForSeal/kill/seal/collect/log AND buz primitives (buzSend, buzInbox, buzAwait — using patch 8). BeeHandle is substrate-neutral ({id, name, agent, cwd}); control routes through substrateForRecord(record) — no leaked tmuxTarget. spawn defaults to implicit swarmId `flow:<name>:run:<runId>` so cohort is addressable. ctx.signal AbortSignal threaded everywhere. Foreground SIGINT handler aborts and writes meta status=cancelled. runId format: `<ts>-<8hex>`. listRuns scans newest-first; orphaned status when pid is dead. cli registers cmdFlow with define|list|inspect|remove|run|runs|logs|status|cancel. SessionRecord gains runId?/flowName? fields. spawnBee refactored to a pure function returning SessionRecord without printing (printing wrapped by cli callers). Ledger uses session.save (with runId/flowName) — no redundant flow.spawn-bee event. tailRunLog uses poll-based reader (NOT fs.watch).
- **Tests:** Foreground run meta transitions; failure surfaces stack to result.json; SIGINT in foreground aborts wait and persists cancelled status; Mocked HiveFacade: JSON flow runs end-to-end; bindings resolved; BeeHandle has no tmuxTarget; remote-substrate spawn still works

#### Patch 12 — Flow background runs: detached fork, cancel-by-pgid, __flow-exec hidden command
- **Size:** M (~400 LoC)
- **Depends on:** #11
- **New files:** src/flow/background.ts, tests/flow/background.test.ts
- **Modified files:** src/cli.ts, src/completion.ts
- **Rationale:** spawnDetachedRun re-execs process.execPath with [hiveEntryPath(), '__flow-exec', runId], detached:true + stdio piped to log fd + child.unref(). cancelRun sends SIGTERM to -pgid then SIGKILL after graceMs (default 3000). __flow-exec is excluded from completion COMMANDS. Windows: --background prints clear unsupported error. Background runs are independent process trees (daemon does not own them — design decision recorded here).
- **Tests:** Detached child survives parent exit; cancel signals pgid; log.txt receives output

#### Patch 13 — Search module: pure search engine + rotated-ledger enumeration + per-command completion scoping
- **Size:** L (~900 LoC)
- **Depends on:** #1, #4
- **New files:** src/search.ts, tests/search.test.ts
- **Modified files:** src/cli.ts, src/completion.ts, src/store.ts, src/seal.ts
- **Rationale:** Three corpora: seals, ledger (enumerates ledger.jsonl + ledger.jsonl.* rotated files), session records — transcripts excluded per locked decision. Default --limit 30; --limit 0 unlimited. Substring (default, case-insensitive unless --case) or --regex (pattern length <= 256). makeSnippet returns {snippet, matchStartInSnippet, matchEndInSnippet} so pretty highlighting is deterministic. cli registers cmdSearch and adds cmdSeals dispatcher (new noun parallel to existing `seal` singular verb) routing 'find'. completion FLAG_VALUE_KINDS refactor (already landed in patch 8) is reused: --type/--status scoped to search only. `seals find` rejects --type with friendly error. Orphan-filtered hit count surfaced in stderr (pretty) or notes.orphanFiltered (json). Multi-token query treated as a single phrase.
- **Tests:** Rotated ledger files all scanned in order; Snippet offsets allow correct ANSI highlight without re-matching; Filter validation: unknown colony/swarm errors clearly; --bee accepts only kind=bee selectors

#### Patch 14 — Help screen, PHASE2_TEST_CHECKLIST, README/PRD updates for all new commands
- **Size:** M (~300 LoC)
- **Depends on:** #3, #4, #7, #8, #11, #12, #13
- **New files:** PHASE2_TEST_CHECKLIST.md
- **Modified files:** src/cli.ts, README.md, PRD.md, HONEYBEE_V2_SPEC.md
- **Rationale:** Centralises printHelp() rows for all new commands (node, substrate, daemon, buz, flow, search, seals) including their key flags (--node, --background, --arg, --tier, --sender, --type, --since, --status). Updates HONEYBEE_V2_SPEC.md §10/§19 to reconcile 'bus' -> 'buz' nomenclature decided during patch 8. Adds Phase 2 manual test checklist (multi-node spawn/list/attach, daemon install/uninstall/status, buz delivery across tiers, flow foreground/background/cancel, search ranking).

## Cross-cutting changes

### sessionrecord
- + node?: string (undefined ↔ 'local') — patch 3
- + runId?: string — patch 11
- + flowName?: string — patch 11
- + buzAccept?: ('interrupt'|'queue'|'passive')[] — patch 8
- + lastObservedState?: string — patch 6
- + lastObservedStateAt?: string — patch 6
- All additive, normalizeSessionRecord allowlist extended in each patch; no migration required.

### state
- BeeState += 'node_unreachable' (transient, non-terminal) — patch 4
- StateContext += unreachableNodes?: Set<string> — patch 4
- stateLabel/isTerminalState/formatStateCell exhaustively handle node_unreachable — patch 4
- Export enteredIdleWithOutput(prev,next) predicate generalized (any prev !== idle_with_output && next === idle_with_output) — patch 6

### store
- Export ledgerPath() and sealsRoot() — patch 1
- Add touchSession()/updateSessionFields() that writes record atomically WITHOUT appending a ledger entry (daemon uses for lastObservedState) — patch 6
- Refactor private atomicWriteFile into src/fsx.ts; all modules import from there — patch 1
- spawnBee refactor: pure function returning SessionRecord, no printing — patch 11 (used by flow/sdk.ts)

### cli
- New noun dispatchers in main switch (cli.ts): node (patch 3), substrate (patch 3), daemon (patch 7), buz (patch 8), flow (patch 11), search (patch 13), seals (patch 13)
- Hidden __flow-exec command (patch 12)
- --node flag wired through cmdSpawn/cmdRun (patch 4)
- --substrate <kind>[:<node>] parser as alias of --node (patch 4)
- Transactional kill (substrate.kill -> hasSession poll -> deleteSession; kill_failed persistence) in cmdKill/cleanupRunSession/swarmDestroy (patch 5)
- cmdList multi-node aggregator with Promise.allSettled + per-node timeout (patch 4)
- cmdAttach: ssh -t for remote (--print and interactive) (patch 4)
- spawnBee extracted as pure function (patch 11)

### completion
- Per-command FLAG_VALUE_KINDS refactor: scope kinds to (command, flag) pairs — landed in patch 8, reused by patch 13
- Added to COMMANDS: node, substrate, daemon, buz, flow, search, seals
- Excluded from COMMANDS: __flow-exec (patch 12)
- NOUN_COMMAND_SUBS additions: node, substrate, daemon, buz, flow, seals
- FLAGS_BY_COMMAND entries for each new noun and their subcommands
- FLAG_VALUE_KINDS additions: 'node', 'buz-tier', 'searchType', 'sealStatus', 'flow', 'run'
- CompletionState carries nodes?, flows?, runs? (loaded via Promise.allSettled in getCompletions)

### help
- printHelp() command table rows for: node, substrate, daemon (with sub-commands), buz, flow (with --background/--arg), search, seals find — centralized in patch 14 but each module patch appends its own rows incrementally to avoid merge conflicts.
- Inline usage examples block in printHelp gains a Phase 2 section.

## Risks

- Substrate seam touches every CLI call site that uses tmux: spawn, send, brief, list, attach, kill, run, wait, readiness. Patch 2 must land the wait.ts/readiness.ts substrate refactor or remote spawn is broken end-to-end (spec issue caught by reviewer). Schedule patch 2 for a quiet window — high blast radius even though backwards-compatible via tmux.ts shim.
- SSH ControlMaster is off by default in Phase 2 — `hive list` across many remote nodes will be slow. Mitigation: per-node timeout (~1.5s probe + 3s list parallel) and HIVE_NODE_PROBE_MS env knob. Document that opting into ControlMaster via NodeRecord.sshArgs is recommended for production multi-node use.
- Daemon auto-install (launchctl LaunchAgent) flirts with the spec's anti-goal 'no hidden autonomous background work'. Mitigation: daemon README and install banner explicitly state it is mechanical (no policy/autonomy), policy lives in on-disk records. README/PRD updates in patch 14 must include this messaging.
- Ledger pressure: cohort buz sends on a 100-bee colony could write 100 ledger events; daemon ticks could write per-session updates. Mitigation: batched buz.cohort.send event; touchSession() bypasses ledger for tick observation. Re-validate against existing 10MB rotation behavior under load.
- Background flow runs are independent process trees (not daemon-owned). If the daemon ever needs to inventory or cancel them, a follow-up phase is required. Document this explicitly in patch 14.
- Naming change bus->buz must be applied in HONEYBEE_V2_SPEC.md in lock-step with patch 8. Two-doc divergence is a real risk; patch 14 includes the spec update and should land before public review.
- Argv ARG_MAX on ssh-tmux sendText: long briefs over SSH must use `tmux load-buffer -b <buf> -` with stdin streaming, NOT argv. Patch 3 implements this — adding a regression test for >100KB payloads is recommended.
- TS SDK distribution: flows authored in TS need to `import { defineFlow } from 'honeybee'`. Until the package is published, `npm link honeybee` is the documented dev path. Patch 10 must surface a clear error from tsLoader when the import fails so users discover the link path quickly.

## Open questions requiring user decision

**Implementation is blocked on these until you decide.**

1. Naming reconciliation: confirm 'buz' (per locked decisions) over 'bus' (per current HONEYBEE_V2_SPEC.md §10/§19). Patch 8 + patch 14 will update the spec, but please confirm the directory layout is ~/.hive/buz/<bee>/{inbox,outbox,queue,read,quarantine}/ (NOT ~/.hive/bus/<bee>/{inbox,outbox}/).

2. Sender attribution model for buz: should --sender accept (a) any non-empty string (humans can spoof), (b) require a bee id with a separate --sender-human for humans (anti-spoof), or (c) implicit caller — only the running shell user? The synthesis recommends option (b) (--sender for bees, --sender-human for humans, writes to _external/) to close the audit hole. Confirm.

3. Daemon ownership of flow background runs: synthesis treats background flow runs as independent process trees (daemon does NOT manage them, `hive flow runs` is the inventory). Spec-implied alternative: daemon hosts background runs via an RPC. Confirm independent-process model — daemon stays the dispatcher for buz/state-derived work only.

4. ssh-tmux node implicit local registration: should `hive node list` synthesize a 'local' node when none is registered (current synthesis design), or require explicit `hive node register local --kind local-tmux` for symmetry? Synthesis recommends implicit-local. Confirm.

5. Flow cleanup default on failure/cancel: leave spawned bees alive (matches `hive run --keep` default and respects user authority), or kill them? Synthesis recommends keep-alive default with a flow-level `cleanup: 'kill-on-end' | 'keep'` opt and ctx.hive.killAll() convenience. Confirm.

## Completeness critique findings

### Gaps (12)
- NodeRecord.capabilities is missing. Spec §15 explicitly shows {node, kind, endpoint, capabilities: ['claude','codex','node','python'], status} as the resource model, and `hive spawn codex --substrate ssh:mini01` implies capability gating ('does mini01 have codex installed?'). Patch 3 defines NodeRecord with name/kind/endpoint but no capabilities or status fields, and no capability-mismatch error path. Either ship capabilities now or explicitly defer in patch 3/14.
- Node status / heartbeat persistence is unspecified. Spec §15 says 'remote substrates report heartbeats'. Synthesis only describes a substrate.probe() with TTL cache (transient, in-memory). Nothing writes node status to ~/.hive/nodes/<name>.json across runs, so `hive node list` cannot show last-seen / offline without re-probing. Decide: does the daemon write heartbeat updates into NodeRecord, or stays purely ephemeral?
- tail.ts is NOT refactored to go through Substrate. Phase 1 ships src/tail.ts (transcript/pane stream); patch 2 only refactors wait.ts and readiness.ts. `hive tail <remote-bee>` will still call local tmux directly and silently fail on ssh-tmux sessions. Add tail.ts to patch 2's modifiedFiles or add a patch.
- send/brief call sites in cli.ts are not explicitly enumerated for the substrate refactor. cmdSend, cmdBrief, broadcast-send paths all touch sendText/sendEnter/capture. Patch 2 only lists src/tmux.ts as shim + wait.ts + readiness.ts. cli.ts is in the patch 4 list for spawn/list/attach but a clean inventory of every `tmux.*` call site in cli.ts and where each gets a Substrate is missing. High blast-radius gap.
- Substrate caching strategy in the daemon is undefined. Daemon tick reads N session records spanning M nodes per tick (~2s). Synthesis says TickDeps takes 'substrate-routable capturePane' but never specifies: do we open one ssh-tmux substrate per node and reuse across ticks (requires lifecycle/eviction), or per-tick (kills latency without ControlMaster)? This is a load-bearing design decision the implementer needs.
- Cross-node buz interrupt requires the daemon (or sender) to know the recipient's substrate. Sender CLI runs locally; recipient's tmuxTarget is on a different host. Patch 8 says BuzTransportContext is 'built from buildLocalSubstrate for local bees, ssh-tmux substrate for remote'. Spell out: who resolves recipient->substrate (substrateForRecord) on the SENDER side and what error surfaces if the recipient's node is unreachable mid-send. Tier downgrade fallback to queue on transport failure is implied but not stated.
- Default buzAccept policy is not specified. If a SessionRecord has no buzAccept field (every bee spawned before patch 8, or any bee not explicitly configured), which tiers are allowed? Undefined behavior is a real spoof/DoS vector. Pick a default in patch 8 (likely ['queue','passive']) and state it.
- Flow run storage layout is implicit. listRuns 'scans newest-first', but synthesis never states the directory layout — is it ~/.hive/flows/<name>/runs/<runId>/{meta.json,log.txt,result.json}? Or ~/.hive/runs/<runId>/? `hive flow runs` cross-flow listing depends on the choice. Define this in patch 11.
- format.ts changes for multi-node are unspecified. Patch 4 modifies src/format.ts but the synthesis doesn't say what the new `hive list` columns look like. Is there a `node` column? Does TSV stay backwards-compatible (Phase 1 Test Checklist §11 promises TSV stability)? This decision affects every consumer script.
- hive flow run `--watch` / live tail on background runs is not wired end-to-end. Patch 1 adds --follow to BOOLEAN_FLAGS but no patch wires --follow to `hive flow logs` for in-progress runs. Either land it in patch 11/12 or explicitly defer.
- Concurrent writes between daemon touchSession and CLI saveSession need a per-session lock. Synthesis introduces touchSession() to skip ledger writes but doesn't mention locking; two writers racing on the same .json will produce torn/last-writer-wins state. Specify: per-session withFileLock around both writers, or document that touchSession only writes monotonically-merged subset fields.
- Plist run-time robustness when dist/cli.js disappears (npm reinstall, repo move) is unaddressed. Install-time check is described; runtime failure mode (launchctl logs the failure but state.json/logs are silent to `hive daemon status`) is not. Document the recovery path or make `hive daemon status` detect 'plist present, process never alive' and explain why.

### Modalities not run
- Real SSH integration test. Patch 3 lists tests/substrates/ssh-tmux.mock.test.ts — mocked argv only. No test actually runs `ssh localhost tmux ...` against a real sshd, so the synthesis claim 'ssh-tmux supported' is structurally unverified. At minimum add a gated live-probe test (skip if SSH_LOCALHOST_AVAILABLE is unset).
- Real launchctl install/uninstall. Patch 7 'shimmed launchctl on PATH' verifies argv only. No test boots the daemon under a real LaunchAgent and confirms tick() runs end-to-end on a 2s timer.
- Migration of existing SessionRecords with no `node` field. Synthesis claims 'undefined ↔ local' but no test loads a Phase 1 session record from disk, runs cmdList in a multi-node world, and confirms the implicit local synthesis works. Add a fixture-based migration test.
- Search across a real rotated ledger (multiple ledger.jsonl.* files in chronological order). Patch 13 says 'Rotated ledger files all scanned in order' as a test but the rotation behavior under HIVE_LEDGER_MAX_BYTES exists in Phase 1 — write a fixture that produces rotated files and confirms enumeration order across the boundary.
- Concurrent CLI vs daemon. No test exercises `hive kill <bee>` while the daemon is mid-tick on the same bee. This is the highest-probability real-world bug after merge.
- Real cohort buz interrupt against >50 bees with per-recipient timeout. Synthesis sets concurrency=8 and timeout=5s but no test exercises this under contention; small-N tests will not catch timeout fanout issues.
- Foreground flow run SIGINT under real signal delivery. Patch 11 mentions 'SIGINT in foreground aborts wait and persists cancelled status' but in Vitest signal handlers usually need spawned child processes. State whether this is a child-process test or in-process abort-controller mock.
- End-to-end remote flow run: foreground flow that spawns on --node mini01 and waits — no test in the queue ties patches 3+4+11 together to confirm the remote bee handle is functional.

### Claims unverified
- 'ssh-tmux supported' — only verified by mocked argv tests in patch 3. No live SSH test in the queue.
- 'Daemon ticks every ~2s and detects active->idle_with_output transitions' — tested via pure tick() injection in patch 6, but no end-to-end test installs the LaunchAgent, runs a real bee, and observes the transition fire. The integration claim is structurally unverified.
- 'buz tier downgrade on disallowed tier' — patch 8 lists 'Tier dispatch + policy downgrade chain' as a test, but the synthesis text never specifies the downgrade ladder (interrupt->queue->passive? interrupt->reject?). Spell out the precedence so the test is implementable.
- 'No migration required' for new SessionRecord fields — claim depends on normalizeSessionRecord allowlist being extended in EACH patch (1,3,6,8,11). No single patch owns the consolidated allowlist; risk of one patch forgetting to extend.
- 'Per-command FLAG_VALUE_KINDS does not pollute other commands' — refactor lands in patch 8 and is reused by patch 13. The refactor is a behavior change to existing Phase 1 completion contracts; no test in the queue verifies that existing scoped flags (e.g. --colony, --swarm) still complete correctly after the refactor.
- 'spawnBee refactored to a pure function returning SessionRecord without printing' — patch 11 changes a function used by patches 3,4,5 (multi-node spawn). Risk: if patch 11 lands last, intermediate patches may rely on the print side-effect. Document the order dependency or move the spawnBee refactor earlier (with patch 4).
- 'BeeHandle has no tmuxTarget; remote-substrate spawn still works' — test in patch 11, but no test confirms a flow targeting --node mini01 produces a working remote bee that buz can interrupt across the SSH boundary.
- 'Backwards-compatible via tmux.ts shim' (risk #1) — no test boots a Phase 1 install (legacy session records, no node field, direct tmux.ts importers) under the Phase 2 shim and confirms zero behavior change.

### Surfaces not considered
- spec §12 `hive artifacts list --colony honeybee` is in the spec command surface but absent from the patch queue. Decide: out of scope, or add to patch 13 (artifacts as a fourth search corpus / dedicated sub-noun).
- spec §5 `hive ps --watch` and §11 `hive ps --watch` are in the spec but no patch implements --watch. With a daemon now writing lastObservedState atomically, this is a natural cheap win; consider folding it into patch 6 or patch 14.
- spec §11 sparse notifications (sealed/blocked/needs-input/flow-completed/substrate-offline). Synthesis says the daemon is 'reserved for future notifications' — fine to defer, but at minimum patch 14 should state the deferred work and the ledger event names the future notifier will subscribe to (so we don't have to renumber events).
- PHASE2_TEST_CHECKLIST.md is in patch 14 but no CHANGELOG.md update or release-notes patch is mentioned. README + PRD + spec is covered; if the project ships a CHANGELOG, add it.
- Daemon log rotation policy details. Patch 6 mentions src/daemon/log.ts with 'log rotation' but doesn't specify size threshold, retention count, or env knob. Mirror HIVE_LEDGER_MAX_BYTES pattern (HIVE_DAEMON_LOG_MAX_BYTES, HIVE_DAEMON_LOG_KEEP).
- buz storage limits / GC. inbox, outbox, queue, read, quarantine grow unbounded. No retention/GC subcommand is proposed (`hive buz gc --older-than 30d`?). Even a documented manual-cleanup story would close this.
- Search pagination beyond --limit. --limit 30 is fine for CLI but Jancsi/Hermes consuming hive search programmatically will hit 30-result ceilings without a cursor or --offset. Either commit to --limit-only or add --offset to the patch.
- Shell completion for `hive flow run --arg KEY=VALUE` syntax. Patch 14 mentions --arg in printHelp but completion FLAG_VALUE_KINDS doesn't include arg-kv completion. Probably defer, but call it out.
- Daemon behavior on macOS sleep/wake. launchctl LaunchAgents survive sleep but the tick clock will skew. No discussion of how the daemon detects and logs catch-up after wake.
- Capability-mismatch error path on spawn. `hive spawn codex --node mini01` when mini01 has no codex installed should error clearly; this depends on NodeRecord.capabilities (already flagged as missing).
- tail.ts substrate parity (called out under gaps but worth listing as a surface: tail is in the spec's universal verbs §5).

### Additions recommended (these should fold into the patch queue)
- Add NodeRecord.capabilities (string[]) and NodeRecord.status (online|offline|unknown) + lastSeen field; wire `hive spawn --node mini01` to error early on capability mismatch. Land in patch 3, add capability-mismatch test.
- Add tail.ts to patch 2's modifiedFiles. Audit every tmux.* call site in cli.ts and list them explicitly in patch 2 or 4 rationale.
- Add a per-recipient `substrate downgrade` rule to patch 8: on substrate transport failure for tier=interrupt, downgrade to tier=queue and surface tier_downgraded ledger event. Spell out the buzAccept default ('queue' + 'passive' if undefined).
- Add per-session withFileLock around touchSession() in patch 6, OR explicitly document that touchSession is monotonic-merge-only and CLI writers always re-read inside lock.
- Add a small live-probe test gated by SSH_LOCALHOST_AVAILABLE in patch 3 that exercises real ssh against localhost. Keeps the 'ssh-tmux supported' claim honest without breaking CI.
- Pin the flow run storage layout in patch 11 (recommend ~/.hive/flows/<name>/runs/<runId>/{meta.json,log.txt,result.json}). Pin `hive flow runs` to cross-flow listing semantics.
- Commit to a `hive list` column model for multi-node in patch 4: either a new `node` column (default-on when >1 node registered) or a `--wide` flag. Update Phase 1 TSV stability promise accordingly.
- Add HIVE_DAEMON_LOG_MAX_BYTES + HIVE_DAEMON_LOG_KEEP env knobs and a buz GC story (manual command or documented retention) in patch 6/8.
- Add a fixture-based migration test that loads a Phase 1 SessionRecord (no node/runId/flowName/buzAccept) into Phase 2 cli.cmdList and confirms it surfaces as a local bee with default policy.
- Document deferred work in patch 14: notifications, capabilities-based scheduling, `hive ps --watch`, artifacts list, search pagination, Level 2 resumability. Name the ledger event keys reserved for future notifier so v3 doesn't churn them.
- Move the spawnBee pure-function refactor earlier (into patch 4) so patches 5/8 build on the stable signature, instead of landing it in patch 11.
- Add a Substrate cache/lifecycle policy section to patch 6 (one substrate per node, evicted on N consecutive failures, reset on node CRUD).

## Per-module designs (raw)

Each module went through design then adversarial verify. Raw output for reference.

### `substrate` — verdict: `revise`

**Summary:** Introduce a Substrate abstraction that captures every operation currently in src/tmux.ts behind a typed interface, and ship two concrete implementations (local-tmux refactored from the existing module, plus a new ssh-tmux that wraps `ssh <endpoint> tmux …`). Add a node registry (~/.hive/nodes/<name>.json) with CRUD via `hive node` and atomic writes; thread a `node` field through SessionRecord; let `hive spawn --node <name>` route to a remote substrate; have `hive list/ps` aggregate across all registered nodes; add a `node_unreachable` state derived when a record's node fails its health probe; make `hive attach` print/exec `ssh <endpoint> -t tmux attach -t <target>` for remote bees. All changes are additive and forward-compatible: missing `node` is treated as 'local'; existing local tmux call sites keep their semantics. Substrate is async, batch-friendly (multi-target capture/list to amortize SSH), and dispatchable from a single helper given a SessionRecord. The daemon question is left open; v1 ships with per-CLI live SSH probes wrapped in a configurable timeout/health cache.

**New files:**
- `src/substrates/index.ts` — Substrate interface (10 ops), SubstrateKind union, types (Target, LaunchSpec, CaptureOptions, AttachIntent, ProbeResult), a registry that maps SubstrateKind+endpoint to a Substrate instance, and dispatch helpers: substrateFor(record), substrateForNode(nodeName), withSubstrate(record, fn). Caches instances per (kind,endpoint) to allow SSH ControlMaster reuse later. Also exports LOCAL_NODE_NAME ('local') and a tiny probe helper used by `node_unreachable` derivation. (~200 LoC)
- `src/substrates/local-tmux.ts` — LocalTmuxSubstrate: the refactored body of src/tmux.ts. Implements Substrate by calling `tmux` via execFile. Keeps the createLauncher tmpfile dance, attachCommand TMUX detection, and the `formatShellCommand` export. Re-exports the LaunchSpec/launcher utilities for backwards compatibility. Adds a probe() that always returns { ok:true } in <5ms. (~220 LoC)
- `src/substrates/ssh-tmux.ts` — SshTmuxSubstrate: implements Substrate by shelling out to `ssh [options] <endpoint> tmux …`. Reuses the same arg vectors as local-tmux but transports them through SSH. Uploads the launcher script via a heredoc (`ssh endpoint 'bash -s' < runner`) or, for spawn, writes a remote tempdir via `ssh endpoint 'mktemp -d'`, scp's the payload+runner, then launches tmux with `node <runner> <payload>`. attachCommand returns ['ssh','-t',endpoint,'tmux','attach-session','-t',target]. probe() runs `ssh -o ConnectTimeout=2 -o BatchMode=yes endpoint true` with a result cache. Honors NodeRecord.sshCommand override (defaults to 'ssh'). Treats non-zero exit + 'No such session' or empty list-sessions as `hasSession=false`. (~320 LoC)
- `src/node.ts` — Node registry CRUD with atomic writes, mirrors src/colony.ts. Functions: validNodeName, listNodes, loadNode, nodeExists, registerNode, updateNode, unregisterNode, saveNode. Defines NodeRecord type (see types). Auto-injects an implicit 'local' node (kind='local-tmux', endpoint='localhost') if not present — listNodes() returns it as a synthetic record so callers never special-case it. Atomic writes + appendLedger ('node.register','node.update','node.unregister'). Stored under ${root}/nodes/<name>.json (root from HIVE_STORE_ROOT or ~/.hive). (~180 LoC)
- `tests/substrates/local-tmux.parity.test.ts` — Behavioral parity test: drives LocalTmuxSubstrate through the full Substrate interface (spawn → hasSession → sendText → capture → kill) using a real tmux server in a sandboxed socket dir (TMUX_TMPDIR). Validates that observable outputs equal the pre-refactor src/tmux.ts (snapshot of capture, listSessions returning the created target). (~180 LoC)
- `tests/substrates/ssh-tmux.mock.test.ts` — Mocks execFile/spawn (via a stub injected through a substrate factory option) to record argv and assert that SshTmuxSubstrate constructs the exact 'ssh <endpoint> tmux …' invocations expected for each Substrate op. Covers probe() caching, exit-code 255 → unreachable, attachCommand including '-t'. Uses NodeRecord.sshCommand to assert that a custom 'ssh -F ~/.hive/ssh_config' override is respected. (~200 LoC)
- `tests/node.crud.test.ts` — Node CRUD test under a temp HIVE_STORE_ROOT: registerNode validates name, updateNode merges, unregisterNode removes, listNodes synthesizes 'local' if not registered, ledger contains node.register/update/unregister events. (~140 LoC)
- `tests/state.node_unreachable.test.ts` — Tests that deriveState returns { state:'node_unreachable', detail:'node <name> offline' } when context.unreachableNodes contains the record.node, even if liveTargets doesn't include the tmuxTarget (the node hasn't been probed). Verifies precedence: kill_failed > node_unreachable > sealed > dead > rest. (~100 LoC)
- `tests/cli.node.test.ts` — End-to-end CLI tests via the parsed command path for `hive node register/list/inspect/unregister`, plus `hive spawn --node <name>` writing record.node, plus `hive list` calling a stubbed multi-node aggregator that reports one unreachable node. ssh substrate is stubbed. (~200 LoC)
- `tests/cli.attach.remote.test.ts` — Asserts cmdAttach for a remote-node bee with --print outputs the exact `ssh <endpoint> -t tmux attach-session -t <target>` string; without --print, asserts attachSession dispatches through the SshTmux substrate. (~100 LoC)

**Modified files:**
- `src/tmux.ts` — Becomes a thin compatibility shim: re-exports LaunchSpec, formatShellCommand, attachCommand, attachSession, capture, hasSession, kill, listTmuxSessions, newSession, sendEnter, sendKey, sendText from './substrates/local-tmux.js'. Keeps existing external imports working without churn. Marked '@depreca
- `src/store.ts` — Add optional 'node' field to SessionRecord (string, default semantically 'local' when absent). Append 'node' to the string-key passthrough loop in normalizeSessionRecord so old records still load (missing → undefined; callers treat undefined as 'local').
- `src/state.ts` — Add 'node_unreachable' to BeeState union; extend StateContext with `unreachableNodes?: Set<string>`. In deriveState, after the kill_failed early return and BEFORE the liveTargets check, add: `const node = record.node ?? 'local'; if (context.unreachableNodes?.has(node)) return { state: 'node_unreacha
- `src/cli.ts` — Replace direct imports from './tmux.js' with imports from './substrates/index.ts' (dispatch helpers) for the call sites that touch a SessionRecord: ensureLive, send, brief, tail/follow, list/ps capture loop, attach, kill, run wait/capture. Add new case 'node' → cmdNode dispatcher (subcommands: list,
- `src/completion.ts` — Add 'node' to COMMANDS. Add NODE_SUBCOMMANDS = ['list','register','inspect','unregister']; wire NOUN_COMMAND_SUBS.node and NOUN_SUB_ARG.node = { inspect: 'node', unregister: 'node' }. Add FLAGS_BY_COMMAND.spawn += '--node' and FLAGS_BY_COMMAND.run += '--node'. Add FLAG_VALUE_KINDS['--node'] = 'node'
- `src/swarm.ts` — No schema change to SwarmRecord. swarmDestroy in cli.ts will iterate members and dispatch substrate.kill via per-record substrate resolution (not in swarm.ts itself). Confirm via type signature: nothing imported from tmux directly here.
- `PHASE1_TEST_CHECKLIST.md` — Append Phase 2 substrate section with manual cases: register a node, spawn to it, list shows it, kill it via remote substrate, simulate unreachable host (firewall) → list shows node_unreachable, attach --print shows ssh command, attach without --print execs ssh -t.

**Schema changes:**
- SessionRecord: + node?: string (undefined ↔ 'local'). Forward-compatible: older records without 'node' load unchanged. Ledger events for session.save include node if present.
- New record type NodeRecord under ${HIVE_STORE_ROOT}/nodes/<name>.json with fields {name, kind, endpoint, createdAt, description?, capabilities?, sshCommand?, sshArgs?}
- Ledger events added: 'node.register' {name,kind,endpoint}, 'node.update' {name,patch}, 'node.unregister' {name}
- BeeState union: + 'node_unreachable' (transient, non-terminal)
- StateContext: + unreachableNodes?: Set<string>

**Integration points:**
- src/cli.ts: switch from direct tmux imports to substrateForRecord(record) at every existing call site (ensureLive, send, brief, tail, list capture loop, attach, kill, swarm destroy, run). The dispatcher resolves the substrate once per record per command invocation; tmux.ts shim remains for any external import path
- src/cli.ts cmdList: replaces single listTmuxSessions() call with parallel per-node listSessions() via Promise.allSettled with per-node timeout (default 5s, configurable via HIVE_NODE_PROBE_MS); failed nodes contribute to StateContext.unreachableNodes
- src/cli.ts cmdSpawn: resolves --node before allocating identity; passes through to spawnBee, which calls substrate.hasSession/spawn instead of the local functions; records record.node when value != 'local'
- src/cli.ts cmdAttach: dispatches substrate.attachCommand for --print and substrate.attachSession for interactive; for ssh-tmux this naturally produces 'ssh <endpoint> -t tmux attach-session -t <target>'
- src/state.ts: new derivation rule inserted between kill_failed and liveTargets handling (order matters because a node being offline should not be reported as 'dead')
- src/completion.ts: imports listNodes from src/node.ts; '--node' value completion; 'hive node <sub>' subcommand wiring; replaces listTmuxSessions import with the substrate-local re-export
- src/store.ts: SessionRecord.node added (optional); normalizeSessionRecord passthrough loop includes 'node'
- src/swarm.ts: untouched; swarmDestroy in cli.ts resolves per-member substrate to kill
- src/clean.ts: pass-through — deadSessionRecords still operates on local-only liveTargets; in Phase 2 we extend the aggregator before this point so 'clean --dead' on the local node continues to work; remote-node 'dead' classification is deferred to the daemon
- src/wait.ts, src/readiness.ts, src/transcripts.ts, src/seal.ts: untouched. Readiness keeps using pane text (now obtained via substrate.capture). Transcripts paths are local until the SessionRecord.transcriptPath field becomes node-aware in a later phase
- src/config.ts (if introduced in Phase 2): HIVE_NODE_PROBE_MS and HIVE_NODE_PROBE_CACHE_MS read from env
- Future src/daemon.ts hook: substrate registry exposes clearSubstrateCache() so daemon can refresh probe state without leaking child processes

**Module-level open questions:**
- Does the daemon poll remote tmux for state, or does every CLI 'hive list' do live SSH queries? Phase 2 ships live queries with a short-TTL probe cache (e.g. 2s) shared via a sidecar file ${root}/cache/nodes.json. Daemon can later become the producer of that cache without changing the CLI consumer.
- Remote tmux version compatibility: hard-fail with a 'tmux >= 2.4 required on <node>' error on first failed list-sessions, or degrade gracefully (e.g. fall back to send-keys instead of paste-buffer)? Recommendation: hard-fail with actionable message; defer graceful degradation to Phase 3.
- SSH ControlMaster: ship now or defer? Recommendation: defer connection pooling to Phase 2.5 but make NodeRecord.sshArgs a first-class field so users can opt in immediately.
- Should `hive spawn --node` also accept `--substrate ssh:mini01` shorthand from the spec? Recommendation: accept --node and alias --substrate to it (parse 'ssh:<name>' as --node <name>); document --node as canonical.
- How does 'hive seal' / 'hive last' source seal artifacts on remote bees? For Phase 2, seals are recorded on the controller (local ~/.hive/seals/) only; remote seal files require a future fetch step.
- Transcript paths in SessionRecord are local file paths. For remote bees they would point at the remote filesystem. Phase 2 defers transcript-on-remote (no transcriptPath written for remote spawns; falls back to pane capture).
- kill_failed on a remote node — should we retry once after probe success? Phase 2: leave kill_failed sticky in the record; the next manual kill attempt resolves it.
- Should `hive clean --dead` operate per-node or only on the local node by default? Recommendation: per-node opt-in via --node, default local. Avoids cleaning records that look dead only because their node is briefly offline.
- Where do per-node config defaults live (e.g. per-node HIVE_CLAUDE_CMD)? Defer to Phase 2.5 with NodeRecord.envDefaults — out of scope for this module.

**Verifier — real issues:**
- wait.ts and readiness.ts are declared 'untouched' but they import { capture, sendEnter, sendKey } directly from './tmux.js' (which becomes a local-tmux shim). For a remote bee, waitForAgentReady and waitForIdle will call the LOCAL tmux about a session name that only exists remotely — readiness instantly times out, wait blocks forever, and `hive run --node mini01` is broken end-to-end. These modules MUST take a Substrate (or accept the SessionRecord and resolve internally) to actually work with ssh-tmux. The integrationPoints line 'Readiness keeps using pane text (now obtained via substrate.capture)' contradicts the dependsOnModules claim that readiness/wait are untouched.
- Design omits `hive substrate list` even though HONEYBEE_V2_SPEC.md §5 lists it as a noun management command and §15 makes Substrate one of the core nouns. Only `hive node …` is wired. Phase 2 is the natural place to add a trivial 'substrate list' that prints the registered SubstrateKind union; deferring it leaves the spec partially implemented and the FLAGS_BY_COMMAND/COMMANDS tables out of sync with the documented vocabulary.
- Design defers the spec-literal `--substrate <kind>:<node>` flag to an open question, but the spec uses it in actual canonical examples (`hive spawn --frame deep-review --substrate ssh:mini01`, `hive spawn codex --substrate ssh:mini01`). Without parsing `--substrate` even as an alias of `--node`, every example in §5 and §15 of the spec stops working in Phase 2. The fix is one parse-time normalization, but it isn't in the modifiedFiles diff for src/cli.ts.
- Remote sendText carries the full prompt as an argv to `ssh endpoint tmux set-buffer -b <buf> <text>`. SSH/exec argv has a kernel-imposed limit (ARG_MAX, ~256KB on macOS, ~128KB on Linux) and an SSH-side per-channel cap. Long packets (briefs with full context dumps are easily 50-200KB today) will silently fail or get truncated on the remote. Design's risks discuss tmux version skew but do not cover argv-size for SSH-tunneled set-buffer; recommend streaming via `ssh ... 'tmux load-buffer -b <buf> -'` and piping text on stdin.
- Remote spawn assumes `node` is on the remote host (the launcher runner is a `.mjs` file executed via `node <runner> <payload>`). NodeRecord.capabilities lists 'node' but nothing enforces it at spawn time. First failed remote spawn will surface as an opaque tmux exit. Either gate spawn on capabilities or fall back to a pure-shell launcher (and document the fallback).

**Verifier — missing pieces:**
- SpawnOptions type in cli.ts needs `node?: string` added — the design says SpawnOptions.node is passed through but never lists the field in the types/modifiedFiles diff.
- cmdKill is not updated even though the substrate refactor is the right moment to make kill transactional per spec §17 (attempt substrate.kill → confirm !substrate.hasSession → only then deleteSession; on failure mark status='kill_failed' with lastError). The design also doesn't say where kill_failed gets recorded for remote bees after the cleanup race window.
- src/wait.ts and src/readiness.ts modifications (capture/sendEnter/sendKey → substrate dispatch) and corresponding test updates are missing from modifiedFiles.
- Help (`printHelp`) entry: the design's modifiedFiles for src/cli.ts says 'Add `node` and `spawn --node` to printHelp()', but the command list in printHelp is structured as an array of [name, args, desc] triples; the design doesn't enumerate them so it's easy to omit `--node` from the spawn/run rows or forget the `node` row entirely. Should also add `substrate list` once that command lands.
- Ledger events for spawn/kill on a remote node should include `node` so audit trails distinguish local vs remote. The design adds node.register/update/unregister events but doesn't extend session.save / prompt.send / session.delete / session.wait payloads to include `node`.
- No mention of CompletionState carrying nodes through getCompletionsFromState; design says 'Extend CompletionState with nodes?' but doesn't include it in the FLAG_VALUE_KINDS table entry or in the offline-completion test paths (tests/completion.*.test.ts is not in the test list).
- Edge case: `hive list --node <name>` filter is not added even though we now have a node dimension. Without it, with many remote nodes the table becomes hard to scan. Minor but worth a flag.
- Risk for AttachIntent type in the public API: types/publicAPI lists 'AttachIntent' in src/substrates/index.ts but no later place defines or uses it; either drop it or specify its shape.
- Notifications spec §11 lists 'substrate/node went offline' as a notification target — node_unreachable is the right derived state, but there's no hook for emitting that notification (deferred to daemon module presumably; should be called out as a clean seam, currently isn't).
- tests/state.node_unreachable.test.ts asserts precedence but the design's stateLabel mapping 'node_unreachable' → 'offline' is inconsistent with other state labels which are 1:1 with the enum. Either keep 'node_unreachable' label or document the rename in stateLabel and in `formatStateCell` (which has a switch over BeeState and currently lacks a 'node_unreachable' arm — that's a missing TS-exhaustiveness fix).

### `daemon` — verdict: `revise`

**Summary:** A long-lived general-purpose Honeybee daemon (`hive-daemond`) that ticks every ~2s, derives state for live sessions, detects active→idle_with_output transitions, and dispatches deferred work — initially: buz tier-B queue delivery. The daemon is auto-started via a launchd LaunchAgent on macOS (and documented as a `--user` systemd unit on Linux), exposes a small file-based IPC (PID, state.json, log.txt) under `~/.hive/daemon/`, and is controlled through a new `hive daemon <install|uninstall|start|stop|restart|status|logs|run>` subcommand group. The main loop is split into a pure dependency-injected `tick()` for unit testing and an outer `run()` that owns the timer, PID file, signal handling, log rotation, and crash semantics. Resumability checkpointing and notification dispatch are reserved hook points but unimplemented in Phase 2.

**New files:**
- `src/daemon/index.ts` — Public daemon types, paths under HIVE_STORE_ROOT, PID/status helpers (read/write/clear), liveness check (kill -0 + process name), install/uninstall orchestration, default config (HIVE_DAEMON_TICK_MS, HIVE_DAEMON_LOG_MAX_BYTES), and the DaemonStatus shape consumed by `hive daemon status`. (~240 LoC)
- `src/daemon/run.ts` — Main loop. Exports a pure `tick(deps, prev)` function (no I/O outside injected deps) and an outer `runDaemon(opts)` that owns PID lock acquisition, the setInterval (or async sleep loop), signal handlers (SIGTERM/SIGINT/SIGHUP), state.json writeback, ledger emission, log rotation, and dispatcher invocations. (~360 LoC)
- `src/daemon/plist.ts` — macOS launchd plist generator. Pure function `renderPlist(opts)` returning XML, plus install/uninstall helpers that write to `~/Library/LaunchAgents/dev.honeybee.hive.plist`, run `launchctl bootstrap/bootout gui/$UID`, and verify the agent label is registered. Also exports `renderSystemdUnit(opts)` for Linux documentation/copy-paste — not auto-installed. (~220 LoC)
- `src/daemon/dispatch.ts` — Dispatcher registry. Tick produces a list of derived state transitions; dispatchers are plain functions `(transition, deps) => Promise<void>`. Phase 2 ships exactly one dispatcher — `dispatchBuzQueue` — which reads `~/.hive/bus/<beeId>/queue/` for the bee that just transitioned active→idle_with_output and delivers messages via `sendText`. The registry is the seam where future notification/checkpoint dispatchers plug in. (~180 LoC)
- `src/daemon/log.ts` — Append-only structured logger writing JSONL to `~/.hive/daemon/log.txt` with size-based rotation (rotate at HIVE_DAEMON_LOG_MAX_BYTES, default 5 MB; keep N rotated files, default 3). Also exports a follow/tail helper used by `hive daemon logs`. (~120 LoC)
- `tests/daemon-tick.test.ts` — Unit tests for the pure `tick()` function using fake deps (in-memory sessions, fake panes, fake clock). Asserts: transition detection (active→idle, idle→active, ready→active), no-spurious-transitions on identical state, dead session removal, dispatcher invocation order, single-tick exception isolation (one dispatcher throwing must not skip others). (~380 LoC)
- `tests/daemon-plist.test.ts` — Golden-file tests for `renderPlist({ label, programArguments, stdoutPath, stderrPath, keepAlive, runAtLoad, environmentVariables })`. Asserts the rendered plist parses as valid XML (via Node's built-in DOM-free regex sanity checks since we have no XML dep), embeds HIVE_STORE_ROOT into EnvironmentVariables, uses absolute paths only, and matches a checked-in fixture byte-for-byte. (~180 LoC)
- `tests/daemon-install.test.ts` — Integration tests for install/uninstall idempotency under a temp HOME + HIVE_STORE_ROOT. `launchctl` is shimmed via a fake binary on PATH; asserts: install writes plist, runs `bootstrap`, second install is a no-op; uninstall runs `bootout` + removes plist; uninstall when not installed is a no-op; install refuses if PID file points at a live process for a different label. (~220 LoC)
- `tests/daemon-status.test.ts` — Unit tests for status helpers: writeStatus → readStatus round-trip; isDaemonRunning() correctly returns false when PID file is stale (PID does not exist) and true when process is alive; concurrency guard refuses second runDaemon() invocation. (~160 LoC)

**Modified files:**
- `src/cli.ts` — Import `cmdDaemon` from './daemon/index.js'. Add `case "daemon": await cmdDaemon(parsed); break;` in the top-level switch. Extend the `printHelp` commands table with a `daemon <install|uninstall|start|stop|restart|status|logs|run>` row. No changes to existing verbs; this is purely additive.
- `src/completion.ts` — Add `"daemon"` to the top-level `COMMANDS` array. Add `DAEMON_SUBCOMMANDS = ["install", "uninstall", "start", "stop", "restart", "status", "logs", "run"]` and register under `NOUN_COMMAND_SUBS` so `hive daemon <TAB>` completes. Add `FLAGS_BY_COMMAND.daemon = ["--foreground", "--tick-ms", "--follow",
- `src/store.ts` — No schema-breaking change. Add an optional `lastObservedState?: string` and `lastObservedStateAt?: string` to `SessionRecord` (and to the `normalizeSessionRecord` whitelist) so the daemon can persist what it last computed without re-deriving from scratch on each cold-start tick. Both fields are forw
- `src/state.ts` — Export a new `stateTransitionsBetween(prev: Map<string, BeeState>, next: Map<string, BeeState>)` helper that returns `Array<{ name: string; from?: BeeState; to: BeeState }>` so the daemon can compute transitions purely. No change to `deriveState` semantics.
- `PHASE1_TEST_CHECKLIST.md` — Append a Phase 2 daemon section (install/uninstall, status reporting, log rotation, tick correctness, buz delivery on idle transition) — checklist only, no behavior change.

**Schema changes:**
- SessionRecord: add optional `lastObservedState?: string` — last BeeState value the daemon derived for this record. Allows `hive ps` to render stale-but-honest state when the daemon is down or hasn't ticked yet.
- SessionRecord: add optional `lastObservedStateAt?: string` — ISO timestamp of the tick that produced `lastObservedState`. Used to compute staleness.
- Both fields are added to the `normalizeSessionRecord` string-field whitelist and remain optional — old records continue to load with both fields undefined. No migration required.
- New on-disk file: `~/.hive/daemon/daemon.pid` containing JSON `{pid, label, version, startedAt}`. Not part of SessionRecord; lives under its own subtree.
- New on-disk file: `~/.hive/daemon/state.json` containing `DaemonStatus` (minus the derived `installed`/`running` flags). Atomic-written each tick.
- New on-disk file: `~/.hive/daemon/log.txt` JSONL (rotated). One line per significant event: tick.start, tick.done, transition, dispatch.ok, dispatch.fail, fatal.
- Ledger event types added (additive): `daemon.install`, `daemon.uninstall`, `daemon.start`, `daemon.stop`, `daemon.tick.fatal` (only for crash-class failures, not per-tick).
- Bus directory contract (defined here, implemented by buz module): `~/.hive/bus/<bee-id>/queue/<ts>-<from>.json`, `~/.hive/bus/<bee-id>/delivered/...`, `~/.hive/bus/<bee-id>/failed/...`. Daemon is the only mover of files between these directories.

**Integration points:**
- src/state.ts: daemon calls `deriveState(record, context)` per session each tick. New `stateTransitionsBetween` helper added here so transition detection is shared with future modules (notifications, ps --watch).
- src/store.ts: daemon uses `listSessions`, `saveSession` (to persist `lastObservedState`/`lastObservedStateAt`), and `appendLedger` for install/uninstall/start/stop/tick-fatal events. Atomic write + lock primitives are reused as-is.
- src/tmux.ts: daemon uses `listTmuxSessions` for the live set and `capture` for pane content; `sendText` is used by the buz dispatcher to deliver queued prompts. No tmux.ts changes required.
- src/seal.ts: daemon calls `sealedBeeNames()` once per tick to flow seal status into StateContext.
- src/lock.ts: PID file is implemented as a long-held variant of `withFileLock` — daemon process opens the lock file at startup and releases on shutdown (open handle prevents EEXIST elsewhere; stale handling reuses the same 60s mtime heuristic).
- src/cli.ts: adds `case "daemon"` and the help-table row. No other verb is altered.
- src/completion.ts: adds daemon to top-level commands and registers DAEMON_SUBCOMMANDS for `hive daemon <TAB>` and `hive daemon logs -<TAB>` flags.
- src/colony.ts / src/swarm.ts: no direct dependency in Phase 2; daemon iterates sessions and reads colony/swarm fields off SessionRecord only.
- Future: src/buz.ts (Phase 2 buz module) writes to `~/.hive/bus/<bee>/queue/`. The daemon is the only reader during idle transitions; CLI `hive buz send` is the writer. This contract is defined here and consumed by the buz module.
- Future: src/substrates/ssh-tmux (Phase 2) — the daemon is the natural single owner of remote pane polling (connection reuse). The substrate interface should expose `capturePane(target)` and `listLive()` so the daemon can swap local-tmux for ssh-tmux without changing tick logic.

**Module-level open questions:**
- Remote substrate ownership: Does the daemon become the sole client for ssh-tmux state polling (so it can hold pooled SSH ControlMaster connections), while one-off CLI invocations (hive send, hive kill) still SSH directly? Recommended answer in spec: yes for state derivation, no for direct user actions — CLI keeps the right to bypass the daemon for low-latency interactive verbs, accepting a fresh SSH connect per call. The daemon publishes its last observed state to `lastObservedState` on the SessionRecord so CLI invocations like `hive ps` can render staleness without re-polling.
- Buz dispatch model: Three viable options — (A) buz writes to queue/, daemon polls queue/ every tick regardless of state and delivers when state==idle_with_output; (B) buz writes to queue/, daemon only inspects queue/ on the tick that observes the active→idle transition; (C) buz writes a sentinel + the daemon subscribes via fs.watch. Recommendation: (B) for Phase 2 (cheap, deterministic, no extra fs.watch handles, easy to test). Promote to (A) only if user reports missed deliveries when state thrashes within a single tick window.
- What runs the daemon binary? Two choices: (1) ship a standalone `hive-daemond` entry in package.json bin; (2) reuse `hive daemon run --foreground` as the launchd ProgramArguments target. Recommendation: (2) — fewer binaries, the plist points at `node <abs-path-to-dist/cli.js> daemon run --foreground`. Avoids version skew where the daemon and CLI diverge.
- How does the daemon handle the dev/tsx case? In dev (`npm run dev`) the CLI runs under tsx, but launchd runs the compiled `dist/cli.js`. Plist install should refuse if `dist/cli.js` does not exist and suggest `npm run build` first. `hive daemon run --foreground` works in both dev and prod.
- Linux story: ship only `renderSystemdUnit` + a README snippet, or ship `hive daemon install --systemd` that writes `~/.config/systemd/user/hive.service` and runs `systemctl --user daemon-reload && enable --now`? Recommendation per user decision: document the systemd path but do not auto-install in Phase 2; macOS launchd is the only auto-installed surface.
- Should `hive daemon status` fall back to running an ad-hoc tick when the daemon is down so users still see fresh state? Recommendation: no — keep `status` factual (reports daemon health) and let `hive ps` keep doing its own derivation. Mixing the two is exactly the kind of magic the project avoids.
- Tick budget: at 2s tick interval with N=200 sessions and `tmux capture-pane` per session, can we keep tick wall-clock under ~500ms? Likely yes for local-tmux; for ssh-tmux this becomes the dominant cost and motivates a per-node capture-pane batch. Open: should we cap concurrent capture-pane calls per tick (e.g. p-limit 16) — recommendation: yes, add a small bounded concurrency helper in src/daemon/run.ts; no external dep.
- Crash semantics: if the daemon crashes mid-tick while a dispatcher already delivered a buz message to tmux but had not yet moved the queue file to delivered/, the next tick will redeliver. Acceptable? Recommendation: yes for Phase 2 — at-least-once delivery, documented. Tightening requires a per-message lock that is out of scope.
- Should we surface `daemon down` as a `hive ps` warning banner? Easy to add (just check readDaemonStatus().running) and aligns with cockpit ethos. Recommendation: yes — small banner above the table when pretty mode, suppressed in non-pretty.

**Verifier — real issues:**
- TickDeps type names `sealedNames` but the actual export in src/seal.ts is `sealedBeeNames`. Cosmetic but a real wiring mismatch that needs reconciling either by renaming the export or fixing the dep name.
- Persisting `lastObservedState` via `saveSession` will append a `session.save` ledger entry every tick for every session (see store.ts line 41). With 200 sessions × 2s tick this is ~100 ledger rows/sec — runaway log growth that the existing 10MB rotation will paper over but the ledger becomes useless as a history. Daemon needs a write path that updates the record without ledger emission, or must only write when state changes.
- Dispatcher contract is incomplete. The design says `dispatchBuzQueue` calls `deps.sendText`, but `TickDeps` does not include `sendText`. The contract for what a dispatcher receives is therefore underspecified — either Dispatcher should take its own deps, or `sendText` must be added to TickDeps.
- PID file scheme conflicts with the existing `lock.ts` 60s stale-mtime heuristic. `withFileLock` writes the lock file once at open time; if the daemon holds the lock for hours while running, another process will see the file's mtime as >60s old and treat it as stale per the existing rule. Either the daemon must explicitly touch the PID file's mtime each tick, or the stale heuristic in lock.ts must be bypassed for long-held PID locks — neither is acknowledged.
- Bus directory layout contradicts the spec. Spec §10 (lines 426-430) explicitly defines `~/.hive/bus/<bee>/inbox/` and `outbox/`. The design defines `queue/`, `delivered/`, `failed/`. The design is asserting a new contract that other modules will follow, but it must reconcile with the inbox/outbox naming or the spec must be updated.
- The user-locked buz three-tier model (interrupt/queue/passive with per-bee acceptance policy) is reduced silently to tier-B queue delivery only. Phase 2 daemon ships exactly `dispatchBuzQueue` with no acknowledgement of tier-A (interrupt) and tier-C (passive). The per-bee acceptance policy gate on dispatch is also nowhere in the dispatcher flow.
- Spec's anti-goal §23 explicitly forbids 'hidden background autonomy' and 'hidden autonomous background work'. The daemon is auto-installed as a launchd LaunchAgent that ticks every 2s and dispatches work. The summary should explicitly defend the daemon as mechanical, not autonomous (and the README needs to surface this to users); the current summary glosses over this tension and may read as exactly the thing the spec forbids.

**Verifier — missing pieces:**
- `hive ps` modification is not in `modifiedFiles` but the open-questions and 'daemon down banner' recommend changing `hive ps` output. Either commit to that change explicitly or drop the banner from scope.
- `hive ps --watch` is referenced in the spec but does not appear in modifiedFiles. If the daemon publishes `lastObservedState`, `hive ps --watch` should be the natural consumer — design is silent on this.
- No ledger event `daemon.tick.done` listed in schemaChanges — only `daemon.tick.fatal`. The dispatch.ok/dispatch.fail events are in the log.txt but not the ledger. Ledger contract for dispatch outcomes (e.g., a buz message was delivered) should be explicit because it is the auditable record for inter-agent messaging — exactly the kind of thing the spec wants observable.
- Atomic write helper is duplicated across modules (store.ts, frame.ts, colony.ts, seal.ts, ids.ts, swarm.ts each have a private `atomicWriteFile`). Design says 'atomic write via existing atomicWriteFile pattern' but there is no exported shared helper. Daemon either copies the pattern again (more duplication) or extracts a helper — pick one.
- No `--json` exit shape for `hive daemon status` is specified beyond 'JSON-stable'. With exit codes 0/3/4 the consumers need a documented schema.
- package.json `bin` and build wiring not addressed beyond an open question. The plist will reference `dist/cli.js`; if package.json points elsewhere or if `node_modules/.bin/hive` is the entry, install needs to resolve which path to embed. Design should commit to a resolution strategy (e.g., `process.argv[1]` at install time, or `require.resolve`).
- Process-name verification on macOS uses /proc on Linux — design says '/proc-style process name check on Linux (best effort)' but macOS has no /proc. The risk mitigation in §risks promises `ps -p` but the publicAPI for `isDaemonRunning` does not commit to a cross-platform implementation.
- No teardown for in-flight dispatcher when SIGTERM arrives. The design mentions signal handling but does not say whether ticks-in-progress complete or are aborted (deps.signal: AbortSignal exists in DaemonRunOptions but not in TickDeps — so dispatchers cannot observe it).
- Per-bee buz acceptance policy hook is missing. Spec/decisions imply policies like 'this bee never accepts interrupts during sealed state'. Where does the daemon read this? Not in TickDeps, not in Dispatcher.
- Phase 2 'ships ssh-tmux this phase along with the abstraction' (user decision) — the design defers the substrate seam entirely to 'Future' in integrationPoints. If ssh-tmux really ships this phase, the daemon's capturePane/listLive contract should be substrate-shaped now, not tmux-shaped. Currently TickDeps.capturePane takes a `target: string` (tmux semantics), not a substrate-routable address.

### `buz` — verdict: `accept-with-tweaks`

**Summary:** The buz module implements file-backed addressed messaging between bees with three delivery tiers: interrupt (paste immediately into recipient pane via substrate.sendText AND drop a copy in inbox/), queue (store in queue/ for daemon to deliver on next active->idle_with_output transition), and passive (store in inbox/ with no delivery action). Storage lives under ~/.hive/buz/<bee>/{inbox,queue,outbox,read}/ as YAML-frontmatter + Markdown files. Each SessionRecord gains an optional buzAccept policy that lists acceptable tiers; messages targeting a disallowed tier are auto-downgraded (interrupt -> queue -> passive) and the actually-delivered tier is recorded as deliveredAs in the message. Cohort sends iterate per bee with isolation: one recipient failing or downgrading never aborts the broadcast. The CLI exposes `hive buz send|inbox|read|outbox|purge`, all selector-aware. The general hive daemon (designed in a sibling module) is what scans queue/ directories on a tick AND on substrate-readiness signal to perform tier-B delivery; buz exposes a pure `processQueueForBee(name, substrate)` function the daemon calls, so buz remains testable without a real daemon. Sender attribution is required (--from is mandatory and non-empty), and message IDs are deterministic-sortable ULIDs (timestamp-millis hex + 8 random hex) generated locally with zero dependencies.

**New files:**
- `src/buz.ts` — Core buz module: storage layout, BuzTier enum, BuzMessage type, message ID generation, YAML-frontmatter serialization/parsing, atomic writes with file locks, tier dispatch with policy resolution and auto-downgrade, listing/reading/consuming/purging inbox/outbox/queue/read mailboxes, and the daemon-facing processQueueForBee() function. (~520 LoC)
- `tests/buz.test.ts` — Unit tests for buz: ID generation/sortability, YAML frontmatter roundtrip, policy resolution + downgrade chain, send() per-tier behavior with mocked substrate, processQueueForBee transition handling, cohort fan-out isolation, purge --read/--all semantics, --consume move-to-read behavior, sanitization of selectors in filenames. (~480 LoC)
- `tests/buz-cli.test.ts` — Integration tests for cmdBuz subcommands (send/inbox/read/outbox/purge) including selector fan-out, --from validation, --tier flag enum guarding, --unread/--limit/--from filters on inbox, --consume effects on read state, exit codes. (~260 LoC)

**Modified files:**
- `src/store.ts` — Extend SessionRecord type with optional buzAccept?: BuzTier[] (or string[] persisted; validated on load). Update normalizeSessionRecord() to read object.buzAccept if present, validate each element is one of 'interrupt'|'queue'|'passive', drop unknown values silently for forward compatibility. No wri
- `src/cli.ts` — Register 'buz' command in the main switch dispatcher (after 'seal'). Add cmdBuz(parsed) that dispatches subcommands send|inbox|read|outbox|purge. Each subcommand uses resolveSelector for selector expansion (send/inbox/outbox/purge), reads --from, --tier, --prompt|-p, --unread, --limit, --from-sender
- `src/completion.ts` — Add 'buz' to COMMANDS array. Add BUZ_SUBCOMMANDS = ['send','inbox','read','outbox','purge','accept']. Extend NOUN_COMMAND_SUBS with buz -> BUZ_SUBCOMMANDS. Extend NOUN_SUB_ARG so buz.send / buz.inbox / buz.outbox / buz.purge / buz.accept positional 1 completes as a selector (any session ref + @swarm
- `src/state.ts` — Add an optional callback hook (or exported helper) `onTransition(prev: BeeState, next: BeeState, record: SessionRecord)` consumed by the daemon. For the buz integration we don't change derivation; instead the daemon snapshots last-known states and detects active -> idle_with_output transitions itsel

**Schema changes:**
- SessionRecord (src/store.ts): + buzAccept?: ('interrupt' | 'queue' | 'passive')[]  — optional, additive, forward-compatible. Missing/empty means 'all three tiers accepted'. Unknown enum members on load are dropped silently. No migration of existing records required.
- Ledger events (~/.hive/ledger.jsonl): + 'buz.send' {type, from, to, tier, deliveredAs, id, downgraded, reason?}, + 'buz.queue.drain' {type, to, ids, count, errors?}, + 'buz.read' {type, bee, id, consumed}, + 'buz.purge' {type, bee, scope: 'read'|'all', removed}, + 'buz.accept.set' {type, bee, tiers}.
- New on-disk layout under HIVE_STORE_ROOT (default ~/.hive): ~/.hive/buz/<safe-bee-name>/{inbox,outbox,queue,read,quarantine}/  and ~/.hive/buz/_external/<safe-sender>/outbox/ for human-originated sends.
- Message file format (YAML frontmatter delimited by '---' lines + Markdown body) stored as <ts>-from-<safe-sender>-<id>.md where <ts> is the sentAt (or deliveredAt for queue->inbox moves) with ':' and '.' replaced by '-' (same pattern as seal.ts).

**Integration points:**
- src/selectors.ts: cmdBuz uses resolveSelector(target) for fan-out; treats kind='bee' as 1-element cohort, kind='swarm'/'colony' iterates resolved records. Identical pattern to cmdSend / cmdBrief / cmdSeal.
- src/store.ts: SessionRecord gains buzAccept?: BuzTier[]. normalizeSessionRecord must round-trip the field. setAcceptPolicy delegates to saveSession (atomic write + ledger append). appendLedger receives {type: 'buz.send', from, to, tier, deliveredAs, id} and {type: 'buz.queue.drain', to, ids} events.
- src/state.ts: exports a tiny predicate transitionedToIdleWithOutput(prev,next). The general daemon (designed in the daemon module) calls deriveState on a tick, compares to the previous tick's state per bee, and on a transition calls processQueueForBee(record, daemonContext). buz itself never imports daemon code.
- src/tmux.ts (and future src/substrates/*): processQueueForBee takes a BuzDaemonContext with substrate.sendText/isLive. In phase 2 the daemon constructs this from the bee's substrate field (local-tmux/ssh-tmux). buz is substrate-agnostic; tests inject a fake substrate.
- src/cli.ts: cmdBuz registered in the main switch. Shares acceptsTrust/ensureLive helpers? No: buz never auto-accepts trust prompts because it never spawns. ensureLive is replaced with substrate.isLive at the buz call site.
- src/completion.ts: adds buz subcommands and --tier enum completion; sessionRefs() is reused for --from value completion.
- src/seal.ts: parallel storage shape (per-bee directories under HIVE_STORE_ROOT) and atomicWriteFile helper pattern; buz duplicates the helper privately for clarity (no shared util module yet) OR we extract a small src/fsx.ts shared between seal.ts and buz.ts in a follow-up.
- src/lock.ts: withFileLock used around per-bee queue->inbox transitions and around outbox writes to prevent concurrent senders from clobbering each other (lock file at ~/.hive/buz/<bee>/.write.lock).
- src/ledger (via store.appendLedger): every send and every queue-drain produces a ledger event; the search module (designed separately) will index these.
- Future src/daemon.ts (sibling Phase 2 module): owns the tick loop that calls processQueueForBee. Protocol: on each tick (e.g. every 1s) the daemon: 1) lists sessions, 2) derives state for each, 3) for any bee that transitioned active->idle_with_output AND whose queue/ is non-empty, calls processQueueForBee, 4) on substrate.sendText failure, leaves the file in queue/ and records the error in the ledger for retry. The daemon writes its own heartbeat to ~/.hive/daemon/heartbeat.json; buz queries this file optionally to warn the user when running 'hive buz send --tier queue' if the daemon hasn't ticked recently.

**Module-level open questions:**
- Interrupt tier when recipient pane is dead: spec says 'auto-downgrade or hard-fail'. Recommendation locked in design: auto-downgrade to queue by default; expose --strict-interrupt on `hive buz send` for callers (flows, manager bees) that require synchronous delivery and want a non-zero exit. Confirm this matches Tormod's mental model for human-driven cohort interrupts.
- Cohort interrupt ordering: design pastes serially per bee. If one recipient's substrate.sendText blocks (e.g. ssh-tmux network hang), the cohort stalls. Should we add a per-recipient timeout (e.g. 2s) and downgrade on timeout? Recommendation: yes, default 5s, configurable via HIVE_BUZ_INTERRUPT_TIMEOUT_MS. Confirm.
- Should --consume move to read/ AND update an in-message field, or only move? Recommendation: only move (filesystem state IS the read state). This keeps the file content immutable after delivery. Confirm — alternative is to add readAt to frontmatter on consume.
- Sender attribution from CLI: required and free-form string (must be non-empty). Should we validate that --from matches an existing bee record OR allow human strings like 'tormod' for human-originated messages? Recommendation: allow arbitrary non-empty string; do not require it to resolve to a SessionRecord. This makes it easy for humans to inject messages.
- Outbox storage when the sender is a non-bee string (human): write to a synthetic ~/.hive/buz/_external/<from>/outbox/? Recommendation: yes, but treat _external as a reserved name (validate bee names cannot equal '_external' on spawn).
- Message file naming sanitization: <ts>-from-<sender>-<id>.md — what if <sender> contains slashes or unicode? Recommendation: apply safeName() from store.ts to the sender token in the filename only; the YAML 'from' field stores the raw value.
- Queue daemon retry on substrate failure: should we move bad messages to a quarantine/ folder after N retries to avoid blocking the queue? Recommendation: yes — after 3 substrate.sendText failures, move to <bee>/quarantine/ and continue draining. Confirm.
- buz accept policy update for non-running bees: allowed? Recommendation: yes — the record persists buzAccept regardless of liveness so messages keep arriving on the right tier when the bee restarts.
- Does cohort send guarantee at-most-once delivery if the daemon races a manual send? Recommendation: per-bee write lock ensures serialization but if a flow sends interrupt while a daemon is draining queue, both can succeed (the interrupt arrives in-flow, the queued message arrives later). Document this clearly; do not attempt cross-channel dedupe.

**Verifier — real issues:**
- Spec naming collision: /Users/trmd/Projects/trmd/honeybee/repos/honeybee/HONEYBEE_V2_SPEC.md sections 10 and 19 explicitly call this module 'bus' (file under ~/.hive/bus/, command 'hive bus send', src/bus.ts). The design renames it to 'buz' without justifying the divergence from the spec. The locked decision sheet says 'buz three-tier', so user intent is buz — but spec docs are the source of truth in this repo and will need to be updated in lock-step or this design contradicts the spec the reviewer is told to check against. Either update HONEYBEE_V2_SPEC.md before/with this module, or revert to 'bus'.
- sendMessage signature for 'interrupt' tier conflates two things: it claims to 'paste immediately into recipient pane via substrate.sendText AND drop a copy in inbox/' but only takes `daemon?: BuzDaemonContext` as the substrate carrier. The CLI path (cmdBuz send --tier interrupt) is human-driven, not daemon-driven — yet it MUST be passed a BuzDaemonContext to actually paste. Either rename the parameter to a substrate/transport context and make it required for interrupt, or the CLI must always construct one. Calling sendMessage without `daemon` on tier=interrupt silently downgrades to queue or throws — design does not specify which, and tests don't cover the 'CLI sendMessage with no substrate context, tier=interrupt' case.
- BuzDaemonContext.substrate.isLive(target) does not exist on the current substrate surface. src/tmux.ts exposes hasSession(target) and sendText(target, text) — no isLive. Either the design needs a new export from tmux.ts (and a documented contract on the future substrate abstraction) or it must reuse hasSession. The integration list does not enumerate the new tmux export, so this is a missed integration change. ssh-tmux substrate (also Phase 2) must implement the same isLive shape — coordinate with the substrate module review.
- Race / dedupe: design correctly identifies the manual-interrupt vs daemon-drain race but the per-bee write lock only serialises file moves. The locked semantic — 'cross-channel dedupe is explicitly NOT attempted' — is fine, but the queue-drain protocol must not also re-write to the same inbox file naming scheme as the manual interrupt did. Filenames are `<ts>-from-<safe-sender>-<id>.md`; for a queue-drained message the `<ts>` is the deliveredAt (per schemaChanges) but the id is still the original sentAt-anchored id. This is OK, but the design should specify that renaming queue/<original-name>.md → inbox/<original-name>.md preserves the *original* timestamp prefix (avoid rewriting filename), otherwise the daemon may collide with concurrent direct-interrupt files. Spec says rename to deliveredAt — clarify.
- Spec §6 state machine: 'idle_with_output' is the first idle-after-output. The daemon trigger 'active -> idle_with_output' will only fire once per work cycle — but what if a bee transitions ready -> idle_with_output (e.g. boot completes without ever going through 'active'), or active -> blocked -> idle_with_output? deriveState() in src/state.ts allows these paths. The transitionedToIdleWithOutput predicate as described ('predicate over prev,next') would miss the ready→idle_with_output path. Recommend the predicate trigger on ANY transition INTO idle_with_output from non-idle_with_output, OR be explicit about which prior states qualify. The design is too narrow as written.
- BuzMessage.deliveredAs is committed to disk at send time for tier=interrupt and tier=passive (good), but for tier=queue the queued file has `deliveredAs: 'queue'` and `deliveredAt: undefined`. When the daemon drains and moves to inbox/, it must REWRITE the YAML frontmatter to set `deliveredAt`. The design says 'fills deliveredAt' but does not spell out that this is an in-place YAML rewrite under withFileLock, and that this is NOT atomic across rename+rewrite. Either rewrite-then-rename, or accept that deliveredAt may be momentarily inconsistent with location. Spec the order.
- Sender attribution policy creates a spoofing/audit hole: 'allow arbitrary non-empty string' for --from means any human can spoof CL.cc9 as the sender on a tier=interrupt to another bee, and the recipient cannot tell humans from bees. Design should at minimum (a) prefix human senders with a reserved marker (e.g., `human:tormod`) AND (b) reject --from values that collide with reserved tokens or live bee names unless --as-bee is passed. The current 'reserve _external' guard only protects bee-naming, not message provenance. Recommend stricter from-validation.
- openQuestion item 7 (quarantine after N retries) is treated as resolved-by-recommendation but the schemaChanges add a quarantine/ directory without enumerating a 'buz.quarantine' ledger event. If retries are part of the design, the schema and tests must cover it (currently no test for quarantine behaviour, no purgeMailbox scope for quarantine/, no listMailbox for inspection).
- Ledger pressure: every buz.send is one event; cohort send to a 100-bee colony writes 100 ledger events under the appendLedger file lock. Phase 1 ledger locks per write. Under a daemon-drain + cohort-send concurrent path this could starve unrelated ledger writers. Add a batched buz.cohort.send event {to[], ids[], byTier} for cohort fan-out and keep per-recipient detail only where audit demands it.

**Verifier — missing pieces:**
- No command to inspect the QUEUE for a bee from the CLI. cmdBuz lists send|inbox|read|outbox|purge but not queue, even though listQueue() is exported. Add `hive buz queue <selector>` (read-only visibility for the user, especially important when the daemon is suspect).
- Completion mismatch: design adds 'accept' to BUZ_SUBCOMMANDS but the CLI section only enumerates five subcommands (send|inbox|read|outbox|purge) plus a stray 'accept' subcommand mentioned in passing. Reconcile the canonical list; ensure completion, help, and dispatcher all agree.
- Help text for `hive buz` and its subcommands is referenced ('Add help text entries for buz') but not enumerated. Phase 1 modules added a help section per command — make sure printHelp() in cli.ts gains the buz block, including --strict-interrupt and HIVE_BUZ_INTERRUPT_TIMEOUT_MS env var.
- Daemon heartbeat dependency for the warning case ('hive buz send --tier queue warns when ~/.hive/daemon/heartbeat.json is stale') is named but not designed: no path constant, no heartbeat shape, no staleness threshold. This is a hard dependency on the daemon module — the daemon design must own that constant, and the buz module must IMPORT it (not duplicate the path). Add an integration call-out.
- Cohort fan-out concurrency for tier=interrupt: openQuestion 9 proposes bounded concurrency (default 8) and a per-recipient timeout (default 5s, HIVE_BUZ_INTERRUPT_TIMEOUT_MS). These are not in the publicAPI (BuzSendOptions has no concurrency or timeoutMs), and tests do not cover them. Add to BuzSendOptions / sendCohort and to the test list.
- purgeMailbox does not list a 'quarantine' scope despite quarantine/ being added to schemaChanges. Either add `purgeMailbox(name, { quarantine: true })` or drop quarantine until a follow-up.
- No CLI command to delete/cancel an individual queued message. If a user buz sends with --tier queue and wants to revoke before the daemon drains, they have no recourse other than `hive buz purge --all`. Consider `hive buz cancel <selector> <id>` or document the gap.
- No mention that ledger events MUST NOT include the message body. Search includes the ledger but excludes transcripts per locked decisions; if body leaks into the ledger, that bypasses the transcript-exclusion intent. The design's schemaChanges enumerate fields and do NOT include body — good — but state this explicitly as a contract.
- Test for: BuzDaemonContext is undefined and tier=interrupt — does sendMessage throw or auto-downgrade? Tests don't cover. Same for tier=passive (should succeed without daemon) — covered implicitly but call it out.
- Test for: malformed buzAccept on disk (e.g. an old session record with buzAccept = 'all' string instead of array, or buzAccept = ['unknown-tier']). Design says drop silently but tests don't probe.
- Test for: 'hive buz accept' against a SessionRecord that does not yet exist (typo, dead bee) — design says 'allowed for non-running bees' but there is no test for the loadSession-returns-null path.

### `flow` — verdict: `revise`

**Summary:** The flow module is the Honeybee v2 Phase 2 orchestration layer: users author multi-bee workflows either as TypeScript (`defineFlow({...})` via a published SDK module) or as a declarative JSON step list, register them with `hive flow define`, and execute them with `hive flow run [--background]`. Registry storage mirrors the existing frame module (`~/.hive/flows/<name>.{ts,json}` plus `<name>.source` provenance, TS loaded via dynamic import under tsx with the same degraded-mode error). The runtime constructs a `hive` facade that wraps existing modules (spawn from cli.ts, send/brief/wait/kill/seal via selectors + tmux + seal + wait + readiness) and routes every action through the run's log. JSON flows are compiled into an equivalent `run(ctx)` closure with `{{...}}` variable substitution and the same supported ops. `--background` re-execs the hive binary as a detached child writing to `~/.hive/runs/<runId>/{meta.json,log.txt,result.json}` (atomic writes, status transitions appended to ledger), and `hive flow cancel` SIGTERMs the run's process-group. Phase 2 implements Level 1 resumability only (no checkpoints); the on-disk layout is forward-compatible so Level 2 can layer steps/checkpoints later. The module is purely additive: no existing CLI verb changes, SessionRecord gains two optional `runId`/`flowName` fields, and a new ledger event family `flow.*` is introduced.

**New files:**
- `src/flow/index.ts` — Core types (Flow, BeeHandle, FlowContext, FlowRunMeta, FlowRunStatus), registry CRUD (listFlows, loadFlow, defineFlowFromFile, removeFlow, flowExists), runId allocation, run directory helpers, and exports re-imported by the package entry point. Mirrors the frame.ts structure: JSON + TS sources side-by-side under ~/.hive/flows/, with a <name>.source provenance file. (~320 LoC)
- `src/flow/sdk.ts` — Factory `createHive(runCtx)` that builds the runtime `hive` facade injected as `ctx.hive` into user flows. Wraps spawnBee (extracted helper from cli.ts), selectors.resolveSelector for targets, tmux.sendText, readiness.waitForAgentReady, wait.waitForIdle, seal.recordSeal/loadLatestSeal, plus collect() and a log() that writes to the run's log.txt. Defines BeeHandle (carries id, name, tmuxTarget) and the `target = BeeHandle | string` coercion. (~280 LoC)
- `src/flow/run.ts` — Runtime entry point: loadFlowByName, allocate runId + write meta.json (status=running), open log stream, wrap user run() in try/catch, write result.json + final meta.json on success/failure/cancel. Handles arg parsing (string array of key=value -> Record<string,string>), timeout, SIGTERM trap to mark cancelled, and emits ledger events flow.start, flow.end. Foreground entry; also the entry the background fork re-executes. (~240 LoC)
- `src/flow/json.ts` — JSON-to-Flow adapter: parseJsonFlow validates shape (args list, steps array of supported ops), then compileJsonFlow returns a Flow with a synthetic run(ctx) that iterates steps. Implements {{...}} substitution over a Bindings map (args + spawn bindings + step `bind` outputs). Supports ops: spawn, send, brief, waitForSeal, wait, kill, seal, log, return. Documents that loops/conditionals require TS. (~260 LoC)
- `src/flow/background.ts` — Fork helper: spawnDetachedRun(flowName, args, runId) — re-execs `process.execPath` with `[hiveEntryPath(), '__flow-exec', runId]` using `detached:true, stdio:['ignore', logFd, logFd], cwd:runDir`, child.unref(). Also exposes attachToRun (tail log file via fs.watch+read). Cancellation: cancelRun reads meta.json.pid, sends SIGTERM to -pid (negative = pgid) with a 3s grace then SIGKILL, marks meta.status='cancelled'. (~180 LoC)
- `src/flow/runs.ts` — Run inventory + lifecycle helpers: listRuns (scan ~/.hive/runs/, newest first), loadRunMeta, updateRunMeta (atomic merge), tailRunLog (poll-based like cli followTail), runStatus aggregator that consults isProcessAlive(pid) to upgrade stale 'running' meta to 'orphaned' when pid is gone. Keeps run state on disk only; no in-memory caches. (~200 LoC)
- `src/hive.ts` — Public SDK barrel: re-exports `defineFlow` (typed identity helper), `Flow`, `BeeHandle`, `FlowContext`, `SealArtifact`, `SealRecord` so user-authored TS flows can `import { defineFlow } from 'honeybee'` or `from '<path-to-cloned-repo>/dist/hive.js'`. Also re-exports types only — no runtime side-effects at import time. (~40 LoC)
- `tests/flow/registry.test.ts` — Unit tests for define/list/load/remove of JSON and TS flows; name validation; source provenance round-trip; HIVE_STORE_ROOT isolation via temp dirs. (~180 LoC)
- `tests/flow/json.test.ts` — Unit tests for JSON parser, op validation, {{var}} substitution (args + bindings + nested ${reviewer.id}), unknown op error, return value pass-through. (~220 LoC)
- `tests/flow/run.test.ts` — Integration test: stub the hive facade (inject a fake spawnBee/sendText/waitForIdle/recordSeal), execute a TS flow and a JSON flow end-to-end, assert meta.json transitions, log.txt content, result.json shape. (~260 LoC)
- `tests/flow/background.test.ts` — Spawn a real detached child running a trivial JSON flow that writes a sentinel, assert it survives parent exit (via setsid/pgid check), then cancel and assert SIGTERM cleanup. Skipped on Windows. (~160 LoC)

**Modified files:**
- `src/cli.ts` — Add `case 'flow': await cmdFlow(parsed); break;` to main switch. Add cmdFlow dispatcher with subhandlers: flowDefine, flowList, flowInspect, flowRemove, flowRun, flowRuns, flowLogs, flowStatus, flowCancel, and a private '__flow-exec' (hidden, used by background fork). Add `hive flow ...` rows to pri
- `src/completion.ts` — Add 'flow' to COMMANDS. Define FLOW_SUBCOMMANDS = ['define','list','inspect','remove','run','runs','logs','status','cancel']. Register flow in NOUN_COMMAND_SUBS. Add NOUN_SUB_ARG.flow mapping: inspect/remove/run -> 'flow'; logs/status/cancel -> 'run'. Add FLAG_VALUE_KINDS entries for --arg (no compl
- `src/store.ts` — Add optional `runId?: string` and `flowName?: string` to SessionRecord and extend normalizeSessionRecord's accepted string field list. Forward-compatible additive change, no migration. Add helper `appendLedger` already exists; flow module will use flow.* event types.
- `package.json` — Add `bin` already present. Add `exports` field publishing './hive.js' -> 'dist/hive.js' (and the equivalent TS source under exports condition for development). Add a build step note (no tooling change required; tsc emits dist/hive.js if `tsconfig.json` outDir is set). Document new commands in README
- `PHASE1_TEST_CHECKLIST.md` — (Optional) append a Phase 2 section linking to the new flow tests; non-blocking.

**Schema changes:**
- SessionRecord (src/store.ts) — additive: `runId?: string`, `flowName?: string`. Both are added to normalizeSessionRecord's accepted string field list. Existing records lacking these fields continue to load unchanged.
- Ledger events — new event types appended via appendLedger: { type: 'flow.define', name, source }; { type: 'flow.remove', name }; { type: 'flow.start', runId, flowName, args, background }; { type: 'flow.end', runId, flowName, status, durationMs }; { type: 'flow.cancel', runId, reason }; { type: 'flow.spawn-bee', runId, session, agent }. No schema migration required (ledger is append-only JSONL).
- New on-disk layout at $HIVE_STORE_ROOT (default ~/.hive):
-   flows/<name>.json | flows/<name>.ts          # source
-   flows/<name>.source                          # absolute path provenance, mode 0600
-   runs/<runId>/meta.json                       # FlowRunMeta, atomic-written, mode 0600
-   runs/<runId>/log.txt                         # append-only run log, mode 0600
-   runs/<runId>/result.json                     # return value (if any), atomic-written
-   runs/<runId>/args.json                       # frozen merged args, atomic-written
-   runs/.lock                                   # withFileLock guard for runId allocation
- Forward-compat reservation: runs/<runId>/checkpoints/ directory name is reserved for future Level 2 work; current code MUST NOT write into it.

**Integration points:**
- spawnBee: extracted from cli.ts into a shared internal (either keep in cli.ts and re-export, or move to src/spawn.ts to avoid CLI-from-library cycles). createHive.spawn calls spawnBee directly so flow-spawned bees follow the exact same identity/tmux/SessionRecord path used by `hive spawn`.
- selectors.resolveSelector: createHive coerces a string target into a ResolvedTarget; BeeHandle bypasses the selector path and references the SessionRecord by id for efficiency.
- tmux.sendText, tmux.hasSession, tmux.kill: createHive.send/brief/kill route through these directly with the BeeHandle.tmuxTarget.
- readiness.waitForAgentReady: createHive.brief gates delivery on readiness (same defaults as deliverBrief in cli.ts) before sendText.
- wait.waitForIdle: createHive.wait wraps this with the run's AbortSignal; throws a typed FlowCancelledError if the signal fires.
- seal.recordSeal/loadLatestSeal/listSeals: createHive.seal/waitForSeal use these. waitForSeal mirrors cli.ts's waitForSeal polling loop, additionally awaiting the AbortSignal.
- store.appendLedger: new event types `flow.define`, `flow.remove`, `flow.start`, `flow.end`, `flow.cancel`, `flow.spawn-bee` (the last one supplements session.save with the run-bee linkage).
- store.SessionRecord: bees spawned inside a flow get runId/flowName set on the SessionRecord so `hive list` can show flow provenance later (phase 2 reads but does not render — render is future enhancement).
- frame.ts: pattern for TS-via-dynamic-import + helpful error is copied (the helper `loadTsModule` will be extracted into a tiny src/tsLoader.ts shared by frame and flow). Same FRAME_NAME_RE regex pattern reused for FLOW_NAME_RE.
- completion.ts: flows + runs feed flow completion. Performance note: listRuns scans only run dirs, names, and the meta.json's status/startedAt header — log.txt is never read.
- cli.ts printHelp: add `flow <list|define|inspect|remove|run|runs|logs|status|cancel>` row + a separate `flow run` row that shows --background and --arg.
- package exports: dist/hive.js (built via existing tsc setup) is referenced from package.json `exports`. User TS flows authored outside the repo `import { defineFlow } from 'honeybee'` after `npm i honeybee` (or `npm link` for local dev). For users inside the cloned repo, an explicit relative import or the `paths` mapping documented in README.

**Module-level open questions:**
- How does a user-authored TS flow import the SDK? Three viable options: (1) `npm i honeybee` and `import { defineFlow } from 'honeybee'` — clean but requires the package to actually be published; (2) global symlink via `npm link honeybee` from the user's flow dir — works today, document the one-time setup; (3) relative path `import { defineFlow } from '<repo>/dist/hive.js'` — zero setup but ugly. RECOMMENDATION: ship (2) as the documented default with a clear error in loadTsModule that suggests `npm link honeybee` when the import fails with 'Cannot find module honeybee'.
- runId format: ULID gives lexicographic ordering and 26-char compact form, but adds a tiny dep or ~30 lines of code. UUID is in node:crypto for free but not sortable. Hash of (flowName + startedAt + pid) is sortable and free. RECOMMENDATION: monotonic timestamp prefix + 8 random hex chars, e.g. `20260529T143012-7f3a8b21`. Sortable, unique, zero deps, human-readable.
- How do we keep the child alive past parent exit? `child_process.spawn(process.execPath, [...], { detached: true, stdio: ['ignore', logFd, logFd], cwd: runDir })` followed by `child.unref()`. The `detached: true` creates a new session/pgid on POSIX which is also what we need for clean SIGTERM-to-pgid cancellation. On macOS this is sufficient; Windows would need `windowsHide + DETACHED_PROCESS` flags — out of scope for Phase 2.
- Cancel semantics: send SIGTERM to `-pgid` (negative pid = process group). This cascades to any tmux send-keys child processes spawned during the run AND to nested process trees. Wait `graceMs` (default 3000ms) then SIGKILL the group. Inside the runtime, install a SIGTERM handler that AbortController.abort()s the FlowContext.signal, letting wait/waitForSeal exit cleanly and the run write a final meta.json with status='cancelled'.
- args parsing format: settled on repeatable `--arg key=value` for parity with how the rest of the CLI handles repeated flag values (e.g., `hive spawn` accepts repeated `--home`). Reject keys with `=` in the name. ALSO accept `--args-file path.json` for callers passing large/structured args; values from --arg override --args-file. Document explicitly: JSON flows only see string values; if a user needs typed args they should switch to TS.
- Variable substitution scope in JSON: do we allow nested traversal like `{{result.spawnedBees.0.id}}`? RECOMMENDATION: support dot-path for binding objects (BeeHandle has .id/.name/.tmuxTarget/.cwd/.agent), but reject array indexing and method calls in Phase 2 to keep the parser small. Document that anything beyond `.field` requires TS.
- Concurrency model in JSON flows: only sequential steps are supported. Should we add a `parallel: [steps...]` op? RECOMMENDATION: NO for Phase 2; document that parallelism requires TS (`await Promise.all([...])`). Keeping JSON purely linear protects us from designing a step-dependency graph this phase.
- What happens to spawned bees on flow failure/cancel? RECOMMENDATION: by default, leave them alive (matches the `hive run` --keep default). Add a flow-level `cleanup: 'kill-on-end' | 'keep'` option in JSON metadata and a `ctx.hive.killAll()` convenience. Document the user-takes-responsibility default loudly in the help text.
- Should `hive flow run` without --background block until completion and stream the log to stdout? RECOMMENDATION: yes — foreground runs use the same executor synchronously and pipe ctx.log to stdout. --background returns the runId immediately. Matches user expectation from `hive run` defaults.
- Run retention: ~/.hive/runs/ will grow unbounded. Should `hive clean` learn to prune old runs? RECOMMENDATION: out of scope this phase; document `--older-than` as a follow-up. The directory layout already supports a future `hive flow runs --clean --older-than 7d`.
- Should JSON flows be allowed to call sub-flows? RECOMMENDATION: NO in Phase 2. TS flows can trivially do this by importing other flows and awaiting `executeFlow`. JSON sub-flows would require a `flow: <name>` op — defer to a future phase.

**Verifier — real issues:**
- BeeHandle exposes `tmuxTarget` directly, which leaks a substrate detail Phase 2 is meant to abstract away (ssh-tmux ships this same phase). When a flow spawns a bee on ssh-tmux the local tmux target is the wrong handle — createHive must route through a substrate adapter rather than embedding `tmuxTarget` in BeeHandle.
- No integration story for the daemon. Locked decision: the daemon is general (launchctl-managed) and not buz-only. The design backgrounds a run by re-execing hive directly with `detached:true + unref()`, completely bypassing the daemon. Either the daemon hosts/tracks background runs (then this design contradicts the locked decision) or background runs are deliberately a separate process tree (then say so loudly and explain how `hive flow runs` reconciles with daemon-managed processes).
- No buz integration in the HiveFacade. Locked decision keeps buz three-tier with per-bee acceptance policy. Flows are mechanical recipes and the natural surface for buz `send/receive/await` is exactly this facade. Omitting it forces flow authors back into raw send/wait — a meaningful integration gap with the buz module.
- Redundant ledger event `flow.spawn-bee`. saveSession already emits `session.save` carrying the SessionRecord, and the additive `runId`/`flowName` fields will appear in that event automatically. A separate `flow.spawn-bee` event duplicates information and risks the two diverging.
- Cancel semantics handle background runs but not foreground. SIGTERM-to-pgid + the in-process AbortController is described only for `hive flow cancel <runId>` against a background run. The foreground path needs a SIGINT handler that aborts the FlowContext.signal and writes `status='cancelled'`; otherwise Ctrl-C in foreground leaves meta.json stuck at `running`.
- ctx.hive.spawn() recommended to default to no-swarm. That contradicts the spec's swarm-as-cohort model and means a JSON flow that spawns 100 bees produces 100 ungrouped sessions — `hive ps @<swarm>` won't show them as a cohort, and there is no path to spawn `--frame` from inside a flow. Either default to creating an implicit swarm keyed by runId (so `@<runId>` works), or expose `spawnFrame` and `spawnMany` SDK helpers.
- `{{var}}` substitution + literal escape `\{{` is under-specified for nested SealArtifact JSON. The `seal` op takes an inline artifact object whose string fields presumably should also be substitutable, but `substitute()` is described as operating on string templates only. Either declare artifacts pass-through (no substitution inside) or specify a tree walk over string leaves.
- `hive flow logs --follow` semantics use fs.watch on macOS in some places — node's fs.watch is famously unreliable for append-only files on Darwin (truncates, recreates). The design says "poll-based like cli followTail", which is the right call, but tailRunLog should explicitly use the same poll loop, not fs.watch.

**Verifier — missing pieces:**
- printHelp() addition is mentioned but the actual help row content for `flow run` should include `--background`, `--arg`, and `--args-file` — easy to forget given the existing terse table.
- completion.ts needs a new FLAG_VALUE_KIND for `run` (run-id values) and a `runs?: RunSummary[]` carrier on CompletionState — design names these but does not show the wiring change in resolveFlagValueCandidates (which is currently a closed switch).
- `hive flow inspect <name>` is listed but not specified — what does it print? Source path? Compiled step list? Arg spec? Frame's inspect prints structured output; flow's should match.
- No `--watch` for `hive flow status` even though `hive ps --watch` is the precedent.
- Atomic-write discipline is called out for meta.json/result.json/args.json, but log.txt is plain append. The design should state explicitly that partial-line crashes are tolerated and consumers must be line-tolerant.
- No story for run retention. listRuns scans `~/.hive/runs/`; without a `hive clean --runs` path, this directory grows forever. Recognized in openQuestions but deferring it entirely means the very first long-lived install will accumulate runs.
- Ledger event family lists `flow.start/end/cancel/define/remove/spawn-bee` but omits a `flow.update` event for re-defining an existing flow (frame.define vs frame redefine has the same gap upstream — fine to mirror, but worth noting).
- Test list does not cover the SIGTERM-handler-installs-AbortController behavior inside the runtime — only the external cancelRun path. The in-process abort wiring is the load-bearing piece and needs its own unit test.
- The `__flow-exec` hidden command should be flagged as not-discoverable by completion (currently the completion list adds all subcommands — `__flow-exec` must be excluded explicitly).

### `search` — verdict: `accept-with-tweaks`

**Summary:** Adds `hive search <query>` and a focused alias `hive seals find <query>` over three corpora — seals, ledger, session records (transcripts deliberately excluded). Pure, dependency-injectable search logic in `src/search.ts` returns ranked `SearchHit[]` ordered seals > ledger > sessions, each section sorted by recency. CLI in `src/cli.ts` formats hits in pretty grouped sections (with highlighted snippets and tildified paths), TSV (default for non-TTY), or `--json`. Filters: `--colony`, `--swarm`, `--bee`, `--since`, `--status` (seals only), `--type seals|ledger|sessions`. Search modes: substring (default, ASCII case-insensitive unless `--case`) or `--regex`. Snippet windows are 120 chars wide (40 before / 80 after the first match per record). Default `--limit 30`, `--limit 0` = unlimited. No new runtime deps; reuses `parseAge` (clean.ts), `tildify`/`bold`/`dim`/`cyan` (format.ts), `safeName` (store.ts), `listColonies` and `listSwarms` for filter validation, `listSessions`/`sealedBeeNames`/seal directory walk for the corpus, and the existing ledger.jsonl file. Forward-compatible: no schema mutation, purely additive CLI verbs, falls back gracefully when seals/ledger are absent.

**New files:**
- `src/search.ts` — Pure search engine: matcher construction (substring/regex, case sensitivity), corpus reader interfaces, per-source scanners (seals/ledger/sessions), filter application (--colony/--swarm/--bee/--since/--status/--type), snippet windowing with match offsets, ranking and limiting. Exports runSearch(options, corpus?) -> SearchHit[] with optional injected corpus for tests. (~360 LoC)
- `tests/search.test.ts` — Unit tests for the pure layer: matcher behavior (case, regex), per-source filtering, --since, --colony, --status, snippet windowing edge cases, ordering across sources. End-to-end CLI tests using HIVE_STORE_ROOT temp dir for pretty/TSV/JSON outputs, including the `seals find` alias. (~380 LoC)

**Modified files:**
- `src/cli.ts` — Add imports from ./search.js (runSearch, SearchHit, SearchOptions, SearchType). Register two new switch arms: `search` -> cmdSearch(parsed), and inside cmdSeals add subcommand `find` mapped to cmdSealsFind(parsed). Implement cmdSearch: parse query (parsed.args[0]; allow multi-token via parsed.args.j
- `src/completion.ts` — 1) Add 'search' to COMMANDS array and to SESSION_ANY-like handling only for the --bee flag value (not for positional). 2) Add FLAGS_BY_COMMAND.search = ['--type','--colony','--swarm','--bee','--since','--status','--regex','--case','--limit','--json']. 3) Register noun subcommands: extend SEAL_SUBCOM
- `package.json` — No new dependencies. Optionally bump description or add an entry under bin if a separate executable were desired (not required). Likely no change.

**Schema changes:**
- No SessionRecord schema changes. The new SearchHit, SearchOptions, SearchResult, and Corpus*Entry types live in src/search.ts and are not persisted.
- No ledger event schema changes; ledger remains an append-only JSONL with `ts` and `type` plus event-specific fields. Search only READS the ledger.
- No SealRecord changes; search reads existing records via listSeals + raw text of the seal file for substring matching.
- (Optional, recommended) Export `ledgerPath(): string` from src/store.ts so search.ts uses the canonical ledger path. This is additive (new export), not a schema change.

**Integration points:**
- src/store.ts: import listSessions, type SessionRecord, safeName. SessionRecord field set drives sessionSearchableText (name, agent, command, lastPrompt, brief, notes, cwd). Ledger path is computed locally (join(root, 'ledger.jsonl')) mirroring store.ts's private helper — see open question about exporting ledgerPath().
- src/seal.ts: import type SealRecord, type SealStatus, SealType. Walk sealsRoot() directly OR re-use sealedBeeNames() then per-bee listSeals(). Recommended: walk readdir(sealsRoot(), {withFileTypes:true}) for directory list, then readdir each subdir for .json files to avoid double-parsing; only parse JSON when a substring/regex pre-test on the raw text hits (perf), then validate via validateSealArtifact for typed fields like status filtering. Need to read the file twice OR keep raw alongside parsed record — store both on SealCorpusEntry.
- src/colony.ts: import listColonies, colonyExists for --colony validation (warn + exit non-zero on unknown colony).
- src/swarm.ts: import listSwarms, swarmIds for --swarm validation; strip leading '@' for symmetry with selectors.
- src/selectors.ts: import resolveSelector for --bee <ref>; only accept kind === 'bee' (reject swarm:/colony: refs with a clear error directing users to --swarm/--colony).
- src/clean.ts: import parseAge for --since parsing — share the exact same duration grammar (30m/2h/7d/4w/6mo/1y).
- src/format.ts: import bold, cyan, dim, gray, isPretty, tildify, formatTable, truncate. Match highlighting wraps the matched range in bold(cyan(...)) when isPretty(); fall back to raw text otherwise. Section headers via bold + dim count badge (e.g., 'SEALS  12').
- src/parse.ts: extend BOOLEAN_FLAGS with 'regex' and 'case' so they are recognized as flag-only (no value). Note: 'json' already in BOOLEAN_FLAGS.
- src/cli.ts: register switch arms; add usage strings to printHelp(); ensure 'seals' noun verb routes through a new cmdSeals dispatcher (today there's a 'seal' verb, not 'seals' — introduce a parallel 'seals' command for the `seals find` alias without breaking `seal` singular).
- src/completion.ts: add 'search' and 'seals' to COMMANDS, wire FLAGS_BY_COMMAND.search, add per-command flag-value resolution for --type and --status, route 'seals find' as a noun subcommand with no further positional completion (free-text query).

**Module-level open questions:**
- Should we export `ledgerPath()` (and `ledgerStream()`) from src/store.ts so search.ts can stream the JSONL without duplicating the root-directory logic? Currently ledgerPath() is private. Recommendation: yes, export readonly path getter to keep the source of truth in store.ts.
- If a query is multi-token (`hive search foo bar`), do we treat it as a single phrase ('foo bar') or AND of two substrings? Recommendation: join with a single space and treat as one phrase, matching grep --fixed-strings behavior; AND-of-terms can be added later via a comma-separated --all flag.
- How should we score within a source? Strawman: recency-only (matchedAt desc) with no token-frequency weighting in v1; reserve `score` field on SearchHit for future use (currently set to 1 for seals, 0.5 for ledger, 0.25 for sessions to encode source weighting in sortable form). Confirm OK to leave intra-source scoring purely recency-based.
- For ledger correlation, the `session` field on most ledger events is the bee name. For events that lack `session` (colony.*, swarm.*, frame.*), do we still surface them under a 'no bee' bucket, or hide them when --bee is set? Recommendation: surface them in the general search but exclude them whenever --bee or --colony or --swarm is set (no way to verify membership).
- Snippet for ledger: the JSONL line is already structured. Do we render the raw JSON line as the snippet or extract a human field like event.type + relevant value? Recommendation: render raw JSON line, windowed around the match, since the corpus is small and users want to grep faithfully. Pretty mode dims the keys around the match to highlight context.
- Should seal corpus include the seal file's JSON keys themselves (so a search for 'risks' hits every seal that defines risks)? Recommendation: NO — search the JSON-stringified record but skip key names by searching record values only via a serializeSealValues() helper that joins summary, type, status, filesChanged, testsRun.notes, risks, nextActions with newlines. This avoids surfacing schema noise.
- Do we cap ledger scan size? A 10MB ledger has ~50–100k lines. Synchronous full scan is fine for v1; readline streaming keeps memory bounded. Confirm we should not pre-build an index in this phase (per the user decision: 'No external index').
- Should `--type` accept comma-separated values (e.g., `--type seals,ledger`) in addition to repeated flags (`--type seals --type ledger`)? Recommendation: support both; parse.ts already collects repeated flags into a string[]; add a comma-split in cmdSearch.
- Do we want a `--no-snippet` flag (path-only mode)? Useful for piping to xargs. Recommendation: defer — easy to add later; TSV without snippet column can be done with `cut -f1-3`.

**Verifier — real issues:**
- Ledger rotation gap: store.ts rotates `ledger.jsonl` to `ledger.jsonl.<suffix>` once it exceeds HIVE_LEDGER_MAX_BYTES (default 10MB). The design reads ONLY `ledger.jsonl` and will silently miss rotated history. For an 'archaeologist' tool (spec section 12), this defeats the primary use case on long-lived stores. Search must enumerate `ledger.jsonl*` (sorted ascending by suffix) or document the limitation prominently.
- Cross-source colony/swarm filter is unsound when SessionRecord has been deleted. Seals live on disk after `hive run --rm` removes the SessionRecord; ledger lines reference `event.session` which may no longer resolve. Today the design 'silently filters out' those entries when --colony/--swarm is set, which means a perfectly valid seal becomes invisible. The mitigation (only log via --json `notes`) is too quiet — at minimum print a stderr count in pretty mode, or fall back to seal-record colony hints stamped at seal time.
- `sealsRoot()` and `ledgerPath()` are both PRIVATE in their owning modules. The design implies importing them ('walk sealsRoot() directly' / 'compute ledger path locally mirroring store.ts') which either duplicates path logic or requires module exports the open questions only flag for ledgerPath. Same gap exists for sealsRoot — not listed in openQuestions. Pick one strategy and update the exports list explicitly.
- Match-highlight offset is not threaded through `makeSnippet`. The design returns a snippet string but the pretty formatter must re-locate the match inside the (possibly truncated, ellipsis-prefixed) snippet to wrap it in bold/cyan. Re-running the regex/matcher against the snippet may produce a different first-match offset than the original (e.g., when 'before' includes another occurrence). makeSnippet should return `{ snippet, matchStartInSnippet, matchEndInSnippet }` to make highlighting deterministic.
- `detectFlagValueContext` in completion.ts is global, not command-scoped. Wiring `--type` to 'searchType' globally would pollute completions for any other command that happens to take `--type` later (frame templates, substrate types — both plausible). The design notes this for --status ('gate by current command') but does not apply the same scoping to --type. Real refactor needed in completion.ts to add a `command -> flag -> kind` map, otherwise we create a future foot-gun.
- Regex DoS mitigation is unreliable. The proposal to 'reject patterns containing nested quantifiers via a conservative pre-scan' will both over-reject benign patterns (e.g. `[a-z]+\s+[a-z]+`) and under-reject other catastrophic ones. Per-match wall-clock timeout (or running each line through `RegExp` inside a worker with a hard ms cap) is the only honest mitigation; the simpler and equally safe v1 answer is to make `--regex` use `String.prototype.match` per line (already line-bounded) and cap pattern length to 256.
- `hive seals find` forces `type=['seals']` — but the design does not specify behavior when the user also passes `--type ledger`. Silent override surprises; explicit rejection is friendlier. Same question for `--status` when `seals find` is used with non-seal types implied by absence. Spell out the precedence rule.

**Verifier — missing pieces:**
- FLAGS_BY_COMMAND.seals not specified. The design adds `seals` as a new top-level verb but only wires FLAGS_BY_COMMAND.search. Completion for `hive seals find --<TAB>` will return nothing. Either add `seals` entry mapped to the same flag list as search (minus --type) or implement noun-sub-command flag inheritance.
- `hive ps`/list integration: design does not say what happens when `hive search foo` is run and an active swarm of bees is named `foo-...`. Not a bug — but design should clarify search does not include `SessionRecord.name` collisions with selector syntax (e.g., a query of `@review` is searched literally as text, not parsed as a selector).
- Spec wording uses `hive seals find --repo honeybee`. Design maps this to `--colony` (correct given colony is the repo-like namespace) but does not add `--repo` as an alias. Either add the alias or update help text to nudge users toward `--colony`.
- No mention of `--no-snippet` or `--paths-only` flag — design defers it. Fine, but the TSV section header column order (`type<TAB>path<TAB>beeName<TAB>snippet`) should be locked in the design so downstream consumers can `cut -f1-3` reliably. Today the column order is only in a passing comment.
- No printHelp() table row text drafted. Spec says additive — should pre-write the exact help line (`hive search <query> [--type ...] [--colony ...] ...`) and the `seals find` aliased line to avoid bikeshedding during implementation.
- Behavior when query is an empty string after `--query`-style parsing is undefined. (Design covers missing positional but not e.g. `hive search ''`.)
- Tests do not cover ledger rotation behavior (see real issue #1).

