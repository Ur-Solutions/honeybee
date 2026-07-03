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

import type { RunnerEvent, RunnerOpts, RunnerSession, RunnerTier } from "./types.js";
import { attachSessionPlumbing, spawnSessionChild } from "./sessionBase.js";

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

/** Split a byte stream into complete lines; buffers the partial trailing line. */
function makeLineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const trimmed = line.replace(/\r$/, "");
      if (trimmed.length > 0) onLine(trimmed);
      nl = buffer.indexOf("\n");
    }
  };
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
    for (const ev of produced) plumbing.ingestEvent(ev);
  };

  const handleStderrLine = (line: string): void => {
    // Stderr is diagnostic noise, not a failure — surface as an error event.
    plumbing.ingestEvent({ type: "error", ts: Date.now(), message: line });
  };

  child.stdout?.on("data", makeLineReader(handleStdoutLine));
  child.stderr?.on("data", makeLineReader(handleStderrLine));

  async function send(text: string): Promise<void> {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("hsr stream: child stdin is not writable (session ended?)");
    }
    // Bracket each turn: emit turn_start before the bytes hit stdin so
    // turn_start/turn_end frame every turn across all stream harnesses.
    plumbing.ingestEvent({ type: "turn_start", ts: Date.now() });
    await new Promise<void>((resolve, reject) => {
      stdin.write(config.encodeUserTurn(text), (err) => (err ? reject(err) : resolve()));
    });
  }

  async function answer(requestId: string, answerText: string): Promise<void> {
    if (!config.encodeAnswer) throw new Error("answer not supported by this harness");
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
    try {
      child.kill("SIGINT");
    } catch {
      // best-effort
    }
  }

  return session;
}
