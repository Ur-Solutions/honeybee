# honeybee Navigation-at-Scale PRD

## 1. Summary

**Navigation** gives honeybee (`hive`) a way to find, group, and switch between
bees when there are not ten of them but hundreds or thousands. Today a bee is a
detached tmux session; you find one by scrolling `hive list` or the ⌘s switcher.
That is an O(bees) flat enumeration and it collapses well before a thousand bees.

This PRD reframes navigation around a single principle: **push, not pull.** At
scale the human is the scarce resource, and the vast majority of bees are
autonomously `working` and should be invisible. You do not browse the population;
the few bees that need you announce themselves, and you respond. The list becomes
the exception, the attention queue becomes the default, and standing views become
the unit you actually switch between.

The work builds entirely on the substrate shipped in the `tmux-ux` branch: every
bee already carries `@hive_id` / `@hive_colony` / `@hive_swarm` / `@hive_title` /
`@hive_state` as tmux user options, and tmux filters sessions on those options
natively (`tmux ls -f '#{==:#{@hive_state},waiting}'`) — read-only, instant, no
hive-store polling. The options ARE the navigation API.

## 2. Motivation

- The product direction is many concurrent bees (swarms, colonies, fleets).
  `hive spawn --count` and frames already make spawning hundreds trivial; the
  navigation surface has not kept up.
- A flat searchable list does not solve scale. The bottleneck is not search speed
  but cognitive load: you cannot hold a thousand-bee population in your head, and
  most of it is irrelevant at any moment.
- The expensive signal — "this bee is blocked / waiting / done and needs a human"
  — is already detected (daemon state transitions, `@hive_state`, buz, desktop
  notifications). Navigation should consume that signal instead of making the
  human re-derive it by scanning.
- ⌘s and `hive list` show session names (`CL-3e1`), which are identity, not
  description. The user reported ⌘s is "really hard to use now as I don't know
  what the panes describe" even at current scale.

## 3. Goals

- Decouple the human's cognitive load from the bee count: the day-to-day loop is
  O(bees-that-need-me), not O(bees).
- Make "jump to the next bee that needs input" a single keystroke.
- Make every navigation surface filterable by facet (state, colony, swarm, agent,
  repo, title, node, and possibly tags) without scrolling.
- Make standing, named cockpits the unit you switch between, so the things you
  track grow far slower than the bees.
- Keep it tmux-native and store-light: navigation reads live `@hive_*` options,
  not the hive store, wherever possible.
- Degrade gracefully: every tier is useful on its own and ships independently.

## 4. Non-goals

- Replacing tmux's own navigation (choose-tree, switch-client) — we layer on it.
- A GUI / web dashboard. This is terminal-native, like the rest of hive.
- Autonomous navigation ("AI decides which bee you should look at next" beyond
  mechanical state/priority ordering). Ordering is explicit and inspectable.
- Pane-id-based bee identity (`embed`/`eject`) — still future work, unchanged by
  this PRD.
- Cross-machine aggregation beyond what `hive list` already does across nodes.

## 5. Primary Users

### Tormod / humans

Run a large fleet from inside tmux as the daily driver. Need to respond to bees
that need input without scanning, browse a related cluster on demand, and jump to
a specific known bee instantly.

### Orchestration bees (Jancsi / OpenClaw agents)

Spawn and supervise sub-fleets. Need to query "which of my bees are waiting?"
programmatically (the same facet filters), without tailing panes.

## 6. Design Principle — push, not pull

| | Pull (browse) | Push (triage) |
|---|---|---|
| Primitive | the list | the attention queue |
| Cost | O(bees) | O(bees-that-pinged-you) |
| Default verb | "find the bee" | "go to who needs me" |
| Scales to 1000? | no | yes |

Every requirement below is justified by which side of this table it serves. The
list and switcher do not go away — they become the *pull* escape hatch for the
cases push cannot cover ("show me everything in repo X"). But the default loop is
push.

## 7. Core Concepts

### Facet

A queryable dimension of a bee, surfaced both in the hive store and as a live
`@hive_*` tmux option: `state`, `colony`, `swarm`, `agent`, `repo`/`cwd`,
`title`, `node`, and (pending §13 decision) `tags`. Navigation is "filter the
population by a conjunction of facets."

### Attention set / "needs me"

The bees whose `@hive_state` is `waiting`, `blocked`, or `done` (i.e. not
`working` and not terminal-and-acknowledged). This is the push queue. It is
typically tiny relative to the fleet and is the thing the human actually works.

### View (extended)

The existing `hive view` cockpit (link-window session), extended from a static
selector snapshot into a **live query** over facets, optionally **saved** under a
name. A view is the unit you switch between instead of individual bees.

### Tag / label (proposed)

An arbitrary, multi-valued label on a bee (a bee may carry several), as opposed
to the single-valued `colony`/`swarm`. Tags compose across the hierarchy
("waiting claude bees in repo X"); see the §13 open decision.

## 8. Tiers / Phasing

The work is four tiers, cheapest first; each ships independently. Recommended
order: **Tier 1 + Tier 0 together** (highest leverage, lowest cost), then 2, then
3 after the §13 decisions.

### Tier 0 — faceted list & switcher (cheap)

Make the surfaces you already have queryable.

- ⌘s switcher line carries every facet so fzf narrows on any substring:
  `CL-3e1  [fe-review/t1] claude ~/app  waiting  review the auth PR`.
- State-preset switcher keybinds: a chord that opens the switcher pre-filtered to
  `waiting` (the bees that need you).
- `hive list --state <s> --colony <c> --agent <a> --repo <path> [--tag <t>]`
  filters, composable; plain/JSON output for orchestration bees.

### Tier 1 — attention queue (the real answer)

- `hive next [--state waiting,blocked,done]` switches the current client to the
  next bee in the attention set; cycles on repeat. Pure tmux `ls -f` over
  `@hive_state` — no store read.
- `M-n` keybind bound to it. Optional `M-N` for previous.
- Status bar already shows `N working · N waiting · N done`; make the waiting
  count the headline and (optionally) actionable.
- Ordering is explicit (default: longest-waiting first); see §13.

### Tier 2 — views as the navigation unit

- `hive view --state waiting`, `hive view colony:x --state working`,
  `hive view --tag migration` — views become live facet queries; re-running
  re-materializes (dedupe already exists).
- Saved views: `hive view --save <name> <query>`; `hive view <name>` re-opens;
  a view-switcher (⌘s variant listing only `view-*`).
- Navigate O(views): a handful of standing cockpits per concern regardless of
  fleet size.

### Tier 3 — hierarchy & summarization

- `hive list --group-by colony|swarm|agent|node|state` with rolled-up counts
  ("fe-review: 40 working · 2 waiting") and drill-down.
- Rolled-up state: a colony/swarm reads as `waiting` if any member waits.
- Auto-hide / auto-seal policy for `done`/idle bees so the working set stays
  small (see §13 decision on archival).

## 9. CLI / Keybinding Requirements

### `hive next`
```
hive next [--state <list>] [--prev] [--print]
```
Switch (or `switch-client`, nesting-safe via the Workstream-1 helper) to the next
bee in the attention set. `--print` emits the target instead of switching.

### `hive list` (extended)
```
hive list [--state <list>] [--colony <c>] [--swarm <s>] [--agent <a>]
          [--repo <path>] [--tag <t>]... [--group-by <facet>] [--json]
```
Filters are conjunctive; `--group-by` produces summarized output.

### `hive view` (extended)
```
hive view <selector|--state <list>|--tag <t>> [--name <n>] [--save <n>]
          [--new-client] [--close <n>] [--print]
```

### `hive tag` (proposed, pending §13)
```
hive tag <selector> <tag>...        # add
hive tag <selector> --remove <tag>...
```

### Keybindings (mesh tmux.conf)
- `M-n` / `M-N` → `hive next` / `hive next --prev`
- A switcher chord pre-filtered to `waiting`
- A view-switcher chord (Tier 2)

## 10. Data / Substrate

- Live facets are read from tmux user options via `tmux ls -f '<filter>' -F
  '<format>'` — one call, no store. Already proven for `@hive_state`,
  `@hive_colony`, `@hive_swarm`, `@hive_title`.
- New facets (`@hive_agent`, `@hive_repo`, `@hive_tags`) are stamped at spawn
  alongside the existing options and updated on the same best-effort path as
  `@hive_state`/`@hive_title`.
- The hive store remains the source of truth for metadata; tmux remains the
  source of truth for liveness and live state. No third registry (consistent with
  the existing architecture).
- Tags, if adopted, live in the store (`SessionRecord.tags: string[]`) and are
  mirrored to `@hive_tags` as a delimited string for tmux-side filtering.

## 11. Safety / Operating Defaults

- All `@hive_*` writes stay best-effort (a missing session never breaks a
  command), as today.
- `hive next` and all switchers route through the Workstream-1 nesting-safe attach
  helper — never an `attach-session` inside an existing client.
- Navigation is read-only over the fleet; it never kills, seals, or mutates bees
  (except explicit `hive tag`). Views remain provably incapable of killing a bee.
- Filters never silently truncate: if a cap is applied (e.g. switcher height),
  surface the hidden count.

## 12. Acceptance Criteria

- With 200+ bees, `hive next` lands on a waiting bee in <200ms and cycles through
  exactly the attention set, skipping `working` bees.
- ⌘s, filtered to `waiting`, shows only bees needing input, each with a legible
  title/colony, and selecting one switches without nesting.
- `hive list --state waiting --colony x --json` returns exactly the conjunction,
  usable by an orchestration bee.
- `hive view --state waiting` opens a cockpit of only the waiting bees and
  re-running picks up newly-waiting bees without duplicating windows.
- A saved view re-opens to the same live query days later.
- `hive list --group-by colony` summarizes counts and never enumerates all bees.
- The daily loop on a 1000-bee fleet never requires opening the full list.

## 13. Open Questions / Decisions Needed

1. **One hierarchy or tags?** Today a bee has one `colony` and one `swarm`. At
   scale, cross-cutting queries ("waiting claude bees in repo X") want
   multi-valued **tags**, which compose better than a fixed tree. Decision gates
   Tier 2/3. *Recommendation: add tags; keep colony/swarm as well-known reserved
   facets.*
2. **Ad-hoc or saved views?** Always-fresh queries vs named cockpits you return
   to. *Recommendation: support both; saved views are what make navigation
   O(views).*
3. **Attention-queue ordering.** FIFO (longest-waiting first), priority (blocked
   before done), or spatial (preserve a stable order)? *Recommendation: default
   longest-waiting-first, blocked outranks done.*
4. **Archival policy.** Do `done`/idle bees auto-hide from default surfaces (and
   eventually auto-seal) to keep the working set small, or stay until killed?
5. **Scope of this PRD vs `buz`.** The attention set overlaps with buz's
   idle-transition dispatch. Is `hive next` the human-facing read of the same
   signal buz dispatches programmatically? *Recommendation: yes — one signal,
   two consumers.*

## 14. Out of Scope (future work)

- Pane-id bee identity (`embed`/`eject`).
- Multi-user / shared-fleet navigation.
- Persisted navigation history / "recently visited bees".
- ML-ranked attention ordering.
