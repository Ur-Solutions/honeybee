/**
 * Disposable-process session enumeration. A lost fs.promises completion cannot
 * be cancelled in-process; timing it out merely leaves the registry walk alive
 * to overlap the next tick. This worker keeps that fs work in a child process:
 * a deadline breach SIGKILLs the entire libuv pool, and the next request starts
 * with a clean child.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { storeRoot } from "../fsx.js";
import { listSessions, type SessionRecord } from "../store.js";
import { envMs } from "./timeouts.js";

type SessionListRequest = { id: number; root: string };
type SessionListResponse = { id: number; ok: boolean; records?: SessionRecord[]; error?: string };

/** Child side: serve registry snapshots for the explicitly requested root. */
export async function runSessionListWorker(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const lines = createInterface({ input, terminal: false });
  for await (const line of lines) {
    let request: SessionListRequest | null = null;
    try {
      const parsed = JSON.parse(line) as Partial<SessionListRequest>;
      if (typeof parsed.id === "number" && typeof parsed.root === "string" && parsed.root.length > 0) {
        request = parsed as SessionListRequest;
      }
    } catch {
      // Ignore malformed protocol input and keep serving later requests.
    }
    if (!request) continue;

    const previousRoot = process.env.HIVE_STORE_ROOT;
    let response: SessionListResponse;
    try {
      process.env.HIVE_STORE_ROOT = request.root;
      response = { id: request.id, ok: true, records: await listSessions() };
    } catch (error) {
      response = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (previousRoot === undefined) delete process.env.HIVE_STORE_ROOT;
      else process.env.HIVE_STORE_ROOT = previousRoot;
    }
    output.write(`${JSON.stringify(response)}\n`);
  }
}

export type SessionListChild = {
  stdin: Writable;
  stdout: Readable;
  kill: (signal?: NodeJS.Signals) => void;
  on: (event: "exit" | "error", listener: (...args: unknown[]) => void) => void;
};

export type IsolatedSessionListerOptions = {
  /** Kept below tick.fsMs so the child dies before tick's outer guard fires. */
  timeoutMs?: number;
  spawnChild?: () => SessionListChild;
  root?: () => string;
};

export type IsolatedSessionLister = (() => Promise<SessionRecord[]>) & { close: () => Promise<void> };

function defaultSpawnChild(): SessionListChild {
  const cliPath = process.argv[1];
  if (!cliPath) throw new Error("cannot resolve CLI entrypoint for the session-list child");
  const child: ChildProcess = spawn(process.execPath, [...process.execArgv, cliPath, "daemon", "session-list-worker"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.unref();
  return child as unknown as SessionListChild;
}

export function createIsolatedSessionLister(options: IsolatedSessionListerOptions = {}): IsolatedSessionLister {
  const timeoutMs = options.timeoutMs ?? envMs("HIVE_DAEMON_SESSION_LIST_TIMEOUT_MS", 14_000);
  const spawnChild = options.spawnChild ?? defaultSpawnChild;
  const root = options.root ?? storeRoot;
  let child: SessionListChild | null = null;
  let nextId = 1;
  let buffer = "";
  let scanOffset = 0;
  let decoder = new StringDecoder("utf8");
  const pending = new Map<number, { resolve: (value: SessionListResponse) => void; reject: (error: Error) => void }>();

  const teardown = (reason: string): void => {
    for (const waiter of pending.values()) waiter.reject(new Error(reason));
    pending.clear();
    buffer = "";
    scanOffset = 0;
    decoder = new StringDecoder("utf8");
    child = null;
  };

  const ensureChild = (): SessionListChild => {
    if (child) return child;
    const spawned = spawnChild();
    spawned.on("exit", () => {
      if (child === spawned) teardown("session-list child exited");
    });
    spawned.on("error", (error: unknown) => {
      if (child === spawned) teardown(`session-list child error: ${error instanceof Error ? error.message : String(error)}`);
    });
    spawned.stdin.on("error", () => {
      if (child === spawned) teardown("session-list child stdin error");
    });
    spawned.stdout.on("error", () => {
      if (child === spawned) teardown("session-list child stdout error");
    });
    spawned.stdout.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (;;) {
        const newline = buffer.indexOf("\n", scanOffset);
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        scanOffset = 0;
        let response: SessionListResponse | null = null;
        try {
          response = JSON.parse(line) as SessionListResponse;
        } catch {
          continue;
        }
        if (!response || typeof response.id !== "number") continue;
        const waiter = pending.get(response.id);
        if (!waiter) continue;
        pending.delete(response.id);
        waiter.resolve(response);
      }
      scanOffset = buffer.length;
    });
    child = spawned;
    return spawned;
  };

  const list = async (): Promise<SessionRecord[]> => {
    // Never fall back to an in-process scan: isolation is the safety property,
    // and an unavailable child is an untrusted snapshot, not permission to
    // expose the daemon's own libuv pool to unkillable work.
    const target = ensureChild();
    const id = nextId++;
    const response = await new Promise<SessionListResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        try {
          target.kill("SIGKILL");
        } catch {
          // already gone
        }
        if (child === target) teardown(`session-list request ${id} timed out`);
        reject(new Error(`session-list timed out after ${timeoutMs}ms (child killed)`));
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
        target.stdin.write(`${JSON.stringify({ id, root: root() } satisfies SessionListRequest)}\n`);
      } catch (error) {
        const waiter = pending.get(id);
        pending.delete(id);
        waiter?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (!response.ok) throw new Error(response.error ?? "session-list child failed");
    return response.records ?? [];
  };

  const close = async (): Promise<void> => {
    const current = child;
    if (!current) return;
    teardown("session-list child closed");
    try {
      current.kill("SIGTERM");
    } catch {
      // already gone
    }
  };

  return Object.assign(list, { close });
}
