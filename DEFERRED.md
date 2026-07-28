# Deferred review minors

- **SEM-14 — durable edge-firing memory:** `edgeFiringTail` remains the bounded dedupe/join-success source; replacing it requires a new durable firing index and record migration, beyond a cheap fix.
- **SEM-16 — late seals after ordinary terminal completion:** terminal, non-invalidated activations are not rescanned; durable post-completion audit ingestion needs an explicit retention/sweep policy so completed runs do not remain sweepable forever.
- **contracts-008 — full invalid-output routing matrix:** direct retry and attempts-exhaustion paths are covered, but controller-level invalid-seal forward escalation/no-route/exhaustion permutations are deferred as additional coverage rather than a known semantic defect.

## Delta-review additions (2026-07-28, non-blocking, queued for slice 1.1)
- SEM-13 PARTIAL: subject compare still self-referential.
- SEM-17 PARTIAL: active-run late spawn success leaves bee unowned.
- NEW: `retireAgentsOnTerminal` silently ignored.
- NEW: stale-claim `releaseClaim` corrupt_state sweep-loop after crash-window repair.
- NEW: support-root recreation bypasses per-node attempt caps.
