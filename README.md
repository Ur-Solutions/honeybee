# agentpit

`agentpit` (`ap`) is a small tmux-backed cockpit for interactive agent CLIs.

It creates agent sessions on demand, sends prompts into them, captures panes, and keeps a tiny local ledger. It is inspired by Shannon's practical tmux/transcript idea, but starts broader: Claude, Codex, OpenCode, Pi, Droid, or any configured command.

## v0 scope

- On-demand session creation
- Send prompts into existing sessions
- Tail/capture panes
- List/kill sessions
- Agent presets: `claude`, `codex`, `opencode`, `pi`, `droid`
- `ap wait` idle detection via pane/transcript stability
- Provider transcript discovery and rendering:
  - Claude: `~/.claude/projects/<cwd-key>/*.jsonl`
  - Codex: `~/.codex/sessions/**/*.jsonl`
  - OpenCode: `~/.local/share/opencode/storage/**`
- Transcript matching by cwd, prompt, session id/path, timestamp, and mtime
- No Desk integration yet

## Usage

```sh
npm install
npm run build
npm link

ap spawn claude --cwd ~/Projects/trmd/agentpit/repos/agentpit
ap send <session> "Please inspect the repo and propose a plan. Do not edit."
ap tail <session>
ap wait <session> --last
ap transcript <session>
ap last <session>
ap list
ap kill <session>
```

One-shot cockpit launch:

```sh
ap run claude -p "Review this frontend for polish. Plan only." --cwd ~/Projects/foo --wait --last --keep
```

Override an agent command with environment variables:

```sh
AP_CLAUDE_CMD="/Users/me/.local/bin/claude --model sonnet" ap spawn claude
AP_DROID_CMD="python3 ~/bin/droid-agent.py" ap spawn droid
```

## Transcript readers

`ap transcript` and `ap last` now support Claude, Codex, and OpenCode when their local transcript stores are present. Claude is still the best-tested live path; Codex and OpenCode readers are file-store parsers and should be hardened against future provider format changes as we use them.

## Agent defaults

OpenCode defaults to full-permission interactive mode because Tormod typically runs worker agents that way:

```sh
opencode run --interactive --dangerously-skip-permissions
```

Override with `AP_OPENCODE_CMD` if a safer or different profile is needed.
