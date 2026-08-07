import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { buildAddGenericPasswordCommand, claudeKeychainService, credentialDigest, decodeSecurityPasswordOutput, identityOnlyCredentials, keychainAvailable, readClaudeKeychain, readClaudeKeychainState, writeClaudeKeychainEntry } from "../src/keychain.js";

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
    assert.deepEqual(await writeClaudeKeychainEntry("/tmp/x", "{}"), { ok: false, reason: "unavailable" });
  } finally {
    if (old === undefined) delete process.env.HIVE_NO_KEYCHAIN;
    else process.env.HIVE_NO_KEYCHAIN = old;
  }
});

test("keychain reads distinguish explicit absence from unreadable and preserve present raw bytes", async () => {
  const home = "/tmp/keychain-read-state";
  const read = (execSecurity: (args: string[]) => Promise<{ stdout: string }>) => readClaudeKeychainState(home, {
    available: () => true,
    execSecurity,
  });

  assert.deepEqual(await read(async () => {
    throw Object.assign(new Error("not found"), {
      code: 44,
      stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
    });
  }), { status: "absent" });
  assert.deepEqual(await read(async () => {
    throw Object.assign(new Error("ambiguous security failure"), { code: 44 });
  }), { status: "unreadable", reason: "security-error" }, "exit-code truncation alone is not explicit absence");
  assert.deepEqual(await read(async () => {
    throw Object.assign(new Error("User interaction is not allowed"), { code: 36 });
  }), { status: "unreadable", reason: "security-error" });
  assert.deepEqual(await read(async () => {
    throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true });
  }), { status: "unreadable", reason: "timeout" });

  // Exit zero means the item exists even when its payload is malformed/empty;
  // only the explicit item-not-found status above is absence.
  assert.deepEqual(await read(async () => ({ stdout: "\n" })), { status: "present", raw: "" });
  const healthy = '{"claudeAiOauth":{"accessToken":"a","expiresAt":1}}';
  assert.deepEqual(await read(async () => ({ stdout: `${healthy}\n` })), { status: "present", raw: healthy });
});

test("buildAddGenericPasswordCommand stores compact Claude JSON as a plain password", () => {
  const secret = JSON.stringify({ a: 'b\\c "d"' }, null, 2);
  const compact = JSON.stringify(JSON.parse(secret));
  const quoted = `"${compact.replace(/[\\"]/g, "\\$&")}"`;
  assert.equal(
    buildAddGenericPasswordCommand("me", "Claude Code-credentials", secret),
    `add-generic-password -U -a "me" -s "Claude Code-credentials" -w ${quoted}`,
  );
  // The optional keychain path becomes a trailing quoted token.
  assert.equal(
    buildAddGenericPasswordCommand("me", "svc", "pw", "/tmp/kc db"),
    `add-generic-password -U -a "me" -s "svc" -w "pw" "/tmp/kc db"`,
  );
});

test("security hex rendering is normalized to JSON at the bridge boundary", () => {
  const json = JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt: 123 } });
  assert.equal(decodeSecurityPasswordOutput(Buffer.from(json).toString("hex")), json);
  assert.equal(decodeSecurityPasswordOutput(json), json);
  assert.equal(decodeSecurityPasswordOutput("deadbeef"), "deadbeef", "non-JSON hex is not guessed into credentials");
});

test("buildAddGenericPasswordCommand compacts oversize JSON, fails closed when even that overflows", () => {
  // An array pretty-prints one element per line, so the exact form grows
  // over the interpreter's ~4KB line buffer while the compact form
  // stays well under it. Assert both preconditions so size drift is loud.
  const payload = { claudeAiOauth: { scopes: Array.from({ length: 350 }, () => "ab") } };
  const oversizePretty = JSON.stringify(payload, null, 2);
  const compact = JSON.stringify(payload);
  assert.ok(oversizePretty.length > 4100, "precondition: exact form must overflow the line budget");
  assert.ok(compact.length < 3900, "precondition: compact form must fit the line budget");
  const command = buildAddGenericPasswordCommand("me", "svc", oversizePretty);
  assert.notEqual(command, null);
  assert.match(command!, / -w /);
  assert.doesNotMatch(command!, /[\r\n]/);
  // Too big even compacted → null (fail closed; argv is never a fallback).
  const huge = JSON.stringify({ claudeAiOauth: { accessToken: "x".repeat(5000) } });
  assert.equal(buildAddGenericPasswordCommand("me", "svc", huge), null);
  // Oversize and not JSON → cannot compact → null.
  assert.equal(buildAddGenericPasswordCommand("me", "svc", "z".repeat(5000)), null);
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
test("security -i writes Claude-format credentials as raw JSON, not hex text (macOS only)", { skip: process.platform !== "darwin" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-keychain-test-"));
  const keychain = join(dir, "test.keychain-db");
  try {
    await execFileAsync("security", ["create-keychain", "-p", "test", keychain]);
    // Real Claude-shaped, ASCII OAuth JSON. Pretty input is deliberately
    // compacted: Claude requires a plain password whose `security -w` output
    // begins with `{`, not a hex representation beginning with `7b`.
    const secret = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-example",
        refreshToken: "sk-ant-ort01-example",
        expiresAt: 1_797_782_400_000,
        scopes: ["user:inference", "user:profile"],
      },
    }, null, 2);
    const command = buildAddGenericPasswordCommand("hive-test", "hive-test-svc", secret, keychain);
    assert.notEqual(command, null);
    const pending = execFileAsync("security", ["-i"], { timeout: 60_000 });
    pending.child.stdin?.end(`${command}\n`);
    await pending;
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-w", "-s", "hive-test-svc", keychain], { timeout: 60_000 });
    // Claude's required format: find -w returns JSON text, never a hex blob.
    const raw = stdout.trim();
    assert.equal(raw.startsWith("{"), true, raw.slice(0, 32));
    assert.deepEqual(JSON.parse(raw), JSON.parse(secret));
  } finally {
    await execFileAsync("security", ["delete-keychain", keychain]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("identityOnlyCredentials extracts the claudeAiOauth identity and drops siblings", () => {
  // The oversize driver in the wild: mcpOAuth alone (~2KB of connector
  // tokens) pushes a merged entry past the `security -i` line budget, so the
  // full write fails while the identity subset fits with room to spare. The
  // fallback must always be able to stamp the identity — a keychain kept on
  // a previous account's token silently bills every bee on the home to the
  // wrong account (observed live 2026-07-03).
  const merged = JSON.stringify(
    {
      claudeAiOauth: { accessToken: "sk-ant-oat01-abc", refreshToken: "sk-ant-ort01-def", expiresAt: 1783112557760 },
      mcpOAuth: { server: { accessToken: "m".repeat(4500) } },
    },
    null,
    2,
  );
  assert.equal(buildAddGenericPasswordCommand("me", "svc", merged), null, "precondition: the full merge must overflow the line budget");
  const minimal = identityOnlyCredentials(merged);
  assert.notEqual(minimal, null);
  assert.deepEqual(JSON.parse(minimal!), { claudeAiOauth: { accessToken: "sk-ant-oat01-abc", refreshToken: "sk-ant-ort01-def", expiresAt: 1783112557760 } });
  assert.notEqual(buildAddGenericPasswordCommand("me", "svc", minimal!), null, "the identity subset must fit the line budget");
  // No claudeAiOauth key, or not JSON → nothing to extract.
  assert.equal(identityOnlyCredentials(JSON.stringify({ mcpOAuth: {} })), null);
  assert.equal(identityOnlyCredentials("not json"), null);
});

test("credentialDigest is a stable content hash", () => {
  assert.equal(credentialDigest("abc"), credentialDigest("abc"));
  assert.notEqual(credentialDigest("abc"), credentialDigest("abd"));
  assert.match(credentialDigest("abc"), /^[0-9a-f]{64}$/);
});
