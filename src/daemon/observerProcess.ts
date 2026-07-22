// Isolated HSR observation (CL.701 §5 fix 1). The tick's heavy fs fan-out —
// hundreds of run-dir meta/event reads per tick — used to share the daemon's
// libuv threadpool with everything else. withTimeout never cancels the
// underlying fs call, so one lost completion (observed in production) leaves a
// thread wedged forever; a few of those and the pool is poisoned: every
// fs-backed stage times out, the loop breaches, the sentinel SIGKILLs — the
// recurring listSessions-timeout crash cycle. worker_threads would not help
// (libuv's threadpool is per-process), so the observation sweep runs in a
// DISPOSABLE CHILD PROCESS: a request that blows its deadline gets the child
// SIGKILLed — the orphaned fs calls die with it — and the next request spawns
// a fresh child. The daemon's own pool never touches a run dir.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { hsrObservations, type HsrEventSnapshot, type HsrObservation } from "../hsr/observe.js";
import { envMs } from "./timeouts.js";

type ObserveRequest = { id: number; bees: readonly string[] };
type WireEventSnapshot = Omit<HsrEventSnapshot, "tailEvents">;
type WireObservation = Omit<HsrObservation, "eventSnapshot"> & { eventSnapshot?: WireEventSnapshot };
type ObserveResponse = { id: number; ok: boolean; observations?: Array<[string, WireObservation]>; error?: string };

function observationToWire(observation: HsrObservation): WireObservation {
  const { eventSnapshot, ...rest } = observation;
  if (!eventSnapshot) return rest;
  // hsrEventSnapshot() aliases tailEvents to events. Sending both duplicated
  // every event in the observer's already-large JSON response.
  const { tailEvents: _tailEvents, ...snapshot } = eventSnapshot;
  return { ...rest, eventSnapshot: snapshot };
}

function observationFromWire(observation: WireObservation): HsrObservation {
  const { eventSnapshot, ...rest } = observation;
  if (!eventSnapshot) return rest;
  return { ...rest, eventSnapshot: { ...eventSnapshot, tailEvents: eventSnapshot.events } };
}

/** The child side: serve observation requests over stdin/stdout JSONL. */
export async function runHsrObserveWorker(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const lines = createInterface({ input, terminal: false });
  for await (const line of lines) {
    let request: ObserveRequest | null = null;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as ObserveRequest).id === "number" && Array.isArray((parsed as ObserveRequest).bees)) {
        request = parsed as ObserveRequest;
      }
    } catch {
      // ignore garbage lines
    }
    if (!request) continue;
    let response: ObserveResponse;
    try {
      const observations = await hsrObservations({ includeEvents: true, bees: request.bees });
      response = {
        id: request.id,
        ok: true,
        observations: [...observations].map(([bee, observation]) => [bee, observationToWire(observation)]),
      };
    } catch (error) {
      response = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    output.write(`${JSON.stringify(response)}\n`);
  }
}

export type ObserverChild = {
  stdin: Writable;
  stdout: Readable;
  kill: (signal?: NodeJS.Signals) => void;
  on: (event: "exit" | "error", listener: (...args: unknown[]) => void) => void;
  pid?: number | undefined;
};

export type IsolatedObserverOptions = {
  /** Per-request deadline; on breach the child is SIGKILLed and respawned. */
  timeoutMs?: number;
  /** Testing seam; defaults to spawning `<cli> daemon hsr-observe-worker`. */
  spawnChild?: () => ObserverChild;
};

export type IsolatedHsrObservations = ((beeNames: readonly string[]) => Promise<Map<string, HsrObservation>>) & {
  close: () => Promise<void>;
};

function defaultSpawnChild(): ObserverChild {
  const cliPath = process.argv[1];
  if (!cliPath) throw new Error("cannot resolve CLI entrypoint for the hsr observer child");
  // Preserve execArgv (e.g. `--import tsx` on source/dev daemons) or the
  // child cannot load a .ts entrypoint (review CR-12).
  const child: ChildProcess = spawn(process.execPath, [...process.execArgv, cliPath, "daemon", "hsr-observe-worker"], {
    // stderr inherits so a child crash is visible in the daemon's stream file.
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.unref();
  return child as unknown as ObserverChild;
}

/**
 * Build the TickDeps.hsrObservations implementation backed by the disposable
 * child. One request at a time (the tick is strictly sequential); a deadline
 * breach kills the child so its wedged fs work cannot poison anything, and
 * the NEXT request transparently respawns. A child that cannot even spawn
 * falls back to the in-process sweep — worse isolation beats no observation.
 */
export function createIsolatedHsrObservations(options: IsolatedObserverOptions = {}): IsolatedHsrObservations {
  const timeoutMs = options.timeoutMs ?? envMs("HIVE_DAEMON_OBSERVER_TIMEOUT_MS", 15_000);
  const spawnChild = options.spawnChild ?? defaultSpawnChild;
  let child: ObserverChild | null = null;
  let nextId = 1;
  let buffer = "";
  let scanOffset = 0;
  let decoder = new StringDecoder("utf8");
  const pending = new Map<number, { resolve: (value: ObserveResponse) => void; reject: (error: Error) => void }>();

  const teardown = (reason: string) => {
    for (const [, waiter] of pending) waiter.reject(new Error(reason));
    pending.clear();
    buffer = "";
    scanOffset = 0;
    decoder = new StringDecoder("utf8");
    child = null;
  };

  const ingestResponseText = (text: string): void => {
    if (!text) return;
    buffer += text;
    let newline = buffer.indexOf("\n", scanOffset);
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      scanOffset = 0;
      let response: ObserveResponse | null = null;
      try {
        response = JSON.parse(line) as ObserveResponse;
      } catch {
        newline = buffer.indexOf("\n");
        continue;
      }
      if (response && typeof response.id === "number") {
        const waiter = pending.get(response.id);
        if (waiter) {
          pending.delete(response.id);
          waiter.resolve(response);
        }
      }
      newline = buffer.indexOf("\n");
    }
    // No newline can appear in the already-scanned prefix. Resume at the old
    // end on the next chunk instead of splitting/rescanning the entire growing
    // multi-megabyte JSON response once per ~64 KiB stdout chunk.
    scanOffset = buffer.length;
  };

  const ensureChild = (): ObserverChild => {
    if (child) return child;
    const spawned = spawnChild();
    spawned.on("exit", () => {
      if (child === spawned) teardown("hsr observer child exited");
    });
    // Async spawn failures (ENOENT/EMFILE) and pipe errors (EPIPE on a child
    // that died mid-write) surface as 'error' EVENTS, not throws — unhandled,
    // they would crash the daemon this isolation exists to protect (CR-12).
    spawned.on("error", (error: unknown) => {
      if (child === spawned) {
        teardown(`hsr observer child error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    spawned.stdin.on("error", () => {
      if (child === spawned) teardown("hsr observer child stdin error");
    });
    spawned.stdout.on("error", () => {
      if (child === spawned) teardown("hsr observer child stdout error");
    });
    spawned.stdout.on("data", (chunk: Buffer | string) => {
      ingestResponseText(typeof chunk === "string" ? chunk : decoder.write(chunk));
    });
    child = spawned;
    return spawned;
  };

  const observe = async (beeNames: readonly string[]): Promise<Map<string, HsrObservation>> => {
    let target: ObserverChild;
    try {
      target = ensureChild();
    } catch {
      // Spawn failure (missing CLI entry, fork limits): observation must not
      // stop, so degrade to the in-process sweep.
      return hsrObservations({ includeEvents: true, bees: beeNames });
    }
    const id = nextId++;
    const response = await new Promise<ObserveResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // The whole point: kill the child so its orphaned fs work dies with
        // it instead of poisoning a shared threadpool.
        try {
          target.kill("SIGKILL");
        } catch {
          // already gone
        }
        if (child === target) teardown(`hsr observer request ${id} timed out`);
        reject(new Error(`hsr observer timed out after ${timeoutMs}ms (child killed)`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        target.stdin.write(`${JSON.stringify({ id, bees: beeNames } satisfies ObserveRequest)}\n`);
      } catch (error) {
        const waiter = pending.get(id);
        pending.delete(id);
        waiter?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (!response.ok) throw new Error(response.error ?? "hsr observer failed");
    return new Map((response.observations ?? []).map(([bee, observation]) => [bee, observationFromWire(observation)]));
  };

  const close = async (): Promise<void> => {
    const current = child;
    if (!current) return;
    teardown("hsr observer closed");
    try {
      current.kill("SIGTERM");
    } catch {
      // already gone
    }
  };

  return Object.assign(observe, { close });
}
