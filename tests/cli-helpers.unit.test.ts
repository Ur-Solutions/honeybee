/**
 * HIVE-73 dedup helpers — pure-piece unit tests for the shared helpers that
 * replaced copy-pasted blocks in cli.ts:
 *   - resolveDefineArgs: the (formerly byte-identical) frame/flow define
 *     path/name disambiguation;
 *   - assertSingleBeeInvocation: the run/x/xa cohort-flag guard;
 *     shared by add/quest-start;
 *   - logLinesFlag/followFlag: consistent -n/--lines/-f parsing across the
 *     flow/loop/daemon log commands;
 *   - resolvePromptArg: --prompt/--prompt-file resolution shared by loop
 *     start and loop template save;
 *   - emitLog: the shared tail-and-hint log emitter.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertSingleBeeInvocation,
  emitLog,
  followFlag,
  logLinesFlag,
  resolveDefineArgs,
  resolvePromptArg,
} from "../src/cli.js";
import type { Parsed } from "../src/parse.js";
import type { SessionRecord } from "../src/store.js";

function parsedWith(flags: Record<string, string | true | string[]> = {}): Parsed {
  return { command: "test", args: [], flags: new Map(Object.entries(flags)), rest: [] };
}

function beeRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: "b1", agent: "codex", cwd: "/tmp", command: "codex", tmuxTarget: "b1",
    createdAt: "", updatedAt: "", status: "running", ...over,
  } as SessionRecord;
}

// --- resolveDefineArgs (frame/flow define share one implementation now)
test("resolveDefineArgs: single arg is the source path", () => {
  assert.deepEqual(resolveDefineArgs("frames/a.json"), { sourcePath: "frames/a.json" });
});

test("resolveDefineArgs: path+name in either order", () => {
  assert.deepEqual(resolveDefineArgs("frames/a.json", "myname"), { sourcePath: "frames/a.json", nameOverride: "myname" });
  assert.deepEqual(resolveDefineArgs("myname", "frames/a.ts"), { sourcePath: "frames/a.ts", nameOverride: "myname" });
});

test("resolveDefineArgs: ambiguous pair falls back to first-as-path", () => {
  assert.deepEqual(resolveDefineArgs("a.json", "b.json"), { sourcePath: "a.json", nameOverride: "b.json" });
  assert.deepEqual(resolveDefineArgs("plain", "names"), { sourcePath: "plain", nameOverride: "names" });
});

// --- assertSingleBeeInvocation (run/x/xa cohort guard)
test("assertSingleBeeInvocation: passes for a single-bee invocation", () => {
  assert.doesNotThrow(() => assertSingleBeeInvocation(parsedWith(), "nope"));
  assert.doesNotThrow(() => assertSingleBeeInvocation(parsedWith({ count: "1" }), "nope"));
});

test("assertSingleBeeInvocation: rejects --count > 1 and --frame with the hint", () => {
  assert.throws(() => assertSingleBeeInvocation(parsedWith({ count: "3" }), "use spawn"), /use spawn/);
  assert.throws(() => assertSingleBeeInvocation(parsedWith({ frame: "review" }), "use spawn"), /use spawn/);
});

// --- logLinesFlag/followFlag (flow/loop/daemon log flag parsing)
test("logLinesFlag: -n wins, --lines is the alias, fallback otherwise", () => {
  assert.equal(logLinesFlag(parsedWith({ n: "20" }), 50), 20);
  assert.equal(logLinesFlag(parsedWith({ lines: "80" }), 50), 80);
  assert.equal(logLinesFlag(parsedWith({ n: "20", lines: "80" }), 50), 20);
  assert.equal(logLinesFlag(parsedWith(), 50), 50);
});

test("logLinesFlag: negative and fractional values normalize", () => {
  assert.equal(logLinesFlag(parsedWith({ n: "-5" }), 50), 50);
  assert.equal(logLinesFlag(parsedWith({ lines: "2.9" }), 50), 2);
  assert.equal(logLinesFlag(parsedWith({ n: "abc" }), 50), 50);
});

test("followFlag: -f and --follow are equivalent", () => {
  assert.equal(followFlag(parsedWith()), false);
  assert.equal(followFlag(parsedWith({ f: true })), true);
  assert.equal(followFlag(parsedWith({ follow: true })), true);
});

// --- resolvePromptArg (--prompt/--prompt-file)
test("resolvePromptArg: --prompt passes through, absent flags yield empty", async () => {
  assert.equal(await resolvePromptArg(parsedWith({ prompt: "do it" })), "do it");
  assert.equal(await resolvePromptArg(parsedWith()), "");
});

test("resolvePromptArg: --prompt-file reads and trims; both flags reject", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-prompt-"));
  try {
    const file = join(dir, "prompt.txt");
    await writeFile(file, "  from file\n\n");
    assert.equal(await resolvePromptArg(parsedWith({ "prompt-file": file })), "from file");
    await assert.rejects(
      resolvePromptArg(parsedWith({ prompt: "x", "prompt-file": file })),
      /either --prompt or --prompt-file/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- emitLog (shared tail-and-hint emitter)
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

test("emitLog: emits the full text newline-terminated", async () => {
  const out = await captureStdout(() => emitLog({ text: "a\nb", path: "/tmp/x.log" }));
  assert.equal(out, "a\nb\n");
});

test("emitLog: lines trims to the last N lines (trailing newline ignored)", async () => {
  const out = await captureStdout(() => emitLog({ text: "a\nb\nc\n", path: "/tmp/x.log", lines: 2 }));
  assert.equal(out, "b\nc\n");
});

test("emitLog: lines 0 means the full log; empty text emits nothing", async () => {
  const full = await captureStdout(() => emitLog({ text: "a\nb\n", path: "/tmp/x.log", lines: 0 }));
  assert.equal(full, "a\nb\n");
  const empty = await captureStdout(() => emitLog({ text: "", path: "/tmp/x.log" }));
  assert.equal(empty, "");
});
