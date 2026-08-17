#!/usr/bin/env node
/**
 * Cell-smoke stub agent — the WP3 stub protocol (v2/adapters/src/stub.ts)
 * plus ONE directive the cell smoke needs:
 *
 *   "@sh <command>"  run the command via /bin/sh -c in the agent's cwd
 *                    (the cell space), emit its output as text, reply DONE,
 *                    end the turn ok iff the command exited 0.
 *
 * This is what makes the stub cell smoke honest: the file writes and the
 * git commit happen INSIDE the spawned child — same cwd, same sandbox
 * confinement — exactly where a real agent would do them. Anything else
 * echoes like the WP3 stub.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const sessionId = process.env.STUB_SESSION_ID || `cell-stub-${process.pid}`;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const queue = [];
let busy = false;

function workNext() {
  if (busy) return;
  const msg = queue.shift();
  if (!msg) return;
  busy = true;
  const id = msg.id;
  const body = typeof msg.body === "string" ? msg.body : "";
  emit({ event: "turn_started", messageId: id });
  let ok = true;
  if (body.startsWith("@sh ")) {
    const res = spawnSync("/bin/sh", ["-c", body.slice(4)], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
    if (out.length > 0) emit({ event: "text", text: out });
    ok = res.status === 0;
    emit({ event: "text", text: ok ? "DONE" : `FAILED (exit ${res.status})` });
  } else {
    emit({ event: "text", text: `echo:${body}` });
  }
  emit({ event: "turn_ended", messageId: id, ok });
  busy = false;
  workNext();
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
rl.on("close", () => process.exit(0));

emit({ event: "ready", sessionId });
