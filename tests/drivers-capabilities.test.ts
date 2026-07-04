import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BOOT_MS,
  autoAliasForcesYolo,
  bootMsForAgent,
  defaultsToSoleCredentialedAccount,
  driverDefaultsToYolo,
  forcedSessionIdArgsForAgent,
  hsrAdapterForAgent,
  resumeArgsForAgent,
  sessionPinnedInArgs,
  sessionPinResumeExtrasForAgent,
} from "../src/drivers.js";
import { adapterFor } from "../src/hsr/adapters/index.js";

test("bootMsForAgent: per-kind boot timeouts with a shared default", () => {
  assert.equal(bootMsForAgent("claude"), 15_000);
  assert.equal(bootMsForAgent("codex"), 30_000);
  assert.equal(bootMsForAgent("opencode"), 15_000);
  assert.equal(bootMsForAgent("grok"), 10_000);
  assert.equal(bootMsForAgent("droid"), 5_000);
  assert.equal(bootMsForAgent("pi"), 10_000);
  assert.equal(bootMsForAgent("cursor"), 15_000);
  // Kinds without a declared bootMs (kimi) and unknown kinds fall back.
  assert.equal(bootMsForAgent("kimi"), DEFAULT_BOOT_MS);
  assert.equal(bootMsForAgent("no-such-agent"), DEFAULT_BOOT_MS);
});

test("driverDefaultsToYolo: every harness (and unknown kinds) defaults to yolo", () => {
  for (const kind of ["claude", "codex", "opencode", "grok", "kimi", "cursor", "pi", "droid", "no-such-agent"]) {
    assert.equal(driverDefaultsToYolo(kind), true, `${kind} should default to yolo`);
  }
});

test("autoAliasForcesYolo: only codex forces yolo for <tool>-auto spawns", () => {
  assert.equal(autoAliasForcesYolo("codex"), true);
  assert.equal(autoAliasForcesYolo("claude"), false);
  assert.equal(autoAliasForcesYolo("grok"), false);
  assert.equal(autoAliasForcesYolo("no-such-agent"), false);
});

test("resumeArgsForAgent: per-provider resume forms from the registry", () => {
  assert.deepEqual(resumeArgsForAgent("claude", "abc"), ["--resume", "abc"]);
  assert.deepEqual(resumeArgsForAgent("claude", undefined), ["--continue"]);
  assert.deepEqual(resumeArgsForAgent("codex", "abc"), ["resume", "abc"]);
  assert.deepEqual(resumeArgsForAgent("codex", undefined), ["resume", "--last"]);
  assert.deepEqual(resumeArgsForAgent("opencode", "abc"), ["--session", "abc"]);
  assert.deepEqual(resumeArgsForAgent("opencode", undefined), ["--continue"]);
  assert.deepEqual(resumeArgsForAgent("grok", "abc"), []);
  assert.deepEqual(resumeArgsForAgent("no-such-agent", "abc"), []);
});

test("forcedSessionIdArgsForAgent: only claude has a stable session-id flag", () => {
  assert.deepEqual(forcedSessionIdArgsForAgent("claude", "abc-123"), ["--session-id", "abc-123"]);
  assert.equal(forcedSessionIdArgsForAgent("codex", "abc-123"), null);
  assert.equal(forcedSessionIdArgsForAgent("opencode", "abc-123"), null);
  assert.equal(forcedSessionIdArgsForAgent("no-such-agent", "abc-123"), null);
});

test("sessionPinnedInArgs: detects the driver's pin flag, never for pin-less drivers", () => {
  assert.equal(sessionPinnedInArgs("claude", ["--session-id", "abc"]), true);
  assert.equal(sessionPinnedInArgs("claude", ["--model", "opus"]), false);
  // codex has no session-id flag, so even a literal --session-id is not a pin.
  assert.equal(sessionPinnedInArgs("codex", ["--session-id", "abc"]), false);
  assert.equal(sessionPinnedInArgs("no-such-agent", ["--session-id", "abc"]), false);
});

test("sessionPinResumeExtrasForAgent: claude resumes need --fork-session next to the auto-pin", () => {
  // claude REFUSES `--resume <id> --session-id <new>` without --fork-session
  // (the CLI exits before boot and the bee reads dead), so the auto-injected
  // pin must bring the bridge flag whenever the caller's args resume.
  assert.deepEqual(sessionPinResumeExtrasForAgent("claude", ["--resume", "abc"]), ["--fork-session"]);
  assert.deepEqual(sessionPinResumeExtrasForAgent("claude", ["--continue"]), ["--fork-session"]);
  assert.deepEqual(sessionPinResumeExtrasForAgent("claude", ["--model", "opus", "--resume", "abc"]), ["--fork-session"]);
  // Already bridged, not resuming, or a driver without the interplay → nothing.
  assert.deepEqual(sessionPinResumeExtrasForAgent("claude", ["--resume", "abc", "--fork-session"]), []);
  assert.deepEqual(sessionPinResumeExtrasForAgent("claude", ["--model", "opus"]), []);
  assert.deepEqual(sessionPinResumeExtrasForAgent("codex", ["resume", "abc"]), []);
  assert.deepEqual(sessionPinResumeExtrasForAgent("no-such-agent", ["--resume", "abc"]), []);
});

test("hsrAdapterForAgent + adapterFor: registry-backed adapters and their tiers", () => {
  assert.equal(hsrAdapterForAgent("claude")?.tier(), "stream");
  assert.equal(hsrAdapterForAgent("codex")?.tier(), "server");
  assert.equal(hsrAdapterForAgent("grok"), undefined);
  // adapterFor delegates to the registry and keeps the test-only stub.
  assert.equal(adapterFor("claude"), hsrAdapterForAgent("claude"));
  assert.equal(adapterFor("codex"), hsrAdapterForAgent("codex"));
  assert.equal(adapterFor("stub")?.tier(), "stream");
  assert.equal(adapterFor("opencode"), undefined);
});

test("defaultsToSoleCredentialedAccount: grok-only bare-spawn account default", () => {
  assert.equal(defaultsToSoleCredentialedAccount("grok"), true);
  for (const kind of ["claude", "codex", "opencode", "kimi", "no-such-agent"]) {
    assert.equal(defaultsToSoleCredentialedAccount(kind), false, `${kind} should not default a sole account`);
  }
});
