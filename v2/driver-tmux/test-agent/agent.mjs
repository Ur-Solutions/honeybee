#!/usr/bin/env node
/**
 * The WP5 tmux stub agent — a real CLI living in a real tmux pane, driven by
 * send-keys, emitting the same observation evidence real harnesses do. Used
 * by the tmux driver tests, the spec05.eq equal-treatment matrix and the
 * `v2:harness:real` tmux variant. No agent CLI, no tokens.
 *
 * Evidence style — env TMUX_STUB_STYLE:
 *   hooks       claude-hook-shaped lines appended to $HIVE_EVENTS_FILE
 *               (UserPromptSubmit / Stop) + a claude-format transcript
 *   notify      codex-notify-shaped completion lines appended to
 *               $HIVE_EVENTS_FILE (agent-turn-complete) + a codex-format
 *               transcript (its task_complete is the explicit end)
 *   transcript  transcript file ONLY (the A3 equal-treatment case)
 *   silent      no files at all — pane output only (source (c) fallback)
 *
 * Transcript format — env TMUX_STUB_TRANSCRIPT: claude | codex | grok
 * (default: claude for hooks style, codex for notify style, grok for
 * transcript style — mirroring the harnesses those styles model).
 *
 * Other env: TMUX_STUB_TRANSCRIPT_DIR (where transcripts go),
 * TMUX_STUB_TURN_MS (default 40), TMUX_STUB_IGNORE_SIGTERM=1,
 * TMUX_STUB_DEAF=1 (reads input but never reacts — the unconfirmed-delivery
 * fixture).
 *
 * Message directives (same vocabulary as the HSR stub):
 *   "@crash"  turn starts, process exits 9 mid-turn
 *   "@exit"   turn completes, then exits 0 (clean)
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const env = process.env;
const style = env.TMUX_STUB_STYLE || "transcript";
const turnMs = Number(env.TMUX_STUB_TURN_MS || "40");
const sessionId = `stub-${process.pid}`;
const eventsFile = env.HIVE_EVENTS_FILE || "";
const transcriptDir = env.TMUX_STUB_TRANSCRIPT_DIR || "";
const format =
  env.TMUX_STUB_TRANSCRIPT || (style === "hooks" ? "claude" : style === "notify" ? "codex" : "grok");

if (env.TMUX_STUB_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => console.log("ignoring SIGTERM"));
}

let transcriptPath = null;
function initTranscript() {
  if (style === "silent" || !transcriptDir) return;
  mkdirSync(transcriptDir, { recursive: true });
  if (format === "claude") {
    transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
    writeFileSync(transcriptPath, `${JSON.stringify({ type: "summary", summary: "stub session" })}\n`);
  } else if (format === "codex") {
    transcriptPath = join(transcriptDir, `rollout-${Date.now()}-${sessionId}.jsonl`);
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id: sessionId, cwd: process.cwd() } })}\n`,
    );
  } else {
    const dir = join(transcriptDir, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: sessionId, cwd: process.cwd() } }));
    transcriptPath = join(dir, "chat_history.jsonl");
    writeFileSync(transcriptPath, "");
  }
}

function transcript(row) {
  if (transcriptPath == null) return;
  appendFileSync(transcriptPath, `${JSON.stringify(row)}\n`);
}

function hookEvent(obj) {
  if (!eventsFile) return;
  appendFileSync(eventsFile, `${JSON.stringify(obj)}\n`);
}

function userRow(body) {
  const ts = new Date().toISOString();
  if (format === "claude") {
    transcript({ type: "user", timestamp: ts, sessionId, message: { role: "user", content: body } });
  } else if (format === "codex") {
    transcript({ timestamp: ts, type: "turn_context", payload: { model: "stub" } });
    transcript({ timestamp: ts, type: "event_msg", payload: { type: "task_started" } });
    transcript({
      timestamp: ts,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: body }] },
    });
  } else {
    transcript({ type: "user", content: [{ type: "text", text: body }] });
  }
}

function assistantRow(text) {
  const ts = new Date().toISOString();
  if (format === "claude") {
    transcript({
      type: "assistant",
      timestamp: ts,
      sessionId,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  } else if (format === "codex") {
    transcript({ timestamp: ts, type: "event_msg", payload: { type: "agent_message", message: text } });
  } else {
    transcript({ type: "assistant", content: text });
  }
}

function completion() {
  if (style === "hooks") {
    hookEvent({ hook_event_name: "Stop", session_id: sessionId });
  } else if (style === "notify") {
    hookEvent({ type: "agent-turn-complete", "turn-id": sessionId, "last-assistant-message": "done" });
  } else if (format === "codex") {
    transcript({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "task_complete" } });
  }
  // claude/grok transcript styles end by quiescence — deliberately nothing.
}

const queue = [];
let busy = false;

function workNext() {
  if (busy) return;
  const body = queue.shift();
  if (body == null) return;
  busy = true;
  userRow(body);
  if (style === "hooks") hookEvent({ hook_event_name: "UserPromptSubmit", session_id: sessionId });
  setTimeout(() => {
    if (body.includes("@crash")) process.exit(9);
    console.log(`echo:${body}`);
    assistantRow(`echo:${body}`);
    completion();
    busy = false;
    if (body.includes("@exit")) {
      setTimeout(() => process.exit(0), 15);
      return;
    }
    workNext();
  }, turnMs);
}

initTranscript();
console.log(`stub ready (${style}/${format})`);

const rl = createInterface({ input: process.stdin });
rl.on("line", (raw) => {
  const line = String(raw).trim();
  if (!line) return;
  if (env.TMUX_STUB_DEAF === "1") return; // swallow input silently
  queue.push(line);
  workNext();
});
// In a pane, stdin closing means the pty is being torn down; just exit.
rl.on("close", () => process.exit(0));
