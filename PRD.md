# Agentpit PRD

## 1. Summary

Agentpit (`ap`) is a local cockpit for starting, steering, observing, and extracting results from interactive agent CLIs through tmux.

It exists because some agents are best used as interactive seats rather than one-shot APIs. Agentpit gives Jancsi/Tormod a structured way to spin up Claude, Codex, OpenCode, Pi, Droid, or other CLIs on demand; send work packets; read transcripts/panes; and route results back into human review.

Desk integration is explicitly out of v0 scope.

## 2. Goals

- Create agent sessions on demand, not only as persistent pre-warmed seats.
- Support multiple agent kinds behind one CLI: `claude`, `codex`, `opencode`, `pi`, `droid`, and arbitrary executables.
- Use tmux as the durable process/session substrate.
- Send prompts safely into interactive TUIs.
- Capture pane output for all agents.
- Read durable transcripts for agents that expose them, starting with Claude, Codex, and OpenCode.
- Keep a lightweight local ledger of sessions and prompts.
- Be useful from both human shell and OpenClaw/Jancsi automation.

## 3. Non-goals for v0

- Desk integration.
- Full provider API abstraction.
- Bypassing account controls or hiding automation as fake human input.
- Perfect semantic completion detection for every TUI.
- Cloud/server multi-user orchestration.
- Web UI.

## 4. Primary Users

### Tormod

Wants to launch and steer agent sessions directly from terminal or via Jancsi.

### Jancsi / OpenClaw agents

Need a small reliable CLI to delegate interactive work to other agents and retrieve outputs.

## 5. Core Concepts

### Agent kind

A named preset that resolves to a command:

- `claude` → `claude`
- `codex` → `codex`
- `opencode` → `opencode`
- `pi` → `pi`
- `droid` → `droid`

Override via env:

```sh
AP_CLAUDE_CMD="claude --model sonnet"
AP_DROID_CMD="python3 ~/bin/droid-agent.py"
```

### Session

A tmux session with metadata in `~/.agentpit/sessions/<name>.json`.

Fields:

- name
- agent
- cwd
- command
- tmuxTarget
- createdAt
- updatedAt
- status

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

Agentpit does not require this format, but higher-level routers should prefer it.

### Transcript provider

Provider-specific reader for durable logs. v0 starts with Claude:

`~/.claude/projects/<cwd-key>/*.jsonl`

## 6. CLI Requirements

### `ap spawn <agent>`

Create an on-demand tmux session.

Options:

- `--name <name>` optional explicit session name
- `--cwd <dir>` working directory
- `-- <args...>` pass-through args to agent command

Example:

```sh
ap spawn claude --name frontend-polish --cwd ~/Projects/trmd/agentpit/repos/agentpit
```

### `ap send <session> <prompt>`

Send text into an existing session using tmux buffer paste + Enter.

### `ap tail <session>`

Capture recent tmux pane output.

Options:

- `-n <lines>` line/window size

### `ap transcript <session>`

Render provider transcript if available.

Options:

- `-n <rows>` last transcript rows
- `--json` raw rows

### `ap last <session>`

Print the latest assistant message from provider transcript.

### `ap list`

List known sessions and whether the tmux session is still live.

### `ap kill <session>`

Kill tmux session and remove metadata.

### `ap run <agent> -p <prompt>`

Convenience: spawn, send prompt, then capture initial pane.

## 7. v1 Requirements / Next Development Targets

### 7.1 `ap wait`

Status: implemented first pass.

Wait until an agent appears quiescent, then print result.

Initial heuristic:

- observe transcript mtime, last assistant text, and pane output hash
- require no change for N seconds
- configurable timeout
- optionally print `--last` assistant text or `--transcript` instead of pane

Example:

```sh
ap wait frontend-polish --idle-ms 3000 --timeout-ms 600000 --last
```

### 7.2 Better Claude transcript matching

Status: first pass implemented.

Claude transcript lookup now scores candidates by explicit transcript path, provider session id, submitted prompt text, since timestamp, and mtime. Further hardening should capture Claude session id directly from initialization output when possible.

### 7.3 Codex transcript reader

Status: first pass implemented.

Parses `~/.codex/sessions/**/*.jsonl`, normalizes user/assistant messages from `event_msg` and `response_item` records, and scores candidates by cwd, prompt, session id/path, timestamp, and mtime.

### 7.4 OpenCode transcript reader

Status: first pass implemented.

Parses OpenCode JSON storage under `~/.local/share/opencode/storage`, joining session, message, and part files into normalized transcript rows. Needs live-session hardening after current OpenCode CLI behavior is exercised through `ap`.

### 7.5 `ap packet`

Send a structured packet from CLI flags or stdin:

```sh
ap packet claude \
  --goal "Improve onboarding UI" \
  --repo ~/Projects/digitech/... \
  --mode plan-only
```

### 7.6 `ap ps` / richer status

Show:

- running/dead
- last prompt time
- last transcript mtime
- last assistant preview
- cwd
- command

### 7.7 Session cleanup

Prune dead sessions and stale metadata:

```sh
ap clean --dead
```

## 8. Safety / Operating Defaults

- Default serious tasks should be plan-first.
- Agentpit should not auto-approve destructive actions.
- External sends/posts remain outside v0.
- `ap` may control interactive sessions, but should not attempt to disguise automation with fake typing randomness or anti-detection behavior.
- Prefer explicit cwd and explicit agent args.

## 9. Implementation Notes

Current stack:

- TypeScript
- Node >= 20
- tmux
- local files under `~/.agentpit`

Current repo:

`~/Projects/trmd/agentpit/repos/agentpit`

Current implemented modules:

- `src/agents.ts` — agent command resolution
- `src/tmux.ts` — tmux wrapper
- `src/store.ts` — session metadata + ledger
- `src/transcripts.ts` — transcript discovery/rendering
- `src/cli.ts` — CLI commands

## 10. Acceptance Criteria for v0 Useful Dev

Agentpit is ready for early development when:

- `npm run build` passes.
- `ap spawn/send/tail/list/kill` works with a dummy shell agent.
- `ap spawn claude` can start a real Claude Code session.
- `ap send <claude-session>` can submit a prompt.
- `ap transcript` or `ap last` can retrieve Claude output from JSONL transcript after a turn.
- `ap wait` can wait for pane/transcript stability and return pane, latest assistant text, or transcript.
- Jancsi can use `ap` from OpenClaw to launch and inspect an agent session.

## 11. Open Questions

- Should default project area remain `trmd`, or should this graduate to `openclaw` if packaged as a plugin?
- Should `ap run` keep or kill sessions by default? Current bias: keep sessions; explicit cleanup is safer.
- Which provider reader needs hardening first under live `ap run`: Codex or OpenCode?
- Should session names be human-readable task slugs by default instead of random suffixes?
