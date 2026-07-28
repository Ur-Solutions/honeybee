# Deferred review minors

- **SEM-14 — durable edge-firing memory:** `edgeFiringTail` remains the bounded dedupe/join-success source; replacing it requires a new durable firing index and record migration, beyond a cheap fix.
- **SEM-16 — late seals after ordinary terminal completion:** terminal, non-invalidated activations are not rescanned; durable post-completion audit ingestion needs an explicit retention/sweep policy so completed runs do not remain sweepable forever.
- **contracts-008 — full invalid-output routing matrix:** direct retry and attempts-exhaustion paths are covered, but controller-level invalid-seal forward escalation/no-route/exhaustion permutations are deferred as additional coverage rather than a known semantic defect.

## Delta-review additions (2026-07-28, non-blocking, queued for slice 1.1)
- SEM-13 PARTIAL: subject compare still self-referential.
- SEM-17 PARTIAL: active-run late spawn success leaves bee unowned.
- **DELTA-5 — persisted agent-adoption replans:** recovery intentionally replays the persisted adoption request, so its digest check proves stored-request integrity but cannot detect a newly rendered custom brief that diverges under the same semantic key. Fixing this requires separating stable semantic fields from replay-only transport fields, like the broader SEM-13 migration, rather than discarding the request that closes the attach/adopt crash window.
- NEW: stale-claim `releaseClaim` corrupt_state sweep-loop after crash-window repair.
- NEW: support-root recreation bypasses per-node attempt caps.

## W7a fix-round residuals (2026-07-28)

- **Human stall notification delivery and escalation state (W7A-8):** clock evidence and timeout-edge firing are correct, but buz delivery is still one-shot and recorded before delivery, and only the first threshold notifies. A durable per-edge notification outbox/state machine is deferred because it changes the run schema and requires retry/backoff policy rather than a local correctness patch.
- **Production revision-movement trigger for packet successors (W7A-9):** successor creation and thread linkage are covered, but slice 1 has no subscription/amendment path that advances a live activation's subject revision. W8 must drive the successor through a real revision event and retain the integration fixture; inventing a second revision authority in W7a would violate scope.
- **Unauthenticated verdict-actor residual risk (W7A-10):** ordinary `origin=comb` verification packet kinds do not yet receive Forum's comb-only required-author and exact-pin enforcement. Honeybee checks packet identity, freshness, engine-side pins, and a non-empty actor, but it cannot authenticate that actor. Forum/W7b must extend required author + pin columns to ordinary comb-origin packets before Honeybee can make actor provenance mandatory.
- **Adopt-time terminal race (remaining W7A-11):** human-effect request digests now exclude volatile destination resolution and replay their persisted request, but a feedback bee can still die between resolution and `adoptAgent`. Routing that execution-time failure through `attachedRetryOnDead=spawn` needs a typed adoption error and a new retry transition, so it is deferred rather than guessing from error text.
- **Fresh local-tmux spawn attachment readiness (W7A-12):** spawn-time comb attachment can still deliver its combined contract/track prompt before a newly booted local-tmux CLI is ready. HSR delivery is durable and is the default. The local fix belongs in spawn readiness orchestration so attachment can reuse `confirmSpawnReady`/`deliverSpawnBrief` without double-delivering.
