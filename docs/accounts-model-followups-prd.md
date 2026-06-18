# Account Model — Remaining Follow-ups (PRD)

Companion to [accounts-model.md](./accounts-model.md) and
[accounts-model-impl-spec.md](./accounts-model-impl-spec.md). The S1–S4 account
model (account = `(cli, provider)` pair, full per-account isolation, thin
profiles) and the opencode-SQLite + kimi transcript readers have landed. This
PRD captures the **known-deferred follow-ups** discovered during that work, so
they can be picked up independently.

## Status / context

- **Landed on `main`**: S1 data model, S2 account-first spawn, S3 provider-keyed
  limits + z.ai/minimax fetchers + exhaustion, S4 z.ai mapping fix + the
  minimax/glm migration to isolated accounts.
- **On branch `opencode-kimi-transcripts` (pending merge)**: opencode 1.17.7
  SQLite transcript reader + the kimi transcript provider + the cross-bee
  history-leak fix. Merge into `main` (rebase + ff) when `main` is clean.
- **Resolved decisions (no action)**: the config `kind`-alias is intentionally
  KEPT as complementary cred-less aliasing (distinct from thin profiles); full
  per-account credential isolation via `XDG_DATA_HOME` is verified working.

---

## T1 — Flow-spawn account binding  · P2

**Problem.** Bees spawned by the flow runtime (`spawnBeeForFlow` in
`src/agents.ts`) are never account-bound: they call `resolveAgent` directly,
never `activateAccountIntoHome`, and never set `record.accountId`. So a flow that
spawns `minimax`/`glm`/an account gets no isolated creds, no model selector, and
no usage attribution — unlike the CLI spawn paths. Deferred in S2 to avoid an
import cycle (`activateAccountIntoHome` lives in `src/cli.ts`, which would create
`cli.ts ↔ agents.ts`).

**Approach.**
- Extract `activateAccountIntoHome` (and the small account→home resolution it
  needs) out of `cli.ts` into a module `agents.ts` can import without a cycle
  (e.g. a new `src/accountActivation.ts`, or fold into `accounts.ts`).
- Add `account?: AccountRecord` (+ derived `model`/`provider`) to
  `SpawnBeeOptions`; in `spawnBeeForFlow` activate the account into the home,
  thread `model`/`provider` into `resolveAgent`, and set `record.accountId`.
- Mirror the CLI's `--account`/profile precedence where it makes sense for flows.

**Files.** `src/agents.ts` (`spawnBeeForFlow`, `SpawnBeeOptions`), `src/cli.ts`
(extract activation), new shared module, `src/loop/flow.ts` callers.

**Acceptance.** A flow that spawns an account-backed bee produces a record with
`accountId` set, the isolated home activated, and the right `--model`; the
daemon usage sampler no longer skips it. No import cycle (`tsc` + a cycle check).

---

## T2 — Per-provider usage token accounting  · P3

**Problem.** `transcriptTokenTotals(provider, rows)` in `src/usage.ts` only
handles `claude`/`codex`, so `daemon/usageSampler.ts` never tallies token totals
for opencode or kimi sessions. (Their plan **quota** still works via the S3
provider fetchers — this is only the transcript-derived token *sample* path, and
opencode/grok already returned null here pre-change, so it is not a regression.)

**Approach.**
- opencode: the SQLite `session` row already carries `tokens_input`,
  `tokens_output`, `tokens_reasoning`, `tokens_cache_read/write`. Surface them
  (either from the transcript reader onto `TranscriptFile`, or a dedicated
  `opencodeTokenTotals`).
- kimi: parse `usage.record` events from `agents/main/wire.jsonl`.
- Add `opencode`/`kimi` branches to `transcriptTokenTotals`.

**Files.** `src/usage.ts`, `src/transcripts.ts` (expose token fields),
`src/daemon/usageSampler.ts`.

**Acceptance.** An account-bound opencode/kimi bee accrues token totals in
`~/.hive/usage/<accountId>.jsonl`; `hive` usage views show them.

---

## T3 — `<tool>-auto` / account-pick provider scoping for opencode  · P2 (latent)

**Problem.** `findAccount`, `resolveAccountFlag`, and
`pickLeastLoadedAccount` scope only by `canonicalAgentKind(tool)` — they are
provider-blind. Today each opencode provider has exactly one account, so it is
latent; but once a provider has 2+ accounts (or you `hive spawn opencode-auto`),
auto-pick could select a `glm` account for a `minimax`-intended spawn. A TODO was
left at `pickAutoAccount` in S3.

**Approach.** Add optional provider scoping to the account-pick path: when the
spawn token / profile implies a provider, filter candidates by
`account.provider` as well as `tool`. Autoswap + `swap.ts` already do this
(undefined-tolerant); extend the same to `findAccount`/`pickLeastLoadedAccount`.

**Files.** `src/accounts.ts`, `src/limits.ts` (`pickLeastLoadedAccount`),
`src/cli.ts` (`resolveAccountFlag`).

**Acceptance.** `opencode-auto` / a provider-scoped query never selects a
different-provider account; single-provider-per-cli behavior is unchanged.

---

## T4 — grok / kimi model selector flags  · P3

**Problem.** The driver `modelArgs` hook is implemented for claude/codex/opencode
only; grok and kimi return `[]` (no `--model`), so an account `model` is ignored
for them. Deferred in S2 pending real-CLI verification of their model flags.

**Approach.** Verify grok (`-m/--model`) and kimi (`-m/--model`) accept a model
id, then add their `modelArgs` (bare `--model <model>`, like claude/codex).
Confirm against the live CLIs.

**Files.** `src/drivers.ts` (grok/kimi `modelArgs`).

**Acceptance.** A grok/kimi account with a `model` spawns with the correct
`--model`; no model → byte-identical to today.

---

## T5 — kimi transcript provider polish  · P3

**Problem (minor, from the adversarial review).**
- An idle kimi session (only `config.update`/`metadata` events, zero
  conversation rows) returns `null` even though `state.json` has a usable title.
- Row dedup is adjacent-row `(role, text)` equality — a user legitimately
  sending the identical message twice in a row would drop one.

**Approach.** Optionally surface `state.json.title` for row-less sessions (match
other providers' "title without rows" handling, if any); make dedup turn-aware
rather than adjacent-row. Both are low-impact; do only if kimi history quality
matters.

**Files.** `src/transcripts.ts` (`latestKimiTranscript`/`readKimiRows`).

---

## T6 — Confirm minimax quota parsing against more live data  · P3

**Problem.** The minimax `token_plan/remains` fetcher prefers the count-based
used% (validated live), but falls back to inverting
`current_interval_remaining_percent` with a 0–1-vs-0–100 heuristic that has a
boundary ambiguity at the value `1`. Only one live shape was observed.

**Approach.** Sample the endpoint across usage levels (near-full and
near-empty) and confirm the count path always wins / the fraction fallback is
correct; tighten or drop the dual-format branch.

**Files.** `src/providers.ts` (`minimaxLimits`/`minimaxWindow`).

---

## Priority summary

| Task | What | Priority |
|---|---|---|
| T1 | Flow-spawn account binding | P2 |
| T3 | `<tool>-auto` provider scoping (latent until 2+ accounts/provider) | P2 |
| T2 | Per-provider usage token accounting | P3 |
| T4 | grok/kimi model selector flags | P3 |
| T5 | kimi transcript polish | P3 |
| T6 | minimax quota live confirmation | P3 |
