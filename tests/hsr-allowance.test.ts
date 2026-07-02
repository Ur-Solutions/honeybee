import assert from "node:assert/strict";
import { test } from "node:test";
import { allowanceFor, bestTier, scrubEnvFor, tierAfterFingerprint } from "../src/hsr/allowance.js";

test("bestTier: claude subscription prefers the stream tier", () => {
  assert.equal(bestTier("claude", "subscription"), "stream");
});

test("bestTier: codex subscription prefers the server tier", () => {
  assert.equal(bestTier("codex", "subscription"), "server");
});

test("scrubEnvFor: claude subscription scrubs ANTHROPIC_API_KEY", () => {
  assert.ok(scrubEnvFor("claude", "subscription").includes("ANTHROPIC_API_KEY"));
});

test("scrubEnvFor: claude api-key scrubs nothing (billing is intentional)", () => {
  assert.deepEqual(scrubEnvFor("claude", "api-key"), []);
});

test("tierAfterFingerprint: a --bare fingerprint downgrades claude to pty", () => {
  assert.equal(
    tierAfterFingerprint("claude", "subscription", "error: --bare is now the default for -p"),
    "pty",
  );
});

test("tierAfterFingerprint: no fingerprint match keeps the best tier", () => {
  assert.equal(tierAfterFingerprint("claude", "subscription", "all good here"), "stream");
});

test("allowanceFor: unknown harness returns undefined", () => {
  assert.equal(allowanceFor("nope", "subscription"), undefined);
});
