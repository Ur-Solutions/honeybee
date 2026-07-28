# Agent Templates PRD

> Status: draft (2026-07-28). Owner: Tormod. Origin: replace ad-hoc shell
> shorthands (the local `commit()` zsh function) with named, synced,
> hive-native single-agent spawn presets. Companion: Apiary surface design in
> `apiary/docs/epics/agent-templates.md`.

## 1. Summary

An **agent template** is a named preset for spawning one bee: a spawn token,
a canned prompt, spawn defaults (cwd/account/env/yolo), and harness argv.
`hive template define commit.json` once; then `hive template run commit` from
any machine replaces this per-machine shell function:

```sh
commit () {
  hive x codex-auto "Based on your knowledge of the project, commit all changed files…" \
    --cwd "$PWD" -- -m gpt-5.6-sol -c 'model_reasoning_effort="medium"' \
    -c 'service_tier="fast"' -c features.fast_mode=true
}
```

Templates are a primitive *below* frames, flows, and combs: a frame caste, a
flow node, or (later) a comb agent node can reference a template by name
instead of restating prompt+flags. Phase 1 is CLI + store only; consumers
adopt incrementally.

Non-goals: multi-bee cohorts (that's `frame`), recurrence (that's `loop`),
orchestration (that's `flow`/comb), prompt templating languages beyond a
single `{{input}}` placeholder.

## 2. Definition format

`~/.hive/templates/<name>.json` (or `.ts` with a default export, frame-style):

```json
{
  "name": "commit",
  "description": "Atomic commit + push of the current working tree",
  "bee": "codex-auto",
  "prompt": "Based on your knowledge of the project, commit all changed files now in a series of logically connected groupings…",
  "cwd": "caller",
  "args": ["-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=\"medium\"", "-c", "service_tier=\"fast\"", "-c", "features.fast_mode=true"],
  "yolo": false
}
```

Rules:

- `name` — required; regex `^[A-Za-z0-9][A-Za-z0-9_-]*$` (loop-template
  tightness, no dots), validated **before** any path join (`src/frame.ts:45`
  discipline). File stem must equal the declared name.
- `bee` — required; any spawn token `resolveSpawnSpec` accepts
  (`src/spawnResolve.ts:34`): plain kind, `<tool>-auto`, `<tool>-rr`,
  `<tool>-<account>`, PATH executable. Resolved at **run time**, not define
  time — `codex-auto` picks the least-loaded account per invocation.
- `prompt` — required. If it contains `{{input}}`, invocation-time extra text
  is interpolated there; otherwise extra text is appended as a new paragraph.
  Empty-input interpolation collapses to `""`.
- `cwd` — `"caller"` (default: the invoking shell's cwd — the `commit`
  semantics) or an absolute path.
- `args` — harness argv, stored as `string[]`, delivered verbatim as
  `parsed.rest` so it reaches `resolveAgent` via `extraArgs`
  (`src/commands/spawn.ts:876`). Never re-tokenized.
- Optional: `description`, `account`, `env` (object), `yolo`, `preamble`
  (string or `false`).
- Store adds `createdAt`/`updatedAt` on write (loop-template style).

## 3. CLI

```sh
hive template list                          # alias: ls; dual-mode pretty/TSV, --json
hive template define <file.json|.ts> [<name>]   # frame-style import; writes .source; args either order
hive template update <name>                 # re-import from .source
hive template edit <name>                   # $EDITOR round-trip, JSON-backed only
hive template inspect <name>                # canonical JSON
hive template remove <name>                 # alias: rm
hive template run <name> [extra input] [--wait] [--attach] [--cwd <dir>] [--account <a>] [--name <id>] [-- <bee-args…>]
```

`hive template run` defaults to `x` semantics (fire-and-forget, print bee
name). `--wait` gives `run` semantics; `--attach` gives `xa`.

**Flag-form on the spawn family**, mirroring `--frame`:

```sh
hive spawn --template commit
hive x --template commit "also mention the changelog"
hive run --template commit --wait
hive open --template commit
```

Explicitly rejected: an `@commit` selector form. `@` is the swarm namespace
(`src/selectors.ts:43`), `#`/`tag:`/`colony:` are taken, and the generic
`<ns>:<val>` branch would silently read `template:commit` as a tag selector.
A flag plus a verb needs zero selector-grammar changes and matches how
`--frame` already works.

### 3.1 Precedence

Today: FLAG > PROFILE (`config.bees.<name>`, `src/commands/spawn.ts:755`) >
ACCOUNT. Templates slot in as: **FLAG > TEMPLATE > PROFILE > ACCOUNT**. A
template names a bee token which may itself carry a profile; template fields
override profile fields; explicit CLI flags override both. Harness argv
concatenates in existing order — user `-- …` first, then template `args`,
then profile args (matching `extraArgs` precedence at `spawn.ts:876`).

Conflicting-flag guard, copied from `spawnFromFrame`
(`src/commands/spawn.ts:1368`): `--template` alongside `--frame`, `--pool`,
or a positional bee token throws with a "use X instead" message.

### 3.2 Templates vs. `config.bees` thin profiles

Profiles answer "how does bee alias X spawn" (account/model/args). Templates
answer "what job do I fire" — they add the **prompt** and run-mode defaults,
live in the synced store rather than machine-local config, and are
addressable by consumers (frames/flows/Apiary). Profiles stay; a template may
reference a profiled bee name and inherit it under §3.1 precedence. Docs
should present templates as the user-facing preset concept and profiles as
plumbing.

## 4. Implementation shape (house checklist)

1. `src/template.ts` — domain module cloned from `src/loopTemplate.ts`
   (defensive reader, `withFileLock` on `.templates.lock`, sanitize-on-write,
   timestamps) plus `src/frame.ts`'s `.ts`/`.source` import path
   (`loadTsModule` with `{ kind: "template" }`) and `templatesDir() =
   join(storeRoot(), "templates")`. Ledger types
   `template.define|update|remove`, writes via
   `atomicWriteFile(…, { mode: 0o600 })`.
2. `src/commands/template.ts` — `cmdTemplate(parsed)` switch, house error
   shapes, `resolveDefineArgs` reuse for either-order define args. `run`
   builds a synthetic `Parsed` and delegates to `cmdSpawn` via the
   `spawnDelegated` pattern (`src/commands/run.ts:35`), setting
   `flags.cwd` from template/caller, prompt from §2 interpolation, and
   `rest` from `args`.
3. Dispatch: `case "template"` in `src/cli.ts` (`dispatch()` around `:198`),
   help row in the **Spawn & run** group.
4. `--template` on spawn/run/x/xa/open: value flag (no `BOOLEAN_FLAGS` entry
   needed), resolved inside `cmdSpawn` before profile overlay; `hive open`
   adds it to `OPEN_SPAWN_CONTROL_FLAGS` (`src/commands/run.ts:241`).
5. `hive spawn-picker --template` — third branch in `cmdSpawnPicker`
   (`src/commands/here.ts:41`), names one per line; tmux binding recipe added
   to `docs/KEYBINDINGS_PRD.md` §8.2.
6. Completion: `COMMANDS`, `TEMPLATE_SUBCOMMANDS`, `FLAGS_BY_COMMAND`,
   `FLAG_VALUE_KINDS["--template"]` + engine wiring mirroring frames
   (`src/completion/engine.ts:153`).
7. Tests: `tests/template.test.ts` with `withTempStore`
   (`tests/frame.test.ts:8` pattern) — store CRUD, name validation,
   `{{input}}` interpolation/append, precedence, delegation argv.
8. Docs: `### hive template` section in `docs/HIVE_CLI_REFERENCE.md`
   following the frame section's shape (`:1221`).

Naming note: `hive loop template` (loop presets) and `LaunchTemplate`
(`src/launchTui.ts:60`) already use the word. Accepted: "template" unqualified
means agent template at top level; loop templates remain scoped under
`hive loop`. `LaunchTemplate` should be renamed `LaunchEntry` when the launch
TUI learns to list agent templates (below).

## 5. Consumers (phased)

- **Phase 1 (this PRD):** CLI + store + spawn-family flag + spawn-picker.
- **Phase 1.5:** `hive new` / `cmdLaunch` TUI lists templates alongside
  frames/flows (`src/commands/spawn.ts:1079`).
- **Phase 2 (Apiary):** mirror + surfaces — see the Apiary companion doc.
  Requirements on this side: `hive template list --json` and
  `hive template inspect <name>` are the read API; `template.*` ledger events
  are the change feed Apiary watches.
- **Later:** frame castes gain `"template": "<name>"` as an alternative to
  inline `bee`+`brief`; comb agent nodes reference templates for their spawn
  config (`ALIGN-TO-ENGINE-REV` — belongs in `COMBS_ENGINE_DESIGN.md` when
  slice 1 lands, not here).

## 6. Migration

Define `commit.json` from the shell function's exact prompt/argv, verify
`hive template run commit` matches the old spawn (same `resolveAgent` spec),
then delete the zsh function. Any other local shorthands migrate the same
way; templates sync via the existing store sync manifest, so every tailnet
machine gets them.
