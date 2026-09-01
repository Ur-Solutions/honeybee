#!/usr/bin/env node
/**
 * Fake `codex app-server` for the WP7 continuity test (spec 07 §F): a
 * JSON-RPC 2.0 stdio peer speaking the subset the codex adapter drives —
 * initialize → initialized → thread/start | thread/resume → turn/start | turn/steer —
 * and HONORS `thread/resume {threadId}` the way the real app-server does:
 * the response carries the same `thread.id`. `thread/fork {threadId}` (v6
 * bee.fork) answers with a NEW thread id (the app-server copies the rollout);
 * `turn/interrupt {threadId, turnId}` (v6 bee.interrupt) ends the in-flight
 * turn with turn/completed. `@slow:<ms>` in a turn's text makes it take that
 * long. Never a real agent CLI.
 *
 * env FAKE_CODEX_RPC_LOG   append {method, params, argv, env:{CODEX_HOME}} per request
 *                          (argv = the process's own args, so a test can see which
 *                          `-c key=value` overrides reached the app-server child)
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
    `${JSON.stringify({ method, params, argv: process.argv.slice(2), cwd: process.cwd(), env: { CODEX_HOME: process.env.CODEX_HOME ?? null } })}\n`,
  );
}

let threadId = null;
let turnTimer = null;
let currentTurnId = null;
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
    case "thread/fork":
      // The fork is a NEW thread seeded from the source rollout.
      threadId = randomUUID();
      emit({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId, cwd: msg.params?.cwd ?? null, forkedFrom: String(msg.params?.threadId ?? "") } } });
      return;
    case "turn/start": {
      const turnId = randomUUID();
      currentTurnId = turnId;
      const text = msg.params?.input?.[0]?.text ?? "";
      const slow = /@slow:(\d+)/.exec(String(text));
      emit({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId } } });
      emit({ jsonrpc: "2.0", method: "turn/started", params: { threadId, turn: { id: turnId } } });
      turnTimer = setTimeout(() => {
        turnTimer = null;
        currentTurnId = null;
        emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId, delta: "echo" } });
        // Mirrors the real structured stream seen in the CO.751a incident.
        // Lifecycle still derives from turn/completed; the status notification
        // is deliberately non-authoritative in the Codex adapter.
        emit({ jsonrpc: "2.0", method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
        emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId } } });
      }, slow ? Number(slow[1]) : 10);
      return;
    }
    case "turn/steer": {
      const expected = String(msg.params?.expectedTurnId ?? "");
      if (turnTimer && currentTurnId === expected) {
        emit({ jsonrpc: "2.0", id: msg.id, result: { turnId: currentTurnId } });
      } else {
        emit({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32600, message: `fake-codex: active turn does not match ${expected}` },
        });
      }
      return;
    }
    case "turn/interrupt": {
      const wanted = String(msg.params?.turnId ?? "");
      if (turnTimer && currentTurnId === wanted) {
        clearTimeout(turnTimer);
        turnTimer = null;
        currentTurnId = null;
        emit({ jsonrpc: "2.0", id: msg.id, result: {} });
        emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: wanted }, interrupted: true } });
      } else {
        emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: `fake-codex: no active turn ${wanted}` } });
      }
      return;
    }
    default:
      if (msg.id !== undefined) emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `fake-codex: ${msg.method}` } });
  }
});
rl.on("close", () => process.exit(0));
