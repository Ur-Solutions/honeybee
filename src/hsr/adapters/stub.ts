/**
 * HSR stub adapter (APIA-78) — a real child process, but not a real harness.
 *
 * Exists so the runner-host + stream-runner + run-dir observer can be unit
 * tested end-to-end in isolation, with no claude/codex binary and no network.
 * The "harness" is a tiny node script run via `process.execPath -e <SCRIPT>`
 * that speaks a trivial NDJSON protocol:
 *
 *   out: {"t":"init","sessionId":"..."}         once at startup
 *   in:  {"text":"..."}                          a user turn
 *   out: {"t":"assistant","text":"echo:..."}     + {"t":"result"}   (normal turn)
 *   out: {"t":"needs","requestId":"r1",...}       (turn containing the word "ask")
 *   in:  {"answer":"..."}                         answer to the pending needs
 *   out: {"t":"assistant","text":"answered:..."} + {"t":"result"}
 *
 * The provider session id comes from `opts.sessionId` (threaded through env) or
 * a fixed fallback, so tests can assert both the pinned and learned paths.
 */

import type { RunnerAdapter, RunnerEvent, RunnerOpts, RunnerSession, RunnerTier } from "../types.js";
import { startStreamRunner, type StreamRunnerConfig } from "../streamRunner.js";

const STUB_SESSION_ENV = "HSR_STUB_SESSION_ID";
const STUB_DEFAULT_SESSION_ID = "stub-session";

// The embedded "harness". CommonJS scope (node -e) → `require` is available.
// A single pending-answer slot models the needs_input round-trip.
const STUB_SCRIPT = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const sid = process.env.${STUB_SESSION_ENV} || "${STUB_DEFAULT_SESSION_ID}";
function emit(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
emit({ t: "init", sessionId: sid });
let pendingRequestId = null;
rl.on("line", (raw) => {
  const line = String(raw).trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // In-band turn interrupt (streamRunner encodeInterrupt): end the current
  // turn with a result line, exactly like claude's control_request handling.
  if (msg.interrupt) {
    emit({ t: "result" });
    pendingRequestId = null;
    return;
  }
  if (pendingRequestId) {
    const answer = typeof msg.answer === "string" ? msg.answer : "";
    emit({ t: "assistant", text: "answered:" + answer });
    emit({ t: "result" });
    pendingRequestId = null;
    return;
  }
  const text = typeof msg.text === "string" ? msg.text : "";
  if (text.includes("ask")) {
    pendingRequestId = "r1";
    emit({ t: "needs", requestId: "r1", question: "proceed?" });
    return;
  }
  // A turn mentioning "slowtool" runs a slow tool: assistant text now, a tool
  // event after a beat, the closing result after another — a window for tests
  // to park a next-tool steer against a LIVE turn (queued-steering spec).
  // A "hang" turn never ends on its own — the interrupt test's target.
  if (text.includes("hang")) {
    emit({ t: "assistant", text: "hanging:" + text });
    return;
  }
  if (text.includes("slowtool")) {
    emit({ t: "assistant", text: "starting:" + text });
    setTimeout(() => emit({ t: "tool", tool: "hammer" }), 120);
    setTimeout(() => { emit({ t: "assistant", text: "after-tool" }); emit({ t: "result" }); }, 240);
    return;
  }
  emit({ t: "assistant", text: "echo:" + text });
  // A turn mentioning "usage" also reports token usage — lets tests exercise the
  // usage-event path (per-turn counts) end to end.
  if (text.includes("usage")) emit({ t: "usage", inputTokens: 100, outputTokens: 10 });
  emit({ t: "result" });
});
`;

function parseStub(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const stubConfig: StreamRunnerConfig = {
  harness: "stub",
  tier: "stream",
  command: process.execPath,
  args: ["-e", STUB_SCRIPT],
  parseLine(line: string): RunnerEvent[] {
    const msg = parseStub(line) as Record<string, unknown> | undefined;
    if (!msg || typeof msg.t !== "string") return [];
    switch (msg.t) {
      case "init":
        return []; // sessionId captured via sessionIdFromEvent (event-less init line)
      case "assistant":
        return [{ type: "text", ts: 0, text: String(msg.text ?? "") }];
      case "needs":
        return [
          {
            type: "needs_input",
            ts: 0,
            kind: "question",
            question: String(msg.question ?? ""),
            requestId: typeof msg.requestId === "string" ? msg.requestId : undefined,
          },
        ];
      case "tool":
        return [{ type: "tool_use", ts: 0, tool: String(msg.tool ?? "") }];
      case "usage":
        return [
          {
            type: "usage",
            ts: 0,
            inputTokens: Number(msg.inputTokens ?? 0),
            outputTokens: Number(msg.outputTokens ?? 0),
          },
        ];
      case "result":
        return [{ type: "turn_end", ts: 0 }];
      default:
        return [];
    }
  },
  encodeUserTurn(text: string): string {
    return `${JSON.stringify({ text })}\n`;
  },
  encodeAnswer(_requestId: string, answer: string): string {
    return `${JSON.stringify({ answer })}\n`;
  },
  encodeInterrupt(): string {
    return `${JSON.stringify({ interrupt: true })}\n`;
  },
  sessionIdFromEvent(_event: RunnerEvent, raw: unknown): string | undefined {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (obj.t === "init" && typeof obj.sessionId === "string") return obj.sessionId;
    }
    return undefined;
  },
};

export const stubAdapter: RunnerAdapter = {
  harness: "stub",
  tier(): RunnerTier {
    return "stream";
  },
  start(opts: RunnerOpts): Promise<RunnerSession> {
    // Thread the desired provider session id into the child via env so the
    // stub can echo it back on its init line (learned-sessionId path).
    const env = { ...opts.env, [STUB_SESSION_ENV]: opts.sessionId ?? STUB_DEFAULT_SESSION_ID };
    return startStreamRunner(stubConfig, { ...opts, env });
  },
};
