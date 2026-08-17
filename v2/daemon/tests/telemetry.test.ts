/** Spec 04 behavior 5: the i1_violations table — durable, deduped, ledger-shaped. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryStore, formatI1Violation } from "../src/telemetry.ts";
import type { I1ViolationEvent } from "../src/loops.ts";

const V: I1ViolationEvent = {
  detectedAt: 5000,
  beeId: "bee-1",
  messageId: 7,
  enqueuedAt: 1000,
  deadline: 4000,
  detail: "message 7 undelivered past deadline",
};

test("telemetry.1: violation rows persist, dedup by message id across reopen, and count", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-tel-"));
  const path = join(dir, "telemetry.sqlite3");
  try {
    const t1 = new TelemetryStore(path);
    assert.equal(t1.i1Count(), 0);
    assert.equal(t1.recordI1(V, ["op1", "op2"]), true);
    assert.equal(t1.recordI1(V), false, "same message: recorded once");
    assert.equal(t1.recordI1({ ...V, messageId: 8 }), true);
    assert.equal(t1.i1Count(), 2);
    t1.close();
    // A daemon restart re-detecting the same breach must not double-count.
    const t2 = new TelemetryStore(path);
    assert.equal(t2.recordI1(V), false);
    assert.equal(t2.i1Count(), 2);
    const rows = t2.listI1();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.messageId, 7);
    assert.equal(rows[0]?.invariant, "I1");
    assert.deepEqual(rows[0]?.ops, ["op1", "op2"]);
    t2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry.2: the log line matches the harness ledger shape", () => {
  const line = JSON.parse(formatI1Violation(V, ["a"])) as Record<string, unknown>;
  assert.deepEqual(Object.keys(line).sort(), ["bee", "detail", "invariant", "ops", "step"]);
  assert.equal(line.invariant, "I1");
  assert.equal(line.bee, "bee-1");
});
