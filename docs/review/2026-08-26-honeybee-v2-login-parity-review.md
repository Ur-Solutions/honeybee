# Honeybee v2 login parity review

Date: 2026-08-26

## Verdict

Honeybee v2's simplified account-login model is sound: one account has one authoritative run-home, and login runs directly against that home. The old scratch login-home, vault-authority synchronizer, prompt-staging lane, and automatic auth replay were intentionally removed by approved spec 08; their absence is not a parity defect. The audit found three narrower implementation gaps inside the v2 contract: Cursor's required out-of-home digest bridge was missing, an invalid/empty credential capture could be accepted, and timed-out login seats were left running without a watcher. Those three are addressed by the implementation accompanying this review.

The current machine also does not need every configured account logged in again. The live account mirror shows six Claude accounts and one Grok account requiring authentication. The seven Codex homes report as logged in when checked with `codex login status`; their six missing usage results are a separate `codex app-server` rate-limit probe failure. Cursor and both OpenCode accounts currently return readable usage. Kimi's usage endpoint returns no windows, which is not evidence of a login failure.

## Findings

### Architecture correction: do not restore the old auth machinery

Spec 08 deliberately makes the account home authoritative and defines one account = one run-home. The vault is only a seed/backup. The old scratch login-home, refresh-chain synchronization, credential harvesting, prompt staging, and automatic `auth-resume` replay existed around the former multi-copy/vault-authoritative design and must not be reintroduced.

Likewise, v2's login completion contract is to capture the refreshed credential, mark the account `ok`, and clear `auth_needed`. A later mailbox wake or explicit runtime restart uses the refreshed authoritative home. It does not promise to reconstruct and replay the provider turn that originally failed authentication. Apiary's `resumed` phase should be understood or renamed as “ready to resume,” but it is not evidence that the old recovery lane belongs in core.

### High: Cursor login cannot reliably complete or isolate an account

The v2 recipe acknowledges that Cursor's credential store is machine-global, but models it as home-relative `auth.json` and `cli-config.json` files (`v2/core/src/accountRecipes.ts:63`). The login poller only has an out-of-home digest path for Claude (`v2/daemon/src/accountsService.ts:834`); it has no Cursor equivalent. A normal `cursor-agent login` can therefore change the machine-global store without changing the watched home file, leaving the login operation open until timeout.

Activation only copies recipe files and applies declared recipe environment (`v2/daemon/src/activation.ts:147`). The old implementation additionally detected Cursor's live global-auth digest and lifted account credentials into the spawned process environment. That behavior has not been ported, so selecting a Cursor account may still fall back to whichever identity is active in Cursor's global store.

Impact before the fix: the one-click login contract was broken for Cursor, and per-account Cursor identity was not trustworthy. The fix adds a minimal live-store reader, captures explicit login digest drift into that account's vault/home, and injects `CURSOR_AUTH_TOKEN`/`CURSOR_API_KEY` only into the resolved runtime environment—never into persistent bee state.

### Medium: Login-seat observation is process-local

Open login-seat state and its credential baseline exist only in an in-memory map (`v2/daemon/src/accountsService.ts`). `startLogin` rejoins only when that map entry exists; if tmux survived but daemon memory did not, it replaces the existing session and takes a new baseline.

An isolated reproduction confirmed that tmux can survive a new `AccountsService` while the observer baseline does not. Persisting this small operational record in SQLite would make restart recovery possible without creating another credential home or authority.

The accompanying fix makes timeout ownership explicit: when the bounded login window ends, Honeybee now stops its tmux seat instead of leaving an untracked process behind. Daemon-restart recovery remains a possible v2-native follow-up via SQLite, not via the old scratch-home marker.

### Medium: Invalid or empty capture can mark an account authenticated

Any detected mtime/digest drift calls `captureHomeToVault`, then unconditionally calls `recordAccountLogin` (`v2/daemon/src/accountsService.ts:839`). Capture itself only copies present files and can return an empty list (`v2/daemon/src/activation.ts:147`). For Claude, an unparsable Keychain value is excluded from overrides, but the account is still marked `ok`.

An isolated reproduction changed a Claude Keychain value from valid JSON to `not-json`. V2 reported `detectedBy: digest`, captured zero files, set `lastLoginAt`, and marked the account `ok`.

Impact before the fix: the UI could show successful login and clear bee auth flags without usable credentials. The fix validates the primary credential before capture, requires that primary to be written, consumes rejected baselines without closing the seat, and allows a later valid provider write to complete the same login.

### Resolved: the standalone CLI regains v1 ergonomics as thin sugar

V2 still starts and observes the account-home tmux seat in the daemon, but an interactive `hive login <account>` now attaches that seat in the calling terminal. This also works from a shell already inside tmux by clearing nesting markers only for the child client. When the provider CLI exits, the thin CLI verifies the daemon's fresh `lastLoginAt` and prints an explicit `capture` confirmation. JSON/non-TTY calls remain non-interactive, and `--no-attach` leaves the seat detached for callers that only need its handle.

Claude seats launch the CLI's native `claude auth login` subcommand instead of booting the general TUI and relying on an operator or timed `/login` keystroke. None of this changes the home/vault authority or capture state machine, and Apiary can keep presenting the same daemon-owned seat.

## Parity summary

| Capability | Old setup | V2 status |
| --- | --- | --- |
| Per-account home and vault capture | Yes | Present; happy-path tests pass |
| Claude macOS Keychain drift | Yes | Present |
| Cursor global credential drift | Yes | Implemented in the accompanying fix |
| Cursor per-account runtime identity | Credential env lifted from snapshot | Implemented without persisting secrets in bee.env |
| Rejoin after daemon restart | Scratch-home marker + tmux discovery | Not implemented; possible SQLite follow-up |
| Login timeout ownership | Seat remained discoverable | Bounded seat is now stopped cleanly |
| Validate captured primary credential | Provider-aware checks | Implemented in the accompanying fix |
| Clear auth-needed flag | Yes | Present |
| Stage/replay failed auth prompt | `auth-resume` did both | Intentionally dropped by spec 08 |
| Interactive CLI attach/wait | Automatic | Restored as thin CLI sugar; `--no-attach` opts out |
| Apiary one-click terminal | N/A / older integration | Present; phase wording could say “ready” |

## Verification performed

- Confirmed live Apiary `self` and `setup` state through the connected Apiary MCP endpoint.
- Read the approved account architecture spec, both login implementations, the v2 activation and lifecycle paths, and Apiary's auth-flow adapter.
- `hive daemon status`: running v2 daemon, no recorded I1 invariant violations.
- `hive account list --json`: six Claude accounts and Grok are `auth_needed`; the remaining account rows are `ok`.
- V2 daemon full suite: 106 tests passed.
- Focused v2 account-service login tests after the fix: 6 passed.
- V2 account RPC tests: 3 passed.
- V2 account/verb CLI tests: 24 passed.
- Focused old login and Cursor tests: 14 passed.
- Two isolated temporary-service reproductions verified seat-loss and invalid-capture behavior; temporary tmux server and files were removed afterward.
- Interactive attach selection and exact named-socket tmux argv have focused unit coverage; the provider/capture lifecycle remains covered at the daemon boundary with fake credentials only.
- `npm run check`, `npm run v2:check`, `npm run build`, and `git diff --check`: passed. The two pre-existing strict typecheck gaps encountered during verification were repaired with a tuple annotation and the missing `BeeViewRow` type export.

## Recommended repair order

1. Land the Cursor digest/runtime-env and validated-capture fixes in this patch.
2. Decide whether daemon-restart recovery for an interactive login warrants a small SQLite operational row. Do not restore scratch login homes or filesystem authority.
3. Consider renaming Apiary's terminal phase from `resumed` to `ready`/`authenticated`, unless the UI explicitly issues a lifecycle restart.
4. Manually exercise one real Claude and one real Codex login from an Apiary terminal after deployment; automated tests intentionally never launch a real provider login or handle real credentials.

## Concurrent worktree note

The checkout already contained uncommitted v2 account/CLI changes, primarily for round-robin account selection and compatibility aliases. They were inspected and preserved. They do not address the login parity gaps above.
