# Review: executionAdmin:1 bootstrap RPCs + canonical Apiary nodeId binding

- **Commit:** `49297d39` (stacked on H1 `adb1310b`), branch `agent/apiary-p01-local-admin`
- **Reviewer:** apiary-p01-local-admin-review (CL.32bd), 2026-08-05
- **Scope:** Is `executionAdmin.bindLocalAuthorityHost` / `executionAdmin.registerWorkingCopy`
  safe and usable by Apiary L2 for the first local checkpoint?
- **Verdict:** **Clear — no P0/P1.** Typecheck clean; full suite green
  (2431 pass / 0 fail / 9 skipped).

## What was checked

**Canonical signing/digest parity.** `requestDigest = canonicalDigest(body)` and the
envelope signature both use the one canonical form (`src/comb/canonical.ts` sorted-key
JSON; signature excludes only the `signature` field, `src/execution/signing.ts:49-58`).
Apiary consumes the identical code via the `honeybee/execution/v1` subpath, so both
sides verify byte-identically. Digest is checked before signature, so a tampered body
fails as digest drift and a re-digested tamper fails as a signature break — both
covered by tests (`execution-admin.test.ts:268-283`).

**Same-user TOFU boundary.** Socket dir and file are asserted `0o700` fail-closed —
`chmod` now aborts server start on failure instead of being swallowed
(`src/hsr/rpc.ts:128-134, 252-260`). First-bind is possession-proof only, documented
as acceptable solely for the local-authority-host kind on a same-user socket; there is
no replace/handoff path, and registration verifies against the **pinned** key, never a
request-carried key (`adminMethods.ts:308`). A different self-signed key attempting
takeover is `IDEMPOTENCY_CONFLICT` (tested).

**nodeId coherence.** The binding pins the single canonical Apiary nodeId; both the
bind and register bodies carry exactly one nodeId inside the signed body, so a
divergent node fact is impossible by shape. `node.describe`, lease-audience
validation (`runStart.ts:124`), explicit placement, run projections, and event
origins all resolve `binding.nodeId`; the minted identity is signing custody only.
The service caches the binding only after a successful read, so a bind landing after
daemon start is picked up (`service.ts:114-120`). Tests use a canonical id
deliberately distinct from the minted one and assert it end-to-end through
describe → run.start → run.get.

**Corpus vocabulary parity.** The admin `IDENTIFIER` regex is byte-identical to the
corpus `common.schema.json#Identifier` that `NodeId`/`WorkingCopyId`/`ProductId`
alias, so a bound nodeId can never be corpus-invalid on later protocol surfaces.
`workingCopy` carries exactly the WorkingCopyRef fact fields
(workingCopyId/nodeId/providerId/productId/origin/revision/branch); revision is
stricter than the corpus (full 40/64-hex vs 7+) which is safe for registration.

**Fail-closed corrupt/permission handling.** Corrupt binding → `BINDING_DENIED`,
bytes preserved (tested); corrupt working-copy registry → `AUTHORITY_UNAVAILABLE`,
never overwritten (tested); corrupt node identity refuses to mint a replacement;
fingerprint is recomputed from the stored key on every read so a doubly-edited
key+fingerprint still refuses.

**Idempotency.** Bind: full-fact equality under a file lock; identical replay returns
the original record, any differing fact conflicts. Register: content idempotence via
the H1 registry (same id + same content replays, same id + different content
conflicts without mutating the registry). Both proven across a server restart.

**Path leakage.** The locator path is request-only; validation refusals never echo it;
responses, replays, conflicts, and run projections are asserted path-free (both the
`"path"` key and the path value).

**JSON-RPC wiring & H1 interaction.** Admin methods merge onto the aggregate socket
with a distinct `executionAdmin: 1` capability, available before `protocol.hello`
(a binding must be installable before any corpus method can succeed). The e2e test
drives bind → register → hello → run.start over the real socket and shows the run
claiming the admin-registered copy with durable occupancy, and
`materializeExplicitPlacement` proving product/digest/origin/revision against the
leased target.

**Test honesty.** Gate tests mutate the body *before* digesting/signing, so they carry
valid signatures over mutated bodies — they exercise the gates, not just signature
failure. Tamper tests distinguish digest breaks from signature breaks. Oversized
requests, version drift, unknown fields at every level, and the NDJSON line bound
(overflow + framing resume) are all covered.

## Minor notes (no action required for this checkpoint)

- `SERVER_MAX_LINE_BYTES` is enforced in UTF-16 code units by `makeLineReader`, so the
  true byte bound is up to ~3× the named 8 MiB. A bound still exists; naming nit only.
- After an oversized line destroys a connection, complete lines already buffered from
  the same chunk still dispatch to handlers before the close lands. Same-user socket;
  negligible.
- Registry-corruption refusals include the daemon's own `working-copies.json` store
  path in the message. That is Honeybee's store path, not the locator, and the caller
  is the same OS user; the "path-free" guarantee (locator never crosses the boundary)
  holds.
- `installLocalAuthorityHostBinding` (test/tooling seam) can replace a binding that
  the service has already cached for the process lifetime. The RPC path never
  replaces, and the seam is documented as direct-write for tests.

## Test evidence

- `npm run check` — clean (src + test tsconfigs).
- `npm test` — 2440 tests: 2431 pass, 0 fail, 9 skipped (includes the new
  `execution-admin.test.ts` end-to-end suite over the real control socket).
