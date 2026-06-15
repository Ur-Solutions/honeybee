# Code Review 932a458e1617

Review date: 2026-05-28
Scope: current working tree against merge base `5257576481632fff38eb26c466e5c9725210f943`, including modified and untracked files.
Note: Subagents were not used because the request did not explicitly authorize spawning them; this is a local deep review.

## Findings

### P1 - Registry names are used as paths without validation

Files:
- `src/frame.ts:44`
- `src/frame.ts:78`
- `src/swarm.ts:41`
- `src/swarm.ts:70`
- `src/colony.ts:31`
- `src/colony.ts:58`

The `load*`, `remove*`, and `archive/destroy*` paths accept raw user-controlled names and then build filesystem paths with `join(rootDir, name + ".json")` or `join(rootDir, name + ".ts")`. The create paths validate names, but the read/remove/update paths do not. This allows path traversal outside the intended registry directories. The most severe case is `removeFrame`: `hive frame remove ../swarms/victim` deletes `~/.hive/swarms/victim.json`, and names with additional `..` components can reach outside `~/.hive` for `.json`/`.ts` files. `loadFrame` can also dynamically import a traversed `.ts` path before validating its exported frame name.

Fix direction: validate names at every public accessor boundary, not just create. For frame names use `validFrameName`, for swarm IDs use `validSwarmId`, and for colonies use `validColonyName`. Also add a shared safe path helper that resolves the final path and asserts it remains inside the expected directory before reading, importing, writing, or deleting. Add regression tests for `../escape` on `loadFrame`, `removeFrame`, `loadSwarm`, `destroySwarm`, `loadColony`, and `archiveColony`.

### P2 - `hive run` forwards swarm/frame flags into spawn but handles only one record

File: `src/cli.ts:633`

`cmdRun` creates a spawn-shaped parsed object with `flags: new Map(parsed.flags)` and passes it to `cmdSpawn`. That means flags that are valid for `spawn`, such as `--count`, `--frame`, `--swarm-id`, `--colony`, and `--briefed`, also affect `run` even though `run` is implemented around a single returned `SessionRecord`. For example, `hive run codex -p hi --count 3 --rm` can spawn three bees, send the prompt to only the first, and clean up only the first, leaving the rest running and recorded as part of a swarm the user did not ask `run` to manage.

Fix direction: either reject swarm/frame-only flags in `cmdRun`, or intentionally implement multi-record run semantics by sending, waiting, and cleaning up every spawned record. The safer behavior is to filter the flags passed to `cmdSpawn` down to spawn options that make sense for a one-shot single bee, and throw a clear usage error for `--count` and `--frame`.

### P2 - TS frame aliases are returned as defined but cannot be loaded later

File: `src/frame.ts:65`

`defineFrameFromFile(source, nameOverride)` returns `{ ...draft, name: finalName }`, but for `.ts` frames it only copies the source file and does not rewrite or wrap the default export. If the source exports `name: "actual"` and the user runs `hive frame define alias frame.ts`, the define call reports `alias` as created, but `loadFrame("alias")` later imports the copied TS module and validates it against expected name `alias`, producing `Frame name mismatch: file declares "actual", expected "alias"`.

Fix direction: either disallow `nameOverride` for `.ts` frames with a clear error, or persist an alias wrapper/metadata record so subsequent `loadFrame(alias)` validates against the same effective name returned by `defineFrameFromFile`. Add a regression test for TS `nameOverride`, matching the existing JSON override test.

## Verification

- `npm run check` passed.
- `npm test` passed: 112 tests.
- Manually reproduced `frame remove ../swarms/victim` deleting a swarm JSON under a temporary `HIVE_STORE_ROOT`.
- Manually reproduced TS frame alias failure under a temporary `HIVE_STORE_ROOT`.

