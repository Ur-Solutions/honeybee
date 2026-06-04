# Honeybee v2 — Phase 1 Test Checklist

Walk through this end-to-end to exercise everything that landed in Phase 1. Each section can be done in isolation.

## 0. Setup

- [ ] `npm run build` succeeds
- [ ] `npm test` shows 112/112 passing
- [ ] Reload shell completion: `eval "$(hive completion zsh)"` (or `bash`/`fish`)

## 1. Colonies

- [x] `hive colony create review --description "deep code review namespace"`
- [x] `hive colony list` shows `review` plus any existing colonies
- [x] `hive colony inspect honeybee` prints the JSON record
- [x] `hive colony create review` again — fails with `already exists`
- [x] `hive colony create ../escape` — fails with `Invalid colony name`

## 2. Frames

Save this as `/tmp/deep-review.json`:

```json
{
  "name": "deep-review",
  "description": "Multi-role code review",
  "castes": [
    { "name": "architect", "bee": "claude", "count": 1, "brief": "Read architecture. Wait for assigned files." },
    { "name": "reviewer",  "bee": "codex",  "count": 2, "brief": "Walk the code. Wait for assigned files." },
    { "name": "oddball",   "bee": "grok",   "count": 1, "brief": "Look for strange high-upside ideas. Wait." }
  ]
}
```

- [x] `hive frame define /tmp/deep-review.json`
- [x] `hive frame list` shows `deep-review · 3 castes · 4 bees`
- [x] `hive frame inspect deep-review` round-trips the JSON
- [ ] `hive frame define /tmp/deep-review.json house-review` defines it under a different name
- [ ] `hive frame remove house-review` succeeds; `hive frame remove house-review` again fails

## 3. Swarms

### Homogeneous swarm

- [ ] `hive spawn codex --count 3 --colony honeybee` spawns 3 bees + one swarm record
- [ ] `hive swarm list` shows the new `@<id>` with 3 bees, colony honeybee
- [ ] `hive swarm inspect @<id>` prints the JSON record

### Frame-based swarm (briefed)

- [x] `hive spawn --frame deep-review --colony review --briefed`
- [x] Watch the per-bee `spawn` lines — each shows `caste:<name>` and `@<swarm-id>`
- [x] After each spawn, the brief is delivered (you'll see `brief · <name> · N chars`)
- [x] `hive list --colony review` shows all bees with state `ready · briefed, awaiting prompt`

## 4. Broadcast send

- [ ] `hive send colony:honeybee "what file are you in right now?"` reaches every live bee in the colony
- [ ] Trailing summary line shows `sent · colony:honeybee · N/M bees`
- [ ] `hive send @<swarm-id> "stop and report status"` reaches every member of one swarm
- [ ] If any swarm member is dead, you see a `skip <name> (dead)` line on stderr — broadcast does NOT abort
- [ ] `hive send <single-bee> "..."` still works (unchanged behavior)
- [ ] `hive send <dead-single-bee> "..."` still errors hard (matches old behavior)

## 5. Brief (warm without work)

- [ ] `hive brief @<swarm-id> "You are reviewing the auth module. Wait for assigned packet."`
- [ ] `hive list --swarm <id>` shows `ready · briefed, awaiting prompt`
- [ ] `hive brief <single-bee> "..."` also works
- [ ] Each session record now has `brief` and `briefedAt` fields (check with `cat ~/.hive/sessions/<name>.json`)

## 6. State machine in `ps` / `list`

Run `hive ps` (alias for `list`) and verify you can produce each of these states:

- [ ] `active` (green) — send a prompt and look within ~30s
- [ ] `idle_with_output` (dim) — same bee, wait until detail shows `idle <duration>`
- [ ] `ready` (green) — fresh-spawned bee, no prompt sent yet
- [ ] `booting` (cyan) — catch a bee in the first second or two after spawn
- [ ] `blocked` (yellow) — spawn codex/claude without `--accept-trust` in a brand-new cwd; pane sits at trust prompt
- [ ] `dead` (gray) — a session whose tmux is gone (kill or crash)
- [ ] `sealed` (magenta) — after running §8 below
- [ ] Filters: `hive ps --colony honeybee` and `hive ps --swarm <id>` narrow the table

## 7. Cleanup commands

- [ ] `hive swarm destroy @<id>` kills every member, marks the swarm destroyed, leaves the swarm record (with `destroyed: true`)
- [ ] `hive clean --dead --dry-run` lists candidates
- [ ] `hive clean --dead` removes orphaned session records
- [ ] `hive colony archive review` flips `archived: true` on the colony; archived colonies are filtered out of completion suggestions

## 8. Seals

Save this as `/tmp/seal.json`:

```json
{
  "status": "done",
  "type": "implementation",
  "summary": "Refactored auth middleware for new compliance requirements.",
  "filesChanged": ["src/auth.ts", "src/middleware.ts"],
  "testsRun": [{ "command": "npm test", "result": "passed" }],
  "risks": ["Legacy session tokens still need backfill."],
  "nextActions": ["Run migration on staging."],
  "confidence": 0.82
}
```

- [ ] `hive seal <bee-id> --from /tmp/seal.json` records the seal
- [ ] `hive last <bee-id> --seal` prints the seal JSON
- [ ] `hive ps` shows that bee as `sealed` (magenta dot)
- [ ] `~/.hive/seals/<bee-name>/<timestamp>.json` exists on disk
- [ ] Re-seal the same bee — second seal is stored alongside; `hive last --seal` shows the newest
- [ ] `hive seal @<swarm-id> --from /tmp/seal.json` records the same artifact for every member
- [ ] In one shell: `hive wait <bee> --seal` (blocks). In another: `hive seal <bee> --from /tmp/seal.json`. The wait unblocks and prints the seal.

### Schema validation

- [ ] Edit the JSON to `"status": "maybe"` — `hive seal` rejects with `Invalid seal status`
- [ ] Empty `"summary"` — rejected with `summary must be a non-empty string`
- [ ] `"confidence": 1.5` — rejected with `confidence must be a number between 0 and 1`
- [ ] `"testsRun": [{ "command": "x", "result": "perhaps" }]` — rejected with `result must be passed, failed, or skipped`

## 9. Shell completion

Reload first: `eval "$(hive completion zsh)"`. Then tab-test each:

- [ ] `hive <TAB>` → all 16 commands (spawn/send/brief/seal/ps/colony/frame/swarm/...)
- [ ] `hive --<TAB>` → `--version --help`
- [ ] `hive spawn <TAB>` → bee names (claude/codex/opencode/grok/pi/droid + profile aliases)
- [ ] `hive spawn claude --colony <TAB>` → active colony names (archived filtered out)
- [ ] `hive spawn --frame <TAB>` → frame names
- [ ] `hive spawn claude --swarm-id <TAB>` → swarm ids
- [ ] `hive list --colony <TAB>` → colony names
- [ ] `hive list --swarm <TAB>` → swarm ids
- [ ] `hive send <TAB>` → live bee refs
- [ ] `hive last <TAB>` / `hive kill <TAB>` → all bee refs (incl. dead)
- [ ] `hive colony <TAB>` → `list create inspect archive`
- [ ] `hive colony archive <TAB>` → colony names
- [ ] `hive colony inspect <TAB>` → colony names
- [ ] `hive frame <TAB>` → `list define inspect remove`
- [ ] `hive frame inspect <TAB>` → frame names
- [ ] `hive frame remove <TAB>` → frame names
- [ ] `hive swarm <TAB>` → `list inspect destroy`
- [ ] `hive swarm inspect <TAB>` → `@<swarm-id>` candidates (with `@` prefix)
- [ ] `hive swarm destroy <TAB>` → `@<swarm-id>` candidates
- [ ] `hive completion <TAB>` → `bash zsh fish`

## 10. Edge cases worth poking

- [ ] `hive spawn codex --colony nonexistent` → fails with helpful "Unknown colony" message
- [ ] `hive spawn codex --colony <archived-colony>` → fails with "Colony is archived"
- [ ] `hive send @ghost "..."` → fails with "Unknown swarm: @ghost"
- [ ] `hive send colony:ghost "..."` → fails with "Unknown colony"
- [ ] `hive seal @<empty-swarm> --from x.json` → "No bees match selector"
- [ ] `hive frame define /tmp/missing.json` → "Source file not found"
- [ ] `hive frame define /tmp/x.yaml` → "Unsupported frame source extension"

## 11. Scripting / piped output (TSV stays stable)

- [ ] `hive list | head` — piped output is TSV (not the pretty table). Columns: state, ref, name, agent, cwd, command. Status token uses new state names (`idle_with_output` etc.) instead of `running`/`dead` — adjust any old scripts.
- [ ] `hive ps | awk '$1 == "sealed" {print $3}'` — should print names of all sealed bees
- [ ] `hive swarm list | awk '$1 == "live"'` — only undestroyed swarms

---

When everything above ticks, Phase 1 is dogfooded. Open issues in the spec text — bus / flow runner / search / multi-substrate — are Phase 2.


# Tormod notes

- [x] Should be possible to both rename colonies and update their description
    - `hive colony update <name> --description "..."` (use `--description ""` to clear)
    - `hive colony update <name> --name <new>` (cascades to sessions + swarms)
    - `hive colony rename <old> <new>` (shorthand)
- [x] Need file autocomplete on creating frames
    - `hive frame define <TAB>` lists `.json`/`.ts` files and directories from cwd; supports relative, `~/`, and absolute prefixes
- [x] This command fails:

        hive frame define /tmp/hive-test/veloren/deep-review.json house-review
        hive: Source file not found: house-review

    Fixed: both arg orders now work (path then name, or name then path) by detecting which arg has a path-like shape (`.json`/`.ts`/slash).
- [x] Need a way to set default args for bee types. The raw `codex` cli should be given --yolo as a flag or whatever the full perm is.
    - `~/.hive/config.json` with shape `{ "bees": { "codex": { "yolo": true, "home": "2", "command": "..." } } }`
    - `hive config show` / `hive config path` / `hive config set-bee <bee> [--yolo|--no-yolo] [--home <v>] [--command "..."]`
    - Precedence: explicit flags > env vars (`HIVE_<BEE>_CMD`, `HIVE_<BEE>_YOLO`) > config defaults
- [x] Need a way to set "home" for castes
    - `home` is now a recognized caste field in frames. Per-caste home wins; falls back to the spawn-level `--home` flag.
- [ ] Need "ls" aliases for colony and swarm (any any other locations with list)
- [ ] Need autocomplete for hive send for swarms, especially when starting typin @
- [ ] State machine states are clearly wrong. Cl.588 for instance were shown as idle when it was clearly active.
