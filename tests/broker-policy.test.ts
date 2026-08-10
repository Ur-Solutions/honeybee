import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BROKER_OPS,
  decideBrokerPolicy,
  loadBrokerAcl,
  type BrokerAcl,
} from "../src/daemon/brokerPolicy.js";

test("broker policy allows every v1 operation when caller acts as itself", () => {
  for (const op of BROKER_OPS) {
    assert.deepEqual(decideBrokerPolicy({ op, callerBee: "CL.self", subjectBee: "CL.self" }), {
      allowed: true,
      reason: "self operation",
      source: "default-self",
    });
  }
});

test("broker policy denies cross-bee subjects by default", () => {
  for (const op of BROKER_OPS) {
    const decision = decideBrokerPolicy({ op, callerBee: "CL.self", subjectBee: "CL.other" });
    assert.equal(decision.allowed, false, op);
    assert.equal(decision.source, "deny", op);
    assert.match(decision.reason, /CL\.other is not granted/, op);
  }
});

test("broker policy accepts exact and wildcard per-bee grants", () => {
  const acl: BrokerAcl = {
    "CL.coordinator": {
      "broker:state": ["CL.worker"],
      "broker:seal": ["*"],
    },
  };
  assert.equal(decideBrokerPolicy({
    op: "broker:state",
    callerBee: "CL.coordinator",
    subjectBee: "CL.worker",
  }, acl).source, "acl");
  assert.equal(decideBrokerPolicy({
    op: "broker:seal",
    callerBee: "CL.coordinator",
    subjectBee: "CL.any",
  }, acl).source, "acl");
  assert.equal(decideBrokerPolicy({
    op: "broker:buz-inbox",
    callerBee: "CL.coordinator",
    subjectBee: "CL.worker",
  }, acl).allowed, false);
});

test("broker policy rejects unknown operations and missing identities", () => {
  assert.deepEqual(decideBrokerPolicy({
    op: "broker:nope",
    callerBee: "CL.self",
    subjectBee: "CL.self",
  }), {
    allowed: false,
    reason: "unknown broker operation: broker:nope",
    source: "deny",
  });
  assert.match(decideBrokerPolicy({
    op: "broker:state",
    callerBee: "",
    subjectBee: "CL.self",
  }).reason, /calling bee identity is required/);
  assert.match(decideBrokerPolicy({
    op: "broker:state",
    callerBee: "CL.self",
    subjectBee: "",
  }).reason, /subject bee identity is required/);
});

test("broker ACL loader accepts the keyed file shape and fails closed on bad entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-broker-policy-"));
  try {
    const path = join(dir, "broker-acl.json");
    await writeFile(path, JSON.stringify({
      "CL.coordinator": {
        "broker:state": ["CL.worker"],
      },
    }));
    assert.deepEqual(await loadBrokerAcl(path), {
      "CL.coordinator": {
        "broker:state": ["CL.worker"],
      },
    });

    await writeFile(path, JSON.stringify({ "CL.coordinator": { "broker:nope": ["CL.worker"] } }));
    await assert.rejects(loadBrokerAcl(path), /unknown operation broker:nope/);

    await writeFile(path, "not json");
    await assert.rejects(loadBrokerAcl(path), /invalid broker ACL JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing optional broker ACL loads as the default empty policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-broker-policy-missing-"));
  try {
    assert.deepEqual(await loadBrokerAcl(join(dir, "missing.json")), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
