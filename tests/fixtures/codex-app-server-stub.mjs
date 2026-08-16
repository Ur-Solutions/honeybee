#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.CODEX_APP_SERVER_STUB_LOG;
let initialized = false;

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(message) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log(message);

  if (message.method === "initialize" && message.id !== undefined) {
    write({ id: message.id, result: { userAgent: "hive-test", platformFamily: "unix", platformOs: "linux" } });
    return;
  }
  if (message.method === "initialized" && message.id === undefined) {
    initialized = true;
    return;
  }
  if ((message.method === "thread/start" || message.method === "thread/resume") && message.id !== undefined) {
    if (!initialized) {
      write({ id: message.id, error: { code: -32002, message: "Not initialized" } });
      return;
    }
    write({ id: message.id, result: { thread: { id: "thread-stub", turns: [] } } });
    if (process.env.CODEX_APP_SERVER_STUB_ASK === "1") {
      setTimeout(() => write({
        jsonrpc: "2.0",
        id: "approval-stub",
        method: "item/permissions/requestApproval",
        params: { threadId: "thread-stub", turnId: "turn-stub", itemId: "item-stub", reason: "approve test", permissions: {} },
      }), 20);
    }
    return;
  }
  if (message.method === "turn/start" && message.id !== undefined) {
    write({ id: message.id, result: { turn: { id: "turn-live", status: "inProgress", items: [] } } });
    write({ method: "turn/started", params: { threadId: "thread-stub", turn: { id: "turn-live", status: "inProgress" } } });
    return;
  }
  if (message.method === "turn/steer" && message.id !== undefined) {
    write({ id: message.id, result: { turnId: message.params.expectedTurnId } });
  }
});
