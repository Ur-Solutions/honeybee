import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeKeychainService, credentialDigest, keychainAvailable, readClaudeKeychain, writeClaudeKeychain } from "../src/keychain.js";

test("claude keychain service embeds sha256(config dir)[0..8]; default home is unsuffixed", () => {
  // Fixture verified against a real keychain produced by Claude Code.
  assert.equal(claudeKeychainService("/Users/trmd/.claude-1"), "Claude Code-credentials-a9fc6b50");
  assert.equal(claudeKeychainService(join(homedir(), ".claude")), "Claude Code-credentials");
  assert.match(claudeKeychainService("/some/other/home"), /^Claude Code-credentials-[0-9a-f]{8}$/);
  // Path normalization: trailing segments resolve identically.
  assert.equal(claudeKeychainService("/Users/trmd/.claude-1/"), claudeKeychainService("/Users/trmd/.claude-1"));
});

test("HIVE_NO_KEYCHAIN disables the bridge entirely", async () => {
  const old = process.env.HIVE_NO_KEYCHAIN;
  process.env.HIVE_NO_KEYCHAIN = "1";
  try {
    assert.equal(keychainAvailable(), false);
    assert.equal(await readClaudeKeychain("/tmp/x"), null);
    assert.equal(await writeClaudeKeychain("/tmp/x", "{}"), false);
  } finally {
    if (old === undefined) delete process.env.HIVE_NO_KEYCHAIN;
    else process.env.HIVE_NO_KEYCHAIN = old;
  }
});

test("credentialDigest is a stable content hash", () => {
  assert.equal(credentialDigest("abc"), credentialDigest("abc"));
  assert.notEqual(credentialDigest("abc"), credentialDigest("abd"));
  assert.match(credentialDigest("abc"), /^[0-9a-f]{64}$/);
});
