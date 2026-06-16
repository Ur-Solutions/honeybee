# honeybee Workspaces & Quests PRD

> Expands the vision in `docs/workspaces-and-quests.md` into an implementable
> spec, to the bar of `LOOPS_PRD.md` / `NAVIGATION_PRD.md` / `fork-and-pane.md`.

## 1. Summary

This PRD introduces the two operator-facing abstractions that turn `hive` from
an agent-orchestration CLI into a daily **agent workspace** for one human:

1. **Workspaces** — a *persisted*, first-class tmux UI session that hosts a
   mix of bees (linked in) and ordinary panes (shells at a file root). Unlike a
   `hive view` cockpit (ephemeral, no record), a workspace has a store record,
   a **file root**, an optional **colony** association, survives closing the
   terminal natively (detached tmux), and can be **reconstructed after a
   reboot** from a saved layout snapshot. Every colony auto-gets a workspace;
   stand-alone workspaces are allowed.

2. **Quests** — a *tracked task* with a beginning and a completion. A quest
   lives in a colony, owns a workspace while active, and typically spawns one or
   more swarms/flows to do the work. A quest may be linked to a Linear issue.
   When the work is resolved, `hive quest done` archives the quest: it seals or
   kills the bees, snapshots and tears down the workspace, and files the
   artifacts for later indexation.

The two are intertwined — **a quest gets a workspace** — so they ship together.
Both build directly on primitives that already exist: the `view.ts` link-window
machinery (workspaces are its persisted evolution), the colony/swarm/frame/flow
record types, seals, and the pane-identity work just landed (a workspace hosts
pinned bees).

## 2. Motivation

- `hive` is already a strong agent-to-agent substrate; its weakest layer is
  *operator* ergonomics. The recurring need is "somewhere durable to organize
  and return to the work," which the current ephemeral `view` and metadata-only
  `colony` do not provide.
- Today there is **no persistence of tmux layout** and **no restore after a
  reboot** (verified: `reconcile.ts` is account/transcript reconciliation, not
  tmux). A daily driver who lives in tmux loses their whole arrangement on
  restart. Workspaces close that gap and provide an alternative to tools like
  `cmux` / `tmux-resurrect`, integrated with the hive model.
- Work is naturally *task-shaped* ("review PR #1255", "migrate the auth flow"),
  but hive has no object for a task with a lifecycle. Swarms/flows are the
  *how*; a quest is the *what and why*, with a clean begin→archive arc.
- Colonies are pure metadata with no home on disk and no UI; binding a colony to
  a file root + workspace makes "open my project" a single command.

## 3. Goals

- A **persisted, named, file-rooted** tmux workspace that is a first-class hive
  record, hosts bees + shells, and survives both terminal-close (natively) and
  reboot (via snapshot restore).
- **One command** to open a colony's workspace (or create an ad-hoc one), and to
  restore everything after a reboot.
- A **quest** object with a clean lifecycle: create (optionally from a Linear
  issue) → work (swarms/flows in its workspace) → `done` (seal/kill, archive,
  optionally close the Linear issue).
- Reuse, not reinvent: workspaces extend `view`'s link machinery; quests compose
  colonies + swarms + flows + seals.
- Everything is **inspectable, selector-addressable**, and follows the existing
  record/ledger conventions.
- Degrade gracefully: workspaces are useful without quests; quests without
  Linear; restore without exact pixel geometry.

## 4. Non-goals

- A general tmux session manager for non-hive sessions (we manage `ws-*` and the
  bees in them, not arbitrary user sessions).
- Pixel-perfect layout restoration in v1 (same windows/panes/roles, not exact
  pane geometry — that is a later phase).
- Resurrecting *live agent state* across a reboot (processes die; we re-spawn or
  resume from `providerSessionId`, we do not freeze/thaw a running agent).
- A full project-management surface inside hive (quests link to Linear; they do
  not replace it).
- Multi-user / shared workspaces.

## 5. Primary Users

### Tormod / humans (the operator)
Runs a fleet from inside tmux as the daily driver. Wants "open the project,"
"track this task," and "pick up exactly where I left off after a reboot."

### Orchestration bees
Create quests programmatically (a planning bee spins up a quest per Linear issue,
seeds a swarm, walks away) and read quest status without tailing panes.

## 6. Core Concepts

### Workspace
A persisted tmux session named `ws-<name>` with a **store record**
(`WorkspaceRecord`), a **file root** (a local directory), an optional **colony**,
and a set of **members** (windows): bees (linked via `link-window`) and ordinary
panes (shells/commands at the file root). It is `detach-on-destroy off` and never
auto-destroyed, so it persists across terminal close. A **layout snapshot**
captures enough to reconstruct it after a reboot.

### Member
One window in a workspace. Either:
- **bee** — a linked bee window (the bee's home session is elsewhere; the
  workspace holds a link, exactly like `view`), or
- **pane** — an ordinary shell/command pane rooted at the workspace's file root.

### File root
The directory a workspace is "about." Colony workspaces prompt for it on first
open; ad-hoc workspaces take `--root` (default: cwd). New panes and quest bees
default their `cwd` to it.

### Layout snapshot
A serialized description of the workspace's windows and their roles (bee id /
shell command), plus optional tmux `window_layout` geometry strings, written to
disk so `restore` can rebuild the session after the tmux server is gone.

### Quest
A tracked task: `QuestRecord` with `status` (open → active → done → archived),
a `colony`, a `workspace`, the `swarmIds` spun up for it, and an optional
`linearIssueId`. The quest *owns* its workspace while active.

### Archive
On quest completion, the durable record of what happened: the bees' seals, the
workspace's final snapshot, and the quest metadata, filed under
`~/.hive/quests/<id>/` and excluded from live listings — available for later
indexation/search.

## 7. Workspaces

### 7.1 Data model (`src/workspace.ts`, new — mirrors `swarm.ts`/`colony.ts`)

```ts
export type WorkspaceMember =
  | { kind: "bee"; beeId: string }                       // linked bee window
  | { kind: "pane"; name: string; command?: string };    // shell/command at root

export type WorkspaceRecord = {
  name: string;            // WS_NAME_RE: /^[A-Za-z0-9][A-Za-z0-9_-]*$/
  rootDir: string;         // the file root (absolute)
  colony?: string;         // colony this workspace belongs to (auto-workspaces)
  questId?: string;        // set while a quest owns this workspace
  members: WorkspaceMember[];
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
  archivedAt?: string;
  description?: string;
  // Geometry snapshot (Phase 2): per-window tmux window_layout strings.
  layout?: Array<{ windowName: string; layout: string }>;
};
```

- Stored at `storeRoot()/workspaces/<name>.json`; lock
  `workspaces/.workspaces.lock`; CRUD + ledger (`workspace.create|update|
  rename|archive`) following the `colony.ts`/`swarm.ts` pattern exactly.
- The tmux session name is `ws-<name>` (`WORKSPACE_PREFIX = "ws-"`), kept
  distinct from `view-*` so neither leaks into the other's listing/selectors
  (same exclusion discipline `view.ts` already establishes).
- `SessionRecord` gains `workspaceId?: string` (added to
  `OPTIONAL_STRING_SESSION_KEYS`) so a bee knows its home workspace.
- `ColonyRecord` gains `rootDir?: string` and `workspace?: string` (the
  auto-created workspace's name) — additive, allow-listed.

### 7.2 Lifecycle

- **Auto-creation:** creating a colony (`createColony`) also provisions a
  `WorkspaceRecord` named after the colony; its `rootDir` is resolved lazily —
  prompted on first `hive workspace open <colony>` and persisted.
- **Open:** `hive workspace open <name>` ensures the `ws-<name>` session exists
  (create from the record's members if missing — reuse `buildView`'s
  link/dedupe core, generalized to also create shell panes), then enters it via
  the Workstream-1 nesting-safe attach helper (`switch-client` inside tmux).
- **Membership:** adding a bee links its window (`linkHere`-style, but persisted
  into `members`); `hive workspace add-pane` opens a shell at `rootDir`. Removing
  a member unlinks (never `-k`).
- **Persistence across terminal close:** native — the session is detached and
  `detach-on-destroy off`. Reopening is just attach.
- **Snapshot:** the daemon (or an on-demand `hive workspace snapshot`) refreshes
  `members` + `layout` from the live session so the record tracks reality.
- **Close vs archive:** `hive workspace close` detaches/tears down the tmux
  session (unlink bees safely, like `closeView`) but keeps the record;
  `hive workspace archive` marks it archived and files its final snapshot.

### 7.3 Restore (the reboot story)

After a reboot the tmux server and every bee process are gone, but the records
persist. `hive workspace restore <name>` (or `hive restore --all`) rebuilds:

1. Create `ws-<name>`, set `rootDir`, `detach-on-destroy off`.
2. For each **pane** member: open a window/pane at `rootDir` running its
   `command` (or a shell).
3. For each **bee** member: the bee's process is dead. Default: **re-spawn**
   it fresh into the workspace (reuse `spawnBee`, window linked in);
   `--resume` continues it from `providerSessionId` via the native resume args
   (`src/swap.ts:113-118`, same mechanism `fork` uses). A bee with neither is
   restored as a dead placeholder the user can re-spawn.
4. Phase 2: apply saved `window_layout` geometry via `select-layout`.

This is the deterministic-structure interpretation of "instantly restored":
windows, roles, and file root come back exactly; live agent state is re-spawned
or resumed, not frozen.

### 7.4 Relationship to `view`

`view` stays as the ephemeral, zero-record cockpit (good for a throwaway glance
at a swarm). A workspace is its persisted sibling. The shared link-window core
(`buildView` link/dedupe, `closeView` safe-unlink, grouped sessions for
independent focus) is factored into a reusable module both consume.

## 8. Quests

### 8.1 Data model (`src/quest.ts`, new)

```ts
export type QuestStatus = "open" | "active" | "done" | "archived";

export type QuestRecord = {
  id: string;              // generateQuestId() — "<prefix>-<hex>", like swarm ids
  title: string;
  colony: string;          // a quest always lives in a colony (auto-create if absent)
  workspace: string;       // the ws-<name> it owns
  status: QuestStatus;
  swarmIds: string[];      // swarms spun up for this quest
  linearIssueId?: string;  // optional external link (e.g. "ENG-1234")
  createdAt: string;
  activatedAt?: string;
  completedAt?: string;
  archivedAt?: string;
  description?: string;
};
```

- Stored at `storeRoot()/quests/<id>/quest.json`; the directory also holds the
  archive (seals copy, final workspace snapshot) on completion. Ledger:
  `quest.create|activate|done|archive`.
- `SessionRecord` gains `questId?: string` (allow-listed) so every bee a quest
  spawns is attributable to it.

### 8.2 Lifecycle

- **Create:** `hive quest create "<title>" [--colony <c>] [--root <dir>]
  [--linear <issue>]`. Creates the quest, ensures a colony (auto-create from the
  title slug if none), and provisions the quest's workspace (file root from
  `--root`/colony/cwd). If `--linear`, fetch the issue (see §8.3) and seed the
  workspace/brief from it.
- **Start work:** `hive quest start <id> (--frame <f> | --flow <f>) [--brief
  "..."]`. Spawns a swarm from a frame or runs a flow, with every bee tagged
  `questId`, `colony`, and its window linked into the quest's workspace
  (reuse `spawnFromFrame` / flow run + the workspace link path). From a Linear
  issue, the default brief is "read <issue> and begin."
- **Inspect:** `hive quest list [--colony c]`, `hive quest inspect <id>` —
  status, member swarms, bee states (rolled up), workspace, Linear link.
- **Done:** `hive quest done <id> [--keep-bees] [--close-linear]`. Seals are
  collected; bees are sealed-or-killed transactionally (`src/kill.ts`); the
  workspace is snapshotted then closed; seals + snapshot + metadata are filed
  under `~/.hive/quests/<id>/`; status → `done`/`archived`. With
  `--close-linear`, mark the Linear issue done.

### 8.3 Linear integration (optional, pluggable)

No external task integration exists in hive today (verified). Linear is an
**optional adapter**, not a hard dependency:

- **Read** (`--linear <issue>` on create): fetch title/description to seed the
  quest title and the swarm's first brief.
- **Write** (`--close-linear` on done): transition the issue to Done.
- **Transport:** a thin `LinearAdapter` interface with one implementation. The
  operator already has the **Linear MCP** connected, so the default adapter
  drives it through MCP; an API-token implementation is the fallback. hive core
  never imports Linear directly — the adapter is injected, and absent config the
  quest works fully without Linear.

### 8.4 Completion & archive

`hive quest done` is the one place hive **archives** rather than deletes session
work (today `clean`/`kill` delete records). Archive = copy each member bee's
seals + the final workspace snapshot + the quest record into
`~/.hive/quests/<id>/`, mark sessions `archived` (a new status value, excluded
from default `list`/selectors/clean — they are not dead, they are filed), and
release the live tmux session. This satisfies the hotkey-doc wish for
"automatic archiving and storing of bee sessions for later indexation."

## 9. Command surface

```
# Workspaces
hive workspace open <name|colony> [--root <dir>] [--new-client] [--print]
hive workspace list [--colony <c>] [--archived]
hive workspace add-pane <name> [--cmd "..."] [--name <label>]
hive workspace add <name> <bee-selector>          # link existing bee(s) in
hive workspace snapshot <name>                     # refresh members/layout
hive workspace rename <old> <new>
hive workspace close <name>                        # tear down session, keep record
hive workspace archive <name>
hive workspace restore <name> [--resume] | hive restore --all   # post-reboot

# Quests
hive quest create "<title>" [--colony <c>] [--root <dir>] [--linear <issue>]
hive quest start  <id> (--frame <f> | --flow <f>) [--brief "..."]
hive quest list   [--colony <c>] [--status <s>]
hive quest inspect <id>
hive quest done   <id> [--keep-bees] [--close-linear]
hive quest archive <id>
```

### Selectors & in-tmux keys (folds in the hotkey wishlist)
- Extend the selector grammar with `ws:<name>` and `quest:<id>` (and `@quest-id`)
  so `send`/`view`/`kill` accept them; resolution mirrors `colony:`/`@swarm`
  (`src/selectors.ts`).
- The faceted ⌘s switcher (NAVIGATION_PRD Tier 0) gains workspace/quest rows,
  grouped colony → quest → swarm → bee ("better selector UX" hotkey item).
- Keybindings (compose with fork-and-pane Phase D `display-popup` pickers):
  `rename current workspace` (⌘⇧R), `move bee to workspace/colony`,
  `spawn swarm from frame/flow` picker → `hive quest start`.

## 10. Data model changes (summary)

| Where | Change |
|---|---|
| `src/workspace.ts` (new) | `WorkspaceRecord`, `WorkspaceMember`, CRUD, `ws-` prefix |
| `src/quest.ts` (new) | `QuestRecord`, `QuestStatus`, CRUD, `generateQuestId` |
| `src/colony.ts` | `+ rootDir?`, `+ workspace?` (allow-listed) |
| `src/store.ts` | `SessionRecord += workspaceId?, questId?`; `status += "archived"`; both new string keys appended to `OPTIONAL_STRING_SESSION_KEYS` |
| `src/selectors.ts` | `Selector += { kind: "workspace" } \| { kind: "quest" }` |
| `src/state.ts` | `deriveState` treats `archived` as terminal-but-not-dead |

Every new **string** field must be added to its record's allow-list (the
`OPTIONAL_STRING_SESSION_KEYS` lesson from store.ts:248) or it is silently
dropped on load.

## 11. Persistence & restore mechanics

- **Snapshot capture:** `tmux list-windows -t =ws-<name>: -F
  '#{window_name}\t#{window_layout}'` for geometry, plus per-pane
  `#{pane_current_path}` / `#{pane_current_command}` for shell members, plus the
  `@hive_id` of any linked bee window (already stamped — pane-identity work) to
  recover bee membership without guessing.
- **Restore:** rebuild session → recreate pane members at `rootDir` → re-spawn
  /resume bee members → (Phase 2) `select-layout <window_layout>`.
- **Reconcile on boot:** a `hive restore --all` sweep (and an optional login
  hook the operator installs) rebuilds every non-archived workspace. This is the
  tmux-layout analogue the current `reconcile.ts` deliberately does not do.

## 12. Reuse map (implementation anchors)

- View link machinery to generalize: `buildView`/`linkHere`/`closeView`/
  `createGroupedView` (`src/view.ts:91-234`).
- Record/CRUD/ledger pattern to mirror: `src/colony.ts:21-110`,
  `src/swarm.ts:31-83`, `src/frame.ts:28-131`.
- Spawn into a workspace: `spawnBee` (`src/cli.ts`), `spawnFromFrame`
  (`src/cli.ts:508-546`), pane pinning via `agentPaneId` (just shipped).
- Quest swarms/flows: `createSwarm` (`src/swarm.ts:56`), flow run + `FlowHive`
  facade (`src/flow/run.ts:60`, `src/flow/index.ts:67-86`).
- Native resume for restore/`--resume`: `resumeArgs` (`src/swap.ts:112-118`).
- Seal collection on done: `listSeals`/`loadLatestSeal` (`src/seal.ts:119-148`).
- Transactional kill on done: `src/kill.ts`.
- Selectors: `src/selectors.ts:6-100`. Nesting-safe enter: `src/attach.ts`.

## 13. Safety / operating defaults

- **Workspaces never kill bees:** member removal and `close` use the `view`
  safe-unlink discipline (no `-k`, abort on a bee's last link).
- **Archive ≠ delete:** quest `done` archives (records preserved under
  `~/.hive/quests/<id>/`); only explicit `kill` deletes. `clean` must skip
  `archived` sessions.
- **Restore is idempotent:** restoring an already-live workspace is a no-op /
  re-attach; restore never double-spawns a bee that is already alive.
- **Linear is optional and side-effect-gated:** no Linear writes without
  `--close-linear`; absent the adapter, quests work fully offline.
- **File-root prompts, never guesses destructively:** a colony workspace asks
  for its root once and persists it; nothing is created outside `rootDir`.

## 14. Phasing

- **Phase 1 — Workspaces as first-class persisted sessions.** `WorkspaceRecord`,
  `ws-` sessions, open/list/add/add-pane/close/rename, colony auto-workspace +
  `rootDir`, selector `ws:`. Reuses the view core. (No restore yet — terminal-
  close persistence is native.)
- **Phase 2 — Snapshot & reboot restore.** Layout capture, `hive workspace
  restore` / `hive restore --all`, bee re-spawn/`--resume`, geometry.
- **Phase 3 — Quests.** `QuestRecord`, create/start/list/inspect/done, swarm/flow
  integration, completion archive, `quest:` selectors.
- **Phase 4 — Linear adapter + in-tmux keys.** Optional Linear read/write via the
  connected MCP, `display-popup` pickers (with fork-and-pane Phase D), ⌘⇧R etc.

## 15. Acceptance criteria

- **W1** `hive workspace open fe` creates `ws-fe` at the prompted root, links the
  colony's bees, and enters it nesting-safe; closing the terminal and `hive
  workspace open fe` returns to it intact.
- **W2** `hive workspace add-pane fe --cmd "lazygit"` adds a pane at the root;
  `snapshot` records it.
- **W3** After `tmux kill-server` (simulated reboot), `hive workspace restore fe`
  rebuilds the windows + shell panes at the root and re-spawns the bee members;
  `--resume` continues a claude bee from its `providerSessionId`.
- **W4** A workspace never appears in bee `list`/selectors; closing one leaves
  every bee alive (the `view` invariant).
- **Q1** `hive quest create "review #1255" --colony reviews` makes a quest + its
  workspace; `hive quest start <id> --frame review` spawns the swarm into it,
  every bee tagged `questId`.
- **Q2** `hive quest done <id>` seals/kills the bees, files seals + snapshot
  under `~/.hive/quests/<id>/`, marks sessions `archived` (gone from `list`,
  skipped by `clean`), and closes the workspace.
- **Q3** `hive quest create --linear ENG-1234` seeds the title/brief from the
  issue; `hive quest done --close-linear` transitions it to Done — and both are
  no-ops with a clear message when no Linear adapter is configured.

## 16. Open questions / decisions needed

1. **Reboot bee restore default:** ✅ DECIDED — re-spawn fresh by default;
   `--resume` from `providerSessionId` opt-in (same-account concurrency hazard
   applies, per fork-and-pane §7.1). A bee with neither restores as a dead
   placeholder.
2. **Exact geometry in v1?** *Recommend: same windows/roles in Phase 1; capture
   `window_layout` but only apply it in Phase 2.*
3. **File root home:** on the workspace only, or also `ColonyRecord.rootDir`?
   *Recommend: both — colony carries the canonical root, its auto-workspace
   inherits it.*
4. **Archived sessions storage:** a `status:"archived"` flag in place vs moving
   records to `~/.hive/archive/`. *Recommend: in-place flag + a `quests/<id>/`
   copy of seals/snapshot; keep the live store as the index, exclude archived
   from defaults.*
5. **Quest ⇒ colony required?** *Recommend: yes; auto-create a colony from the
   title slug when `--colony` is omitted.*
6. **Linear transport:** ✅ DECIDED — an adapter interface with an **MCP-backed
   default** (the connected Linear MCP) and an API-token fallback; neither in
   core, both side-effect-gated.
7. **Tags/relationships:** ✅ DECIDED — tags & relationships become a
   **first-class concept** with their own spec (`TAGS_AND_RELATIONSHIPS_PRD.md`).
   This PRD's `questId`/`workspaceId`/`colony` membership aligns onto that model
   rather than adding ad-hoc fields.

## 17. Out of scope (future work)

- Managing arbitrary non-hive tmux sessions.
- Pixel-perfect multi-pane geometry beyond `window_layout` strings.
- Freezing/thawing live agent process state across reboot.
- Shared/multi-user workspaces and quests.
- A native task tracker (Linear remains the source of truth for issues).
