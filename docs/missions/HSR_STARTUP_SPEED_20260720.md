# HSR startup-speed mission — 2026-07-20

## Mission

Make a newly requested bee observable and useful as quickly as the native
harness permits. Optimize the full path used by Apiary:

`Apiary execFile -> hive x -> account/home preparation -> HSR host admission ->
harness protocol handshake -> initial prompt acceptance -> turn_start`.

Correctness, account isolation, durable prompt delivery, HSR lifecycle truth,
and native transcript identity are hard constraints. This mission does not
trade away those properties for a lower number.

## Metrics

- `request_to_cli_return_ms`: Apiary-equivalent `hive x` wall clock.
- `request_to_running_ms`: HSR meta reaches `running`.
- `request_to_turn_start_ms`: the initial prompt reaches the harness.
- `request_to_first_text_ms`: first model output (provider latency included).
- burst p50/p95/max for 1, 2, 4, and 8 Codex starts.
- phase breakdown: resolve, activation, exec check, allocation, host fork,
  persistence, queued publication, adapter handshake, socket ready, prompt send.

Every comparison uses the same harness/account/model/cwd/prompt, includes at
least five warm samples, reports failures/timeouts, and retains raw JSON.

## Shards and ownership

| Shard | Owner | Scope | Output |
|---|---|---|---|
| S0 | coordinator | benchmark contract, baselines, merge, final verification | benchmark JSON + summary |
| S1 | proof bee `startup-opt-proof-20260720` | read-only structural review | Hive review seal |
| S2 | benchmark worker | harness matrix and burst measurements | raw benchmark JSON, no code edits |
| S3 | implementation worker | low-risk parent/CLI and activation fast paths | isolated commit/seal |
| S4 | implementation worker | resident HSR/Codex warm-server feasibility or implementation | isolated commit/seal |
| S5 | verifier | adversarial correctness and regression review | review seal |

Only the coordinator assigns implementation files after S0/S1/S2 identify
disjoint changes. One owner per file at a time. Workers never edit the primary
repo checkout; implementation work uses dedicated worktrees.

## Worker seal contract

Use the standard Hive seal artifact with:

```json
{
  "status": "done|blocked|needs_input|failed",
  "type": "implementation|review|risk|test|witness",
  "summary": "what was established",
  "filesChanged": ["repo-relative paths"],
  "testsRun": [{"command": "exact command", "result": "passed|failed|skipped", "notes": "detail"}],
  "risks": ["remaining correctness or measurement risk"],
  "nextActions": ["specific next step"],
  "confidence": 0.0
}
```

Benchmark workers also record harness/version, account id (never credentials),
substrate, sample count, raw timings, percentile method, timeout, and host logs.

## Ramp and monitor

1. One read-only proof bee.
2. One sequential benchmark worker.
3. At most three concurrent implementation/review bees after measurements are
   valid and file ownership is disjoint.
4. Burst benchmarks ramp `1 -> 2 -> 4 -> 8`; stop increasing if failures occur,
   p95 exceeds 90 seconds, or an account/provider reports exhaustion.

Monitor:

```sh
hive ps --colony hsr-startup-speed --wide
hive seals find "startup" --colony hsr-startup-speed --since 24h --json
hive search "prompt.run" --type ledger --since 1h --json
```

## Merge and verification

The coordinator normalizes worker seals and raw timings, checks every claimed
gain against identical before/after samples, then runs a verifier against the
diff and raw evidence. Required repository gates are `npm run check`, relevant
targeted tests, full `npm test`, and `npm run build`. Apiary changes, if any,
also require its typecheck, lint/test targets, and build.

## Stop policy

Success means a statistically supported reduction in startup latency with no
loss of prompt durability, account isolation, state correctness, or harness
compatibility. Stop a candidate after two non-improving iterations, any
cross-account/session leak, repeated harness instability, or a provider limit.
Maximum live mission bees: 8. Maximum retries per failed sample: 1. No broad
cleanup and no deletion of user sessions.

Recovery and cleanup:

```sh
hive send colony:hsr-startup-speed "Stop after the current operation and seal status."
hive ps --colony hsr-startup-speed --wide
hive retire <mission-bee>
hive clean --dead --dry-run
```

Test bees are retired rather than deleted so raw run evidence remains available
until merge and review are complete.
