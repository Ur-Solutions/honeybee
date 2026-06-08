# honeybee Loops PRD

## 1. Summary

**Loops** give honeybee (`hive`) a first-class, harness-agnostic way to run a bee
repeatedly on a repetitive task — for a long time, continuously, or **until some
condition** — without requiring the underlying harness to have its own loop
primitive.

A loop is a detached driver that, each iteration, ensures a bee is ready, injects
a (usually static) prompt, waits for the bee to finish the turn, evaluates a stop
condition, and repeats. The loop lives in hive, not in the harness, so it works
identically across Claude, Codex, OpenCode, Grok, Pi, Droid, and arbitrary
executables — including harnesses that have no `/loop` of their own.

Loops are deliberately **not** "goal mode." There is no goal specification and no
semantic completion judgment in the common case. A loop just keeps doing the work;
stopping is a menu of mostly-mechanical conditions, with an LLM judge as the most
expensive opt-in rather than the premise.

## 2. Motivation

- Higher-level orchestration agents (and humans) need a dead-simple way to spawn
  long-running, repetitive work — "keep doing X", "work the queue", "until tests
  pass" — and walk away.
- Claude Code has a `/loop` harness primitive; most other harnesses do not. hive
  already drives every harness through the same tmux substrate, so hive is the
  natural owner of a uniform loop that any harness inherits.
- Long-horizon runs rot a single agent's context. We need explicit control over
  *how* context is carried across iterations, rather than hoping the harness's
  opaque auto-compaction holds up over hundreds of passes.

## 3. Goals

- One driver, trivial to invoke from CLI **and** from an orchestration bee.
- Harness-agnostic: works wherever `hive spawn` works.
- Three context strategies behind a single `--context` flag.
- A menu of stop conditions from "forever" to "until shell command exits 0" to an
  optional judge — defaulting to cheap/mechanical.
- Inspectable, resumable, killable, like flow runs.
- Built on the existing flow + seal + substrate primitives; the daemon stays dumb.

## 4. Non-goals

- Goal mode / semantic "is the goal achieved?" judging as the default mechanism.
- Autonomous task selection ("AI decides the next task") — the loop runs the prompt
  it was given; it does not invent new objectives. (Consistent with the v2 anti-goal
  on hidden autonomous background work.)
- Moving loop execution into the daemon. The daemon remains an observation-only
  ticker; loops are detached flow processes.
- Cross-machine loop scheduling / multi-user orchestration (a loop runs on one
  substrate, like any bee).

## 5. Primary Users

### Orchestration bees (Jancsi / OpenClaw agents)

Spawn loops as a single call (`hive.loop({...})` or `hive loop start ...`), then
read `progress.md` to see what a loop has accomplished — without tailing panes.

### Tormod / humans

Start a loop from the terminal, watch status/logs, and stop it when satisfied.

## 6. Core Concepts

### Loop

A named, detached run that re-prompts a bee until a stop condition fires. Identified
by a `loopId`. Has a context mode, a prompt, zero-or-more stop conditions, and a
state directory under `~/.hive/loops/<loopId>/`.

### Iteration

One pass of the loop: ensure-ready → inject prompt → bee works → bee **seals** →
hive evaluates stop. The **seal is the iteration boundary** (see §8).

### Context mode

How context is carried across iterations. Three presets over two orthogonal knobs
(see §7).

### Stop condition

What ends the loop. A menu, cheapest first (see §9). Multiple may be combined; the
loop stops when any fires. A `--max` backstop is mandatory unless `--forever` is set.

### Summarizer

In rolling mode, who writes the carried-forward summary: the loop bee itself
(default) or a dedicated cheap bee (see §10).

### Loop artifacts

The on-disk record of a loop: config, rolling summary, history, and per-iteration
logs (see §13).

## 7. Context Modes

Internally one driver with two knobs:

- `carrier ∈ {same, fresh}` — reuse one bee, or spawn a clean bee each iteration.
- `memory ∈ {harness, none, hive-rolling}` — who owns cross-iteration context.

Exposed as a single `--context` flag with three presets:

| `--context`  | carrier | memory       | Notes |
|--------------|---------|--------------|-------|
| `persistent` | same    | harness      | Re-prompt one bee; rely on the **harness's** auto-compaction. |
| `ralph`      | fresh   | none         | Fresh bee each iteration; all state lives on disk / in the repo. |
| `rolling`    | fresh   | hive-rolling | Fresh bee each iteration, **seeded with a hive-maintained summary**. |

Guidance:

- `persistent` is simplest and keeps continuity, but its long-run quality depends on
  the harness's auto-compaction, which is opaque and varies by harness (good on
  Claude, weaker/absent elsewhere). Best for short/medium loops.
- `ralph` is the most robust for very long horizons because every iteration starts
  clean. Requires the task to be re-derivable from disk each pass (a checklist file,
  a work queue, the repo itself).
- `rolling` is "Ralph with memory": fresh context each pass plus a compacted
  narrative hive controls. It gives **uniform, hive-owned compaction across all
  harnesses** and is the recommended long-run default off Claude. Mechanically it
  shares Ralph's fresh-bee code path; the difference is hive injects a summary and
  folds the result forward.

## 8. Iteration Lifecycle — seal as the boundary

Each iteration:

1. **Ensure ready** — for `fresh`, spawn a new bee and wait for driver readiness
   (`isReady(pane)` per `drivers.ts`); for `same`, reuse the existing bee. If the
   bee is `blocked` (trust/MCP prompt), surface and pause rather than spin.
2. **Inject prompt** — send the task prompt (`rolling` also injects `progress.md` +
   `history.md`; see §10). hive appends a standing **"finish by sealing"**
   instruction so the iteration has a defined end.
3. **Work** — the bee does the task.
4. **Seal** — the bee writes a seal (status + artifact). The seal *is* the iteration
   boundary; hive detects it via `waitForSeal` (falling back to idle detection for
   harnesses/tasks that don't seal — see §9).
5. **Fold + evaluate** — `rolling` folds the seal artifact into memory; hive then
   checks every stop condition.

Reusing seal means one mechanism yields three things at once: the iteration
boundary, the summary payload (rolling), and a stop signal (seal status `done`).

## 9. Stop Conditions

A loop stops when **any** active condition fires. Listed cheapest first:

- `--max N` — iteration cap. **Mandatory** unless `--forever`. Default `100`.
- `--max-duration <dur>` — wallclock cap (e.g. `2h`).
- `--forever` — run until `hive loop stop`; disables the mandatory `--max`.
- `--until '<cmd>'` — run a shell command between iterations in the loop cwd; stop
  when it exits `0`. Mechanical, no tokens. The sweet spot for "until something":
  `--until 'npm test'`, `--until 'test -z "$(grep -F "[ ]" TODO.md)"'`.
- `--stop-on-seal <status,...>` — stop when the bee seals with a listed status.
  Default `done`. (Seal statuses: `done`, `blocked`, `needs_input`, `failed`.)
- `--stop-on-sentinel '<regex>'` — stop when a marker line appears in pane/transcript.
  Fallback for harnesses without reliable seals.
- `--judge '<prompt>'` — spawn a cheap bee each iteration to answer "stop?"; stop on
  yes. The only goal-mode-flavored option; **explicitly opt-in**, never default.

Safety interplay: `blocked`/`needs_input` seals (or detected blocked state) pause the
loop and notify, rather than counting as a normal iteration, so a stuck bee is not
re-prompted in a tight spin.

## 10. Rolling Compaction Details

Only applies to `--context rolling`.

**Fold-forward, not reset.** Because the bee is fresh each iteration, "summarize
yourself" must mean *"integrate what you just did into the summary you were handed,"*
not "describe this one iteration." The injected `progress.md` goes in; an updated
`progress.md` comes out. Otherwise memory silently collapses to last-iteration-only
and rolling degrades into Ralph. hive's appended summarize instruction states this
explicitly.

**Append-only history guards the telephone game.** A fresh bee re-summarizing a
summary every pass decays over hundreds of iterations. Mitigations:

- `history.log` is **append-only**, one line per iteration, and the bee **never**
  rewrites it.
- `history.md` (the digest) is re-derived from `history.log` on a token-budget
  threshold, rather than always summary-of-summary.

**What gets injected next iteration:** the static task prompt + `progress.md`
(detailed, last state) + `history.md` (digest). Injection size is budgeted.

**Who summarizes** (`--summarizer`):

- `self` (default) — the loop bee's closing act *is* the summary: hive auto-appends
  "update `progress.md`, append one line to `history.log`, then seal" to the
  iteration prompt. Cheapest, best-informed, zero extra spawn. Risk: lost if the bee
  crashes mid-iteration (next iteration re-derives from the last good `progress.md`).
- `bee` — a dedicated cheap summarizer bee reads the transcript/seal and writes the
  same artifacts. Robust, costs extra tokens. Use when the loop bee is unreliable or
  the work is too sensitive to interrupt with a summarize step.

Both produce the same artifacts; the knob only chooses the author.

## 11. CLI Requirements

### `hive loop start`

```sh
hive loop start --bee <kind> --cwd <dir> --context persistent|ralph|rolling \
  --prompt "<task>" \
  [--until '<cmd>'] [--max N] [--max-duration <dur>] [--forever] \
  [--stop-on-seal <status,...>] [--stop-on-sentinel '<regex>'] [--judge '<prompt>'] \
  [--summarizer self|bee] \
  [--prompt-file <path>]
```

Starts a detached loop, prints the `loopId`. `--prompt-file` reads the prompt from a
file (preferred for long prompts). `--summarizer` applies to `rolling` only.

Example — work a checklist with Ralph until none remain:

```sh
hive loop start --bee claude --cwd ~/Projects/trmd/honeybee/repos/honeybee \
  --context ralph --max 200 \
  --prompt "Take the next unchecked item in TODO.md, do it, check it off. If none remain, seal done." \
  --until 'test -z "$(grep -F "[ ]" TODO.md)"'
```

Example — long-horizon refactor with rolling memory:

```sh
hive loop start --bee codex --cwd ~/repo --context rolling --forever \
  --prompt-file ./refactor-task.md --summarizer self
```

### `hive loop status [<loopId>]`

Show a loop's state: context mode, iteration count, last seal status, last stop-check
result, elapsed time, and the head of `progress.md`. With no id, list all loops.

### `hive loop logs <loopId>`

Tail the loop driver log and per-iteration logs.

- `-n <lines>`
- `-f`, `--follow`
- `--iter <n>` show a specific iteration's log

### `hive loop stop <loopId>`

Signal the detached driver to stop after the current iteration (or immediately with
`--now`, which also kills the in-flight bee). Records a final state.

### `hive loop list`

List loops with status (`running`, `stopped`, `done`, `errored`), context mode, and
iteration count.

## 12. Programmatic Surface

The same capability is exposed to orchestration bees through the flow facade so a bee
can spawn a loop as trivially as a human:

```ts
const loopId = await hive.loop({
  bee: "claude",
  cwd: "/path/to/repo",
  context: "rolling",            // "persistent" | "ralph" | "rolling"
  prompt: "...",
  until: "npm test",             // optional shell predicate
  max: 200,                       // backstop
  summarizer: "self",            // rolling only
});

const status = await hive.loopStatus(loopId);
await hive.loopStop(loopId);
```

If an MCP surface is exposed, mirror these as `loop_start` / `loop_status` /
`loop_stop` tools.

## 13. Artifacts / On-disk Layout

Per loop, under `~/.hive/loops/<loopId>/`:

- `loop.json` — config + live state (see fields below).
- `progress.md` — rolling detailed summary (rolling mode). Latest carried-forward
  state; injected next iteration.
- `history.md` — rolling digest of all iterations (rolling mode). Re-derived from
  `history.log` on a budget threshold.
- `history.log` — append-only, one line per iteration; never rewritten.
- `iter-NNN.log` — per-iteration driver/pane log.
- `seals/iter-NNN.json` — the iteration's seal artifact.

`loop.json` fields:

- `loopId`
- `bee`, `requestedBee`, `cwd`
- `context` (`persistent` | `ralph` | `rolling`)
- `carrier`, `memory` (derived knobs)
- `prompt` (or `promptPath`)
- `stop` — `{ max, maxDuration, forever, until, stopOnSeal, stopOnSentinel, judge }`
- `summarizer` (`self` | `bee`)
- `status` (`running` | `stopped` | `done` | `errored` | `paused`)
- `iteration` — current count
- `currentBee` — live bee id, if any
- `lastSealStatus`
- `lastStopCheck` — `{ condition, result, at }`
- `startedAt`, `updatedAt`, `endedAt`
- `pid`, `pgid` — detached driver process group, for `stop`

This mirrors the flow-run state pattern, so status/logs/inspect/resume come along for
free, and `progress.md` is directly readable by an orchestrator.

## 14. Cross-Harness Considerations

- **Readiness** reuses per-driver `isReady(pane)` (`drivers.ts`) so iteration steps
  detect "awaiting input" uniformly across harnesses.
- **Iteration end** prefers seal; for harnesses/tasks that don't seal, fall back to
  idle detection (`wait.ts`, fingerprint-stable for `idleMs`, default ~3s) plus
  `--stop-on-sentinel`.
- **`persistent` auto-compaction is harness-owned** and therefore uneven; `rolling`
  is the portable way to get controlled compaction everywhere.
- Loops run on whatever substrate the bee runs on (local-tmux or ssh-tmux); no new
  substrate work is required.

## 15. Safety / Operating Defaults

- **Runaway guard:** `--max` is mandatory unless `--forever` is explicitly set.
  `--forever` loops must still be trivially killable (`hive loop stop`).
- **Visible iterations:** every iteration boundary is logged (id, count, seal status,
  stop-check result) so a runaway is observable and a cost trail exists.
- **Blocked ≠ iteration:** a `blocked`/`needs_input`/trust-prompt state pauses the
  loop and notifies; it does not burn iterations re-prompting a stuck bee.
- **No autonomy creep:** loops run the given prompt; they do not select new tasks or
  approve destructive actions on their own. Plan-first defaults still apply to the
  underlying bee.
- **Judge is opt-in:** the only LLM-judged stop condition is explicitly requested,
  never implied.

## 16. Implementation Notes

Loops are sugar over existing primitives, not new core machinery:

- A built-in **`loop` flow** (TypeScript, since TS flows already support
  `while`/conditionals + background execution + status/logs/cancel) whose body uses
  the existing facade ops: `spawn` / `send` / `brief` / `wait` / `waitForSeal` /
  `seal` / `kill` / `log`.
- A **stop-predicate evaluator** that runs `--until` as a child process in the loop
  cwd between iterations.
- **`hive loop` CLI** that compiles to a background flow run
  (`flow run loop --background --arg ...`), reusing the detached runner
  (`__flow-exec`/pgid signaling) and status/logs/cancel plumbing.
- **`hive.loop(...)`** facade method for in-flow / in-agent use.
- Loop state persists to `~/.hive/loops/<loopId>/` (mirrors flow-run state), so a
  driver restart can resume or at least report accurately.

Relevant existing modules: `src/flow/` (facade, background runner, json/ts authoring),
`src/seal.ts`, `src/wait.ts`, `src/drivers.ts`, `src/readiness.ts`, `src/state.ts`,
`src/substrates/`, `src/agents.ts`, `src/cli.ts`.

## 17. Acceptance Criteria

Loops are ready for early use when:

- `hive loop start --context ralph ... --until '<cmd>'` runs fresh bees in a loop and
  stops when the predicate exits 0 or `--max` is hit.
- `hive loop start --context persistent ...` re-prompts a single bee each iteration.
- `hive loop start --context rolling --summarizer self ...` spawns a fresh bee per
  iteration, injects `progress.md` + `history.md`, and the bee's closing seal updates
  `progress.md` and appends to `history.log`; `history.md` is re-derived on threshold.
- `--summarizer bee` produces the same artifacts via a dedicated summarizer bee.
- `hive loop status/logs/stop/list` work; `stop` cleanly halts the detached driver
  and (with `--now`) the in-flight bee.
- A `blocked`/trust-prompt state pauses the loop instead of spinning.
- `hive.loop(...)` lets an orchestration bee start and stop a loop.
- Works against at least Claude and one non-Claude harness (Codex or OpenCode).

## 18. Open Questions

- Should `--until` run only between iterations, or also be allowed to interrupt a
  long iteration (e.g. poll while the bee works)?
- For `rolling`, what default token budget triggers `history.md` re-derivation, and
  should it be size- or iteration-count-based?
- Should `persistent` optionally write an external checkpoint summary too (durable
  recovery), even though the harness owns live context?
- Default behavior when an iteration errors (bee dies, no seal): retry same
  iteration, count it as a failure toward a threshold, or pause? Proposed: retry up
  to N, then pause.
- Should loops emit ledger/`buz` events on each iteration so other bees can react,
  or stay silent unless asked?
- Naming: `hive loop` vs folding under `hive flow` as a preset flow. Proposed:
  dedicated `hive loop` surface, `loop` flow underneath.
