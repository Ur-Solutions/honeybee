import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { firstUserText, hasTranscriptProvider, lastAssistantText, latestTranscript, renderTranscript } from "../src/transcripts.js";

type KimiFixture = { home: string; workDir: string; sessionId: string };

// Lay out a KIMI_CODE_HOME the way kimi-code does: session_index.jsonl mapping
// the session to its workDir + sessionDir, a per-session state.json with the
// title/updatedAt, and an agents/main/wire.jsonl event log.
async function seedKimiHome(): Promise<KimiFixture> {
  const home = await mkdtemp(join(tmpdir(), "honeybee-kimi-"));
  const workDir = join(home, "project");
  const sessionId = "session_abc123";
  const sessionDir = join(home, "sessions", "wd_project", sessionId);
  await mkdir(join(sessionDir, "agents", "main"), { recursive: true });

  // A second, older session in a different workDir to confirm cwd matching.
  const otherDir = join(home, "sessions", "wd_other", "session_other");
  await mkdir(join(otherDir, "agents", "main"), { recursive: true });

  await writeFile(
    join(home, "session_index.jsonl"),
    [
      JSON.stringify({ sessionId, sessionDir, workDir: resolve(workDir) }),
      JSON.stringify({ sessionId: "session_other", sessionDir: otherDir, workDir: join(home, "elsewhere") }),
    ].join("\n") + "\n",
  );

  await writeFile(
    join(sessionDir, "state.json"),
    JSON.stringify({ createdAt: "2026-06-16T08:52:46.340Z", updatedAt: "2026-06-16T08:53:01.107Z", title: "Wire up kimi reader", isCustomTitle: false, lastPrompt: "Wire up kimi reader" }),
  );
  await writeFile(
    join(sessionDir, "agents", "main", "wire.jsonl"),
    [
      JSON.stringify({ type: "metadata", protocol_version: "1.4", created_at: 1781694345771 }),
      JSON.stringify({ type: "config.update", profileName: "agent", systemPrompt: "noise" }),
      JSON.stringify({ type: "turn.prompt", input: [{ type: "text", text: "Wire up kimi reader" }], origin: { kind: "user" }, time: 1781694347792 }),
      // context.append_message repeats the same user text — must be deduped.
      JSON.stringify({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "Wire up kimi reader" }], toolCalls: [] }, time: 1781694347792 }),
      JSON.stringify({ type: "usage.record", model: "kimi-code/kimi-for-coding", usage: {}, time: 1781694350940 }),
      JSON.stringify({ type: "context.append_message", message: { role: "assistant", content: [{ type: "text", text: "Reader wired up." }] }, time: 1781694351000 }),
    ].join("\n") + "\n",
  );

  await writeFile(join(otherDir, "state.json"), JSON.stringify({ updatedAt: "2026-06-15T08:00:00.000Z", title: "Other" }));
  await writeFile(
    join(otherDir, "agents", "main", "wire.jsonl"),
    JSON.stringify({ type: "turn.prompt", input: [{ type: "text", text: "do not match" }], origin: { kind: "user" }, time: 1 }) + "\n",
  );

  return { home, workDir, sessionId };
}

test("latestTranscript reads a kimi session: title/rows/cwd match and dedup", async () => {
  const { home, workDir, sessionId } = await seedKimiHome();
  try {
    const tx = await latestTranscript("kimi", workDir, { homePath: home });

    assert.ok(tx, "expected a transcript");
    assert.equal(tx.provider, "kimi");
    assert.equal(tx.sessionId, sessionId);
    assert.equal(tx.title, "Wire up kimi reader");
    assert.equal(tx.mtimeMs, Date.parse("2026-06-16T08:53:01.107Z"));
    assert.equal(tx.matchedBy.includes("cwd"), true);
    // turn.prompt + context.append_message carry the same user text once.
    assert.equal(renderTranscript(tx.rows), "## user\nWire up kimi reader\n\n## assistant\nReader wired up.");
    assert.equal(firstUserText(tx.rows), "Wire up kimi reader");
    assert.equal(lastAssistantText(tx.rows), "Reader wired up.");
    assert.equal(hasTranscriptProvider("kimi"), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("latestTranscript scores a kimi session by prompt", async () => {
  const { home, workDir } = await seedKimiHome();
  try {
    const tx = await latestTranscript("kimi", workDir, { homePath: home, prompt: "Wire up kimi reader" });
    assert.ok(tx);
    assert.equal(tx.matchedBy.includes("prompt"), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("latestTranscript returns null for kimi when KIMI_CODE_HOME is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-kimi-absent-"));
  try {
    // No session_index.jsonl under this home.
    const tx = await latestTranscript("kimi", join(dir, "project"), { homePath: join(dir, "nope") });
    assert.equal(tx, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
