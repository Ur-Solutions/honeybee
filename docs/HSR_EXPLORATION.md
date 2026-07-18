# HSR — Hive Substrate Runner (design exploration)

Status: exploration (v1, 2026-07-02) · companion: apiary `docs/substrates-research.md`
Scope: pane-less local agent execution under the hive daemon — harness/mode
matrix, identity & observation, Apiary visibility, promote-to-tmux, and the
subagent-default policy.

---

## 1. Positioning

HSR is a third `SubstrateKind` (`"hsr"`) that runs harness CLIs as **direct
children of the hive daemon** — no tmux session, no pane, no screen-scrape.
Its promises, in priority order:

1. **Cheap, fast subagents.** No tmux server churn, no pane explosion, no
   ptmx consumption (structured mode), sub-second spawn.
2. **Structured truth.** Real events (turns, tool calls, token usage,
   permission requests) instead of regex over `capture-pane`. This upgrades
   `deriveState`, needs-input detection, and the usage sampler from
   heuristics to facts.
3. **Same bee, different floor.** An HSR bee is a normal `SessionRecord` with
   full citizenship: ledger, buz, seals, limits, autoswap, lineage, and
   Apiary visibility — only `attach` differs.
4. **Policy awareness.** A data-driven allowance registry keeps HSR on the
   right side of each provider's rules (see apiary research doc §2) and
   falls back to PTY mode when a structured path is withdrawn (the
   "`claude -p` goes `--bare`" scenario).

Non-goals: remote execution (that's ssh-tmux / sandbox kinds).

**Decision (2026-07-02): HSR is the default substrate for most agents in
Apiary** — not only agent-spawned subagents. Since Apiary's chat pane reads
native transcripts (§3), structured steering and in-chat permission handling
make a pane redundant for ordinary work. tmux becomes the *opt-in* substrate,
chosen when the session genuinely needs a terminal: SSH/remote work, raw TUI
interaction, or an explicit terminal-attach workflow. Compose's runner chip
should default to `Hive runner (HSR)` with `Local tmux` one keystroke away.

---

## 2. Harness × mode matrix

hive currently ships eight drivers (`src/drivers.ts`): claude, codex,
opencode, grok, kimi, cursor, pi, droid. Everything hive already computes for
them is **substrate-neutral and reused wholesale**: `resolveAgent` →
`AgentSpec {command,args,env}`, `homeEnv` isolation (CLAUDE_CONFIG_DIR /
CODEX_HOME / …), account activation (`activateAccountIntoHome`), model flags
(`modelArgsForAgent`), forced session ids (`forcedSessionIdArgs`). HSR changes
only the last mile: *what process shape wraps the AgentSpec*.

Four runner tiers, best-available wins:

| Tier | Shape | Process economics |
|---|---|---|
| **S** — server-multiplexed | one long-lived server process, N sessions over RPC | best; one process per (harness, home) |
| **B** — bidirectional stream | one process per session, stdin/stdout protocol, multi-turn | one process per bee |
| **T** — turn-based re-exec | process per *turn*, state carried by harness resume | zero idle processes |
| **P** — PTY fallback | node-pty around the interactive TUI | 1 pty + watcher thread per bee |

Per harness (verified where noted; ? = verify during build):

| Harness | Best tier | Mechanism | Multi-turn | Resume (for promote) | Native transcript on disk | Confidence |
|---|---|---|---|---|---|---|
| **claude** | B | `claude -p --input-format stream-json --output-format stream-json` (process stays alive across turns) or Agent SDK in-proc | ✅ | ⚠️ headless↔headless only — interactive `--resume` CANNOT rejoin a `-p` session (§7 2026-07-03) | ✅ JSONL under `$CLAUDE_CONFIG_DIR/projects/…` (also in `-p` mode) | high |
| **codex** | **S** | `codex app-server` (JSON-RPC over stdio; the official embedding protocol — `codex proto` is gone). One server per (home/account) hosts many conversations; approvals arrive as RPC callbacks | ✅ | `codex resume <id>` / `codex exec resume` — rollout id learned from server | ✅ rollout JSONL under `$CODEX_HOME/sessions/…` | high |
| **opencode** | **S** | `opencode serve --hostname 127.0.0.1 --port 0`; authenticated REST + SSE, one isolated server/session per bee | ✅ (strict queued prompts; next-tool steering at native tool events) | ✅ REST session id is the same SQLite-backed id accepted by interactive `opencode --session <id>` (1.17.18, 2026-07-18) | ✅ SQLite (Apiary already reads it) | high |
| **kimi** | B | `kimi acp` — bidirectional ACP JSON-RPC over stdio; Honeybee owns initialize/session/prompt/cancel and permission callbacks | ✅ (queued turns) | ✅ `session/resume` over ACP and `kimi --session <id>` in the TUI share the native session store (0.27.0, 2026-07-17) | ✅ `$KIMI_CODE_HOME/sessions/…/<session>/agents/main/wire.jsonl` | high |
| **grok** | B | `grok --no-auto-update agent --no-leader stdio` — native ACP JSON-RPC over stdio | ✅ (queued turns) | ✅ ACP `session/load`; interactive `grok --resume <id>` / `--continue` shares the native session store (0.2.102, 2026-07-18) | ✅ per-session dir under `$GROK_HOME` (Apiary reads it) | high |
| **cursor** | T? | `cursor-agent -p/--print` headless exists; resume support decent | per-turn | `cursor-agent resume`? verify | ? | low-med |
| **droid** | T | `droid exec` headless (Factory) | per-turn | session id in output; verify | ? | med |
| **pi** | P | no known structured mode | — | — | ? | low |

Notes:
- **Tier S is a meaningful efficiency jump for codex/opencode**: a swarm of 20
  codex subagents = *one* `app-server` process per account-home, not 20 TUIs
  in 20 panes. This is where "abstracts the different CLIs in the most
  efficient way possible" cashes out.
- **Model/reasoning**: Kimi ACP does not honor the top-level TUI model/mode
  flags. Its adapter applies `model` and `mode` after new/resume with
  `session/set_config_option`. Supported model ids are `kimi-code/k3`,
  `kimi-code/kimi-for-coding`, and
  `kimi-code/kimi-for-coding-highspeed`.
- **Grok model/reasoning and input**: the Grok adapter starts ACP with the
  selected `--model` and `--reasoning-effort`, then applies the negotiated
  model/reasoning and permission mode to the new or loaded session. It handles
  standard ACP permission requests plus Grok's `x.ai/ask_user_question`
  extension without flattening multiple questions or multi-select choices.
- **Accounts/limits**: HSR structured events include token usage (claude
  `result` messages; codex token-count RPCs; OpenCode completed assistant
  messages with separate non-cached input, output, cache read/write, reasoning,
  total, and cost fields) → the usage sampler gets exact
  numbers for HSR bees instead of pane-scrape estimates. Autoswap keeps
  working (it operates on SessionRecords + accounts, not panes); "exhausted"
  detection improves from regex to typed error events.
- **Allowance registry** (versioned data, not code) rows: (harness, authKind)
  → permitted tiers, required flags, env scrub list (`ANTHROPIC_API_KEY` on
  subscription spawns), fingerprint strings that trigger fallback, policy
  note + date. The registry is *also* what decides tier P is required — e.g.
  if a future `claude` release makes `--bare` the `-p` default and the
  installed version refuses OAuth in print mode, the claude row flips B→P
  without a code change.

### The RunnerAdapter interface (sketch)

```ts
type RunnerAdapter = {
  harness: string;
  tier(): "server" | "stream" | "turn" | "pty";       // from allowance registry + probing
  start(spec: AgentSpec, opts: RunnerOpts): Promise<RunnerSession>;
};
type RunnerSession = {
  sessionId: string;                  // provider session id (pinned or learned)
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  events: AsyncIterable<RunnerEvent>; // turn_start/end, tool, usage, needs_input{kind,question,options}, exit
  snapshot(lines?): string;           // rendered tail for Substrate.capture() compat
  stop(): Promise<void>;
};
```

`SubstrateHsr` implements the lean `SubstrateCore` (apiary research §5.1) by
delegating to per-harness adapters; `snapshot()` renders recent events as
text so the daemon's existing `deriveState`/readiness path still functions,
while a parallel structured path feeds typed state directly.

---

## 3. Identity, records, and observation

An HSR bee is a first-class bee:

- **SessionRecord** as today, with `substrate: "hsr"`, no `tmuxTarget`/
  `agentPaneId`; new fields: `runnerPid`, `runnerTier`, `providerSessionId`
  (already exists — pinned at birth for claude, learned for others).
- **`hive here` without `$TMUX_PANE`:** HSR stamps `HIVE_BEE=<name>` (+
  `HIVE_PARENT`, `HIVE_COMB`) into every child env. `hive here` resolution
  order becomes: `$HIVE_BEE` → `$TMUX_PANE` reverse index. This keeps every
  in-agent affordance (`hive fork`, self-sealing, buz) working pane-lessly —
  and it's worth adding to tmux spawns too, for robustness.
- **Daemon integration:** HSR runs as a daemon service. The tick loop needs
  no structural change: `substrateFor(record)` returns the HSR substrate,
  whose `snapshot()/liveness()` answer from the in-memory runner registry
  (backed by pid checks). Runner event streams additionally push
  `lastObservedState` transitions directly (no 2s polling latency for
  needs-input — it's event-driven).
- **Crash recovery:** runner children are detached-pgid processes (reuse
  `flow/background.ts` plumbing) with run dirs under
  `~/.hive/hsr/<bee>/{meta,events.jsonl,ring.txt}`. If the daemon restarts,
  it re-adopts children from meta files (pid + pgid + start-time check);
  orphans whose process died get `status: "dead"` like any bee.
- **Kimi telemetry:** ACP supplies transcript/tool/input events but no token or
  rate-limit stream. The adapter safely tails only `usage.record` and terminal
  structured error records from the matching native `wire.jsonl`, starting at
  EOF on resume. It never re-emits context or content records, so assistant
  text remains single-sourced from ACP. Auth, rate-limit, and generic errors
  are de-duplicated against prompt RPC failures before entering the durable
  HSR event log.
- **Grok telemetry:** each ACP prompt result carries exact aggregate input,
  output, cache-read, and reasoning-token usage. Honeybee persists that usage
  even when the prompt RPC fails. JSON-RPC `-32003` becomes an exhausted event
  with the provider reset/login detail; failures that require a fresh login
  become `auth_expired { requiresLogin: true }` with actionable recovery detail.

### Apiary visibility — yes, and mostly for free

This is the crux question, and the answer is strong: **HSR bees appear in
Apiary's normal Agent Run chat with zero Apiary changes for the read path.**

- Apiary's session list watches `~/.hive/sessions/*.json` — HSR bees are
  there (they're SessionRecords).
- Apiary's transcript pane doesn't read tmux at all — it reads **native
  provider transcripts** via the capture host (fileSource/grokDir/opencodeDb),
  resolved by `providerSessionId` + home. Claude in `-p` mode, codex under
  `app-server`, opencode under `serve` — all still write their native
  transcripts to the (isolated) home dirs. The APIA-66/67 pipeline lights up
  unchanged.
- **Steering:** Apiary calls `hive send`, which dispatches through
  `substrateFor(record).sendText(...)` → HSR routes it to
  `RunnerSession.send()`. One hive-side change, no Apiary change.
- **Terminal pane:** the only degraded surface. No tmux target to attach.
  Options: (a) render the ring buffer + live stream over the daemon socket
  as a read-only "console" tab; (b) hide the terminal tab for HSR bees;
  (c) promote (§4). Recommend (a)+(c).

And one place where HSR is *better* than tmux in the chat:

- **Permission prompts become structured needs-input.** Tier B/S surfaces
  approvals as protocol callbacks (Agent SDK `canUseTool` /
  `--permission-prompt-tool`; codex app-server approval RPCs). HSR emits
  `needs_input{kind: "permission", tool, args, options}` → daemon → Apiary
  can render **real approve/deny buttons in the chat pane** and answer over
  the same channel. In tmux, the same moment is a scraped `❯ 1. Yes` menu
  that Apiary can only answer by faking keystrokes. The interactive story is
  *stronger* pane-lessly — which is exactly why promote matters less.

---

## 4. Promote to tmux (and demote)

With full chat visibility + structured steering + in-chat permission
handling, promotion is an **escape hatch**, not a core flow. Remaining uses:
the user wants the raw TUI (slash commands, visual diffs), a harness quirk
needs eyeballing, or tier-P output is garbled.

Mechanics — `hive promote <bee>` (and `hive demote <bee>` symmetric):

1. **Quiesce.** If mid-turn: either wait for `turn_end` (default, with
   timeout) or `interrupt()` (`--now`). Turn-based tiers are always
   quiescent between turns.
2. **Stop the runner** cleanly (tier S: end the conversation on the shared
   server — the server keeps serving other bees; tier B/T/P: SIGTERM the
   child).
3. **Relaunch via resume** on `local-tmux`:
   `substrate.newSession(target, cwd, spec')` where `spec'` is the normal
   interactive AgentSpec **plus resume args**: claude `--resume <uuid>`,
   codex `resume <rolloutId>`, opencode attach-to-session, etc. Same home,
   same account, same env — so the harness sees its own session and replays
   its own history natively (no transcript surgery needed; this is the same
   trick fork/`--session-id` pinning already relies on).
4. **Update the record**: `substrate: "local-tmux"`, new `tmuxTarget` +
   `agentPaneId`, keep `uuid`/`providerSessionId`/`combId`/`parentId`;
   ledger `session.promote` event. Apiary's watcher picks up the change;
   the terminal pane goes live; the chat pane never blinked (same
   providerSessionId → same native transcript file → capture host follows
   the same file).
5. **Demote** is the mirror: kill the pane (not the session record),
   relaunch under HSR with the same resume args. Useful for "I steered it,
   now background it again" — and it makes promote non-scary (round-trip
   safe).

Per-harness feasibility = the *Resume* column in §2. `hive promote`/`demote`
is enabled for Codex, Grok, OpenCode, and Kimi. Claude remains rejected because
its stores are disjoint; cursor/droid wait for verified round trips; pi never
(tier P can instead "re-parent" by spawning a
fresh tmux TUI with a context re-injection brief — lossy, labeled as such).

Edge cases: mid-turn interrupt loses in-flight tool output (harnesses handle
this — same as ctrl-c in the TUI); a promote while a permission request is
pending should auto-answer "deny/ask again in TUI" or carry the prompt over
(the TUI will re-prompt on resume); tier-S server keeps running for its other
bees — promote only detaches one conversation.

---

## 5. HSR as the default for agent-spawned subagents

Agreed — this should be the default, and hive can detect the context cleanly.

- **Origin detection:** a spawn is *agent-initiated* when the calling env has
  `HIVE_BEE` (HSR children) or `$TMUX_PANE` resolves to a bee via the
  `hive here` index (tmux children). Both exist/are planned today; no
  heuristics needed.
- **Policy knob** (config + per-spawn override):
  `spawn.defaultSubstrate = { user: "local-tmux", agent: "hsr" }`, overridable
  with `hive x --substrate tmux|hsr` and per-frame/flow settings. Fork
  follows the same rule: `hive fork` from inside a bee lands the child on
  HSR unless `--pane`/`--window` is explicit (those flags *are* a substrate
  choice — they mean "I want it visible next to me").
- **Why it's right:** subagents are read by their parents, not attached to
  by humans; combs stop filling with panes nobody looks at; 25-agent fan-outs
  stop being 25 ptys + 25 TUI redraw loops; spawn latency drops (no tmux
  round-trips, tier S reuses a warm server); and macOS ptmx/fd budgets stop
  being the fan-out ceiling entirely in structured tiers.
- **Needs-input routing:** HSR emits structured needs-input → daemon checks
  `parentId`: if the parent is alive, deliver as **buz to the parent** (it's
  the orchestrator's job); only escalate to the user (notification /
  Apiary Needs-me) when parentless or the parent is dead/idle past a
  threshold. This implements Apiary's planned "suppress orchestrated
  children" notification rule (architecture §9) at the source instead of in
  the UI.
- **Lineage & views:** `parentId` lineage is substrate-independent, so
  Apiary's hierarchical orchestration views and `hive bees` trees are
  unaffected.
- **Combs are deprecated by this design (decision 2026-07-02).** Multiple
  agents sharing one tmux session (sub-bee panes, `newPane`, fork
  `--pane/--window`) existed to make subagents *visible* inside tmux — Apiary
  now provides that visibility natively via lineage views over HSR bees.
  Plan: new forks/subagents land on HSR (never as panes); `newPane`/comb
  spawn paths are retired; `combId` remains as a legacy read-only field until
  records age out; pane pinning (`agentPaneId`) stays, since one-bee-per-
  session still needs correct pane targeting when users split windows
  manually. This also shrinks the `Substrate` interface HSR must satisfy.
- **Governor:** per-tier concurrency budgets (tier S: sessions per server;
  tier B/T: max children; tier P: pty budget ~64 with queueing +
  `kern.tty.ptmx_max` headroom check), per-account concurrency caps (limits
  data is already per-account), and a global fan-out cap with overflow
  queueing — the same shape as Apiary's round-robin pool queue, one level
  down.

---

## 6. Build order (HSR-internal)

1. **Daemon socket** (unix, JSON-RPC): spawn/send/interrupt/observe/liveness.
   (Also the transport Apiary's future event stream rides on.)
2. **claude tier B + codex tier S adapters** + allowance registry v1 + env
   scrubbing + run-dir/adoption plumbing. These two cover the overwhelming
   majority of real subagent load.
3. **Subagent default policy** (origin detection + config knob + needs-input
   → parent buz routing).
4. **Apiary read-path validation** (should be zero-change; fix the terminal
   pane to show ring-buffer console for HSR bees).
5. **Promote/demote** for verified shared-session-store harnesses (Codex,
   Grok, OpenCode, and Kimi; Claude is explicitly gated).
6. **Grok and Kimi ACP plus OpenCode tier S**, then cursor/droid tier T probing.
7. **Tier P fallback** (node-pty ≥1.2.0-beta.14, ring buffer, governor) —
   last, because tiers S/B/T cover current policy reality; P is insurance.

Open questions carried forward: cursor/droid resume verification; whether
the Agent SDK (in-proc) or
`claude -p` stream-json (subprocess) is the better claude tier B (SDK gives
`canUseTool` + hooks; subprocess gives cleaner process isolation and env
scrubbing — lean subprocess first, SDK when permission-routing lands);
ring-buffer size/retention; whether HSR events should *also* be the capture
source for Apiary (replacing file-tailing for HSR bees) or stay
transcript-file-based for uniformity (lean: files for v1, socket stream
later).

---

## 7. Implementation corrections (living)

Dated notes where building against the real code/binaries refined §1–§6.

### 2026-07-18 — OpenCode 1.17.18 uses authenticated REST/SSE, not ACP

Inspection of the installed 1.17.18 binary and matching official source
confirmed that ACP still bridges permission requests but not `question.asked`.
Shipping ACP would therefore strand a turn that uses OpenCode's structured
question tool. The production adapter instead owns a per-bee
`opencode serve --hostname 127.0.0.1 --port 0` process and:

- generates a random `OPENCODE_SERVER_PASSWORD`, authenticates every health,
  REST, and SSE request with Basic auth, parses the actual loopback port, and
  terminates the detached process group on stop;
- creates or validates a directory-owned session, subscribes to `/event`
  before the first asynchronous prompt, filters every provider event by
  session, and reconciles messages/status/pending inputs after SSE reconnect;
- maps assistant text and reasoning deltas, tool lifecycle, exact completed
  message usage/cost, idle/error/auth/rate state, permissions, and all native
  structured questions into runner events;
- replies to questions as ordered `string[][]` data, preserving multiple
  questions and multi-select answers, and replies to permissions through the
  native permission endpoint;
- queues normal sends one turn at a time, holds `next-tool` sends for a real
  tool boundary, aborts through the session API, and resumes the existing id
  only after cwd and Honeybee ownership checks;
- accepts only qualified `provider/model` selectors and maps OpenCode's
  reasoning effort to its `variant` field.

OpenCode HSR is intentionally **local-only** for now. Its `auth.json` can hold
credentials for several providers, so Honeybee must never ship that whole file
to a remote node. Remote support waits for safe filtering to the selected
provider credential.

### 2026-07-02 — Runner host process model (refines §3 crash recovery, §5.2)

**Decision: HSR runners are detached, self-supervising host processes — not
children hosted inside the daemon tick loop.** Building against the daemon
(`src/daemon/run.ts`) made the tension concrete: the daemon is a launchd
LaunchAgent that today is a *pure observer* (spawning tmux bees never requires
it), and its reliability model is a strictly-sequential, per-call-timeout-bounded
tick loop. Holding N harness children's stdin/stdout protocol streams *inside*
that process would (a) couple every HSR bee's life to daemon restarts (a
restart orphans the pipes → the live stream-json/app-server conversation is
unrecoverable, only re-enterable via resume), and (b) inject unbounded
concurrent protocol I/O into a loop engineered to stay lean.

Instead, mirror the existing `flow/background.ts` precedent (which §3/§5.2
already say to reuse):

- **Runner host = a detached-pgid process** (hidden CLI subcommand, e.g.
  `hive __hsr-run <bee>`), spawned by the spawn path the same way
  `spawnDetachedRun` forks flow runs. It owns the harness child (holds its
  pipes), runs the per-harness adapter, and writes the run dir
  `~/.hive/hsr/<bee>/{meta.json,events.jsonl,ring.txt}`.
- **Steering** (`send`/`interrupt`/`answer`) → the host listens on a per-bee
  control socket `~/.hive/hsr/<bee>/control.sock` (JSON-RPC, the APIA-73
  transport). `hive send` / SubstrateHsr connect to it.
- **Tier S** (codex `app-server`) shares one host per `(harness, home/account)`
  hosting N conversations; its control socket is keyed by the server, and each
  bee addresses its conversation/thread id.
- **The daemon does not host runners.** It (and `hive bees`) *observe* them by
  reading run dirs (liveness from `meta` pid/pgid/start-time; snapshot from
  `ring.txt`; state/needs-input from `events.jsonl` tail). "Crash adoption"
  therefore means *reconciling run-dir meta with live pids* — not recovering
  pipes. Dead host → `status: dead`. No hard daemon dependency for HSR
  spawn/steer; the daemon adds observation + needs-input→parent-buz routing.
- **APIA-73's role sharpens**: the unix-socket JSON-RPC is (1) a reusable
  transport/codec used by both the per-bee control sockets and (2) a
  daemon-level aggregate control/observe endpoint for Apiary (spawn/observe/
  liveness across all HSR bees). It is *not* a hard prerequisite for a
  CLI-driven HSR spawn — the CLI spawns the detached host directly — so the
  build validates the runner host + adapters end-to-end via the CLI first,
  then layers the daemon aggregate endpoint on top.

Net effect on build order (§6): item 1 (socket) is delivered as the shared
JSON-RPC **transport** first, then the runner host/registry/run-dirs reuse it
for per-bee control, then the adapters, then the daemon aggregate endpoint +
`deriveState` HSR branch (HSR liveness is registry/run-dir based, since
`deriveState` otherwise reads every pane-less bee as `dead`).

### 2026-07-02 — Two bugs caught by the first live claude run (tier-B validated)

Running a real `claude -p` stream-json bee end-to-end through the runner
surfaced two issues unit tests missed:

1. **Control socket must not live under the run dir.** An AF_UNIX path is
   capped at ~104 bytes (macOS) / ~108 (Linux). `<runDir>/control.sock` under a
   relocated/temp `HIVE_STORE_ROOT` (or a long bee name) exceeds it →
   `listen EINVAL`. Fix: the control socket lives at a SHORT hashed path
   (`/tmp/hive-hsr-<uid>/<bee8>-<hash16>.sock`), recorded in
   `meta.controlSocket` for observers to read back. Run dir still holds
   meta/events/ring.
2. **Host must not leak the child on setup failure.** If `startRpcServer` (or
   any post-spawn step) throws, `runHsrHost` now stops the already-spawned
   harness child before rethrowing — otherwise the orphaned child + its open
   stdio pipes hang the process. Relatedly, the stream runner now destroys the
   child's stdio pipes on exit so a finished host exits cleanly (no zombie
   `__hsr-run`).

Confirmed working: `claude -p --input-format stream-json` DOES persist across
turns (two user messages on one kept-open stdin → two results), so tier-B
(one persistent process, multi-turn) is correct as designed.

### 2026-07-03 — claude interactive/headless session stores are DISJOINT (breaks §4 promote for claude; codex is fine)

Building APIA-84 (promote/demote) disproved the §2 claude Resume claim
("`claude --resume <uuid>` — deterministic … also in `-p` mode"). Verified
repeatedly against claude 2.1.199:

- **Interactive `claude --resume <id>` cannot rejoin a `-p`/headless session** —
  it returns `No conversation found` for every HSR (`-p`-created) session, even
  though the JSONL is on disk under `~/.claude/projects/…`. `--continue` picks
  up the most recent *interactive* session and ignores a `-p` one.
- **Headless `claude -p --resume <id>` of an *interactive* session also fails.**
- **Headless↔headless resume WORKS** with full continuity.

So claude has two disjoint session stores (interactive TUI vs headless `-p`),
and §4 promote (HSR-headless → interactive tmux) / demote (interactive tmux →
HSR-headless) **cannot carry claude conversation history** — the resumed
process errors and exits ~1s. The on-disk JSONL ≠ interactive-resumability.

**codex has NO such separation** — `codex resume <threadId>` rejoins an
app-server (HSR) thread interactively; codex promote/demote works end-to-end
with continuity.

Mitigation shipped in APIA-84: promote/demote now **liveness-gate** the relaunch
(`tmuxSessionSurvives`/`hsrChildSurvives`) and **fail-safe roll back** to the
original substrate (`reviveHsrRunner`/`reviveTmuxPane`) if the resumed process
dies, so a rejected resume never bricks a bee. Also: codex mints its thread id
at runtime, so `cmdPromote` backfills `record.providerSessionId` from the HSR
`meta.json` before resuming (generalize into the observe/reconcile loop as a
follow-up). Product decision on whether claude stays promote/demote-gated is
tracked with APIA-84.

### 2026-07-03 — remote-hsr vs ssh-tmux: when to choose which (APIA-97 parity)

Phase B (APIA-90–96) landed `remote-hsr` as the proper structured remote
substrate. `ssh-tmux` stays — the two are complementary, not redundant:

| | **remote-hsr** (structured) | **ssh-tmux** (attach-first) |
|---|---|---|
| On the node | detached runner-host, no tmux | a tmux session/pane |
| Observation | structured events streamed home (§APIA-94) → exact state/usage, in-chat needs-input | screen-scrape over `tmux capture-pane` |
| Steering | `hive send` → runner-host RPC over the ssh-forwarded socket | tmux `send-keys` |
| Attach | read-only console (ring + live stream) / `promote` to local tmux | `hive attach` → a real remote TUI |
| Economics | tier-S shares one server per (harness,home); no ptmx/pane churn | one pane per bee |
| Best for | fan-out subagents, background work, structured chat/usage, cheap swarms | raw TUI interaction, visual diffs, an explicit terminal-attach workflow on the remote |

Default remote work → **remote-hsr**. Reach for **ssh-tmux** when a human needs
to sit in a real terminal on the remote (slash-commands, TUI, eyeball a quirk).
`remote-hsr` can `promote` a bee to local tmux for the raw-TUI moments (§4).

**Parity confirmed (2026-07-03):** APIA-85's Substrate-interface shrink (removed
`newPane`/`killPane`) did NOT regress ssh-tmux — `tests/ssh-tmux.test.ts` 24/24,
`cli.multinode` 8/8, `cli.attach.remote` 2/2, `substrates.local-tmux` 17/17 all
green. The **live** ssh-tmux suite (`ssh-tmux.live.test.ts`) + the remote-hsr
real-host e2e both need a reachable ssh host and are exercised in APIA-98
(loopback ssh key-auth is not provisioned in the dev sandbox — flagged).

### 2026-07-04 — first REAL-ssh remote-hsr run (metal-1): two transport bugs the mocks hid

Bootstrapped + drove a real remote node (`trmd-metal-1`, linux, node v24) over a
real ssh forward. `hive node status <remote>` reported `offline` every time
("ssh child exited early"). Root cause was TWO bugs that the mock-only Phase B
tests (exec-hook + in-proc socket relay) structurally could not catch — both in
`src/hsr/remoteTransport.ts`, fixed together:

1. **The forward tunnel must NOT share the ControlPersist master.** `ssh -N -L`
   with `ControlMaster=auto` + `ControlPersist` hands its forward to a
   *backgrounded* master and the foreground `ssh` exits `0` at once —
   `openSshSocketForward` (correctly) reads that foreground exit as the tunnel
   dying, and worse, successive tunnels race for the local socket via
   `StreamLocalBindUnlink`, so it flaps. Fix: the tunnel now gets a DEDICATED,
   non-multiplexed connection (`ControlMaster=no`, no `ControlPath`) — the
   foreground process lives for the tunnel's whole life. Costs one ~0.4s
   handshake per node; irrelevant for a long-lived tunnel. Short exec commands
   (`ensureRemoteServe`) still reuse the shared master.
2. **`~` is not expanded in a `-L` forward target.** `DEFAULT_REMOTE_SOCKET` was
   `~/.hive/…`; the remote *shell* expands `~` when starting the serve (so the
   serve binds `/root/.hive/…`), but sshd does NOT expand `~` in a forward spec —
   the local socket bound yet forwarded to a nonexistent remote path and carried
   no RPC. Fix: `ensureRemoteServe` resolves `~/…` → absolute via the remote
   `$HOME` and returns it; the forward targets the resolved path so serve-bind
   and forward agree.

**Validated over real ssh (zero credentials shipped, via the `stub` adapter driven
directly against the runner-host's forwarded control socket):** bootstrap;
`node status` → online ~0.5s cold; `spawn` (tier stream); `observe` + `send`
streaming `turn_start`/`text`/`turn_end` home (APIA-94 event mirror path over real
ssh); `list`/state; `kill` → empty; and RECONNECT — hard-killing the `ssh -N`
forward mid-session emits `reconnect`→`up`, the tunnel re-establishes, a retried
`send` succeeds and the `observe` subscription self-heals (events resume on the
new tunnel). STILL DEFERRED (needs credential sign-off / a running daemon):
account-bound real codex/claude bee via hive's `ephemeral-token` deliver+shred
path (test tier 7), usage sampling against a live provider, and the daemon-hosted
`remoteEventMirror` writing remote events into a local run dir.

### 2026-07-17 — production Kimi ACP runner

Kimi Code 0.27.0 was verified against its live ACP process and native session
store. Honeybee now implements the complete local lifecycle: initialize,
new/resume, explicit model/mode config, queued prompts, tool and assistant
updates, permission/question callbacks, cancellation, stop, and process exit.
The adapter tails native wire telemetry only for usage and structured failures;
ACP remains the sole transcript source.

Remote Kimi HSR remains deliberately **local-only**. No Kimi credential is
minted or copied to a remote node, and `spawnBee` rejects the request before
remote transport or account credential handling. Remaining remote work is to
design and test a short-lived or refresh-token-safe Kimi credential delivery
and shredding policy; the existing Claude/Codex policy is not generalized by
assumption.

### 2026-07-18 — production Grok ACP runner

The locally installed `grok 0.2.102 (ab5ebf69acec) [stable]` exposes a native,
long-lived ACP process at `grok --no-auto-update agent … stdio`. Honeybee now
owns the full local lifecycle: ACP initialize/authenticate, new/load, queued
prompts, cancel, model/reasoning/mode selection, standard text/thought/tool
updates, standard permission callbacks, Grok structured questions, exact
per-prompt usage, rate/auth classification, and orderly process-group stop.
The deterministic fixture covers prompt errors that still carry usage and
verifies next-tool delivery waits for an actual tool boundary.

The guarded live smoke on 2026-07-18 exercised cached-token authentication,
`session/new`, one no-tools marker prompt, a native usage envelope with a
non-zero total, orderly stop, `session/load` of that exact session, and a
second orderly stop. It deliberately did not spend additional turns on live
permissions/questions/rate-limit paths; those remain deterministic-fixture
coverage.

Remote Grok HSR is deliberately **local-only** for both auth kinds. Subscription
spawns explicitly select cached-token authentication, scrub `XAI_API_KEY` and
`GROK_CODE_XAI_API_KEY`, and never copy Grok's rotating OAuth material to a
node. API-key spawns explicitly select `xai.api_key` and preserve those env
variables because developer-API billing is intentional, but remote delivery is
still rejected until Honeybee has a tested ephemeral secret delivery and
shredding path. This keeps API-key behavior explicit without treating a static
key as permission to generalize the subscription credential policy.
