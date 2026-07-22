# Review — operator gateways (H1–H4) + three reliability fixes

Reviewed: 2026-07-22 · Reviewer: CL.fe3 (independent verification on every
branch; antagonist review agents on the two large diffs; manual review on
the two small ones). Implementers: four codex bees (gpt-5.6-sol, xhigh),
one branch each, in isolated worktrees off `df61826`.

Origin: the 2026-07-22 boot incident (bee `gw-honeybee`) — codex app-server
`thread/start` timeout ladder ×2 on a contended `CODEX_HOME`, silent to a
parked `hive wait --seal`, revive dropped the model pin and rewrote the
record's `command`. Proposal for the gateway half:
`docs/OPERATOR_GATEWAYS_PROPOSAL.md`. Apiary counterpart review:
apiary `docs/review/AGENT_GATEWAY_G1_G3_REVIEW.md`.

## Verdicts

| Branch | Commits | Rounds | Verdict |
|---|---|---|---|
| `feat/operator-gateways` (H1–H4) | 9 | 2 (capability ad; security round) | **merge-ready** |
| `fix/wait-terminal-states` | 2 | 0 | **merge-ready** |
| `fix/revive-argv` | 2 | 0 | **merge-ready** |
| `fix/codex-boot-contention` | 5 | 1 (4 items + 3 optionals, all applied) | **merge-ready** |

All four verified independently by the reviewer: `npm run check` + focused
suites green per branch (32, 11, 74→82, 18–38 tests respectively); each
implementer additionally ran the full suite green (serially — two
integration tests are known to time out only under parallel host load).

## `feat/operator-gateways` — what landed and what the review caught

H1 universal `HIVE_BEE`/`HIVE_BEE_ID` (spawn, flow, **and fork** — forks
were missed in round one); H2 validated `--env` passthrough (CLI, daemon
RPC with `spawnEnv: 1` capability advertisement, flows) with a
denylist **derived from the driver registry**; H3 tolerant cached registry
(`~/.hive/gateways/*.json`, pid liveness with EPERM=live, disable switch
that freezes rather than reconciles-to-zero); H4 MCP-config seeder with
ownership stamps, kit-manifest deference, and byte-preserving merges.

Review rounds fixed, in order of severity:

1. **Credential-env bypass (security).** The protected-key set covered only
   identity + homeEnv keys; driver `extraEnv`/`secretEnvKeys`
   (`XDG_DATA_HOME` → opencode auth.json relocation,
   `CURSOR_API_KEY`/`CURSOR_AUTH_TOKEN`) were overridable by caller `--env`
   **and by a gateway registry file** — the CL.c50 incident class the
   proposal forbids, and a test asserted the hole as correct. Now derived
   from every driver's recipe; caller refused, gateway dropped; test
   asserts the refusal (`56ffc4c`).
2. **Token leak (security).** All spec.env rendered into `record.command`
   → per-spawn tokens (e.g. `APIARY_AGENT_TOKEN`) stored plaintext in
   `~/.hive` and shown in `hive ls`; ssh-tmux put values on the remote
   command line. Caller/gateway values now redacted in rendered/stored
   commands; ssh launches ship the env-bearing script over stdin
   (`a1e4155`).
3. **H1 not universal.** `fork.ts` never stamped identity env (tmux forks:
   none at all). Fixed with tests (`58cd201`).
4. **H4 wrong claude target.** Seeder wrote `mcpServers` into
   `settings.json`; **empirical probe on claude 2.1.217** showed
   settings.json-only yields "No MCP servers configured" while
   `.claude.json` is honored. Retargeted with byte-preserving top-level
   merge of the mixed credential/state file (`22aa644`). The proposal's
   dialect table should be read accordingly.
5. Daemon `capabilities` handler did not exist at the branch point (so
   Apiary's documented spawn:2 warm path was silently falling back to CLI);
   restored + `spawnEnv: 1` advertised and asserted (`d62c724`). **The
   handshake contract is pinned as `{ ok: true, spawn: 2, spawnEnv: 1 }`.**
6. Test hygiene: spawn-env test read the developer's real gateway registry
   (temp-store fixture now), EPERM liveness, disable-freeze (`ffac9e5`).

Declined with sound rationale: stamp-before-config-write reorder (naive
reversal creates false ownership if the config write fails; needs a
deliberate two-phase design — recorded as follow-up).

**Follow-ups (minor, non-blocking):** JSON-flow `validateSpawn` silently
drops an `env` key (TS facade only honors it) — should refuse or honor;
crash-window ownership orphan (the two-phase stamp design); hand-edits to a
live honeybee-owned MCP entry are silently reverted (debug-note at least);
duplicate registry `name` last-wins is undefined in the contract; no
env-value length cap; `hive gateways` lacks `--json` and prints "none
registered" when merely disabled.

## `fix/wait-terminal-states` — manual review

Exit contract: 0 success · 1 terminal/hopeless (also blocked prompt) ·
2 timeout — documented in help + `HIVE_CLI_REFERENCE.md`. Every poll
reloads the record (deleted → terminal; full terminal vocabulary mapped)
and consults runtime liveness through the new shared `sessionLiveness.ts`
(same source-of-truth discipline as `hive tail`, fixing the stale-`working`
trap). Correct subtleties: a *throwing* probe is unknown-liveness (retry,
never false-terminal); `waitForSeal` checks the seal before liveness each
iteration so seal-then-retire still reports success. Clean.

## `fix/revive-argv` — manual review

`launchArgv` frozen on all five spawn paths *before* hive appends its
provider-session pin; every revive variant replays it with lifecycle args
supplied separately (`--fresh` = fresh session, never default flags);
records immutable across revives (`lastReviveCommand` added instead;
explicit-undefined merge semantics verified to actually delete the stale
`providerSessionId`); legacy string-only records recovered via the repo's
own shell-word parser with resume-suffix stripping (wildcarded-id match for
damaged records) and fail-open only where structured data never existed;
`set-model` overrides ride along without duplication; revive prints the
relaunched command. Clean.

## `fix/codex-boot-contention` — review round applied

Landed: per-home boot lock (boot window only), slow-vs-dead probe with
one-line host.log classification, account-auto breaker (10-min cooldown,
clear-on-success, last-resort never yields zero candidates). The antagonist
round caught three emergent-under-load majors, all fixed (`0e61df2`,
`8a5d6f9`):

1. Limits probe inherited the 10-minute lock timeout → `--account auto`
   could silently stall minutes; now 3s lock wait with rollout-snapshot
   fallback, regression-tested.
2. Home lock was held **across the machine-wide admission-slot wait** —
   under a 12-bee stampede, back-of-queue spawns would time out where they
   previously queued and succeeded. Nesting inverted (slot → home, ordering
   preserved everywhere → no deadlock).
3. The breaker recorded queue/lock timeouts as *account* failures —
   converting load-shedding into 10-minute penalties on healthy accounts,
   a cascade recreating the incident. Now trips only on
   `CodexBootProbeError`.
4. A test locked the real `~/.codex` (hermetic now); optionals all done
   (`rpc-error` third class, `cause` preserved, spawn-failure
   classification).

**Follow-ups (minor):** stale-reclaim can steal from a live but suspended
(sleep/SIGSTOP >2 min) holder — add pid-liveness before steal, matching
`fsx.ts`'s long-lived-lock discipline; tmux codex TUI still refreshes auth
in a shared home unserialized (it boots no app-server; operator note);
`tests/events.test.ts` has a pre-existing ledger-follow rename-race flake
under parallel load.

## Also fixed along the way (outside these branches)

`hive wait`'s silent 10-minute default timeout with exit 0 was part of the
incident; the exit-code contract above supersedes it. The `revive --fresh`
flag-drop and the account-picker contention blindness are the other two
incident halves, covered by their branches.

## Merge notes

The four branches are independent off `df61826`; `feat/operator-gateways`
and `fix/codex-boot-contention` both touch `src/commands/spawn.ts` and
`src/agents.ts` — merge sequentially and re-run the suite between (serial
run recommended; two known load-sensitive tests). After merging
`feat/operator-gateways`, rebuild the npm-linked CLI (`npm run build`) so
Apiary's `--env` probe and daemon `spawnEnv` capability go live (the Apiary
`feat/agent-gateway` branch gates on both).
