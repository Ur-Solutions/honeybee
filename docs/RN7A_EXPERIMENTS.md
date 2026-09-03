# RN7a boot-behavior experiments — refresh-blanked credential leases

Date: 2026-09-03. Operator: RN7a agent (Cell rn7a-account-lease). Design under
test: `apiary/docs/design/remote-nodes/credential-leases.md` ("Open questions
for the redline" #1, and the codex re-validation the RN7 slicing names as the
first box).

Method note (credential hygiene): every test ran in a throwaway `mkdtemp` home
(0700, files 0600). The real refresh token was NEVER written anywhere new — the
lease file was constructed in memory from a read-only vault read with the
refresh field blanked before the first byte hit disk. Throwaway homes were
zero-overwritten and removed after each run. No account's live home was
touched; the accounts used (`codex-tormod-ursolutions.no`,
`claude-tormod-ursolutions.no`) had no concurrent bees.

## Experiment 1 — codex on `refresh_token: ""`

Binary: `codex-cli 0.152.0` (the machine's current codex; v1's finding was on
0.142.5). Credential: `codex-tormod-ursolutions.no` vault `auth.json`
(access-token TTL ~8.2 days at test time, `last_refresh` 2026-09-01), with
`tokens.refresh_token` replaced by `""` (field kept), everything else
(`auth_mode`, `OPENAI_API_KEY`, `tokens.id_token`, `tokens.access_token`,
`tokens.account_id`, `last_refresh`) preserved.

### 1a. Boot + one prompt round-trip — PASS

```
CODEX_HOME=<throwaway> codex exec --skip-git-repo-check -s read-only "Reply with exactly: LEASE-OK"
→ OpenAI Codex v0.152.0 … model: gpt-5.6-sol … sandbox: read-only
→ codex: LEASE-OK
→ tokens used: 5,310 — exit 0
```

codex booted, authenticated with the access token alone, completed the turn.
After the run the home's `auth.json` was byte-identical in the fields that
matter: `refresh_token` still `""`, `last_refresh` unchanged, access token
unchanged. No rotation attempt, no warning.

### 1b. Forced 401 (tampered access-token signature) — typed, bounded failure

Same construction, with the access token's JWT signature segment reversed so
the backend rejects it (a structural stand-in for a genuinely expired/revoked
token; claims and expiry identical).

```
→ codex_login::auth::manager: Failed to refresh token: 400 Bad Request:
  { "error": { "message": "Invalid 'refresh_token': empty string. …",
    "type": "invalid_request_error", "param": "refresh_token", "code": "empty_string" } }
→ ERROR: Reconnecting... 5/5 (bounded retries)
→ exit 1
```

On auth rejection codex tries its refresh flow, presents the empty refresh
token, receives a deterministic HTTP 400 `empty_string`, retries a bounded 5
times, and exits 1 with a clean error. No interactive login prompt, no
crash-loop, no mutation of the delivered file.

**Verdict: v1's finding HOLDS on codex-cli 0.152.0.** The access-token-only
lease boots and runs; at token death the harness fails typed and
non-interactively. The workstation rotation loop (renew inside the 60-minute
window, re-deliver) is both sufficient and necessary.

## Experiment 2 — claude on `refreshToken: ""`

Binary: `claude 2.1.233 (Claude Code)`. Credential:
`claude-tormod-ursolutions.no` vault `.credentials.json` (access-token TTL
~3.6 h at test time, subscription `max`), `claudeAiOauth.refreshToken` replaced
by `""`, access token / `expiresAt` / scopes preserved; vault `.claude.json` +
`settings.json` copied alongside for onboarding state. `ANTHROPIC_API_KEY`
scrubbed from the env (the registry's subscription rule).

### 2a. Boot + one prompt round-trip — PASS

```
CLAUDE_CONFIG_DIR=<throwaway> claude -p "Reply with exactly: LEASE-OK"
→ LEASE-OK — exit 0
```

### 2b. Local `expiresAt` in the past (blanked refresh) — PASS

Same lease with `expiresAt` set 60 s into the past (access token still
server-valid — this isolates the CLI's local-expiry handling, the "does it
hard-require the refresh flow" question).

```
→ LEASE-OK — exit 0
```

The run completed and `.credentials.json` was NOT rewritten (`expiresAt` kept
my past value, `refreshToken` still `""`). claude 2.1.233 in `-p` mode does
not hard-gate on local expiry metadata and does not need a working refresh
flow to complete a turn while the server still accepts the access token.

### 2c. Server-side 401 (tampered access token, blanked refresh) — typed failure

```
→ Failed to authenticate. API Error: 401 OAuth access token is invalid.
→ exit 1
```

A clean, non-interactive hard failure — no login prompt, no hang.

**Verdict: the design's open question #1 resolves to "runs cleanly to
expiry, codex-style".** claude with a blanked `refreshToken` runs normally
until the access token actually dies server-side, then fails typed. Rotation
(the daemon's central OAuth refresh, ~25 % of TTL per the design) plus
re-delivery is the correct claude lease model; no mid-session refresh flow is
hard-required.

## Consequences for the `account.lease` verb (RN7a)

- Ship claude leases as `.credentials.json` with `refreshToken: ""` — the
  half-shipped v1 path is validated end to end on today's binary.
- Ship codex leases exactly as v1 did (`refresh_token: ""`, field kept), with
  the vault-freshening dance and the 15-minute minimum-TTL refusal.
- Both harnesses fail TYPED at token death → the satellite's `auth_needed`
  reactive renewal (RN7b) has a reliable signal to key on.
