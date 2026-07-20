# HSR startup optimization results — 2026-07-20

## Outcome

The optimized path makes a new bee durable and returns control to Apiary much
earlier, then reaches the native harness as quickly as its startup protocol
allows. The primary warm Codex result is:

- sequential: CLI return p50 **301 → 114 ms** (-62%); turn start p50
  **430 → 276 ms** (-36%);
- burst 8: CLI return p50/p95 **626/1061 → 198/322 ms** (-68%/-70%);
  turn start p50/p95 **779/1197 → 466/782 ms** (-40%/-35%);
- zero failures and zero Codex handshake retries in every final controlled
  cohort.

These are request-to-observation wall-clock measurements around the same
`hive x` workflow Apiary invokes. Model output latency is not included in the
speedup claim.

## Controlled results

Nearest-rank percentiles, milliseconds. The baseline and final reports use the
same harness, account, cwd, HSR substrate, prompt, and stop event. The final
path uses `dist/cli-x.js`; retirement still uses the full CLI.

### Codex concurrency ladder

| Concurrency | CLI return baseline p50/p95 | Final p50/p95 | Change | Turn start baseline p50/p95 | Final p50/p95 | Change |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 301 / 321 | 114 / 219 | -62% / -32% | 430 / 490 | 276 / 408 | -36% / -17% |
| 2 | 303 / 401 | 112 / 139 | -63% / -65% | 433 / 530 | 279 / 296 | -36% / -44% |
| 4 | 344 / 670 | 121 / 196 | -65% / -71% | 500 / 811 | 292 / 463 | -42% / -43% |
| 8 | 626 / 1061 | 198 / 322 | -68% / -70% | 779 / 1197 | 466 / 782 | -40% / -35% |

Primary raw reports:

- baseline: `codex-hsr-baseline-sequential-20260720.json`,
  `codex-hsr-baseline-burst2-20260720.json`,
  `codex-hsr-baseline-burst4-20260720.json`, and
  `codex-hsr-baseline-burst8-20260720.json`;
- final: `codex-hsr-final-fast-x-sequential-r2-20260720.json`,
  `codex-hsr-final-fast-x-burst2-20260720.json`,
  `codex-hsr-final-fast-x-burst4-20260720.json`, and
  `codex-hsr-final-fast-x-burst8-r2-20260720.json`.

### Other native harnesses

| Harness | CLI return baseline p50/p95 | Final p50/p95 | Change | Turn start baseline p50/p95 | Final p50/p95 | Change |
|---|---:|---:|---:|---:|---:|---:|
| Claude | 431 / 436 | 196 / 286 | -55% / -34% | 426 / 430 | 209 / 281 | -51% / -35% |
| Kimi | 815 / 3647 | 121 / 270 | -85% / -93% | 810 / 3640 | 601 / 780 | -26% / -79% |
| Grok | 1837 / 4265 | 123 / 280 | -93% / -93% | 1827 / 4259 | 917 / 1205 | -50% / -72% |
| OpenCode | 910 / 2232 | 110 / 232 | -88% / -90% | 903 / 2226 | 665 / 1082 | -26% / -51% |

Final reports are `claude-hsr-final-keychain-elision-fast-x-r2-20260720.json`,
`kimi-hsr-final-fast-x-sequential-20260720.json`,
`grok-hsr-final-fast-x-sequential-20260720.json`, and
`opencode-hsr-final-fast-x-sequential-20260720.json`. Each final cohort had
zero failures. The Kimi/Grok/OpenCode command now returns after durable startup
publication and prompt queuing; their remaining request-to-turn time is mostly
native harness boot.

## What changed

1. Every detached local HSR host publishes startup metadata before its native
   handshake. A first prompt sent during startup is persisted and drained under
   the existing delivery lock when the control socket becomes ready. Monitoring
   distinguishes Codex admission queueing from native harness booting, and
   `runningAt` gives every harness a uniform ready timestamp.
2. Best-effort Kit convergence skips both Kit subprocesses when the same home
   has a matching ownership manifest less than 60 seconds old. Explicit strict
   profile requests always synchronize; `HIVE_KIT_SYNC_TTL_MS=0` disables the
   freshness shortcut.
3. The detached HSR child has a dedicated entry and dynamically imports only
   its requested adapter. The missing-payload bootstrap fell from p50/p95
   99.6/109.3 ms to 33.4/37.5 ms; the traced child graph fell from 224 source
   modules and all adapters to 11 source modules before adapter selection.
4. Parent host polling is deadline-aware at 10 ms rather than a fixed 100 ms.
   The isolated second-probe floor fell from about 101 ms to 11 ms.
5. Honeybee exposes `hive-x` for the authoritative `x` implementation. Apiary's
   spawn path prefers it and removes the leading `x`; if `hive-x` is absent it
   invokes the older `hive x` path byte-for-byte. Non-spawn commands never route
   to the specialized binary.
6. Repeated Claude activation avoids a macOS Keychain write only when the
   existing (including hex-encoded) credential and merged target are provably
   identical JSON. Parse or comparison failure takes the write path. Rotated
   token rescue and the independent post-write identity reread remain intact.

The simple stub end-to-end median moved from 204 ms to turn start at baseline
to 172 ms with the final fast entry. More importantly, its parent ready phase
fell from roughly 100 ms to 22–25 ms in final real-harness reports.

## Native limits and rejected shortcuts

The final warm medians expose the remaining approximate native boundary after
the detached host starts: Codex 149 ms to running, Kimi 492 ms, Grok 803 ms,
and OpenCode 567 ms. Claude's stream adapter returns almost immediately; its
remaining parent cost is macOS Keychain validation.

A shared resident Codex app-server is the largest theoretical next step: it
could remove the normal per-bee 150–200 ms handshake and avoid occasional
model-refresh/retry tails. It was deliberately not enabled. The current Codex
protocol does not yet prove per-thread process environment, bee identity,
account isolation, and shared-server crash fanout. One server per bee remains
the correctness boundary until those properties have hermetic multi-thread
tests.

Likewise, a durable activation marker that skipped Claude rotated-token rescue
was rejected. Claude may rotate a live refresh token in another home at any
time; skipping that rescue can revive a dead chain or recreate the observed
wrong-account billing class. The landed Keychain optimization removes only a
provable no-op.

## Measurement caveats

- Startup is sensitive to filesystem cache, machine load, provider model
  refresh, and account lock contention. Cold first samples are retained, not
  silently discarded. Two early final Codex runs under heavy host load are also
  retained; the primary r2 reports were collected after the load subsided.
- Small cohorts make p95 equal to the maximum. Raw samples and failures are
  therefore more informative than a single percentile.
- Codex model-refresh diagnostics are often benign. Forced thread-start retries
  occur in roughly 3% of the retained historical corpus and add seconds; no
  retry occurred in the final controlled matrix.
- `request_to_first_text_ms` is provider/model latency and is not a Honeybee
  optimization target.

## Verification and handoff

Honeybee gates on the merged branch:

- `npm run check`: passed;
- focused HSR, queue, Kit, entry, CLI, activation, keychain, and swap tests:
  passed;
- `npm test`: 1780 passed, 0 failed, 9 skipped;
- `npm run build`: passed; both `dist/cli.js` and `dist/cli-x.js` executable.

Apiary gates on `perf/bee-startup-fast` at commit `5e3e56c`:

- focused binary-resolution and spawn tests: 59 passed;
- `pnpm typecheck`: passed across the workspace;
- `pnpm test`: 1517 passed, 0 failed;
- `pnpm build`: passed.

Mission evidence is retained under colony `hsr-startup-speed`. Review seals:
`startup-opt-proof-20260720`, `hsr-startup-benchmark-s2`,
`hsr-startup-architecture-s4`, `hsr-startup-entry-s3`,
`hsr-startup-activation-s3b`, `hsr-startup-activation-s3d`,
`hsr-startup-fast-x-s3c`, and `hsr-startup-verifier-s5`. Mission bees were
retired after sealing; benchmark bees were retired after every sample.
