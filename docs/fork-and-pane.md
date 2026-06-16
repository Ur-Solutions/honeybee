# honeybee Fork & Pane-Identity PRD

## 1. Summary

This PRD covers three intertwined pieces of new functionality on the
`fork-and-pane-ux` branch:

1. **`hive fork <bee> [checkpoint]`** — branch an existing bee into a *fresh*
   substrate instance (new pane/session, optionally a different model, harness,
   or node), seeded from the source bee's state.
2. **Combs & sub-bees** — drop the implicit *"1 tmux session = 1 bee"* rule and
   replace it with *"1 pane = 1 bee."* A tmux session becomes a **comb** that can
   hold several adjacent, independently-addressable bees, and you can spin a new
   **sub-bee** into the session you are already in, in place.
3. **In-tmux UX** — `hive here` (the bee owning the current pane) plus installable
   tmux keybindings that run `hive spawn` / `fork` / `split` through
   `display-popup`, so you never have to detach to branch or grow a swarm.

The unifying mechanism is **pane pinning**: every bee records the tmux **pane id**
it actually runs in (`agentPaneId`), and all agent I/O targets that pane instead
of "whatever pane is currently active." Pane pinning is the root fix for the
current model's silent-wrong-pane bugs (§3), the foundation combs are built on,
and the enabling primitive for the long-deferred `embed`/`eject` work — without
adopting that whole model now.

## 2. Background — the current model (verified)

Today a bee **is a detached tmux session**, and every read/write hive performs
targets `=name:` — the **active pane of the active window** of that session
(`src/substrates/local-tmux.ts:66-87`). There is **no pane id or window id stored
anywhere** (`src/store.ts:7-47`), and there is **zero `list-panes`/`list-windows`
usage for bee I/O** — `view.ts` lists windows only for presentation. Liveness is
`hasSession(tmuxTarget)` (`src/substrates/local-tmux.ts:49-52`) — it checks the
**session**, never the pane.

The proven seed/brief pattern already exists and `fork`/`split` will reuse it
verbatim: `waitForAgentReady → sendText → writeHiveState → updateSession`
(`deliverBrief`, `src/cli.ts:669-696`; loop fresh-carrier, `src/loop/flow.ts:188-239`).

`fork` is named but unimplemented; the spec defers it pending "stable transcript
export" (`HONEYBEE_V2_SPEC.md §13`), and `embed`/`eject` pane-identity is "future
work" (`NAVIGATION_PRD.md §4, §14`). This PRD implements a pragmatic subset of
both that does not contradict either roadmap.

## 3. Problems being solved

These are the answers to the four motivating questions, each a concrete current
behavior we are fixing.

| # | Scenario | Today | Root cause |
|---|---|---|---|
| a | You **split** a bee's window / add a pane | hive silently follows whichever pane is **active**; `capture`, `hive send`, and readiness all hit the wrong pane | I/O targets `=name:` (active pane), `src/state.ts:69`, `src/readiness.ts:42` |
| b | You add a **window** to a bee's session | window is invisible to state/IO until it becomes active, then hijacks I/O like (a); `view` links only the active window (`view.ts:105`); `kill` takes the whole session | no per-bee window/pane tracking |
| c | You **delete the agent pane** but the session survives (other panes/windows exist) | hive still reports the bee **alive** and starts reading/writing whatever pane is now active | liveness = `hasSession`, never the pane |
| d | You want to **spawn/fork from inside tmux / inside a bee** | partial: `--here` links a new bee's window into your session (`cli.ts:292-314`), but the spawn runs in your shell (not "inside a bee"), there are **no keybindings/`display-popup`**, and **no `$TMUX_PANE`→bee** reverse index, so a bee can't fork *itself* in place | no pane identity, no in-tmux affordance |

All four collapse to: **hive does not know which pane a bee owns.** Pane pinning
fixes a/b/c directly and makes d (and combs, and fork-in-place) possible.

## 4. Core concepts & vocabulary

- **Bee** — unchanged as an identity: `id`/`uuid` + record + lifecycle. New
  invariant: a bee owns **exactly one pane** (`agentPaneId`).
- **Comb** — a tmux session that hosts one *or more* bees (one per pane). A solo
  bee is just a comb of size 1 (no behavior change for existing bees). The comb
  is identified by the tmux session name (today's `tmuxTarget`).
- **Sub-bee** — a bee spawned *into an existing comb* (an adjacent pane in the
  same session), carrying `parentId` (who it budded from) and the shared
  `combId`. Naming of this concept is an open decision (§12, Q1); the doc uses
  "sub-bee" + the verb **`hive split`** as working names.
- **Fork** — a *new* bee in a *fresh* comb (its own session, possibly a different
  node/model/harness), seeded from a source bee's state and carrying
  `forkedFromId` lineage. Fork is cross-session; split is intra-session.
- **Pane pinning** — recording `agentPaneId` and targeting it for all agent I/O.

The distinction in one line: **`split` grows a comb (siblings share a window);
`fork` branches a lineage (a new comb elsewhere).**

## 5. Data model changes

### 5.1 `SessionRecord` (additive, `src/store.ts:7-47`)

```ts
// Pane identity (Phase A) — pins the bee to its actual pane.
agentPaneId?: string;   // tmux pane id, e.g. "%7" (server-unique; survives window moves)

// Comb / sub-bee lineage (Phase B)
combId?: string;        // the comb (tmux session) this bee shares; for a solo bee, == tmuxTarget
parentId?: string;      // the bee this one was split from (intra-comb), if any

// Fork lineage (Phase C)
forkedFromId?: string;  // source bee id
forkedAt?: string;      // ISO timestamp
seedMode?: "resume" | "seal" | "summary" | "log" | "none";
forkCheckpoint?: string;// e.g. "seal:2026-06-14T10:30:00Z" | "resume:<providerSessionId>" | "log:<path>"

// First-class model (Phase C) — independent of the frozen `command` string
model?: string;         // e.g. "sonnet", "opus", "grok-code-fast-1"
```

Each new **string** field must also be appended to `OPTIONAL_STRING_SESSION_KEYS`
(`src/store.ts:241`) — the deserializer's allow-list — or it is written to disk but
silently dropped on the next load.

**Key consequence:** `tmuxTarget` stops being unique per bee — sub-bees in one
comb share a `tmuxTarget` (session) but differ by `agentPaneId`. The unique key
remains `name`/`id`. Every call site that assumed "session ⇒ one bee" must key on
`(tmuxTarget, agentPaneId)` for I/O and on `name`/`id` for identity. Legacy
records (no `agentPaneId`) keep today's active-pane behavior — pinning is
back-compatible and best-effort.

### 5.2 Ledger events (`appendLedger`, `src/store.ts:210`; compaction `src/store.ts:85-97`)

- `fork.create` — `{ name, forkedFromId, seedMode, forkCheckpoint?, model?, node? }`
- `bee.split` — `{ name, parentId, combId, agentPaneId }`

### 5.3 New tmux user option

- `@hive_pane` — the bee's `agentPaneId`, stamped alongside the existing
  `@hive_*` options so reverse lookup and reconciliation can read it without the
  store. (Note: `@hive_*` are **session**-scoped options; in a multi-bee comb the
  per-bee identity lives on the *pane* — see §6.3.)

## 6. Substrate contract changes (`src/substrates/types.ts`)

The substrate is the single seam. Both `local-tmux` and `ssh-tmux` implement
every change; `view.ts`/`attach.ts` are unaffected. (The tmux mechanics below —
pane-id targeting `-t %id`, `split-window -P -F '#{pane_id}'`, `kill-pane` leaving
the session alive, `list-panes -a` — were empirically verified on tmux 3.6a.)

### 6.1 Pane-aware I/O (Phase A)

Pane-scoped methods gain an optional pane id. When present, target the
server-unique pane (`%7`) directly; when absent, fall back to `=${target}:`
(today's behavior) so legacy bees keep working.

```ts
capture(target: string, lines?: number, paneId?: string): Promise<string>;
sendText(target: string, text: string, paneId?: string): Promise<void>;
sendEnter(target: string, paneId?: string): Promise<void>;
sendKey(target: string, key: string, paneId?: string): Promise<void>;
```

Internal helper (both substrates):

```ts
// pane id is globally unique on a tmux server, so `-t %7` is exact on its own;
// the `=name:` form stays the fallback for unpinned (legacy) bees.
const paneArg = (session: string, paneId?: string) => (paneId ? paneId : `=${session}:`);
```

Session/window-scoped methods (`kill`, `hasSession`, `setUserOptions`,
`renameWindow`) are **unchanged** — they legitimately address the session/window.

### 6.2 Capture the pinned pane at spawn (Phase A)

`newSession` returns the id of the pane it created so spawn can pin it:

```ts
newSession(target, cwd, spec): Promise<{ paneId: string }>;
// local-tmux: after `new-session -d`, read `tmux list-panes -t =name: -F '#{pane_id}'`
//             (or `new-session ... -P -F '#{pane_id}'`).
```

`spawnBee` stores the returned `paneId` as `agentPaneId` and stamps `@hive_pane`.

### 6.3 Comb / sub-bee primitives (Phase B)

```ts
// Create an adjacent pane in an existing comb and launch `spec` in it.
newPane(target, cwd, spec, opts?: { dir?: "h" | "v" | "window" }): Promise<{ paneId: string }>;
//   local-tmux: `tmux split-window -t =name: -d -P -F '#{pane_id}' -c cwd <launcher>`
//   dir:"window" => `new-window` instead (a sub-bee in its own window of the comb)

// Kill just this bee's pane without taking the whole comb.
killPane(paneId): Promise<KillResult>;   // `tmux kill-pane -t %id`

// Liveness for pinned panes: one call, all panes on the server.
listPanes(): Promise<Set<string>>;       // `tmux list-panes -a -F '#{pane_id}'`
```

### 6.4 Liveness via pane (Phase A/B)

`StateContext` (`src/state.ts:18-29`) gains `livePanes?: Set<string>`. `deriveState`:

- A bee **with** `agentPaneId`: **dead** iff `agentPaneId ∉ livePanes` — even when
  the comb session is still alive. This is the fix for problem (c).
- A bee **without** `agentPaneId` (legacy): fall back to today's
  `liveTargets`/`hasSession` logic.

**Two distinct maps.** Liveness uses the new `livePanes` set (server-wide pane
ids). Readiness/state *content* uses the existing `panes` map (`src/state.ts:25`),
keyed today by `tmuxTarget` and read via `record.tmuxTarget` (`src/state.ts:69`).
Because sub-bees in one comb **share `tmuxTarget`**, that map must be re-keyed to
`agentPaneId ?? tmuxTarget` (and `deriveState`'s lookup updated to match) —
otherwise the second sub-bee's capture overwrites the first and its readiness/state
break. This re-keying is part of Phase A/B work.

## 7. Command surface

### 7.1 `hive fork` (Phase C)

```
hive fork <bee> [checkpoint]
          [--agent <kind>] [--model <m>]      # fork into a different harness/model
          [--node <n>] [--cwd <dir>]
          [--seed resume|seal|summary|log|none]
          [--read-log] [--name <n>] [--account <a>] [--here] [--print]
```

- **`<bee>`** resolves via `selectors.resolveSelector` (reuse).
- **`[checkpoint]`** selects the seed anchor: a **seal** (default: latest;
  `seal:<ISO>` for a specific one) or `msg:N` (transcript offset — deferred, see
  §11). Seals are the only durable structured snapshots
  (`src/seal.ts:138-148`).
- **Layered seeding (chosen default)** — best fidelity available, in order:
  1. `--seed resume` **and** same harness **and** known `providerSessionId` →
     spawn with native resume args (`src/swap.ts:113-118`: `claude --resume <id>`,
     `codex resume <id>`, `opencode --session <id>`). Exact continuation.
  2. else **latest seal** → brief: *"You are a fork of `<bee>`. State: `<seal.summary>`;
     files changed: …; next: …. Continue from here."*
  3. else **generated summary** → a new standalone `summarizeTranscript(record)`
     that Phase C must **add** (spawn a summarizer bee over the source transcript,
     no loop state). Note: `src/loop/summarizer.ts` is reused for *prompt-shaping
     patterns only* — there is no standalone "summarize a bee" API today
     (`summarize` elsewhere is unrelated account-usage code). If there is no seal
     and no summarizer yet, fork falls through to `--read-log` (§12 Q5).
  - `--read-log` overrides: don't inline anything; brief = *"Read the log at
    `<transcriptPath>` and continue."* (local only; cheapest/most robust).
- **Cross-harness/model** (`--agent codex`, `--model opus`): native resume is
  same-harness-only, so cross-harness forks **must** use seal/summary/log seeding.
  Adds the first-class `model` field.
- **Identity & lineage:** new `allocateBeeIdentity`; record `forkedFromId`,
  `forkedAt`, `seedMode`, `forkCheckpoint`, `model`; emit `fork.create`.
- **Account safety (critical):** never share a live home — Anthropic rotates
  refresh tokens and two bees on one home log each other out
  (`src/accounts.ts:389-399`, `src/swap.ts:60-86`). Default: the fork gets its own
  home (copy of the parent's for creds/config, may be stale → warn) or a distinct
  `--account`. `--seed resume` on the same account is flagged as a concurrency
  hazard.
- **Anti-cross-match:** give the fork a *distinct* `providerSessionId` and a
  `lastPromptAt` set at creation. This leverages the **existing** scoring — no new
  matcher logic — so the daemon can't assign the parent's transcript to the fork:
  `scoreTranscript` adds `SCORE.since` for `mtime ≥ sinceIso−5s` (where
  `sinceIso = lastPromptAt ?? createdAt`) and `SCORE.sessionId` on id match
  (`src/sessionMetadata.ts`, `src/transcripts.ts:430-457`).

### 7.2 `hive split` (Phase B) — the "decompose into sub-bees" verb

```
hive split [<bee>] [<agent>] [--brief <text>] [--dir v|h|window] [--cwd <dir>] [--model <m>]
```

- No `<bee>` (or `--here`) → split **the current bee's comb** (uses `hive here`).
- Creates an adjacent pane via `substrate.newPane`, launches `<agent>` (defaults to
  the parent's agent), registers a **new bee record** with `parentId`, shared
  `combId`/`tmuxTarget`, its own `agentPaneId`; seeds via `deliverBrief`.
- The sub-bee is a full first-class bee (`hive list`, `tail`, `kill`, `fork` all
  work on it). It shares the comb's home/account by default (same session, same
  human).
- "Automatic attachment/registration handling": because hive creates the pane, it
  knows the new pane id immediately — no `$TMUX_PANE` round-trip needed for
  registration; reconciliation sees it via `listPanes`.

**Implementation note:** `split` does **not** go through `spawnBee`'s
`newSession` + `hasSession(tmuxTarget)` guard (`src/cli.ts:362`) — that guard
rejects a second bee on an existing session and would block sub-bees. It calls
`substrate.newPane` on the comb and saves a record with the *shared* `tmuxTarget`
plus a fresh `agentPaneId`. Reconciliation/clean must therefore enumerate panes per
comb (`listPanes`), not assume one bee per session.

### 7.3 `hive here` (Phase B/D)

```
hive here [--id] [--json]
```

- Resolves the bee owning the current pane: read `$TMUX_PANE` → match `agentPaneId`;
  fallback to current session (`$TMUX` → `display -p '#{session_name}'`) → bee with
  that `tmuxTarget` (solo combs). Enables fork/split-in-place and keybindings.

### 7.4 `hive kill` (Phase B, comb-aware)

- `hive kill <bee>` → `killPane(agentPaneId)` when the bee shares a comb with live
  siblings; `kill` (whole session) when it is the sole/last bee in the comb.
- `hive kill <comb>` / `--comb` → kill the entire session (all sub-bees), with the
  existing transactional discipline (`src/kill.ts`).

### 7.5 Keybindings (Phase D)

Ship `docs/honeybee.tmux.conf` (and `hive keys install` to append it), e.g.:

```tmux
bind-key b display-popup -E "hive spawn-picker --here"          # spawn a new bee here
bind-key s display-popup -E "hive split --here"                 # decompose: add a sub-bee
bind-key f display-popup -E "hive fork \"$(hive here --id)\" --here"  # fork the current bee
```

`display-popup -E` runs with the pane's env, so `$TMUX_PANE` is set and `hive here`
resolves correctly from inside the popup. These bindings target **local-tmux**;
under `ssh-tmux` the popup runs in the *remote* shell, so cross-substrate
keybindings are deferred.

## 8. Safety & operating defaults

- **Back-compat:** unpinned legacy bees keep today's active-pane behavior; pinning
  is additive and best-effort (a failed `@hive_pane` write never breaks spawn).
- **No shared live home** across fork/parent (OAuth rotation hazard, §7.1).
- **Comb kill never surprises:** killing one sub-bee never kills siblings; killing
  the comb is explicit.
- **Crash-safety / idempotency:** record + ledger already write together inside the
  session lock (`src/store.ts:76-80`). The real gaps are that `allocateBeeIdentity`
  runs under a *separate* id-index lock *before* the session is saved
  (`src/ids.ts:34-41`, non-idempotent), and that a partial failure can orphan a
  pane/session. Fix: allocate identity inside the session lock and clean up orphans
  on failure.
- **SSH limits surfaced:** seeding a large summary over `ssh-tmux` uses
  `load-buffer` but has an 8s op timeout and accounts are local-only
  (`src/substrates/ssh-tmux.ts`); fork warns when seeding a remote node with a
  transcript/account it cannot carry.

## 9. What we are explicitly NOT doing

- **Full `embed`/`eject`** (one bee owning/sharing many panes; pane↔bee
  re-parenting). The comb model keeps the simpler 1-pane-1-bee invariant. Pane
  pinning leaves `embed`/`eject` strictly easier later.
- **Message-offset replay** (`fork --at msg:N`) as a first-class durable
  checkpoint — deferred until transcript export is stable (`HONEYBEE_V2_SPEC.md
  §13`). `[checkpoint]` means a seal for now.
- **Generic restore checkpoints** (the reserved `flows/.../checkpoints/` dir stays
  unwritten).

## 10. Phasing

Each phase ships independently and is useful alone. Order chosen so the
foundation (pane identity) lands first and unblocks the rest.

- **Phase A — Pane pinning + pane liveness.** Substrate paneId threading,
  `agentPaneId` at spawn, `@hive_pane`, `livePanes` in state derivation. *No new
  commands.* Fixes problems (a), (b), (c). Highest leverage, lowest surface.
- **Phase B — Combs & sub-bees.** `newPane`/`killPane`/`listPanes`, `hive split`,
  `hive here`, comb-aware `hive kill`. Answers (d) and the decompose ask.
- **Phase C — `hive fork`.** Schema lineage + `model` field, layered seeding,
  account safety, anti-cross-match, `fork.create` ledger.
- **Phase D — In-tmux keybindings.** `display-popup` config + `hive keys install`,
  `hive spawn-picker`.

## 11. Acceptance criteria

- **A1** Split a bee's window and switch panes: `hive send`, `tail`, and state
  detection still hit the **agent** pane, not the focused one.
- **A2** Kill the agent pane while the comb session survives: `hive list` shows the
  bee **dead** within one daemon tick.
- **B1** From inside a bee, `hive split codex` opens an adjacent pane running codex,
  registered as a new bee with `parentId` set; `hive list` shows both sharing one
  comb.
- **B2** `hive here --id` inside any bee pane prints that bee's id.
- **B3** `hive kill <sub-bee>` removes only its pane; siblings keep running.
- **C1** `hive fork CL.x` (same harness, known session id) resumes exactly via
  native resume; `hive fork CL.x --agent codex` seeds codex from the latest seal.
- **C2** A forked bee in the same cwd as its parent is never assigned the parent's
  transcript by the daemon.
- **C3** Fork never logs out the parent's account (own home / distinct account).
- **D1** `prefix+f` inside a bee forks it into a popup-launched, here-linked bee
  without detaching.

## 12. Open questions / decisions needed

1. **Name for sub-bees / the decompose concept** (you flagged this). Working names
   in the doc are *sub-bee* + verb *`hive split`*. Candidates:
   - **comb** (session) + **`hive split`** (verb) + members stay plain *bees* with
     `parentId` — minimal new vocabulary. *(doc default)*
   - **comb** + **`hive bud`** (a bee *buds* an adjacent sibling) + offspring =
     the parent's **brood**. More on-metaphor.
   - **cell** for each pane-bee (the comb is wax cells) + **`hive divide`**.
2. **Do sub-bees share the comb owner's account/home?** Default proposed: yes (same
   session/human). Confirm vs. per-sub-bee identity.
3. **Solo-bee `combId`:** *Recommend* `combId == tmuxTarget` for every bee from
   creation (uniform queries; matches the §5.1 schema note), rather than leaving it
   undefined until a second bee joins.
4. **`@hive_*` are session-scoped** but per-bee identity in a comb is per-pane.
   Either move per-bee facets to pane options (`set -p`) for multi-bee combs, or
   keep the store as source of truth for in-comb membership. Recommend: store is
   truth for membership; `@hive_pane`/`@hive_id` still stamped for the comb's
   primary bee.
5. **Fork default when no seal and no session id exists** (never-sealed,
   never-prompted source): fall through to `--read-log` (point at cwd) or refuse
   with a clear message? Recommend: summarize the pane if non-trivial, else refuse.

## 13. Reuse map (implementation anchors)

- Seeding: `deliverBrief` (`src/cli.ts:669-696`), loop fresh-carrier
  (`src/loop/flow.ts:188-239`).
- Spawn pipeline: `spawnBee` (`src/cli.ts:342-392`), `writeSpawnOptions`
  (`src/hiveState.ts:71-88`).
- Selectors: `src/selectors.ts`. Native resume: `src/swap.ts:113-118`.
- Seals: `src/seal.ts:138-148`. Summarizer: `src/loop/summarizer.ts`.
- Substrate I/O to make pane-aware: `src/substrates/local-tmux.ts:66-87`
  (+ ssh mirror), interface `src/substrates/types.ts:20-50`.
- State/liveness: `src/state.ts:18-29, 45-105`; `--here`: `src/cli.ts:292-314`,
  `src/view.ts:125-145`; in-tmux detection: `process.env.TMUX` / `$TMUX_PANE`.
</content>
</invoke>
