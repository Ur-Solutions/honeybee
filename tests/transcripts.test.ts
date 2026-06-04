import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { hasTranscriptProvider, lastAssistantText, latestTranscript, renderTranscript } from "../src/transcripts.js";

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
