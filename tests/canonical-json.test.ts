// Pins the production canonical-JSON behavior that peers (Apiary) align to.
//
// canonicalJson sorts keys lexicographically and then rebuilds a JS object,
// which re-orders INTEGER-LIKE keys numerically ("2" before "10") per JS
// object semantics. That composite behavior is the long-standing Comb digest
// primitive; its bytes are load-bearing (existing digests/signatures), so this
// suite is a tripwire: if these assertions ever fail, digests of previously
// signed data change. Apiary's serializer aligns to THIS behavior — do not
// "fix" the numeric ordering here without a coordinated digest migration.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canonicalDigest, canonicalJson } from "../src/comb/canonical.js";

test("canonicalJson: string keys sort lexicographically", () => {
  assert.equal(canonicalJson({ b: 1, a: 2, C: 3 }), '{"C":3,"a":2,"b":1}');
});

test("canonicalJson: integer-like keys serialize in numeric order (pinned production behavior)", () => {
  // Lexicographic would be "10" before "2"; JS object key order puts integer
  // -like keys numerically first. This is the behavior peers must match.
  assert.equal(canonicalJson({ "2": "two", "10": "ten" }), '{"2":"two","10":"ten"}');
  assert.equal(canonicalJson({ "10": "ten", "2": "two" }), '{"2":"two","10":"ten"}');
  // Mixed keys: integer-like keys first (numeric), then string keys (sorted).
  assert.equal(canonicalJson({ b: 0, "10": 1, a: 2, "2": 3 }), '{"2":3,"10":1,"a":2,"b":0}');
});

test("canonicalJson: nesting, arrays, and digest stability", () => {
  assert.equal(canonicalJson({ z: [{ b: 1, a: [null, true] }], y: "s" }), '{"y":"s","z":[{"a":[null,true],"b":1}]}');
  assert.equal(
    canonicalDigest({ "2": "two", "10": "ten" }),
    canonicalDigest({ "10": "ten", "2": "two" }),
  );
});
