#!/usr/bin/env node
/**
 * Fake `claude` for the WP7 continuity test (spec 07 §F): speaks the
 * `-p --input-format stream-json --output-format stream-json` envelope the
 * claude adapter normalizes and HONORS `--resume <session_id>` the way the
 * real CLI does — the system/init line echoes the resumed id (a fresh run
 * mints a new uuid). Never a real agent CLI, no tokens.
 *
 * Like the real CLI in stream-json mode it emits NOTHING until the first user
 * message arrives on stdin (the readyAtSpawn finding).
 *
 * env FAKE_CLAUDE_ARGV_LOG   append {argv, cwd, env:{CLAUDE_CONFIG_DIR}, sessionId} per boot
 * env FAKE_CLAUDE_FAIL_RESUME=1  exit 1 on --resume ("No conversation found") — the failure shape
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const resumeAt = argv.indexOf("--resume");
const resumed = resumeAt >= 0 ? argv[resumeAt + 1] : undefined;
const sessionId = resumed ?? randomUUID();

if (process.env.FAKE_CLAUDE_ARGV_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_ARGV_LOG,
    `${JSON.stringify({ argv, cwd: process.cwd(), env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null }, sessionId, resumed: resumed ?? null })}\n`,
  );
}

if (resumed && process.env.FAKE_CLAUDE_FAIL_RESUME === "1") {
  process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
  process.exit(1);
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let initSent = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", (raw) => {
  const line = String(raw).trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || msg.type !== "user") return;
  const text = msg.message?.content?.[0]?.text ?? "";
  if (!initSent) {
    initSent = true;
    emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), model: "fake", claude_code_version: "0.0.0-fake" });
  }
  setTimeout(() => {
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `echo:${text}` }] }, session_id: sessionId });
    emit({ type: "result", subtype: "success", is_error: false, result: `echo:${text}`, session_id: sessionId });
  }, 10);
});
rl.on("close", () => process.exit(0));
