import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildAddGenericPasswordCommand, claudeKeychainService, credentialDigest, keychainAvailable, readClaudeKeychain, writeClaudeKeychain } from "../src/keychain.js";

const execFileAsync = promisify(execFile);

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

test("buildAddGenericPasswordCommand hex-encodes the secret and quotes the other tokens", () => {
  // Hex sidesteps the `security -i` tokenizer entirely: quotes, backslashes,
  // and the newlines of pretty-printed merged JSON all round-trip.
  const secret = '{\n  "a": "b\\c \\"d\\""\n}';
  const hex = Buffer.from(secret, "utf8").toString("hex");
  assert.equal(
    buildAddGenericPasswordCommand("me", "Claude Code-credentials", secret),
    `add-generic-password -U -a "me" -s "Claude Code-credentials" -X ${hex}`,
  );
  // The optional keychain path becomes a trailing quoted token.
  assert.equal(
    buildAddGenericPasswordCommand("me", "svc", "pw", "/tmp/kc db"),
    `add-generic-password -U -a "me" -s "svc" -X ${Buffer.from("pw").toString("hex")} "/tmp/kc db"`,
  );
});

test("buildAddGenericPasswordCommand compacts oversize JSON, fails closed when even that overflows", () => {
  // An array pretty-prints one element per line, so the exact bytes hex to
  // well over the interpreter's ~4KB line buffer while the compact form
  // stays well under it. Assert both preconditions so size drift is loud.
  const payload = { claudeAiOauth: { scopes: Array.from({ length: 350 }, () => "ab") } };
  const oversizePretty = JSON.stringify(payload, null, 2);
  const compact = JSON.stringify(payload);
  assert.ok(oversizePretty.length * 2 > 4100, "precondition: exact form must overflow the line budget");
  assert.ok(compact.length * 2 < 3900, "precondition: compact form must fit the line budget");
  const command = buildAddGenericPasswordCommand("me", "svc", oversizePretty);
  assert.notEqual(command, null);
  const hex = command!.split(" -X ")[1]!;
  assert.equal(Buffer.from(hex, "hex").toString("utf8"), compact);
  // Too big even compacted → null (fail closed; argv is never a fallback).
  const huge = JSON.stringify({ claudeAiOauth: { accessToken: "x".repeat(3000) } });
  assert.equal(buildAddGenericPasswordCommand("me", "svc", huge), null);
  // Oversize and not JSON → cannot compact → null.
  assert.equal(buildAddGenericPasswordCommand("me", "svc", "z".repeat(3000)), null);
});

test("buildAddGenericPasswordCommand rejects account/service values that break the line protocol", () => {
  assert.equal(buildAddGenericPasswordCommand("me", "svc\nrogue", "pw"), null);
  assert.equal(buildAddGenericPasswordCommand("me\rrogue", "svc", "pw"), null);
  assert.equal(buildAddGenericPasswordCommand("me", "svc", "pw", "/tmp/kc\ndb"), null);
});

// End-to-end check of the stdin path against the real `security` tokenizer,
// isolated in a throwaway keychain file so the developer's login keychain is
// never touched. Exercises the same command construction writeClaudeKeychain
// uses, with the explicit keychain-path argument targeting the fixture.
test("security -i round-trips a hostile secret byte-for-byte (macOS only)", { skip: process.platform !== "darwin" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-keychain-test-"));
  const keychain = join(dir, "test.keychain-db");
  try {
    await execFileAsync("security", ["create-keychain", "-p", "test", keychain]);
    // Pretty-printed like mergeCredentialsJson output: multi-line, quotes,
    // backslashes, shell metacharacters, unicode.
    const secret = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-x"y\\z', weird: "q'{}[]$`!* #;|&<>()~^%\téé😀" },
    }, null, 2);
    const command = buildAddGenericPasswordCommand("hive-test", "hive-test-svc", secret, keychain);
    assert.notEqual(command, null);
    const pending = execFileAsync("security", ["-i"], { timeout: 60_000 });
    pending.child.stdin?.end(`${command}\n`);
    await pending;
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-w", "-s", "hive-test-svc", keychain], { timeout: 60_000 });
    // find -w hex-encodes non-plain (here: multi-line) data — decode, exactly
    // as readClaudeKeychain consumers do via decodeClaudeCredentialsRaw.
    const raw = stdout.trim();
    const got = /^[0-9a-f]+$/.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, "hex").toString("utf8") : raw;
    assert.equal(got, secret);
  } finally {
    await execFileAsync("security", ["delete-keychain", keychain]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credentialDigest is a stable content hash", () => {
  assert.equal(credentialDigest("abc"), credentialDigest("abc"));
  assert.notEqual(credentialDigest("abc"), credentialDigest("abd"));
  assert.match(credentialDigest("abc"), /^[0-9a-f]{64}$/);
});
