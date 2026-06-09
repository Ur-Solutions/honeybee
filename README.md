# honeybee

`honeybee` is a small tmux-backed cockpit for interactive AI bees. Its CLI is `hive`.

It creates bee sessions on demand, sends prompts into them, captures panes, and keeps a tiny local ledger. It is inspired by Shannon's practical tmux/transcript idea, but starts broader: Claude, Codex, OpenCode, Grok, Pi, Droid, or any configured command.

## v0 scope

- On-demand session creation
- Send prompts into existing sessions
- Tail/capture panes
- List/kill sessions
- Bee presets: `claude`, `codex`, `opencode`, `grok`, `pi`, `droid`
- Auth-profile aliases: `codex1`, `codex2`, `codex3`, `cc1`, `cc2`, `cc3`
- Human-oriented UUID-backed bee IDs such as `CO.a3f`, `CL.91b`, `CC.07d`
- `hive wait` idle detection via pane/transcript stability
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

hive spawn claude --cwd ~/Projects/trmd/honeybee/repos/honeybee
hive spawn codex2 --cwd ~/Projects/trmd/honeybee/repos/honeybee
hive spawn cc3 --cwd ~/Projects/trmd/honeybee/repos/honeybee
hive send <session> "Please inspect the repo and propose a plan. Do not edit."
hive tail <session>
hive tail <session> -f
hive tail -f <session>
hive wait <session> --last
hive transcript <session>
hive last <session>
hive list
hive clean --dead --dry-run
hive clean --dead
hive kill <session>
```

One-shot cockpit launch:

```sh
hive run claude -p "Review this frontend for polish. Plan only." --cwd ~/Projects/foo --wait --last
```

`hive run --wait` keeps its tmux session by default after printing output. Add `--rm` or `--cleanup` only when you explicitly want the session destroyed after the wait completes. If `--wait` is omitted, `hive` also preserves the session so you can inspect or continue it later.

`hive run` waits for a recognized bee prompt before sending the prompt. It fails closed on startup timeouts, trust prompts, or MCP warnings. `--accept-trust` acknowledges known trust prompts; `--force-send` only overrides a readiness timeout after printing the captured pane excerpt.

```sh
hive run claude -p "Inspect this repo." --accept-trust
hive run codex -p "Try anyway." --force-send
```

`hive spawn` also waits for the bee to reach its prompt, automatically accepting a startup trust/safety prompt (e.g. codex's "Do you trust the contents of this directory?") so the session is usable instead of stuck. Pass `--no-accept-trust` to leave the prompt untouched, or `--no-wait` to return immediately without waiting.

Fire-and-forget shorthand:

```sh
hive x claude "Fix the failing test in ids.ts"
hive x codex2 "Summarize this repo"
```

`hive x <bee> <prompt>` is the quick way to spawn a bee of a given type and hand it
a prompt in one command. It waits for the bee to be ready, delivers the prompt, prints
the bee id, and returns immediately — unlike `hive run`, it does not block to capture
output. Inspect the bee later with `hive tail`, `hive attach`, or `hive wait`. The
prompt is positional (everything after the bee), and spawn flags pass through
(`--cwd`, `--home`, `--name`, `--colony`, `--node`, `--yolo`); `--force-send` overrides
a readiness timeout. For a whole swarm, use `hive spawn ... --count <n>` then `hive send`.

Override a bee command with environment variables:

```sh
HIVE_CLAUDE_CMD="/Users/me/.local/bin/claude --model sonnet" hive spawn claude
HIVE_DROID_CMD="python3 ~/bin/droid-agent.py" hive spawn droid
```

`HIVE_<AGENT>_CMD` is parsed as an argv-style command line, not as shell syntax. Shell metacharacters such as `;`, `$()`, and redirects are passed as literal arguments or rejected when they make the executable invalid. Use `env NAME=value command ...` when an override needs environment variables.

Select a Claude/Codex auth home explicitly:

```sh
hive spawn codex --home 2
hive spawn claude --home ~/.claude-3
```

## Bee IDs

New bees get UUID-backed human IDs by default:

- Canonical Codex bees use `CO.`
- Canonical Claude bees use `CL.`
- Aliases use the first two alphanumeric characters of the requested alias, e.g. `cc3` → `CC.`
- Other harnesses use the first two alphanumeric characters of the requested/canonical bee kind

The visible suffix is the shortest unused UUID prefix with at least three hex characters. If all three-character combinations for a prefix are exhausted, honeybee automatically uses four characters, then five, and so on. The full UUID is stored in the session record and `~/.hive/id-index.json` tracks UUIDs that have ever been allocated.

Sessions can be referenced by the shortest leading prefix that is unique among currently stored sessions, while never shortening below the visible ID. Example: `hive kill CO.a3f` works, and if only one current session begins with a longer full UUID prefix, that longer prefix works too.

Dead session metadata can be pruned after tmux sessions exit:

```sh
hive clean --dead --dry-run
hive clean --dead --older-than 7d --dry-run
hive clean --dead
```

The dry run includes each dead bee's age based on its last session update. Use `--older-than <age>` to prune only stale dead bees; supported units include `s`, `m`, `h`, `d`, `w`, `mo`, and `y`.

## Transcript readers

`hive transcript` and `hive last` now support Claude, Codex, OpenCode, and Grok when their local transcript stores are present. Claude is still the best-tested live path; Codex, OpenCode, and Grok readers are file-store parsers and should be hardened against future provider format changes as we use them.

Bees without a transcript reader yet (Pi, Droid, arbitrary executables) fall back to pane capture for `hive last`, so a completed session can still be harvested instead of failing with a dead-end transcript error.

## Bee defaults

Claude, Codex, OpenCode, and Grok default to their safer interactive modes:

```sh
claude
codex
opencode run --interactive
grok --tools= --disable-web-search --no-subagents
```

Full-permission/yolo mode is explicit:

```sh
hive spawn claude --yolo
HIVE_CODEX_YOLO=1 hive spawn codex
```

Grok keeps the minimal tool profile by default to avoid inherited broken MCP servers.

Pi's interactive CLI does not currently expose an approval/yolo flag in `pi --help`; full built-in tools are enabled by default. Droid exposes its unsafe bypass flag for `droid exec` (`--skip-permissions-unsafe`), not for the interactive TUI path hive uses.

Override with `HIVE_<AGENT>_CMD` if a safer, stricter, or newly-supported bypass profile is needed.


## Phase 2

Phase 2 turns `hive` into a multi-node cockpit on top of Phase 1's local-tmux
core. Everything below is additive — Phase 1 verbs, TSV columns, and storage
shapes are preserved.

- `hive node …` — register `ssh-tmux` endpoints; `hive spawn --node mini01`
  routes through the SSH substrate. The implicit `local` node is always
  available even without a file under `~/.hive/nodes/`.
- `hive substrate list` — see the registered substrate kinds.
- `hive ps` aggregates across nodes, adds `node_unreachable` as a derived
  state, surfaces a pretty-mode `NODE` column when more than one node is
  registered (or always with `--wide`), and leaves piped/TSV output Phase-1
  shaped.
- `hive daemon …` — install/start/stop a launchctl-managed dispatcher that
  ticks every ~2s, derives state, and drains the buz queue. Linux ships a
  systemd unit snippet for copy-paste (no auto-install).
- `hive buz …` — three-tier addressed messaging (`interrupt | queue |
  passive`) under `~/.hive/buz/<bee>/{inbox,outbox,queue,read,quarantine}/`,
  with strict sender attribution (`--sender <bee>` or `--sender-human <name>`)
  and a per-bee `buzAccept` policy. Default when unset:
  `['queue', 'passive']`.
- `hive flow …` — TS or JSON flows registered under `~/.hive/flows/<name>.{ts,json}`,
  run foreground or detached with `--background` (independent process trees,
  not daemon-managed). Cancel signals the run's pgid.
- `hive search …` and `hive seals find …` — retrieval over seals, ledger
  (including rotated `ledger.jsonl.*`), and session records. Transcripts are
  deliberately not searched.

End-to-end manual walkthrough lives in
[`PHASE2_TEST_CHECKLIST.md`](./PHASE2_TEST_CHECKLIST.md).

## Naming notes

The project is now **honeybee**, its CLI is **hive**, and interactive workers are **bees**. New session metadata is written under `~/.hive`; old `~/.agentpit` sessions are still visible for migration safety. The old `ap` binary name remains as a compatibility alias for the same CLI.
