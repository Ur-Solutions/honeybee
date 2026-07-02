# Honeybee Fix Swarm - 2026-06-20

Colony: `honeybee`
Swarm: `honeybee-fix-20260620`
Coordinator cwd: `/Users/trmd/Projects/trmd/honeybee/repos/honeybee`

## Rules

- One bee owns exactly one task.
- Each bee works only in its own `pro wt` worktree under `/Users/trmd/Projects/trmd/honeybee/worktrees/honeybee/`.
- Do not edit the canonical repo worktree.
- Do not merge back to `main`.
- Implement the smallest correct fix, add focused tests/docs, and run the most relevant checks.
- Finish by reporting status, changed files, tests run, and blockers.

## Tasks

1. `resolver-parity`: Fix flow/loop spawn resolver parity for thin profile overlays.
2. `loop-readiness`: Fix loop readiness timeouts to use the resolved agent.
3. `atomic-loop-ids`: Make loop id allocation atomic.
4. `package-publish`: Fix package publishing so installed bins cannot point at missing `dist` files.
5. `recovery-failures`: Make `swapAccount`, `revive --all`, and `restore --all` failure handling resumable.
6. `usage-search-backpressure`: Add backpressure/streaming to usage/search hot paths.
7. `frame-spawn-parity`: Fix frame spawn account/profile parity.
8. `redaction`: Add redaction for search/session/seal/transcript outputs.
9. `tmux-docs`: Restore or correct shipped tmux keybinding docs.
10. `ledger-bee-filter`: Fix ledger `--bee` filtering.
11. `account-auto-tests`: Add focused tests around account-bound flow/frame spawns and `<tool>-auto` resolution.

## Collection

The coordinator monitors:

- `hive ps --swarm honeybee-fix-20260620 --wide`
- `hive last <bee>`
- `git status --short` in each worktree
- focused test output reported by each bee

Stop command:

```sh
hive swarm destroy @honeybee-fix-20260620
```

## Launch And Results

Initial Kimi worker `hbfix-20260620-09-tmux-docs` failed because the Kimi OAuth login was expired. It was killed and replaced by Claude worker `hbfix-20260620-09-tmux-docs-r2`.

| Task | Bee | Worktree | Result |
| --- | --- | --- | --- |
| 01 resolver parity | `hbfix-20260620-01-resolver-parity` | `worktrees/honeybee/hbfix-20260620-01-resolver-parity` | done |
| 02 loop readiness | `hbfix-20260620-02-loop-readiness` | `worktrees/honeybee/hbfix-20260620-02-loop-readiness` | done |
| 03 atomic loop ids | `hbfix-20260620-03-atomic-loop-ids` | `worktrees/honeybee/hbfix-20260620-03-atomic-loop-ids` | done |
| 04 package publish | `hbfix-20260620-04-package-publish` | `worktrees/honeybee/hbfix-20260620-04-package-publish` | done |
| 05 recovery failures | `hbfix-20260620-05-recovery-failures` | `worktrees/honeybee/hbfix-20260620-05-recovery-failures` | done |
| 06 usage/search backpressure | `hbfix-20260620-06-usage-search-backpressure` | `worktrees/honeybee/hbfix-20260620-06-usage-search-backpressure` | done |
| 07 frame spawn parity | `hbfix-20260620-07-frame-spawn-parity` | `worktrees/honeybee/hbfix-20260620-07-frame-spawn-parity` | done |
| 08 redaction | `hbfix-20260620-08-redaction` | `worktrees/honeybee/hbfix-20260620-08-redaction` | done |
| 09 tmux docs | `hbfix-20260620-09-tmux-docs-r2` | `worktrees/honeybee/hbfix-20260620-09-tmux-docs-r2` | done |
| 10 ledger bee filter | `hbfix-20260620-10-ledger-bee-filter` | `worktrees/honeybee/hbfix-20260620-10-ledger-bee-filter` | done |
| 11 account/auto tests | `hbfix-20260620-11-account-auto-tests` | `worktrees/honeybee/hbfix-20260620-11-account-auto-tests` | done |

Integration note: several shards intentionally overlap (`src/cli.ts`, `src/agents.ts`, `src/spawnResolve.ts`, `src/search.ts`, and shared tests). Merge them deliberately rather than with a blind `pro wt merge-all`.
