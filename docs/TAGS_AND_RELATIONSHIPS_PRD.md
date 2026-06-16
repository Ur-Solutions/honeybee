# honeybee Tags & Relationships PRD

## 1. Summary

**Tags & Relationships** makes labeling and connection a *first-class* concept in
honeybee (`hive`) — its own subsystem with its own module, verb, tmux facet, and
query path — rather than a drift of grouping fields scattered across the session
record.

The model has two halves, joined by **one query spine**:

1. **Tags** — a tag is a label carried by a bee, either a **bare token**
   (`migration`, `waiting-review`) stored verbatim or an explicit `namespace:value`
   (`prio:p1`). The existing single-hierarchy facets (`colony`, `swarm`, `quest`,
   `workspace`, `caste`, `node`, `comb`) become **reserved namespaces** whose value
   is *derived on read* from the canonical scalar fields that already store them.
   So "filter by colony", "filter by swarm", "filter by quest", and "filter by an
   arbitrary label" become the *same line of code* — one mechanism, one switcher
   chip model, one tmux option.
2. **Relationships** — directed, typed edges between two bee identities
   (`reports-to` / `owned-by`, plus the `split-from` / `forked-from` lineage from
   fork-and-pane). Direction and a target *bee* are things tag-equality cannot
   express, so relationships are their own typed layer — but they are *queried*
   through the same selector grammar (`owns:<bee>`, `children-of:<bee>`,
   `forks-of:<bee>`), so the operator learns one filter idiom.

The decision that anchors this design (NAVIGATION_PRD §13 Q1): **add tags; keep
colony/swarm as well-known reserved facets.** Here that is made *literally true* —
colony/swarm are reserved namespaces whose cardinality is pinned to 1, derived
from `record.colony` / `record.swarmId`, so they keep their dedicated write verbs,
their rename cascade, and their single-valued guarantee, and they *cannot drift*
from a duplicate tag copy because there is no copy. This is also the literal
satisfaction of WORKSPACES_AND_QUESTS_PRD §16 Q7 ("`questId`/`workspaceId`/`colony`
membership aligns onto this model rather than adding ad-hoc fields"): those become
reserved-namespace values, not new query mechanisms.

The work builds on the substrate hive already ships: every bee carries
`@hive_*` user options that `tmux ls -f` filters natively (NAVIGATION_PRD §1), and
the session record already validates an allow-list and carries unknown keys
through a load→save cycle (`src/store.ts:248`, `:299-305`). Tags need exactly one
new array field on the record plus a delimited `@hive_tags` mirror; relationships
need three plain string fields. No new on-disk registry in v1.

## 2. Motivation

- **The asks each grew their own labeling system.** NAVIGATION_PRD wants
  multi-valued tags for faceted filtering at scale ("waiting claude bees in repo
  X"). hotkey-and-minor-features wants a "parent association between bees
  (owned-by / reports-to)" to filter the bees you own. fork-and-pane wants
  lineage edges (`parentId` / `combId` / `forkedFromId`). WORKSPACES_AND_QUESTS
  wants `questId` / `workspaceId` membership. Left alone, that is *five* ad-hoc
  field sets and *five* query idioms for what is one concept: "this bee is
  labeled / connected, let me filter on it."
- **Scattered fields don't compose and don't scale conceptually.** A bee already
  has `colony`, `swarmId`, `caste`, `node`; adding `questId`, `workspaceId`,
  `combId`, `parentId`, `forkedFromId`, `reportsToId`, `tags` as parallel,
  independently-queried columns means every navigation surface, selector, and
  switcher chip special-cases each one. The operator has to learn N filters.
- **The signal already exists; it needs one home.** The store is already the
  source of truth for metadata and tmux for liveness (NAVIGATION_PRD §10). What's
  missing is a single *labeling/connection* concept that every grouping maps onto,
  so the faceted switcher, the attention queue, and orchestration bees all read
  the same mechanism.
- **Tags must be their own concept, not a field.** The operator decided tags
  "live as their own concept." That means a module (`src/tags.ts`), a record-level
  validation branch, ledger events, a `@hive_tags` facet, a `hive tag` verb, and a
  selector grammar — not a `tags` column quietly added next to `colony`.

## 3. Goals

- One query spine: a single predicate ("does this bee carry tag T?") and a single
  selector grammar extension serve colony, swarm, quest, workspace, caste, comb,
  *and* arbitrary user tags.
- Make tags genuinely multi-valued and free-form while keeping colony/swarm/quest/
  workspace single-valued and reserved — enforced by namespace, not convention.
- Directed relationships (owned-by / reports-to / lineage) are first-class,
  queryable in both directions ("bees I own", "children of X", "forks of X"),
  stored once on the source bee with the reverse computed.
- Zero migration for the reserved facets: every existing bee gains correct
  `colony:` / `swarm:` / `caste:` tags on read, with no backfill job.
- Keep it tmux-native and store-light: tags mirror to one `@hive_tags` option for
  store-free `tmux ls -f` filtering; the store stays the source of truth.
- Honor the existing architecture: no third registry, allow-list discipline,
  best-effort tmux writes, back-compatible record format.
- Each phase ships independently and is useful on its own.

## 4. Non-goals

- A separate `~/.hive/tags/` or `~/.hive/relationships/` registry in v1. Reverse
  queries are O(n) scans over `listSessions()` — the same scan every list/selector
  call already does. An inverted index is a deferred, rebuildable cache (§14
  Phase 4), never a source of truth.
- Replacing colony/swarm/quest/workspace *storage*. Those keep their canonical
  scalar fields, record types, write verbs, and cascade logic; tags are the
  unifying *read/query* spine, not a unifying storage blob.
- Encoding directed relationships as paired tags (e.g. `owner-of:x` on the parent
  *and* `owned-by:x` on the child). That doubles writes and reintroduces
  two-record drift; relationships are typed edges stored once on the source.
- Infix boolean composition (`A OR B`, `NOT C`, parentheses) in v1. `hive list`
  composes facets *conjunctively* via repeated flags, which covers every PRD
  acceptance criterion. A boolean `and`/`or`/`not` Selector node is deferred (§16).
- A GUI / web surface, or ML-ranked tag suggestion. Terminal-native, explicit.
- Writing the lineage fields themselves — `parentId` / `forkedFromId` / `combId`
  are *written* by fork-and-pane's `split` / `fork` commands. This PRD only adds
  their reserved-namespace tags and reverse selectors.

## 5. Primary Users

### Tormod / humans

Run a large fleet and need to slice it by any dimension without scrolling: "waiting
claude bees in repo X", "everything tagged `migration`", "the bees I own", "the
forks of CL.x". Need to add/remove labels on a bee or selection with one verb, and
have the faceted ⌘s switcher and `hive next` consume those labels.

### Orchestration bees (Jancsi / OpenClaw agents)

Spawn and supervise sub-fleets. Need to tag a sub-fleet at spawn, set a
reports-to/owned-by relationship, and later query "which of my bees are waiting?"
or "which bees do I own?" programmatically through the same conjunctive filters —
without tailing panes or learning a second query language.

## 6. Core Concepts

### Tag

A label carried by a bee, in one of two forms: a **bare token** (`migration`,
`waiting-review`) or an explicit **`namespace:value`** (`prio:p1`). A bare token is
always a free-form user tag, stored **verbatim** — there is no invented prefix.
The colon belongs to namespaces (reserved facets and optional power-user
namespaces). So `--tag migration` stores `migration`, and `--tag prio:p1` stores
`prio:p1`. The value grammar forbids whitespace, comma, tab, and newline — so the
delimited `@hive_tags` mirror and the tab-delimited `list-sessions` parse can never
be corrupted (§9).

### Namespace

The part before the colon (reserved facets and power-user namespaces only; bare
user tags have no namespace). Reserved namespaces map to a **getter**, split into
three tiers by how their getter is sourced **today** — so the reader never
mistakes an aspirational facet for a shipped one:

- **Live in v1** — back an existing `SessionRecord` field, so they derive with zero
  new code and zero data migration: `colony → record.colony`,
  `swarm → record.swarmId`, `caste → record.caste`, `node → record.node`,
  `agent → record.agent`.
- **Net-new derivation this PRD builds** — `repo → repoTagFor(record.cwd)` and
  `state → @hive_state` (both are new code with the §13 contract, not existing
  behavior). The `agent:`/`repo:` tmux facets additionally require stamping
  `@hive_agent`/`@hive_repo`, which `writeSpawnOptions` does **not** do today (§9.2,
  §10.5).
- **Lights up when its owning PRD lands** — `quest → record.questId`,
  `workspace → record.workspaceId`, `comb → record.combId ?? record.tmuxTarget`.
  The getters ship in v1 but return nothing until WORKSPACES_AND_QUESTS / fork-and-
  pane populate those fields.

All reserved-namespace tags are **single-valued by construction** (a bee has one
colony) and are **never persisted as tags** — they are derived on read. Users
cannot write them via `hive tag` (rejected with a redirect to the canonical verb).

- **User tags** — a bare token, multi-valued, the *only* free-form,
  persisted-on-the-bee tags. Power users may invent their own `namespace:value`
  (e.g. `prio:p1`); any non-reserved namespace is just a user tag stored verbatim.
  There is **no mandatory default namespace** — bare means bare.

### Effective tag set

The union, computed on read, of (a) the derived reserved tags from every getter
that returns a value and (b) the stored user tags in `record.tags`. This one set
is what the selector predicate, the switcher chip line, and the `@hive_tags`
mirror all read. There is a single derivation function so the three consumers
never diverge.

### Relationship (directed edge)

A directed, typed connection from one bee to another bee, with a *verb*:
`reports-to` / `owned-by` (operator-chosen, mutable — the hotkey "parent
association"), `split-from` (intra-comb lineage, write-once), `forked-from`
(cross-comb lineage, write-once). An edge is stored as a scalar field on the
**source** bee pointing at a target bee id. The reverse direction ("bees that
report to me", "children of X", "forks of X") is computed by a scan, projected
into the same selector grammar.

### Reserved vs user, single vs multi — the load-bearing table

| Concept | Storage | Cardinality | Written by | Queried as |
|---|---|---|---|---|
| colony / swarm | `record.colony` / `swarmId` | single (reserved) | spawn / move / rename | `colony:x` `@x` `tag:colony:x` |
| quest / workspace | `record.questId` / `workspaceId` | single (reserved) | quest-start / ws-add | `quest:x` `ws:x` |
| caste / node / comb | `record.caste` / `node` / `combId` | single (reserved) | frame spawn / split | `caste:x` `comb:x` |
| user tags | `record.tags: string[]` | **multi** | `hive tag` | `#x` `tag:x` |
| owned-by / reports-to | `record.reportsToId` | **directed edge** | `hive own` | `owns:<bee>` |
| split / fork lineage | `record.parentId` / `forkedFromId` | **directed edge** | `hive split` / `fork` | `children-of:` `forks-of:` |

## 7. Data model

The net-new *persisted* state is intentionally small: **one array field** (user
tags) and **three string fields** (relationship edges). Everything reserved is
derived, not stored twice.

### 7.1 `SessionRecord` (additive, `src/store.ts:7-54`)

```ts
// Tags (first-class). Holds ONLY free-form user tags — bare or power-user-
// namespaced, e.g. ["migration", "waiting-review", "prio:p1"]. Reserved-
// namespace tags (colony:/swarm:/…) are NEVER stored here — derived on read.
tags?: string[];

// Relationships (directed, typed edges). Each is a bee id on the SOURCE bee.
reportsToId?: string;   // "owned-by / reports-to" — operator-chosen, mutable
                        // (hotkey-and-minor-features.md "parent association")
// parentId?, forkedFromId? are WRITTEN by fork-and-pane (split/fork); this PRD
// adds only their reserved-namespace tags + children-of:/forks-of: selectors.
```

`tags` is an **array**, so it cannot ride `OPTIONAL_STRING_SESSION_KEYS`
(strings-only, applied at `src/store.ts:278-280`). It needs its own validation
branch in `normalizeSessionRecord`, modeled exactly on the `buzAccept` precedent
(`src/store.ts:291-297`): coerce to array, filter to grammar-valid strings,
**reject reserved namespaces** (defense-in-depth so a hand-edited file can't
smuggle `colony:x` into `tags`), dedupe, and cap (32 tags × 64 chars — see §13).
`tags` is added to `KNOWN_SESSION_KEYS` (`src/store.ts:250`) so the unknown-key
carry-through doesn't double-handle it.

`reportsToId` is a plain string → appended to `OPTIONAL_STRING_SESSION_KEYS`
(`src/store.ts:248`), alongside the already-planned `parentId` / `forkedFromId` /
`combId` / `workspaceId` / `questId` from the sibling PRDs.

### 7.2 The three layers (one is pure-derived)

- **Layer 1 — value & namespacing.** `RESERVED_NAMESPACES: Record<string,
  (rec) => string | undefined>` (the §6 getters); user tags are stored bare, with
  no default namespace. The single derivation entry point
  `effectiveTags(record): Set<string>` returns reserved
  (from getters) ∪ user (from `record.tags`). Used by the selector predicate, the
  switcher line, and the `@hive_tags` renderer — one function, three consumers.
- **Layer 2 — persisted user tags.** `record.tags: string[]`, the one net-new
  array field, written through `updateSession()` inside the existing per-session
  lock (`src/store.ts:136-162`), so tag writes are atomic with the rest of the
  record and race-free against the heartbeat/touch path (`src/store.ts:123`).
- **Layer 3 — relationship edges.** `record.reportsToId` (+ the fork-and-pane
  `parentId` / `forkedFromId`) as scalar strings on the source bee. The reverse
  ("bees I own", "children of X") is an O(n) scan over `listSessions()` — the same
  scan `resolveSelector` already performs (`src/selectors.ts:87`). No edge table,
  no adjacency cache, no cascade-delete machinery in v1.

### 7.3 Why no separate tag/edge store in v1

NAVIGATION_PRD §10 is explicit: "no third registry — store is truth for metadata,
tmux is truth for liveness." A `~/.hive/tags/index.json` would *be* that third
registry and a perpetual consistency liability. `listSessions()` is already O(n)
and already loaded for every list/selector call; tag filtering is a `.filter()`
over data already in hand. The inverted index is deferred to §14 Phase 4 — and
even then it is a *derived cache* rebuilt by ledger replay, with its own
`.tags.lock`; if it ever disagrees with the per-bee records, the records win.

### 7.4 Why relationships are edges, not tags (grafted rigor)

A directed `reports-to` edge has a *verb* and a *direction* that tag-equality
cannot express, and its value is a *bee*, not a label. The rejected alternative —
paired tags (`owner-of:x` on the parent, `owned-by:x` on the child) — doubles
writes and reintroduces exactly the two-record drift this design avoids. Storing
each edge once on the source bee and computing the reverse is the correct call.
The design therefore has **one query spine, two storage models** (derived-tag
membership + scalar-edge relationships). The storage and the resolved Selector
kind for relationships are honestly distinct from tags, even though both are
*queried* through the one selector grammar. v1 does not project relationships into
any tmux option (§9.4).

### 7.5 Ledger events (`appendLedger`, `src/store.ts:217-223`)

Compacted, mirroring the colony/swarm conventions:

- `tag.add` — `{ bee, tags: [...] }`
- `tag.remove` — `{ bee, tags: [...] }`
- `rel.set` — `{ bee, kind: "reports-to", to }`
- `rel.clear` — `{ bee, kind }`

Lineage edges (`parentId` / `forkedFromId`) are *not* duplicated here — they ride
the existing `bee.split` / `fork.create` events (fork-and-pane §5.2).

## 8. Selector grammar

One new prefix family unifies everything. Extend the `Selector` union
(`src/selectors.ts:6-9`) with a tag kind and a relationship-reverse kind:

```ts
export type Selector =
  | { kind: "bee"; query: string }
  | { kind: "swarm"; name: string }              // @x   — kept, now sugar for tag:swarm:x
  | { kind: "colony"; name: string }             // colony:x — kept, now sugar for tag:colony:x
  | { kind: "tag"; namespace?: string; value: string }     // facet / user-tag match
  | { kind: "rel"; verb: RelVerb; target: string };        // reverse relationship traversal
```

`ResolvedTarget` (`src/selectors.ts:11-14`) must gain matching multi variants that
**carry `records: SessionRecord[]`**, because every consumer does
`resolved.kind === "bee" ? [resolved.record] : resolved.records` (~10 sites:
`src/cli.ts:578,595,626,758,3452,3485,3591,3871,…`). So the new kinds surface
`records` and flow through unchanged:

```ts
export type ResolvedTarget =
  | { kind: "bee"; record: SessionRecord }
  | { kind: "swarm" | "colony"; name: string; records: SessionRecord[] }   // existing
  | { kind: "tag"; namespace?: string; value: string; records: SessionRecord[] }
  | { kind: "rel"; verb: RelVerb; target: string; records: SessionRecord[] };
```

`formatSelector` (an exhaustive switch, `src/selectors.ts:74-83`) and
`isSelectorMulti` (`:70-72`) each get the two new cases.

### 8.1 Parsing (`parseSelector`, `src/selectors.ts:25`)

Longest-prefix dispatch, a strict superset of today's grammar:

| Input | Selector | Meaning |
|---|---|---|
| `colony:x` | `colony` (sugar → `tag:colony:x`) | bees whose derived `colony:` tag is `x` |
| `@x` | `swarm` (sugar → `tag:swarm:x`) | bees whose derived `swarm:` tag is `x` |
| `tag:<ns>:<val>` or `<ns>:<val>` (known ns) | `tag` | bees carrying that tag |
| `#migration` or `tag:migration` | `tag` (user) | bees carrying the bare user tag `migration` |
| `owns:<bee>` / `owned-by:<bee>` / `reports-to:<bee>` | `rel` | bees whose `reportsToId` resolves to `<bee>` |
| `children-of:<bee>` | `rel` | bees whose `parentId` resolves to `<bee>` |
| `forks-of:<bee>` | `rel` | bees whose `forkedFromId` resolves to `<bee>` |
| bare token | `bee` | unchanged exact/prefix match (`matchesSessionReference`) |

`colony:` and `@` keep their exact current spellings and resolve to the *same
record set* as before — they simply lower into the unified tag resolver. **Zero
breakage.** The old colony/swarm branches in `resolveSelectorFromState` collapse
into the generic tag branch while preserving their throw-on-unknown behavior
(checked against `state.colonies` / `state.swarms`, `src/selectors.ts:89-98`).

### 8.2 Resolution (`resolveSelectorFromState`, `src/selectors.ts:41`)

**One predicate** for every membership/tag selector:

```ts
// tag kind (bare user tag or ns:value):
const want = selector.namespace ? `${selector.namespace}:${selector.value}` : selector.value;
return state.records.filter((r) => effectiveTags(r).has(want));
```

`effectiveTags(r)` is the §7.2 derivation (reserved getters ∪ `r.tags`). The
*matching* line is uniform, but the **unknown-value throw bifurcates per reserved
namespace** — it is not literally one branch: `colony:` checks `state.colonies`
and `swarm:` checks `state.swarms` (`src/selectors.ts:89-98`) to throw
`Unknown colony/swarm` as today, while `quest:` / `workspace:` have **no existence
set yet** (those registries are populated by WORKSPACES_AND_QUESTS) so they match
0..N without a throw, and user tags never throw. So the resolver carries a small
per-namespace existence-check map alongside the getters map; the *predicate* is
shared, the *unknown-value policy* is per namespace.

**Relationship kind** resolves the anchor to a **raw bee id**, then scans by string
equality — it must **not** require the anchor to still be a live bee:

```ts
// rel kind: resolve the anchor to an id string. Try the bee resolver's
// exact/prefix/ambiguity logic (src/selectors.ts:58-67) for a friendly id, but
// FALL BACK to the raw token when it no longer resolves to a live bee, so
// `owns:<dead-owner>` still matches live bees that carry the dead owner's id.
const targetId = resolveBeeId(state, selector.target) ?? selector.target;
return state.records.filter((r) => r[fieldFor(verb)] === targetId);
// fieldFor: "owns"/"owned-by"/"reports-to" → reportsToId;
//           "children-of" → parentId; "forks-of" → forkedFromId
```

**Dangling-edge policy (v1):** when an owner/parent/fork source is killed, the
`reportsToId`/`parentId`/`forkedFromId` values on surviving bees are left as-is
(no cascade, no edge-table to sweep — §13). Reverse queries match by raw id, so a
dangling edge is tolerated and still answerable; cleanup is deliberately out of
v1 (§16).

### 8.3 Conjunction, multi-semantics, formatting

- **Conjunction** is flag-based AND in `cmdList` — but this is a **prerequisite to
  build, not existing infrastructure**: `cmdList` today reads only `--colony` /
  `--swarm` / `--node` (`src/cli.ts:817-819`) and has no positional selector. The
  `--tag` / `--state` / `--agent` / `--repo` / `--json` flags and positional-
  selector support are a NAVIGATION_PRD Tier 0 deliverable this PRD's Phase 1
  depends on (§10.5). Once built, `hive list --tag a --tag b --state waiting
  --colony x` ANDs each predicate; repeated `--tag` is conjunctive — covering
  "waiting claude bees in repo X" without an infix parser. A boolean
  `and`/`or`/`not` Selector node is deferred to §16.
- **`isSelectorMulti`** returns `true` for `tag` and `rel` kinds (they may match
  0..N bees), so they route through the existing multi-bee path
  (`resolved.kind === "bee" ? [record] : records`) and are correctly rejected by
  multi-refusing commands like `rename` (which refuses one title on many bees).
  **Grafted refinement:** when a `tag`/`rel` selector resolves to *exactly one*
  bee, callers that take a single target may opt into treating it as singular —
  but the default, conservative behavior matches today's swarm/colony multi path
  (see §16 Q for the single-match ergonomics decision).
- **`formatSelector`** round-trips each kind to its canonical `ns:value` /
  `verb:target` string so saved views (NAVIGATION_PRD Tier 2) persist a stable
  selector.

## 9. tmux mirroring & queryability

One new session option mirrors the unified tag set for store-free, tmux-native
filtering — `@hive_*` options ARE the navigation API (NAVIGATION_PRD §10).

### 9.1 `@hive_tags`

A delimited string of the bee's **full effective tag set** (reserved-derived +
user), stamped at spawn and updated on any tag/membership change. Format is
**sentinel-wrapped** with a leading and trailing delimiter so word-boundary
matching works:

```
 colony:fe swarm:t1 quest:q-ab migration waiting-review
```

The leading/trailing space lets

```sh
tmux ls -f '#{m:* migration *,#{@hive_tags}}' -F '#{@hive_id}'
```

match `migration` exactly without substring false positives. **Verified on tmux
3.6a** (matching fork-and-pane's empirical bar): with `@hive_tags=' colony:fe
swarm:t1 migration waiting-review '`, the `#{m:* migration *,…}` filter matches
that bee but **not** `migration-foo`; `#{m:* colony:fe *,…}` matches it but **not**
a bee tagged `colony:fe2`; and `#{m:* review *,…}` matches a bare-`review` bee but
**not** one carrying `waiting-review`. Because the tag value grammar forbids
whitespace/comma (§6), the space delimiter is unambiguous and no value escaping
beyond `setUserOptions`' existing argv handling is needed.

### 9.2 Write path

Extend `writeSpawnOptions` (`src/hiveState.ts:72-89`) to add `@hive_tags:
renderTags(record)`, where `renderTags` composes from the *same* `effectiveTags`
derivation the selector uses (single source of derivation logic). Add a
`writeHiveTags(record)` helper paralleling `writeHiveState` / `writeHiveTitle`
(`src/hiveState.ts:47,61`), called from `hive tag`, `hive own`, `hive move`,
frame/quest/workspace membership changes — anywhere a reserved field or user tag
changes. All writes stay **best-effort** (try/catch swallow), so a missing session
never breaks the command, exactly like `@hive_state` today.

### 9.3 Session-scope caveat (grafted from fork-and-pane §12 Q4)

`@hive_*` options are **session-scoped**, but a multi-bee comb shares one session
(fork-and-pane §6.3/§12 Q4). A session can hold only **one** `@hive_tags` string,
so it cannot represent per-sub-bee tags. The honest invariant:

- **Solo combs** (`combId == tmuxTarget`, one bee): `@hive_tags` is authoritative-
  correct; the `tmux ls -f` fast path is exact.
- **Multi-bee combs** (>1 bee in the session): the `tmux ls -f` fast path is
  **skipped entirely** for that session and the query **falls back to the store
  scan**. Stamping "the primary bee's tags" would produce *silent false negatives*
  — a non-primary sub-bee tagged `migration` would be invisible to the tmux filter
  — and false positives for siblings, which a "confirm against the store" step
  catches only one-way. So v1 does not pretend: multi-bee combs are store-queried,
  period, until pane-scoped options land.

`hive list --tag` therefore unions the tmux fast path (solo sessions) with a store
scan (multi-bee sessions); it is always correct, and only the *speed* benefit is
solo-only. When pane-scoped options (`set -p @hive_tags`) land, per-pane mirroring
makes multi-bee combs fast too, with no selector change.

### 9.4 What is *not* tmux-mirrored

Relationship reverse-queries (`owns:` / `children-of:` / `forks-of:`) have **no
tmux fast path** — they are store O(n) scans by design (a pairwise, directional
fact has no faithful session-scoped form). v1 does **not** mirror relationships to
any `@hive_*` option (no `@hive_owner`); relationships are store-queried, full
stop. This is an honest scope line: membership and user tags are fully
tmux-queryable for solo sessions; the relationship half is always store-queryable.
(A read-only ownership chip in the switcher is possible later but is not v1 — it
would need a new mirrored option that earns its keep only once the switcher
itself, a NAVIGATION Tier 0 item, exists.)

## 10. Unification

This is the load-bearing claim: colony/swarm/quest/workspace membership,
parent-association, and fork/comb lineage are **not rebuilt on top of tags** — they
are *projected* into the one tag query path while their canonical storage stays
exactly where it is. Nothing breaks because nothing is rewired; the tag layer is
added *alongside* as the unifying read/query surface.

### 10.1 Membership (colony, swarm, quest, workspace, caste, node, comb)

Storage **unchanged**: these stay single-valued scalar fields written by
`spawn` / `spawn-frame` / `quest start` / `workspace add` exactly as the other
PRDs specify. The tags subsystem **never writes them** and **never copies them**
into `record.tags`. `RESERVED_NAMESPACES` getters *derive* `colony:fe`,
`swarm:t1`, `quest:q-ab`, `workspace:fe`, `comb:CO.x`, `caste:reviewer`,
`node:mac` on read. Consequences:

- **Rename cascade keeps working untouched.** `cascadeColonyRename`
  (`src/cli.ts`, the colony-rename path) rewrites `record.colony`; the derived
  `colony:` tag follows automatically — there is no tag store to also fix.
- **A bee can never carry two colonies** — the reserved namespace is single-valued
  by construction. This enforces NAVIGATION_PRD §13 Q1's "keep colony/swarm as
  well-known reserved facets" *at the type level*.
- **WORKSPACES_AND_QUESTS §16 Q7 is satisfied literally:** `questId` /
  `workspaceId` / `colony` membership *is* the tag value, stored canonically and
  surfaced through the unified namespace. **Zero new SessionRecord fields** are
  added for quest/workspace by this PRD; they light up automatically when those
  fields are populated by their own PRD (the getters are written in advance).

### 10.2 Parent-association (owned-by / reports-to)

hotkey-and-minor-features line 10's "parent association between bees (owned-by or
reports-to)" → `record.reportsToId` (operator-set, mutable). "Bees I own" =
`owns:<me>` selector = reverse scan. It is **not** a tag (direction matters; the
value is a bee, not a label), but the *query* flows through the unified resolver
as a `rel` kind. Optionally surfaced as a read-only `rel:reports-to:<id>` chip in
the switcher (§9.4).

### 10.3 Fork / comb lineage (fork-and-pane §5.1)

- `combId` is **membership** → derived tag `comb:<id>` (with the §12 Q3
  recommendation `combId == tmuxTarget` for solo bees, so every bee uniformly
  carries a `comb:` tag).
- `parentId` (intra-comb split) and `forkedFromId` (cross-comb fork) are **typed
  edges** → queried via `children-of:<bee>` / `forks-of:<bee>`.
- **Lineage immutability (fork-and-pane §7) is preserved** because tags never
  mutate these — `hive tag` only ever touches the user namespace; attempting
  `hive tag <bee> colony:x` or `parent:x` is rejected with *"reserved namespace;
  set via spawn/move/split, not tag."* `parentId` / `forkedFromId` are written
  *once* by `hive split` / `hive fork`, not by any tag verb.

### 10.4 Migration & back-compat

- **Zero-migration for reserved facets.** Because reserved tags are *derived on
  read*, every existing `~/.hive/sessions/*.json` bee instantly gains correct
  `colony:` / `swarm:` / `caste:` / `node:` tags with **no data rewrite, no
  backfill script, no half-migrated-record risk**. A bee written by today's binary
  loads, and its derived tag set is computed fresh each read.
- **New fields are additive & allow-list-gated.** `tags` (array, own validation
  branch + `KNOWN_SESSION_KEYS` entry) and `reportsToId` (string,
  `OPTIONAL_STRING_SESSION_KEYS`) are optional. Until they land in a given binary,
  any such field a newer binary writes rides through unchanged on an older binary
  via the unknown-key carry-through (`src/store.ts:299-305`), so forward/backward
  compat holds in both directions.
- **Old selector spellings preserved.** `colony:fe`, `@t1`, and bare bee names
  parse and resolve identically — they are now sugar lowering into the unified
  resolver, a strict superset. No command, keybinding, frame, or script breaks.
- **No dual-read divergence cliff.** Unlike a design that *copies* `colony` into a
  `colony:` tag and must dual-read both for a release, the derived-getter approach
  has **one** source for each reserved facet (the scalar field), so there is
  nothing to keep in sync and no deprecation cliff to forget.

### 10.5 Dependencies — what must exist first

This PRD's Phase 1 is **not** a pure add-on; it co-requires NAVIGATION_PRD Tier 0
plumbing that does **not** exist today and must land first (or as part of Phase 1).
The PRD does not treat any of these as already-built:

- **Faceted `cmdList`.** Today `cmdList` reads only `--colony` / `--swarm` /
  `--node` (`src/cli.ts:817-819`) with no positional selector. Phase 1 must add
  `--tag` / `--state` / `--agent` / `--repo` / `--json` and positional-selector
  support before T1/T4 can pass.
- **New stamped options.** `@hive_agent` and `@hive_repo` are **not** stamped today
  (`writeSpawnOptions` stamps only id/colony/swarm/title/pane/state,
  `src/hiveState.ts:72-89`). The `agent:` / `repo:` tmux facets need them added.
- **`@hive_state` faceted reader.** The `state:` facet reads a live state map; the
  single faceted `tmux ls -f` surface that produces it is itself a NAVIGATION_PRD
  Tier 0/1 deliverable, not existing behavior.

None of this is hard, but the conjunction filter and the live-state map are
**co-requisites with NAVIGATION_PRD Tier 0**, not infrastructure to build on.

## 11. Command surface

### `hive tag` (the tag verb)

```
hive tag <selector> <tag>...                 # add user-namespace tags
hive tag <selector> --remove <tag>...        # remove user tags (idempotent)
hive tag <selector> --list                   # show a bee's full effective tag set
```

- Bare `<tag>` ⇒ stored verbatim as a user tag; `<ns>:<val>` ⇒ that namespace
  (reserved → rejected; any other namespace → a power-user user tag).
- Reserved namespaces are **rejected** on add/remove with a redirect: *"`colony` is
  a reserved facet — set it via `hive spawn --colony` / `hive move`, not `hive
  tag`."*
- `<selector>` may be any selector (bee / `@swarm` / `colony:` / `tag:` / `rel:`),
  so you can bulk-tag a whole colony or a query result.
- Add is multi-bee aware (applies to all resolved records), reporting a count;
  piggybacks `updateSession` atomicity + a `tag.add` ledger event; refreshes
  `@hive_tags`.

### `hive own` and `hive move` (relationship + membership mutation — net-new, owned here)

Neither command exists today; this PRD **owns both** as the membership/relationship
mutation verbs (no other PRD defines `hive move`).

```
hive own <owner-selector> <bee-selector>...  # set reportsToId on each bee → owner
hive own <bee-selector> --clear              # clear ownership
hive move <bee> --colony <c>                 # reassign a bee's colony (reserved facet)
hive move <bee> --owner <o>                  # alias for `hive own` on one bee
```

`hive own` sets `record.reportsToId` (the owned-by / reports-to edge) and emits
`rel.set` / `rel.clear`. `hive move --colony` rewrites the canonical `record.colony`
field (the derived `colony:` tag follows on read) — it is the verb the reserved-
namespace rejection message redirects to. Lineage edges (`parentId` /
`forkedFromId`) are **not** settable by either — they are written once by
`hive split` / `hive fork`.

### `hive list` (extended — conjunctive facet filter)

```
hive list [--tag <ns:val>]... [--state <s>] [--colony <c>] [--swarm <s>]
          [--agent <a>] [--repo <path>] [--node <n>] [--json]
          [owns:<bee> | children-of:<bee> | forks-of:<bee> | #<tag>]
```

`--tag` repeats conjunctively and composes with every other facet flag; a
relationship/tag selector can also be passed positionally as a filter.

### `hive view` (extended)

```
hive view --tag <ns:val> | hive view children-of:<bee> | hive view owns:<bee>
```

Views become live tag/relationship queries (NAVIGATION_PRD Tier 2); re-running
re-materializes without duplicating windows.

### Implicit writers

`spawn-frame` sets `caste:` (via `record.caste`); `split` sets `parentId` +
shared `combId`; `fork` sets `forkedFromId`; `quest start` / `workspace add` set
`questId` / `workspaceId`. Each refreshes `@hive_tags` best-effort. The tags
subsystem adds the *query* surface for all of them, not the write.

## 12. Reuse map (implementation anchors)

- **Record type & allow-list:** `SessionRecord` (`src/store.ts:7-54`);
  `OPTIONAL_STRING_SESSION_KEYS` (`src/store.ts:248`) — append `reportsToId`;
  `KNOWN_SESSION_KEYS` (`src/store.ts:250`) — add `tags`.
- **Array-field validation precedent:** the `buzAccept` branch
  (`src/store.ts:291-297`) — copy its shape for the `tags` validation block in
  `normalizeSessionRecord` (`src/store.ts:257-308`), adding reserved-namespace
  rejection.
- **Forward/back-compat:** unknown-key carry-through (`src/store.ts:299-305`).
- **Atomic tag writes:** `updateSession` / `mergeSessionFields` under the
  per-session lock (`src/store.ts:136-162`); heartbeat/touch path
  (`src/store.ts:123`).
- **Ledger:** `appendLedger` (`src/store.ts:217-223`); session compaction
  (`src/store.ts:92-104`) — optionally add `tags`.
- **Selectors:** `Selector` / `ResolvedTarget` union (`src/selectors.ts:6-14`);
  `parseSelector` (`src/selectors.ts:25-39`); `resolveSelectorFromState`
  (`src/selectors.ts:41-68`), reuse the bee resolver's ambiguity throw
  (`src/selectors.ts:63-65`) for relationship-anchor resolution;
  `isSelectorMulti` (`src/selectors.ts:70-72`); `formatSelector`
  (`src/selectors.ts:74-83`); the `listSessions()`-backed resolve
  (`src/selectors.ts:85-99`).
- **tmux mirroring:** `writeSpawnOptions` (`src/hiveState.ts:72-89`),
  `writeHiveState` / `writeHiveTitle` (`src/hiveState.ts:47,61`) — pattern for a
  new `writeHiveTags`; `setUserOptions` + `listSessionStates`
  (`src/substrates/local-tmux.ts:165-196`, ssh mirror `:171-196`).
- **New module:** `src/tags.ts` — `effectiveTags(record)`, `RESERVED_NAMESPACES`
  getters, `renderTags(record)`, `parseTag`, reserved-rejection guard, the
  `hive tag` / `hive own` command bodies.

## 13. Safety / defaults

- **Best-effort tmux, always.** Every `@hive_tags` write is wrapped in try/catch
  (the `@hive_state` discipline); a missing session never breaks `hive tag`.
  Filtering falls back to the store scan when the mirror is stale.
- **Validation never fatal.** A grammar-invalid or reserved-namespace tag in a
  record is *dropped on load*, not thrown (the `buzAccept` forward-compat
  precedent) — a hand-edited file can't crash a load.
- **Reserved namespaces are protected at two layers:** parse-time rejection in
  `hive tag`, and persist-time rejection in `normalizeSessionRecord` (so a
  smuggled `colony:x` in `tags` is stripped on load).
- **Caps with surfaced truncation.** `tags` is capped (32 tags × 64 chars); over
  the cap, excess is dropped and the count surfaced, never silently truncated.
  `@hive_tags` is a single option string; if the effective set would exceed a
  readable option budget, the mirror truncates (store stays complete) and the
  switcher confirms against the store.
- **`repo` / `state` reserved getters are specified, not hand-waved (grafted
  fix):** `repo:` derives via `repoTagFor(cwd)` = the git-toplevel basename when
  inside a repo, else the cwd basename; collisions (two repos sharing a basename)
  are accepted as a known lossy facet and documented. `state:` is **not** computed
  in the store-only filter path — it is read from the `@hive_state` map that the
  navigation surface fetches (NAVIGATION_PRD §10 — a contract that surface MUST
  provide; the single faceted `tmux ls -f` reader is not built today). So
  `effectiveTags` never triggers a per-bee tmux round-trip; `state:` is a
  tmux-facet tag, surfaced only where the state map is already in hand, never as a
  store-only filter.
- **Relationships are reference-only.** Clearing `reportsToId` never kills a bee;
  there is no cascade. Lineage edges (`parentId` / `forkedFromId`) are write-once
  and survive kill as history (fork-and-pane §7).
- **Nothing on the spawn-critical path.** Every tags/relationships behavior is
  removable; a failed mirror or rejected tag degrades to the store, never blocks
  spawn/wait/seal.

## 14. Phasing

Each phase ships independently and is useful alone; order matches the dependent
PRDs.

- **Phase 1 — Tags (NAVIGATION_PRD §7 / §13 Q1).** `tags?: string[]` field +
  validation branch + `effectiveTags` derivation + `RESERVED_NAMESPACES` getters
  for the facets that already have fields (colony/swarm/caste/node/agent/repo/
  comb) + `hive tag` CLI + `tag:` / `#` selector + `hive list --tag` +
  `@hive_tags` mirror. Reserved namespaces work day one with no other PRD landed;
  delivers the multi-valued-tags ask end to end with zero migration.
- **Phase 2 — Relationships (hotkey-and-minor-features line 10).** `reportsToId`
  field + `hive own` / `hive move --owner` + `owns:` / `reports-to:` selectors.
  `parentId` / `forkedFromId` reverse selectors (`children-of:` / `forks-of:`)
  light up as those fields land from fork-and-pane (which *writes* them).
- **Phase 3 — Quest/workspace facets (WORKSPACES_AND_QUESTS §16 Q7).** The
  `quest:` / `workspace:` reserved getters are already written; they light up
  automatically when `questId` / `workspaceId` start being populated by that PRD.
  No tags work needed at that point — it just plugs in.
- **Phase 4 — Optional index (scale).** Only on measured need (>1000-bee
  `hive list --tag` profiling slow): an inverted `~/.hive/tags/index.json` as a
  rebuildable derived cache under `.tags.lock`, invalidated by ledger replay,
  never a source of truth (records always win). A boolean `and`/`or`/`not`
  Selector node (§16) can land here too.

## 15. Acceptance criteria

- **T1** `hive tag CL.x migration prio:p1` adds `migration` + `prio:p1` (stored
  verbatim, no `t:` prefix); `hive list --tag migration` and `hive list --tag
  prio:p1` each return CL.x; `hive tag CL.x --remove migration` drops it.
- **T2** `hive tag CL.x colony:other` is **rejected** with a redirect to `hive
  move`; CL.x's colony is unchanged.
- **T3** A bee created by the *previous* binary, with `record.colony = "fe"` and
  no `tags` field, is returned by `hive list --tag colony:fe` and `colony:fe`
  with **no migration step** — the reserved tag is derived on read.
- **T4** `hive list --tag migration --state waiting --colony fe --json` returns
  exactly the conjunction, usable by an orchestration bee.
- **T5** `tmux ls -f '#{m:* migration *,#{@hive_tags}}' -F '#{@hive_id}'` lists
  exactly the `migration`-tagged **solo** bees with no store read, matching
  `migration` without false-matching `migration-foo` (verified on tmux 3.6a, §9.1);
  multi-bee combs are excluded from the fast path and answered by the store scan.
- **T6** `colony:fe`, `@t1`, and a bare bee name resolve to the *same* record sets
  as before this PRD — no existing selector, frame, or keybinding breaks.
- **R1** `hive own me CL.a CL.b` sets `reportsToId` on both; `hive list owns:me`
  returns exactly CL.a and CL.b.
- **R2** `hive split` sets `parentId`; `hive list children-of:<parent>` returns
  the sub-bee. `hive fork` sets `forkedFromId`; `hive list forks-of:<src>` returns
  the fork. Neither is mutable via `hive tag`.
- **R3** Clearing `reportsToId` (`hive move CL.a --owner ''`) removes CL.a from
  `owns:me` and never kills CL.a.
- **S1** A grammar-invalid or reserved tag in a hand-edited record is dropped on
  load; the record still loads.

## 16. Open questions

1. **Single-match ergonomics for `tag`/`rel` selectors.** `isSelectorMulti`
   returns `true` for them, so a command that refuses multi-target (e.g. `rename`
   setting one title) rejects a `tag:`/`owns:` selector *even when it matches
   exactly one bee* — a small regression vs the bee path that resolves a lone
   match to a single target. *Recommendation: keep multi-by-default for safety;
   add an opt-in `--one` (or auto-singularize when exactly one match) for commands
   that can sensibly take a single resolved bee.*
2. **Boolean composition.** Conjunctive flags cover the headline asks, but
   "waiting OR blocked claude bees" needs an `and`/`or`/`not` Selector node and a
   small infix parser. *Recommendation: defer to Phase 4; ship conjunctive flags
   first.*
3. **Tag governance at scale.** Free-form user tags invite inconsistency
   (`migration` vs `migrations` vs `migrate`). *Recommendation: defer a `hive tag
   --list-all` / `hive tag rename <old> <new>` registry tool until fleets show the
   need; v1 relies on the grammar + reserved-set guard.*
4. **Multi-owner relationships.** v1 stores one `reportsToId` per bee (a bee
   reports to one owner). If "a bee reports to several owners" becomes a real ask,
   it graduates to an edge list (the runner-up `edges.jsonl` model) — a clean
   forward path, since the *query* grammar (`owns:`) is unchanged. *Recommendation:
   single owner in v1; revisit if many-to-many is requested.*
5. **`@hive_tags` length budget.** A bee with many reserved + user tags could
   approach a readable option-value / `list-sessions` parse limit. *Recommendation:
   measure; truncate the mirror with store-confirm fallback (§13) if it bites.*
6. **`state:` as a tag.** Modeling live state as a reserved tag is elegant for the
   switcher but `@hive_state` is the canonical liveness source. *Recommendation:
   expose `state:` only where the state map is already fetched (§13), never as a
   store-only filter, to avoid a per-bee tmux round-trip.*
7. **Dangling-edge cleanup.** v1 tolerates `reportsToId` / `parentId` /
   `forkedFromId` pointing at a killed bee — reverse queries match by raw id, with
   no cascade and no edge table to sweep (§8.2, §13). If dangling edges become
   noise at fleet scale, a sweep (or the deferred Phase 4 index) can prune them.
   *Recommendation: tolerate in v1; revisit with the Phase 4 index.*

## 17. Out of scope (future work)

- A persisted `~/.hive/tags/` or `~/.hive/relationships/` registry / edge table
  (deferred to Phase 4 as a rebuildable cache only).
- Many-to-many directed relationships / a general graph store (the runner-up
  `unified-edges-graph` model) — a clean upgrade path exists but is unjustified for
  the v1 mandate.
- Boolean infix selector composition with parentheses.
- Per-pane `@hive_tags` (`set -p`) for multi-bee combs — lands with pane-scoped
  options; v1 mirrors the comb's primary bee.
- Tag rename/merge tooling, per-colony allowed-tag policy, and ML tag suggestion.
- Cross-machine tag aggregation beyond what `hive list` already does across nodes.
