# Honeybee execution protocol contract corpus (`local-core-v1`, 0.x)

Canonical, language-neutral schemas and golden fixtures for the Apiary ↔
Honeybee execution protocol (slice C0 of the Phase 0–1 plan; RFC:
`apiary/docs/design/team-ready/honeybee-execution-protocol-rfc.md`).

Honeybee owns this corpus. Apiary consumes it through the package subpath
`honeybee/execution/v1` (validators, digest, conformance runner) — it never
copies these types into its own source tree.

The corpus stays **0.x** until the Honeybee server and the Apiary client both
pass Slice B fixtures; only then is it stamped `v1` (plan §5.1).

## Layout

- `profile.json` — protocol/contract version, named feature profiles
  (`local-core-v1` baseline with `kit-profile-v1`; `runtime-target-v1` schema
  names only, default-off), method-to-schema map, event-type registry, typed
  error codes.
- `states.json` — Run / Lease / Command / Collection / Environment state
  machines (plus `runtime-target-v1` Target/Attachment, inactive).
- `schemas/*.schema.json` — JSON Schema 2020-12 documents; `$ref` between files
  resolves by `$id` registration, not network fetch.
- `fixtures/` — golden requests, responses, event pages, entities, error
  envelopes, negotiation pairs, state-transition tables, and `invalid/`
  fixtures that must fail validation.
- `digest.json` — the committed deterministic schema digest.

The run-command schema is the forward-compatible validation vocabulary;
`local-core-v1.commands` is the baseline client command set, and the selected
harness's signed `node.describe.harnesses[].commands` can narrow it further.
For example, `answer` and `checkpoint` remain schema-valid but are absent from
both the baseline and node descriptor. `answer` needs a signed expected
runner-host epoch; `checkpoint` has no runtime implementation. An older/direct
client that still sends either receives `CAPABILITY_MISMATCH` before a durable
operation or provider effect.

## Lease expiry and Bee lifecycle

An execution lease bounds Run authority and resource occupancy; it does not
file the user's logical conversation. When a started Run reaches lease expiry,
Honeybee waits for any real in-flight turn to settle, parks the exact HSR
runtime, and may terminalize the internal Run as `cancelled` with cause
`lease_expired`. The SessionRecord remains active, messageable, and bound to
the same provider session so an ordinary send can lazily replace its runtime.

Explicit `run.cancel` and `run.release` are different: they remain lifecycle
terminal actions and stop/archive the exact Bee generation. Older Honeybee
versions incorrectly routed lease expiry through that explicit archive path.
When an explicit cancel arrives after the Run already settled with
`lease_expired`, Honeybee first proves the exact Bee archive, then persists a
versioned `cancelLifecycle.state=archive-settled` operation receipt, and only
then appends a proof-bearing `cancel.requested`. That event carries a distinct
`lifecycleProofId` plus the exact v1 receipt; a bare legacy
`cancel.requested` is not archive proof and must not override lease-offload
semantics in a consumer. Proof-bearing members use a separate idempotency key
so a fixed daemon can supersede an unsafe bare row from an older daemon.

`hive execution repair-lease-archive <bee> --run <exact-run-id>` is a
bounded legacy migration for one operator-authorized case. It defaults to
proof-only inspection and requires `--apply` to write the audited correction;
it is not a general unarchive/revive primitive. Historical storage used the
same generic retire evidence for automatic and human retirement, so this
repair is deliberately never run automatically.

During a mixed-version deployment, a daemon that had already classified the
pre-correction runtime could overwrite the accepted correction and launch one
replacement before the fixed binary took over. An explicit retry recognizes
only the durable correction → same-generation `runtime.lost` → one succeeded,
zero-replay recovery chain. With the old daemon quiesced, it fences delivery,
strictly stops that exact no-work successor (host and child group), revalidates
its clean event closure, and records a dedicated correction-restore edge back
to active/parked/done. Any prompt, pending delivery, extra recovery attempt,
changed process birth, explicit lifecycle action, or stop/closure doubt makes
the retry fail closed.

## Schema digest

`schemaDigest` is `sha256:` over the canonical JSON (sorted keys) of
`{ profile, states, schemas }`. Fixtures do not contribute to the digest, so
golden responses may embed the digest itself. Regenerate after any schema,
profile, or state change:

```sh
npm run execution:digest
```

The script rewrites `digest.json`, the `schemaDigest` field of negotiation
response fixtures, and the `requestDigest` of golden request envelopes
(canonical digest of their `body`).

## Conformance

`tests/execution-contract.test.ts` runs the conformance suite via
`src/execution/conformance.ts`, which checks:

- every schema compiles and every `$ref` resolves;
- the digest is deterministic and matches `digest.json`;
- valid fixtures validate, `invalid/` fixtures fail;
- request-envelope fixtures carry `requestDigest = canonicalDigest(body)`;
- negotiation fixtures are internally consistent (`incompatible` iff a
  required feature is missing) and pin the current schema digest;
- transition fixtures exactly mirror `states.json`;
- every `local-core-v1` method, event family, and error code has fixture
  coverage; and
- no valid fixture contains machine paths or secret-looking bytes.

Apiary runs the same corpus through the exported `runConformance` and its own
client-side fixture tests (slice C1); both repositories must report the same
`contractVersion` + `schemaDigest`.

## Governance

This corpus encodes the RFC as proposed. Accepting `local-core-v1` does not
accept `runtime-target-v1` (schema names are reserved here but the profile is
`defaultEnabled: false` — absence means honest capability absence) and does not
accept the Phase 4 `comb-activation-v1` extension, which is intentionally not
in this corpus.
