#!/usr/bin/env node
/**
 * The WP3 stub agent executable — a real child process speaking the simple
 * jsonl protocol the stub adapter (v2/adapters/src/stub.ts) normalizes.
 *
 * Used by driver integration tests and the `v2:harness:real` invariant gate:
 * real OS processes, real pipes, real signals — no agent CLI, no tokens.
 *
 * Controllable behavior:
 *   env STUB_BOOT_DELAY_MS      delay before the ready line (default 0)
 *   env STUB_HANG_ON_BOOT=1     never emit ready (boot hang)
 *   env STUB_EXIT_BEFORE_READY=1  exit(7) before ready (spawn/boot crash)
 *   env STUB_IGNORE_SIGTERM=1   ignore SIGTERM (forces the driver's KILL escalation)
 *   env STUB_TURN_MS            per-turn work duration in ms (default 5)
 *   env STUB_SESSION_ID         session id reported in ready (default stub-<pid>)
 *   message body directives:
 *     "@hang"      turn starts, never ends
 *     "@crash"     turn starts, process exits 9 mid-turn
 *     "@exit"      turn completes, then process exits 0 (clean exit)
 *     "@authfail"  turn emits a login-required auth error, ends ok:false
 *     "@ratelimit" turn emits a rejected rate-limit event, ends ok:false
 *
 * Messages arriving mid-turn are queued and worked FIFO (the accept point).
 */
import { createInterface } from "node:readline";

const env = process.env;
const bootDelayMs = Number(env.STUB_BOOT_DELAY_MS ?? "0");
const turnMs = Number(env.STUB_TURN_MS ?? "5");
const sessionId = env.STUB_SESSION_ID || `stub-${process.pid}`;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (env.STUB_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    emit({ event: "text", text: "ignoring SIGTERM" });
  });
}

if (env.STUB_EXIT_BEFORE_READY === "1") {
  process.exit(7);
}

const queue = [];
let busy = false;
let hung = false;

function workNext() {
  if (busy || hung) return;
  const msg = queue.shift();
  if (!msg) return;
  busy = true;
  const id = msg.id;
  const body = typeof msg.body === "string" ? msg.body : "";
  emit({ event: "turn_started", messageId: id });
  if (body.includes("@hang")) {
    hung = true; // never ends; never picks up further work
    return;
  }
  setTimeout(() => {
    if (body.includes("@crash")) {
      // turn_started was written a full turn ago (pipe flushed); die mid-turn.
      process.exit(9);
    }
    if (body.includes("@authfail")) {
      emit({ event: "error", message: "Not logged in · Please run /login" });
      emit({ event: "turn_ended", messageId: id, ok: false });
    } else if (body.includes("@ratelimit")) {
      emit({ event: "rate_limited", status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 });
      emit({ event: "turn_ended", messageId: id, ok: false });
    } else {
      emit({ event: "text", text: `echo:${body}` });
      emit({ event: "turn_ended", messageId: id, ok: true });
    }
    busy = false;
    if (body.includes("@exit")) {
      // Give the pipe a beat to flush turn_ended before the clean exit.
      setTimeout(() => process.exit(0), 15);
      return;
    }
    workNext();
  }, turnMs);
}

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
  if (msg && msg.type === "message") {
    queue.push(msg);
    workNext();
  }
});

// stdin closing means the parent is gone or stopping us; exit cleanly.
rl.on("close", () => {
  process.exit(0);
});

if (env.STUB_HANG_ON_BOOT !== "1") {
  setTimeout(() => {
    emit({ event: "ready", sessionId });
  }, Number.isFinite(bootDelayMs) ? Math.max(0, bootDelayMs) : 0);
}
