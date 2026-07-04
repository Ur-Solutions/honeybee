# Checkout Pools PRD

> Status: draft (2026-07-04). Cross-cutting feature spanning the `pro` CLI and hive,
> with Apiary as a downstream consumer. Native successor to the Apiary-owned pool
> design in `apiary/docs/architecture.md` §7.5 and the "PATH 6 — Round-robin pool"
> compose flow in `apiary/docs/design-brief.md` §11.3.

## 1. Summary

A **checkout pool** is a named set of pre-cloned full checkouts of a project repo
(`pro co` clones), sized elastically, that bees claim and release. Spawning an
agent into a pool claims the next free checkout (round-robin); finishing releases
it; when every member is taken, the pool **auto-extends** by cloning a new member.
Pools eliminate the per-task cost of creating a working copy and make "spawn an
agent on a clean main, right now" a single keystroke from tmux.

Requirements this PRD covers:

1. Pools are named entities on a pro project, associating project checkouts.
2. Members are created by a pool command (`extend`); pools default to a base
   branch (typically `main`).
3. Any repo checkout can be marked **inhabited** by a bee (pool members get this
   automatically; occupancy is visible for non-pool checkouts too).
4. Per-pool **max occupancy** per checkout — default 1 bee, configurable higher.
5. Spawning into a full pool auto-extends it (creates a new member for you).
6. A sync command drives all pool checkouts (and optionally all checkouts) to
   latest `origin/<base>`, attempting rebase and reverting cleanly on conflict.
7. A very fast in-tmux flow (new pane / popup) to spawn an agent into a pool
   checkout.

## 2. Background — what exists today (verified)

**pro** (`~/Projects/oss/pro/repos/pro`, bash):
- `pro co` manages long-lived full clones at `<project>/checkouts/<repo>/<name>`
  (`lib/co.sh`). Create is `git clone --local` (hardlinked objects, origin re-pointed
  to the primary's origin); `-b BRANCH` post-checkout; `--from-origin` for a fresh
  network clone.
- `pro co y|sync` is **ff-only**, refuses dirty/detached. `pro co Y|sync-all` is
  atomic across the project: preflight rejects any dirty/detached member, and any
  ff failure rolls every prior sync back to its pre-sync SHA (`lib/co.sh:285-343`).
  There is **no rebase path** today — requirement 6 is new behavior.
- Slot resolution/context helpers live in `lib/slot.sh`; metadata refresh is
  `refresh_project_repos` + `build_index` after every mutation.
- pro is deliberately **folder-native**: directories are truth, `project.json` is
  repaired metadata (`pro fix`).

**hive** (`repos/honeybee`, TypeScript):
- `src/proProjects.ts` is an existing bridge to pro: parses `pro ls repos`, knows
  the `repos/ | worktrees/<repo>/<name> | checkouts/<repo>/<name>` layout
  (`resolveProSlotForCwd`, :190), and creates/deletes slots by shelling to
  `pro co s -c <name>` (`createProSlot` :262, `acquireProSlot` :271 — race-safe
  probe→create→reprobe returning `{path, created}`).
- `hive fork launch` (`src/commands/fork.ts:487-532`) is the working precedent:
  acquire a pro slot up front, spawn with its path as cwd, roll the slot back only
  if we created it and the spawn failed.
- Spawn cwd precedence: `--cwd` flag > account profile cwd > `process.cwd()`
  (`src/cli/shared.ts:157`, consumed at `src/commands/spawn.ts:577`).
- Durable entities are one-JSON-file-per-record under `~/.hive/`
  (`storeRoot()`, `src/fsx.ts:7`); `src/colony.ts` (record + dir + file lock) is
  the cleanest template for a new entity. Bee records are `SessionRecord` in
  `src/store.ts` (note the deserializer allow-list at `store.ts:379` for new fields).
- Liveness is **derived, not stored**: `deriveState` (`src/state.ts:82`) over live
  tmux panes + seals + HSR run dirs; terminal detection feeds the daemon reconcile
  loop (`src/daemon/tick.ts:480`).
- The fleet TUI already renders pro slot kind/name per bee (`src/beesTui.ts:662`,
  glyphs `⧉` worktree / `⎇` checkout). tmux fast-spawn keybindings are centralized
  in `CANONICAL_TMUX_CONF` / `RECOMMENDED_BINDS` (`src/keybindings.ts:36, 92`) and
  run `display-popup … "hive …"`.
- There is **no existing pool / occupancy / reservation concept** in hive.

**apiary** (Electron cockpit):
- `docs/design-brief.md` §11.3 specs the compose flow: "Where it lives" is a
  multi-step palette whose sixth kind is **Round-robin pool** → pick a pool → pool
  detail → spawn. Capacity chip (`core-pool · 4 free`), low-free warning, overflow
  queues, `New pool…` / `Add clone` affordances. Busy = running-sage dot, free =
  hollow ring.
- `docs/architecture.md` §7.5 planned pools as **Apiary-owned Yjs state**
  (`workspace.pools: Y.Map<PoolId, {name, repo, clones[], claims}>`). **This PRD
  supersedes that ownership**: pool truth moves to pro + hive; Apiary mirrors it
  exactly the way it already mirrors `~/.hive/sessions/*.json` (tool-authoritative,
  never CRDT-merged — architecture tenet #3).

## 3. Vocabulary & model

- **Pool** — named per `(project, repo)`; e.g. `core` on `trmd/honeybee:honeybee`.
  Config: base branch (default: repo default branch), `maxOccupancy` per member
  (default 1), `maxSize` (default 32, **soft** — see §6.3), optional `minFree`.
- **Member** — a pro checkout belonging to a pool. Naming convention:
  `checkouts/<repo>/<pool>-<n>` with `n` monotonically increasing (`core-1`,
  `core-2`, …). Membership is **derived from the directory name** (folder-native),
  so `pro` and `hive` agree without a shared registry of members.
- **Inhabited** — a checkout (pool member or not) whose path is the `cwd` of at
  least one live, non-terminal bee. Occupancy count = number of such bees.
- **Claim** — hive's short-lived, durable record that a specific bee (or pending
  spawn) has been allocated a specific member. Claims bridge the race window
  between allocation and the bee's `SessionRecord` existing; steady-state
  occupancy is derived, not claimed (§6.2).
- **Free** — member with occupancy + active claims `< maxOccupancy` and not
  parked (§6.5).

## 4. Ownership split

| Concern | Owner | Where |
|---|---|---|
| Checkout directories, cloning, deletion | **pro** | `checkouts/<repo>/<pool>-<n>` |
| Pool definition (base branch, maxOccupancy, maxSize) | **pro** | `project.json` `repos[].pools[]` |
| Member enumeration | **pro** (derived from disk) | `pro pool ls --porcelain` |
| Sync-to-origin w/ rebase + clean revert | **pro** | `pro pool sync`, `pro co sync --rebase` |
| Occupancy (which bee inhabits what) | **hive** (derived from `SessionRecord.cwd` + `deriveState`) | computed on read |
| Claims (allocation race safety, round-robin pointer) | **hive** | `~/.hive/pools/<key>.json` |
| Allocation policy, auto-extend trigger | **hive** | `hive pool` / `hive spawn --pool` |
| Fast tmux spawn UX | **hive** | keybinding + popup |
| Pool UI (PATH 6 palette, pool detail) | **apiary** (read-only mirror + shell-outs) | watches `~/.hive/pools/` + `hive pool status --json` |

Rationale: pro owns everything that is true about the *project tree on disk* and
must hold with hive absent (you can use pools purely from the shell). hive owns
everything that is true about *agents* and must hold with apiary absent. Apiary
owns nothing new.

## 5. pro-side spec

### 5.1 Pool metadata

`project.json`, per repo entry:

```json
{
  "name": "honeybee",
  "path": "repos/honeybee",
  "pools": [
    { "name": "core", "branch": "main", "maxOccupancy": 1, "maxSize": 12 }
  ]
}
```

- `name` must be a slug; `<pool>-<n>` member names must not collide with existing
  ad-hoc checkout names (creation refuses if a non-member checkout already matches
  the pattern).
- Members are **not** listed in metadata — they are the `checkouts/<repo>/<pool>-<n>`
  directories. `pro fix` / `pro doctor` validate the convention (gaps in numbering
  are fine; duplicates or non-git dirs are flagged).
- `maxOccupancy` / `maxSize` live here so the config travels with the project and
  hive never needs its own copy. `maxSize` defaults to 32 and is a **soft limit**:
  extension past it succeeds with a loud warning, never a hard failure.

### 5.2 New command family: `pro pool`

Context-relative like `pro co` (run inside a project/repo; qualify `REPO:NAME` in
multi-repo projects).

```
pro pool                        # list pools (name, size, branch, per-member branch+dirty)
pro pool c|create <name> [-b BRANCH] [--occupancy N] [--max-size N] [--size N]
                                # define pool; --size N pre-extends N members
pro pool e|extend <name> [N]    # clone next N members (default 1): git clone --local
                                #   from primary, checkout <branch>, origin re-pointed
                                #   (exactly cmd_co_create); prints created paths
pro pool d|delete <name> [--members|--keep-members] [--force]
                                # drop pool config; --members trashes member checkouts
                                #   (same safety rails as `pro co d`)
pro pool y|sync <name>          # sync members to origin/<branch>; see 5.3
pro pool ls --porcelain         # machine output for hive/apiary (see below)
```

Porcelain format **(as shipped)** — lines are record-tagged and carry the repo,
since pool names are only unique per repo:

```
pool	<repo>	<name>	<branch>	<maxOccupancy>	<maxSize>
member	<repo>	<pool>	<n>	<path>	<branch>	<dirty 0|1>	<ahead>	<behind>
```

`ahead`/`behind` count against the last-fetched `origin/<branch>` ref, `-` when
the ref is missing; listing never fetches.

Implementation: new `lib/pool.sh` reusing `resolve_slot_target`, `_co_dir`,
`cmd_co_create` internals, `refresh_project_repos`, `build_index`.

### 5.3 Sync semantics (requirement 6) — `pro pool sync` and `pro co sync --rebase`

Per member, against `origin/<pool.branch>` (member's current branch is *not* the
target — pool members are expected to sit on the base branch; see parking below):

1. Skip (report `skipped-dirty`) if worktree dirty. Unlike `co sync-all`'s
   all-or-nothing preflight, pool sync is **per-member**: one bad member must not
   block refreshing the rest. `--strict` restores atomic behavior if wanted.
2. Skip (report `skipped-parked`) if member is on a branch ≠ base branch — that is
   a bee's (or your) work in progress. Never touch it.
3. `git fetch origin <branch>`.
4. Try `merge --ff-only origin/<branch>` → `synced-ff`.
5. If ff fails (local commits on base branch): snapshot `HEAD`, try
   `git rebase origin/<branch>`.
   - Success → `synced-rebase (a..b, N commits replayed)`.
   - Conflict → `git rebase --abort`, verify `HEAD` == snapshot (belt-and-braces
     `reset --hard <snapshot>` if not), report `failed-rebase-reverted`. Exit code
     reflects any failures; every member is left either updated or byte-identical
     to its pre-sync state. This is the "attempting rebasing, exiting with clean
     revert" requirement.

As shipped, the full status vocabulary is: `synced-ff`, `synced-rebase`,
`unchanged`, `skipped-dirty`, `skipped-parked`, `skipped-detached`,
`failed-rebase-reverted`, `failed-ff`, `failed-fetch`, `failed-no-origin`,
`failed-missing`. `--strict` (atomic preflight + rollback) still *skips* parked
members rather than blocking on them.

Ad-hoc (non-pool) checkouts are **never** touched by pool sync. They get the
same machinery through `pro co sync` directly, which grows selectors and the
rebase path:

```
pro co y|sync [NAME…] [--all] [--rebase]
```

Multiple `[REPO:]NAME` selectors sync those checkouts; `--all` sweeps every
checkout in the project (pool members included); `--rebase` enables step 5
(default stays ff-only for backward compatibility). Per-member skip/report
semantics as above; the existing atomic `co Y|sync-all` remains for the
all-or-nothing use case.

pro deliberately knows nothing about occupancy. Skipping *inhabited* members is
hive's job (§6.6) — hive passes an explicit member list. Direct `pro pool sync`
is still safe against live bees in the common case because an inhabited member is
almost always dirty or parked; but the guarantee lives in hive.

## 6. hive-side spec

### 6.1 Pool records — `~/.hive/pools/<key>.json`

Key: `<area>-<project>-<repo>-<pool>` slug (e.g. `trmd-honeybee-honeybee-core`).
Pattern-copy `src/colony.ts` (dir helper, file lock, atomic write):

```jsonc
{
  "key": "trmd-honeybee-honeybee-core",
  "area": "trmd", "project": "honeybee", "repo": "honeybee", "pool": "core",
  "colony": "honeybee",            // optional association for selectors/UI
  "rrCursor": 3,                    // round-robin pointer: last-allocated n
  "claims": [                       // short-lived; see 6.2
    { "member": 3, "path": "...", "beeName": "drone-07", "claimedAt": "...", "pendingUntil": "..." }
  ],
  "parked": [5]                     // members withheld from allocation (6.5)
}
```

This file holds **only what cannot be derived**: the cursor, in-flight claims,
parks. Config (branch, occupancy caps) is read from pro (`pro pool ls
--porcelain`, cached via the existing 30s `proProjects` cache); membership is
read from disk. If the file is deleted, pools still work — cursor resets, claims
rebuild from live bees.

### 6.2 Occupancy model

- **Derived truth**: a member is inhabited by every bee whose `SessionRecord.cwd`
  realpath-prefixes the member path and whose `deriveState` is non-terminal
  (reuse `resolveProSlotForCwd` on bee cwd; already how the TUI labels slots).
- **Claims** cover the allocation→record gap only: written under the pool file
  lock at allocation, carrying `pendingUntil` (~120s). A claim is *consumed* once
  a live bee with matching name/cwd exists, *expired* if `pendingUntil` passes
  with no such bee. Free-count = `maxOccupancy − (live inhabitants + unconsumed
  claims)` per member.
- **Release is lazy**: bee goes terminal (sealed/dead/killed/cleaned) → member
  simply stops counting it. Eager cleanup: `src/kill.ts` and `hive clean` drop
  any matching claim; the daemon sweep (§6.6) garbage-collects expired claims.
  No stored "inhabited" bit means no staleness bugs — same philosophy as
  `deriveState`.
- Non-pool checkouts get the same derived treatment for free: `hive pool status`
  (and the TUI) can show occupancy for any pro slot, satisfying "any repo
  checkout can be marked as inhabited".

### 6.3 Allocation (round-robin + auto-extend)

`allocatePoolMember(pool)` under the pool file lock:

1. Enumerate members from disk; compute free set (§6.2), excluding `parked`.
2. Pick the **emptiest** free member (lowest occupancy + claims below cap);
   ties broken round-robin — first at index > `rrCursor`, wrapping (matches the
   mockup's "next up"). With `maxOccupancy: 1` every free member is equally
   empty, so this reduces to plain round-robin.
3. None free → **auto-extend** (requirement 5): shell `pro pool extend <name>`
   and claim the new member. `maxSize` is **soft**: past it, extension still
   proceeds but both hive and `pool status` warn loudly
   (`pool core exceeds maxSize: 33/32 — consider cleaning or raising maxSize`).
   Queueing is explicitly out of scope for v1 (§9) — Apiary's overflow-queue can
   layer on later without protocol changes.
4. Write claim + advance `rrCursor`, release lock, return `{path, member, created}`.

Rollback mirrors fork-launch: if allocation *created* a member and the spawn then
fails, drop the claim; optionally `pro co d` the fresh member (flag-gated,
default keep — a spare clone is harmless and expensive to remake).

### 6.4 Spawn integration

- `hive spawn --pool <name>` (also on `hive x`, `hive new`, `hive fork launch`):
  allocate → inject as cwd (highest precedence, same slot as `--cwd`; mutually
  exclusive with `--cwd`) → `spawnBee` → claim ties to the final bee name.
  Insertion point: `src/commands/spawn.ts:577` beside `resolveSpawnCwd`.
- Pool name resolution: exact key, else unique match by pool name within the
  current cwd's pro project / the bee's colony association.
- `--count N` fan-out claims N members in one lock acquisition (the design
  brief's "natural partner to Fan-out"), auto-extending as needed.
- Record a `poolKey` (+ member) on `SessionRecord` (add to the `store.ts:379`
  allow-list) so fleet/TUI/ledger can attribute bees to pools without re-deriving.

### 6.5 `hive pool` command family

`src/commands/pool.ts` (dispatch pattern of `colony.ts`), registered in
`src/cli.ts` switch + help "Organize" group:

```
hive pool                          # pools with occupancy: core 4/6 (2 busy · 4 free)
hive pool status [<pool>] [--json] # member table: n, path, branch, occupant bee(s),
                                   #   state, dirty/parked — the PATH-6 detail view
hive pool spawn <pool> [spawn flags…]   # allocate + spawn (what the popup runs)
hive pool extend <pool> [N]        # manual grow (delegates to pro)
hive pool sync [<pool>|--all]      # occupancy-aware sync: free members only (6.6)
                                   #   pools only — ad-hoc checkouts are pro's
                                   #   territory: `pro co sync [NAME…] [--all]`
hive pool claim <pool> [n] / release <pool> <n>   # manual escape hatches
hive pool park <pool> <n> / unpark # withhold a member from allocation
```

`--json` on `pool`/`status` is the Apiary contract.

### 6.6 Daemon sweep (`src/daemon/tick.ts`)

Piggyback the existing reconcile loop:

- Expire stale claims (past `pendingUntil`, no matching bee).
- **Refresh-on-vacate**: when a member transitions inhabited → free, run the
  §5.3 sync for that member (skip if dirty/parked) so the next claim lands on
  fresh `origin/<branch>`. This keeps the pool hot without a cron.
- If `minFree` is configured and free-count dipped below it, pre-extend in the
  background — spawn latency then never includes a clone.
- Flag members left dirty or parked by departed bees: surfaced in `pool status`
  and a `buz` nudge, never auto-reset. A human (or an explicit
  `hive pool reset <n> --hard`) decides.

### 6.7 Fast tmux flow (requirement 7)

- New canonical bind in `src/keybindings.ts` (`CANONICAL_TMUX_CONF` +
  `RECOMMENDED_BINDS`): **`M-p`** → `display-popup -E "hive pool launch"`.
- `hive pool launch`: fzf-style picker (pattern of `hive launch`/`fork launch`)
  — step 1 pick pool (rows show `core 4/6 · 2 busy`, plus `new pool…`); step 2
  agent/harness (reuse the `hive new` picker, prefilled defaults); ↵ allocates,
  spawns, and links the bee's window into the current session (existing `--here`
  path, `cli.ts:292` per fork-and-pane PRD). Zero-free pools show `(will extend)`
  rather than being disabled.
- Total keystrokes for the happy path: `M-p`, ↵ (pool), ↵ (agent) — bee running
  on a clean main in its own pane link.
- Fleet TUI/sidebar: extend the existing slot glyphs (`beesTui.ts:662`) with the
  pool member (`⎇ core-3`), and a pools section showing capacity chips.

## 7. Concurrency & failure modes

- **Two spawns race one free member** — claims are written under the pool file
  lock (`withLock` pattern from `colony.ts`); second allocator sees the first
  claim and takes the next member.
- **Spawn dies after claim** — claim expires at `pendingUntil`; daemon GC.
- **Bee `cd`s out of its member** — occupancy is cwd-record-based, not live-pwd;
  the claim + `SessionRecord.poolKey` keep attribution stable regardless.
- **Member deleted on disk while claimed** — enumeration is disk-derived, so it
  vanishes from the roster; dangling claim expires; `pool status` warns.
- **pro missing / not on PATH** — `hive pool` degrades with the existing
  proProjects error surface; spawn `--pool` fails fast with actionable message.
- **Sync vs. inhabitant race** — hive computes the free set and passes explicit
  member paths to pro; a member claimed between compute and sync is dirty-skipped
  by pro's per-member preflight (worst case it ff-syncs under a just-started bee
  that hasn't touched the tree — benign).

## 8. Apiary follow-through (separate work, listed for alignment)

- Drop `workspace.pools` Yjs ownership (architecture.md §7.5) → watch
  `~/.hive/pools/*.json` + shell `hive pool status --json`, mirroring exactly like
  sessions (tool-authoritative). Claims map cleanly: `claims: {cloneId →
  sessionId}` ≙ hive claims + derived occupancy.
- PATH-6 palette drives `hive pool spawn` / `pro pool create` under the hood.
- Overflow **queue** (design-brief) becomes an Apiary-side wait on free-count —
  or a later `hive pool` primitive if it proves generally useful.

## 9. Out of scope (v1)

- Spawn queueing on full pools (soft-extend past `maxSize` with a warning
  instead).
- Worktree pools (`pro wt` slots share one object store & branch namespace;
  checkouts are the right isolation for parallel agents — revisit if clone cost
  bites even with `--local` hardlinks).
- Remote-node pools (remote-hsr already has its own checkout provisioning,
  `spawn.ts:255`; unify later behind the same allocation interface).
- Auto-deleting shrunk members; quest/workspace integration (pools compose with
  WORKSPACES_AND_QUESTS_PRD naturally: a quest's swarm spawns `--pool`).

## 10. Phasing

1. **pro**: `lib/pool.sh` (create/extend/ls/porcelain/delete), `--rebase` sync
   path + per-member `pool sync`, `project.json` pools schema, doctor checks,
   README. Independently shippable & shell-usable.
   **✅ Shipped 2026-07-04** — pro repo branch `checkout-pools` (4 commits on
   `2b6ed02`), build green (shellcheck + 69/69 smoke + 54/54 pool assertions).
   Not yet merged to pro `main`.
2. **hive core**: `src/pool.ts` (records, claims, allocation, occupancy
   derivation), `proProjects.ts` additions (`pro pool` porcelain parsing,
   extend), `hive pool` commands, `spawn --pool`, `SessionRecord.poolKey`.
3. **hive UX + daemon**: `M-p` popup flow, TUI surfacing, daemon sweep
   (claim GC, refresh-on-vacate, minFree pre-extend), `HIVE_CLI_REFERENCE.md`,
   completion.
4. **apiary**: ownership flip + PATH-6 UI against the new surfaces.

Testing: pro gets bats-style tests beside existing `tests/` (rebase-revert
byte-identical guarantee is the critical one); hive unit-tests allocation as a
pure function over `(roster, claims, sessions)` + an integration test against a
scratch `HIVE_STORE_ROOT` and a throwaway pro project fixture (pattern exists in
`real-tests/`).

## 11. Resolved questions (2026-07-04)

1. **Naming** — "pool" confirmed (`pro pool` + `hive pool`). No honeybee-themed
   alternative (comb is a retired term).
2. **`maxOccupancy > 1`** — allocation prefers the **emptiest** member below
   cap, round-robin tie-break (§6.3).
3. **`maxSize`** — default **32**, **soft** limit: auto-extend past it proceeds
   with a loud warning, never a hard failure (§5.1, §6.3).
4. **Ad-hoc checkout sync** — `hive pool sync` never touches non-pool checkouts.
   Ad-hoc sweeps go through pro directly: `pro co sync [NAME…] [--all]
   [--rebase]` (§5.3).
