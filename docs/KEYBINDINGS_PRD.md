# honeybee Keybindings & In-tmux Affordances PRD

## 1. Summary

The operator lives inside tmux full-time (WezTerm → tmux), and honeybee (`hive`)
already ships a curated keyboard layer: a managed tmux.conf with `M-*` no-prefix
bindings (`M-s` fzf switcher, `M-j` choose-tree, `M-d`/`M-D` splits, `M-t`
new-window, `M-w` kill, `M-Enter` zoom, `M-1..5`, `C-a` prefix), a 2-row status
bar reading `@hive_*` options, and WezTerm `cmd→Meta` translation under a managed
marked block. What is missing is the **keybinding LAYER as a first-class hive
concern**: the picker commands the popups invoke, the standalone in-tmux
affordances (rename the current bee, grab URLs out of a pane), and a single,
authoritative map of which hotkey belongs to which spec.

This PRD is that single home. It owns three things end-to-end:

1. **The keybinding distribution / management model** — how hive ships and
   verifies the recommended binding set without seizing ownership of the
   operator's hand-curated config (`hive keys print | path | check | doctor`).
2. **The display-popup picker subcommands** — a thin, stdout-only verb
   (`hive spawn-picker --frame|--flow`) whose output feeds `fzf` inside a
   `display-popup -E`, plus the picker↔fzf↔action contract.
3. **The standalone minor features** — `hive here` (the pane→bee reverse-lookup
   bridge), rename-current-bee, and the `hive urls` URL grabber.

It **supersedes `docs/fork-and-pane.md` §7.5** (see §10), **cites**
`docs/fork-and-pane.md` §7.3 for the `hive here` pane-identity primitive, and
**delegates** the faceted ⌘s engine to `docs/NAVIGATION_PRD.md`, workspace rename
/ archiving to `docs/WORKSPACES_AND_QUESTS_PRD.md`, and parent-association /
tags / move-to-colony to `docs/TAGS_AND_RELATIONSHIPS_PRD.md`. Syn integration is
out of scope.

The design rests on two seams already proven in the repo: the marked-block
discipline (the WezTerm `-- >>> hive >>>` block at `/Users/trmd/.wezterm.lua`),
and the popup-picker pattern (`tmux ls -F '#{@hive_*}' | fzf | cut | xargs tmux
…`) from the shipped `M-s` switcher (`/Users/trmd/mesh/profiles/tmux/.tmux.conf:37-38`).

## 2. Motivation

- The operator runs a large fleet from inside tmux. Spawning, forking, renaming,
  and triaging bees should be single chords, not multi-step shell sessions.
- `docs/fork-and-pane.md` §7.5 sketches the keybinding idea in three lines
  (`bind-key b/s/f` + "`hive keys install` to append it") but never specifies the
  picker subcommands, the install model, the collision policy, or the binding
  set. That sketch needs a real home before any of it is implementable.
- The wishlist in `docs/hotkey-and-minor-features.md` mixes items this layer owns
  (rename bee, spawn-from-frame/flow pickers, URL grabber) with items owned by
  three sibling PRDs (faceted ⌘s, workspace rename, parent-association,
  move-to-colony). Without an explicit distribution map these get built twice or
  not at all.
- The `M-*` / `cmd-*` keyspace is nearly exhausted by the shipped bindings.
  Adding new affordances safely requires a deliberate collision ledger, not
  ad-hoc key grabs.
- Several affordances ("act on the bee I'm looking at") need a `$TMUX_PANE`→bee
  reverse lookup. `hive here` is that bridge primitive and the blocking
  prerequisite for the whole layer; it deserves a pinned CLI surface.

## 3. Goals

- Be the **single home** for the keybinding layer: install/management model,
  picker subcommands, standalone affordances, and the ownership map.
- Add new bindings that are **collision-safe against the already-shipped set**,
  verified against the live mesh tmux.conf for the tmux layer. The terminal
  ALT/cmd layer in `~/.wezterm.lua` is a separate, list-keys-invisible collision
  source that must be checked by eye (or by an extended `hive keys doctor`) — see
  §6 ledger.
- Keep hive's footprint in the operator's config **minimal and reversible**:
  hive ships a documented snippet and verify tooling; the operator owns the
  bindings.
- Make picker subcommands **thin, testable, and reusable** — stdout-only list
  verbs that compose with `fzf` in a binding, never embedding switching/spawning
  logic in the picker itself.
- Specify the standalone minor features (`hive here`, rename-current,
  `hive urls`) to an implementable bar.
- **Reconcile, do not duplicate**: every wishlist item maps to exactly one owner;
  delegated items get a binding here and a citation, never a re-implementation.
- **Stage cleanly across sibling PRDs**: a binding whose backing command is not
  yet shipped must degrade gracefully, not install a dead key.

## 4. Non-goals

- A dotfile framework, a per-key rebind UI, or a config DSL. One documented
  snippet, one verify command.
- Auto-mutating the operator's `~/.tmux.conf` / mesh profile / `~/.wezterm.lua`
  as the default behavior (see §7 and §13 for why; a managed installer is left as
  a strictly-additive future option).
- The faceted ⌘s search/group engine, `hive next`, saved views — owned by
  NAVIGATION_PRD; this PRD owns only the **bindings that invoke them**.
- Workspace rename semantics, quest start, archiving/indexing — owned by
  WORKSPACES_AND_QUESTS_PRD; this PRD owns only the bindings.
- Parent-association filtering, tags, the move-to-colony mutation — owned by
  TAGS_AND_RELATIONSHIPS_PRD.
- Cross-substrate (`ssh-tmux`) keybindings — deferred (see §13).
- Deep Syn integration — separate project, out of scope (§17).

## 5. Primary Users

### Tormod / humans

Live in tmux as the daily driver (WezTerm → tmux). Want single chords to spawn a
bee from a frame, fork the bee under the cursor, rename it, grab a URL it printed
and open it, and jump to the next bee that needs input — all without leaving the
attached client or hand-typing `hive` commands. Hand-curate their own tmux.conf
and expect hive to respect that ownership.

### Orchestration bees (Jancsi / OpenClaw agents)

Invoke the same picker/affordance verbs programmatically (e.g. `hive urls <bee>
--json`, `hive here --id`) for scripting, without the tmux binding layer. This is
why the affordances are CLI verbs, not inline shell baked into bindings.

## 6. Core Concepts

### Keybinding layer (two-layer model)

A clean split between **how a command is summoned** and **what the command does**:

- The **binding layer** (this PRD) is a key → `display-popup -E "<verb> | fzf |
  <action>"`. It carries no domain logic beyond "open a picker" or "run a command
  with the current-bee context."
- The **command layer** (this PRD's own verbs, plus NAVIGATION / WORKSPACES /
  TAGS verbs) does the actual work.

The seam between them is the `@hive_*` tmux option layer and `hive here`.

### Picker subcommand

A thin hive verb that **prints candidates one-per-line to stdout** (the selectable
machine token in a fixed column) and does nothing else. The tmux binding wraps it:
`display-popup -E "<picker> | fzf | cut -fN | xargs <action>"`. Pickers are pure
(no switching, no spawning, no store writes) and therefore trivially testable by
snapshotting stdout. They reuse the existing completion loaders.

### `display-popup -E` + `$TMUX_PANE` inheritance

`display-popup -E` runs the command in the pane's environment, so `$TMUX_PANE` is
set inside the popup. This is the mechanism that lets `hive here` (and any
`--here` flag) resolve the current bee from inside a popup. The entire affordance
layer rests on this one fact (proven by the shipped `M-s` binding; the `prefix+L`
account picker that also demonstrates it is documented in PHASE3 but not yet in
the live conf, §6).

### `hive here` — the bridge primitive

Reverse lookup `$TMUX_PANE` → `SessionRecord.agentPaneId`; fallback `$TMUX`
session name → `tmuxTarget`. Resolves "the bee I'm looking at" so bindings can
target it. The resolution algorithm is specified in `fork-and-pane.md` §7.3
(Phase A/B pane-pinning); this PRD pins its **CLI surface** for keybinding use and
is its primary consumer (§9).

### Marked block

The idempotent install/update discipline already used by the shipped WezTerm
block: a region delimited by start/end sentinel comments, replaced wholesale on
update. This PRD reuses the pattern as the **documented shape** the operator may
adopt, and as the shape a future managed installer would use — but the default
model (§7) does not write it for the operator.

### Collision ledger

The enumerated set of already-bound keys against which every new binding is
checked. New bindings draw only from verified-free keys. There are **three
independent collision sources**, not one:

1. **The mesh tmux layer** (`~/mesh/profiles/tmux/.tmux.conf`): `C-a` prefix;
   `M-s/M-j/M-d/M-D/M-t/M-w/M-Enter/M-1..5`, `M-arrows`. This conf does **not**
   unbind tmux defaults, so under `C-a` the default `prefix-s` (choose-tree) and
   `prefix-f` (find-window) are still live.
2. **The WezTerm `cmd→Meta` hive block** (`~/.wezterm.lua`, `-- >>> hive >>>`):
   maps `cmd→M-`, `cmd+shift→M-<shift>`, `cmd+opt+arrow→M-arrow` onto the same
   M-keys as source (1).
3. **The leftover WezTerm Zellij ALT→ESC layer** (`~/.wezterm.lua`, lines
   ~61–71): `ALT+f→M-f`, `ALT+n→M-n`, `ALT+i→M-i`, `ALT+o→M-o`, `ALT+p→M-p`,
   plus `ALT+ø`/`ALT+æ` and ALT-arrows, all sending Meta sequences straight into
   tmux. **This means lowercase `M-f`, `M-n`, `M-i`, `M-o`, `M-p` are NOT free**
   even though the tmux conf never binds them. This ALT layer is **lowercase
   only** — capital/shifted forms (`M-F`, `M-N`, `M-R`, …) remain free.

`prefix+L` (account login) is **documented** in `docs/PHASE3_MESH_INTEGRATION.md`
but is **not** in the live conf (no `bind-key L`); it is still listed as a key to
avoid so the documented binding lands cleanly when shipped.

**Blind spot.** `hive keys check` reads `tmux list-keys`, so it sees sources (1)
and (2) (the WezTerm block ultimately resolves to tmux M-keys) but is
**structurally blind to ALT-origin collisions** that live only in `~/.wezterm.lua`
(source 3) — those never reach the tmux key table. The terminal ALT/cmd layer
must be eyeballed against `~/.wezterm.lua`, or `hive keys doctor` extended to read
it (§7.3, §13).

## 7. Keybinding architecture (install / management)

### 7.1 Principle — documented snippet, no config mutation

hive never writes to the operator's `~/.tmux.conf`, mesh profile, or
`~/.wezterm.lua` by default. It ships verbs plus a canonical, copy-pasteable
binding block (`docs/honeybee.tmux.conf`) and provides **print + verify** helpers.
The operator pastes, or `source-file`s, the parts he wants, and owns collisions.

This is the deliberate, opinionated choice for *this* operator: he hand-curates
his tmux.conf, the mesh profile is template-managed (re-rendered out from under
any inline edits), and collision resolution against his `M-*` set is a judgment
call only he can make. An auto-rewriter fights all three. The cost — paste/source
once, re-run `hive keys check` after upgrades — is bounded and auditable. This
**supersedes** `fork-and-pane.md` §7.5's "`hive keys install` to append it":
append-machinery is replaced by print + verify.

### 7.2 Artifacts hive ships

1. **`docs/honeybee.tmux.conf`** — the canonical, copy-pasteable binding block
   (the full recommended set, §11). A header comment documents that it is
   *unmanaged* and the operator owns it. Designed to be either (a) pasted into the
   operator's conf, or (b) referenced via `source-file <path>` from his own conf
   so updates flow without re-paste.
2. **The picker / affordance verbs** — `hive here`, `hive spawn-picker
   --frame|--flow`, `hive urls`, `hive rename --here` (§8, §9) — the targets the
   bindings call.

`hive keys print` reads from the **same canonical string** that backs
`docs/honeybee.tmux.conf`, so the doc and the command can never drift.

### 7.3 The `hive keys` command group (print / inspect, zero mutation)

```
hive keys print  [--tmux | --wezterm]   # emit the recommended block to stdout
hive keys path                          # print the abs path of docs/honeybee.tmux.conf
hive keys check                         # diagnose: which recommended binds are live; flag collisions
hive keys doctor                        # check + end-to-end popup-env / fzf / opener / substrate probes
```

- **`hive keys print`** emits the recommended binding block to stdout. `--tmux`
  (default) prints the tmux block; `--wezterm` prints the `cmd→Meta` additions
  needed for the new cmd keys this PRD introduces (§11). Redirecting to a config
  file (`hive keys print >> ~/.tmux.conf`) is the operator's explicit choice, not
  hive's.
- **`hive keys path`** prints the absolute path of the shipped
  `docs/honeybee.tmux.conf` (resolved relative to the hive install) so the
  operator can `source-file` it. (Path-stability caveat: see §13.)
- **`hive keys check`** reads the live tmux server bindings (`tmux list-keys`) and
  the live `@hive_*` options, reports which recommended binds are present/absent,
  flags collisions against the already-shipped tmux `M-*` set, and runs the static
  substrate/PATH checks (confirms `fzf` and a browser opener `open`/`xdg-open` are
  on `PATH`, and that the substrate is `local-tmux`; warns under `ssh-tmux`, §13).
  Pure read; exits non-zero if recommended verbs are unreachable (e.g. `hive` not
  on `PATH` inside popups). This is the safety valve that replaces install
  idempotency: instead of managing a block, hive lets the operator manage it and
  verifies the result. **Limitation: `check` covers the tmux layer only.** It
  reads `tmux list-keys`, so it cannot see ALT-origin collisions that live only in
  `~/.wezterm.lua` (the leftover Zellij ALT→M layer, §6) — those never reach the
  tmux key table. The collision report is therefore *necessary but not sufficient*;
  the terminal ALT/cmd layer must be eyeballed.
- **`hive keys doctor`** (OPTIONAL, Phase 2 — see §14) adds the end-to-end
  popup-probe that `check`'s static checks cannot do: spawn a probe
  `display-popup -E` running `hive here --id` and confirm it resolves (proving
  `$TMUX_PANE` inheritance at runtime). A future extension would also parse
  `~/.wezterm.lua` to surface the ALT/cmd-layer collisions `check` is blind to.
  The PATH / substrate / `fzf` / opener checks now live in `check` (above), not
  here.
- **`hive keys check --against-recommended`** (drift, optional): compares live
  binds to the shipped recommended set so an operator who pasted an older snippet
  learns it is stale after a hive upgrade.

### 7.4 Why no marked-block installer (and the door left open)

The WezTerm side already uses a `-- >>> hive >>>` marked block managed by the mesh
setup, so the precedent for managed blocks exists. This PRD deliberately does not
extend that to tmux bindings because (a) the operator hand-curates his tmux.conf
and an auto-rewriter fights him; (b) collisions with his `M-*` set are his
judgment call; (c) `source-file` already gives update-flow without ownership
transfer.

If a managed installer is ever wanted, it is a **strictly-additive future phase**
(§14) that wraps `hive keys print` with the same marked-block discipline the
WezTerm block already demonstrates:

```tmux
# >>> hive keybindings >>>
# Managed by `hive keys install` — re-running replaces this block. Do not edit by hand.
# hive-keys-version: <sha256-12>
… bindings …
# <<< hive keybindings <<<
```

Such an installer would: read the whole file, delete any existing anchored span
(regex, line-start anchored), append a fresh block, write atomically (tmp +
rename), back up once (`<path>.bak-<ts>`), and emit a `tmux source-file` hint. The
version-hash line drives drift detection without parsing bindings. **INCLUDE mode**
(`source-file ~/.config/hive/honeybee.tmux.conf` rather than inline) would be the
default for the mesh-managed case so re-renders never clobber the block. This PRD
leaves that door open but does not walk through it — `hive keys install` is not
part of the shipped surface.

### 7.5 Dependency gating (graceful degradation)

Some recommended bindings target verbs owned by sibling PRDs not yet shipped
(`hive workspace rename`, `hive quest start`, `hive move`). The print/verify model
does not gate these — the snippet always installs cleanly — but each delegated
binding **degrades gracefully**: a binding whose backing verb is absent surfaces a
no-op error inside its own popup (which closes), never a dead key that breaks the
keymap. `hive keys check` reports which delegated bindings are live vs. pending so
the operator knows what is wired. Only `hive here` (and the Phase A/B pane-pinning
it depends on) is a true blocker for the `--here` affordances.

## 8. Picker subcommands (display-popup targets)

This PRD owns these verbs. They are the targets the `display-popup -E` bindings
invoke.

### 8.1 The picker contract

Every picker:

- **Emits candidate lines to stdout**, one per line, with the selectable machine
  token as the **first** whitespace/tab field (mirroring the `M-s` switcher's
  `cut -d' ' -f2` discipline). Multi-field rows are TAB-delimited so `cut -f1`
  extracts the token regardless of spaces in titles.
- **Does no switching/spawning itself.** The picker = list; the binding = `fzf` +
  action. This keeps pickers testable (snapshot stdout) and the action explicit.
- **Exits 0 with empty stdout** when there are no candidates (the binding's
  `xargs -r` then no-ops and the popup closes cleanly).
- **Exits non-zero** with a `dim` stderr message when the context is wrong (e.g.
  not inside tmux for a `--here` path).
- **Reads the LOCAL store.** Pickers (and explicit-selector verbs like
  `hive urls <bee>`) enumerate the local fleet. Run from a popup under `ssh-tmux`
  (which executes in the *remote* shell) they would mismatch context, so they must
  **detect `ssh-tmux` and hard-error** rather than silently target the wrong fleet
  (§13).

Candidate loaders are already parallel-friendly (the `Promise.all` in
`getCompletions`, `src/completion.ts:411-421`): `listFrames()`, `listFlows()`,
`listSwarms()`, `listColonies()`, `listSessions()` (§12).

### 8.2 `hive spawn-picker [--frame | --flow] [--here]`

Lists spawn candidates for a `display-popup` "spawn something here" chord.

- `--frame` (default): emits one frame name per line from `listFrames()` (the
  `frameList()` pattern, `src/cli.ts:2051-2081`).
- `--flow`: emits one flow name per line from `listFlows()`.
- `--here`: a passthrough hint echoed back so the binding can append `--here` to
  the spawn action unconditionally; the spawned bee then links into the current
  pane/session via the existing `--here` / `maybeLinkHere` path
  (`src/cli.ts:272-314`, `linkHere` `src/view.ts:145-180`). The picker itself only
  prints.

Binding shapes (the picker prints; the binding adds `fzf` + the spawn action):

```tmux
# spawn from frame, link here:
display-popup -E "hive spawn-picker --frame | fzf --prompt='frame> ' \
  | xargs -r -I{} hive spawn --frame {} --here"

# spawn swarm from flow (start verb owned by WORKSPACES §8.2):
display-popup -E "hive spawn-picker --flow | fzf --prompt='flow> ' \
  | xargs -r -I{} hive quest start --flow {}"
```

This **fully specifies** what `fork-and-pane.md` §7.5 named only as
`hive spawn-picker --here`: the flag surface, the stdout format, and the
picker/fzf/action split. There is a **single** picker verb — `hive spawn-picker`
with `--frame` / `--flow` selecting the candidate source. The two spawn chords
(`M-b` spawn-from-frame, `M-F` spawn-swarm-from-flow) differ only in which flag
the binding supplies; there is no separate `hive frame-picker` / `hive
flow-picker` verb. The flow→swarm spawn **semantics** are owned upstream
(WORKSPACES §8.2 / the flow runner); this PRD owns only the picker + binding.

### 8.3 `hive split` binding (no new picker by default)

Decompose / add a sub-bee. The default binding calls the existing `hive split
--here` directly (`hive split` owned by fork-and-pane Phase B, §7.2). An optional
`hive split-picker` could emit caste/agent candidates (the `BEES` list,
`src/completion.ts:49-52`) so the operator picks a sub-bee type, but the default
ships pickerless.

### 8.4 `hive fork` binding (no new picker)

Fork the current bee. Uses `hive here --id` inline (the bridge primitive, §9):

```tmux
display-popup -E "hive fork \"$(hive here --id)\" --here"
```

`hive fork` is owned by fork-and-pane Phase C; this PRD owns only the binding.

### 8.5 Move-to-colony (delegated; binding shape only)

"Move bee to colony" (wishlist) lists colonies (`listColonies()`) → `fzf` → a
move mutation. The colony picker is trivially ownable here, but the **mutation**
is `hive move <bee> --colony <c>`, defined in TAGS_AND_RELATIONSHIPS_PRD §11
(command surface). Decision: defer the whole feature (including its picker) there
to keep relationship mutations in one PRD. The delegation is live — the verb
exists in TAGS — so this is a real citation, not a forward reference (§10).

### 8.6 Nesting safety

Pickers that only `spawn` / `fork` / `open` are nesting-safe by construction (they
never switch the client). Any binding that ends in `switch-client` / `attach` (the
waiting-switcher chord, `hive next`) MUST route through the Workstream-1
nesting-safe attach helper (NAVIGATION_PRD §9, ~line 167: "switch-client,
nesting-safe via the Workstream-1 helper"; restated NAVIGATION §11), never a raw
`attach-session` inside an attached client. `display-popup -E` already isolates the
popup shell from the parent client.

## 9. Standalone minor features

### 9.1 `hive here` — pane→bee reverse lookup (the bridge)

Specified algorithmically in `fork-and-pane.md` §7.3 (the spec home); this PRD
pins its CLI surface for keybinding use and is its primary consumer.

```
hive here [--id] [--json]
```

- **Resolution** (per §7.3): read `$TMUX_PANE` → match
  `SessionRecord.agentPaneId` (Phase A pane-pinning); fallback `$TMUX` present →
  `tmux display -p '#{session_name}'` → match `SessionRecord.tmuxTarget` (solo
  combs / legacy unpinned bees). When a pane matches a sub-bee sharing a comb, the
  **pane match wins** over the session match (returns the sub-bee, not a sibling).
- **Output**: default prints bee name; `--id` prints the stable bee id (for
  `hive fork "$(hive here --id)"`); `--json` prints the full record. Error to
  stderr + non-zero exit if not inside tmux or no match.
- **Back-compat**: unpinned legacy bees resolve via the `$TMUX` fallback and never
  error merely because `@hive_pane` is absent.
- **Performance**: a single `listSessions()` + env reads, plus the optional
  `display -p` fallback — no substrate round-trip in the common (pinned) path.

`hive here` is **bee-only**. The owning-workspace lookup the ⌘⇧R binding needs is
a separate, WORKSPACES-owned `hive workspace here` (whose `ws-*` prefix detection
is owned there) — not a `--workspace` flag on this verb. This resolves §16 open
question 1: keeping the workspace resolution out of `hive here` avoids the
cross-PRD split that risked drift.

This is the **blocking prerequisite** for every `--here` / current-bee affordance.

Acceptance: `hive here --id` inside any bee pane prints that bee's id; inside a
sub-bee pane it prints the sub-bee, not a sibling (inherits fork-and-pane B2).

### 9.2 Rename current bee (cmd+r) — owned here

A binding over the existing rename verb. Ship a thin convenience wrapper so the
binding carries no fragile shell:

```
hive rename --here <new-title>
```

`hive rename --here <title>` is an **argv-reshaping wrapper** over the existing
`cmdRename` handler (`src/cli.ts:617`). `cmdRename` reads `parsed.args[0]` as the
**selector** and `parsed.args.slice(1)` as the **title** (the selector-then-title
contract, `src/cli.ts:618,621`). The wrapper must therefore:

1. Intercept `--here` and pull the bare positional as the title.
2. Resolve the current bee via `hive here --id`.
3. **Inject the resolved id as `args[0]`** (the selector) and shift the title to
   `args[1]`, BEFORE delegating into `cmdRename`.

This preserves the selector-then-title contract so the title is never mistaken for
a selector (the failure mode if `--here <title>` were passed through raw, where
`<title>` would land in `args[0]` and be resolved as a selector). The existing
`--auto` / `--clear` paths are unaffected. `hive rename` sets `@hive_title` (not
the tmux session name; already mirrored to the status bar rows and the `M-s`
switcher line), so the rename is visible immediately without re-attach.
Recommended binding (collects the name in-pane):

```tmux
bind -n M-r display-popup -E -w 60% -h 20% \
  "read -p 'rename bee> ' n && [ -n \"$n\" ] && hive rename --here \"$n\""
```

Shipping `hive rename --here` (rather than inlining `hive rename "$(hive here
--id)" "$n"` in the binding) keeps the fragile `$()` capture out of the snippet
and makes the rename path testable in TypeScript (mitigates the quoting hazard
flagged by review). `cmd+r → M-r` is documented under `hive keys print
--wezterm`; lowercase `M-r` is verified free — it is not bound in the mesh conf
and not in the WezTerm ALT layer (which only takes `f/n/i/o/p/ø/æ`, §6 ledger).

Acceptance: cmd+r → type → status bar (row 1/row 2) and the `M-s` line update
without re-attach.

### 9.3 `hive urls` — URL grabber (cmd+u) — fully owned

```
hive urls [<bee>] [--lines <n>] [--open] [--json]
```

Lists website URLs printed in a bee's pane, for `fzf` + open-in-browser.

- Default bee is the current one via `hive here` when omitted; accepts an explicit
  selector to grab from another bee.
- Captures pane scrollback via `substrate.capture(tmuxTarget, lines, agentPaneId)`
  (`capture(target, lines, paneId?)`, `src/substrates/local-tmux.ts:93` — already
  accepts `paneId` and large history; bounded by the tmux `history-limit`, ~100k
  in the mesh conf). `--lines` defaults to ~2000, capped to `history-limit`.
- Extracts URLs with `/https?:\/\/[^\s<>"{}\\|^`\[\]]+/g`, strips trailing
  punctuation `.,;:)]}'"`, dedupes via a `Set` preserving first-seen order. Emits
  one URL per line; `--json` emits an array; `--open` opens the first match
  directly (rare path — the `fzf` flow is the norm).

Binding (`cmd+u → M-u`, verified free):

```tmux
bind -n M-u display-popup -E -w 70% -h 60% \
  "hive urls | fzf --prompt='url> ' --no-sort | xargs -r open"
```

`--no-sort` preserves recency order. The browser opener is platform-detected in
the **snippet** (`open` on macOS, `xdg-open` on Linux), not baked into `hive urls`
— the verb stays side-effect-free unless `--open` is passed.

Feasibility is high: every primitive (capture with `paneId`, regex, `fzf`, opener)
already exists; **no substrate changes**.

Acceptance: a bee that printed N URLs → cmd+u popup lists N deduped URLs, Enter
opens the chosen one in the default browser; empty → popup closes with a `dim` "no
URLs" line. (Scrollback-only limitation: see §13/§16.)

### 9.4 Switcher binding (cmd+s — already shipped)

The `M-s` switcher (`tmux.conf:37-38`) is a pure-tmux `tmux ls -f/-F | fzf |
switch-client`. The "better grouped ⌘s" wishlist item does **not** introduce a new
CLI verb. NAVIGATION's switcher is, by its own §10 stance, a pure `tmux ls -f/-F`
— "the `@hive_*` options ARE the navigation API." So the grouped-⌘s enhancement is
NAVIGATION **enriching the inline `tmux ls -F` FORMAT STRING** (NAVIGATION Tier 0,
§9 keybindings): a longer `-F` template that carries the `@hive_colony` /
`@hive_swarm` (and the Tier-0 `@hive_agent`/`@hive_repo`/`@hive_tags`) facets so
fzf narrows and groups on them. **This PRD owns the binding string** (it lives in
`docs/honeybee.tmux.conf`); NAVIGATION owns the format string and the facet
options it reads (NAVIGATION §9–10). There is no `hive switcher-format` verb. We do
not reimplement faceting. The switch action routes through the nesting-safe helper.

## 10. Dependency / distribution map

Every wishlist item in `docs/hotkey-and-minor-features.md` mapped to exactly one
owner. **OWNED-HERE** = this PRD specifies the command. **DELEGATED** = the binding
lives here, the command lives in the cited PRD. **OUT-OF-SCOPE** = excluded.

| # | Wishlist item | Owner | Command / verb | Binding |
|---|---|---|---|---|
| 5 | Rename current bee (cmd+r) | **OWNED-HERE** | `hive rename --here` (over existing `hive rename`) | `M-r` (this PRD) |
| 6 | Rename current workspace (cmd+shift+r) | **DELEGATED** → WORKSPACES §9 | `hive workspace rename` | `M-R` (this PRD) |
| 7 | Spawn swarm from frame picker | **OWNED-HERE** (picker) | `hive spawn-picker --frame` → existing `hive spawn --frame --here` | `M-b` (this PRD) |
| 8 | Spawn swarm from flow picker | **OWNED-HERE** (picker) | `hive spawn-picker --flow` → `hive quest start --flow` (WORKSPACES §8.2) | `M-F` (this PRD) |
| 10 | Parent association filter (owned-by / reports-to) | **DELEGATED** → TAGS_AND_RELATIONSHIPS_PRD | `hive list --parent` / facet (via NAVIGATION facets once landed) | no key reserved |
| 11 | Better ⌘s selector (group by colony→swarm) | **DELEGATED** → NAVIGATION Tier 0 / §9–10 | NAVIGATION-owned `tmux ls -F` format string (no new verb) | `M-s` binding string (this PRD) |
| 12 | List URLs + fzf + open-in-browser | **OWNED-HERE** | `hive urls` | `M-u` (this PRD) |
| 13 | Automatic archiving / indexing | **DELEGATED** → WORKSPACES §8.4 | `hive quest done` → archive path (not a standalone daemon) | none |
| 14 | Deep Syn integration | **OUT-OF-SCOPE** | — (separate project) | none |
| 15 | Move bee to colony | **DELEGATED** → TAGS_AND_RELATIONSHIPS_PRD §11 | `hive move <bee> --colony <c>` (defined in TAGS §11; + colony picker) | binding shape (§8.5) |

Plus the in-tmux primitives and navigation bindings:

| Capability | Owner | Command | Binding |
|---|---|---|---|
| Pane→bee reverse lookup | **CITES** fork-and-pane §7.3 (CLI surface OWNED-HERE) | `hive here` | n/a (consumed by other bindings) |
| Spawn bee here | binding OWNED-HERE; verb existing | `hive spawn --frame --here` | `M-b` / `prefix b` |
| Decompose / sub-bee | binding OWNED-HERE; verb fork-and-pane B | `hive split --here` | `M-x` / `prefix e` |
| Fork current bee | binding OWNED-HERE; verb fork-and-pane C | `hive fork "$(hive here --id)" --here` | `M-k` / `prefix k` |
| Next / prev attention bee | **DELEGATED** → NAVIGATION Tier 1 / §9 | `hive next` / `hive next --prev` | `M-g` / `M-N` (this PRD) |
| Waiting-filtered switcher | binding OWNED-HERE; format string NAVIGATION Tier 0 | `tmux ls -f waiting -F <fmt>` (NAVIGATION format; no new verb) | waiting chord (this PRD) |

### Wishlist quick ledger

```
line 5  rename bee ......... OWNED  (binding + `hive rename --here`)
line 6  rename workspace ... binding OWNED; verb → WORKSPACES §9
line 7  spawn-from-frame ... picker + binding OWNED (`spawn-picker --frame`); spawn verb existing
line 8  spawn-from-flow .... picker + binding OWNED (`spawn-picker --flow`); start verb → WORKSPACES §8.2
line 10 parent assoc ....... DEFER → TAGS_AND_RELATIONSHIPS (filter via NAVIGATION facets)
line 11 better cmd+s ....... binding OWNED; grouping = NAVIGATION `tmux ls -F` format string (no new verb)
line 12 URL grabber ........ FULLY OWNED (`hive urls` + binding)
line 13 auto-archive ....... DEFER → WORKSPACES §8.4 (quest done → archive)
line 14 Syn ................ OUT OF SCOPE
line 15 move to colony ..... DEFER → TAGS_AND_RELATIONSHIPS §11 (`hive move --colony` + picker)
```

### Supersession & citation

- **SUPERSEDES `fork-and-pane.md` §7.5** (Keybindings, Phase D). That section is a
  3-line sketch (`bind-key b/s/f` + "`hive keys install` to append it"). This PRD
  is now the single home for the keybinding install/management layer, the picker
  subcommands, and the full binding set. **Action**: replace §7.5's body with a
  one-line pointer — *"Keybinding layer, install/management model, and picker
  subcommands are specified in `docs/KEYBINDINGS_PRD.md`; this section retains only
  the pane-identity dependency."* Keep §7.5's `ssh-tmux` caveat (the popup runs in
  the remote shell → cross-substrate keybindings deferred); this PRD inherits and
  cites it (§13).
- **CITES `fork-and-pane.md` §7.3** for the `hive here` resolution algorithm and
  the §6.2/§6.3 pane primitives (`agentPaneId` capture, `newPane` / `killPane` /
  `listPanes`, `@hive_pane`). Those mechanics stay in fork-and-pane; this PRD owns
  only `hive here`'s CLI surface and use-cases. The seam: **fork-and-pane owns how
  a pane gets pinned to a bee; this PRD owns how that pin is read from inside tmux
  and wired to keys.**
- **CITES** fork-and-pane §7.1 (`hive fork`), §7.2 (`hive split`), §7.4
  (`hive kill`) — the verbs the bindings dispatch into.

### Dependency ordering

`hive here` (fork-and-pane §7.3 + Phase A/B pane-pinning) is **blocking** for every
`--here` affordance and current-bee rename/url resolution. The pickers and the
`hive keys` group ship independently of pane-pinning (they don't need `--here`
until paired with it). NAVIGATION's grouped-switcher format string / `hive next`
and WORKSPACES' `hive workspace rename` / `hive workspace here` / quest-start land
in parallel — their bindings here **degrade gracefully** (e.g. `M-R` prompts for
the old workspace name if `hive workspace here` is unimplemented), so this PRD is
not hard-blocked on them.

## 11. Command surface

### New verbs owned here

```
hive here [--id] [--json]
hive spawn-picker [--frame | --flow] [--here]
hive urls [<bee>] [--lines <n>] [--open] [--json]
hive rename --here <new-title>            # argv-reshaping wrapper over existing `hive rename`
hive keys print  [--tmux | --wezterm]
hive keys path
hive keys check  [--against-recommended]
hive keys doctor                          # OPTIONAL (Phase 2): runtime popup-probe; static checks live in `check`
```

### Recommended binding set (canonical `docs/honeybee.tmux.conf`)

Collision ledger — **three sources, do NOT redefine** (full discussion §6):

- **tmux layer (mesh conf, already shipped):** `C-a` prefix; `M-s` switcher;
  `M-j` choose-tree; `M-d`/`M-D` splits; `M-t` new-window; `M-w` kill-pane;
  `M-Enter` zoom; `M-1..M-5` select-window; `M-Left/Right/Up/Down` pane-nav. The
  conf does **not** unbind tmux defaults, so `prefix-s` (choose-tree) and
  `prefix-f` (find-window) under `C-a` are still live.
- **WezTerm `cmd→Meta` hive block:** maps `cmd→M-`, `cmd+shift→M-<shift>`,
  `cmd+opt+arrow→M-arrow` onto the same M-keys.
- **WezTerm leftover Zellij ALT→ESC layer** (`~/.wezterm.lua` lines ~61–71):
  sends `M-f`, `M-n`, `M-i`, `M-o`, `M-p` (plus `M-ø`/`M-æ`/ALT-arrows) into tmux.
  **So lowercase `M-f`/`M-n`/`M-i`/`M-o`/`M-p` are NOT free.** This layer is
  **lowercase only** — capital/shifted forms (`M-F`, `M-N`, `M-R`, `M-K`, `M-G`…)
  are unaffected.
- **`prefix+L` (account login):** *documented in
  `docs/PHASE3_MESH_INTEGRATION.md`, not yet in the live conf* — listed here as a
  key to avoid so it lands cleanly when shipped, not as an already-shipped bind.

> **Optional prerequisite.** The dead Zellij ALT lines (`f`/`n`/`i`/`o`/`p`/`ø`/`æ`)
> in `~/.wezterm.lua` MAY be deleted to free that lowercase-Meta space. If the
> operator does that, lowercase `M-f`/`M-n` become available again and the re-derived
> picks below could revert. The recommended set assumes the ALT lines stay.

Re-derived **verified-free** no-prefix key set (avoids the ALT-taken lowercase
`f`/`n`/`i`/`o`/`p`): `b`, `k`, `F`, `x`, `r`, `R`, `u`, `g`, `N` — all unbound in
the live mesh conf and clear of the WezTerm ALT layer. Fork moved off the
ALT-taken `M-f` → **`M-k`**; next moved off the ALT-taken `M-n` → **`M-g`**:

```tmux
# >>> honeybee keybindings (recommended; you own this block) >>>

# Spawn / decompose / fork (verbs: fork-and-pane Phase B/C/D; pickers: KEYBINDINGS_PRD)
bind -n M-b display-popup -E -w 60% -h 50% \
  "hive spawn-picker --frame | fzf --prompt='frame> ' | xargs -r -I{} hive spawn --frame {} --here"   # cmd+b spawn from frame, here
bind -n M-F display-popup -E -w 60% -h 50% \
  "hive spawn-picker --flow  | fzf --prompt='flow> '  | xargs -r -I{} hive quest start --flow {}"      # cmd+shift+f spawn swarm from flow (start → WORKSPACES)
bind -n M-k display-popup -E \
  "hive fork \"$(hive here --id)\" --here"                                                              # cmd+k fork current bee, here (M-f taken by WezTerm ALT layer)
bind -n M-x display-popup -E \
  "hive split --here"                                                                                   # cmd+x decompose / add sub-bee (split → fork-and-pane B)

# Standalone affordances (owned here)
bind -n M-r display-popup -E -w 60% -h 20% \
  "read -p 'rename bee> ' n && [ -n \"$n\" ] && hive rename --here \"$n\""                              # cmd+r rename current bee
bind -n M-R display-popup -E -w 60% -h 20% \
  "read -p 'rename workspace> ' n && [ -n \"$n\" ] && hive workspace rename \"$(hive workspace here)\" \"$n\""  # cmd+shift+r rename workspace (both verbs → WORKSPACES)
bind -n M-u display-popup -E -w 70% -h 60% \
  "hive urls | fzf --prompt='url> ' --no-sort | xargs -r open"                                          # cmd+u list+open URL (xdg-open on Linux)

# Navigation (bindings owned here; engine → NAVIGATION_PRD)
bind -n M-g run-shell "hive next"                                                                       # cmd+g next attention bee (M-n taken by WezTerm ALT layer; NAVIGATION Tier 1)
bind -n M-N run-shell "hive next --prev"                                                                # cmd+shift+n prev attention bee
# M-s switcher is already shipped; to adopt grouped UX, swap its inline `tmux ls -F ...`
# for NAVIGATION's longer `tmux ls -F` format string carrying @hive_colony/@hive_swarm
# facets (binding here, format string there — no new CLI verb).

# <<< honeybee keybindings <<<
```

For operators who prefer to preserve `M-k`/`M-u`/`M-x` for in-pane terminal use,
the snippet also ships a **commented prefix-keyed alternative** for each heavier
verb. The mesh conf does **not** unbind tmux defaults, so under `C-a` the default
`prefix-s` (choose-tree) and `prefix-f` (find-window) are still live — the
alternative therefore **avoids `s` and `f`** and uses `prefix b` spawn, `prefix e`
split, `prefix k` fork, `prefix F` frame, `prefix G` flow, `prefix u` urls,
`prefix R` workspace-rename, `prefix m` move. (An operator who would rather reuse
`s`/`f` must explicitly `unbind-key -T prefix s` / `unbind-key -T prefix f` first;
the snippet does not do this for him.) These eight letters are verified free in
the `C-a` prefix table against the live mesh conf. His choice, since he owns the
block.

### WezTerm additions (`hive keys print --wezterm`)

Add to the existing `hive_keys` table in `~/.wezterm.lua` under the `-- >>> hive
>>>` block (the emitter only **appends** to the existing 12 hops; it never rewrites
the non-binding config riding in the same block):

```lua
{ key = 'b', mods = 'SUPER',       action = meta('b') },   -- cmd+b  spawn-from-frame
{ key = 'k', mods = 'SUPER',       action = meta('k') },   -- cmd+k  fork (M-f avoided: ALT layer)
{ key = 'f', mods = 'SUPER|SHIFT', action = meta('F') },   -- cmd+shift+f spawn-from-flow
{ key = 'x', mods = 'SUPER',       action = meta('x') },   -- cmd+x  split/decompose
{ key = 'r', mods = 'SUPER',       action = meta('r') },   -- cmd+r  rename bee
{ key = 'r', mods = 'SUPER|SHIFT', action = meta('R') },   -- cmd+shift+r rename workspace
{ key = 'u', mods = 'SUPER',       action = meta('u') },   -- cmd+u  urls
{ key = 'g', mods = 'SUPER',       action = meta('g') },   -- cmd+g  next  (M-n avoided: ALT layer)
{ key = 'n', mods = 'SUPER|SHIFT', action = meta('N') },   -- cmd+shift+n prev
```

**How these override native CMD bindings.** WezTerm resolves `config.keys` as
**last-match-wins by table order**: because the hive block is *appended* after the
defaults, each appended `cmd+*` entry overrides any earlier native CMD assignment
for the same key purely by position — no `DisableDefaultAssignment` is involved.
In `~/.wezterm.lua`, `DisableDefaultAssignment` is used for exactly one key
(`cmd+=`); `cmd+d`/`cmd+w`/`cmd+Enter` are overridden by their later-appended
`config.keys` entries, not by disabling defaults. (The earlier "DisableDefault\
Assignment precedent" framing was wrong and has been removed.) Note that **native
`cmd+w` (CloseCurrentPane) still coexists** with the hive `cmd+w→M-w` mapping
where it is not shadowed — order, not disablement, decides which wins. The chosen
keys avoid native Find: `cmd+f` is **not** remapped (fork now rides `cmd+k`), so an
operator who relies on WezTerm Find keeps it; the prefix variant remains available
either way (§13).

## 12. Reuse map

Everything load-bearing already exists in the repo. File:line anchors:

| Concept | File:line | Note |
|---|---|---|
| Shipped `M-s` switcher (popup-picker pattern) | `/Users/trmd/mesh/profiles/tmux/.tmux.conf:37-38` | `tmux ls -F '#{@hive_*}' \| fzf \| cut -d' ' -f2 \| xargs tmux switch-client -t` — the proven pattern |
| Prefix + WezTerm cmd→Meta block (marked-block precedent) | `/Users/trmd/.wezterm.lua:100-128` | `-- >>> hive >>>` … `-- <<< hive <<<`, `meta(k)=SendString('\x1b'..k)` |
| WezTerm leftover Zellij ALT→ESC layer (collision source) | `/Users/trmd/.wezterm.lua:61-71` | `ALT+f/n/i/o/p/ø/æ`+arrows → `M-*` into tmux; takes lowercase `M-f/M-n/M-i/M-o/M-p`; list-keys-invisible (§6) |
| WezTerm CMD override mechanism | `/Users/trmd/.wezterm.lua` | `config.keys` last-match-wins by table order; `DisableDefaultAssignment` only on `cmd+=`; native `cmd+w` coexists with hive `cmd+w→M-w` |
| `@hive_*` options stamped at spawn | `src/hiveState.ts:71-88` | `writeSpawnOptions()` → `@hive_id/colony/swarm/title/pane/state` |
| Candidate loaders (parallel) | `src/completion.ts:411-421` | `listFrames/listFlows/listSwarms/listColonies/listSessions` in the `getCompletions` `Promise.all` |
| `BEES` caste list | `src/completion.ts:49-52` | fallback candidates for an optional split-picker |
| Frame list pattern | `src/cli.ts:2051-2081` | `frameList()` — the shape `spawn-picker --frame` mirrors |
| Swarm/colony list patterns | `src/cli.ts:2264-2293`, `1936-1960` | for delegated swarm/colony pickers |
| `hive spawn --frame --here` + link | `src/cli.ts:272-314`, `src/view.ts:145-180` | `cmdSpawn` / `maybeLinkHere` / `linkHere` — picker feeds this unchanged |
| `hive rename` (sets `@hive_title`, not session name) | `cmdRename`, `src/cli.ts:617` | reads `args[0]`=selector, `args.slice(1)`=title (`:618,621`); `--auto`/`--clear` supported; `--here` reshapes argv to inject the selector |
| Pane capture (supports `paneId`, large history) | `capture(target, lines, paneId?)`, `src/substrates/local-tmux.ts:93` | `hive urls` needs no substrate change |
| `$TMUX` / env checks | `src/cli.ts:294, 1749, 1764` | precedent for reading tmux env in commands |
| Selector resolution | `src/selectors.ts:85-100` | `resolveSelector` — handles bee/colony/swarm targets |
| `hive here` algorithm (cited) | `docs/fork-and-pane.md:272-280` | §7.3 — reverse lookup spec |
| Keybindings sketch (superseded) | `docs/fork-and-pane.md:289-302` | §7.5 |
| Faceted ⌘s (format string, no verb) / `hive next` (delegated) | `docs/NAVIGATION_PRD.md:122-132` (Tier 0), `161-193` (§9), `194-206` (§10 `tmux ls -f/-F`) | switcher = pure `tmux ls -f/-F`; grouping is a longer `-F` format string, not a `switcher-format` verb |
| Workspace rename / quest archive (delegated) | `docs/WORKSPACES_AND_QUESTS_PRD.md:280-301` (§9), `270-278` (§8.4) | rename + quest-done→archive |
| Nesting-safe attach helper | `docs/NAVIGATION_PRD.md:167` (§9), `211-213` (§11) | Workstream-1 helper for any switch; quoted at §9 ~line 167 |

## 13. Safety / operating defaults

- **No config mutation by default.** hive never writes the operator's tmux.conf /
  mesh profile / wezterm.lua. The only durable artifact is the documented
  `docs/honeybee.tmux.conf`; the operator pastes or `source-file`s it. This makes
  "reversible/idempotent" trivially true — there is nothing to clobber.
- **Pickers are read-only and side-effect-free.** They print candidates; the
  action lives in the binding. A picker can never spawn, switch, or kill.
- **`@hive_*` writes stay best-effort** (consistent with the existing
  architecture): a missing session never breaks a command, and a failed
  `@hive_title` write on rename never fails the rename's store update.
- **Nesting safety.** Any binding that switches clients (`hive next`,
  waiting-switcher) routes through the Workstream-1 nesting-safe helper, never a
  raw `attach-session` inside an attached client. Spawn/fork/url pickers are
  nesting-safe by construction.
- **Graceful degradation.** A binding whose backing verb is not yet shipped
  surfaces a no-op error inside its own popup (which closes) — never a dead key.
  `hive keys check` reports live vs. pending bindings.
- **`hive urls` is bounded.** It reads live scrollback only (capped by tmux
  `history-limit`, ~100k); URLs scrolled out of history are not recovered (§16).
- **`ssh-tmux` deferral.** Under `ssh-tmux`, `display-popup -E` runs in the
  **remote** shell. Two distinct failure modes:
  - `hive here` / `--here` paths resolve against the *remote* fleet (the remote
    `$TMUX_PANE`), not local. Cross-substrate keybindings are deferred (inherited
    from fork-and-pane §7.5).
  - The **non-`--here` pickers and explicit-selector verbs** — `hive spawn-picker`
    (no `--here`) and `hive urls <explicit-bee>` — read the **LOCAL store** by
    design. Run from a popup inside the remote shell they list/operate on the
    *local* fleet's names while sitting in the remote context, so they are simply
    **wrong/unusable** under `ssh-tmux`. These should **detect the `ssh-tmux`
    substrate and hard-error** (non-zero, `dim` message), not silently target the
    remote fleet or silently operate on a fleet the operator can't see.
  `hive keys check` warns when the substrate is `ssh-tmux` (static substrate
  check, §7.3).
- **Collision discipline.** New bindings draw only from verified-free keys (§11
  ledger). `hive keys check` flags live collisions against the shipped **tmux**
  set only — it cannot see the WezTerm ALT/cmd layer (it reads `tmux list-keys`),
  so the terminal layer must be eyeballed against `~/.wezterm.lua` (§6).
- **Quoting kept out of bindings where it bites.** Rename uses a `hive rename
  --here` wrapper (not an inline `$(hive here --id)` capture) so the fragile
  substitution lives in testable TypeScript, not a doc snippet.

## 14. Phasing

**Phase 0 — `hive here` (blocking, depends on fork-and-pane Phase A/B).**
Implement / pin the CLI surface (`--id` / `--json` / `--workspace`). Acceptance:
`hive here --id` resolves correctly in pinned and legacy panes. Unblocks all
`--here` affordances.

**Phase 1 — pickers + `hive keys` group + standalone affordances.** Ship the
single `hive spawn-picker --frame|--flow` verb, `hive urls`, `hive rename --here`,
the `hive keys print | path | check` group (with `check` carrying the static
PATH / substrate / `fzf` / opener probes), and `docs/honeybee.tmux.conf`. These
are independent of each other and of pane-pinning (except the `--here` paths,
gated on Phase 0). Highest leverage, lowest cost.

**Phase 2 — navigation / workspace bindings + optional `hive keys doctor`.** Add
`M-g`/`M-N` (→ NAVIGATION `hive next`), the waiting-switcher chord (→ NAVIGATION's
`tmux ls -f/-F` format string, no new verb), and `M-R` workspace rename (→
WORKSPACES `hive workspace rename` + `hive workspace here`) to the same snippet as
those verbs land. **Optional in this phase:** `hive keys doctor` — the runtime
`display-popup` probe of `$TMUX_PANE` inheritance, plus the future
`~/.wezterm.lua` ALT/cmd-layer collision parse (§7.3). Bindings degrade gracefully
until their verbs land.

**Phase 3 — delegated mutations.** Add the move-to-colony binding once
TAGS_AND_RELATIONSHIPS ships `hive move`. Parent-association filtering surfaces
through NAVIGATION facets; no new key reserved here.

**Future (additive, not committed) — managed installer.** If wanted, wrap
`hive keys print` with the marked-block `hive keys install` (§7.4), INCLUDE-mode
default for the mesh-managed case. Strictly additive; does not change the
print/verify surface.

## 15. Acceptance criteria

- `hive here --id` inside any bee pane prints that bee's id; inside a sub-bee pane
  it prints the sub-bee, not a sibling; inside a legacy unpinned pane it resolves
  via the session fallback.
- `cmd+b` (`M-b`) opens a popup listing frames; selecting one spawns a bee from
  that frame linked into the current session, without detaching.
- `cmd+k` (`M-k`) inside a bee forks it into a popup-launched, here-linked bee
  without detaching (inherits fork-and-pane D1). (`M-k`, not `M-f` — `M-f` is taken
  by the WezTerm ALT layer, §6.)
- `cmd+r` (`M-r`) → type a name → the bee's `@hive_title` updates in the status bar
  and the `M-s` switcher line without re-attach.
- `cmd+u` (`M-u`) lists the deduped URLs printed in the current bee's pane; Enter
  opens the chosen one in the default browser; an empty pane closes the popup with
  a `dim` "no URLs" line.
- `hive keys print` emits a block byte-identical to `docs/honeybee.tmux.conf`;
  `hive keys check` reports which recommended binds are live, flags any **tmux-layer**
  collision, runs the static PATH/`fzf`/opener/substrate checks, and warns under
  `ssh-tmux`. The optional `hive keys doctor` (Phase 2) confirms `$TMUX_PANE`
  inheritance via a runtime probe popup.
- Every new binding is verified collision-free **against the tmux layer** of the
  live mesh tmux.conf (`tmux list-keys`) by `hive keys check`; the WezTerm
  ALT/cmd layer (`~/.wezterm.lua`) is verified by eye (or a future `doctor`
  extension), since `list-keys` cannot see it (§6).
- The recommended no-prefix set (`M-b`/`M-k`/`M-F`/`M-x`/`M-r`/`M-R`/`M-u`/`M-g`/`M-N`)
  avoids the WezTerm-ALT-taken lowercase `M-f`/`M-n`/`M-i`/`M-o`/`M-p`.
- A binding whose backing verb is absent (e.g. `hive move` pre-TAGS) fails inside
  its own popup and never breaks the keymap.

## 16. Open questions

1. **`hive here --workspace` vs. `hive workspace here`.** *RESOLVED (this
   revision): `hive here` is bee-only; the owning-workspace lookup the ⌘⇧R binding
   needs is a separate WORKSPACES-owned `hive workspace here` (the `--workspace`
   flag is removed from `hive here`, §9.1, §11). This avoids the cross-PRD split
   that risked drift. Remaining coordination: WORKSPACES must actually ship
   `hive workspace here`; until then the `M-R` binding degrades gracefully (§10).*
2. **Path stability for `source-file`.** `hive keys path` resolving relative to the
   hive install is brittle across reinstall/relocation and across machines.
   *Options: (a) `hive keys print >> conf` (paste, goes stale silently), (b)
   `source-file $(hive keys path)` (brittle path), (c) a managed installer (§7.4).
   `hive keys check` audits presence either way; pick a primary recommendation.*
3. **`hive urls` durability.** Scrollback-only loses scrolled-out URLs. The
   wishlist framed this beside archiving/indexing (WORKSPACES §8.4). *Decide
   whether `hive urls` later reads from an archive, and whether that reshapes the
   thin verb or extends it.*
4. **Default key namespace.** Ship the aggressive no-prefix set
   (`M-k`/`M-u`/`M-x`/`M-g`, capturing some in-pane Meta combos) as default, or the
   prefix-keyed variant? Note the set already steers around the WezTerm ALT layer
   (fork on `M-k` not `M-f`, next on `M-g` not `M-n`) and leaves native WezTerm
   Find (`cmd+f`) untouched (§6, §11). *Recommendation: ship no-prefix as default
   with the commented prefix alternative; the operator owns the block.*
5. **Move-to-colony picker ownership.** The colony picker is trivially ownable
   here, but the mutation is TAGS'. *Recommendation: keep the whole feature in TAGS
   to keep relationship mutations in one place (current call); revisit if the
   picker proves reusable.*
6. **Managed installer adoption.** Does the mesh-managed case eventually want the
   §7.4 INCLUDE-mode installer to survive re-renders, or is `source-file` from a
   template enough? *Decide with the mesh setup owner.*

## 17. Out of scope

- **Deep Syn integration** (wishlist line 14) — Syn is a separate project. No
  verbs, no bindings, no reserved keys here. A future `hive keys` extension point
  is noted but unspecified.
- **The faceted ⌘s engine, `hive next`, saved views** — owned by NAVIGATION_PRD;
  this PRD owns only the bindings that invoke them.
- **Workspace rename semantics, quest start, archiving/indexing** — owned by
  WORKSPACES_AND_QUESTS_PRD.
- **Parent-association filtering, tags, move-to-colony mutation** — owned by
  TAGS_AND_RELATIONSHIPS_PRD.
- **A managed `hive keys install` config rewriter** — left as a strictly-additive
  future phase (§14); not part of the shipped surface.
- **Cross-substrate (`ssh-tmux`) keybindings** — deferred (§13).
- **Pane-id bee identity (`embed`/`eject`)** — unchanged future work, per
  NAVIGATION_PRD §14 and fork-and-pane.
