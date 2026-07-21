import assert from "node:assert/strict";
import { test } from "node:test";
import { activationKey, judgeActivationEvidence } from "../src/activation.js";

const CLAIM = { taskId: "FL.x/s3", attempt: 2, attemptStartedAt: "2026-07-20T10:00:00.000Z" };

test("activationKey: scope:claimant:attempt", () => {
  assert.equal(activationKey("FL.x", "s3", 2), "FL.x:s3:2");
  assert.equal(activationKey("run-9", "nodeA", 1), "run-9:nodeA:1");
});

test("judgeActivationEvidence: absent or stale evidence is none", () => {
  assert.equal(judgeActivationEvidence(CLAIM, null), "none");
  assert.equal(judgeActivationEvidence(CLAIM, undefined), "none");
  assert.equal(judgeActivationEvidence(CLAIM, { recordedAt: "2026-07-20T09:59:59.999Z", taskId: "FL.x/s3", attempt: 2 }), "none");
});

test("judgeActivationEvidence: fresh but disagreeing correlation keys are a mismatch", () => {
  assert.equal(judgeActivationEvidence(CLAIM, { recordedAt: "2026-07-20T10:01:00.000Z", taskId: "FL.y/s1" }), "mismatch");
  assert.equal(judgeActivationEvidence(CLAIM, { recordedAt: "2026-07-20T10:01:00.000Z", attempt: 1 }), "mismatch");
});

test("judgeActivationEvidence: fresh evidence agreeing on every carried key matches", () => {
  assert.equal(judgeActivationEvidence(CLAIM, { recordedAt: "2026-07-20T10:01:00.000Z", taskId: "FL.x/s3", attempt: 2 }), "match");
  // keys the evidence does not carry are not required
  assert.equal(judgeActivationEvidence(CLAIM, { recordedAt: "2026-07-20T10:01:00.000Z" }), "match");
});

test("judgeActivationEvidence: a claim without attemptStartedAt (legacy) skips time scoping", () => {
  const legacy = { taskId: "FL.x/s3", attempt: 2 };
  assert.equal(judgeActivationEvidence(legacy, { recordedAt: "2020-01-01T00:00:00.000Z", taskId: "FL.x/s3" }), "match");
});
