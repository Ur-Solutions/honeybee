import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { persistSessionTranscriptMetadata, refreshSessionTranscriptMetadata } from "../src/sessionMetadata.js";
import { loadSession, saveSession, type SessionRecord } from "../src/store.js";
import type { TranscriptFile } from "../src/transcripts.js";

async function withTempStore(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hive-session-metadata-"));
  const previous = process.env.HIVE_STORE_ROOT;
  process.env.HIVE_STORE_ROOT = root;
  try {
    await fn(root);
  } finally {
    if (previous === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function bee(name: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    agent: "claude",
    cwd: "/tmp/workspace",
    command: "claude",
    tmuxTarget: name,
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

function claudeProjectKey(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

test("crashed HSR bee never adopts a live sibling transcript from spawn proximity", async () => {
  await withTempStore(async (root) => {
    const cwd = join(root, "workspace");
    const home = join(root, "claude-home");
    const transcriptDir = join(home, "projects", claudeProjectKey(cwd));
    const siblingPath = join(transcriptDir, "sibling-provider-a097.jsonl");
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      siblingPath,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-18T12:00:19.000Z",
          message: { role: "user", content: "work belonging to CL.454" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-18T12:00:20.000Z",
          message: { role: "assistant", content: "CL.454 is running" },
        }),
      ].join("\n") + "\n",
    );
    await utimes(siblingPath, new Date("2026-07-18T12:01:00.000Z"), new Date("2026-07-18T12:01:00.000Z"));

    const crashed = bee("CL.e74", {
      cwd,
      homePath: home,
      substrate: "hsr",
      providerSessionId: "own-provider-e77",
      lastPrompt: "work belonging to CL.e74",
      lastPromptAt: "2026-07-18T12:00:00.000Z",
      lastObservedState: "crashed",
    });
    const liveSibling = bee("CL.454", {
      cwd,
      homePath: home,
      createdAt: "2026-07-18T12:00:19.000Z",
      updatedAt: "2026-07-18T12:01:00.000Z",
      providerSessionId: "sibling-provider-a097",
      transcriptPath: siblingPath,
      lastObservedState: "working",
    });
    await saveSession(crashed);
    await saveSession(liveSibling);

    await refreshSessionTranscriptMetadata(crashed);

    const stored = await loadSession(crashed.name);
    assert.equal(stored?.providerSessionId, "own-provider-e77");
    assert.equal(stored?.transcriptPath, undefined);
    assert.equal(stored?.title, undefined);
  });
});

test("prompt evidence cannot replace an existing provider identity", async () => {
  await withTempStore(async () => {
    const record = bee("CL.anchored", {
      providerSessionId: "own-session",
      lastPrompt: "repeated task",
      lastPromptAt: "2026-07-18T12:00:00.000Z",
    });
    await saveSession(record);
    const sibling: TranscriptFile = {
      provider: "claude",
      path: "/tmp/sibling.jsonl",
      sessionId: "sibling-session",
      mtimeMs: 1,
      rows: [],
      score: 800,
      matchedBy: ["mtime", "prompt", "spawn-proximity"],
      title: "Sibling title",
    };

    await persistSessionTranscriptMetadata(record, sibling);

    const stored = await loadSession(record.name);
    assert.equal(stored?.providerSessionId, "own-session");
    assert.equal(stored?.transcriptPath, undefined);
    assert.equal(stored?.title, undefined);
  });
});

test("an unanchored bee cannot claim prompt-matched metadata owned by another sibling", async () => {
  await withTempStore(async () => {
    const target = bee("CL.target", { lastPrompt: "same prompt", lastPromptAt: "2026-07-18T12:00:00.000Z" });
    const owner = bee("CL.owner", {
      providerSessionId: "owned-session",
      transcriptPath: "/tmp/owned.jsonl",
      lastObservedState: "working",
    });
    await saveSession(target);
    await saveSession(owner);
    const transcript: TranscriptFile = {
      provider: "claude",
      path: "/tmp/owned.jsonl",
      sessionId: "owned-session",
      mtimeMs: 1,
      rows: [],
      score: 500,
      matchedBy: ["mtime", "prompt"],
      title: "Owner title",
    };

    await persistSessionTranscriptMetadata(target, transcript);

    const stored = await loadSession(target.name);
    assert.equal(stored?.providerSessionId, undefined);
    assert.equal(stored?.transcriptPath, undefined);
    assert.equal(stored?.title, undefined);
  });
});

test("terminal sibling records retain transcript ownership against heuristic adoption", async () => {
  await withTempStore(async () => {
    const target = bee("CL.target", { lastPrompt: "same prompt", lastPromptAt: "2026-07-18T12:00:00.000Z" });
    const historical = bee("CL.historical", {
      status: "archived",
      providerSessionId: "historical-session",
      transcriptPath: "/tmp/historical.jsonl",
      lastObservedState: "crashed",
    });
    await saveSession(target);
    await saveSession(historical);
    const transcript: TranscriptFile = {
      provider: "claude",
      path: "/tmp/historical.jsonl",
      sessionId: "historical-session",
      mtimeMs: 1,
      rows: [],
      score: 500,
      matchedBy: ["mtime", "prompt"],
      title: "Historical title",
    };

    await persistSessionTranscriptMetadata(target, transcript);

    const stored = await loadSession(target.name);
    assert.equal(stored?.providerSessionId, undefined);
    assert.equal(stored?.transcriptPath, undefined);
    assert.equal(stored?.title, undefined);
  });
});

test("an explicit stored session id still permits legitimate resume metadata", async () => {
  await withTempStore(async () => {
    const resumed = bee("CL.resumed", { providerSessionId: "resume-session" });
    const historical = bee("CL.historical", {
      providerSessionId: "resume-session",
      transcriptPath: "/tmp/resume.jsonl",
      lastObservedState: "crashed",
    });
    await saveSession(resumed);
    await saveSession(historical);
    const transcript: TranscriptFile = {
      provider: "claude",
      path: "/tmp/resume.jsonl",
      sessionId: "resume-session",
      mtimeMs: 1,
      rows: [],
      score: 1_000,
      matchedBy: ["mtime", "session-id"],
      title: "Resumed work",
    };

    await persistSessionTranscriptMetadata(resumed, transcript);

    const stored = await loadSession(resumed.name);
    assert.equal(stored?.providerSessionId, "resume-session");
    assert.equal(stored?.transcriptPath, "/tmp/resume.jsonl");
    assert.equal(stored?.title, "Resumed work");
  });
});
