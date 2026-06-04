# Honeybee v2 Spec

Status: draft v2 product/architecture spec  
Source: multi-agent code review + product brainstorm, refined in #honeybee 2026-05-23  
Repo: `/Users/trmd/Projects/trmd/honeybee/repos/honeybee`  
CLI: `hive`  
Product: `honeybee`

## 1. Governing Principle

Honeybee is a fast, legible control plane for durable implementing agents.

It is **not** an autonomous project manager. It should not grow a strategic brain. That orchestration layer lives above Honeybee: with Tormod, Jancsi/Hermes, scheduled jobs, manager agents with bounded authority, or human-written recipes.

The clean split:

```text
Hermes / Jancsi / higher agents
= orchestration, planning, decomposition, routing, policy, judgment

Honeybee / hive
= bee runtime, process control, session state, transcripts, handoffs,
  IDs, status, messaging primitives, deterministic mechanical flows
```

Honeybee should be the hands, eyes, radio, cockpit, and clipboard. It owns `who`, `where`, `state`, and `how to reach them`. It does not own `why`.

The design equation:

```text
honeybee = durable interactive seats
         + typed handoffs
         + observable state
         + human/agent steering
         + deterministic runtime recipes
```

Avoid the swarm black box. Build the cockpit.

## 2. Product Boundary

### Honeybee owns

- Where bees run.
- How many bees exist.
- What colony/swarm they belong to.
- How to address/control them.
- Process lifecycle and execution substrate.
- Session state, transcripts, artifacts, and handoff contracts.
- Factual status and retrieval primitives.
- File-backed messaging primitives.
- Deterministic flows as mechanical recipes.

### Honeybee does not own

- Why bees exist.
- Strategy, planning, prioritization, and decomposition.
- Deciding whether a review is sufficient.
- Deciding when to merge, ship, or close an effort.
- Cross-project orchestration.
- Long-term product/project memory beyond its own ledger.
- Interpreting vague human goals.
- Hidden autonomous background work.

If a feature needs judgment, Honeybee should expose data and controls; the upper layer should decide.

## 3. Vocabulary

The taxonomy should stay small. The earlier vocabulary had too many group nouns (`cell`, `squad`, `team`, `mission`, `swarm`) describing overlapping concepts. v2 collapses them.

### Core nouns

```text
bee        one interactive agent/process seat
swarm      a live cohort of bees spawned and addressed as a unit
frame      a reusable blueprint for a swarm: roles, composition, initial briefs
colony     persistent project/org namespace
substrate  execution backend type
node       concrete execution endpoint
caste      role of a bee inside a swarm, if needed
```

### Explicitly not Honeybee nouns

```text
mission    lives above Honeybee, in Hermes/Jancsi/human orchestration
cell       killed; wrong biological scale and too ambiguous
squad      killed; absorbed by swarm
team       killed; template concept is frame
```

### Class/instance discipline

```text
frame -> spawn -> swarm
```

A frame is reusable structure. A swarm is the live thing created from it.

A swarm may be homogeneous or differentiated. That is a property of the frame/spawn, not a different noun. A 100-Codex batch and a 5-role deep review cohort are both swarms.

### Colony scope

A colony is the durable namespace for project-scoped work:

```text
colony:honeybee
colony:marketing
colony:seo
```

Do not think `hive = one colony`. Beekeepers run many colonies; the tool is closer to the apiary.

## 4. Selector Model

Universal verbs act on selectors. Noun subcommands manage nouns.

Do not create parallel verbs like:

```bash
hive send BEE.cl.4 "..."
hive swarm send review-swarm "..."
hive colony send marketing "..."
```

Use one action verb and resolve the target:

```bash
hive send CL.cc9 "..."
hive send @deep-review-001 "..."
hive send colony:marketing "..."
```

Candidate selectors:

```text
CL.cc9
CO.13d
@deep-review-001
colony:marketing
caste:reviewer@deep-review-001
```

Start with the simple stable set:

```text
<bee-id>
@<swarm>
colony:<colony>
```

Add caste selectors only when real workflows demand them.

## 5. CLI Shape

### Universal action verbs

These verbs act on selectors where possible:

```bash
hive spawn <bee> [--count N] [--colony name] [--substrate substrate] [--briefed]
hive spawn --frame <frame> [--colony name] [--substrate substrate] [--briefed]

hive send <selector> "..."
hive brief <selector> "..."
hive wait <selector>
hive kill <selector>
hive seal <selector>
hive tail <selector>
hive attach <bee>
hive ps [--colony name] [--watch]
hive search "..."
```

`spawn` absorbs creation:

```bash
hive spawn codex
hive spawn codex --count 100 --colony seo --briefed
hive spawn --frame deep-review --colony honeybee --substrate ssh:mini01
```

No separate `hive swarm spawn` is needed. `swarm` manages swarm records, it does not duplicate the creation verb.

### Noun management commands

```bash
hive swarm list
hive swarm inspect <selector>
hive swarm destroy <selector>

hive frame list
hive frame define <name> <file>
hive frame inspect <name>
hive frame remove <name>

hive colony list
hive colony create <name>
hive colony inspect <name>
hive colony archive <name>

hive node list
hive node register <name> ...
hive node inspect <name>

hive substrate list
```

### Commands to avoid or rename

- Drop `msg` as a top-level action verb; use `send` for direct send. The durable mailbox ships in Phase 2 as the `buz` noun (file-backed addressed messaging — see §10), not a duplicate of sending.
- Drop `pulse` as a separate verb if it is just status streaming. Prefer `hive ps --watch`.
- Keep `tail` separate from `attach`: `tail` is transcript/pane stream; `attach` is interactive takeover.
- Keep `seal`; it is a good bespoke Honeybee verb. A sealed cell of work means the work is capped and preserved as a handoff artifact.

## 6. Bee Lifecycle and State Machine

`running` / `dead` is too crude. v2 needs factual, derived state that makes a cockpit useful.

Candidate states:

```text
booting
ready
briefed
active
thinking
tool_running
waiting_for_input
blocked
idle_with_output
sealed
dead
error
kill_failed
```

`briefed` is the prepared-but-not-started state. It is not a new noun.

Example:

```bash
hive spawn --frame frontend-redesign --briefed
```

This creates warmed, role-briefed bees that have received initial context but must wait for assigned work.

Example `ps` output:

```text
CL.cc9  review.architect  tool_running       reading src/cli.ts
CO.13d  review.codex      blocked            trust prompt
GR.982  ideas.grok        sealed             artifacts/grok-ideas.md
```

State derivation may use:

- process liveness
- tmux pane contents
- transcript mtime/hash
- last user prompt
- last assistant message
- provider-specific readiness/blockage patterns
- explicit sentinel files or seal records

This is observability, not orchestration.

## 7. Handoff Contract and `hive seal`

Agents saying vaguely “done” is not enough. v2 should make structured completion first-class.

A bee is sealed when it emits a structured handoff artifact and Honeybee records/validates it. Sealing does **not** mean Honeybee approves the work. It means the work has been capped into a durable record for a human or upper agent to judge.

Example seal:

```json
{
  "status": "done",
  "summary": "Implemented canonical record.id display in list output.",
  "filesChanged": ["src/format.ts", "src/cli.ts", "tests/format.test.ts"],
  "testsRun": [
    { "command": "npm run check", "result": "passed" },
    { "command": "npm test", "result": "passed" }
  ],
  "risks": ["Legacy sessions still require exact-name resolution."],
  "nextActions": ["Add migration helper for legacy session IDs."],
  "confidence": 0.78
}
```

Candidate commands:

```bash
hive seal CL.cc9 --from /tmp/review.json
hive wait CL.cc9 --seal
hive last CL.cc9 --seal
```

Seal types may include:

```text
implementation seal
review seal
risk seal
test seal
witness seal
```

Important semantics:

- `seal` records and validates a handoff artifact.
- It does not approve, merge, ship, or decide sufficiency.
- Witness/critic requirements are policy from above, enforced mechanically by Honeybee if supplied.

Example:

```bash
hive seal CL.impl --requires-witness CO.review
```

Honeybee may enforce “both artifacts exist and match schema.” Jancsi/Tormod decides whether that is good enough.

## 8. Frames, Swarms, and Briefed Bees

### Frame

A frame is a reusable blueprint for a swarm.

Example frame:

```yaml
name: deep-review
castes:
  - name: architect
    bee: claude
    count: 1
    brief: Read architecture. Wait for assigned review packet.
  - name: reviewer
    bee: codex
    count: 2
    brief: Read codebase. Wait for assigned file list.
  - name: oddball
    bee: grok
    count: 1
    brief: Look for strange high-upside ideas. Wait.
```

### Swarm

A swarm is a live cohort spawned from either:

- a single bee type plus count, or
- a frame.

Examples:

```bash
hive spawn codex --count 100 --colony seo --briefed
hive spawn --frame deep-review --colony honeybee --substrate local-tmux
```

### Briefed-but-waiting

Briefing warms context without starting substantive work:

```text
You are the accessibility reviewer.
Read the project context.
Do not begin implementation.
Wait for assigned packet.
```

This allows a swarm to be ready on the runway without burning chaos.

## 9. Flow vs Frame

Keep this guardrail sharp:

```text
frame = who exists / roles / composition / initial briefing
flow  = mechanical sequence of operations
```

If something is a predefined set of bees with roles, it is a frame.

If something says “do A, wait for B, route C to D,” it is a flow.

Flows are allowed in Honeybee only as deterministic mechanical recipes. They are not planning brains.

Example:

```bash
hive flow run code-review --repo . --target main
```

Possible TypeScript shape:

```ts
export default flow("dual-review", async ({ hive, args }) => {
  const codex = await hive.spawn("codex", { name: "review.codex" });
  const claude = await hive.spawn("claude", { name: "review.claude" });

  await hive.send(codex, packet("codex-review.md"));
  await hive.send(claude, packet("claude-review.md"));

  await hive.waitForSeal(codex);
  await hive.waitForSeal(claude);

  return hive.collect([codex, claude]);
});
```

Design constraints:

- Prefer thin TypeScript/shell-backed recipes before any YAML DSL.
- Avoid complex orchestration DSLs until the repeated shape proves itself.
- A flow should not decide strategic next actions.
- A flow can execute: spawn, send, wait, collect, seal, return artifact paths.

## 10. Mailbox / Buz

Inter-agent communication should be explicit, addressed, auditable, and low-bandwidth. Do not build Slack inside Honeybee.

Historically this section was called "Bus" (the name still fits the metaphor of a shared transit channel); the shipped noun is spelled **`buz`** for symmetry with bee vocabulary. Storage, command, and module name all use `buz`.

A simple file-backed mailbox under `~/.hive/buz/` is enough. Each bee owns five sub-mailboxes:

```text
~/.hive/buz/
  CL.cc9/inbox/2026-05-23T13-00-00Z-from-CO.13d-<id>.md      # delivered messages
  CL.cc9/outbox/2026-05-23T13-00-00Z-to-CO.13d-<id>.md       # what this bee sent
  CL.cc9/queue/2026-05-23T13-00-00Z-from-CO.13d-<id>.md      # awaiting daemon drain
  CL.cc9/read/...                                            # post --consume
  CL.cc9/quarantine/...                                      # after N delivery failures
  _external/tormod/outbox/...                                # human-originated sends
```

Three delivery tiers, gated by each bee's `buzAccept` policy on the SessionRecord (default when absent: `['queue', 'passive']` — interrupts require explicit opt-in):

- `interrupt` — pasted into the recipient's pane immediately via the substrate.
- `queue` — written to `queue/`; the daemon drains to `inbox/` on the next `active → idle_with_output` transition.
- `passive` — written straight to `inbox/`, no delivery action.

Sender attribution is strict: `--sender <bee>` must resolve to a registered bee id; humans pass `--sender-human <name>` and their outbox lives under `_external/`.

Commands (as shipped):

```bash
hive buz send <selector> --sender CO.13d --tier queue -p "Review this patch"
hive buz send <selector> --sender-human tormod --tier interrupt -p "stop"
hive buz inbox <selector> [--limit N] [--from <ref>]
hive buz outbox <selector>
hive buz queue <selector>
hive buz read <message-id> [--consume] [--bee <ref>]
hive buz purge <selector> [--read | --older-than 30d | --all]
hive buz config <bee> [--accept interrupt,queue,passive]
```

The upper layer decides routing. Honeybee stores and delivers.

## 11. Phone / Walk UX

Tormod needs to steer work while mobile or context-switching. Full transcripts are not a phone UX.

v2 should provide compressed factual status:

```bash
hive ps --terse
hive ps --colony honeybee
hive ps --watch
hive brief CL.cc9
hive brief @deep-review-001
```

Example factual status:

```text
4 bees running.
CO.review sealed: artifacts/reviews/codex.json
CL.review blocked: prompt not submitted
GR.ideas sealed: artifacts/ideas/grok.md
```

If there is a “suggested next action,” it should generally be generated by Hermes/Jancsi from Honeybee data, not by Honeybee itself.

Notifications should be sparse:

- bee sealed
- bee blocked
- bee needs input
- flow completed
- substrate/node went offline

## 12. Search / Librarian / Archaeologist

Useful work disappears into old panes and transcripts. v2 should make retrieval first-class.

Candidate commands:

```bash
hive search "id allocation race"
hive artifacts list --colony honeybee
hive seals find --repo honeybee
```

Keep this as retrieval/indexing substrate. Honeybee returns relevant transcripts, seals, artifacts, and ledger entries. Hermes/Jancsi synthesizes the answer.

This avoids duplicate work without turning Honeybee into a reasoning system.

## 13. Fork / Replay

Fork/replay is useful but not a v2 core dependency unless transcript export is already stable.

Problem: “What if we had asked Codex differently from message 42?”

Full fidelity replay across TUIs is hard. Start simple:

```bash
hive transcript CL.cc9 --until 42 > packet.md
hive spawn claude --name CL.alt
hive send CL.alt "$(cat packet.md)"
```

Possible later command:

```bash
hive fork CL.cc9 --at msg:42 --name CL.alt-review
```

Do not promise time travel until the substrate can actually reproduce enough context.

## 14. Manager Bees and Permission Boundaries

Manager bees can be useful as advisory coordinators, but recursive unmanaged autonomy is a trap.

A manager bee may:

```text
- read colony/swarm state
- summarize status
- suggest next actions
- draft packets
- request spawns
- route messages if explicitly granted
```

A manager bee may not, by default:

```text
- spawn directly
- approve its own work
- mutate repos unless assigned implementation work
- recursively create unmanaged swarms
- make merge/ship decisions
```

The pattern:

```text
manager suggests -> Jancsi/Tormod/upper agent decides -> Honeybee executes
```

If direct authority is added, it must be explicit capability-based permission, not a default role implication.

## 15. Multi-Server and Substrate Model

v2 should generalize beyond “tmux on this Mac” without pretending to be a distributed consensus system.

Staged model:

```text
v0: local tmux on this Mac
v1: primary store tracks remote resources explicitly
v2: remote substrates report heartbeats/artifacts
v3: maybe partial sync / replicated stores if the shape proves necessary
```

Prefer a primary-controller model:

```text
/Users/trmd/.hive
= primary index / ledger / colony/swarm/session records

remote machine/container
= execution resource with local runtime details
```

Remote resource example:

```json
{
  "node": "mac-mini-1",
  "kind": "ssh-tmux",
  "endpoint": "trmd-mini",
  "capabilities": ["claude", "codex", "node", "python"],
  "status": "online"
}
```

### Substrate abstraction

`tmux` is the first substrate, not the ontology.

Candidate types:

```ts
type RunSubstrate =
  | "local-tmux"
  | "ssh-tmux"
  | "docker"
  | "modal"
  | "cloudflare-workers"
  | "browserbase-agent"
  | "e2b"
  | "daytona"
  | "kubernetes"
  | "custom";
```

Same bee interface, different execution backend:

```bash
hive spawn claude --substrate local-tmux
hive spawn codex --substrate ssh:mini01
hive spawn worker --substrate cloudflare
hive spawn researcher --substrate e2b
```

Internal boundary:

```text
Bee
= identity + control channel + transcript/artifact channel + lifecycle

Substrate
= how process exists and how Honeybee talks to it

Node
= concrete place/substrate endpoint where work can run
```

Distributed sync smells expensive before the product shape is proven. Start with honest resource tracking and heartbeats.

## 16. Provider Profiles and Agent Drivers

Provider behavior should be declarative and centralized, not scattered folklore.

Target profile shape:

```ts
type AgentProfile = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwdPolicy?: "repo" | "home" | "custom";
  readiness?: ReadinessMatcher[];
  transcriptReader?: TranscriptReader;
  permissionsMode?: "safe" | "yolo" | "custom";
};
```

Example:

```json
{
  "name": "codex",
  "command": "/opt/homebrew/bin/codex",
  "args": [],
  "env": {
    "HOME": "/Users/trmd",
    "HIVE_STORE_ROOT": "/Users/trmd/.hive"
  }
}
```

Rules:

- Resolution should be pure: `resolveAgent() -> AgentProfile`.
- No settings writes during lookup/help/list/doctor.
- External settings mutations happen only during spawn, after executable validation.
- Mutations are logged in the ledger.
- `HOME` and auth profile behavior must be first-class, especially for Codex/Claude aliases.
- `HIVE_<AGENT>_CMD` should remain argv-style, not shell script syntax.
- Expand leading `~` manually in command tokens or prefer structured config with absolute paths.

## 17. Store, IDs, and Correctness

Honeybee is infrastructure. Infrastructure without store correctness becomes haunted furniture.

v2 correctness requirements:

### ID allocation

- `id-index.json` allocation must be locked.
- Re-read inside lock.
- Write temp file then rename atomically.
- Visible IDs are stable once allocated.
- `hive list` displays canonical `record.id`, not a dynamically recomputed shortest prefix.
- Shortest-unique logic is for resolution, ambiguity messages, completions, and optional helper output.

### Session resolution

For UUID-backed bees:

```text
allow canonical id
allow full UUID prefix no shorter than visible id
allow exact session name
```

For legacy/custom sessions:

```text
exact name only
or require explicit --legacy-prefix / longer minimum prefix
```

A wrong `hive send` is annoying. A wrong `hive kill` can destroy work. Resolution should be conservative.

### Kill semantics

`hive kill` must be transactional-ish:

```text
1. Resolve session record.
2. Attempt tmux/substrate kill.
3. Confirm the process/session no longer exists.
4. Only then delete Honeybee metadata or mark final dead state.
```

If kill fails:

```text
keep session record
mark status = "kill_failed"
record lastError
print recovery command
```

The store must never pretend a bee is dead because its paperwork was shredded.

### Run/wait cleanup

For AI workers, preservation should be the default:

```bash
hive run claude --wait          # wait and preserve
hive run claude --wait --rm     # delete after successful terminal condition
hive run claude --wait --keep   # explicit preserve, alias/clarity
```

Honeybee’s value is durable, attachable, inspectable seats. Auto-deleting sessions after heuristic idle destroys observability.

### Ledger writes

- Ledger append should be concurrency-safe.
- Large JSONL lines may interleave under concurrent writes; lock or use safe append discipline.
- Bound ledger growth or add rotation eventually.

## 18. Safety Defaults

v2 should fail closed around provider prompts and privileged modes.

- Do not auto-accept trust prompts by default.
- `--accept-trust` should be explicit and tied to the session/cwd.
- `--force-send` should only override readiness timeout after printing captured pane context.
- Yolo/full-permission modes must be explicit.
- Provider command overrides must not be shell-injection surfaces.
- Honeybee should not hide automation as fake human input.
- External sends/posts remain above Honeybee unless explicitly modeled as a controlled substrate.

## 19. Implementation Architecture

`cli.ts` should not become procedural pasta.

Target modules:

```text
src/parse.ts        CLI parsing
src/commands/*.ts   command handlers
src/store.ts        session/ledger persistence
src/ids.ts          bee ID allocation/resolution
src/agents.ts       provider profiles
src/drivers.ts      provider-specific readiness/transcript/home facts
src/tmux.ts         local tmux substrate
src/substrates/*    future substrate implementations
src/wait.ts         wait/readiness logic
src/transcripts.ts  transcript extraction/scoring
src/bee.ts          Bee domain object
src/flow.ts         thin flow executor primitives, not orchestration brain
src/seal.ts         handoff schema validation and seal persistence
src/buz.ts          file-backed addressed messaging (three-tier)
src/daemon/*        long-lived dispatcher (launchctl-managed; ticks ~2s)
src/search.ts       seals/ledger/sessions retrieval engine
src/node.ts         node registry (~/.hive/nodes/<name>.json)
```

Principle: keep provider-specific behavior behind drivers/profiles; keep orchestration decisions out of the core.

## 20. Test Pyramid

Next tests should cover more than ID helpers.

### Unit

- argv parser
- command override parsing and tilde expansion
- ID allocation and resolution
- canonical display formatting
- provider profile resolution purity
- readiness matchers
- transcript scoring/tie ambiguity
- seal schema validation
- selector parsing

### Integration with fake substrate/tmux

- spawn -> send -> tail -> wait -> kill
- `run --wait` preserves by default
- `run --wait --rm` removes only after verified terminal condition
- kill failure keeps record and marks `kill_failed`
- list displays canonical `record.id`
- store round-trip under temp `HIVE_STORE_ROOT`
- concurrent spawn allocation
- concurrent ledger writes
- multi-line prompt send

### Golden fixtures

- Claude ready prompt
- Claude unsubmitted pasted prompt
- Codex trust prompt
- Codex MCP warning before readiness
- Grok partial scrollback / durable output file pattern
- OpenCode transcript variants

### Live probes

- real Claude spawn/send/wait/last
- real Codex spawn/send/wait/last
- auth-home aliases (`cc1`, `cc2`, `cc3`, `codex1`, `codex2`, `codex3`)
- `HIVE_STORE_ROOT=/Users/trmd/.hive` visibility from both Hermes and Tormod shell

## 21. Suggested Patch Queue

Recommended order:

1. Display canonical `record.id` everywhere and reserve shortest-unique logic for resolution.
2. Lock + atomic writes for ID allocation/session records/ledger.
3. Preserve `hive run --wait` sessions by default; use explicit `--rm` for cleanup.
4. Harden `hive kill` deletion semantics.
5. Finish parser/module extraction and add parser tests.
6. Add/finish `Bee` abstraction and provider driver/profile boundary.
7. Add `hive ps --terse` with factual state machine.
8. Add `hive seal` and seal artifact schema.
9. Add frame/swarm/colony records and selector parsing.
10. Add briefed spawn mode.
11. Add file-backed buz mailbox (three-tier: interrupt/queue/passive; per-bee `buzAccept` policy).
12. Add deterministic `flow` runner, TypeScript-first.
13. Add search over transcripts/seals/artifacts.
14. Add nodes/substrates registry; start with `local-tmux`, then `ssh-tmux`.

## 22. v2 Acceptance Criteria

Honeybee v2 is credible when:

- Tormod can spawn one bee, 100 homogeneous bees, or a role-differentiated frame with one command.
- Every bee has a stable canonical ID and conservative resolution.
- `hive ps` gives factual, mobile-readable state without reading full transcripts.
- `hive seal` records typed handoff artifacts with tests/risks/next actions.
- A swarm can be addressed as a unit via `@swarm` selectors.
- A colony can group project-scoped bees/swarms/artifacts without implying strategy.
- Flows can run deterministic recipes but cannot become planning brains.
- Provider profiles centralize command/env/readiness/transcript behavior.
- The store survives concurrent spawns and writes.
- Failed kills and blocked provider prompts are represented honestly.
- Jancsi/Hermes can query Honeybee state and artifacts to make higher-level decisions.

## 23. Anti-Goals / Temptations to Resist

Do not build:

- Recursive swarm planning inside Honeybee.
- Built-in “AI decides next task” loops.
- Complex YAML orchestration DSL before simple TypeScript flows prove inadequate.
- Hidden background autonomy.
- Honeybee making merge/ship decisions.
- Honeybee owning product memory.
- Honeybee interpreting vague user goals.
- Honeybee doing strategic prioritization.
- Bee-to-bee freeform group chat as the primary coordination model.
- A distributed system before primary-controller remote resources are exhausted.

That would make Honeybee a second brain. We do not need two brains. We need one sharp cockpit.

## 24. Summary

Honeybee v2 should become a local OS for agent work: durable seats, stable addresses, observable state, typed handoffs, project namespaces, reusable frames, addressable swarms, mechanical flows, and substrate-aware execution.

The architecture boundary is the product. Keep Honeybee concrete. Let Jancsi think.
