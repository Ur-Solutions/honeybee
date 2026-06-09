import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { hasTranscriptProvider, lastAssistantText, latestTranscript, projectKeyForCwd, renderTranscript } from "../src/transcripts.js";

test("latestTranscript inherits Claude ai-title metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-claude-title-"));
  try {
    const cwd = join(dir, "workspace");
    const projectDir = join(dir, "projects", projectKeyForCwd(cwd));
    const chatPath = join(projectDir, "session-1.jsonl");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      chatPath,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "Please repair title inheritance." } }),
        JSON.stringify({ type: "ai-title", sessionId: "session-1", aiTitle: "Repair Title Inheritance" }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Done." } }),
      ].join("\n") + "\n",
    );

    const tx = await latestTranscript("claude", cwd, { homePath: dir });

    assert.ok(tx);
    assert.equal(tx.title, "Repair Title Inheritance");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript derives Codex title from summary metadata before prompt fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-codex-title-"));
  try {
    const cwd = join(dir, "workspace");
    const sessionDir = join(dir, "sessions", "2026", "06", "09");
    const chatPath = join(sessionDir, "rollout-2026-06-09T10-00-00-session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      chatPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-session", cwd } }),
        JSON.stringify({ type: "turn_context", payload: { summary: "Implement inherited bee titles" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Fallback prompt text should not win" } }),
      ].join("\n") + "\n",
    );

    const tx = await latestTranscript("codex", cwd, { homePath: dir });

    assert.ok(tx);
    assert.equal(tx.title, "Implement inherited bee titles");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript falls back to the start of the Codex user prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-codex-prompt-title-"));
  try {
    const cwd = join(dir, "workspace");
    const sessionDir = join(dir, "sessions", "2026", "06", "09");
    const chatPath = join(sessionDir, "rollout-2026-06-09T11-00-00-session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      chatPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-session", cwd } }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Implement proper name inheritance for bees so the generated session title is visible in hive list",
          },
        }),
      ].join("\n") + "\n",
    );

    const tx = await latestTranscript("codex", cwd, { homePath: dir });

    assert.ok(tx);
    assert.equal(tx.title, "Implement proper name inheritance for bees so the generated session title is...");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript reads Grok chat history from the encoded workspace session folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-grok-tx-"));
  try {
    const cwd = join(dir, "workspace with spaces");
    const sessionId = "019e54fc-368f-7932-bc57-7737469083d2";
    const sessionDir = join(dir, "sessions", encodeURIComponent(resolve(cwd)), sessionId);
    const chatPath = join(sessionDir, "chat_history.jsonl");
    const unsafeDir = join(dir, "unsafe-session");
    const unsafeChatPath = join(unsafeDir, "chat_history.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(unsafeDir, { recursive: true });
    await writeFile(
      join(sessionDir, "summary.json"),
      `${JSON.stringify({
        info: { id: sessionId, cwd },
        current_model_id: "grok-build",
        updated_at: "2026-05-23T13:28:04.504702Z",
      })}\n`,
    );
    await writeFile(
      chatPath,
      [
        JSON.stringify({ type: "system", content: "ignore system prompts" }),
        JSON.stringify({ type: "user", content: [{ type: "text", text: "Fix the Grok transcript path" }] }),
        JSON.stringify({ type: "assistant", content: "Done. Grok transcript lookup works." }),
      ].join("\n") + "\n",
    );
    await writeFile(
      unsafeChatPath,
      [
        JSON.stringify({ type: "user", content: "Fix the Grok transcript path" }),
        JSON.stringify({ type: "assistant", content: "Unsafe direct path should not be read." }),
      ].join("\n") + "\n",
    );

    const tx = await latestTranscript("grok", cwd, {
      homePath: dir,
      prompt: "Fix the Grok transcript path",
      transcriptPath: unsafeChatPath,
    });

    assert.ok(tx);
    assert.equal(tx.provider, "grok");
    assert.equal(tx.sessionId, sessionId);
    assert.equal(tx.path, chatPath);
    assert.equal(tx.matchedBy.includes("cwd"), true);
    assert.equal(tx.matchedBy.includes("prompt"), true);
    assert.equal(lastAssistantText(tx.rows), "Done. Grok transcript lookup works.");
    assert.equal(renderTranscript(tx.rows), "## user\nFix the Grok transcript path\n\n## assistant\nDone. Grok transcript lookup works.");
    assert.equal(hasTranscriptProvider("grok"), true);
    assert.equal(hasTranscriptProvider("pi"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
