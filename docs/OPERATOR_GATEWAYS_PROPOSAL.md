# Operator gateways — bees discover and reach the surfaces that host them

Status: **draft proposal** (v1, 2026-07-22 — no code yet)
Owner: honeybee
Consumer contract: `apiary/docs/AGENT_GATEWAY_DESIGN.md` (the Apiary Agent
Gateway is the first registrant; this doc is the honeybee half it tags
ALIGN-TO-HONEYBEE)
Scope: registry + env + home-config seeding. Honeybee never speaks the
gateway protocol itself.

Apiary is adding an **Agent Gateway**: an MCP server in its main process, on
a local Unix socket, that lets a bee introspect and drive the operator
surface hosting it — its sidecar browser, whiteboard, shelf terminals, and
(policy-gated) all of Apiary via the command registry. Apiary handles bees
it spawns itself by stamping env and writing MCP config into the session
home at spawn time. That leaves the bees **honeybee** spawns — `hive x` /
`hive spawn` from a shell, daemon spawns, flow/loop spawns, and every future
comb-engine activation — which get gateway access only if honeybee
cooperates.

The ask is deliberately generic. Honeybee should not know what "Apiary" is.
It should know what an **operator gateway** is: an external surface that
advertises a socket and a shim under `~/.hive`, and wants (a) every bee to
carry enough identity env to introduce itself, and (b) every harness home to
carry the MCP config that launches the shim. Apiary is the first
registrant; a future TUI dashboard or the kit server could be the second.

Honeybee's obligations reduce to four small, independently useful changes:

1. a **gateway registry** honeybee reads best-effort (§3);
2. **universal bee-identity env** — `HIVE_BEE` on every substrate, not just
   HSR (§4);
3. **spawn env passthrough** — `--env` / spawn-request env, so operators can
   stamp their own tokens through `hive spawn` (§5);
4. a **gateway MCP-config seeder** beside `homeDefaults.ts` (§6).

Nothing here makes honeybee depend on any gateway: every piece is a
best-effort no-op when the registry is empty, exactly like the kit
integration (`src/kit.ts` — external binary, env-gated, silent absence).

---

## 1. Grounding — where spawns and homes actually happen

Verified against the tree (2026-07-22):

- **One env chokepoint.** Both spawn implementations —
  `spawnBee` (`src/commands/spawn.ts:192`) and the flow runtime's
  `spawnBeeForFlow` (`src/agents.ts:395`) — build the child env through
  `resolveAgent` (`src/agents.ts:111-162`; env assembled at
  `agents.ts:142-145`). Flights wire `spawnSlot` → `spawnBee`
  (`src/daemon/flightSweep.ts:40-56`); loops and flows go through
  `spawnBeeForFlow` (`src/loop/spawn.ts:41`, `src/flow/hive_facade.ts:141`);
  the comb engine design commits to `spawnBee`
  (`docs/COMBS_ENGINE_DESIGN.md`). The daemon's hsr-control `spawn` RPC
  shells back into `hive spawn` (`src/daemon/hsrControl.ts:245-293`), so it
  inherits anything the CLI path does.
- **Identity env is HSR-only today.** `HIVE_BEE` (= bee **name**),
  `HIVE_COMB`, `HIVE_PARENT` are stamped in the HSR child overlay
  (`src/hsr/runner-entry.ts:57-65`, `src/hsr/remoteHost.ts:282-311`). Tmux
  bees get none of them — they resolve via `TMUX_PANE`.
- **No spawn env passthrough.** Neither `hive spawn` nor the daemon spawn
  RPC accepts caller-supplied env; `spec.env` is exactly homeEnv (+
  identity-activation env).
- **Home config seeding has a house pattern.** `src/accounts/homeDefaults.ts`
  merge-seeds `settings.json` (claude) and `config.toml` (codex) on every
  activation (`src/accounts/activation.ts:136-192`, called from
  `spawn.ts:251` / `agents.ts:422`). Honeybee writes **no MCP config**
  anywhere today; the only MCP writer is kit's `kit sync`
  (`src/kit.ts:116-177`), which owns only files claimed by
  `<home>/.kit/manifest.json`.
- **Registries under `~/.hive` are the idiom** (`config.json`, node
  registry, accounts registry, daemon socket advertisement under
  `daemonRoot()`), all `atomicWriteFile` + lock (`src/fsx.ts`,
  `src/lock.ts`). Honeybee does not currently read any externally-owned
  advertisement file — that part is new.

---

## 2. Non-goals

- Honeybee does **not** speak MCP, proxy gateway calls, or manage gateway
  lifecycle. It reads advertisements and writes config; the wire belongs to
  the operator and the bee's harness.
- No per-session home config. Homes are per-account and shared across bees
  (`src/accounts/homes.ts:21-33`); gateway config must be identity-free
  (identity travels in env, §4).
- No hard dependency in either direction: gateway absent → bees spawn
  exactly as today; honeybee absent → the operator's own spawn path still
  works (Apiary stamps env itself).
- No auth theater. Everything is same-user local; tokens are the operator's
  scoping handles, opaque to honeybee (§5).

---

## 3. The gateway registry — `~/.hive/gateways/`

One JSON file per registered gateway, written and owned by the operator app,
never by honeybee:

```
~/.hive/gateways/<name>.json
```

```jsonc
{
  "name": "apiary",
  "protocol": "mcp",                     // only value honeybee understands in v1
  "socketPath": "~/.hive/gateways/apiary.sock",
  "shim": {                               // how a harness reaches the socket
    "command": "/Applications/Apiary.app/Contents/Resources/apiary-mcp",
    "args": []
  },
  "env": { "APIARY_GATEWAY": "~/.hive/gateways/apiary.json" },  // static only
  "pid": 4242,
  "startedAt": "2026-07-22T09:00:00Z",
  "gatewayRev": 1
}
```

Rules:

- **Liveness = pid.** A file whose `pid` is dead (`kill(pid, 0)` fails) is
  stale and ignored everywhere; the operator rewrites its file on boot and
  unlinks on clean quit. Honeybee never deletes another tool's file.
- **`shim.command` is absolute.** The GUI-PATH lesson cuts both ways
  (`hiveBin.ts` exists because shells and GUIs disagree about PATH); a bee's
  harness must never have to find the shim by name.
- **`env` is static values only.** Honeybee merges it verbatim into child
  env for live gateways (§4). Anything per-bee (tokens, session ids) is
  *not* the registry's business — per-bee env travels via passthrough (§5)
  or is derived by the gateway from `HIVE_BEE` adoption.
- **Read helper**: `liveGateways(): GatewayRecord[]` in a new
  `src/gateways.ts` — tolerant parse (malformed file → skipped with a
  debug note, never a spawn failure), cached per-process with mtime check.
  Kill switch: `HIVE_GATEWAYS_DISABLE=1` (the `HIVE_KIT_DISABLE` pattern,
  `src/kit.ts:49-55`).
- Why a directory and not a `config.json` key: `config.json` is
  human-authored, strictly validated configuration
  (`src/config.ts:97-101,220-224`); a gateway file is a **runtime
  advertisement** with a pid in it — the same species as the daemon's own
  socket files under `daemonRoot()`, so it gets the same shape: a file the
  owning process drops and retracts.

> Reconciliation: Apiary's design draft placed its endpoint at
> `~/.hive/apiary/gateway.json`. That moves here —
> `~/.hive/gateways/apiary.json` (+ `apiary.sock` beside it). The Apiary doc
> carries the matching amendment.

---

## 4. Universal bee-identity env

Gateways resolve a connecting bee by asking "which session are you" and
verifying against `~/.hive/sessions/`. That only works if every bee can
answer. Today only HSR bees can (`HIVE_BEE`, `runner-entry.ts:63`); tmux
bees carry nothing.

**Change: stamp identity into `spec.env` at the spawn sites, for every
substrate.** Both `spawnBee` and `spawnBeeForFlow` know the allocated
name/id before substrate handoff (name chosen at `spawn.ts:307`; tmux
`newSession` receives env at `spawn.ts:492-497` / `agents.ts:452`), so the
merge happens there — the HSR overlay keeps its stamps (idempotent
re-stamp), tmux and remote paths gain them:

```
HIVE_BEE     = <name>          (existing semantics, now universal)
HIVE_BEE_ID  = <id>            (new — the stable CL.xxx id; names can be
                                renamed by `hive rename`, ids cannot, and a
                                gateway adopting by name alone would break
                                across a rename)
HIVE_PARENT / HIVE_COMB        (as today, where known)
```

Additionally, for each **live** gateway (§3): merge the registry's static
`env` block. That is the entire per-spawn gateway cost — one cached
registry read and an object spread at `resolveAgent`
(`agents.ts:142`).

Side benefit, independent of gateways: `hive here` / `spawnParent` origin
classification (`src/spawnParent.ts:27`, `src/cli/shared.ts:483,515`) gets
a pane-less answer inside tmux bees too. The existing readers already
prefer `HIVE_BEE` when present, so this is additive; the scrub list
consumers (Apiary's `scrubBeeIdentityEnv` mirrors `BEE_ORIGIN_KEYS`) must
add `HIVE_BEE_ID` — noted in the Apiary doc's companion contract.

---

## 5. Spawn env passthrough

Operators that spawn *through* honeybee need to stamp their own per-bee env
— Apiary's `APIARY_SESSION_ID` + `APIARY_AGENT_TOKEN` are minted per spawn
in Apiary's main process, and today `hive spawn` gives them nowhere to go.

**Change: caller-supplied env, three entry points, one merge site.**

- `hive spawn`/`hive x`/`hive new`: repeated `--env KEY=VALUE` flags
  (execFile-style, never shell-parsed).
- The daemon hsr-control `spawn` RPC: an optional `env` object on the
  request (`hsrControl.ts:245-293` forwards it as `--env` argv when
  shelling back into the CLI). The daemon advertises this in the
  `capabilities` RPC as **`{ ok: true, spawn: 2, spawnEnv: 1 }`** — this
  triple is a pinned cross-repo contract (Apiary gates daemon-path env on
  `spawnEnv >= 1`); additions are allowed, renames/removals are not.
- `spawnBeeForFlow`: an `env` field on its options, for flow authors.

Merge order in `resolveAgent` (last wins):
`homeEnv` → identity-activation env → gateway static env (§4) → caller env
→ honeybee identity stamps (§4). Caller env can therefore *not* spoof
`HIVE_BEE`/`HIVE_BEE_ID` — identity stamps land last. A small denylist
refuses caller overrides of `homeEnv` keys (`CLAUDE_CONFIG_DIR` et al,
`drivers.ts:163-266`) — redirecting a bee's home breaks transcript
attribution (the CL.c50 incident class) and must stay impossible from a
flag.

This is useful beyond gateways (ad-hoc feature flags, proxy settings for a
one-off bee) and is the smallest honest primitive: honeybee does not need
to understand tokens, only carry them.

---

## 6. Gateway MCP-config seeding

The piece that makes gateway access *automatic*: every harness home carries
MCP config launching each live gateway's shim, so a bee's harness connects
without the bee doing anything.

**Change: a new seeder, `src/accounts/gatewayMcp.ts`, sibling to
`homeDefaults.ts`, invoked on the same activation path**
(`activation.ts:136-192`, which already runs on every spawn via
`spawn.ts:251` / `agents.ts:422`). Semantics mirror the house rules
established by `seedClaudeHomeDefaults`/`seedCodexHomeDefaults`
(`homeDefaults.ts:35-43,73-88`): merge, never replace; malformed files left
untouched; idempotent.

Per-harness dialects, keyed off the driver registry (`drivers.ts:160-303`):

| Harness | File in home | Entry |
|---|---|---|
| claude | `.claude.json` `mcpServers` (**empirically verified 2026-07-22 on claude 2.1.217: `settings.json` `mcpServers` is ignored**; `.claude.json` is a mixed credential/state file — merge byte-preserving) | `"<name>": { command, args }` |
| codex | `config.toml` `[mcp_servers.<name>]` | `command`, `args`, `env_vars` for the gateway advertisement env plus `HIVE_BEE`/`HIVE_BEE_ID` (Codex does not otherwise forward those variables to STDIO MCP children) |
| opencode | `opencode.json` `mcp` | per opencode schema |
| grok / kimi / cursor / pi / droid | per driver, as each grows MCP support | absent entry = skipped, logged at debug |

Ownership rules:

- Honeybee owns **only the entries it writes**, addressed by gateway name
  (`apiary`, …). It records what it wrote in a small
  `<home>/.hive-gateways.json` stamp (the `readKitHomeStamp` pattern,
  `spawn.ts:270`), and on each activation reconciles: live gateway → entry
  upserted; gateway gone/stale → **its** entry removed; entries honeybee
  didn't write are never touched.
- **Kit boundary**: kit owns files claimed in `<home>/.kit/manifest.json`
  (`src/kit.ts:13-14`). Where kit claims the harness's MCP file, honeybee
  defers entirely and the gateway should instead register as a kit
  toolpack — the seeder checks the manifest and skips with a debug note.
  One writer per file, always.
- Homes are shared per-account, and that is fine: the config is
  identity-free (shim + socket path only); *who is calling* arrives via §4
  env when the harness launches the shim with the bee's environment.
- Stale-config grace: between a gateway dying and the next activation
  sweep, homes still reference the shim. The shim contract (owned by the
  operator, stated here as an expectation) is to **exit cleanly when the
  socket is absent** so a dead gateway costs a harness nothing beyond one
  failed MCP server at startup.

CLI surface, read-only and small: `hive gateways` — list registry entries
with liveness, and which homes currently carry their config. No
register/unregister verbs; registration is the operator's file-drop.

---

## 7. Touchpoint summary

| Change | Where |
|---|---|
| Registry read + liveness (`liveGateways`) | `src/gateways.ts` (new) |
| Gateway static env + identity stamps into spec.env | `src/agents.ts:111-162` (`resolveAgent`) + name/id merge in `spawn.ts` / `agents.ts` spawn sites |
| Universal `HIVE_BEE`/`HIVE_BEE_ID` (tmux + HSR + remote) | `spawn.ts:492-497,431-440,357-372`; `agents.ts:452`; keep `runner-entry.ts:57-65`, `remoteHost.ts:282-311` |
| `--env` passthrough | `src/commands/spawn.ts` flag parse; `src/daemon/hsrControl.ts:245-293` RPC field; `spawnBeeForFlow` option |
| MCP-config seeder + home stamp | `src/accounts/gatewayMcp.ts` (new), wired in `src/accounts/activation.ts:136-192` |
| `hive gateways` listing | `src/commands/` (new, trivial) |

Nothing in the daemon spawn path needs its own change (it re-enters the
CLI), and the future comb engine is covered by construction (it calls
`spawnBee`).

---

## 8. Invariants

1. **Zero-cost absence.** Empty/absent registry → byte-identical spawn
   behavior to today. All gateway reads are tolerant and cached.
2. **A gateway can never break a spawn.** Malformed registry file, dead
   socket, unwritable home config — all degrade to "no gateway", logged at
   debug, never thrown into the spawn path.
3. **Identity env is honeybee's, last-write.** Caller env and gateway env
   cannot shadow `HIVE_BEE`/`HIVE_BEE_ID`/`HIVE_PARENT`/`HIVE_COMB` or
   homeEnv keys.
4. **One writer per config file.** Kit-claimed files are kit's; honeybee
   touches only its own named entries elsewhere and removes only what its
   stamp proves it wrote.
5. **Honeybee stays protocol-blind.** It never opens `socketPath`; liveness
   is pid-based precisely so no MCP knowledge leaks in.

---

## 9. Staged plan

1. **H1 — identity env.** Universal `HIVE_BEE` + new `HIVE_BEE_ID` across
   substrates. Independent win; unblocks gateway *adoption* for every bee
   even before any other piece lands (an operator can ship its gateway with
   config written only into its own spawns, and adopted bees still work).
2. **H2 — env passthrough.** `--env` + daemon RPC field + flow option, with
   the denylist. Unblocks Apiary's spawn-time token stamping (its G2).
3. **H3 — registry + gateway env.** `src/gateways.ts`, static env merge,
   `hive gateways`.
4. **H4 — MCP seeder.** `gatewayMcp.ts` + home stamp + kit-manifest
   deference. After this, *every* bee on the machine reaches a live
   gateway with zero operator spawn involvement.

---

## 10. Open questions

1. **`HIVE_BEE_ID` vs rename semantics** — is stamping the id enough, or
   should `hive rename` be considered rare enough to skip the second var?
   (Proposal keeps it: one env var is cheap; a broken adoption after rename
   is a miserable bug to find.)
2. **Kit-first instead of native seeder** — kit already materializes MCP
   config and will likely front the gateway as a toolpack anyway. The
   native seeder exists so gateway access does not depend on kit being
   installed/enabled; if kit becomes a hard dependency of the fleet, H4
   collapses into a kit profile and the seeder is deleted.
3. **Remote nodes** — a bee on another tailnet node has no local socket.
   Registry entries could later carry a `node` scope or a TCP fallback;
   out of scope for v1 (matches Apiary's phase-4 sketch).
4. **Should flights/flows advertise the gateway to *contract* text** (bees
   told in their brief that a gateway exists)? Probably a kit-skill
   concern, not honeybee's — the `apiary` skill documents the tools.
