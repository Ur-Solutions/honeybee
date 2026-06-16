# Accounts = (CLI × provider) pairs

## Problem

honeybee's current model collapses two distinct ideas into one `tool` string:

- **the CLI** — how to drive a binary (launch command, readiness, where auth
  lives, config-home env, exhaustion signal);
- **the identity** — whose credentials, which provider, which quota/usage.

This holds for claude/codex (one CLI = one login = one provider) but breaks on
**opencode**, where one binary multiplexes several provider logins inside a
single shared `auth.json` (`minimax-coding-plan`, `zai-coding-plan`,
`kimi-for-coding`). Consequences we hit in practice:

- minimax/glm can't be distinct accounts — `addAccount` keys on
  `canonicalAgentKind` → `opencode`, and the credential is one shared blob.
- Usage never attributes: `daemon/usageSampler.ts` skips any bee with no
  `accountId`, and `~/.hive/usage/<accountId>.jsonl` + all of `limits.ts` are
  account-keyed. A `hive spawn minimax` bee has no account → no usage, ever.

## The reframe

The atomic unit is the **(CLI, model-provider) pair**, and *that* is the
account. Model is an attribute of the account, not a separate identity.

```
minimax            = account{ cli: opencode,  provider: minimax-coding-plan, model: MiniMax-M3 }
glm                = account{ cli: opencode,  provider: zai-coding-plan,     model: glm-5.2 }
kimi               = account{ cli: kimi-code, provider: moonshot }
grok               = account{ cli: grok,      provider: xai }
claude-ursolutions = account{ cli: claude,    provider: anthropic, email: tormod@ursolutions.no }
```

The keystone payoff is not cosmetic: when the **primary spawn unit is an
account**, every bee is account-bound by construction, so the usage sampler,
limits, exhaustion and auto-swap light up uniformly for every provider with no
special-casing. The whole "account-gated usage" friction dissolves.

## Decisions (settled)

1. **Full isolation.** Each (cli, provider) account owns its config+auth store
   (`~/.hive/homes/<id>/`), holding exactly one provider login. opencode is not
   special; every account is identical in shape. Cost: re-login each opencode
   provider into its own store instead of the shared `auth.json`.
2. **Accounts + thin profiles.** Account = identity/creds. A *profile* is
   optional spawn-sugar referencing an account (model override, extra args,
   cwd). You can spawn either.

## Layers

- **CLI adapter** (today's `drivers.ts`, slimmed): launch command (default +
  yolo), config-home env (claude→`CLAUDE_CONFIG_DIR`, opencode→
  `OPENCODE_CONFIG_DIR` + `XDG_DATA_HOME`, grok→`GROK_HOME`,
  kimi→`KIMI_CODE_HOME`), `isReady`/`isActive`, credential file paths,
  how to select a provider/model (opencode: `--model <provider>/<model>`;
  single-provider CLIs: implicit), `isExhausted` (pane signal).
- **Provider adapter** (new, e.g. `providers.ts`): keyed by provider id —
  `baseURL`, `fetchLimits(account) → AccountLimits` (the quota endpoints:
  z.ai `…/monitor/usage/quota/limit`, minimax `…/token_plan/remains`, claude/
  codex existing), model catalog/default, `login` flow. Replaces the
  `account.tool === "claude"` switch in `limits.ts`.
- **Account** = (cli, provider, default model, isolated home, creds): the thing
  you spawn, vault, track, and swap.
- **Bee** = a running instance of an account in a tmux pane (+ cwd, task).

## Data shapes

```ts
// AccountRecord (v2). Keep the stored field name `tool` == cli for back-compat
// during migration; `provider` is new and required.
type AccountRecord = {
  id: string;            // "minimax", "claude-tormod-ursolutions.no"
  label: string;
  cli: string;           // driver kind: opencode | claude | codex | grok | kimi
  provider: string;      // minimax-coding-plan | zai-coding-plan | anthropic | xai | moonshot
  model?: string;        // default model for spawns
  email?: string;
  addedAt: string;
};

// Profile (thin, config.json) — sugar over an account.
type Profile = {
  account: string;       // account id
  model?: string;
  args?: string[];
  cwd?: string;
  yolo?: boolean;
};
```

For single-provider CLIs the provider is the canonical one
(claude→anthropic, codex→openai, grok→xai, kimi→moonshot).

## Spawn flow

`hive spawn <name>`:
1. Resolve `<name>` → account (directly, or via profile → account).
2. CLI adapter builds the command (binary + provider/model selection + yolo).
3. Set the config-home env to the account's isolated store (creds + config are
   the account's).
4. The bee record always carries `accountId` → usage/limits/exhaustion/swap work
   with no special path.

## Migration

- Backfill existing accounts: `cli` = old `tool`; infer `provider`
  (claude→anthropic, codex→openai). `opencode-opencode1` is ambiguous — split
  per provider or retire.
- minimax/glm: create as isolated accounts, `opencode auth login` each provider
  into its own store, set provider+model. Retire the `config.json` `kind`-alias
  bees (the alias mechanism becomes internal plumbing or is removed).
- kimi/grok: already registered + isolated; just add the `provider` field.

## Staged plan

Each stage ships value and keeps the suite green.

- **S1 — Data model.** Add `cli`+`provider` to `AccountRecord`; backfill;
  scaffold the provider-adapter registry. No behavior change.
- **S2 — Account-first spawn (keystone).** `hive spawn <account>` resolves
  cli+provider+model+isolated home and always sets `accountId`; thin profiles
  reference accounts. Usage gating dissolves here.
- **S3 — Provider limits/exhaustion.** Move claude/codex fetchers into provider
  adapters; add z.ai + minimax fetchers and `isExhausted` for opencode/kimi/grok.
  `account list` now shows usage for all.
- **S4 — Migrate real accounts.** Isolate minimax/glm (re-login), set providers,
  retire kind-alias bees, resolve `opencode-opencode1`.
- **S5 — Cleanup.** Remove the kind-alias shim if fully replaced; finalize docs.
