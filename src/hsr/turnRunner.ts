/**
 * HSR turn-tier runner.
 *
 * `startTurnRunner` is the reusable RunnerSession for tier-"turn" harnesses:
 * ONE short-lived child process PER TURN, with conversation state carried by
 * the harness's own resume mechanism (cursor `-p … --resume=<chatId>`). The
 * session outlives its children: the event queue / ring buffer
 * (createSessionPlumbing) span all turns, the provider session id is learned
 * from the first turn's init line, and every later turn resumes it.
 *
 * Semantics that differ from the one-child tiers:
 *   - send() commits the turn (enqueues + starts the drain loop) and returns;
 *     it does NOT wait for the turn to finish. Turns run strictly one at a
 *     time — a send during a live turn queues behind it.
 *   - The prompt travels over the child's STDIN (closed after the write), not
 *     argv — argv is visible to every local process in `ps`, and prompts can
 *     exceed argv limits.
 *   - A per-turn child exit does NOT emit an "exit" event or end the stream
 *     (the host would finalize the bee as exited after its first turn). Only
 *     stop() emits the terminal exit event.
 *
 * Node builtins only.
 */

import type { ChildProcess } from "node:child_process";
import type { RunnerEvent, RunnerOpts, RunnerSession } from "./types.js";
import { createSessionPlumbing, spawnSessionChild, stopChildGroup } from "./sessionBase.js";
import { makeLineReader } from "./lineReader.js";

export type TurnRunnerConfig = {
  harness: string;
  command: string;
  /** argv shared by every turn child (print/stream flags + caller args; no prompt). */
  baseArgs: string[];
  /**
   * Per-turn argv additions given the provider session id when one is known
   * (the resume selector, e.g. ["--resume=<id>"]). First fresh turn gets
   * undefined and returns [].
   */
  turnArgs(sessionId: string | undefined): string[];
  /** Parse one raw stdout line into zero or more RunnerEvents. */
  parseLine(line: string): RunnerEvent[];
  /** Optional: pull the provider session id out of an event/wire line. */
  sessionIdFromEvent?(event: RunnerEvent, raw: unknown): string | undefined;
};

// A never-emitted sentinel handed to sessionIdFromEvent for lines that produced
// no user-facing event (init lines), mirroring streamRunner.ts.
const SESSION_PROBE_EVENT: RunnerEvent = { type: "error", ts: 0, message: "" };

function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export async function startTurnRunner(config: TurnRunnerConfig, opts: RunnerOpts): Promise<RunnerSession> {
  const core = createSessionPlumbing(opts.bee);

  // A caller-supplied session id is honored only on an explicit RESUME: turn
  // harnesses have no "pin a fresh session to this id" flag, so resuming an id
  // the provider has never seen would fail the first turn outright. Fresh
  // sessions learn their id from the first turn's init line instead.
  let knownSessionId: string | undefined = opts.resume === true && opts.sessionId ? opts.sessionId : undefined;
  let currentChild: ChildProcess | null = null;
  let currentExited: () => boolean = () => true;
  let currentExitedPromise: Promise<void> = Promise.resolve();
  let stopped = false;
  const turnQueue: string[] = [];
  let draining = false;

  const session: RunnerSession = {
    sessionId: knownSessionId ?? "",
    tier: "turn",
    send,
    interrupt,
    answer,
    events: core.events,
    snapshot: core.snapshot,
    stop,
  };

  const learnSessionId = (id: string | undefined): void => {
    if (id && id.length > 0) {
      knownSessionId = id;
      session.sessionId = id;
    }
  };

  const handleStdoutLine = (onTurnEnd: () => void) => (line: string): void => {
    let produced: RunnerEvent[];
    try {
      produced = config.parseLine(line);
    } catch {
      return; // a parse-hook throw must not kill the read loop
    }
    if (config.sessionIdFromEvent) {
      const raw = safeJsonParse(line);
      if (produced.length === 0) {
        learnSessionId(config.sessionIdFromEvent(SESSION_PROBE_EVENT, raw));
      } else {
        for (const ev of produced) learnSessionId(config.sessionIdFromEvent(ev, raw));
      }
    }
    for (const ev of produced) {
      if (ev.type === "turn_end") onTurnEnd();
      core.ingestEvent(ev);
    }
  };

  async function runTurn(text: string): Promise<void> {
    core.ingestEvent({ type: "turn_start", ts: Date.now() });
    const args = [...config.baseArgs, ...config.turnArgs(knownSessionId)];
    let child: ChildProcess;
    try {
      child = await spawnSessionChild(config.command, args, { cwd: opts.cwd, env: opts.env });
    } catch (error) {
      core.ingestEvent({
        type: "error",
        ts: Date.now(),
        message: `could not start ${config.harness} turn: ${error instanceof Error ? error.message : String(error)}`,
      });
      core.ingestEvent({ type: "turn_end", ts: Date.now() });
      return;
    }
    let exited = false;
    let exitCode: number | null = null;
    const exitedPromise = new Promise<void>((resolve) => {
      child.once("exit", (code) => {
        exited = true;
        exitCode = code ?? null;
        // Parent-side pipes are not auto-closed on child exit; a leaked stdin
        // handle per turn would keep the host's event loop pinned forever.
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve();
      });
    });
    currentChild = child;
    currentExited = () => exited;
    currentExitedPromise = exitedPromise;
    session.pid = child.pid as number;

    let sawTurnEnd = false;
    child.stdout?.on("data", makeLineReader(handleStdoutLine(() => (sawTurnEnd = true))));
    child.stderr?.on("data", makeLineReader((line: string) => {
      core.ingestEvent({ type: "error", ts: Date.now(), message: line });
    }));

    // Deliver the prompt over stdin and close it — print mode reads to EOF.
    const stdin = child.stdin;
    if (stdin && !stdin.destroyed) {
      stdin.on("error", () => undefined); // EPIPE from an early child exit
      stdin.end(text);
    }

    await exitedPromise;
    currentChild = null;
    if (!sawTurnEnd) {
      // The child died without a result line (crash, auth failure). Surface a
      // non-zero exit as an error so the turn's failure is observable, and
      // close the turn bracket either way.
      if (exitCode !== null && exitCode !== 0) {
        core.ingestEvent({ type: "error", ts: Date.now(), message: `${config.harness} turn exited with code ${exitCode}` });
      }
      core.ingestEvent({ type: "turn_end", ts: Date.now() });
    }
    core.flushRing();
  }

  function drain(): void {
    if (draining) return;
    draining = true;
    void (async () => {
      try {
        while (turnQueue.length > 0 && !stopped) {
          await runTurn(turnQueue.shift()!);
        }
      } finally {
        draining = false;
        // Turns queued while the loop was winding down still need a drain.
        if (turnQueue.length > 0 && !stopped) drain();
      }
    })();
  }

  async function send(text: string): Promise<void> {
    if (stopped) throw new Error("hsr turn: session stopped");
    turnQueue.push(text);
    drain();
  }

  async function answer(): Promise<void> {
    // Turn children run headless with force/trust flags; there is no live
    // prompt channel to answer into.
    throw new Error("answer not supported by this harness (turn tier)");
  }

  async function interrupt(): Promise<void> {
    const child = currentChild;
    if (!child) return;
    try {
      child.kill("SIGINT");
    } catch {
      // best-effort
    }
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    turnQueue.length = 0;
    const child = currentChild;
    if (child) {
      await stopChildGroup(child, currentExited, currentExitedPromise).catch(() => undefined);
    }
    core.ingestEvent({ type: "exit", ts: Date.now(), code: null });
    core.flushRing();
    core.endStream();
  }

  return session;
}
