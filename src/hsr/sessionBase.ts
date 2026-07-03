/**
 * HSR shared session plumbing (HIVE-20).
 *
 * The harness-agnostic scaffolding every RunnerSession needs, extracted from
 * streamRunner.ts and the codex adapter (which had duplicated it wholesale):
 *
 *   - spawnSessionChild: detached spawn + the async spawn-error handshake
 *     (a bad command surfaces via the 'error' event, not the sync return).
 *   - attachSessionPlumbing: the structured event queue backing the session's
 *     AsyncIterable, the rendered-text ring buffer with debounced ring.txt
 *     writes, event ingest (ts-stamp → queue → events.jsonl append → ring),
 *     the child-exit handler (exit event, stream end, parent-side pipe
 *     teardown), and process-group stop (SIGTERM → grace → SIGKILL).
 *
 * A new runner wires its protocol (parse/encode/transport hooks) and delegates
 * everything else here — see streamRunner.ts (tier "stream") and
 * adapters/codex.ts (tier "server") for the two shapes.
 *
 * Persistence split (single source of truth): the RUNNER appends to
 * events.jsonl + writes ring.txt. The host (host.ts) only broadcasts events to
 * live socket observers — it never re-appends. This keeps the durable log
 * authored in exactly one place, close to where events are produced.
 *
 * Node builtins only. Process-group teardown mirrors src/flow/background.ts.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { RunnerEvent } from "./types.js";
import { appendHsrEvent, appendRingText, writeHsrRing } from "./runDir.js";

// Debounce ring.txt writes so a chatty turn does not thrash the disk.
const RING_DEBOUNCE_MS = 50;
// Process-group teardown grace (SIGTERM → SIGKILL), mirrors flow/background.ts.
const STOP_GRACE_MS = 2_000;
const STOP_POLL_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spawn the harness child detached (own process group ⇒ pgid === pid, so
 * stop() can group-kill it) and wait for the OS-level spawn to succeed or
 * fail. Post-spawn errors (rare: e.g. EPIPE) are swallowed — they must not
 * crash the host.
 */
export async function spawnSessionChild(
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
): Promise<ChildProcess> {
  const child: ChildProcess = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    child.once("error", onError);
    child.once("spawn", () => {
      child.removeListener("error", onError);
      resolve();
    });
  });
  child.on("error", () => undefined);
  return child;
}

/** The shared per-session plumbing a runner builds its RunnerSession from. */
export type SessionPlumbing = {
  /** The structured event stream backing RunnerSession.events. */
  events: AsyncIterable<RunnerEvent>;
  /** Stamp ts (when 0/absent), queue, persist to events.jsonl, ring on text. */
  ingestEvent(event: RunnerEvent): void;
  /** Rendered text tail (RunnerSession.snapshot). */
  snapshot(lines?: number): string;
  /** True once the child has exited. */
  hasExited(): boolean;
  /** Resolves when the child has exited and the plumbing is torn down. */
  exitedPromise: Promise<void>;
  /** SIGTERM the child's process group, SIGKILL after a grace; awaits exit. */
  stop(): Promise<void>;
};

/**
 * Install the shared plumbing on a freshly spawned session child: event queue,
 * ring buffer, ingest, exit teardown, and group stop. `onChildExit` runs FIRST
 * in the exit handler, before the exit event is ingested — a runner disposes
 * its transport there (e.g. the codex RPC peer).
 */
export function attachSessionPlumbing(
  bee: string,
  child: ChildProcess,
  hooks: { onChildExit?: () => void } = {},
): SessionPlumbing {
  const childPgid = child.pid as number; // detached ⇒ leader of its own group

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

  // --- ingest one produced event: stamp, persist, queue, ring ----------------
  const ingestEvent = (event: RunnerEvent): void => {
    if (typeof (event as { ts?: unknown }).ts !== "number" || (event as { ts: number }).ts === 0) {
      (event as { ts: number }).ts = Date.now();
    }
    pushEvent(event);
    // The runner is the single writer of the durable event log (see file docs).
    void appendHsrEvent(bee, event).catch(() => undefined);
    if (event.type === "text") {
      ringText = appendRingText(ringText, event.text);
      scheduleRingWrite();
    }
  };

  // --- child exit -------------------------------------------------------------
  let exited = false;
  let resolveExited!: () => void;
  const exitedPromise = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  child.once("exit", (code, signal) => {
    exited = true;
    hooks.onChildExit?.();
    ingestEvent({ type: "exit", ts: Date.now(), code: code ?? null, signal: signal ?? undefined });
    flushRing();
    endStream();
    // Node does NOT auto-close the parent-side stdio pipes on child exit — the
    // stdin write pipe in particular stays an open handle and would keep the
    // host's event loop alive forever (a zombie __hsr-run process that never
    // exits after its session ends). Destroy them so the host exits cleanly.
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    resolveExited();
  });

  function snapshot(lines?: number): string {
    if (lines === undefined) return ringText;
    const all = ringText.split("\n");
    // Drop a trailing empty produced by the terminal newline before slicing.
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    return all.slice(Math.max(0, all.length - lines)).join("\n");
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

  return {
    events,
    ingestEvent,
    snapshot,
    hasExited: () => exited,
    exitedPromise,
    stop,
  };
}
