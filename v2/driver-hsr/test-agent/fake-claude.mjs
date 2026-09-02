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
 * `--resume <id> --fork-session` (v6 bee.fork) is honored like the real CLI:
 * the conversation is rejoined but the process mints a NEW session id (init
 * reports it), so source and fork never share a transcript. `--resume <id>
 * --session-id <new>` WITHOUT --fork-session is refused like the real CLI.
 * A `control_request {subtype:"interrupt"}` line (v6 bee.interrupt) ends the
 * in-flight turn with a result line, like the real CLI. `@slow:<ms>` in a
 * message makes the turn take that long. `@ratelimit` in a message makes the
 * turn hit the provider wall like the real CLI does: a `rate_limit_event`
 * with status "rejected" and an errored result (spec 08 rotation trigger).
 * `@authfail` makes the turn fail with "Not logged in · /login".
 *
 * Transcript files (only when CLAUDE_CONFIG_DIR is set, like the real CLI's
 * config dir): the first turn writes `projects/<cwd-key>/<sessionId>.jsonl`
 * under the config dir, and `--resume <id>` REQUIRES `projects/*\/<id>.jsonl`
 * there — a missing one fails the first turn the way the real CLI does
 * (`result error_during_execution`, `errors:["No conversation found with
 * session ID: …"]`, exit 1). This is the bee.swapAccount regression shape:
 * a conversation that only exists in the SOURCE account's home.
 *
 * env FAKE_CLAUDE_ARGV_LOG   append {argv, cwd, env:{CLAUDE_CONFIG_DIR, HIVE_BEE, HIVE_BEE_ID, HIVE_PARENT}, sessionId, resumed, forked} per boot
 * env FAKE_CLAUDE_FAIL_RESUME=1  exit 1 on --resume ("No conversation found") — the failure shape
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const resumeAt = argv.indexOf("--resume");
const resumed = resumeAt >= 0 ? argv[resumeAt + 1] : undefined;
const forked = argv.includes("--fork-session");
const pinAt = argv.indexOf("--session-id");
const pinned = pinAt >= 0 ? argv[pinAt + 1] : undefined;
if (resumed && pinned && !forked) {
  process.stderr.write("--session-id can only be used with --continue or --resume if --fork-session is also specified\n");
  process.exit(1);
}
// resume keeps the id; fork mints a new one (or takes the pin); fresh mints.
const sessionId = resumed && !forked ? resumed : (pinned ?? randomUUID());

if (process.env.FAKE_CLAUDE_ARGV_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_ARGV_LOG,
    `${JSON.stringify({ argv, cwd: process.cwd(), env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, HIVE_BEE: process.env.HIVE_BEE ?? null, HIVE_BEE_ID: process.env.HIVE_BEE_ID ?? null, HIVE_PARENT: process.env.HIVE_PARENT ?? null }, sessionId, resumed: resumed ?? null, forked })}\n`,
  );
}

if (resumed && process.env.FAKE_CLAUDE_FAIL_RESUME === "1") {
  process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
  process.exit(1);
}

// The config dir's transcript store (real CLI: ~/.claude or CLAUDE_CONFIG_DIR).
const configDir = process.env.CLAUDE_CONFIG_DIR;
function projectKey(cwd) {
  let real = resolve(cwd);
  try {
    real = realpathSync(real);
  } catch {
    // not created yet — keep the resolved path
  }
  return real.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
}
function transcriptKnown(id) {
  const root = join(configDir, "projects");
  if (!existsSync(root)) return false;
  return readdirSync(root).some((dir) => existsSync(join(root, dir, `${id}.jsonl`)));
}
function recordTranscript(obj) {
  if (!configDir) return;
  const dir = join(configDir, "projects", projectKey(process.cwd()));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ ...obj, sessionId, cwd: process.cwd() })}\n`);
}
const resumeMissing = Boolean(resumed && configDir && !transcriptKnown(resumed));

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let initSent = false;
let turnTimer = null;
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
  if (msg && msg.type === "control_request" && msg.request?.subtype === "interrupt") {
    // Like the real CLI: ack the control request; an in-flight turn ends now
    // with its result line (the session stays alive).
    emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
    if (turnTimer) {
      clearTimeout(turnTimer);
      turnTimer = null;
      emit({ type: "result", subtype: "success", is_error: false, result: "[interrupted]", session_id: sessionId });
    }
    return;
  }
  if (!msg || msg.type !== "user") return;
  const text = msg.message?.content?.[0]?.text ?? "";
  if (resumeMissing) {
    // Like the real CLI: the resume target is looked up on the first turn;
    // an unknown id ends the run before any model call (num_turns 0).
    emit({
      type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, duration_ms: 0, stop_reason: null,
      session_id: sessionId, errors: [`No conversation found with session ID: ${resumed}`],
    });
    process.exit(1);
  }
  if (!initSent) {
    initSent = true;
    emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), model: "fake", claude_code_version: "0.0.0-fake" });
    recordTranscript({ type: "init", resumed: resumed ?? null, forked });
  }
  recordTranscript({ type: "user", text });
  const slow = /@slow:(\d+)/.exec(text);
  turnTimer = setTimeout(() => {
    turnTimer = null;
    if (text.includes("@ratelimit")) {
      emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: "five_hour" }, session_id: sessionId });
      emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "You've hit your usage limit (rate limit reached)", session_id: sessionId });
      return;
    }
    if (text.includes("@authfail")) {
      emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in · /login", session_id: sessionId });
      return;
    }
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `echo:${text}` }] }, session_id: sessionId });
    emit({ type: "result", subtype: "success", is_error: false, result: `echo:${text}`, session_id: sessionId });
  }, slow ? Number(slow[1]) : 10);
});
rl.on("close", () => process.exit(0));
