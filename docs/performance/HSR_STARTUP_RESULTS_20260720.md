# HSR startup optimization results — 2026-07-20

## Outcome

The optimized path makes a new bee durable and returns control to Apiary much
earlier, then reaches the native harness as quickly as that harness allows. The
most repeatable improvement is in Honeybee's control plane:

- the best warm Codex cohort returned from `hive-x` at p50/p95 **114/219 ms**,
  published its session at **75/177 ms**, started its detached host at
  **103/205 ms**, and observed turn start at **276/408 ms**;
- a directly adjacent, same-stop-event stress rerun against exact baseline
  commit `8808b11` still improved CLI return **585/907 → 361/523 ms**
  (-38%/-42%) and host start **498/847 → 322/459 ms** (-35%/-46%);
- every final controlled cohort completed with zero spawn failures. Both Codex
  ten-sample sequential cohorts above had zero handshake retries.

Native readiness is less stable than control-plane startup. In the adjacent
stress rerun, Codex turn start moved **857/1496 → 1242/3195 ms** even as the
parent and host became materially faster. That reversal came after host start,
inside the native Codex app-server handshake, and is the clearest measurement
of the remaining harness/provider boundary. Accordingly, turn-start gains below
are observed local cohort deltas, not a stable causal guarantee.

All timings are request-to-observation wall clock around the same `hive x`
workflow Apiary invokes. Model output latency is excluded.

## Direct same-stop validation

Nearest-rank p50/p95 in milliseconds. These two ten-sample, concurrency-one
reports were run adjacently with `until: turn-start`, the same Codex account,
cwd, timeout, and poll interval. The executable is intentionally different:
the exact baseline worktree used its full CLI; the final worktree used the
dedicated `hive-x` entry.

| Milestone | Baseline p50/p95 | Final p50/p95 | Change |
|---|---:|---:|---:|
| Session durable | 337 / 760 | 260 / 393 | -23% / -48% |
| Detached host started | 498 / 847 | 322 / 459 | -35% / -46% |
| CLI returned | 585 / 907 | 361 / 523 | -38% / -42% |
| Native turn started | 857 / 1496 | 1242 / 3195 | +45% / +114% |

Raw reports:
`codex-hsr-baseline-turn-start-sequential-r2-20260720.json` and
`codex-hsr-final-turn-start-sequential-r3-20260720.json`.

## Observed warm cohorts

These retained local cohorts show the best sustained warm behavior and scaling,
but they were collected at different times and are not paired experiments.
Filesystem/provider cache state and machine load can differ. The historical
concurrency-one baseline stopped at first text while the final stopped at turn
start; both contain turn-start timestamps, but their post-turn observation and
cleanup windows differ. The burst cohorts use the same `turn-start` stop event.

### Codex concurrency ladder

| Concurrency | Samples B/F | CLI baseline p50/p95 | Final p50/p95 | Observed change | Turn baseline p50/p95 | Final p50/p95 | Observed change |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 5 / 10 | 301 / 321 | 114 / 219 | -62% / -32% | 430 / 490 | 276 / 408 | -36% / -17% |
| 2 | 4 / 4 | 303 / 401 | 112 / 139 | -63% / -65% | 433 / 530 | 279 / 296 | -36% / -44% |
| 4 | 8 / 8 | 344 / 670 | 121 / 196 | -65% / -71% | 500 / 811 | 292 / 463 | -42% / -43% |
| 8 | 8 / 8 | 626 / 1061 | 198 / 322 | -68% / -70% | 779 / 1197 | 466 / 782 | -40% / -35% |

Primary reports are `codex-hsr-baseline-{sequential,burst2,burst4,burst8}-20260720.json`
and the corresponding `codex-hsr-final-fast-x-*` reports. The retained final
burst-8 primary is the `r2` report.

### Other native harnesses

| Harness | Samples B/F | CLI baseline p50/p95 | Final p50/p95 | Observed change | Turn baseline p50/p95 | Final p50/p95 | Observed change |
|---|---:|---:|---:|---:|---:|---:|---:|
| Claude | 3 / 10 | 431 / 436 | 196 / 286 | -55% / -34% | 426 / 430 | 209 / 281 | -51% / -35% |
| Kimi | 3 / 5 | 815 / 3647 | 121 / 270 | -85% / -93% | 810 / 3640 | 601 / 780 | -26% / -79% |
| Grok | 3 / 5 | 1837 / 4265 | 123 / 280 | -93% / -93% | 1827 / 4259 | 917 / 1205 | -50% / -72% |
| OpenCode | 3 / 5 | 910 / 2232 | 110 / 232 | -88% / -90% | 903 / 2226 | 665 / 1082 | -26% / -51% |

Final reports are `claude-hsr-final-keychain-elision-fast-x-r2-20260720.json`,
`kimi-hsr-final-fast-x-sequential-20260720.json`,
`grok-hsr-final-fast-x-sequential-20260720.json`, and
`opencode-hsr-final-fast-x-sequential-20260720.json`. Kimi, Grok, and OpenCode
now return after durable startup publication and prompt queuing; their remaining
request-to-turn time is primarily native harness boot.

The stub end-to-end median moved from 204 ms at baseline to 172 ms with the
final fast entry. Its isolated parent ready phase fell from roughly 100 ms to
22–25 ms in final real-harness reports.

## What changed

1. Every detached local HSR host publishes startup metadata before its native
   handshake. A first prompt sent during startup is persisted and drained under
   the existing delivery lock once the control socket is ready. Monitoring
   distinguishes Codex admission from native harness boot, and `runningAt`
   provides a uniform ready timestamp.
2. Best-effort Kit convergence skips both Kit subprocesses when the same home
   has a matching ownership manifest less than 60 seconds old. Strict profile
   requests always synchronize; `HIVE_KIT_SYNC_TTL_MS=0` disables the shortcut.
3. The detached child has a dedicated entry and dynamically imports only its
   requested adapter. Missing-payload bootstrap fell from p50/p95 99.6/109.3 ms
   to 33.4/37.5 ms; the traced pre-selection graph fell from 224 source modules
   and all adapters to 11 source modules.
4. Parent host polling is deadline-aware at 10 ms rather than a fixed 100 ms.
   The isolated second-probe floor fell from about 101 ms to 11 ms.
5. Honeybee exposes `hive-x` for the authoritative `x` implementation. Apiary
   prefers it only for spawn, strips the leading `x`, and falls back byte-for-byte
   to `hive x`. Named-spawn stdout is parsed into the persisted session name.
6. Repeated Claude activation avoids a macOS Keychain write only when existing
   and merged credentials are provably identical JSON, including hex-encoded
   values. Parse/comparison failure writes normally; rotated-token rescue and
   the independent final identity reread remain intact.

## Native limits and rejected shortcuts

In the best warm final cohorts, the approximate host-start-to-native-running
median was Codex 149 ms, Kimi 492 ms, Grok 803 ms, and OpenCode 567 ms. Those are
not fixed floors: the adjacent stress rerun shows Codex's handshake can expand
to seconds under load even with no explicit retry.

A shared resident Codex app-server is the largest theoretical next step, but it
was deliberately not enabled. The protocol does not yet prove per-thread
process environment, bee identity, account isolation, and shared-server crash
fanout. One server per bee remains the correctness boundary until those
properties have hermetic multi-thread tests.

A durable activation marker that skipped Claude rotated-token rescue was also
rejected. Claude may rotate a live refresh token in another home at any time;
skipping rescue can revive a dead chain or recreate the wrong-account billing
class. The landed Keychain optimization removes only a provable no-op.

## Measurement caveats

- The original raw schema did not record prompt or model. Runs used the driver
  default prompt and harness-selected default model, but that fact is not
  independently auditable from those JSON files. The benchmark now records
  both fields and accepts `--model` for future reports.
- The burst-2 baseline/final cohorts have four samples each; Claude, Kimi, Grok,
  and OpenCode baselines have three. They are below the mission's five-sample
  target, and their p95 is simply the maximum. Treat those rows as directional.
- Startup is sensitive to filesystem cache, machine load, provider model
  refresh, and account lock contention. Cold samples and two early final Codex
  runs under heavy load are retained rather than discarded.
- Forced Codex thread-start retries occur in roughly 3% of the retained
  historical corpus and add seconds. No retry occurred in the final controlled
  matrix or the adjacent ten-sample validation.
- `request_to_first_text_ms` is provider/model latency and is not a Honeybee
  optimization target. No complex Apiary foreground UI/e2e flow was run.

## Verification and handoff

Honeybee gates on `perf/hsr-startup-speed`:

- `npm run check`: passed;
- focused HSR, queue, Kit, entry, CLI, activation, keychain, and swap suites:
  passed;
- `npm test`: 1780 passed, 0 failed, 9 skipped;
- `npm run build`: passed; `dist/cli.js` and `dist/cli-x.js` are executable;
- package dry run includes `dist/cli-x.js` and `dist/hsr/runner-entry.js`.

Apiary gates on `perf/bee-startup-fast`:

- focused binary-resolution and spawn suite: 685 adapter tests passed;
- `pnpm typecheck`: passed across the workspace;
- `pnpm test`: 1518 passed, 0 failed;
- `pnpm build`: passed after the final integration fix.

Independent adversarial review found no blocking Honeybee HSR startup, account,
or runtime defect; its one Apiary named-spawn parsing finding is fixed,
regression-tested, typechecked, and built.

Mission evidence remains under colony `hsr-startup-speed`. Seals:
`startup-opt-proof-20260720`, `hsr-startup-benchmark-s2`,
`hsr-startup-architecture-s4`, `hsr-startup-entry-s3`,
`hsr-startup-activation-s3b`, `hsr-startup-activation-s3d`,
`hsr-startup-fast-x-s3c`, and `hsr-startup-verifier-s5`. All mission and
benchmark bees were retired.
