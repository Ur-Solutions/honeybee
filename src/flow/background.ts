// Background flow runs — detached fork + cancel-by-pgid.
//
// Design (locked in PHASE2_PLAN.md §"Locked decisions" #3):
//   - Background flow runs are INDEPENDENT process trees. The daemon does not
//     manage them; `hive flow runs` is the inventory.
//   - `hive flow run <name> --background` re-execs the CLI entry under the
//     hidden `__flow-exec <runId>` command, with detached:true so the child
//     forms its own session/process group. The parent prints the runId and
//     exits 0 immediately; child.unref() ensures the parent event loop does
//     not block on the child.
//   - `hive flow cancel <runId>` reads meta.pgid and signals -pgid with
//     SIGTERM, then (after graceMs) SIGKILL. The whole process tree dies.
//   - Windows is not supported — `process.spawn(detached:true)` does not
//     create a POSIX process group, so `process.kill(-pgid, ...)` is a no-op.
//     The --background flag prints a clear error on win32.
//
// File layout:
//   ~/.hive/flows/<name>/runs/<runId>/meta.json   — written by spawnDetached
//                                                   BEFORE the child starts
//                                                   so pgid is durable.
//   ~/.hive/flows/<name>/runs/<runId>/log.txt     — child stdout+stderr
//   ~/.hive/flows/<name>/runs/<runId>/result.json — written by the child
//                                                   when executeFlow returns.

import { spawn } from "node:child_process";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { appendLedger } from "../store.js";
import type { Flow } from "./index.js";
import {
  generateRunId,
  readMeta,
  runLogPath,
  type FlowRunMeta,
  writeMeta,
} from "./runs.js";

/** Resolved CLI entry path (matches the daemon installer's logic). */
async function resolveEntry(): Promise<string> {
  const raw = process.argv[1];
  if (!raw) throw new Error("flow background: could not resolve CLI entry path (process.argv[1] is empty)");
  const { realpath } = await import("node:fs/promises");
  try {
    return await realpath(raw);
  } catch {
    return raw;
  }
}

export type SpawnDetachedOptions = {
  /** Override the runId (default = generateRunId()). */
  runId?: string;
  /** Override the CLI entry path (default = realpath(process.argv[1])). */
  entryOverride?: string;
  /** Override node binary (default = process.execPath). Used by tests. */
  execPath?: string;
  /**
   * Extra argv prepended to the entry (e.g. `["--import","tsx"]` for tsx dev).
   * Defaults to the parent's own process.execArgv (minus test-runner/watch
   * flags) so loader flags propagate automatically — without this, the dev
   * entry (`tsx src/cli.ts`) would fork detached children as plain
   * `node src/cli.ts ...`, which die instantly on the .ts entry.
   */
  execArgv?: string[];
  /** Extra env vars forwarded to the child. */
  env?: Record<string, string | undefined>;
};

/**
 * Env var set on detached children. The child IS the leader of its own process
 * group (detached:true ⇒ setsid), so executeFlow can persist pgid=process.pid
 * itself instead of relying on the parent's post-spawn meta patch winning the
 * race against the child's startup meta write.
 */
export const DETACHED_RUN_ENV = "HIVE_FLOW_DETACHED";

/** process.execArgv minus flags that would change the child's execution mode. */
function inheritableExecArgv(): string[] {
  return process.execArgv.filter(
    (arg) => arg !== "--test" && !arg.startsWith("--test=") && arg !== "--watch" && !arg.startsWith("--watch="),
  );
}

export type SpawnDetachedResult = {
  runId: string;
  pid: number;
  pgid: number;
};

/**
 * Spawn a detached child to run `flow` under the hidden `__flow-exec` command.
 * Returns the child's pid/pgid AFTER the meta.json is durable. The parent can
 * print the runId and exit immediately.
 *
 * On Windows, throws — detached process-groups are POSIX-only.
 */
export async function spawnDetachedRun(
  flow: Flow,
  args: Record<string, unknown>,
  options: SpawnDetachedOptions = {},
): Promise<SpawnDetachedResult> {
  if (process.platform === "win32") {
    throw new Error(
      "hive flow run --background is not supported on Windows (POSIX process groups are required to cancel).",
    );
  }
  const runId = options.runId ?? generateRunId();
  const entry = options.entryOverride ?? (await resolveEntry());
  const execPath = options.execPath ?? process.execPath;
  const startedAt = new Date().toISOString();
  const logPath = runLogPath(flow.name, runId);

  // Persist meta.json BEFORE forking so cancelRun can find the run by id
  // (pgid is filled in after spawn — but we write a placeholder file so
  // the run dir exists for the child's stdio fds).
  await mkdir(dirname(logPath), { recursive: true });
  const preMeta: FlowRunMeta = {
    runId,
    flowName: flow.name,
    args,
    status: "running",
    startedAt,
    cleanup: flow.cleanup ?? "keep",
    background: true,
  };
  await writeMeta(flow.name, runId, preMeta);

  // Open log file once; child gets it as stdout AND stderr (fd duplicated).
  const logHandle = await open(logPath, "a", 0o600);
  const logFd = logHandle.fd;

  try {
    const childArgv = [
      ...(options.execArgv ?? inheritableExecArgv()),
      entry,
      "__flow-exec",
      runId,
      "--flow",
      flow.name,
    ];
    const child = spawn(execPath, childArgv, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        [DETACHED_RUN_ENV]: "1",
        ...(options.env ?? {}),
      },
    });
    // Async spawn failures (e.g. ENOENT exec path) surface via the 'error'
    // event AFTER spawn() returns; without a listener they would crash the
    // parent. The missing-pid check below already converts them into a thrown
    // error + failed meta.
    child.once("error", () => undefined);
    if (!child.pid) {
      throw new Error(`hive flow run --background: spawn failed (no pid for ${flow.name})`);
    }
    // detached:true on POSIX makes child its own process group with pgid == child.pid.
    const pid = child.pid;
    const pgid = child.pid;
    child.unref();

    // Now patch meta.json with pid + pgid. The child's executeFlow will read
    // this file at startup and preserve pgid in its own writes (see flow/run.ts).
    const updated: FlowRunMeta = { ...preMeta, pid, pgid };
    await writeMeta(flow.name, runId, updated);

    await appendLedger({
      type: "flow.run.background.spawn",
      flowName: flow.name,
      runId,
      pid,
      pgid,
    });

    return { runId, pid, pgid };
  } catch (error) {
    // The pre-written meta says "running" with no pid — nothing could ever
    // downgrade or cancel it. Persist a terminal status before rethrowing.
    const failed: FlowRunMeta = { ...preMeta, status: "failed", endedAt: new Date().toISOString() };
    await writeMeta(flow.name, runId, failed).catch(() => undefined);
    throw error;
  } finally {
    // The child inherited the fd; the parent no longer needs it.
    await logHandle.close().catch(() => undefined);
  }
}

export type CancelRunOptions = {
  /** Milliseconds between SIGTERM and SIGKILL. Default 5000. */
  graceMs?: number;
  /** Polling interval while waiting for SIGTERM. Default 100ms. */
  pollMs?: number;
  /** Override process.kill (testing). Throws semantics must match. */
  killImpl?: (pid: number, signal: NodeJS.Signals | number) => void;
  /**
   * Override the "is the process group still alive?" check (testing).
   * Receives the POSITIVE pgid. Default: process.kill(pgid, 0).
   */
  isAlive?: (pgid: number) => boolean;
};

export type CancelRunResult = {
  runId: string;
  flowName: string;
  signalled: "SIGTERM" | "SIGKILL" | "already-dead";
  pgid?: number;
};

/**
 * Cancel a background run by sending SIGTERM to its process group, then
 * SIGKILL after `graceMs` if still alive. Updates meta.json to status='cancelled'.
 *
 * If the run is already not running (status != 'running' or pgid missing/dead),
 * returns signalled='already-dead' and leaves on-disk meta as-is.
 */
export async function cancelRun(
  flowName: string,
  runId: string,
  options: CancelRunOptions = {},
): Promise<CancelRunResult> {
  const meta = await readMeta(flowName, runId);
  if (!meta) throw new Error(`Unknown run: ${runId} (flow: ${flowName})`);

  if (meta.status !== "running") {
    return { runId, flowName, signalled: "already-dead", pgid: meta.pgid };
  }
  const pgid = meta.pgid;
  if (typeof pgid !== "number" || pgid <= 0) {
    // Foreground run with only a pid — fall back to SIGTERM on the pid.
    if (typeof meta.pid === "number" && meta.pid > 0) {
      try {
        (options.killImpl ?? process.kill)(meta.pid, "SIGTERM");
      } catch {
        // ignore
      }
      return { runId, flowName, signalled: "SIGTERM" };
    }
    // No pid AND no pgid: there is no process that could ever flip this record
    // to a terminal status (the spawn died before the pid patch). Persist
    // cancelled so the run does not read as "running" forever.
    const cancelledNoPid: FlowRunMeta = { ...meta, status: "cancelled", endedAt: new Date().toISOString() };
    await writeMeta(flowName, runId, cancelledNoPid);
    await appendLedger({ type: "flow.run.cancel", flowName, runId, signalled: "already-dead" });
    return { runId, flowName, signalled: "already-dead" };
  }

  const killImpl = options.killImpl ?? ((pid: number, sig: NodeJS.Signals | number) => process.kill(pid, sig));
  const isAlive = options.isAlive ?? ((pg: number) => {
    try {
      // Signal 0 to a negative pgid checks whether the group has any members.
      process.kill(-pg, 0);
      return true;
    } catch {
      return false;
    }
  });
  const graceMs = options.graceMs ?? 5000;
  const pollMs = options.pollMs ?? 100;

  // SIGTERM the whole process group.
  let signalled: CancelRunResult["signalled"] = "SIGTERM";
  try {
    killImpl(-pgid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      signalled = "already-dead";
    } else if (code === "EPERM") {
      // We don't own it — treat as a hard failure.
      throw error;
    } else {
      throw error;
    }
  }

  // Wait up to graceMs for the group to exit; if still alive, SIGKILL.
  if (signalled === "SIGTERM") {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!isAlive(pgid)) break;
      await sleep(pollMs);
    }
    if (isAlive(pgid)) {
      try {
        killImpl(-pgid, "SIGKILL");
        signalled = "SIGKILL";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }

  // Persist cancelled status. Re-read meta first: a concurrently-finishing
  // child may have written a terminal status (e.g. "ok") between our initial
  // read and the signal — spreading the stale pre-signal snapshot would
  // clobber it. Only a still-"running" record is flipped to cancelled.
  const endedAt = new Date().toISOString();
  const fresh = await readMeta(flowName, runId).catch(() => null);
  if (!fresh || fresh.status === "running") {
    const cancelled: FlowRunMeta = { ...(fresh ?? meta), status: "cancelled", endedAt };
    await writeMeta(flowName, runId, cancelled);
  }

  await appendLedger({
    type: "flow.run.cancel",
    flowName,
    runId,
    pgid,
    signalled,
  });

  return { runId, flowName, signalled, pgid };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ensure the run dir + meta.json exist. Helper for callers that need to
 * verify a run is present before signalling — currently only used by tests.
 */
export async function runDirExists(flowName: string, runId: string): Promise<boolean> {
  try {
    const path = runLogPath(flowName, runId);
    await stat(dirname(path));
    return true;
  } catch {
    return false;
  }
}
