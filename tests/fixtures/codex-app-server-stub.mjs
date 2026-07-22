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
  }
});
