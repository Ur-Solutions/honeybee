// Conformance runner for the execution protocol corpus (slice C0 exit gate).
// The corpus self-validates, the digest is deterministic and committed, and
// the negotiation/idempotency/state-machine fixtures behave as the RFC
// requires. Apiary (C1) loads the same corpus and must see the same digest.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalDigest } from "../src/comb/canonical.js";
import { runConformance } from "../src/execution/conformance.js";
import {
  computeSchemaDigest,
  createExecutionValidator,
  isTransitionAllowed,
  loadExecutionContract,
} from "../src/execution/contract.js";
import type { JsonValue } from "../src/comb/types.js";

const contract = loadExecutionContract();

test("execution corpus passes full conformance", () => {
  const report = runConformance(contract);
  assert.deepEqual(report.issues, []);
  assert.equal(report.ok, true);
  assert.ok(report.counts.schemas >= 28, `expected the full schema set, saw ${report.counts.schemas}`);
  assert.ok(report.counts.values >= 40, `expected the golden corpus, saw ${report.counts.values} values`);
  assert.ok(report.counts.transitions >= 7);
  assert.ok(report.counts.negotiations >= 3);
});

test("schema digest is deterministic and committed", () => {
  const first = computeSchemaDigest(contract);
  const second = computeSchemaDigest(loadExecutionContract());
  assert.equal(first, second);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(contract.committedDigest, first);
});

test("any schema change moves the digest", () => {
  const mutated = loadExecutionContract();
  const schema = structuredClone(mutated.schemas.get("run-intent"))!;
  (schema.properties as Record<string, JsonValue>).sneakyField = { type: "string" };
  mutated.schemas.set("run-intent", schema);
  assert.notEqual(computeSchemaDigest(mutated), computeSchemaDigest(contract));
});

test("unknown fields fail closed on golden values", () => {
  const validator = createExecutionValidator(contract);
  const hello = contract.fixtures.find((f) => f.valid && f.schema === "protocol-hello-request");
  assert.ok(hello);
  const value = structuredClone(hello.values[0]) as Record<string, JsonValue>;
  assert.equal(validator.validate("protocol-hello-request", value).valid, true);
  value.surprise = true;
  assert.equal(validator.validate("protocol-hello-request", value).valid, false);
});

test("state machines answer transition queries", () => {
  assert.equal(isTransitionAllowed(contract, "run", "running", "lost"), true);
  assert.equal(isTransitionAllowed(contract, "run", "lost", "recovering"), true);
  assert.equal(isTransitionAllowed(contract, "run", "completed", "running"), false);
  assert.equal(isTransitionAllowed(contract, "run", "allocating", "cancelled"), false);
  assert.equal(isTransitionAllowed(contract, "environment", "sealed", "releasing"), true);
  assert.equal(isTransitionAllowed(contract, "environment", "ready", "retained"), false);
  assert.equal(isTransitionAllowed(contract, "lease", "offered", "active"), false);
  assert.equal(isTransitionAllowed(contract, "command", "dispatching", "indeterminate"), true);
  assert.throws(() => isTransitionAllowed(contract, "job", "queued", "active"), /unknown state machine entity/);
});

test("negotiation corpus includes a required-feature rejection", () => {
  const incompatible = contract.negotiations
    .map((n) => n.response as Record<string, JsonValue>)
    .find((response) => response.compatibility === "incompatible");
  assert.ok(incompatible, "expected an incompatible negotiation fixture");
  assert.ok((incompatible.missingRequiredFeatures as string[]).length > 0);
});

test("reserved runtime-target schemas are fail-closed", () => {
  const validator = createExecutionValidator(contract);
  for (const name of ["runtime-target-ref", "runtime-target-descriptor", "attach-lease", "active-attachment-ref"]) {
    assert.equal(validator.validate(name, {}).valid, false, `${name} must reject everything while reserved`);
    assert.equal(contract.schemas.get(name)?.["x-reserved"], "runtime-target-v1");
  }
});

test("golden envelopes carry canonical body digests", () => {
  const envelopes = contract.fixtures.filter((f) => f.valid && f.schema === "execution-request-envelope");
  assert.ok(envelopes.length >= 8, "expected an envelope fixture per effect method");
  for (const fixture of envelopes) {
    for (const value of fixture.values) {
      const doc = value as Record<string, JsonValue>;
      assert.equal(doc.requestDigest, canonicalDigest(doc.body as JsonValue), fixture.path);
    }
  }
});

test("tampering with an envelope body breaks its effect digest", () => {
  const start = contract.fixtures.find((f) => f.valid && f.path.endsWith("run-start-envelope.json"));
  assert.ok(start);
  const doc = structuredClone(start.values[0]) as {
    requestDigest: string;
    body: { intent: Record<string, JsonValue> };
  };
  doc.body.intent.placement = "canonical";
  assert.notEqual(canonicalDigest(doc.body as JsonValue), doc.requestDigest);
});

test("run.start replay fixtures share one receipt across transport requests", () => {
  const byPath = (suffix: string) =>
    contract.fixtures.find((f) => f.path.endsWith(suffix))?.values[0] as Record<string, JsonValue> | undefined;
  const created = byPath("run-start-receipt.json");
  const replayed = byPath("run-start-receipt-replayed.json");
  assert.ok(created && replayed);
  assert.notEqual(created.requestId, replayed.requestId);
  const createdReceipt = created.receipt as Record<string, JsonValue>;
  const replayedReceipt = replayed.receipt as Record<string, JsonValue>;
  assert.equal(createdReceipt.receiptId, replayedReceipt.receiptId);
  assert.equal(createdReceipt.effectKey, replayedReceipt.effectKey);
  assert.equal(createdReceipt.requestDigest, replayedReceipt.requestDigest);
  assert.equal(createdReceipt.outcome, "created");
  assert.equal(replayedReceipt.outcome, "replayed");
});
