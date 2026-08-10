import assert from "node:assert/strict";
import { test } from "node:test";
import { isWellFormedPaneId, splitFusedPaneStamp } from "../src/paneId.js";

test("isWellFormedPaneId accepts exactly the #{pane_id} shape", () => {
  assert.equal(isWellFormedPaneId("%7"), true);
  assert.equal(isWellFormedPaneId("%0"), true);
  assert.equal(isWellFormedPaneId("%110"), true);

  // The fused mis-stamp family (review §1.1) and everything else is rejected.
  assert.equal(isWellFormedPaneId("%110_18981"), false);
  assert.equal(isWellFormedPaneId("%7\t5908"), false);
  assert.equal(isWellFormedPaneId("7"), false);
  assert.equal(isWellFormedPaneId("%"), false);
  assert.equal(isWellFormedPaneId(""), false);
  assert.equal(isWellFormedPaneId(" %7"), false);
  assert.equal(isWellFormedPaneId("%7 "), false);
  assert.equal(isWellFormedPaneId("%7:5908"), false);
  assert.equal(isWellFormedPaneId("Last login: %7"), false);
});

test("splitFusedPaneStamp recovers the tab join and its non-UTF-8 '_' sanitization", () => {
  assert.deepEqual(splitFusedPaneStamp("%7\t5908"), { paneId: "%7", pid: 5908 });
  assert.deepEqual(splitFusedPaneStamp("%110_18981"), { paneId: "%110", pid: 18981 });
});

test("splitFusedPaneStamp rejects everything that is not exactly a fused stamp", () => {
  assert.equal(splitFusedPaneStamp("%7"), null);
  assert.equal(splitFusedPaneStamp("%7:5908"), null);
  assert.equal(splitFusedPaneStamp("%7_0"), null);
  assert.equal(splitFusedPaneStamp("%7_-3"), null);
  assert.equal(splitFusedPaneStamp("%7_59x"), null);
  assert.equal(splitFusedPaneStamp("x%7_59"), null);
  assert.equal(splitFusedPaneStamp("%7_59_60"), null);
  assert.equal(splitFusedPaneStamp(""), null);
});
