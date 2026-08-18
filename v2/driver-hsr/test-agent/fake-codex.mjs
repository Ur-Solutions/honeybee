#!/usr/bin/env node
/**
 * Fake `codex app-server` for the WP7 continuity test (spec 07 §F): a
 * JSON-RPC 2.0 stdio peer speaking the subset the codex adapter drives —
 * initialize → initialized → thread/start | thread/resume → turn/start —
 * and HONORS `thread/resume {threadId}` the way the real app-server does:
 * the response carries the same `thread.id`. Never a real agent CLI.
 *
 * env FAKE_CODEX_RPC_LOG   append {method, params, env:{CODEX_HOME}} per request
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(method, params) {
  if (!process.env.FAKE_CODEX_RPC_LOG) return;
  appendFileSync(
    process.env.FAKE_CODEX_RPC_LOG,
    `${JSON.stringify({ method, params, cwd: process.cwd(), env: { CODEX_HOME: process.env.CODEX_HOME ?? null } })}\n`,
  );
}

let threadId = null;
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
  if (!msg || typeof msg.method !== "string") return;
  log(msg.method, msg.params ?? null);
  switch (msg.method) {
    case "initialize":
      emit({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake-codex/0" } });
      return;
    case "initialized":
      return;
    case "thread/start":
      threadId = randomUUID();
      emit({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId, cwd: msg.params?.cwd ?? null } } });
      return;
    case "thread/resume":
      threadId = String(msg.params?.threadId ?? "");
      emit({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId, cwd: msg.params?.cwd ?? null } } });
      return;
    case "turn/start": {
      const turnId = randomUUID();
      emit({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId } } });
      emit({ jsonrpc: "2.0", method: "turn/started", params: { threadId, turn: { id: turnId } } });
      setTimeout(() => {
        emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId, delta: "echo" } });
        emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId } } });
      }, 10);
      return;
    }
    default:
      if (msg.id !== undefined) emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `fake-codex: ${msg.method}` } });
  }
});
rl.on("close", () => process.exit(0));
