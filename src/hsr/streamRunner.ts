/**
 * HSR stream-tier runner (APIA-78).
 *
 * `startStreamRunner` is the reusable RunnerSession for tier-"stream" harnesses:
 * ONE child process per bee, an NDJSON-ish stdin/stdout protocol, multi-turn
 * (claude `-p --output-format stream-json`, kimi `acp`). It is CONFIGURED by a
 * per-harness adapter through a `StreamRunnerConfig` (parse/encode hooks) — the
 * harness-agnostic plumbing (event queue, ring buffer, run-dir persistence,
 * exit teardown, process-group stop) lives in sessionBase.ts and is shared
 * with the server-tier codex adapter; this file owns only the line-oriented
 * stdio protocol on top of it.
 *
 * Node builtins only.
 */

import type { RunnerEvent, RunnerInputAnswer, RunnerOpts, RunnerSendOpts, RunnerSession, RunnerTier } from "./types.js";
import { attachSessionPlumbing, spawnSessionChild } from "./sessionBase.js";
import { makeLineReader } from "./lineReader.js";

export type StreamRunnerConfig = {
  harness: string;
  tier: RunnerTier; // "stream"
  command: string;
  args: string[]; // resolved argv for the child
  /** Parse one raw stdout line into zero or more RunnerEvents. */
  parseLine(line: string): RunnerEvent[];
  /** Encode a user turn as the bytes to write to child stdin (include trailing newline). */
  encodeUserTurn(text: string): string;
  /** Optional: encode an answer to a needs_input requestId (permission/question). */
  encodeAnswer?(requestId: string, answer: string): string;
  /**
   * Optional: encode a TURN interrupt as a stdin line (e.g. claude's
   * stream-json `control_request {subtype:"interrupt"}`). When absent,
   * interrupt() falls back to SIGINT — which kills a headless child outright
   * and finalizes the bee as crashed, so provide this wherever the harness
   * has an in-band interrupt.
   */
  encodeInterrupt?(): string;
  /** Optional: pull the provider session id out of an event (e.g. claude system/init). */
  sessionIdFromEvent?(event: RunnerEvent, raw: unknown): string | undefined;
};

// A never-emitted sentinel handed to sessionIdFromEvent for lines that produced
// no user-facing event (e.g. claude/stub `system`/`init`), so the provider
// session id can still be learned at init from `raw` (the parsed wire line).
const SESSION_PROBE_EVENT: RunnerEvent = { type: "error", ts: 0, message: "" };

function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export async function startStreamRunner(config: StreamRunnerConfig, opts: RunnerOpts): Promise<RunnerSession> {
  const bee = opts.bee;

  const child = await spawnSessionChild(config.command, config.args, { cwd: opts.cwd, env: opts.env });
  const plumbing = attachSessionPlumbing(bee, child);

  const session: RunnerSession = {
    sessionId: opts.sessionId ?? "",
    tier: config.tier,
    pid: child.pid as number,
    send,
    interrupt,
    answer,
    events: plumbing.events,
    snapshot: plumbing.snapshot,
    stop: plumbing.stop,
  };

  const learnSessionId = (id: string | undefined): void => {
    if (id && id.length > 0) session.sessionId = id;
  };

  // next-tool hold (queued-steering spec): texts parked here wait for the
  // current turn's next tool boundary. `turnActive` brackets between our own
  // turn_start (send) and the harness's turn_end.
  let turnActive = false;
  const heldForNextTool: string[] = [];

  const handleStdoutLine = (line: string): void => {
    let produced: RunnerEvent[];
    try {
      produced = config.parseLine(line);
    } catch {
      return; // a parse-hook throw must not kill the read loop
    }
    // Learn the provider session id — from produced events, or from an
    // event-less init line via the sentinel probe.
    if (config.sessionIdFromEvent) {
      const raw = safeJsonParse(line);
      if (produced.length === 0) {
        learnSessionId(config.sessionIdFromEvent(SESSION_PROBE_EVENT, raw));
      } else {
        for (const ev of produced) learnSessionId(config.sessionIdFromEvent(ev, raw));
      }
    }
    for (const ev of produced) {
      if (ev.type === "turn_end") turnActive = false;
      plumbing.ingestEvent(ev);
      // Flush AFTER ingesting so the boundary event precedes the interjected
      // text in the durable stream. tool_use flushes into the live turn;
      // turn_end flushes as a fresh turn (writeTurn re-brackets).
      if (ev.type === "tool_use" || ev.type === "turn_end") flushHeldForNextTool();
    }
  };

  const handleStderrLine = (line: string): void => {
    // Stderr is diagnostic noise, not a failure — surface as an error event.
    plumbing.ingestEvent({ type: "error", ts: Date.now(), message: line });
  };

  child.stdout?.on("data", makeLineReader(handleStdoutLine));
  child.stderr?.on("data", makeLineReader(handleStderrLine));

  function writableStdin(): NonNullable<typeof child.stdin> {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("hsr stream: child stdin is not writable (session ended?)");
    }
    return stdin;
  }

  async function writeTurn(text: string): Promise<void> {
    const stdin = writableStdin();
    // Bracket each turn: emit turn_start before the bytes hit stdin so
    // turn_start/turn_end frame every turn across all stream harnesses.
    turnActive = true;
    plumbing.ingestEvent({ type: "turn_start", ts: Date.now() });
    await new Promise<void>((resolve, reject) => {
      stdin.write(config.encodeUserTurn(text), (err) => (err ? reject(err) : resolve()));
    });
  }

  // Interject into the LIVE turn: no turn_start re-bracket — the text joins
  // the turn the harness is already running.
  async function writeInterjection(text: string): Promise<void> {
    const stdin = writableStdin();
    await new Promise<void>((resolve, reject) => {
      stdin.write(config.encodeUserTurn(text), (err) => (err ? reject(err) : resolve()));
    });
  }

  function flushHeldForNextTool(): void {
    if (heldForNextTool.length === 0) return;
    const texts = heldForNextTool.splice(0, heldForNextTool.length);
    // Fire-and-forget from the stdout read loop; a write failure surfaces as
    // an error event rather than killing the reader.
    void (async () => {
      for (const text of texts) {
        try {
          if (turnActive) await writeInterjection(text);
          else await writeTurn(text);
        } catch (error) {
          plumbing.ingestEvent({
            type: "error",
            ts: Date.now(),
            message: `next-tool steer dropped: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    })();
  }

  async function send(text: string, opts?: RunnerSendOpts): Promise<void> {
    if (opts?.mode === "next-tool" && turnActive) {
      writableStdin(); // fail the caller NOW if the session is already dead
      heldForNextTool.push(text);
      return;
    }
    await writeTurn(text);
  }

  async function answer(requestId: string, answerValue: RunnerInputAnswer): Promise<void> {
    if (!config.encodeAnswer) throw new Error("answer not supported by this harness");
    const answerText = typeof answerValue === "string" ? answerValue : JSON.stringify(answerValue);
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("hsr stream: child stdin is not writable (session ended?)");
    }
    await new Promise<void>((resolve, reject) => {
      stdin.write(config.encodeAnswer!(requestId, answerText), (err) => (err ? reject(err) : resolve()));
    });
  }

  async function interrupt(): Promise<void> {
    if (plumbing.hasExited()) return;
    // Prefer the harness's in-band interrupt: it ends the TURN and keeps the
    // session alive. SIGINT (the fallback) kills a headless child outright —
    // the host then finalizes the bee as exited, which reads as crashed.
    if (config.encodeInterrupt) {
      try {
        const stdin = writableStdin();
        await new Promise<void>((resolve, reject) => {
          stdin.write(config.encodeInterrupt!(), (err) => (err ? reject(err) : resolve()));
        });
        return;
      } catch {
        // stdin gone — fall through to the signal path.
      }
    }
    try {
      child.kill("SIGINT");
    } catch {
      // best-effort
    }
  }

  return session;
}
