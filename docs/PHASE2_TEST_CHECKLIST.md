# Honeybee v2 — Phase 2 Test Checklist

Walk through this end-to-end to exercise everything that landed in Phase 2. Each
section can be done in isolation. Phase 1 behaviour is covered by
`PHASE1_TEST_CHECKLIST.md` and must keep passing alongside this one.

## 0. Setup

- [ ] `npm run build` succeeds (Phase 2 modules require the compiled `dist/cli.js`
      for the daemon LaunchAgent)
- [ ] `npm test` shows all tests passing (currently 387, 2 skipped under
      `SSH_LOCALHOST_AVAILABLE`)
- [ ] `npm run check` reports no TypeScript errors
- [ ] Reload shell completion: `eval "$(hive completion zsh)"`
- [ ] `hive help` shows new rows: `node`, `substrate`, `daemon`, `buz`, `flow`,
      `search`, `seals find`

## 1. Nodes

The implicit `local` node is always available — `hive node list` synthesizes it
even with no file under `~/.hive/nodes/`.

- [ ] `hive node list` prints at least the implicit `local` row (kind `local-tmux`,
      endpoint `localhost`)
- [ ] `hive node register mini01 --kind ssh-tmux --endpoint user@mini01.local \
        --capabilities claude,codex,node --description "lab box"`
- [ ] `hive node list` now shows both `local` and `mini01`
- [ ] `hive node inspect mini01` prints the JSON record (capabilities, endpoint,
      sshCommand if set)
- [ ] `hive node update mini01 --description "lab box, gpu"`; inspect confirms
      the change
- [ ] `hive node register local --kind ssh-tmux ...` → fails (`local` is
      reserved)
- [ ] `hive node register ../escape --kind local-tmux --endpoint x` → fails with
      invalid name
- [ ] `hive node unregister mini01`; `hive node list` falls back to the implicit
      `local` only
- [ ] `hive substrate list` prints the registered substrate kinds
      (`local-tmux`, `ssh-tmux`)

## 2. Multi-node `hive list` / `hive ps`

Register two nodes (one reachable, one deliberately unreachable) so the
aggregator and `node_unreachable` derivation both fire.

```bash
hive node register reach   --kind ssh-tmux --endpoint localhost --capabilities claude
hive node register offline --kind ssh-tmux --endpoint nope.invalid:22 --capabilities claude
hive spawn claude --node reach -- ""
```

- [ ] `hive ps` (pretty) renders a `NODE` column once more than one node is
      registered. Each row shows `local`, `reach`, or `offline` as appropriate
- [ ] `hive ps --wide` forces the `NODE` column even with a single node
- [ ] `hive ps --node reach` filters to bees on that node
- [ ] Bees on the unreachable node render `node_unreachable` (not `dead`)
- [ ] `hive ps | head` — piped output is still Phase-1 TSV: `state, ref, name,
      agent, cwd, command`. **No `node` column in TSV.** Existing scripts keep
      working
- [ ] `hive node unregister offline` then `hive ps` — the previously
      unreachable rows revert to local state derivation rules

## 3. Remote attach

With at least one ssh-tmux node registered and one bee spawned on it:

- [ ] `hive attach <remote-bee> --print` outputs exactly
      `ssh <endpoint> -t tmux attach-session -t <target>`
- [ ] `hive attach <remote-bee>` (no `--print`) execs the same command and
      drops you into the remote pane
- [ ] `hive attach <local-bee>` still uses local `tmux attach-session` (Phase
      1 parity preserved)
- [ ] Live SSH probe (gated): `SSH_LOCALHOST_AVAILABLE=1 npm test` runs the
      otherwise-skipped ssh-tmux integration test against a real local sshd

## 4. Transactional kill

- [ ] `hive kill <bee>`: the session record only disappears after substrate
      confirms `hasSession` is false
- [ ] Force a kill failure (e.g. revoke ssh access mid-kill, or `chmod -x` the
      tmux binary on the remote): the SessionRecord persists with
      `status: "kill_failed"` and a `lastError` field
- [ ] A subsequent `hive kill <bee>` retries cleanly once the failure source
      is gone
- [ ] `hive swarm destroy @<id>` and `hive run --rm` follow the same
      transactional shape — survivors keep `kill_failed` set

## 5. Daemon (macOS launchctl)

The daemon is the ticking dispatcher: 2s tick, derives state, drains buz queues
on `active → idle_with_output` transitions. It is *mechanical*, not autonomous —
policy lives in records on disk.

- [ ] `hive daemon status` (when nothing installed) prints `down · not-installed`
      and exits 3
- [ ] `hive daemon install` creates
      `~/Library/LaunchAgents/dev.honeybee.hive.plist`, bootstraps under
      `gui/$UID`, and is idempotent on rerun (use `--force` to overwrite)
- [ ] `hive daemon install` refuses if `dist/cli.js` does not exist (run
      `npm run build` first)
- [ ] `hive daemon start` / `stop` / `restart` all return success and reflect
      in `hive daemon status`
- [ ] `hive daemon status` (pretty) shows `● running`, the pid, host, startedAt,
      tickCount, and lastTickAt
- [ ] `hive daemon status --json` produces stable JSON; exits 0 when running,
      3 when down
- [ ] `hive daemon logs` (default 50 lines) prints the JSONL log; `--follow`
      tails and exits cleanly on SIGINT
- [ ] `hive daemon logs -n 200` adjusts the initial slice
- [ ] `hive daemon run --foreground` (used by the LaunchAgent) ticks in the
      current shell; refuses if another daemon already holds the pid lock
      (exit code 3)
- [ ] `hive daemon uninstall` removes the plist and `launchctl bootout`s the
      label; idempotent
- [ ] On Linux: `hive daemon install` exits with a clear error and prints the
      `systemd --user` unit snippet for copy-paste (no auto-install)

## 6. Buz (file-backed messaging)

Storage lives under `~/.hive/buz/<bee>/{inbox,outbox,queue,read,quarantine}/`
plus `~/.hive/buz/_external/<sender>/outbox/` for human senders. Three tiers:
`interrupt`, `queue`, `passive`. Default `buzAccept` (when the SessionRecord
field is absent) is `['queue', 'passive']` — interrupts require explicit
opt-in via `hive buz config`.

Spawn two bees for these checks, e.g. `CL.aaa` and `CO.bbb`.

### 6.1 Sender attribution (strict)

- [ ] `hive buz send CL.aaa --tier queue -p "hi"` (no sender) → fails with
      `exactly one of --sender <bee> or --sender-human <name> is required`
- [ ] `hive buz send CL.aaa --sender CO.bbb --sender-human tormod -p "hi"` →
      fails (mutually exclusive)
- [ ] `hive buz send CL.aaa --sender SOMETHING.ZZZ -p "hi"` → fails (sender must
      resolve to a registered bee)
- [ ] `hive buz send CL.aaa --sender-human tormod --tier queue -p "hi"` →
      writes the message; outbox lands under `~/.hive/buz/_external/tormod/outbox/`

### 6.2 Tier dispatch and policy

- [ ] `hive buz config CL.aaa` prints the current policy (default
      `queue,passive`; source `default`)
- [ ] `hive buz config CL.aaa --accept interrupt,queue,passive` updates the
      SessionRecord; `hive buz config CL.aaa` now shows source `explicit`
- [ ] `hive buz send CL.aaa --sender CO.bbb --tier passive -p "for later"`
      writes straight to `inbox/`
- [ ] `hive buz send CL.aaa --sender CO.bbb --tier queue -p "drain me"` writes
      to `queue/`; `hive buz queue CL.aaa` lists it
- [ ] `hive buz send CL.aaa --sender CO.bbb --tier interrupt -p "stop"` (with
      interrupts allowed) pastes into the live pane and drops a copy in `inbox/`
- [ ] If `buzAccept` excludes `interrupt`, a tier-interrupt send downgrades to
      `queue` (ledger event records `downgraded: true`)

### 6.3 Inbox / read / consume

- [ ] `hive buz inbox CL.aaa` lists messages newest-first with id, sender,
      tier, deliveredAt
- [ ] `hive buz inbox CL.aaa --from CO.bbb --limit 5` filters by sender and
      caps results
- [ ] `hive buz read <id>` prints the full message (frontmatter + body)
- [ ] `hive buz read <id> --consume` moves the file from `inbox/` to `read/`
- [ ] `hive buz outbox CO.bbb` shows what `CO.bbb` sent

### 6.4 Purge / GC

- [ ] `hive buz purge CL.aaa --read` removes everything under `read/`
- [ ] `hive buz purge CL.aaa --older-than 30d` removes inbox + read entries
      older than 30 days
- [ ] `hive buz purge CL.aaa --all` wipes the full bee mailbox tree
- [ ] Passing two of `--read|--older-than|--all` → fails (mutually exclusive)
- [ ] Passing none → fails (`pass --read, --older-than <age>, or --all`)

## 7. Daemon-driven buz dispatch (tier-B drain)

This is the only Phase 2 dispatcher wired into the daemon tick.

- [ ] `hive daemon start` (or `hive daemon run --foreground` in another shell)
- [ ] Spawn `CL.drain`, send it a prompt so it goes `active`
- [ ] `hive buz send CL.drain --sender CO.bbb --tier queue -p "next step"`
      while CL.drain is still active — file sits in `queue/`
- [ ] Wait for `CL.drain` to settle into `idle_with_output`
- [ ] Within one tick (~2s) the daemon moves the queued file to `inbox/`,
      rewriting `deliveredAt`. Verify with `ls ~/.hive/buz/CL.drain/inbox/` and
      `hive buz inbox CL.drain`
- [ ] Ledger event `buz.queue.drain` appears in `~/.hive/ledger.jsonl` with
      the message ids
- [ ] Simulate a substrate failure (kill the tmux session mid-drain); after 3
      consecutive failures the message lands in `quarantine/`
- [ ] `hive daemon logs --follow` shows `transition`, `dispatch.ok`,
      `dispatch.fail` JSONL lines

## 8. Flow registry

Save `/tmp/deep-review.flow.json`:

```json
{
  "name": "deep-review",
  "args": [
    { "name": "topic", "required": true }
  ],
  "steps": [
    { "op": "spawn", "bee": "claude", "bind": "lead" },
    { "op": "brief", "target": "{{lead.id}}", "body": "Review: {{topic}}" },
    { "op": "wait", "target": "{{lead.id}}" },
    { "op": "seal", "target": "{{lead.id}}", "summary": "done" }
  ]
}
```

- [ ] `hive flow define /tmp/deep-review.flow.json` registers it
- [ ] `hive flow list` shows `deep-review · 1 args · 4 steps`
- [ ] `hive flow inspect deep-review` prints the compiled JSON + source path
- [ ] `hive flow define /tmp/deep-review.flow.json review2` defines it under a
      second name (path/name argument order is detected automatically, mirroring
      `hive frame define`)
- [ ] `hive flow remove review2` succeeds; second `remove review2` fails
- [ ] TS flow: `hive flow define ./my-flow.ts` loads via `tsLoader`; an unknown
      import (e.g. missing `honeybee` symlink) surfaces a friendly hint

## 9. Flow runs (foreground + background)

Layout per run: `~/.hive/flows/<name>/runs/<runId>/{meta.json,log.txt,result.json}`.

### Foreground

- [ ] `hive flow run deep-review --arg topic=auth` blocks, streams the log to
      stdout, and writes `result.json`
- [ ] meta.json transitions `running → ok` (or `failed`/`cancelled`)
- [ ] Ctrl-C aborts the foreground run; meta.json status ends as `cancelled`;
      process exits 130
- [ ] `hive flow run deep-review` without required `--arg topic=…` fails with
      a clear missing-arg message

### Background

- [ ] `hive flow run deep-review --arg topic=auth --background` prints the runId
      and pid/pgid, then exits immediately
- [ ] The detached child survives the parent shell exit (e.g. `exit` the
      terminal, reopen, run `hive flow status <runId>`)
- [ ] `hive flow runs` lists newest-first across all flow names
- [ ] `hive flow status <runId>` shows status + start/end timestamps + duration
- [ ] `hive flow logs <runId>` prints the log; `--follow` tails live output
- [ ] `hive flow cancel <runId>` sends SIGTERM to the run's pgid; after the
      grace window, SIGKILL. `hive flow status <runId>` ends as `cancelled`
- [ ] Cancelling an already-finished run prints `already <status>` and does not
      error
- [ ] Background runs are independent process trees — `hive daemon stop` does
      not kill in-flight flow runs

## 10. Search (`hive search` + `hive seals find`)

Corpus: seals, ledger (including rotated `ledger.jsonl.*` files), session
records. Transcripts are explicitly NOT searched.

- [ ] `hive search "auth middleware"` returns hits across all three corpora,
      grouped `SEALS / LEDGER / SESSIONS`
- [ ] `hive search foo --type seals` restricts to seals
- [ ] `hive search foo --type seals,ledger` accepts comma-separated values
- [ ] `hive search foo --type bogus` fails with a clear enum error
- [ ] `hive search foo --case` makes the substring match case-sensitive
- [ ] `hive search "^seal.*done$" --regex` works; pattern length > 256 chars
      fails
- [ ] `hive search foo --colony honeybee --since 7d` filters by colony + age
- [ ] `hive search foo --colony nonexistent` fails fast with "Unknown colony"
- [ ] `hive search foo --bee @swarm-id` rejects swarm-shape selectors (use
      `--swarm`)
- [ ] `hive search foo --limit 0` returns unlimited results
- [ ] `hive search foo --json` prints a stable JSON shape; pretty mode highlights
      the matched range in cyan
- [ ] `hive seals find foo` is equivalent to `hive search foo --type seals`
- [ ] `hive seals find foo --type ledger` fails (the seals noun already
      restricts the corpus)
- [ ] Generate a rotated `ledger.jsonl.<n>` (set `HIVE_LEDGER_MAX_BYTES=1024`
      and write events). Confirm `hive search` scans both the active file and
      the rotated suffixes

## 11. Edge cases worth poking

- [ ] `hive spawn codex --node mini01` when `mini01.capabilities` does not
      include `codex` → fails early with a capability-mismatch error (no tmux
      session created)
- [ ] `hive spawn claude --node ghost` → fails with `Unknown node`
- [ ] `hive node unregister local` → fails (reserved)
- [ ] Session records from Phase 1 (no `node`, `runId`, `flowName`, or
      `buzAccept` field) still load. `hive ps` shows them as local; `hive buz
      send` respects the default `queue,passive` policy
- [ ] Concurrent daemon tick + `hive kill` on the same bee: per-session
      `withFileLock` prevents torn writes; the record either ends deleted or
      with `kill_failed`, never half-written
- [ ] `hive buz send` to a cohort (`@swarm`) with one substrate failure: the
      broadcast continues to other recipients; the failed recipient logs a
      `buz.send` event with `error`
- [ ] `hive flow run` with a step that throws inside TS: meta.json ends as
      `failed`; result.json carries the error message + stack

## 12. Scripting / TSV stability

Phase 1 promised TSV stability. Phase 2 preserves it.

- [ ] `hive list | head` — six columns, in order: `state, ref, name, agent,
      cwd, command`. **No new columns added in piped/TSV mode**, even with
      multiple nodes registered. Phase 1 scripts keep working
- [ ] `hive ps --wide | head` — the `node` column is added only when stdout is
      a TTY; piped output stays Phase-1-shaped
- [ ] `hive flow runs | head` and `hive flow status <runId>` produce TSV when
      not on a TTY (status, runId, flowName, startedAt, endedAt, durationMs)
- [ ] `hive daemon status` (non-TTY) prints
      `<running|down>\t<installed|not-installed>\t<pid>\t<startedAt>\t<lastTickAt>\t<tickCount>`
- [ ] `hive node list` (non-TTY) prints
      `<kind>\t<name>\t<endpoint>\t<status>\t<capabilities>`
- [ ] `hive buz inbox <bee> | awk -F'\t' '{print $1}'` parses cleanly
- [ ] `hive search foo --json | jq '.hits | length'` works for scripted
      consumers; default non-TTY output is TSV with deterministic columns

---

When everything above ticks, Phase 2 is dogfooded. Deferred work (Level 2
resumability, transcript search, Docker/Modal/Kubernetes substrates,
fork/replay, sparse notifications, manager bees, `hive ps --watch`,
`hive artifacts list`, search pagination) is enumerated at the bottom of
`PHASE2_PLAN.md` under "Phase 3 candidates".
