# Honeybee Loops — Test Checklist

Walk through this to exercise everything in the Loops feature (`LOOPS_PRD.md`,
`feat/loops`). Loops run a bee repeatedly until a stop condition, harness-agnostic,
via a built-in `loop` flow run detached (`runId === loopId`) with artifacts under
`~/.hive/loops/<loopId>/`.

Sections 0–2 and 8–10 are deterministic and need no live agent. Sections 3–7, 9,
11, 13–14 drive real bees — they need a harness that can **seal** (run `hive seal`),
ideally in `--yolo`. **Note:** the per-iteration seal timeout is 30 min, so a bee
that never seals stalls each iteration until the idle fallback — use a sealing
harness (or `--max-duration`) for prompt iteration.

Tip: sandbox a throwaway store with `export HIVE_STORE_ROOT=$(mktemp -d)` so these
runs don't touch your real `~/.hive`. Unset it when done.

## 0. Setup

- [ ] `npm run build` succeeds
- [ ] `npm test` passes (currently 418, 2 skipped under `SSH_LOCALHOST_AVAILABLE`)
- [ ] `npm run check` reports no TypeScript errors
- [ ] Reload shell completion: `eval "$(hive completion zsh)"`; typing
      `hive loop ` completes `start status logs stop list`, and `--context `
      completes `persistent ralph rolling`
- [ ] `hive help` shows a `loop` row: `<start|status|logs|stop|list> [id] …`

## 1. Built-in `loop` flow registry

The `loop` flow ships with hive (no file under `~/.hive/flows`). It must resolve in
a fresh process so the detached `__flow-exec` child can load it.

- [ ] `hive flow list` includes a `loop` row (`kill-on-end`) even with an empty
      `~/.hive/flows`
- [ ] `hive flow inspect loop` (or run the proof) shows the built-in resolves:
      `npx tsx -e "import('./src/flow/index.js').then(m=>m.loadFlow('loop')).then(f=>console.log(f.name,f.cleanup,f.args.length))"`
      → `loop kill-on-end 14`
- [ ] `hive flow define ./whatever.json loop` → fails: `Cannot define flow "loop": it is a built-in flow.`
- [ ] `hive flow remove loop` → fails: `Cannot remove flow "loop": it is a built-in flow.`

## 2. `hive loop start` — eager arg validation (fails BEFORE spawning)

All of these must error at the CLI and spawn **no** detached process / loop dir.

- [ ] Missing `--context`: `hive loop start --bee claude --cwd . --prompt x --max 5`
      → `Loop requires --context (persistent | ralph | rolling).`
- [ ] Bad `--context`: `--context foo …` → `Unknown --context "foo". Use one of: persistent, ralph, rolling.`
- [ ] Missing `--bee`/`--cwd`/`--prompt` → `Loop requires --<name> (non-empty).`
- [ ] No `--max` and no `--forever`:
      `hive loop start --bee claude --cwd . --context ralph --prompt x`
      → `Loop requires --max <N> (a positive integer) unless --forever is set.`
- [ ] `--max 0` / `--max -1` / `--max abc` → `Invalid --max "...": expected a positive integer.`
- [ ] `--stop-on-seal done,bogus` → `Invalid --stop-on-seal "bogus". Use any of: done, blocked, needs_input, failed.`
- [ ] `--summarizer wrong` → `Invalid --summarizer "wrong". Use one of: self, bee.`
- [ ] `--max-duration 5x` → `Invalid --max-duration "5x". Use e.g. 30s, 10m, 2h.`
- [ ] `--prompt x --prompt-file f.txt` together → `Provide either --prompt or --prompt-file, not both.`
- [ ] `--prompt-file ./task.md` reads + trims the file as the prompt (start succeeds)

## 3. Ralph mode (fresh bee each iteration, state on disk)

Use a sealing harness. Seed a checklist the bee works:
`printf -- '- [ ] a\n- [ ] b\n' > TODO.md`.

```bash
hive loop start --bee claude --cwd "$PWD" --context ralph --yolo --max 10 \
  --until 'test -z "$(grep -F "[ ]" TODO.md)"' \
  --prompt "Take the next unchecked item in TODO.md, do it, tick it off, then seal done."
```

- [ ] `hive loop status <id>` shows `context ralph (carrier=fresh memory=none)`
- [ ] Each iteration spawns a NEW bee named `loop-<id>-i<N>` and kills it after
      (check `hive ps` mid-run — at most one live `loop-<id>-i*` bee at a time)
- [ ] The loop ends with `stopReason until` once both items are ticked, OR
      `stopReason max` if it hits 10 first
- [ ] `~/.hive/loops/<id>/` has no `progress.md`/`history.*` (ralph keeps no
      hive-managed memory)

## 4. Persistent mode (one bee, re-prompted)

```bash
hive loop start --bee claude --cwd "$PWD" --context persistent --yolo --max 3 \
  --prompt "Do one small improvement, then seal done."
```

- [ ] `status` shows `context persistent (carrier=same memory=harness)`
- [ ] The SAME bee (`loop-<id>`) is reused across iterations (no respawn in `hive ps`)
- [ ] A timeout fallback does NOT mis-attribute a prior iteration's seal (each
      iteration advances `iteration` only on a genuinely new seal)
- [ ] Ends on `max` after 3

## 5. Rolling mode (fresh bee + hive-managed fold-forward)

```bash
hive loop start --bee claude --cwd "$PWD" --context rolling --yolo --max 4 \
  --summarizer self \
  --prompt "Continue the migration. Integrate prior progress; seal with the full updated progress as your summary."
```

- [ ] `status` shows `context rolling (carrier=fresh memory=rolling)`
- [ ] `~/.hive/loops/<id>/progress.md` is OVERWRITTEN each iteration with the
      integrated (fold-forward) summary — not reset to just the last iteration
- [ ] `~/.hive/loops/<id>/history.log` GROWS by exactly one line per iteration and
      earlier lines are never rewritten (`wc -l` increases monotonically; diff old
      lines stay byte-identical)
- [ ] `~/.hive/loops/<id>/history.md` is re-derived from `history.log`: verbatim
      while ≤ 20 lines; once > 20 it starts with `(<k> earlier iterations elided)`
      followed by the last 20 lines
- [ ] `hive loop status <id>` prints a `progress.md (head):` block (first 8 lines)
- [ ] `--summarizer bee`: a separate `loop-<id>-sum<N>` bee briefly appears,
      produces the summary, and is killed; `progress.md`/`history.log` update the
      same way (live-harness smoke)

## 6. Stop menu (first hit wins)

Each condition, in isolation, should set the matching `stopReason`:

- [ ] `--stop-on-seal done` (default): bee seals `done` → `stopReason seal:done`
- [ ] `--stop-on-seal failed`: bee seals `failed` → `stopReason seal:failed`
- [ ] `--until 'exit 0'` → stops immediately before iteration 1 (`stopReason until`);
      `--until 'exit 1'` keeps looping until another condition fires
- [ ] `--stop-on-sentinel 'ALL DONE'`: bee prints that marker in its pane →
      `stopReason sentinel` (verify it also fires in **ralph/rolling**, i.e. the
      pane is scanned while the bee is still live, before the fresh-carrier kill)
- [ ] `--max N`: stops at iteration N with `stopReason max`
- [ ] `--max-duration 30s`: stops after ~30s with `stopReason max-duration`
- [ ] `--forever`: runs without a max (verify `--max` is NOT required) and only
      ends via `--until`/seal/sentinel/`hive loop stop`
- [ ] `--judge "Stop when the suite is green"`: opt-in judge bee answers STOP →
      `stopReason judge` (live-harness smoke; a flaky/erroring judge must NOT stop
      the loop)
- [ ] A **no-seal** iteration does NOT synthesize a `done` that trips
      `--stop-on-seal`; it falls through to the mechanical stops (until/max/sentinel)

## 7. Stop / cancel

- [ ] `hive loop stop <id>` (graceful) prints `queued` / `stops after current
      iteration`, writes `~/.hive/loops/<id>/stop-request`, and the loop ends at
      the next boundary with `status stopped`, `stopReason stop-requested`
- [ ] `hive loop stop <id> --now` SIGTERM→SIGKILLs the driver pgid and reconciles
      `loop.json` to `status stopped`, `stopReason stopped:now` (status/list never
      stay stuck at `running`)
- [ ] `hive loop stop <unknown>` → `Unknown loop: <unknown>`
- [ ] `--now` on a loop whose bees run on a remote/ssh node: confirm the bee is
      killed too (it is not in the driver's local pgid — relies on `kill-on-end`)

## 8. `status` / `logs` / `list` output

- [ ] `hive loop list` (pretty) → table `LOOP CONTEXT STATUS ITER STARTED`;
      empty → `No loops yet. Start one with: …`
- [ ] `hive loop status <id>` (pretty) shows context+carrier/memory, bee,
      `iteration / max`, lastSeal, stopCheck, stopReason, elapsed, pid
- [ ] `hive loop status <id> --json` prints the full `loop.json`
- [ ] `hive loop status` (no id) falls back to the list
- [ ] `hive loop logs <id>` prints the driver log; `--iter 2` prints
      `iter-002.log`; `-n 20` tails 20 lines; `-f`/`--follow` streams until the
      loop leaves `running`
- [ ] `hive loop logs <id> --iter 0` → `Invalid --iter "0": expected a positive integer.`

## 9. Pause semantics (blocked ≠ spin)

- [ ] A bee that seals `blocked` or `needs_input` → loop ends `status paused`,
      `stopReason seal:<status>` (it does NOT re-prompt / spin)
- [ ] A fresh spawn that hits a trust/MCP prompt (readiness `trust`/`blocked`) →
      `status paused`, `stopReason readiness:<reason>`; a readiness `timeout` →
      `status errored`

## 10. Artifacts / on-disk layout

For any started loop, `~/.hive/loops/<id>/` contains:

- [ ] `loop.json` — config + live state (`status`, `iteration`, `carrier`,
      `memory`, `stop{…}`, `pid`, `pgid`, `stopReason`, timestamps), mode `0600`
- [ ] `iter-NNN.log` per iteration; `seals/iter-NNN.json` per sealed iteration
- [ ] `stop-request` only after a graceful `hive loop stop`
- [ ] rolling only: `progress.md`, `history.md`, `history.log`
- [ ] flow run-state co-exists at `~/.hive/flows/loop/runs/<id>/{meta.json,log.txt,result.json}`

## 11. Programmatic surface (in-flow / in-agent)

From a TS flow or orchestration bee using the HiveFacade:

- [ ] `await hive.loop({ bee, cwd, context:"ralph", prompt, until, max })` returns
      a `loopId`, writes the initial `loop.json`, and detaches a run
- [ ] `await hive.loopStatus(loopId)` returns the `LoopConfig`
- [ ] `await hive.loopStop(loopId)` requests graceful stop; `{ now:true }` cancels
- [ ] Invalid spec (e.g. missing `--max` without `forever`) rejects eagerly before
      detaching

## 12. Interaction with `hive flow` (runId === loopId)

- [ ] A running loop appears in `hive flow runs` (flow `loop`, run = loopId)
- [ ] `hive flow status <loopId>` and `hive flow logs <loopId>` work on a loop
- [ ] `hive flow cancel <loopId>` is equivalent to `hive loop stop <loopId> --now`
      at the process level (note: it does NOT reconcile `loop.json` — prefer
      `hive loop stop --now`)

## 13. Cross-harness smoke

- [ ] Run a short `--context ralph --max 2` loop on **claude** (sealing in `--yolo`)
- [ ] Repeat on one **non-claude** harness (codex or opencode) — readiness and the
      seal boundary both work without a harness-native loop primitive

## 14. Known-minimal / gaps to eyeball

- [ ] `--judge` and `--summarizer bee` are implemented minimally and not covered by
      automated tests — smoke them against a live harness before relying on them
- [ ] There is no in-process CLI test (`src/cli.ts` runs `main()` at import);
      `buildLoopConfig` validation and the facade paths are unit-tested instead
- [ ] The 30-min per-iteration seal timeout is not yet configurable — a
      non-sealing harness iterates slowly; pair with `--max-duration` if needed

## 15. Scripting / TSV stability

- [ ] `hive loop list | head` → TSV `loop.run<TAB>loopId<TAB>context<TAB>status<TAB>iter<TAB>startedAt`
- [ ] `hive loop status <id>` (non-TTY) → TSV `loopId context status iteration lastSeal startedAt endedAt`
- [ ] `hive loop start … | cat` (non-TTY) → `loop.start<TAB>loopId<TAB>pid<TAB>pgid`
- [ ] `hive loop stop <id> | cat` → `loop.stop<TAB>loopId<TAB>queued` (or `…<TAB>now<TAB><signalled>`)
- [ ] `hive loop status <id> --json | jq .status` parses cleanly

## 16. Edge cases worth poking

- [ ] `hive loop start` on Windows → clear "not supported on Windows" error
- [ ] Start a loop, kill the terminal — the detached driver survives; reopen and
      `hive loop status <id>` still reports progress (pid/pgid persisted)
- [ ] `--until 'some-broken-cmd'` (nonzero/erroring predicate) never throws the
      loop into `errored`; it just keeps looping until another condition fires
- [ ] An already-aborted run / immediate `--now` doesn't crash `runStopPredicate`
      (no TDZ/throw — the predicate resolves `false` cleanly)
- [ ] Two loops in the same cwd write to distinct `~/.hive/loops/<id>/` trees and
      don't clobber each other's `progress.md`/`history.log`

---

When everything above ticks, Loops is dogfooded. Deferred work: configurable seal
timeout, LLM-backed `history.md` digest (currently mechanical elision), `--until`
mid-iteration interruption, resumable `paused` loops, and in-process CLI tests
(see `LOOPS_PRD.md` §18 Open Questions).
