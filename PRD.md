# honeybee PRD

## 1. Summary

honeybee (`hive`) is a local cockpit for starting, steering, observing, and extracting results from interactive bee CLIs through tmux.

It exists because some bees are best used as interactive seats rather than one-shot APIs. honeybee gives Jancsi/Tormod a structured way to spin up Claude, Codex, OpenCode, Pi, Droid, or other CLIs on demand; send work packets; read transcripts/panes; and route results back into human review.

Desk integration is explicitly out of v0 scope.

## 2. Goals

- Create bee sessions on demand, not only as persistent pre-warmed seats.
- Support multiple bee kinds behind one CLI: `claude`, `codex`, `opencode`, `pi`, `droid`, and arbitrary executables.
- Use tmux as the durable process/session substrate.
- Send prompts safely into interactive TUIs.
- Capture pane output for all agents.
- Read durable transcripts for bees that expose them, starting with Claude, Codex, and OpenCode.
- Keep a lightweight local ledger of sessions and prompts.
- Be useful from both human shell and Jancsi automation.

## 3. Non-goals for v0

- Desk integration.
- Full provider API abstraction.
- Bypassing account controls or hiding automation as fake human input.
- Perfect semantic completion detection for every TUI.
- Cloud/server multi-user orchestration.
- Web UI.

## 4. Primary Users

### Tormod

Wants to launch and steer bee sessions directly from terminal or via Jancsi.

### Jancsi / OpenClaw agents

Need a small reliable CLI to delegate interactive work to other bees and retrieve outputs.

## 5. Core Concepts

### Bee kind

A named preset that resolves to a command:

- `claude` → `claude`
- `codex` → `codex`
- `opencode` → `opencode`
- `pi` → `pi`
- `droid` → `droid`

Override via env:

```sh
HIVE_CLAUDE_CMD="claude --model sonnet"
HIVE_DROID_CMD="python3 ~/bin/droid-agent.py"
```

Command overrides are interpreted as argv-style command lines, not shell scripts.

### Session

A tmux session with metadata in `~/.hive/sessions/<name>.json`.

Fields:

- `name` — visible session/bee ID, usually `<prefix><uuid-prefix>` such as `CO.a3f`
- `id` — same visible bee ID, kept explicit for future named sessions
- `prefix` — harness prefix, e.g. `CO.`, `CL.`, `CC.`
- `uuid` — normalized 32-character UUID backing the bee ID
- `agent` — canonical bee kind
- `requestedAgent` — harness/alias originally requested by the user
- `cwd`
- `command`
- `tmuxTarget` — tmux-safe target; may differ from `name` because tmux treats `.` specially
- `createdAt`
- `updatedAt`
- `status`

Bee ID rules:

- Canonical Codex: `CO.`
- Canonical Claude: `CL.`
- Aliases: first two alphanumeric characters of the requested alias, e.g. `cc3` → `CC.`
- Other harnesses: first two alphanumeric characters of the requested/canonical bee kind
- Suffix: shortest unused UUID prefix with at least three hex characters; grow to four, five, etc. as the allocation space is exhausted
- Index: `~/.hive/id-index.json` tracks every allocated UUID so visible IDs are not reused
- Resolution: sessions are referable by the shortest leading prefix unique among currently stored sessions, never shorter than the visible ID

### Work packet

A structured prompt recommended for serious tasks:

```md
Goal:
Context:
Repo/path:
Constraints:
Allowed actions:
Stop condition:
Return format:
```

honeybee does not require this format, but higher-level routers should prefer it.

### Transcript provider

Provider-specific reader for durable logs. v0 starts with Claude:

`~/.claude/projects/<cwd-key>/*.jsonl`

## 6. CLI Requirements

### `hive spawn <agent>`

Create an on-demand tmux session.

Options:

- `--name <name>` optional explicit session name
- `--cwd <dir>` working directory
- `-- <args...>` pass-through args to bee command

Example:

```sh
hive spawn claude --name frontend-polish --cwd ~/Projects/trmd/honeybee/repos/honeybee
```

### `hive send <session> <prompt>`

Send text into an existing session using tmux buffer paste + Enter.

### `hive tail <session>`

Capture recent tmux pane output.

Options:

- `-n <lines>` line/window size
- `-f`, `--follow` keep polling the pane and print changes

### `hive transcript <session>`

Render provider transcript if available.

Options:

- `-n <rows>` last transcript rows
- `--json` raw rows

### `hive last <session>`

Print the latest assistant message from provider transcript.

### `hive list`

List known sessions and whether the tmux session is still live.

### `hive kill <session>`

Kill tmux session and remove metadata.

### `hive run <agent> -p <prompt>`

Convenience: spawn, send prompt, then capture initial pane.

## 7. v1 Requirements / Next Development Targets

### 7.1 `hive wait`

Status: implemented first pass.

Wait until a bee appears quiescent, then print result.

Initial heuristic:

- observe transcript mtime, last assistant text, and pane output hash
- require no change for N seconds
- configurable timeout
- optionally print `--last` assistant text or `--transcript` instead of pane

Example:

```sh
hive wait frontend-polish --idle-ms 3000 --timeout-ms 600000 --last
```

### 7.2 Better Claude transcript matching

Status: first pass implemented.

Claude transcript lookup now scores candidates by explicit transcript path, provider session id, submitted prompt text, since timestamp, and mtime. Further hardening should capture Claude session id directly from initialization output when possible.

### 7.3 Codex transcript reader

Status: first pass implemented.

Parses `~/.codex/sessions/**/*.jsonl`, normalizes user/assistant messages from `event_msg` and `response_item` records, and scores candidates by cwd, prompt, session id/path, timestamp, and mtime.

### 7.4 OpenCode transcript reader

Status: first pass implemented.

Parses OpenCode JSON storage under `~/.local/share/opencode/storage`, joining session, message, and part files into normalized transcript rows. Needs live-session hardening after current OpenCode CLI behavior is exercised through `hive`.

### 7.5 `hive packet`

Send a structured packet from CLI flags or stdin:

```sh
hive packet claude \
  --goal "Improve onboarding UI" \
  --repo ~/Projects/digitech/... \
  --mode plan-only
```

### 7.6 `hive ps` / richer status

Show:

- running/dead
- last prompt time
- last transcript mtime
- last assistant preview
- cwd
- command

### 7.7 Session cleanup

Status: implemented for dead tmux sessions.

Prune dead sessions and stale metadata:

```sh
hive clean --dead --dry-run
hive clean --dead --older-than 7d --dry-run
hive clean --dead
```

The dry-run output includes the age of each dead bee from its last metadata update. `--older-than <age>` filters cleanup to dead bees older than the requested duration.

## 8. Safety / Operating Defaults

- Default serious tasks should be plan-first.
- honeybee should not auto-approve destructive actions.
- External sends/posts remain outside v0.
- `hive` may control interactive sessions, but should not attempt to disguise automation with fake typing randomness or anti-detection behavior.
- Prefer explicit cwd and explicit bee args.

## 9. Implementation Notes

Current stack:

- TypeScript
- Node >= 20
- tmux
- local files under `~/.hive`

Current repo:

`~/Projects/trmd/honeybee/repos/honeybee`

Current implemented modules:

- `src/agents.ts` — bee command resolution
- `src/drivers.ts` — centralized bee driver facts for readiness, home env, and transcript support
- `src/parse.ts` — CLI argument parsing helpers
- `src/readiness.ts` — startup readiness and trust/safety prompt handling
- `src/tmux.ts` — tmux wrapper
- `src/store.ts` — session metadata + ledger
- `src/lock.ts` — lightweight local file lock helper
- `src/transcripts.ts` — transcript discovery/rendering
- `src/wait.ts` — idle detection and wait output handling
- `src/cli.ts` — CLI commands

## 10. Acceptance Criteria for v0 Useful Dev

honeybee is ready for early development when:

- `npm run build` passes.
- `hive spawn/send/tail/list/kill` works with a dummy shell agent.
- `hive spawn claude` can start a real Claude Code session.
- `hive send <claude-session>` can submit a prompt.
- `hive transcript` or `hive last` can retrieve Claude output from JSONL transcript after a turn.
- `hive wait` can wait for pane/transcript stability and return pane, latest assistant text, or transcript.
- Jancsi can use `hive` from OpenClaw to launch and inspect a bee session.

## 11. Open Questions

- Should default project area remain `trmd`, or should this graduate to `openclaw` if packaged as a plugin?
- Should `hive run` keep or kill sessions by default? Current behavior: `hive run --wait` keeps sessions by default; use `--rm` or `--cleanup` to destroy after the wait completes.
- Which provider reader needs hardening first under live `hive run`: Codex or OpenCode?
- Should session names be human-readable task slugs by default instead of random suffixes?
