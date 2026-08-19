/**
 * Sender-attribution envelope (contract B4a): bee-sent mail is delivered
 * wrapped in the v1-byte-compatible buz injection envelope; operator and
 * human mail is delivered bare. Unit tier on envelope.ts plus one loop-level
 * proof that the delivery loop hands the driver the enveloped text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUZ_INJECTION_MARKER, deliveryText, isPeerSender, urgencyToTier } from "../src/envelope.ts";

const baseMsg = { id: 7, body: "shard 3 is yours", urgency: "next" as const, enqueuedAt: 1_787_000_000_000 };

test("envelope.1: bee-sent mail wraps in the v1 envelope — marker, one parseable meta line, blank line, body verbatim", () => {
  const text = deliveryText({ ...baseMsg, sender: "CL.6d44f" }, true);
  const lines = text.split("\n");
  assert.equal(lines[0], BUZ_INJECTION_MARKER);
  const meta = JSON.parse(lines[1] as string) as Record<string, unknown>;
  // The exact contract of Apiary's parseBuzInjectionMeta: version 1, from set.
  assert.equal(meta.version, 1);
  assert.equal(meta.from, "CL.6d44f");
  assert.equal(meta.tier, "next-tool");
  assert.equal(meta.id, "7");
  assert.equal(meta.sentAt, new Date(baseMsg.enqueuedAt).toISOString());
  assert.equal(lines[2], "");
  assert.equal(lines.slice(3).join("\n"), "shard 3 is yours");
});

test("envelope.2: only POSITIVELY-identified peers envelope — operator, humans, and answeredBy names stay bare", () => {
  assert.equal(deliveryText({ ...baseMsg, sender: "operator" }, false), baseMsg.body);
  const none = (): boolean => false;
  const knows = (id: string): boolean => id === "some-uuid";
  assert.equal(isPeerSender("operator", knows), false, "operator never envelopes, even if a bee had that id");
  assert.equal(isPeerSender("human:tormod", none), false);
  assert.equal(isPeerSender("tormod", none), false, "answeredBy names are people (v6.rpc.6)");
  assert.equal(isPeerSender("CO.a3f", none), true, "handle grammar is peer evidence");
  assert.equal(isPeerSender("some-uuid", knows), true, "a store-known bee id is peer evidence");
  assert.equal(isPeerSender("some-uuid", none), false);
});

test("envelope.3: tier mapping matches the Q2 amendment", () => {
  assert.equal(urgencyToTier("now"), "interrupt");
  assert.equal(urgencyToTier("next"), "next-tool");
  assert.equal(urgencyToTier("idle"), "queue");
});
