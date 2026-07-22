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
  `comb`. Reserved tags are *derived on read* from the
  bee's canonical fields — no migration is needed for existing bees.
- `owns:<bee>` / `owned-by:<bee>` / `reports-to:<bee>`: all bees whose
  `reportsToId` resolves to `<bee>` (the owned-by/reports-to edge, set by
  `hive own`). The three spellings are aliases.
- `children-of:<bee>`: all bees split from `<bee>` (their `parentId`).
- `forks-of:<bee>`: all bees forked from `<bee>` (their `forkedFromId`).
  These reverse-relationship selectors match by raw id and TOLERATE a dead
  anchor: `owns:<killed-owner>` still returns surviving bees that carry the dead
  owner's id (no cascade — relationships are reference-only).

`@`, `colony:`, `#`, `tag:`, and the relationship prefixes
`owns:`/`owned-by:`/`reports-to:`/`children-of:`/`forks-of:` are **reserved
selector prefixes**: a string beginning with one is parsed as that selector
kind, not a bee name. Bee names
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
| `opencode` | `opencode --mini` | `opencode --mini --auto` |
| `grok` | `grok --tools= --disable-web-search --no-subagents` | `grok --permission-mode bypassPermissions --always-approve --tools= --disable-web-search --no-subagents` |
| `kimi` | `kimi` | `kimi --yolo` |
| `pi` | `pi` | `pi` |
| `droid` | `droid` | `droid --settings ~/.factory/hive-droid-yolo-settings.json` |
| `cursor` | `cursor-agent` | `cursor-agent --force` |

Every built-in agent — and any arbitrary harness kind — defaults to yolo mode
unless explicitly opted out. Kinds with no curated yolo command (e.g. `pi`) run
their normal command; the rest use the bypass command above.

Yolo controls:

```sh
hive spawn claude               # permissionless (default)
hive spawn claude --no-yolo     # opt back into approval prompts
hive spawn grok --no-yolo
HIVE_YOLO=1 hive spawn codex     # env force (redundant with the default)
hive config set-bee grok --no-yolo   # persistent opt-out
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
hive colony ...
hive pool ...
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
hive spawn <bee> [--name <id>] [--cwd <dir>] [--pool <name> [--no-keep]]
  [--home|--profile <1|2|3|path>]
  [--account <account>] [--autoswap] [--colony <name>]
  [--brief <text>] [--briefed] [--count <n>]
  [--swarm-id <id>|--swarm <id>] [--node <name>]
  [--substrate <local:name|ssh:name>] [--here] [--yolo|--no-yolo]
  [--accept-trust|--no-accept-trust] [--no-wait] [--boot-ms <ms>]
  [-- <bee-args...>]
```

`--pool <name>` (also on `x`/`run`/`xa`/`open` — mutually exclusive with
`--cwd`): allocate a member of a checkout pool and spawn the bee inside it —
see [`hive pool`](#hive-pool). `--count N` claims N members in one lock
acquisition, auto-extending the pool as needed; each bee lands in its own
member. The bee's record carries `poolKey`/`poolMember` for attribution. If
the spawn fails, the claim is dropped; a member the allocation freshly cloned
is kept by default (`--no-keep` deletes it on rollback). Local substrates only
(tmux/HSR) — pool members are local paths.

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
hive spawn codex-rr          # round-robin: next account in registration order (also: --account rr)
```

Account-bound spawns activate credentials into a home before launch. Autoswap
requires an account and opts the bee into daemon account swapping when usage is
exhausted.

`auto` is a reserved account query (`--account auto`, or the `<tool>-auto` bee
spec, on `spawn`/`run`/`x`/`xa`/`open`): hive reads the provider limits of every
credentialed account for that tool and picks the one with the least
*pace-adjusted* weekly load. Pace is used% minus elapsed% of the window: an
account behind pace holds unused quota that expires at its reset, so it is
preferred even over accounts with nominally lower used% — e.g. 70% used but
resetting tomorrow beats 40% used with five days to go. Pace's weight fades as
headroom drops below 25%, so a 98%-used account an hour from reset never wins
on pace alone. Accounts ≥90% into their 5h window sort behind ones with
headroom, and accounts whose limits cannot be read are a last resort (oldest
registration wins). The pick is printed to stderr, e.g.
`account auto → claude-thto (weekly 66%, 5h 12%) — least effective weekly load (18% behind pace — surplus expires at reset)`.

The pick reads limits through the cache with a default ttl of **1h**, so
back-to-back auto spawns cost no extra provider round-trips. Override per call
with `--ttl <age>` (`--ttl 0` forces a live read); `hive limits` keeps the
same cache warm.

`rr` is the second reserved account query (`--account rr`, or `<tool>-rr`):
hive advances a persistent cursor at `<storeRoot>/round-robin.json` through the
tool's credentialed accounts, sorted by registration time. Each spawn picks the
**next** account regardless of remaining quota — use this when you want to
spread workload evenly (e.g. when running many parallel loops) rather than let
limits steer the pick. Two concurrent spawns serialize through a file lock so
the cursor never doubles up or skips. The pick is logged to stderr, e.g.
`account rr → claude-ursolutions — round-robin: next after claude-thto`.

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

### `hive own`

Set the **owned-by / reports-to** edge between bees: every `<bee-selector>`'s
`reportsToId` is pointed at the single bee resolved from `<owner-selector>`.

```sh
hive own <owner-selector> <bee-selector>...  # set the reports-to edge
hive own <bee-selector> --clear              # unset the edge
```

Examples:

```sh
hive own CL.lead CO.a3f CO.b1c   # both bees now report to CL.lead
hive own CL.lead colony:fe       # everyone in colony fe reports to CL.lead
hive own CO.a3f --clear          # drop CO.a3f's reports-to edge
```

The owner selector must resolve to exactly one bee (0 or >1 is an error). Each
bee selector may be a multi-bee selector, so one command can wire a whole
cohort; the result reports a count. Each write emits a `rel.set` /  `rel.clear`
ledger event. Relationships are **reference-only**: clearing an edge never kills
a bee, and the edge has no tmux mirror in v1.

Query the edge via the reverse selectors:

```sh
hive list owns:CL.lead          # bees that report to CL.lead
hive list owned-by:CL.lead      # alias of owns:
hive list reports-to:CL.lead    # alias of owns:
hive list children-of:CO.a3f    # bees split from CO.a3f (parentId)
hive list forks-of:CO.a3f       # bees forked from CO.a3f (forkedFromId)
```

A reverse selector tolerates a dead anchor: `owns:<killed-owner>` still returns
the surviving bees that carry the dead owner's id (no cascade).

### `hive move`

Reassign a bee's colony, or its owner (an alias for `hive own` on one bee).

```sh
hive move <bee> --colony <c>     # rewrite record.colony (derived colony: follows)
hive move <bee> --owner <o>      # alias for: hive own <o> <bee>
hive move <bee> --owner ''       # clear ownership (same as hive own <bee> --clear)
```

Examples:

```sh
hive move CO.a3f --colony backend   # move CO.a3f into colony backend
hive move colony:fe --colony be      # bulk-move a whole colony
hive move CO.a3f --owner CL.lead     # point CO.a3f's reports-to at CL.lead
hive move CO.a3f --owner ''          # clear CO.a3f's reports-to edge
```

Pass exactly one of `--colony` / `--owner`. `--colony` refreshes the bee's
`@hive_tags` tmux option (because `colony:` is a derived reserved tag); the
`--owner` path does not (relationships have no tmux mirror). This is the verb the
`hive tag` reserved-namespace rejection redirects to for `colony:`.

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

Exit codes:

| Code | Outcome |
| ---: | --- |
| `0` | The requested idle output or a new seal was printed. |
| `1` | The bee became blocked or reached a terminal/hopeless state (`crashed`, killed, archived, deleted, or a missing runtime/pinned tmux pane). |
| `2` | The timeout elapsed before success. |

Every wait mode refreshes the session record and checks runtime liveness on
each poll. Terminal failures return within one poll interval and print a
one-line diagnosis naming the state; a transport probe failure is treated as
unknown liveness rather than false death and can still end in timeout code `2`.

## Listing, Attaching, Killing, Cleaning

### `hive list` / `hive ls` / `hive ps`

Show known sessions with derived state.

```sh
hive list [selector] [--colony <name>] [--swarm <id>] [--node <name>]
          [--state <s>] [--agent <a>] [--repo <name>] [--tag <ns:val>]...
          [--archived] [--json] [--wide]
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
- `--archived`: include **filed** (`status:"archived"`) bees. They are **hidden
  by default**; `--archived` (or an explicit `--state archived`) re-includes them.

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

### `hive next`

Jump to the next local bee that needs attention. This is the *attention queue*
(navigation Tier 1, "push, not pull"): instead of scanning the full list, you
walk only the bees whose live state says they want you — `M-n` to step forward,
`M-N` (`--prev`) to step back, cycling through the set.

```sh
hive next [--state <comma-list>] [--prev] [--print]
```

The attention set:

- It is the LOCAL bees whose live `@hive_state` is one of the attention states.
  The default attention states are `waiting,done,failed` — everything tracked
  that is NOT actively `working`.
- `@hive_state` is read straight from the local tmux server (one
  `tmux list-sessions` over the option — no per-bee store read). hive writes it
  on its own spawn/brief/send/seal transitions, and the daemon and agent
  Stop/Notification hooks keep it current; a bee with no `@hive_state` set (or
  one that is `working`) is never in the set.
- `--state waiting` (or a comma list like `--state waiting,blocked`) overrides
  the default set. The order you list states in is the order they are visited.
- Remote bees are never in the queue — the attention queue is the local tmux
  server (a remote bee lives on a different server and cannot be
  `switch-client`'ed to).

Ordering and cycling:

- Bees are grouped by attention-state priority (the order given to `--state`;
  default `waiting` → `done` → `failed`), and within each group oldest-first
  (longest in that state), using each bee's last observed state time.
- `hive next` finds your current session in the ordered queue and jumps to the
  NEXT entry, wrapping around at the end; `--prev` jumps to the previous one. If
  your current pane is not itself a bee in the set, `next` enters at the front
  and `--prev` at the back.
- When the set is empty, it prints `no bees need attention` and exits 0 — there
  is nothing to switch to and that is not an error.

Switching (nesting-safe):

- Inside tmux the current client is repointed with `tmux switch-client` (via the
  same nesting-safe attach helper as `hive attach` — `attach-session` inside an
  existing client is never emitted).
- `--print` prints the context-appropriate command instead of switching.
- Outside tmux there is no current client to repoint, so `hive next` prints the
  attach command for the target (run it, or run `hive next` from inside tmux to
  switch directly) instead of crashing.

Examples:

```sh
hive next                       # → the oldest waiting bee, then cycle on repeat
hive next --prev                # step backward through the queue
hive next --state waiting       # only bees waiting on input
hive next --state waiting,done  # waiting first, then done
hive next --print               # emit the switch-client command, don't switch
```

### Retired: `hive view` / `hive workspace` / `hive quest`

Workspaces, quests, and the colony cockpit moved to the Apiary desktop app;
the CLI keeps `spawn --here` for window placement. (Removed 2026-07-03.)

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

### `hive fork`

Branch an existing bee into a **fresh comb** (its own new tmux session,
optionally a different harness/model/node), seeded from the source bee's state.
Where `split` grows a comb (siblings share a window), `fork` branches a lineage
into a new comb elsewhere.

```sh
hive fork <bee> [checkpoint]
          [--agent <kind>] [--model <m>]
          [--node <n>] [--cwd <dir>]
          [--seed resume|seal|summary|log|none]
          [--read-log] [--name <n>] [--account <a>] [--here] [--print]
```

- `<bee>` — the source bee to fork (a single bee selector; forking a set is
  refused).
- `[checkpoint]` — the seed anchor: a **seal**. Default `latest` (the most
  recent seal); `seal:<ISO>` selects a specific one. `msg:N` (transcript offset)
  is deferred.
- `--agent <kind>` — fork into a different harness (defaults to the source's
  agent). Cross-harness forks cannot use native resume (see below).
- `--model <m>` — first-class model, also baked into the spawned command via the
  per-harness flag (Claude `--model <m>`, Codex `-m <m>`, OpenCode
  `--model <provider>/<model>`). OpenCode selectors must stay provider-qualified
  so a resumed server session cannot silently switch among configured providers.
- `--node <n>` / `--cwd <dir>` — node and working directory (cwd defaults to the
  source's).
- `--seed <mode>` — force a seeding rung; `--read-log` is shorthand for log
  seeding and overrides the ladder.
- `--name <n>` — name for the fork (defaults to a fresh auto-allocated id).
- `--account <a>` — the account whose dedicated home the fork uses (required for
  an account-bound source; see Account safety).
- `--here` / `--print` — behave like `hive spawn`: link the fork's window into
  your current tmux session, or print the attach command.

**Seeding ladder** (best fidelity available, in order; the chosen rung is
recorded in `seedMode`):

1. **resume** — `--seed resume` (or default) **and** same harness **and** a
   known source `providerSessionId` → the fork spawns with native resume args
   (claude `--resume <id>`, codex `resume <id>`, opencode `--session <id>`)
   baked into its command. Exact continuation.
2. **seal** — the latest/selected seal → a brief: *"You are a fork of `<bee>`.
   State: `<summary>`; files changed: …; next: …. Continue from here."*
3. **summary** — deferred in v1 (no standalone summarizer); falls through to log.
4. **log** — `--read-log` (or the fallthrough) → a brief pointing at the
   source's `transcriptPath`. If there is no resume session, no seal, and no
   transcript, the fork is **refused** with a clear message.

**Cross-harness rule:** native resume is same-harness only. A cross-harness fork
(`--agent codex` from a claude source) **must** seed from a seal or log; an
explicit `--seed resume` that is cross-harness is **refused** loudly rather than
silently downgraded.

**Account safety (critical):** a fork must never share a live home with its
parent — Anthropic rotates OAuth refresh tokens, so two bees on one home log
each other out. Therefore:

- An **account-bound** source (`accountId` set) **must** be forked with
  `--account <a>` (or `--account auto`); without it the fork is refused. The
  account brings its own dedicated home.
- A **default-home** source may be forked without `--account` — the fork gets
  its own fresh session in the default home (the same risk profile as spawning a
  second default bee).
- `--seed resume` needs the parent's home to see its provider session, so it is
  only honored for a default-home source (with a loud warning about the shared
  home); combining `--seed resume` with `--account` is refused.

**Anti-cross-match:** the fork is a new session with no `providerSessionId` of
its own and a `lastPromptAt` stamped at creation, so the daemon's transcript
scorer can never assign the **parent's** transcript to the fork.

**Lineage:** the fork records `forkedFromId` (source id), `forkedAt`, `seedMode`,
`forkCheckpoint` (`seal:<ISO>` | `resume:<id>` | `log:<path>` | `none`), and
`model`, and emits a `fork.create` ledger event. The `forks-of:<bee>` selector
lists a bee's forks.

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

## Keybindings and In-tmux Affordances

The keybinding LAYER — picker verbs the `display-popup` chords invoke, the
standalone in-tmux affordances, and the recommended binding set — is specified in
`docs/KEYBINDINGS_PRD.md`. These verbs are thin, testable, and side-effect-free
(the action lives in the binding). The canonical copy-pasteable tmux block is
`docs/honeybee.tmux.conf`, emitted byte-for-byte by `hive keys print --tmux`.

### `hive spawn-picker`

A **pure stdout list verb** for a `display-popup` "spawn something here" chord: it
prints candidate names one-per-line and does nothing else (no spawn/switch/store
write). The binding wraps it: `display-popup -E "hive spawn-picker --frame | fzf
| xargs -r -I{} hive spawn --frame {} --here"`.

```sh
hive spawn-picker [--frame | --flow] [--here]
```

- `--frame` (default) — one frame name per line (via `listFrames()`).
- `--flow` — one flow name per line (via `listFlows()`).
- `--here` — a passthrough hint for the binding (so it appends `--here` to the
  spawn action). It does **not** change the printed candidate set.
- Empty candidate set → exit 0 with empty stdout (the binding's `xargs -r`
  no-ops). The first whitespace/TAB field is the selectable machine token.
- Reads the LOCAL store: hard-errors (non-zero) when the default substrate is
  `ssh-tmux`, to avoid targeting the wrong fleet (KEYBINDINGS_PRD §8.1/§13).

### `hive urls`

Lists website URLs printed in a bee's pane, for an `fzf` + open-in-browser chord.
Side-effect-free unless `--open`.

```sh
hive urls [<bee>] [--lines <n>] [--open] [--json]
```

- Default bee is the current pane (via `hive here` resolution); an explicit
  selector grabs from another bee.
- Captures pane scrollback via the substrate (`--lines` defaults to ~2000).
- Extracts `http(s)` URLs, strips trailing punctuation, dedupes preserving
  first-seen (recency) order.
- Default output is one URL per line; `--json` emits a JSON array; `--open` opens
  the **first** match via the platform opener (`open` on macOS, `xdg-open` on
  Linux).
- Empty → exit 0 with a dim "no URLs" note on stderr (so the popup closes
  cleanly). An explicit selector hard-errors under an `ssh-tmux` default
  substrate (it reads the LOCAL store).

### `hive rename --here`

An argv-reshaping convenience wrapper over `hive rename` for the cmd+r chord. It
pulls the bare positional(s) as the **title**, resolves the current bee via `hive
here`, and injects that id as the selector before delegating — so the title is
never mistaken for a selector.

```sh
hive rename --here <new-title>
```

The non-`--here` behavior of `hive rename` is unchanged: `hive rename <selector>
<title>`, `--auto` (daemon-style auto-title), `--clear`. Rename sets `@hive_title`
(not the tmux session name), so the status bar and the `M-s` switcher line update
without re-attach.

### `hive keys`

Print and verify the recommended binding set. Zero config mutation: hive ships a
documented snippet plus verify tooling; the operator owns the bindings.

```sh
hive keys print [--tmux | --wezterm]    # emit the recommended block to stdout
hive keys path                          # print the abs path of docs/honeybee.tmux.conf
hive keys check [--against-recommended] # diagnose live binds, collisions, static checks
```

- `print` — `--tmux` (default) prints the tmux block **verbatim** from the same
  source-of-truth string backing `docs/honeybee.tmux.conf`; `--wezterm` prints
  the `cmd→Meta` additions for `~/.wezterm.lua`.
- `path` — the absolute path of the shipped `docs/honeybee.tmux.conf` (resolved
  relative to the hive install), for `source-file "$(hive keys path)"`. Path
  stability caveat: it tracks the install location, so it is brittle across
  reinstall/relocation (KEYBINDINGS_PRD §16 Q2).
- `check` — a **pure read** that reports which recommended binds are present /
  absent / collide (against `tmux list-keys -T root`), and runs static checks:
  `fzf` on PATH, a browser opener on PATH, the substrate is `local-tmux` (warns
  under `ssh-tmux`), and `hive` itself is reachable. Exits non-zero only on a hard
  failure (`hive` unreachable); warnings otherwise. `--against-recommended` flags
  live binds that drift from the shipped set.
- **Limitation**: `check` reads `tmux list-keys`, so it is blind to the WezTerm
  ALT/cmd layer in `~/.wezterm.lua` — that must be eyeballed (KEYBINDINGS_PRD §6).
- `hive keys doctor` is an optional Phase 2 runtime popup-probe; it currently
  reports "not yet implemented".

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
hive clean --crashed [--older-than <age>] [--dry-run|-n]
hive clean --idle [--older-than <age>] [--dry-run|-n]
hive clean -i
hive clean --interactive
```

Examples:

```sh
hive clean --dead --dry-run
hive clean --crashed --dry-run
hive clean --dead --older-than 7d
hive clean --idle --dry-run
hive clean -i
```

Age units are parsed by `parseAge` and include units such as `s`, `m`, `h`,
`d`, `w`, `mo`, and `y`.

Important behavior:

- `--dead` deletes records for sessions that no longer exist.
- `--crashed` deletes records whose runtime disappeared without a retire/kill.
- `--idle` kills live bees in the `idle_with_output` state.
- `-i`/`--interactive` cannot be combined with `--dead`, `--crashed`, `--idle`,
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

## Checkout Pools

### `hive pool`

Checkout pools (CHECKOUT_POOLS_PRD): named, elastically sized sets of
pre-cloned `pro co` checkouts (`checkouts/<repo>/<pool>-<n>`) that bees claim
round-robin and release by going terminal. Pool config (base branch,
`maxOccupancy`, `maxSize`) and membership are **pro's** truth (`pro pool` —
requires a pool-enabled `pro` on PATH; without one every pool verb fails with
a typed, actionable error). hive owns only what cannot be derived — the
round-robin cursor, in-flight claims, and parked members — in
`~/.hive/pools/<key>.json` (key `<area>-<project>-<repo>-<pool>`). Deleting
that file is harmless: the cursor resets and claims rebuild from live bees.

```sh
hive pool                          # pools in scope: occupancy like core 4/6 (2 busy · 4 free)
hive pool status [<pool>] [--json] # member table: n, state, bees, branch, ahead/behind, path
hive pool spawn <pool> <bee> [spawn flags…]   # allocate + spawn (= hive spawn <bee> --pool <pool>)
hive pool launch                   # M-P popup: pick pool → pick agent → spawn (--here linked)
hive pool extend <pool> [N]        # manual grow (delegates to pro pool extend)
hive pool sync [<pool>|--all]      # occupancy-aware sync of FREE members only
hive pool claim <pool> [n] [--ttl <age>]      # manual claim (specific member with n)
hive pool release <pool> <n>       # drop all claims on member n
hive pool park <pool> <n>          # withhold a member from allocation
hive pool unpark <pool> <n>
```

`hive pool launch` is the fast tmux flow (recommended bind: **M-P** →
`display-popup -E "hive pool launch"`; lowercase M-p belongs to the WezTerm
Zellij ALT layer, the same collision that put fork on M-k). Two fuzzy steps —
pool (rows like `core 4/6 free · 2 busy`; zero-free pools stay selectable and
read `(will extend)`), then the same account-aware agent list `hive launch`
offers. Inside tmux the spawned bee's window is `--here`-linked into your
session; happy path is M-P, ↵, ↵.

Scope: inside a pro project, verbs see that project's pools; outside, all
projects. A pool argument resolves as the exact key first, else by unique
pool name in scope.

Occupancy is **derived, never stored**: a member is inhabited by every live,
non-terminal bee whose cwd is inside the member path. Claims are short-lived
(~120 s, `HIVE_POOL_CLAIM_TTL_MS`) bridges between allocation and the bee's
record existing; `hive kill`/`clean` drop a killed bee's claim eagerly, and
expiry is the backstop. Free capacity per member is
`maxOccupancy − (live inhabitants + unconsumed claims)`.

Allocation picks the **emptiest** free member, ties broken round-robin (first
member number past the cursor, wrapping). When nothing is free the pool
**auto-extends** via `pro pool extend`; `maxSize` is a soft cap — extension
past it proceeds with a loud warning.

`hive pool sync` computes the free set and passes only those members to
`pro co sync <members…> --rebase` (per-member: dirty → `skipped-dirty`,
off-base → `skipped-parked`, conflicted rebase aborted + reverted
byte-identical → `failed-rebase-reverted`). Inhabited or claimed members are
reported as `skipped-inhabited` and never touched. Ad-hoc (non-pool)
checkouts are pro's territory: `pro co sync [NAME…] [--all] [--rebase]`.

`hive pool status --json` is the machine contract (Apiary): the full derived
model — per pool `key/area/project/repo/pool/repoPath/branch/maxOccupancy/
maxSize/size/busy/free/rrCursor/exceedsMaxSize` plus per member
`n/path/branch/dirty/ahead/behind/parked/occupants/pendingClaims/free` — and
an `adhocCheckouts` array (non-pool checkouts of the same repos with derived
occupants).

The daemon sweeps pools on its tick (every `HIVE_POOL_SWEEP_INTERVAL_MS`,
default 60s): expired claims are GC'd; a member observed going inhabited→free
is refreshed to `origin/<branch>` (§5.3 semantics, clean on-base members
only); a member left **dirty or off-base by a departed bee is flagged, never
auto-reset** — a `pool.member.flagged` ledger event, a warn log line, and a
queue-tier buz nudge to the departed bee's living parent when it has one; and
a pool whose free count dips below its `minFree` floor (`pro pool create
--min-free N`) is pre-extended in the background so spawn latency never
includes a clone. Every step is failure-tolerant: a broken pool (or pool-less
pro) never breaks the tick.

In `hive bees` (TUI + sidebar), pool bees carry their member in the slot
glyph (`⎇ core-3`, from the record's `poolKey`/`poolMember` — never
re-derived), and a pools capacity strip renders under the header
(`pools: core 4/6 · 2 busy | fleet 0/3 (will extend)`).

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
hive account pause <account>
hive account resume <account>
hive account remove <account>
```

Examples:

```sh
hive account add codex work --email me@example.com
hive account login codex work
hive account list --json
hive account capture codex-work --home ~/.codex-work
hive account sync
hive account pause codex-work
hive account resume codex-work
hive account remove codex-work
```

Account IDs are safe lower-case IDs like `codex-work`, derived from tool and
label. Account lookup supports exact id, exact label, unique partial id/label,
and `<tool>-<query>` shorthand.

`account pause` parks an account without removing it: its vaulted credentials
and running bees are untouched, but the `auto`/`rr` pools skip it (pass
`--include-paused` to opt back in for one spawn) and explicitly spawning on it
(`hive spawn`/`x`/`xa`/`open`/`fork`) asks for confirmation first — `--yes`
skips the question, and a non-interactive caller gets a hard error instead.
`account resume` puts it back in rotation. Paused accounts show `paused` in
`account list`, and the autoswap daemon never rotates a bee onto one.

`account login` creates or reuses an account and opens a scratch tmux login
seat. When fresh credentials appear, they are captured into the vault and the
seat is torn down. Use `--no-wait` to leave the seat running and capture later.

Credential rotation notes:

- Claude credentials may live in macOS Keychain.
- Claude refreshes can rotate OAuth chains; Codex, OpenCode, Grok, Kimi, and
  Cursor can rewrite their file-backed credentials in-place.
- Activation rescues and syncs rotated/refreshed credentials before stamping a
  home.
- `hive account sync` pulls rotated/refreshed credentials from attributed homes
  back into the vault. Dedicated account homes are trusted automatically; live
  session homes are trusted when the session record is account-bound.

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
hive usage [account] --live [--interval <dur>]
hive usage [account] --samples [--json]
```

Examples:

```sh
hive limits
hive limits --ttl 30m
hive limits claude-work --json
hive usage --live
hive usage tormod --live --interval 30s
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

#### Live dashboard (`--live`)

`hive usage --live` (aliases `--dashboard`, `--follow`, `-f`) opens a
full-screen, auto-refreshing dashboard in the current terminal showing the same
per-account 5h / weekly / Fable windows as the static table, with wider bars and
live countdowns. The screen repaints every second so reset countdowns and
as-of ages move without network I/O; the underlying limits are re-fetched on a
slower cadence (default 2m, set with `--interval <dur>` such as `30s` or `5m`,
floored at 10s so it can't hammer provider endpoints). A fetch never overlaps a
previous one; a failed refresh keeps the last good data on screen and retries on
the next tick. When the provider rate-limits a sweep (HTTP 429), consecutive
rate-limited sweeps double the wait up to 8× the interval — the header shows
`rate-limited, backing off` — and one clean sweep restores the normal cadence.

Keys: `r` forces an immediate refresh (and resets the cadence and any backoff);
`q` / `Esc` / `Ctrl-C` exit cleanly, restoring the terminal. There is no cursor
or selection — it is a wall dashboard.

A claude account registered without a resolvable email (no `--email` and a
label that is not an address) is flagged loudly — in `account add`/`account
login` output, under the static table, and pinned into the dashboard footer:
every identity guard (token verification, imposter parking, vault mirroring)
keys off the email, so an email-less account can silently show — and be
overwritten by — another account's credentials. Fix it by adding `"email"` to
the record in the accounts registry.

Each live read is ttl-less, so it refreshes the shared on-disk limits cache and
keeps `hive spawn --account auto` warm while the dashboard runs. `--live`
requires an interactive TTY on both stdin and stdout; when either is missing (a
pipe or redirect), it prints the static table once plus a note instead of
opening the dashboard. `--live` cannot be combined with `--json` or `--samples`.

## Seals and Search

### `hive seal`

Record a typed handoff artifact for one bee, swarm, or colony.

```sh
hive seal <selector> --from <path-to-seal.json>
hive seal --example
hive seal --help
```

`hive help seal` prints the same detailed help as `hive seal --help`.
`hive seal --example` prints the representative input artifact below to stdout;
it does not require a selector or `--from`, and it does not write Hive state.

Seal JSON shape:

```json
{
  "status": "done",
  "summary": "Implemented discoverable seal help and verified the CLI behavior.",
  "type": "implementation",
  "filesChanged": ["src/seal.ts", "src/commands/messaging.ts"],
  "testsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "notes": "All tests passed."
    }
  ],
  "risks": ["None known."],
  "nextActions": ["Review the diff."],
  "confidence": 0.95
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

Artifact fields:

- `status` (required): one of the statuses above.
- `summary` (required): a non-empty string.
- `type` (optional): one of the types above.
- `filesChanged`, `risks`, and `nextActions` (optional): arrays of strings.
- `testsRun` (optional): an array of objects. Each object requires a non-empty
  `command` and a `result` of `passed`, `failed`, or `skipped`; `notes` is an
  optional string.
- `confidence` (optional): a finite number from 0 through 1, inclusive.

To self-seal from inside a bee, resolve the current ID, write or edit a truthful
artifact, record it, and clean up the temporary file:

```sh
bee="$(hive here --id)"
artifact="$(mktemp "${TMPDIR:-/tmp}/hive-seal.XXXXXX")"
hive seal --example > "$artifact"
${EDITOR:-vi} "$artifact"
hive seal "$bee" --from "$artifact"
rm -f "$artifact"
```

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
hive clean --crashed --dry-run
hive clean --dead --older-than 7d
hive clean --idle --dry-run
hive clean -i
```
