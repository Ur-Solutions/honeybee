/**
 * HSR stream-tier runner (APIA-78).
 *
 * `BaseStreamRunner` is the reusable RunnerSession for tier-"stream" harnesses:
 * ONE child process per bee, an NDJSON-ish stdin/stdout protocol, multi-turn
 * (claude `-p --output-format stream-json`, kimi `acp`). It is CONFIGURED by a
 * per-harness adapter through a `StreamRunnerConfig` (parse/encode hooks) — the
 * process plumbing (spawn, line buffering, event queue, ring buffer, run-dir
 * persistence, process-group teardown) lives here and is shared.
 *
 * Persistence split (single source of truth): the RUNNER appends to
 * events.jsonl + writes ring.txt. The host (host.ts) only broadcasts events to
 * live socket observers — it never re-appends. This keeps the durable log
 * authored in exactly one place, close to where events are produced.
 *
 * Node builtins only. Process-group teardown mirrors src/flow/background.ts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { RunnerEvent, RunnerOpts, RunnerSession, RunnerTier } from "./types.js";
import { appendHsrEvent, writeHsrRing } from "./runDir.js";

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

// Ring buffer caps — whichever hits first bounds the rendered tail.
const RING_MAX_LINES = 200;
const RING_MAX_BYTES = 16 * 1024;
// Debounce ring.txt writes so a chatty turn does not thrash the disk.
const RING_DEBOUNCE_MS = 50;
// Process-group teardown grace (SIGTERM → SIGKILL), mirrors flow/background.ts.
const STOP_GRACE_MS = 2_000;
const STOP_POLL_MS = 25;

// A never-emitted sentinel handed to sessionIdFromEvent for lines that produced
// no user-facing event (e.g. claude/stub `system`/`init`), so the provider
// session id can still be learned at init from `raw` (the parsed wire line).
const SESSION_PROBE_EVENT: RunnerEvent = { type: "error", ts: 0, message: "" };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

  const child: ChildProcess = spawn(config.command, config.args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true, // own process group ⇒ pgid === child.pid, group-killable on stop()
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Wait for the OS-level spawn to succeed or fail; a bad command surfaces via
  // the async 'error' event, not the synchronous return.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    child.once("error", onError);
    child.once("spawn", () => {
      child.removeListener("error", onError);
      resolve();
    });
  });
  // Post-spawn errors (rare: e.g. EPIPE) must not crash the host.
  child.on("error", () => undefined);

  const childPid = child.pid as number;
  const childPgid = childPid; // detached ⇒ leader of its own group

  // --- structured event queue (backs the AsyncIterable) ----------------------
  const queue: RunnerEvent[] = [];
  const waiters: Array<(r: IteratorResult<RunnerEvent>) => void> = [];
  let ended = false;

  const pushEvent = (event: RunnerEvent): void => {
    if (ended) return;
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else queue.push(event);
  };
  const endStream = (): void => {
    if (ended) return;
    ended = true;
    for (const waiter of waiters.splice(0)) waiter({ value: undefined as never, done: true });
  };

  const events: AsyncIterable<RunnerEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<RunnerEvent> {
      return {
        next(): Promise<IteratorResult<RunnerEvent>> {
          const buffered = queue.shift();
          if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
          if (ended) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  // --- ring buffer (rendered text tail) --------------------------------------
  let ringText = "";
  let ringTimer: NodeJS.Timeout | null = null;

  const ringAppend = (text: string): void => {
    ringText += text.endsWith("\n") ? text : `${text}\n`;
    // Cap by line count.
    const lines = ringText.split("\n");
    if (lines.length > RING_MAX_LINES + 1) {
      ringText = lines.slice(lines.length - (RING_MAX_LINES + 1)).join("\n");
    }
    // Then cap by byte size, dropping whole leading lines.
    while (Buffer.byteLength(ringText, "utf8") > RING_MAX_BYTES) {
      const nl = ringText.indexOf("\n");
      if (nl === -1) {
        ringText = ringText.slice(ringText.length - RING_MAX_BYTES);
        break;
      }
      ringText = ringText.slice(nl + 1);
    }
  };
  const scheduleRingWrite = (): void => {
    if (ringTimer) return;
    ringTimer = setTimeout(() => {
      ringTimer = null;
      void writeHsrRing(bee, ringText).catch(() => undefined);
    }, RING_DEBOUNCE_MS);
  };
  const flushRing = (): void => {
    if (ringTimer) {
      clearTimeout(ringTimer);
      ringTimer = null;
    }
    void writeHsrRing(bee, ringText).catch(() => undefined);
  };

  const session: RunnerSession = {
    sessionId: opts.sessionId ?? "",
    tier: config.tier,
    pid: childPid,
    send,
    interrupt,
    answer,
    events,
    snapshot,
    stop,
  };

  const learnSessionId = (id: string | undefined): void => {
    if (id && id.length > 0) session.sessionId = id;
  };

  // --- ingest one produced event: stamp, persist, queue, ring ----------------
  const ingestEvent = (event: RunnerEvent): void => {
    if (typeof (event as { ts?: unknown }).ts !== "number" || (event as { ts: number }).ts === 0) {
      (event as { ts: number }).ts = Date.now();
    }
    pushEvent(event);
    // The runner is the single writer of the durable event log (see file docs).
    void appendHsrEvent(bee, event).catch(() => undefined);
    if (event.type === "text") {
      ringAppend(event.text);
      scheduleRingWrite();
    }
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
    for (const ev of produced) ingestEvent(ev);
  };

  const handleStderrLine = (line: string): void => {
    // Stderr is diagnostic noise, not a failure — surface as an error event.
    ingestEvent({ type: "error", ts: Date.now(), message: line });
  };

  child.stdout?.on("data", makeLineReader(handleStdoutLine));
  child.stderr?.on("data", makeLineReader(handleStderrLine));

  // --- child exit ------------------------------------------------------------
  let exited = false;
  let resolveExited!: () => void;
  const exitedPromise = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  child.once("exit", (code, signal) => {
    exited = true;
    ingestEvent({ type: "exit", ts: Date.now(), code: code ?? null, signal: signal ?? undefined });
    flushRing();
    endStream();
    resolveExited();
  });

  function snapshot(lines?: number): string {
    if (lines === undefined) return ringText;
    const all = ringText.split("\n");
    // Drop a trailing empty produced by the terminal newline before slicing.
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    return all.slice(Math.max(0, all.length - lines)).join("\n");
  }

  async function send(text: string): Promise<void> {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("hsr stream: child stdin is not writable (session ended?)");
    }
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
    if (exited) return;
    try {
      child.kill("SIGINT");
    } catch {
      // best-effort
    }
  }

  async function stop(): Promise<void> {
    if (exited) return exitedPromise;
    // SIGTERM the whole process group, then SIGKILL after a short grace.
    try {
      process.kill(-childPgid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        // Fall back to signalling just the child if the group signal fails.
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
    const deadline = Date.now() + STOP_GRACE_MS;
    while (!exited && Date.now() < deadline) await sleep(STOP_POLL_MS);
    if (!exited) {
      try {
        process.kill(-childPgid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    await exitedPromise;
  }

  return session;
}
