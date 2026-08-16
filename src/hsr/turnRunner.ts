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
import type { RunnerEvent, RunnerInterruptResult, RunnerOpts, RunnerPreparedAnswer, RunnerSession } from "./types.js";
import { createSessionPlumbing, noteChildProcessEvent, spawnSessionChild, stopChildGroup } from "./sessionBase.js";
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
  /** Bounded EOF wait after an exited child with no exact turn_end (tests may shorten it). */
  pipeDrainTimeoutMs?: number;
};

const DEFAULT_TURN_PIPE_DRAIN_TIMEOUT_MS = 2_000;

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
  const core = createSessionPlumbing(opts.bee, opts.eventHost, opts.onEventPersistenceFailure);

  // A caller-supplied session id is honored only on an explicit RESUME: turn
  // harnesses have no "pin a fresh session to this id" flag, so resuming an id
  // the provider has never seen would fail the first turn outright. Fresh
  // sessions learn their id from the first turn's init line instead.
  let knownSessionId: string | undefined = opts.resume === true && opts.sessionId ? opts.sessionId : undefined;
  let currentChild: ChildProcess | null = null;
  let stopped = false;
  const turnQueue: string[] = [];
  const turnChildren: Array<{ child: ChildProcess; exited: () => boolean; exitedPromise: Promise<void> }> = [];
  let draining = false;
  let failed = false;

  const session: RunnerSession = {
    sessionId: knownSessionId ?? "",
    tier: "turn",
    send,
    interrupt,
    prepareAnswer,
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
      if (currentChild) noteChildProcessEvent(currentChild, ev);
      core.ingestEvent(ev);
    }
  };

  async function runTurn(text: string): Promise<void> {
    core.ingestEvent({ type: "turn_start", ts: Date.now() });
    const args = [...config.baseArgs, ...config.turnArgs(knownSessionId)];
    let child: ChildProcess;
    try {
      child = await spawnSessionChild(config.command, args, {
        cwd: opts.cwd,
        env: opts.env,
        onChildSpawnPending: opts.onChildSpawnPending,
        onChildSpawnFailure: opts.onChildSpawnFailure,
        onChildSpawn: opts.onChildSpawn,
      });
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
    let outputDrainError: Error | undefined;
    let resolveExited!: () => void;
    const exitedPromise = new Promise<void>((resolve) => { resolveExited = resolve; });
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
    child.once("exit", (code) => {
      exited = true;
      exitCode = code ?? null;
      resolveExited();
      // stdin carries no provider output. Keep stdout/stderr intact until an
      // exact terminal boundary or verified EOF below.
      child.stdin?.destroy();
    });
    child.once("close", (code) => {
      if (!exited) {
        exited = true;
        exitCode = code ?? null;
        resolveExited();
      }
      resolveClosed();
    });
    currentChild = child;
    turnChildren.push({ child, exited: () => exited, exitedPromise });
    session.pid = child.pid as number;
    // stop() may have run while spawnSessionChild awaited the OS spawn event.
    // The session-level snapshot could not include this child yet, so close
    // the race here before installing protocol listeners or delivering stdin.
    if (stopped) {
      await stopChildGroup(child, () => exited, exitedPromise).catch(() => undefined);
      if (currentChild === child) currentChild = null;
      return;
    }

    let sawTurnEnd = false;
    let resolveTurnEnd!: () => void;
    const turnEndPromise = new Promise<void>((resolve) => { resolveTurnEnd = resolve; });
    const stdoutReader = makeLineReader(handleStdoutLine(() => {
      if (sawTurnEnd) return;
      sawTurnEnd = true;
      resolveTurnEnd();
    }));
    const stderrReader = makeLineReader((line: string) => {
      core.ingestEvent({ type: "error", ts: Date.now(), message: line });
    });
    let terminalPipeCutoff = false;
    const watchOutput = (name: "stdout" | "stderr", stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return;
      let reachedEof = false;
      stream.once("end", () => { reachedEof = true; });
      stream.once("error", (error) => {
        outputDrainError ??= new Error(`HSR turn child ${name} failed before EOF`, { cause: error });
      });
      stream.once("close", () => {
        if (!reachedEof && !terminalPipeCutoff) {
          outputDrainError ??= new Error(`HSR turn child ${name} closed before EOF`);
        }
      });
    };
    child.stdout?.on("data", stdoutReader);
    child.stdout?.once("end", () => stdoutReader.end());
    child.stderr?.on("data", stderrReader);
    child.stderr?.once("end", () => stderrReader.end());
    watchOutput("stdout", child.stdout);
    watchOutput("stderr", child.stderr);

    // Deliver the prompt over stdin and close it — print mode reads to EOF.
    const stdin = child.stdin;
    if (stdin && !stdin.destroyed) {
      stdin.on("error", () => undefined); // EPIPE from an early child exit
      stdin.end(text);
    }

    // `close` is the strongest ordinary drain proof, but a detached tool may
    // intentionally inherit stdout and keep that event open long after the
    // short-lived CLI parent exits. An exact parsed turn_end is the provider's
    // terminal protocol boundary: once the parent has exited, yield once for
    // already-queued data callbacks, then close only this process's pipe views.
    // The descendant remains tracked and alive until session.stop(). Without a
    // terminal boundary, an EOF that never arrives is ambiguity, not an idle
    // turn; fail the stream after a bounded wait so the host creates its durable
    // event-integrity receipt and exact-stops the owned process groups.
    let timeout: NodeJS.Timeout | undefined;
    let pipeSettled = false;
    const timeoutOutcome = exitedPromise.then(() => new Promise<"timeout">((resolve) => {
      if (pipeSettled) return;
      timeout = setTimeout(() => resolve("timeout"), Math.max(1, config.pipeDrainTimeoutMs ?? DEFAULT_TURN_PIPE_DRAIN_TIMEOUT_MS));
      timeout.unref();
    }));
    const terminalOutcome = Promise.all([exitedPromise, turnEndPromise]).then(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return "terminal" as const;
    });
    const pipeOutcome = await Promise.race([
      closedPromise.then(() => "closed" as const),
      terminalOutcome,
      timeoutOutcome,
    ]);
    pipeSettled = true;
    if (timeout) clearTimeout(timeout);
    if (pipeOutcome !== "closed") {
      terminalPipeCutoff = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    if (pipeOutcome === "timeout") {
      outputDrainError ??= new Error(
        `HSR ${config.harness} turn child exited without a terminal turn boundary or verified pipe EOF`,
      );
    }
    currentChild = null;
    if (outputDrainError) {
      failed = true;
      turnQueue.length = 0;
      await core.fail(outputDrainError);
      return;
    }
    if (!sawTurnEnd) {
      // The child died without a result line (crash, auth failure). Surface a
      // non-zero exit as an error so the turn's failure is observable, and
      // close the turn bracket either way.
      if (exitCode !== null && exitCode !== 0) {
        core.ingestEvent({ type: "error", ts: Date.now(), message: `${config.harness} turn exited with code ${exitCode}` });
      }
      core.ingestEvent({ type: "turn_end", ts: Date.now() });
    }
    await core.flushRing();
  }

  function drain(): void {
    if (draining) return;
    draining = true;
    void (async () => {
      try {
        while (turnQueue.length > 0 && !stopped && !failed) {
          await runTurn(turnQueue.shift()!);
        }
      } finally {
        draining = false;
        // Turns queued while the loop was winding down still need a drain.
        if (turnQueue.length > 0 && !stopped && !failed) drain();
      }
    })();
  }

  async function send(text: string): Promise<void> {
    if (stopped) throw new Error("hsr turn: session stopped");
    if (failed) throw new Error("hsr turn: session failed");
    turnQueue.push(text);
    drain();
  }

  async function prepareAnswer(): Promise<RunnerPreparedAnswer> {
    // Turn children run headless with force/trust flags; there is no live
    // prompt channel to answer into.
    throw new Error("answer not supported by this harness (turn tier)");
  }

  async function answer(): Promise<void> {
    await prepareAnswer();
  }

  async function interrupt(): Promise<RunnerInterruptResult> {
    const child = currentChild;
    if (!child) return { status: "already_idle" };
    try {
      child.kill("SIGINT");
    } catch {
      // best-effort
    }
    return { status: "interrupt_requested" };
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    turnQueue.length = 0;
    // Per-turn children may intentionally leave previews/dev servers running
    // for later turns. Retain every ownership scope until the SESSION stops,
    // then reap current and completed turns together.
    await Promise.all(
      turnChildren.map(({ child, exited, exitedPromise }) =>
        stopChildGroup(child, exited, exitedPromise).catch(() => undefined),
      ),
    );
    core.ingestEvent({ type: "exit", ts: Date.now(), code: null });
    // Process ownership is already settled above. Event persistence failures
    // are surfaced through the iterator/host integrity marker; they must not
    // make an otherwise exact child-group stop look unconfirmed.
    await core.flushRing().catch(() => undefined);
    await core.endStream().catch(() => undefined);
  }

  return session;
}
