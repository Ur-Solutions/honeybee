# Honeybee — Phase 3: Identity & Accounts Plan

Status: **draft for review** (no code yet)
Depends on: Phase 2 patches **1** (fsx/atomic/lock), **6–7** (daemon), **10–12** (flow runtime), and the **§16 driver/profile** boundary. Phase 3 starts after those land.

This plan adds a multi-account / multi-home identity layer to honeybee, replacing `caam`. It is deliberately scoped to honeybee's charter: honeybee owns **who / where / state / how to reach them** and exposes **facts + mechanical controls**; the **policy/judgment** stays as deterministic flows or moves above (Hermes/manager/cron). See §23 anti-goal compliance below.

---

## 1. Why this lives in honeybee (not a standalone tool, not caam)

The v2 spec already reaches for it:

- **§15 line 614** — a Bee is *"identity + control channel + transcript/artifact channel + lifecycle."* Identity is already a first-class axis.
- **§16 line 664** — *"`HOME` and auth profile behavior must be first-class, especially for Codex/Claude aliases."*
- **§20 line 820** — test pyramid lists *"auth-home aliases (`cc1`, `cc2`, `cc3`, `codex1`, `codex2`, `codex3`)"* as honeybee's to own.
- **Today in code** — `hive spawn claude --home ~/.claude-3` / `codex2` already resolves `--home N → ~/.<tool>-N` (`agents.ts:99`) and injects `CLAUDE_CONFIG_DIR`/`CODEX_HOME` (`agents.ts:67`, `drivers.ts:11,17`). Separate homes (req 7) **already work**.

caam's structural flaw: **one shared home + swap the single credential file** → no parallelism. honeybee already has **N homes**, so that flaw never appears.

## 2. The keystone model: home = slot, account = fungible identity

Three decoupled concepts:

```text
account   a provider identity (creds in the vault)        — the "who"   [NEW]
home      a per-tool config dir (~/.claude-N) = a slot    — the "where" [exists: homePath]
bee       the running session + its transcript            — the "what"  [exists]
```

- A **home** is a durable parallel workspace. Its session transcripts live in it.
- An **account** is swappable *within* a home: activating an account = writing its creds into the home (driver-specific recipe), not moving the session.
- **Autoswap** = on exhaustion, activate a different account into the *same* home and `--resume`. The session is untouched because it never leaves the home.

This resolves the earlier "parallelism vs autoswap" tension: parallelism = number of homes; account switching = cred activation within a home. Both at once.

Exactly **one** new core noun — `account` — plus a credential **vault** (infrastructure, like the ledger) and an `accountId` field on `SessionRecord` (the binding). Keeps the taxonomy small per §3.

## 3. Requirement → mechanism map

| # | Requirement | Mechanism | Boundary |
|---|---|---|---|
| 7 | separate homes | already built (`homePath` + driver `homeEnv`) | core |
| 4 | fast login of others | `hive activate <account> --home N` seeds creds into a home | mechanical |
| 3 | tmux hotkey login | `hive login <account>` spawns a login seat; mesh binds a tmux popup + fzf picker | mechanical |
| 6 | opencode | driver parity (`OPENCODE_CONFIG_DIR`/`XDG_DATA_HOME`) | driver |
| 5 | cursor + grok | new drivers + identity recipes | driver |
| 2 | usage tracking | daemon usage sampler → `~/.hive/usage/*.jsonl` (**facts**); `hive usage` | facts (line 623) |
| 8 | session reconciliation across homes | `hive sessions reconcile` + cron; dedupe by session UUID | retrieval primitive |
| 1 | autoswap on exhaustion | exhaustion **event** (fact) + `swap-account` **primitive** + default **flow** (policy, opt-in, overridable) | facts+control; policy = flow |
| 9 | multi-machine sync | **external** (syncthing); honeybee ships a sync manifest, never syncs creds | not honeybee's transport (line 871) |

## 4. Data layout

```text
~/.hive/
  vault/                       # LOCAL ONLY — never synced (this is "login")
    accounts.json              # registry: {id, tool, label, email, addedAt}
    claude/<account-id>/.credentials.json (+ .claude.json snapshot)
    codex/<account-id>/        # incl. whatever codex auth discovery needs (see §6)
    cursor/<account-id>/ ...
  usage/
    <account-id>.jsonl         # append-only usage samples + exhaustion events (facts)
  accounts.lock                # withFileLock for vault/activation writes
  sessions/<bee>.json          # + accountId, + autoswap fields (additive)
  ledger.jsonl                 # + account.activate / account.exhausted / swap events
```

Homes (slots) keep the existing `~/.<tool>-N` convention; no home registry needed (reuse `--home`). Vault permissions `700`/`600`; vault is the one thing excluded from sync.

## 5. CLI surface (maps onto §5 universal verbs)

```text
hive account list                 # accounts + factual usage/exhaustion state
hive account add <tool> <label>   # register
hive account login <tool> <label> # run the tool's real login in a scratch home, capture creds → vault
hive account import-caam          # migrate ~/.local/share/caam/vault → ~/.hive/vault
hive activate <account> --home N  # seed creds into a home (req 4 fast login)
hive login <account> [--popup]    # interactive (re)login seat via local-tmux (req 3)
hive swap-account <bee> <account> # MECHANISM: activate creds in bee's home + --resume (req 1)
hive usage [<account>]            # factual readout: tokens/windows/exhausted (req 2)
hive spawn claude --account <a>   # spawn bound to an account (activates into a home first)
hive spawn claude --autoswap      # opt into the default autoswap flow for this bee
hive sessions reconcile           # index/dedupe sessions across all homes (req 8)
```

## 6. Driver identity recipes

The old Codex `HOME` workaround isolated auth but leaked a fake home into every
developer tool Codex ran. The current rule is: provider identity lives in the
provider-specific home env (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, etc.); general
`HOME` remains the developer's OS home unless a driver has an explicit,
audited exception. Credential injection is driver-specific, expressed on the
§16 `AgentProfile`:

```ts
type IdentityRecipe = {
  credentialFiles: string[];        // copied from vault/<account>/ into the home
  homeEnv?: string;                 // CLAUDE_CONFIG_DIR | CODEX_HOME | OPENCODE_CONFIG_DIR
  env?: Record<string, string>;     // explicit extras ONLY — opt-in, logged
};
```

- **claude** — `homeEnv: CLAUDE_CONFIG_DIR`, copy `.credentials.json` into `homePath`. Clean.
- **codex** — `homeEnv: CODEX_HOME`, copy `auth.json` and keep the legacy `.codex/auth.json` mirror for older discovery paths. Do **not** set `HOME`; Git, SSH, npm, and similar tools must see the real user home.
- **opencode** — `OPENCODE_CONFIG_DIR` + `XDG_DATA_HOME` (matches existing legacy launch).
- **cursor / grok** — new recipes (open question: grok CLI auth dir — see §11).

Rules from §16 still hold: pure `resolveAgent()`, no settings writes during lookup/help/list, mutations only at spawn/activate and logged in the ledger.

## 7. Usage tracking & exhaustion detection (facts only)

- **Usage sampler** runs in the Phase-2 daemon tick (patch 6). For each active bee it reads its transcript (claude/codex transcripts carry token usage) and appends a sample to `~/.hive/usage/<account>.jsonl`. Directional, not exact (subscription 5h/weekly windows aren't a clean token count) — stated honestly.
- **Exhaustion matcher** — a driver-level matcher (sibling of `ReadinessMatcher`) detects the provider's rate-limit message on the pane/transcript. The daemon treats it like any other state transition and emits an `account.exhausted` ledger/bus event with the reset hint. **This is a fact, not a decision.**
- `hive usage` renders the facts (per account: recent tokens, last-exhausted, reset window). No quota judgment baked in.

## 8. Autoswap (mechanism in core, policy as an overridable flow)

- **Primitive** `hive swap-account <bee> <account>`: under `accounts.lock` — ensure process stopped → apply target account's identity recipe into the bee's home → set `SessionRecord.accountId` → `--resume` same session id in same home → ledger `swap` event. Purely mechanical; session survives.
- **Default flow** `autoswap` (ships with honeybee, **opt-in** per bee via `--autoswap`/`SessionRecord.autoswap`, or a colony default): a daemon dispatcher (sibling of patch-9 `buzQueueDispatcher`) watches `account.exhausted` on autoswap-enabled bees → picks the next non-exhausted account for that tool by a **deterministic** rule (e.g. least-recently-exhausted round-robin) → calls the primitive. Transparent, logged, no model judgment.
- **Overridable**: disable the dispatcher and let Hermes/a manager bee/cron consume `account.exhausted` + call the primitive themselves. honeybee never *hides* the rotation.

Justified by the spec's own charter: deterministic "mechanical recipes" / flows (lines 35, 52, §9). The §23 anti-goals it must avoid are *AI-decides-next* and *hidden* autonomy — a transparent, deterministic, opt-in swap is neither.

## 9. Session reconciliation across homes (req 8)

honeybee already reads transcripts per-home (`transcripts.ts`, `homePath` option). `hive sessions reconcile` (ad hoc + cron) scans all known homes, builds/refreshes a unified index keyed by session UUID, dedupes, and flags divergent same-UUID branches (last-writer or keep-both). This directly fixes the problem this whole thread started with: the phase-2 thread orphaned in `~/.claude-1` would have been discoverable from one place.

## 10. Multi-machine sync (req 9) — external

honeybee owns *what the durable state is* and ships a **sync manifest**; syncthing owns the transport.

```text
include: ~/.hive/** (minus vault/), ~/.<tool>-*/projects/** (+ codex sessions, opencode storage)
exclude: ~/.hive/vault/**, **/.credentials.json, **/.cache, *.sync-conflict*
```

Credentials never leave the machine ("sync all profiles minus login"). Each machine builds its own vault via `hive account login` / `import-caam`. Syncthing conflict files are surfaced by `reconcile`. Respects §15 line 623 and §23 line 871 — no distributed system inside honeybee.

## 11. mesh integration (replaces caam's role)

mesh provisions, honeybee runs:

- Install honeybee; remove the caam wrapper functions from `profiles/zsh/.zsh_aliases`.
- Thin shims reconnecting the original aliases: `cc1..3` / `codex1..3` → `hive spawn <tool> --home N` (or keep raw `CLAUDE_CONFIG_DIR=~/.<tool>-N` aliases as muscle memory — user choice).
  - **Interim state (to swap at this patch):** as of this draft, the raw direct-home aliases `cc1-3` / `codex1-3` have been restored to `mesh/profiles/zsh/.zsh_aliases` (replacing caam's `codex1-3` wrappers; caam access kept via `codex-ursolutions/gmail/thto`). These are the stopgap for working today. Patch 3.8 replaces them with the `hive`-backed shims above and removes the caam codex plumbing, so honeybee owns identity end-to-end. Until then, the aliases and the Phase-3 system will coexist.
- tmux keybinding: `prefix + L` → `display-popup` running an fzf account picker → `hive login` (req 3).
- syncthing folder config from the §10 manifest.
- cron: periodic `hive sessions reconcile` (req 8).

## 12. Patch sub-queue (Phase 3)

| # | Size | Depends | What |
|---|---|---|---|
| 3.1 | M | P2 §16 | Driver `IdentityRecipe` + explicit per-profile `env`; isolates provider auth without global `HOME` rewrites |
| 3.2 | M | 3.1, P1 | Vault + `accounts.json` + `hive account add/login/list/import-caam` |
| 3.3 | S | 3.2 | `hive activate` (req 4) + `hive login` interactive seat (req 3) |
| 3.4 | M | 3.2 | `hive swap-account` primitive + `SessionRecord.accountId` (req 1 mechanism) |
| 3.5 | M | P6, 3.2 | Daemon usage sampler + exhaustion matcher + `account.exhausted` event + `hive usage` (req 2 + req 1 trigger) |
| 3.6 | M | 3.4, 3.5, P10–12 | Default `autoswap` flow + dispatcher, opt-in & overridable (req 1 policy) |
| 3.7 | M | 3.1 | cursor + grok drivers; opencode parity (reqs 5, 6) |
| 3.8 | S | all | `hive sessions reconcile` + sync manifest + mesh provisioning + caam deprecation (reqs 8, 9, 3-binding) |

`SessionRecord` additive fields (normalizeSessionRecord allowlist, no migration — same pattern as Phase 2): `accountId?: string` (3.4), `autoswap?: boolean` (3.6).

## 13. Anti-goal compliance (§23 checklist)

- Usage tracking = facts/heartbeats (line 623 explicitly endorses) — not judgment. ✅
- Autoswap = deterministic, opt-in, logged flow (lines 35/52) + overridable from above — not "AI decides", not hidden autonomy. ✅
- Sync = external; honeybee builds no distributed system (line 871). ✅
- Account = identity facet of the bee (line 614); vault is infrastructure like the ledger. ✅
- No planning / prioritization / merge-ship decisions / product memory introduced. ✅

## 14. Risks / open questions

1. **Limit-message detection** is version/provider-sensitive (heuristic). Mitigate: keep matchers in drivers, easy to update; corroborate with transcript usage + the CLI's own limit event.
2. **Codex home isolation** — validate `CODEX_HOME`-only auth against the current Codex CLI; keep the `.codex/auth.json` mirror only as a compatibility file, not as a reason to rewrite `HOME`.
3. **grok identity** — which CLI / where does it store auth? Needs investigation; may be cursor/opencode-provider rather than a standalone binary.
4. **Same account in two homes** simultaneously is allowed but shares that account's quota; the autoswap selector should prefer distinct non-exhausted accounts.
5. **UUID divergence** when the same session is resumed in two homes / two machines (syncthing). Define last-writer vs keep-both; handle `.sync-conflict` files in `reconcile`.
6. **Vault security** — plaintext OAuth creds at rest; `chmod 700/600`, never synced; consider OS keychain later.
7. **Usage ≠ quota** — token sums are directional; subscription windows are opaque. Surface as estimates, never as authoritative remaining-quota.

## 15. Acceptance criteria (mirrors §22)

- Spawn N bees on N different accounts concurrently, fully isolated (no auth clobber).
- An autoswap-enabled bee that hits its limit resumes on another account within seconds, **same session**, with a ledger trail.
- `hive usage` shows factual per-account consumption and which accounts are exhausted.
- `hive login` (hotkey) re-auths any account in a popup without leaving the cockpit.
- Every session across every home is discoverable from one place (the orphaned `~/.claude-1` phase-2 thread included).
- Credentials never leave the machine via sync; all non-cred state replicates across machines.
- caam fully replaced; `cc1-3` / `codex1-3` work through honeybee.
- Codex spawns authenticated (no login prompt) under explicit profile env.
