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
- Claude transcript discovery via `~/.claude/projects/<cwd-key>/*.jsonl`, with prompt/session/path matching
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
ap run claude -p "Review this frontend for polish. Plan only." --cwd ~/Projects/foo --keep
```

Override an agent command with environment variables:

```sh
AP_CLAUDE_CMD="/Users/me/.local/bin/claude --model sonnet" ap spawn claude
AP_DROID_CMD="python3 ~/bin/droid-agent.py" ap spawn droid
```
