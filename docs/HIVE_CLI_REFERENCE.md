# Hive CLI Reference

This is a synthesized reference for the `hive` CLI surface in this repository.
It is based on the TypeScript command handlers in `src/cli.ts` plus the modules
that define agents, selectors, frames, flows, loops, accounts, seals, state, and
storage.

The package exposes two binary names:

- `hive`: primary CLI.
- `ap`: compatibility alias that runs the same CLI.

The current CLI version constant is `0.0.1`.

## Mental Model

Honeybee is a tmux-backed cockpit for interactive AI workers called bees.

- A bee is a tmux session plus a session record under the hive store.
- A bee can run Claude, Codex, OpenCode, Grok, Pi, Droid, Cursor, or any command
  on `PATH`.
- Bees can be grouped into swarms and colonies.
- Frames define reusable swarm blueprints.
- Flows define higher-level automation that can spawn, prompt, wait, seal, and
  clean up bees.
- Loops are a built-in detached flow that repeats a task until a stop condition.
- Buz is the file-backed message bus between bees and humans.
- Accounts are local credential-vault identities that can be activated into
  agent homes.

Default storage root:

```sh
~/.hive
```

Override it with:

```sh
HIVE_STORE_ROOT=/path/to/store hive list
```

Legacy `~/.agentpit` session records are still read for migration safety.

## Parser Rules

The argument parser is intentionally simple.

- The first argv token is the command.
- Long flags use `--flag value` or `--flag=value`.
- Short flags use `-p value`, `-n 20`, `-f`, etc.
- Known boolean flags consume no value.
- Unknown flags consume the next token if it does not start with `-`; otherwise
  they are treated as boolean `true`.
- Repeated flags become arrays. This is used by flags such as `--arg`.
- `--` stops hive parsing. Everything after it goes to the spawned agent command.
- Values that start with `-` should usually use `--flag=value`; this matters for
  `--ssh-args="-F /path/to/config"`.

Internal command names:

- `__complete`: completion engine entrypoint.
- `__flow-exec`: detached background flow child entrypoint.

These are implementation details, not user commands.

## Selectors

Many commands accept a selector.

```sh
hive send CO.a3f "Continue"
hive send @review-swarm "Compare findings"
hive send colony:frontend "Status?"
```

Selector forms:

- `<bee>`: exact session name or unique session/id prefix.
- `@<swarm-id>`: all sessions in a swarm.
- `colony:<name>`: all sessions in a colony.
- `#<tag>` or `tag:<tag>`: all sessions carrying the bare user tag `<tag>`.
- `tag:<ns>:<val>` or `<ns>:<val>` (reserved `<ns>`): all sessions carrying that
  namespaced tag, including the derived reserved facets. `colony:fe` and
  `tag:colony:fe` resolve to the same set; `@t1` and `tag:swarm:t1` likewise.
  Reserved namespaces are `colony`, `swarm`, `caste`, `node`, `agent`, `repo`,
  `quest`, `workspace`, `comb`. Reserved tags are *derived on read* from the
  bee's canonical fields — no migration is needed for existing bees.

`@`, `colony:`, `#`, and `tag:` are **reserved selector prefixes**: a string
beginning with one is parsed as that selector kind, not a bee name. Bee names
are auto-generated (e.g. `CL.a3f`) and never use these prefixes; if you force a
bee name that starts with one (via `--name`), it won't be addressable by that
literal name — pick a different name.

Session references use UUID-backed bee IDs. The visible ID is the shortest
currently unique prefix, never shorter than three hex characters after the
agent prefix, such as `CO.a3f` or `CL.91b`.

Multi-target commands skip dead bees when sensible and report per-target
success. Single-target commands generally fail if the target is not live.

## Bees, Agents, Homes, and Yolo Mode

Built-in agent defaults:

| Bee | Default command | Yolo command |
| --- | --- | --- |
| `claude` | `claude` | `claude --dangerously-skip-permissions` |
| `codex` | `codex` | `codex --dangerously-bypass-approvals-and-sandbox` |
| `opencode` | `opencode run --interactive` | `opencode run --interactive --dangerously-skip-permissions` |
| `grok` | `grok --tools= --disable-web-search --no-subagents` | `grok --permission-mode bypassPermissions --always-approve --tools= --disable-web-search --no-subagents` |
| `pi` | `pi` | `pi` |
| `droid` | `droid` | `droid --settings ~/.factory/hive-droid-yolo-settings.json` |
| `cursor` | `cursor-agent` | `cursor-agent --force` |

Claude defaults to yolo mode unless explicitly opted out. The reserved
`codex-auto` account-picking alias also defaults to yolo; plain `codex` and
other built-in agents use safer defaults unless yolo is requested.

Yolo controls:

```sh
hive spawn claude
hive spawn claude --no-yolo
hive spawn codex --yolo
hive spawn codex --dangerous
HIVE_YOLO=1 hive spawn codex
HIVE_CODEX_YOLO=1 hive spawn codex
hive config set-bee codex --yolo
hive config set-bee claude --no-yolo
```

Home/profile aliases:

```sh
hive spawn codex --home 2       # ~/.codex-2
hive spawn codex2               # alias for codex home slot 2
hive spawn claude --home ~/.claude-3
hive spawn cc3                  # alias for claude home slot 3
```

Alias rules:

- `codex1`, `codex2`, `codex3` -> `codex` with home slot 1, 2, or 3.
- `cc1`, `cc2`, `cc3` -> `claude` with home slot 1, 2, or 3.
- `claude1`, `claude2`, `claude3` -> `claude` with home slot 1, 2, or 3.

Command overrides:

```sh
HIVE_CLAUDE_CMD="claude --model sonnet" hive spawn claude
HIVE_GROK_CMD="grok --model grok-code-fast-1" hive spawn grok
AP_CODEX_CMD="codex --some-legacy-flag" hive spawn codex
hive config set-bee codex --command "codex --model gpt-5"
```

Overrides are split as argv-like shell words, not executed through a shell.
Use `env NAME=value command ...` in the override if the agent needs environment
variables.

## Global Command Surface

Top-level command aliases:

- `list`, `ls`, `ps` are the same command.
- `tail` and `cat` are the same command.
- `transcript` and `tx` are the same command.
- `usage` and `limits` share the account-limit command; `usage --samples`
  switches to local token-sample summaries.

Full user command set:

```text
hive spawn ...
hive run ...
hive x ...
hive xa ...
hive open ...
hive send ...
hive brief ...
hive seal ...
hive tail ...
hive transcript ...
hive last ...
hive wait ...
hive list ...
hive kill ...
hive clean ...
hive attach ...
hive view ...
hive colony ...
hive frame ...
hive swarm ...
hive node ...
hive substrate ...
hive flow ...
hive loop ...
hive buz ...
hive daemon ...
hive search ...
hive seals find ...
hive account ...
hive activate ...
hive login ...
hive swap-account ...
hive usage ...
hive sessions ...
hive sync ...
hive config ...
hive completion ...
hive help
hive --version
```

## Core Session Lifecycle

### `hive spawn`

Start one or more bees in detached tmux sessions and persist session metadata.

```sh
hive spawn <bee> [--name <id>] [--cwd <dir>] [--home|--profile <1|2|3|path>]
  [--account <account>] [--autoswap] [--colony <name>]
  [--brief <text>] [--briefed] [--count <n>]
  [--swarm-id <id>|--swarm <id>] [--node <name>]
  [--substrate <local:name|ssh:name>] [--here] [--yolo|--no-yolo]
  [--accept-trust|--no-accept-trust] [--no-wait] [--boot-ms <ms>]
  [-- <bee-args...>]
```

Single bee:

```sh
hive spawn claude --cwd ~/Projects/app
hive spawn codex --name review-a --home 2 --cwd .
hive spawn codex -- --model gpt-5
hive spawn claude --brief "Context only" --briefed
hive spawn claude --here     # also link the bee's window into your current tmux session
```

`--here` (also on `x`/`xa`): after the normal detached spawn, link the bee's
window into the tmux session you are calling from and select it (a single
bee); `--count > 1` links all windows without stealing focus. Purely
presentational — identity, store record, and lifecycle are unchanged, and the
bee survives the link being closed. Outside tmux the flag warns and is
ignored. Local bees only (`link-window` cannot cross tmux servers).

On spawn the bee's tmux session is also stamped with user options —
`@hive_id`, `@hive_colony`, `@hive_swarm`, `@hive_title`, and `@hive_state`
(`working`/`waiting`/`done`/`failed`, kept current through readiness, prompts,
waits, seals, renames, and daemon observations) — so status bars and scripts
can render hive state straight from `tmux list-sessions -F '#{@hive_state}'`
without touching the store.

Account-bound spawn:

```sh
hive spawn codex --account codex-work
hive spawn codex-work        # <tool>-<account-fragment> shorthand
hive spawn claude-thto --autoswap
hive spawn claude-auto       # least-loaded account pick (also: --account auto)
```

Account-bound spawns activate credentials into a home before launch. Autoswap
requires an account and opts the bee into daemon account swapping when usage is
exhausted.

`auto` is a reserved account query (`--account auto`, or the `<tool>-auto` bee
spec, on `spawn`/`run`/`x`/`xa`/`open`): hive reads the provider limits of every
credentialed account for that tool and picks the one with the least weekly
usage. Accounts ≥90% into their 5h window sort behind ones with headroom, and
accounts whose limits cannot be read are a last resort (oldest registration
wins). The pick is printed to stderr, e.g.
`account auto → claude-thto (weekly 34%, 5h 12%) — least weekly usage`.

The pick reads limits through the cache with a default ttl of **1h**, so
back-to-back auto spawns cost no extra provider round-trips. Override per call
with `--ttl <age>` (`--ttl 0` forces a live read); `hive limits` keeps the
same cache warm.

Homogeneous swarm:

```sh
hive spawn codex --count 3 --colony frontend --swarm-id frontend-review
hive send @frontend-review "Split up and inspect the repo"
```

Constraints:

- `--count > 1` cannot be combined with `--name`.
- `--count > 1` cannot be combined with `--brief` or `--briefed`.
- For swarms, spawn first and then use `hive brief` or `hive send`.

Frame swarm:

```sh
hive spawn --frame review-team --colony frontend --swarm-id review-2026-06
hive spawn --frame review-team --briefed
```

Constraints:

- `--frame` cannot be combined with `--name`.
- `--frame` cannot be combined with `--brief`; caste briefs come from the frame.
- `--briefed` sends each caste brief after readiness.

Readiness behavior:

- Bare `spawn` waits for the agent to reach a prompt unless `--no-wait` is set.
- Startup trust/safety prompts are accepted by default.
- `--no-accept-trust` or `--no-trust` leaves trust prompts untouched.
- Default boot timeouts vary by agent: Claude 15s, Codex 30s, OpenCode 15s,
  Grok 10s, Pi 10s, Droid 5s, unknown agents 10s.

### `hive x`

Fire-and-forget shorthand: spawn one bee, wait until ready, send a prompt, and
return immediately.

```sh
hive x <bee> <prompt> [--cwd <dir>] [--home|--profile <1|2|3|path>]
  [--name <id>] [--yolo] [--force-send] [--boot-ms <ms>]
```

Examples:

```sh
hive x claude "Review this repo and seal with findings"
hive x codex2 "Summarize the architecture"
hive x codex-auto "Run the test suite"   # least-loaded account pick, yolo by default
```

Use `hive tail`, `hive attach`, `hive wait`, or `hive last` later to inspect.

`x` is single-bee only. It rejects `--count > 1` and `--frame`.

### `hive xa`

Spawn one bee and attach to it.

```sh
hive xa <bee> [--cwd <dir>] [--home|--profile <1|2|3|path>]
  [--account <account>] [--name <id>] [--print]
```

Examples:

```sh
hive xa claude --cwd .
hive xa codex-ur --print
hive xa claude-auto              # least-loaded account pick
```

If stdout is not a TTY, or `--print` is set, `hive` prints the tmux attach
command instead of attaching.

### `hive run`

One-shot cockpit launch: spawn a single bee, send a prompt, optionally wait for
completion, and optionally clean up.

```sh
hive run <bee> -p <prompt> [--cwd <dir>] [--node <name>]
  [--wait] [--last|--transcript] [--json] [-n <rows-or-lines>]
  [--idle-ms <ms>] [--timeout-ms <ms>] [--poll-ms <ms>]
  [--rm|--cleanup] [--keep] [--force-send] [--boot-ms <ms>]
```

Examples:

```sh
hive run claude -p "Review this frontend for polish" --cwd . --wait --last
hive run codex -p "Inspect this repo" --accept-trust
hive run claude -p "Fix the test" --wait --last --rm
```

Without `--wait`, `run` sleeps briefly, captures recent pane output, and keeps
the bee. With `--wait`, it waits for idle/blocked/completion and still keeps
the bee unless `--rm` or `--cleanup` is supplied.

Cleanup behavior:

- `--rm` and `--cleanup` kill/remove the session after the run.
- `--keep` cannot be combined with cleanup.
- If the bee is blocked on a permission prompt, cleanup is skipped and exit code
  is nonzero so work is not destroyed.

`run` is single-bee only. It rejects `--count > 1` and `--frame`.

### `hive open`

Run an agent where you are. **Contract changed**: `open` now performs a
*registered* spawn presented in place — inside tmux the bee's window is linked
into your current session (`--here` semantics); outside tmux it spawns and
attaches (`xa` semantics). Either way the bee has a tmux session and a store
record (list/tail/kill/daemon all apply).

The previous behavior — run the agent raw in this terminal, no tmux session,
no record — is now explicit via `--raw`. `--window`/`--app` imply `--raw`
(they target external terminal apps by nature). The old default silently
produced persistent-but-unregistered ghost processes once the daily driver
moved inside tmux.

```sh
hive open <bee> [--raw] [--window] [--app <terminal>] [--cwd <dir>]
  [--account <account>] [--home|--profile <1|2|3|path>] [--print]
  [--yolo|--no-yolo] [<bee-flags...>]
```

Examples:

```sh
hive open claude --account claude-work   # registered bee, linked/attached here
hive open claude --account auto          # least-loaded account pick
hive open claude --resume abc123         # unknown flags still reach the agent
hive open claude --raw                   # old behavior: raw in this terminal, no record
hive open codex --window --cwd .         # external window (implies --raw)
hive open claude -- --print
```

`open` consumes only its own flags. Unknown flags are forwarded to the agent, so
agent-native flags like `--resume` work without `--` in every mode. Use `--`
when you need to pass a flag that `open` itself owns.

Supported terminal apps depend on `src/terminal.ts`; help lists:

```text
wezterm, ghostty, kitty, alacritty, iterm, terminal
```

## Prompting and Context

### `hive send`

Send a prompt to one bee, swarm, or colony.

```sh
hive send <selector> <prompt>
hive send <selector> -p <prompt>
```

Examples:

```sh
hive send CO.a3f "Run the tests now"
hive send @review "Compare notes"
hive send colony:frontend -p "Status update"
```

The prompt is sent into the live tmux pane and recorded as `lastPrompt`.

### `hive brief`

Send a context brief to one bee, swarm, or colony. It waits for readiness before
delivery.

```sh
hive brief <selector> <text>
hive brief <selector> --brief <text>
hive brief <selector> -b <text>
```

Examples:

```sh
hive brief CO.a3f "You are reviewing only the API layer."
hive brief @review --brief "Shared context: focus on regressions."
```

By default, `brief` appends the configured wait footer:

```text
Context only - do not start work yet. Acknowledge briefly, then wait for a follow-up message with the task.
```

Controls:

```sh
hive brief CO.a3f "..." --no-wait-footer
hive brief CO.a3f "..." --no-footer
hive brief CO.a3f "..." --wait-footer "Custom footer"
hive brief CO.a3f "..." --footer "Custom footer"
hive brief CO.a3f "..." --force-send
```

### `hive tag`

Add or remove free-form user tags on one or more bees. A tag is a label: a bare
token like `migration` or a `namespace:value` like `prio:p1`, stored verbatim.
Reserved namespaces (`colony`, `swarm`, `caste`, `node`, `agent`, `repo`,
`quest`, `workspace`, `comb`) cannot be written via `hive tag` — they are
*derived on read* from the bee's canonical fields; use the canonical verb
instead (e.g. `hive spawn --colony` / `hive move`).

```sh
hive tag <selector> <tag>...          # add user tags (stored verbatim)
hive tag <selector> --remove <tag>... # remove user tags (idempotent)
hive tag <selector> --list            # show the bee's full effective tag set
```

Examples:

```sh
hive tag CO.a3f migration prio:p1     # add two tags
hive tag @review-swarm waiting-review # tag a whole swarm
hive tag colony:fe migration          # bulk-tag a colony
hive tag CO.a3f --remove migration    # remove a tag
hive tag CO.a3f --list                # list effective tags (reserved + user)
hive tag CO.a3f colony:other          # rejected: reserved facet, use hive move
```

`<selector>` may be any selector (bee / `@swarm` / `colony:` / `tag:` / `#tag`),
so a single `hive tag` can label an entire cohort; the result reports a count.
Each add/remove writes the record atomically (a `tag.add` / `tag.remove` ledger
event) and best-effort refreshes the session's `@hive_tags` tmux option for
store-free `tmux ls -f` filtering. Tag values forbid whitespace, comma, tab, and
newline; a bee carries at most 32 tags of at most 64 characters each.

Tags are queryable via `hive list --tag` and the `#` / `tag:` selectors:

```sh
hive list --tag migration                 # bees with the user tag migration
hive list --tag migration --tag prio:p1   # conjunctive (AND)
hive list --tag colony:fe                  # derived reserved facet
hive list '#migration'                     # positional tag selector
hive send '#migration' "status?"           # tag selector as a target
```

## Observing Output

### `hive tail` / `hive cat`

Capture or follow a tmux pane.

```sh
hive tail <session> [-n <lines>] [-f|--follow] [--poll-ms <ms>]
hive cat <session> [-n <lines>]
```

Examples:

```sh
hive tail CO.a3f
hive tail CO.a3f -n 120
hive tail -f CO.a3f --poll-ms 500
```

### `hive transcript` / `hive tx`

Render structured provider transcript rows.

```sh
hive transcript <session> [-n <rows>] [--json]
hive tx <session> --json
```

Transcript discovery supports provider stores for Claude, Codex, OpenCode, and
Grok when available.

### `hive last`

Print the most recent assistant text, or the latest seal.

```sh
hive last <session>
hive last <session> --seal
hive last <session> -n <lines>
```

For agents with no transcript provider, `last` can fall back to pane capture
while the session is live.

### `hive wait`

Block until a bee goes idle, is blocked, or produces a new seal.

```sh
hive wait <session> [--idle-ms <ms>] [--timeout-ms <ms>] [--poll-ms <ms>]
  [--last|--transcript|--seal] [--json] [-n <rows-or-lines>]
```

Examples:

```sh
hive wait CO.a3f
hive wait CO.a3f --last
hive wait CO.a3f --transcript --json
hive wait CO.a3f --seal --timeout-ms 900000
```

If the outcome is blocked on an approval/permission prompt, exit code is
nonzero. This prevents shell chains such as `hive wait ... && hive kill ...`
from killing a bee that still needs human approval.

## Listing, Attaching, Killing, Cleaning

### `hive list` / `hive ls` / `hive ps`

Show known sessions with derived state.

```sh
hive list [selector] [--colony <name>] [--swarm <id>] [--node <name>]
          [--state <s>] [--agent <a>] [--repo <name>] [--tag <ns:val>]...
          [--json] [--wide]
hive ps --wide
```

**Faceted filters (conjunctive).** Every filter is an AND: `hive list --colony
frontend --agent claude --state waiting` returns only the bees matching *all*
three. The facets:

- `--colony <name>` / `--swarm <id>` / `--node <name>`: the existing reserved
  facets (swarm accepts a leading `@`).
- `--agent <a>`: exact match on the bee's agent (`claude`, `codex`, ...).
- `--repo <name>`: match on the bee's repo facet — the basename of the bee
  cwd's git top-level (or the cwd basename outside a repo). Two repos sharing a
  basename collide; this is an accepted lossy facet.
- `--state <s>`: match on the bee's state. Accepts the live `@hive_state`
  vocabulary (`working`/`waiting`/`done`/`failed`), the fine-grained `BeeState`
  (`active`, `idle_with_output`, ...), or its display label (`idle`, `offline`).
- `--tag <ns:val>`: match on the bee's effective tag set — a bare user tag
  (`--tag migration`) or a namespaced/reserved tag (`--tag prio:p1`,
  `--tag colony:fe`). Repeats conjunctively: `--tag migration --tag prio:p1`
  returns bees carrying *both*. Composes with every other facet flag.
- positional `[selector]`: a bee / `@swarm` / `colony:<name>` / `#tag` /
  `tag:<...>` selector applied as a filter alongside the flags (an unknown
  colony/swarm errors, consistent with other commands).

**`--json`** emits a machine array regardless of TTY, after all filters are
applied. Each element has the shape:

```json
{
  "ref": "ab12", "name": "...", "id": "...", "title": "...",
  "agent": "claude", "state": "working", "beeState": "active",
  "detail": "...", "colony": "...", "swarm": "...", "comb": "...",
  "node": "local", "repo": "honeybee-build", "cwd": "/abs/path",
  "createdAt": "...", "updatedAt": "..."
}
```

`state` is the live `@hive_state` when the bee is live, else the derived
`BeeState`; `beeState` is always the derived `BeeState`.

States:

- `booting`: live but not ready yet.
- `ready`: live and waiting for a prompt.
- `active`: recently prompted or still active.
- `idle`: live with output after a completed turn.
- `blocked`: permission, trust, or MCP warning prompt.
- `sealed`: latest state has a seal recorded.
- `dead`: tmux session is gone.
- `kill_failed`: previous transactional kill failed.
- `offline`: node unreachable, so liveness is unknown.

Pretty output is tabular. Non-pretty output is TSV-like and keeps a stable
machine shape:

```text
<state>\t<ref>\t<display-name>\t<agent>\t<cwd>\t<command>
```

### `hive attach`

Attach to a bee's tmux session, or print the attach command. Nesting-safe and
node-aware — every path picks the right command for where you are:

- Local bee, outside tmux → `tmux attach-session`
- Local bee, inside tmux → `tmux switch-client` (repoints your current client;
  attaching inside an existing client would nest and is never emitted)
- Remote bee, outside tmux → `ssh -t <endpoint> tmux attach-session ...`
- Remote bee, inside tmux → the ssh attach opens as a new window in your
  current session

`--print` prints the context-appropriate command instead of executing it.

```sh
hive attach <session> [--print]
```

Examples:

```sh
hive attach CO.a3f
hive attach CO.a3f --print
```

### `hive view`

Colony cockpit: link live bees' windows into one ephemeral tmux session
(`view-<name>`) and enter it. Windows are server-level objects — a link is a
second handle onto the same window, so the view renders many bees without
copying or moving anything, and bells/activity flags show up per window.

```sh
hive view <selector> [--name <name>] [--new-client] [--print]
hive view --close <name>
```

Examples:

```sh
hive view @t1                  # cockpit for swarm t1 → view-t1
hive view colony:fe --name fe  # explicit name → view-fe
hive view @t1                  # re-run after the swarm grew: links only new bees
hive view @t1 --new-client     # grouped session (view-t1-2): same windows, independent focus
hive view --close t1           # unlink everything, remove the view
```

Behavior and guarantees:

- Views are ephemeral and tmux-derived: no store records. They are invisible
  to selectors, `list`, and `clean`.
- Re-running `view` dedupes by window id — only bees not already in the view
  are linked.
- `--new-client` creates a grouped session sharing the same windows with
  independent focus (two screens browsing one colony).
- `--close` unlinks every bee window (never `kill-window`, never
  `unlink-window -k`) and then kills only the view session itself. Every bee
  window keeps its home link in the bee's own session, so closing a view is
  provably incapable of killing a bee; if anything refuses to unlink the close
  aborts instead of killing.
- Local bees only — `link-window` cannot cross tmux servers; remote bees are
  skipped with a warning.
- Caveat: `hive kill` on a bee whose window is linked in a view removes the
  bee's session, but the linked window (and the agent process) survives in the
  view until the view is closed.

### `hive split`

Spawn a new sub-bee into the current bee's comb (its tmux session), in an
adjacent pane. This is the "decompose into sub-bees" verb.

```sh
hive split [<bee>] [<agent>] [--brief <text>] [--dir v|h|window] [--cwd <dir>] [--home <h>]
```

- `<bee>` — the parent bee to split from. Omit it (or run from inside a bee's
  pane) to split the **current** bee's comb (resolved via `hive here`).
- `<agent>` — agent kind for the sub-bee (defaults to the parent's agent).
- `--dir v|h|window` — pane placement: `v` (vertical split, default), `h`
  (horizontal split), or `window` (a new window in the same session).
- `--brief <text>` — deliver a brief to the sub-bee once it is ready.
- `--cwd <dir>` — working directory (defaults to the parent's cwd).
- `--home <h>` / `--profile <h>` — home/profile for the sub-bee.

The sub-bee is registered as a **new bee record** carrying `parentId` (the bee
it budded from) and sharing the parent's `combId` and `tmuxTarget`, with its own
`agentPaneId`. A `bee.split` ledger event records the lineage. `hive list` shows
both bees sharing one comb.

### `hive here`

Resolve the bee that owns the current tmux pane — useful for scripts and
keybindings (e.g. `hive split "$(hive here --id)"`).

```sh
hive here [--id] [--json]
```

- `--id` — print only the bee's id.
- `--json` — print full metadata (id, name, agent, cwd, combId, parentId,
  agentPaneId) as JSON.

Resolution prefers `$TMUX_PANE` (matching a bee by `agentPaneId`) and falls back
to the current session name (matching `tmuxTarget`, for solo combs and legacy
bees). Errors cleanly when not inside tmux or when no bee matches.

### `hive kill`

Stop a bee or an entire comb and remove the relevant metadata.

```sh
hive kill <bee> [--comb]
```

- A pane-pinned bee that shares its comb with at least one live sibling is
  dropped with `kill-pane` — **only its pane** goes; siblings keep running and
  the session survives. The record is deleted and a `bee.kill_pane` ledger event
  is emitted.
- A sole/last bee in its comb (or any bee with `--comb`) takes the whole tmux
  session via the transactional kill path.

The kill path is transactional and records `kill_failed` if tmux/session cleanup
does not complete cleanly.

### `hive clean`

Remove stale metadata, kill idle bees, or choose targets in the cleanup TUI.

```sh
hive clean --dead [--older-than <age>] [--dry-run|-n]
hive clean --idle [--older-than <age>] [--dry-run|-n]
hive clean -i
hive clean --interactive
```

Examples:

```sh
hive clean --dead --dry-run
hive clean --dead --older-than 7d
hive clean --idle --dry-run
hive clean -i
```

Age units are parsed by `parseAge` and include units such as `s`, `m`, `h`,
`d`, `w`, `mo`, and `y`.

Important behavior:

- `--dead` deletes records for sessions that no longer exist.
- `--idle` kills live bees in the `idle_with_output` state.
- `-i`/`--interactive` cannot be combined with `--dead`, `--idle`,
  `--dry-run`, or `--older-than`.
- Bees on unreachable or unregistered nodes are not treated as dead.

## Colonies, Frames, and Swarms

### `hive colony`

Manage project-scoped namespaces.

```sh
hive colony list
hive colony create <name> [--description "..."]
hive colony inspect <name>
hive colony archive <name>
hive colony update <name> [--description "..."] [--name <new>]
hive colony rename <old> <new>
```

Examples:

```sh
hive colony create frontend --description "Frontend review work"
hive spawn claude --colony frontend
hive list --colony frontend
hive send colony:frontend "Status?"
hive colony rename frontend ui
```

Renaming a colony cascades to matching session and swarm records.

### `hive frame`

Manage reusable swarm blueprints.

```sh
hive frame list
hive frame define <path-to-frame.json|.ts> [<name>]
hive frame update <name> [path]
hive frame update <path>
hive frame reload <name>
hive frame edit <name>
hive frame inspect <name>
hive frame remove <name>
```

Frame JSON shape:

```json
{
  "name": "review-team",
  "description": "One architect and two implementers",
  "castes": [
    {
      "name": "architect",
      "bee": "claude",
      "count": 1,
      "brief": "Own architecture review.",
      "home": "1"
    },
    {
      "name": "implementer",
      "bee": "codex",
      "count": 2,
      "brief": "Inspect implementation details."
    }
  ]
}
```

Rules:

- Frame names and caste names must match `[A-Za-z0-9][A-Za-z0-9_.-]*`.
- `castes` must be a non-empty array.
- Each caste needs `name`, `bee`, and positive integer `count`.
- Optional caste fields: `brief`, `home`.
- `.json` and `.ts` sources are supported.
- `.ts` frames cannot be renamed at define time; rename inside the source.
- `frame edit` only edits JSON-backed frames. For TS-backed frames, edit the
  source and run `hive frame reload <name>`.

Spawn a frame:

```sh
hive frame define ./review-team.json
hive spawn --frame review-team --colony frontend --briefed
```

### `hive swarm`

Manage bee cohorts.

```sh
hive swarm list
hive swarm inspect <id|@id>
hive swarm destroy <id|@id>
```

Examples:

```sh
hive spawn codex --count 3 --swarm-id quick-review
hive swarm inspect @quick-review
hive swarm destroy @quick-review
```

Destroy kills all member bees and marks the swarm destroyed only if all kills
succeed.

## Nodes and Substrates

### `hive node`

Manage substrate endpoints.

```sh
hive node list
hive node register <name> --kind <local-tmux|ssh-tmux> --endpoint <addr>
  [--capabilities a,b,c] [--description "..."]
  [--ssh-command ssh] [--ssh-args="-F /path/to/config"]
hive node inspect <name>
hive node update <name> [--endpoint addr] [--capabilities a,b]
  [--description "..."] [--ssh-command ssh] [--ssh-args="..."]
hive node unregister <name> [--force]
```

Examples:

```sh
hive node register mini01 --kind ssh-tmux --endpoint user@mini01 --capabilities claude,codex
hive spawn codex --node mini01
hive spawn claude --substrate ssh:mini01
hive node update mini01 --capabilities '*'
hive node unregister mini01 --force
```

The implicit local node is always present:

```text
name: local
kind: local-tmux
endpoint: localhost
capabilities: *
```

`--substrate` accepts:

- `local:<node>`
- `local-tmux:<node>`
- `ssh:<node>`
- `ssh-tmux:<node>`
- `<node>`

Node capability checks happen at spawn time. If a node does not list the target
agent capability and does not contain `*`, spawn fails with an update hint.

### `hive substrate`

List substrate kinds and counts.

```sh
hive substrate list
```

Current kinds:

- `local-tmux`
- `ssh-tmux`

## Flows

Flows are reusable automation definitions. They can be JSON or TypeScript and
are registered under `~/.hive/flows`.

### `hive flow`

```sh
hive flow list
hive flow define <path-to-flow.json|.ts> [<name>]
hive flow inspect <name>
hive flow remove <name>
hive flow run <name> [--arg key=value]... [--foreground|--background]
hive flow runs [--flow <name>]
hive flow logs <runId>
hive flow status <runId> [--json]
hive flow cancel <runId>
```

Examples:

```sh
hive flow define ./deep-review.json
hive flow run deep-review --arg target=src --foreground
hive flow run deep-review --arg target=src --background
hive flow runs --flow deep-review
hive flow status 20260612-abcdef12 --json
hive flow logs 20260612-abcdef12
hive flow cancel 20260612-abcdef12
```

`--arg key=value` coercion:

- `true` -> boolean true.
- `false` -> boolean false.
- finite numeric string -> number.
- everything else -> string.
- repeated `--arg` flags are supported.

Foreground is the default unless `--background` is supplied. Background runs
spawn detached process groups and can be cancelled by run id.

Built-in flow:

- `loop`: used by `hive loop`.

JSON flow shape:

```json
{
  "name": "deep-review",
  "description": "Review a target path",
  "args": [{ "name": "target", "default": "src" }],
  "cleanup": "keep",
  "steps": [
    { "op": "spawn", "as": "arch", "bee": "claude", "cwd": "{{target}}" },
    { "op": "brief", "to": "{{arch.id}}", "text": "Review {{target}}." },
    { "op": "waitForSeal", "of": "{{arch.id}}", "timeoutMs": 600000 },
    { "op": "return", "value": "done" }
  ]
}
```

JSON flow fields:

- `name`: required.
- `description`: optional.
- `args`: optional list of `{ "name": "...", "default": ... }`.
- `cleanup`: `keep` or `kill-on-end`; defaults to `keep`.
- `steps`: non-empty array.

JSON step ops:

- `spawn`: `{ "op": "spawn", "as": "binding", "bee": "claude", "name": "...", "cwd": "...", "home": "...", "node": "...", "colony": "...", "swarmId": "..." }`
- `send`: `{ "op": "send", "to": "{{arch.id}}", "text": "..." }`
- `brief`: `{ "op": "brief", "to": "{{arch.id}}", "text": "..." }`
- `waitForSeal`: `{ "op": "waitForSeal", "of": "{{arch.id}}", "timeoutMs": 600000 }`
- `wait`: `{ "op": "wait", "of": "{{arch.id}}", "idleMs": 3000, "timeoutMs": 600000 }`
- `kill`: `{ "op": "kill", "of": "{{arch.id}}" }`
- `seal`: `{ "op": "seal", "of": "{{arch.id}}", "from": "./seal.json" }`
- `log`: `{ "op": "log", "message": "..." }`
- `return`: `{ "op": "return", "value": ... }`

Substitution supports `{{name}}` and `{{name.field}}` against spawn bindings
and flow args. It intentionally does not evaluate arbitrary expressions.

TypeScript flow pattern:

```ts
import { defineFlow } from "honeybee/flow";

export default defineFlow({
  name: "review",
  description: "Code review",
  args: [{ name: "target", default: "src" }],
  cleanup: "keep",
  run: async (ctx) => {
    const bee = await ctx.hive.spawn({ bee: "claude", cwd: String(ctx.args.target) });
    await ctx.hive.brief(bee, `Review ${ctx.args.target}`);
    await ctx.hive.waitForSeal(bee);
  },
});
```

The runtime facade includes:

- `spawn`
- `send`
- `brief`
- `wait`
- `waitForSeal`
- `kill`
- `seal`
- `collect`
- `log`
- `buzSend`
- `buzInbox`
- `buzAwait`
- `loop`
- `loopStatus`
- `loopStop`
- `killAll`

## Loops

Loops are detached runs of the built-in `loop` flow. They repeat a prompt until
a stop condition fires, a stop request is made, or an error/blocked condition
pauses the loop.

### `hive loop`

```sh
hive loop list
hive loop start --bee <kind> --cwd <dir> --context <persistent|ralph|rolling>
  (--prompt <text>|--prompt-file <path>)
  (--max <n>|--forever)
  [--until <shell-command>] [--max-duration <duration>]
  [--stop-on-seal done,blocked,needs_input,failed]
  [--stop-on-sentinel <regex>] [--judge <text>]
  [--summarizer self|bee] [--yolo]
hive loop status <loopId> [--json]
hive loop logs <loopId> [--iter <n>] [-n <lines>] [-f|--follow]
hive loop stop <loopId> [--now]
```

Examples:

```sh
hive loop start --bee claude --cwd . --context rolling --prompt "Fix one failing test, seal, repeat" --max 10
hive loop start --bee codex --cwd . --context ralph --prompt-file ./task.md --until "test -f DONE" --forever
hive loop status 20260612-abcdef12
hive loop logs 20260612-abcdef12 -f
hive loop logs 20260612-abcdef12 --iter 3
hive loop stop 20260612-abcdef12
hive loop stop 20260612-abcdef12 --now
```

Context modes:

- `persistent`: same bee, harness memory.
- `ralph`: fresh bee each iteration, no memory.
- `rolling`: fresh bee each iteration, rolling folded progress.

Stop conditions:

- `--max <n>`: stop after N iterations.
- `--forever`: disable the max cap.
- `--max-duration <duration>`: stop after elapsed duration, e.g. `30s`, `10m`, `2h`.
- `--until <shell-command>`: run in loop cwd before each iteration; exit code
  0 stops the loop.
- `--stop-on-seal`: comma-separated seal statuses; default is `done`.
- `--stop-on-sentinel <regex>`: scan the live pane before killing a fresh bee.
- `--judge <text>`: spawn helper bee to decide STOP/CONTINUE from progress.
- A seal with status `blocked` or `needs_input` pauses the loop unless that
  status is explicitly in `--stop-on-seal`.
- A permission prompt at the idle boundary pauses the loop and keeps the bee
  attachable.

Logs and state live under `~/.hive/loops/<loopId>/` plus the flow run log path.

## Buz Messaging

Buz is file-backed addressed messaging between bees and humans.

Tiers:

- `interrupt`: paste into tmux immediately and write inbox.
- `queue`: store under queue; the daemon drains it when the recipient is idle.
- `passive`: write inbox only, no live delivery.

Default accept policy when unset:

```text
queue,passive
```

Interrupts require explicit opt-in per bee.

### `hive buz`

```sh
hive buz send <selector> --sender <bee>|--sender-human <name>
  [--tier <interrupt|queue|passive>] [-p <body>] [--subject "..."]
hive buz inbox <selector> [--limit N] [--from <ref>]
hive buz outbox <selector> [--limit N] [--from <ref>]
hive buz queue <selector> [--limit N] [--from <ref>]
hive buz read <message-id> [--consume] [--bee <ref>]
hive buz purge <selector> [--read|--older-than <age>|--all]
hive buz config <bee> [--accept interrupt,queue,passive]
```

Examples:

```sh
hive buz config CO.a3f --accept interrupt,queue,passive
hive buz send CO.a3f --sender-human trmd --tier queue -p "Please post status."
hive buz send @review --sender CO.a3f --tier passive --subject "FYI" -p "Shared note"
hive buz inbox CO.a3f --limit 10
hive buz read 000000ABCDE-123abc --consume --bee CO.a3f
hive buz purge CO.a3f --read
hive buz purge CO.a3f --older-than 7d
```

Policy downgrades:

- If `interrupt` is not accepted, delivery downgrades to `queue` when allowed.
- If `queue` is not accepted, delivery downgrades to `passive` when allowed.
- If an interrupt transport fails, the message is queued for later delivery.

Storage layout:

```text
~/.hive/buz/<bee>/inbox/
~/.hive/buz/<bee>/queue/
~/.hive/buz/<bee>/outbox/
~/.hive/buz/<bee>/read/
~/.hive/buz/<bee>/quarantine/
~/.hive/buz/_external/<human>/outbox/
```

## Daemon

The daemon derives session state, drains buz queues, and supports autoswap
behavior. On macOS it is managed through `launchctl`. On Linux, install/start
commands print a systemd user-unit snippet instead of installing automatically.

### `hive daemon`

```sh
hive daemon status [--label <id>] [--json]
hive daemon run [--tick-ms <n>]
hive daemon install [--label <id>] [--force]
hive daemon uninstall [--label <id>]
hive daemon start [--label <id>]
hive daemon stop [--label <id>]
hive daemon restart [--label <id>]
hive daemon logs [-n <lines>|--lines <lines>] [-f|--follow]
```

Examples:

```sh
hive daemon install
hive daemon start
hive daemon status --json
hive daemon logs -n 200
hive daemon logs -f
hive daemon run --tick-ms 2000
```

Status exits with code 0 when running and 3 when down.

## Accounts and Identity

Accounts are local-only vaulted credentials. They are provider identities
("who") independent of homes ("where"). The vault is under:

```text
~/.hive/vault
```

The sync manifest explicitly excludes the vault.

### `hive account`

```sh
hive account list [--json]
hive account add <tool> <label> [--email <addr>]
hive account login <tool> <label>
hive account capture <account> --home <1|2|3|path>
hive account sync [account]
hive account remove <account>
```

Examples:

```sh
hive account add codex work --email me@example.com
hive account login codex work
hive account list --json
hive account capture codex-work --home ~/.codex-work
hive account sync
hive account remove codex-work
```

Account IDs are safe lower-case IDs like `codex-work`, derived from tool and
label. Account lookup supports exact id, exact label, unique partial id/label,
and `<tool>-<query>` shorthand.

`account login` creates or reuses an account and opens a scratch tmux login
seat. When fresh credentials appear, they are captured into the vault and the
seat is torn down. Use `--no-wait` to leave the seat running and capture later.

Claude-specific notes:

- Claude credentials may live in macOS Keychain.
- Activation rescues and syncs rotated OAuth chains before stamping a home.
- `hive account sync` pulls rotated Claude OAuth chains from homes back into
  the vault.

### `hive activate`

Seed an account's credentials into a home.

```sh
hive activate <account> [--home <1|2|3|path>]
```

Example:

```sh
hive activate codex-work --home 2
```

### `hive login`

Interactive login by existing account.

```sh
hive login <account> [--no-wait] [--popup]
```

Examples:

```sh
hive login claude-work
hive login claude-work --popup
```

`--popup` prints a tmux popup command:

```sh
tmux display-popup -E "hive login <account-id>"
```

### `hive swap-account`

Stop, re-credential, and resume a bee on another account.

```sh
hive swap-account <bee> <account>
```

Example:

```sh
hive swap-account CO.a3f codex-backup
```

The target must resolve to a single bee. The account must match the bee's
agent/tool.

### `hive usage` / `hive limits`

Show provider window usage or local usage samples.

```sh
hive usage [account] [--ttl <age>] [--json]
hive limits [account] [--ttl <age>] [--json]
hive usage [account] --samples [--json]
```

Examples:

```sh
hive limits
hive limits --ttl 30m
hive limits claude-work --json
hive usage --samples
```

Default `usage`/`limits` behavior reports real provider 5h/weekly windows when
available. `--samples` reports local daemon token-sample estimates.

Every live read snapshots the results into a local cache
(`~/.hive/limits-cache.json`). `--ttl <age>` (e.g. `30m`, `2h`) serves cached
entries younger than that instead of paying the provider round-trips; anything
older — and any account whose last read failed — is fetched live and
re-cached. Cached rows show `cache <age>` in the AS-OF column. `--ttl 0`
forces a live read.

## Seals and Search

### `hive seal`

Record a typed handoff artifact for one bee, swarm, or colony.

```sh
hive seal <selector> --from <path-to-seal.json>
```

Seal JSON shape:

```json
{
  "status": "done",
  "summary": "Implemented the requested change.",
  "type": "implementation",
  "filesChanged": ["src/example.ts"],
  "testsRun": [
    { "command": "npm test", "result": "passed" }
  ],
  "risks": ["None known"],
  "nextActions": ["Review the diff"],
  "confidence": 0.86
}
```

Valid statuses:

- `done`
- `blocked`
- `needs_input`
- `failed`

Valid types:

- `implementation`
- `review`
- `risk`
- `test`
- `witness`

`confidence` must be between 0 and 1.

Seals are stored under:

```text
~/.hive/seals/<bee>/
```

### `hive search`

Search seals, ledger lines, and session records. Transcripts are intentionally
not searched.

```sh
hive search <query> [--type seals,ledger,sessions]
  [--colony X] [--swarm X] [--bee X] [--status X]
  [--since 7d] [--regex] [--case] [--limit N] [--json]
```

Examples:

```sh
hive search "regression" --type seals,ledger --since 7d
hive search "CO.a3f" --type sessions --json
hive search "failed tests" --regex --case --limit 0
```

### `hive seals find`

Search seals only.

```sh
hive seals find <query> [--status X] [--colony X] [--bee X]
  [--regex] [--case] [--since 7d] [--limit N] [--json]
```

`hive seals find` rejects `--type` because the corpus is already restricted to
seals.

## Sessions and Sync

### `hive sessions reconcile`

Index sessions across homes and flag duplicates/sync conflicts.

```sh
hive sessions reconcile [--home <path>]... [--json]
```

Examples:

```sh
hive sessions reconcile
hive sessions reconcile --home ~/.claude-2 --home ~/.codex-2 --json
```

### `hive sync manifest`

Write a Syncthing-style include/exclude manifest.

```sh
hive sync manifest [--json]
```

The generated manifest includes hive metadata that is safe to sync and excludes
the credential vault.

## Config and Completion

### `hive config`

View or edit hive config.

```sh
hive config
hive config show
hive config path
hive config set-bee <bee> [--yolo] [--no-yolo] [--home <value>] [--command "..."]
```

Examples:

```sh
hive config show
hive config path
hive config set-bee claude --no-yolo
hive config set-bee codex --home 2 --command "codex --model gpt-5"
```

Config shape:

```json
{
  "briefFooter": "\n\n(Context only - do not start work yet.)",
  "bees": {
    "claude": {
      "yolo": false,
      "home": "1",
      "command": "claude"
    }
  }
}
```

The CLI only writes bee entries through `set-bee`; `briefFooter` can be edited
manually in `~/.hive/config.json`.

### `hive completion`

Print shell completion script.

```sh
hive completion bash
hive completion zsh
hive completion fish
```

Install examples:

```sh
eval "$(hive completion zsh)"
eval "$(hive completion bash)"
hive completion fish | source
```

## Machine Output and Exit Codes

Pretty output is used when stdout/stderr are TTYs. Non-pretty output is intended
for scripts and is usually tab-separated.

Commands with `--json`:

- `transcript`
- `wait` when transcript output is requested through wait options
- `flow status`
- `loop status`
- `daemon status`
- `account list`
- `limits` / `usage`
- `sessions reconcile`
- `sync manifest`
- `search`
- `seals find`

Notable exit behavior:

- Unknown commands and usage errors exit nonzero.
- `hive wait` exits nonzero when the bee is blocked.
- `hive run --wait --rm` keeps a blocked bee and exits nonzero.
- `hive daemon status` exits 0 when running and 3 when down.
- `hive flow run` exits 1 on failed flows and 130 on cancelled flows.
- `hive clean` and `hive swarm destroy` set nonzero exit when cleanup/kill fails.

## Common Usage Patterns

Spawn, brief, assign work, and harvest:

```sh
hive spawn claude --name arch --cwd .
hive brief arch "Context: focus on architecture only."
hive send arch "Review src and seal with risks."
hive wait arch --seal
hive last arch --seal
```

One-shot review, keep the bee:

```sh
hive run claude -p "Review this repo and seal with findings." --cwd . --wait --last
```

One-shot review, clean up on success:

```sh
hive run codex -p "Summarize the repo." --wait --last --rm
```

Spawn a swarm and coordinate:

```sh
hive colony create frontend
hive spawn codex --count 3 --colony frontend --swarm-id fe-review
hive brief @fe-review "Shared context: frontend review."
hive send @fe-review "Split files by package and report findings."
hive list --swarm fe-review
```

Use accounts:

```sh
hive account add claude work
hive account login claude work
hive spawn claude-work --cwd .
hive limits claude-work
```

Remote node:

```sh
hive node register mini01 --kind ssh-tmux --endpoint user@mini01 --capabilities codex,claude
hive spawn codex --node mini01 --cwd /srv/app
hive list --node mini01
```

Queued buz message:

```sh
hive daemon start
hive buz send CO.a3f --sender-human trmd --tier queue -p "When idle, summarize current state."
hive buz queue CO.a3f
```

Detached flow:

```sh
hive flow define ./review.json
hive flow run review --arg target=src --background
hive flow runs
hive flow logs <runId>
```

Loop until a file exists:

```sh
hive loop start --bee claude --cwd . --context rolling \
  --prompt "Make progress, run tests, seal each iteration." \
  --until "test -f DONE" --forever
```

Clean safely:

```sh
hive clean --dead --dry-run
hive clean --dead --older-than 7d
hive clean --idle --dry-run
hive clean -i
```
