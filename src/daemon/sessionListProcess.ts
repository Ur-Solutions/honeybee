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
import {
  DEFAULT_ACTIVE_SESSION_RECONCILE_INTERVAL_MS,
  listActiveSessions,
  rebuildActiveSessionIndex,
  type SessionRecord,
} from "../store.js";
import { envMs } from "./timeouts.js";

type SessionListRequest = { id: number; root: string };
type SessionListResponse = { id: number; ok: boolean; records?: SessionRecord[]; error?: string };

export type SessionListWorkerOptions = {
  listActive?: () => Promise<SessionRecord[]>;
};

export type ActiveIndexReconcileTelemetry = {
  root: string;
  ok: boolean;
  durationMs: number;
  active?: number;
  error?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultReconcileTelemetry(event: ActiveIndexReconcileTelemetry): void {
  const detail = event.ok
    ? event.active === undefined ? "active=unknown" : `active=${event.active}`
    : `error=${event.error ?? "unknown"}`;
  process.stderr.write(
    `[hive] active-index reconcile ${event.ok ? "complete" : "failed"} ` +
    `root=${JSON.stringify(event.root)} durationMs=${event.durationMs} ${detail}\n`,
  );
}

/** Grandchild side: one killable canonical walk for the explicitly bound root. */
export async function runActiveIndexReconcileWorker(): Promise<void> {
  await rebuildActiveSessionIndex();
}

/**
 * Start one disposable canonical-reconcile process. It has its own deadline so
 * a historical fs wedge cannot consume or kill the operational snapshot worker.
 */
function reconcileActiveIndexIsolated(root: string, signal?: AbortSignal): Promise<number> {
  const cliPath = process.argv[1];
  if (!cliPath) return Promise.reject(new Error("cannot resolve CLI entrypoint for active-index reconciliation"));
  // Canonical history scans can legitimately exceed the 14s operational
  // snapshot deadline at 10k+ rows. This work is a separate disposable process,
  // so give it a larger bounded budget without delaying daemon observations.
  const timeoutMs = envMs("HIVE_DAEMON_ACTIVE_SESSION_RECONCILE_TIMEOUT_MS", 60_000);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, cliPath, "daemon", "active-index-reconcile-worker"],
      {
        env: { ...process.env, HIVE_STORE_ROOT: root },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const abort = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(new Error("active-index reconcile cancelled (child killed)"));
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(-1);
    };
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(new Error(`active-index reconcile timed out after ${timeoutMs}ms (child killed)`));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(
        `active-index reconcile exited ${code ?? `signal ${signal ?? "unknown"}`}` +
        `${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      ));
    });
  });
}

/** Child side: serve registry snapshots for the explicitly requested root. */
export async function runSessionListWorker(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  options: SessionListWorkerOptions = {},
): Promise<void> {
  const listActive = options.listActive ?? listActiveSessions;
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
      // The daemon needs only records that can still change or require
      // recovery. Historical rows stay in file-per-record storage and are read
      // explicitly by CLI/history consumers; never serialize them through IPC.
      response = { id: request.id, ok: true, records: await listActive() };
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
  /** Parent-owned pacing survives disposable snapshot-worker replacement. */
  canonicalReconcileIntervalMs?: number;
  now?: () => number;
  reconcileActiveIndex?: (root: string, signal?: AbortSignal) => Promise<number>;
  onReconcileTelemetry?: (event: ActiveIndexReconcileTelemetry) => void;
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
  const canonicalReconcileIntervalMs = options.canonicalReconcileIntervalMs ?? envMs(
    "HIVE_DAEMON_ACTIVE_SESSION_RECONCILE_INTERVAL_MS",
    DEFAULT_ACTIVE_SESSION_RECONCILE_INTERVAL_MS,
  );
  const now = options.now ?? Date.now;
  const reconcileActiveIndex = options.reconcileActiveIndex ?? reconcileActiveIndexIsolated;
  const onReconcileTelemetry = options.onReconcileTelemetry ?? defaultReconcileTelemetry;
  const reportReconcile = (event: ActiveIndexReconcileTelemetry): void => {
    try {
      onReconcileTelemetry(event);
    } catch {
      // Observability is never authoritative for index reconciliation.
    }
  };
  const reconciles = new Map<string, {
    lastAttemptAt: number;
    inFlight?: Promise<void>;
    abort?: AbortController;
  }>();
  let child: SessionListChild | null = null;
  let nextId = 1;
  let buffer = "";
  let scanOffset = 0;
  let decoder = new StringDecoder("utf8");
  const pending = new Map<number, { resolve: (value: SessionListResponse) => void; reject: (error: Error) => void }>();

  const kickCanonicalReconcile = (targetRoot: string): void => {
    const nowMs = now();
    const state = reconciles.get(targetRoot);
    if (state?.inFlight) return;
    if (
      state &&
      nowMs >= state.lastAttemptAt &&
      nowMs - state.lastAttemptAt < canonicalReconcileIntervalMs
    ) return;

    const next = state ?? { lastAttemptAt: nowMs };
    next.lastAttemptAt = nowMs;
    const startedAt = nowMs;
    const abort = new AbortController();
    const inFlight = Promise.resolve()
      .then(() => reconcileActiveIndex(targetRoot, abort.signal))
      .then((active) => {
        reportReconcile({
          root: targetRoot,
          ok: true,
          durationMs: Math.max(0, now() - startedAt),
          ...(active >= 0 ? { active } : {}),
        });
      })
      .catch((error: unknown) => {
        reportReconcile({
          root: targetRoot,
          ok: false,
          durationMs: Math.max(0, now() - startedAt),
          error: errorMessage(error),
        });
      })
      .finally(() => {
        const current = reconciles.get(targetRoot);
        if (current?.inFlight === inFlight) {
          delete current.inFlight;
          delete current.abort;
        }
      });
    next.inFlight = inFlight;
    next.abort = abort;
    reconciles.set(targetRoot, next);
  };

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
    const targetRoot = root();
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
        target.stdin.write(`${JSON.stringify({ id, root: targetRoot } satisfies SessionListRequest)}\n`);
      } catch (error) {
        const waiter = pending.get(id);
        pending.delete(id);
        waiter?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (!response.ok) throw new Error(response.error ?? "session-list child failed");
    // The daemon-owned controller retains cadence and single-flight state even
    // if the disposable hot-snapshot worker is killed and recreated. Start the
    // independent canonical pass only after a trusted response has arrived.
    kickCanonicalReconcile(targetRoot);
    return response.records ?? [];
  };

  const close = async (): Promise<void> => {
    for (const state of reconciles.values()) state.abort?.abort();
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
