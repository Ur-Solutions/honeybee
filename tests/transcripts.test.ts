import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { firstUserText, hasTranscriptProvider, lastAssistantText, latestTranscript, projectKeyForCwd, renderTranscript, stripCommandNoise, transcriptAdapters, type TranscriptProvider, type TranscriptRow } from "../src/transcripts.js";

// Independent re-implementation of Claude Code's project-dir encoding so the
// fixtures below do not circularly depend on projectKeyForCwd.
function claudeEncode(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

test("projectKeyForCwd matches Claude Code's project-dir encoding for dots and underscores", () => {
  assert.equal(projectKeyForCwd("/tmp/.hidden/my_app"), "-tmp--hidden-my-app");
  assert.equal(projectKeyForCwd("/Users/x/.openclaw/workspace"), "-Users-x--openclaw-workspace");
});

test("transcriptAdapters registry covers every provider under its own key", () => {
  const providers: TranscriptProvider[] = ["claude", "codex", "opencode", "grok"];
  assert.deepEqual(Object.keys(transcriptAdapters).sort(), [...providers].sort());
  for (const provider of providers) assert.equal(transcriptAdapters[provider].provider, provider);
});

test("latestTranscript returns null for agents without a transcript adapter", async () => {
  assert.equal(await latestTranscript("gemini", "/tmp"), null);
});

test("latestTranscript: notBeforeIso refuses an older sibling's transcript that wins on mtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-floor-"));
  try {
    const cwd = join(dir, "repo");
    const projectDir = join(dir, "projects", claudeEncode(cwd));
    await mkdir(projectDir, { recursive: true });

    // The earlier sibling: its session started an hour before the bee spawned,
    // but its file carries the NEWEST mtime (it is actively being written).
    const siblingPath = join(projectDir, "sibling.jsonl");
    await writeFile(
      siblingPath,
      [
        JSON.stringify({ type: "user", timestamp: "2026-06-18T11:00:00.000Z", message: { role: "user", content: "investigate slow claude bee spawning" } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-06-18T11:00:05.000Z", message: { role: "assistant", content: "looking" } }),
      ].join("\n") + "\n",
    );

    // The bee's own session, started just after it spawned, older file mtime.
    const ownPath = join(projectDir, "own.jsonl");
    await writeFile(
      ownPath,
      [
        JSON.stringify({ type: "user", timestamp: "2026-06-18T12:00:10.000Z", message: { role: "user", content: "fix bee renaming" } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-06-18T12:00:15.000Z", message: { role: "assistant", content: "on it" } }),
      ].join("\n") + "\n",
    );

    await utimes(ownPath, new Date("2026-06-18T12:00:15.000Z"), new Date("2026-06-18T12:00:15.000Z"));
    await utimes(siblingPath, new Date("2026-06-18T13:00:00.000Z"), new Date("2026-06-18T13:00:00.000Z"));

    const spawnedAt = "2026-06-18T12:00:00.000Z";

    // Without the floor, the newest-mtime sibling wins — the cross-match bug.
    const unguarded = await latestTranscript("claude", cwd, { homePath: dir });
    assert.equal(unguarded?.sessionId, "sibling");

    // With the floor, the bee can only land on its own session.
    const guarded = await latestTranscript("claude", cwd, { homePath: dir, notBeforeIso: spawnedAt });
    assert.equal(guarded?.sessionId, "own");

    // An explicit session-id anchor is authoritative and bypasses the floor
    // (a resumed bee legitimately reopens its pre-spawn session).
    const anchored = await latestTranscript("claude", cwd, { homePath: dir, notBeforeIso: spawnedAt, sessionId: "sibling" });
    assert.equal(anchored?.sessionId, "sibling");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript: a stored transcriptPath outside the computed root is still honored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-outside-root-"));
  try {
    const cwd = join(dir, "repo");
    // The bee's real transcript lives under a DIFFERENT home (e.g. a hive
    // account home the harness inherited from env) than the one the lookup
    // computes its root from. Falling through to discovery in the wrong root
    // is how sibling transcripts get cross-matched.
    const realHome = join(dir, "real-home");
    const wrongRootHome = join(dir, "assumed-home");
    const ownPath = join(realHome, "projects", claudeEncode(cwd), "own.jsonl");
    await mkdir(join(realHome, "projects", claudeEncode(cwd)), { recursive: true });
    await writeFile(
      ownPath,
      [
        JSON.stringify({ type: "user", timestamp: "2026-06-18T12:00:10.000Z", message: { role: "user", content: "fix bee renaming" } }),
        JSON.stringify({ type: "assistant", timestamp: "2026-06-18T12:00:15.000Z", message: { role: "assistant", content: "on it" } }),
      ].join("\n") + "\n",
    );
    // A fresh sibling in the assumed root that would win discovery on mtime.
    const siblingDir = join(wrongRootHome, "projects", claudeEncode(cwd));
    await mkdir(siblingDir, { recursive: true });
    await writeFile(
      siblingDir + "/sibling.jsonl",
      JSON.stringify({ type: "user", timestamp: "2026-06-18T13:00:00.000Z", message: { role: "user", content: "unrelated sibling work" } }) + "\n",
    );

    const found = await latestTranscript("claude", cwd, { homePath: wrongRootHome, transcriptPath: ownPath });
    assert.equal(found?.sessionId, "own");
    assert.ok(found?.matchedBy.includes("path"));

    // A stored path that no longer exists still falls back to discovery.
    const fallback = await latestTranscript("claude", cwd, { homePath: wrongRootHome, transcriptPath: join(realHome, "gone.jsonl") });
    assert.equal(fallback?.sessionId, "sibling");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript: Codex spawn proximity beats a newer same-cwd sibling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-codex-proximity-"));
  try {
    const cwd = join(dir, "workspace");
    const sessionDir = join(dir, "sessions", "2026", "06", "18");
    await mkdir(sessionDir, { recursive: true });

    const ownPath = join(sessionDir, "rollout-2026-06-18T12-00-01-own.jsonl");
    await writeFile(
      ownPath,
      [
        // Codex can stamp the row later than the real session start. The
        // payload timestamp is the start anchor that should tie this file to
        // the bee spawned at 12:00:00.
        JSON.stringify({ type: "session_meta", timestamp: "2026-06-18T12:10:00.000Z", payload: { id: "own", cwd, timestamp: "2026-06-18T12:00:01.000Z" } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-06-18T12:20:00.000Z", payload: { type: "user_message", message: "review the PR" } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-06-18T12:20:05.000Z", payload: { type: "agent_message", message: "own review" } }),
      ].join("\n") + "\n",
    );

    const siblingPath = join(sessionDir, "rollout-2026-06-18T12-05-00-sibling.jsonl");
    await writeFile(
      siblingPath,
      [
        JSON.stringify({ type: "session_meta", timestamp: "2026-06-18T12:05:00.000Z", payload: { id: "sibling", cwd, timestamp: "2026-06-18T12:05:00.000Z" } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-06-18T12:05:01.000Z", payload: { type: "user_message", message: "review the PR" } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-06-18T12:05:05.000Z", payload: { type: "agent_message", message: "sibling review" } }),
      ].join("\n") + "\n",
    );

    await utimes(ownPath, new Date("2026-06-18T12:30:00.000Z"), new Date("2026-06-18T12:30:00.000Z"));
    await utimes(siblingPath, new Date("2026-06-18T13:00:00.000Z"), new Date("2026-06-18T13:00:00.000Z"));

    const tx = await latestTranscript("codex", cwd, {
      homePath: dir,
      notBeforeIso: "2026-06-18T12:00:00.000Z",
      sinceIso: "2026-06-18T12:00:00.000Z",
      prompt: "review the PR",
    });

    assert.equal(tx?.sessionId, "own");
    assert.equal(tx?.matchedBy.includes("spawn-proximity"), true);
    assert.equal(lastAssistantText(tx?.rows ?? []), "own review");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript inherits Claude ai-title metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-claude-title-"));
  try {
    const cwd = join(dir, ".hidden", "my_app.v2");
    const projectDir = join(dir, "projects", claudeEncode(cwd));
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

test("latestTranscript reuses parsed rows while the transcript is unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-claude-cache-"));
  try {
    const cwd = join(dir, "workspace");
    const projectDir = join(dir, "projects", claudeEncode(cwd));
    const chatPath = join(projectDir, "session-1.jsonl");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      chatPath,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "Cache me." } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Cached." } }),
      ].join("\n") + "\n",
    );

    const first = await latestTranscript("claude", cwd, { homePath: dir });
    const second = await latestTranscript("claude", cwd, { homePath: dir });
    assert.ok(first);
    assert.ok(second);
    // Same parsed array instance: the second call stat-short-circuited
    // instead of re-reading and re-parsing the file.
    assert.equal(second.rows, first.rows);

    await appendFile(chatPath, JSON.stringify({ type: "assistant", message: { role: "assistant", content: "More." } }) + "\n");
    const third = await latestTranscript("claude", cwd, { homePath: dir });
    assert.ok(third);
    assert.notEqual(third.rows, first.rows);
    assert.equal(third.rows.length, first.rows.length + 1);
    assert.equal(lastAssistantText(third.rows), "More.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript ignores the Codex reasoning-summary mode when titling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-codex-title-"));
  try {
    const cwd = join(dir, "workspace");
    const sessionDir = join(dir, "sessions", "2026", "06", "09");
    const chatPath = join(sessionDir, "rollout-2026-06-09T10-00-00-session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    // In real rollouts turn_context/session_meta payload.summary is the
    // reasoning-summary MODE ("auto"), not a conversation summary.
    await writeFile(
      chatPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-session", cwd } }),
        JSON.stringify({ type: "turn_context", payload: { cwd, model: "gpt-5", summary: "auto" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Implement inherited bee titles" } }),
      ].join("\n") + "\n",
    );

    const tx = await latestTranscript("codex", cwd, { homePath: dir });

    assert.ok(tx);
    assert.equal(tx.title, "Implement inherited bee titles");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript never adopts a Codex title-generator session as a bee transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-codex-titlegen-"));
  const prevRoot = process.env.HIVE_STORE_ROOT;
  try {
    process.env.HIVE_STORE_ROOT = join(dir, "store");
    // The title generator runs `codex exec` in this dedicated cwd; codex stores
    // rollouts globally per-home, so the bee shares the sessions dir with it.
    const generatorCwd = join(dir, "store", "naming");
    const beeCwd = join(dir, "workspace");
    const sessionDir = join(dir, "sessions", "2026", "06", "25");
    await mkdir(sessionDir, { recursive: true });
    // A title-gen rollout: its first user message is the title prompt itself.
    // Without the generator-cwd guard the bee would adopt it and be titled
    // "You are a session-title generator…".
    await writeFile(
      join(sessionDir, "rollout-2026-06-25T05-00-00-titlegen.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "titlegen", cwd: generatorCwd } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "You are a session-title generator. Output ONLY a 3-8 word title in plain text." } }),
      ].join("\n") + "\n",
    );

    const tx = await latestTranscript("codex", beeCwd, { homePath: dir });
    assert.equal(tx, null);
  } finally {
    if (prevRoot === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prevRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript dedupes Codex dual-format rollouts and filters injected context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-codex-dual-"));
  try {
    const cwd = join(dir, "workspace");
    const sessionDir = join(dir, "sessions", "2026", "06", "09");
    const chatPath = join(sessionDir, "rollout-2026-06-09T12-00-00-session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    // Real rollouts carry each message twice: once as an event_msg and once
    // as a response_item, plus harness-injected user/developer blobs.
    await writeFile(
      chatPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-session", cwd } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "# Instructions: you are Codex" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<user_instructions>\nfollow AGENTS.md\n</user_instructions>" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/tmp</cwd>\n</environment_context>" }] } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "# Agents.md instructions\n\nUse the repo guidance." } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\nUse the repo guidance." }] } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Fix the flaky test" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the flaky test" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done, the test is deflaked." }] } }),
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Done, the test is deflaked." } }),
      ].join("\n") + "\n",
    );

    const tx = await latestTranscript("codex", cwd, { homePath: dir });

    assert.ok(tx);
    assert.equal(renderTranscript(tx.rows), "## user\nFix the flaky test\n\n## assistant\nDone, the test is deflaked.");
    assert.equal(tx.title, "Fix the flaky test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript keeps Codex response_item messages missing from the event stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-codex-mixed-format-"));
  try {
    const cwd = join(dir, "workspace");
    const sessionDir = join(dir, "sessions", "2026", "06", "09");
    const chatPath = join(sessionDir, "rollout-2026-06-09T12-30-00-session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      chatPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-session", cwd } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Fix the mixed\nrollout" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the mixed rollout" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Response-item assistant survived." }] } }),
      ].join("\n") + "\n",
    );

    const tx = await latestTranscript("codex", cwd, { homePath: dir });

    assert.ok(tx);
    assert.equal(renderTranscript(tx.rows), "## user\nFix the mixed\nrollout\n\n## assistant\nResponse-item assistant survived.");
    assert.equal(lastAssistantText(tx.rows), "Response-item assistant survived.");
    assert.equal(tx.title, "Fix the mixed rollout");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("latestTranscript still renders Codex rollouts that only carry response_item messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-codex-response-items-"));
  try {
    const cwd = join(dir, "workspace");
    const sessionDir = join(dir, "sessions", "2026", "06", "09");
    const chatPath = join(sessionDir, "rollout-2026-06-09T13-00-00-session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      chatPath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-session", cwd } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/tmp</cwd>\n</environment_context>" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Refactor the parser" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Parser refactored." }] } }),
      ].join("\n") + "\n",
    );

    const tx = await latestTranscript("codex", cwd, { homePath: dir });

    assert.ok(tx);
    assert.equal(renderTranscript(tx.rows), "## user\nRefactor the parser\n\n## assistant\nParser refactored.");
    assert.equal(tx.title, "Refactor the parser");
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

test("stripCommandNoise removes slash-command and harness blocks, keeps the real prompt", () => {
  const raw = [
    "<local-command-caveat>Caveat: messages below were generated while running local commands.</local-command-caveat>",
    "<command-name>/model</command-name>",
    "<command-message>model</command-message>",
    "<command-args></command-args>",
    "<local-command-stdout>Set model to Opus</local-command-stdout>",
    "Some of my latest bees didn't get a semantic title",
  ].join("\n");
  assert.equal(stripCommandNoise(raw), "Some of my latest bees didn't get a semantic title");
  // A pure slash-command invocation strips to nothing.
  assert.equal(stripCommandNoise("<command-name>/effort</command-name>\n<command-args>ultracode</command-args>"), "");
  // system-reminder injections are dropped too.
  assert.equal(stripCommandNoise("<system-reminder>be careful</system-reminder>\nFix the parser"), "Fix the parser");
  // Tags carrying attributes are still stripped (opening tag is not anchored to a bare `<tag>`).
  assert.equal(stripCommandNoise('<system-reminder priority="high">hidden</system-reminder>visible'), "visible");
});

test("firstUserText skips noise-only rows and returns the first real user message", () => {
  const rows: TranscriptRow[] = [
    { type: "user", message: { role: "user", content: "<command-name>/model</command-name>\n<command-args></command-args>" } },
    { type: "assistant", message: { role: "assistant", content: "Model set." } },
    { type: "user", message: { role: "user", content: "<local-command-caveat>noise</local-command-caveat>\nMigrate the store to SQLite" } },
  ];
  assert.equal(firstUserText(rows), "Migrate the store to SQLite");
});

test("firstUserText defensively skips Codex bootstrap rows before the real prompt", () => {
  const rows: TranscriptRow[] = [
    {
      type: "user",
      message: {
        role: "user",
        content:
          "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>be good</INSTRUCTIONS>\n<environment_context><cwd>/repo</cwd></environment_context>",
      },
    },
    { type: "user", message: { role: "user", content: "Repair the session titles" } },
  ];
  assert.equal(firstUserText(rows), "Repair the session titles");
});

test("firstUserText returns empty when every user row is pure command noise", () => {
  const rows: TranscriptRow[] = [
    { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
    { type: "assistant", message: { role: "assistant", content: "What would you like to work on?" } },
  ];
  assert.equal(firstUserText(rows), "");
});

test("renderTranscript applies the limit after filtering text-less rows", () => {
  const toolRow: TranscriptRow = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } };
  const rows: TranscriptRow[] = [
    { type: "user", message: { role: "user", content: "first prompt" } },
    toolRow,
    toolRow,
    { type: "assistant", message: { role: "assistant", content: "interim answer" } },
    toolRow,
    toolRow,
    toolRow,
    { type: "assistant", message: { role: "assistant", content: "final answer" } },
  ];

  // The raw tail is dominated by text-less tool rows; the limit must apply
  // to the rendered messages, not the raw rows.
  assert.equal(renderTranscript(rows, { limit: 2 }), "## assistant\ninterim answer\n\n## assistant\nfinal answer");
  // JSON mode keeps raw-row semantics.
  assert.equal(renderTranscript(rows, { limit: 2, json: true }).split("\n").length, 2);
});

test("latestTranscript orders OpenCode messages by time.created and parts by filename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeybee-opencode-order-"));
  try {
    const cwd = join(dir, "workspace");
    // Realistic identity-home layout: storage lives under the relocated XDG
    // data tree ({home}/xdg-data/opencode/storage), never the home itself.
    const storage = join(dir, "xdg-data", "opencode", "storage");
    const sessionDir = join(storage, "session", "global");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "ses_abc.json"), JSON.stringify({ id: "ses_abc", directory: cwd }));

    const msgDir = join(storage, "message", "ses_abc");
    await mkdir(msgDir, { recursive: true });
    // Filename order contradicts time.created: msg_a is the *later* reply.
    await writeFile(join(msgDir, "msg_a.json"), JSON.stringify({ id: "msg_a", role: "assistant", time: { created: 200 } }));
    await writeFile(join(msgDir, "msg_b.json"), JSON.stringify({ id: "msg_b", role: "user", time: { created: 100 } }));

    const partADir = join(storage, "part", "msg_a");
    await mkdir(partADir, { recursive: true });
    // Written out of name order; the render must sort by filename.
    await writeFile(join(partADir, "prt_2.json"), JSON.stringify({ text: "part two" }));
    await writeFile(join(partADir, "prt_1.json"), JSON.stringify({ text: "part one" }));
    const partBDir = join(storage, "part", "msg_b");
    await mkdir(partBDir, { recursive: true });
    await writeFile(join(partBDir, "prt_1.json"), JSON.stringify({ text: "do the thing" }));

    const tx = await latestTranscript("opencode", cwd, { homePath: dir });

    assert.ok(tx);
    assert.equal(renderTranscript(tx.rows), "## user\ndo the thing\n\n## assistant\npart one\npart two");
    assert.equal(lastAssistantText(tx.rows), "part one\npart two");
    assert.equal(tx.matchedBy.includes("cwd"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
