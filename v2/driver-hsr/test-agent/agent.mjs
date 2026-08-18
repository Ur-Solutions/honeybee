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
 *   env STUB_SURVIVE_STDIN_CLOSE=1  keep running after stdin closes and swallow
 *                               stdout EPIPE — simulates an agent that outlives
 *                               a daemon SIGKILL (WP4 re-adoption tests)
 *   env STUB_TURN_MS            per-turn work duration in ms (default 5)
 *   env STUB_SESSION_ID         session id reported in ready (default stub-<pid>)
 *   message body directives:
 *     "@hang"      turn starts, never ends
 *     "@crash"     turn starts, process exits 9 mid-turn
 *     "@exit"      turn completes, then process exits 0 (clean exit)
 *     "@authfail"  turn emits a login-required auth error, ends ok:false
 *     "@ratelimit" turn emits a rejected rate-limit event, ends ok:false
 *     "@slow:<ms>" turn takes <ms> instead of STUB_TURN_MS (interrupt tests)
 *   {"type":"interrupt"} (v6): ends the CURRENT turn now — emits
 *     {"event":"turn_ended","messageId":n,"ok":true,"interrupted":true},
 *     un-hangs a "@hang" turn, and keeps working the queue. Idle: ignored.
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
let currentId = null;
let turnTimer = null;

function interruptTurn() {
  if (!busy) return; // idle: nothing to interrupt
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = null;
  hung = false;
  busy = false;
  emit({ event: "turn_ended", messageId: currentId, ok: true, interrupted: true });
  currentId = null;
  workNext();
}

function workNext() {
  if (busy || hung) return;
  const msg = queue.shift();
  if (!msg) return;
  busy = true;
  const id = msg.id;
  currentId = id;
  const body = typeof msg.body === "string" ? msg.body : "";
  emit({ event: "turn_started", messageId: id });
  if (body.includes("@hang")) {
    hung = true; // never ends; never picks up further work (until interrupted)
    return;
  }
  const slow = /@slow:(\d+)/.exec(body);
  const thisTurnMs = slow ? Number(slow[1]) : turnMs;
  turnTimer = setTimeout(() => {
    turnTimer = null;
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
    currentId = null;
    if (body.includes("@exit")) {
      // Give the pipe a beat to flush turn_ended before the clean exit.
      setTimeout(() => process.exit(0), 15);
      return;
    }
    workNext();
  }, thisTurnMs);
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
  } else if (msg && msg.type === "interrupt") {
    interruptTurn();
  }
});

// stdin closing means the parent is gone or stopping us; exit cleanly —
// unless the WP4 re-adoption tests asked us to outlive our parent.
rl.on("close", () => {
  if (env.STUB_SURVIVE_STDIN_CLOSE !== "1") process.exit(0);
});

if (env.STUB_SURVIVE_STDIN_CLOSE === "1") {
  // Writes to a dead parent's pipe must not kill the survivor.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  // Keep the event loop alive with no work pending.
  setInterval(() => {}, 60_000);
}

if (env.STUB_HANG_ON_BOOT !== "1") {
  setTimeout(() => {
    emit({ event: "ready", sessionId });
  }, Number.isFinite(bootDelayMs) ? Math.max(0, bootDelayMs) : 0);
}
