// executeFlow — foreground flow runtime.
//
// Owns:
//   - run-dir + meta.json + result.json lifecycle
//   - BeeHandle tracking via HiveFacade
//   - SIGINT handling (foreground only): aborts run + writes cancelled result
//   - Cleanup policy: flow.cleanup=kill-on-end calls facade.killAll() at end
//
// Background runs are NOT handled here — patch 12 will ship spawnDetachedRun
// that re-execs this process under __flow-exec.

import { appendFile, mkdir } from "node:fs/promises";
import { appendLedger } from "../store.js";
import { DETACHED_RUN_ENV } from "./background.js";
import { HiveFacade } from "./hive_facade.js";
import type { Flow, FlowContext } from "./index.js";
import {
  createRunDir,
  generateRunId,
  type FlowRunMeta,
  type FlowRunResult,
  readMeta,
  runLogPath,
  writeMeta,
  writeResult,
} from "./runs.js";

export type ExecuteFlowOptions = {
  /** Caller-supplied arg values (after defaults are applied). */
  args?: Record<string, unknown>;
  /** Override runId; default = generateRunId(). */
  runId?: string;
  /**
   * Install a SIGINT handler that cancels the run and writes result.json.
   * Default: true. Set to false for tests that drive the abort manually.
   */
  installSignalHandlers?: boolean;
  /** Mark this run as backgrounded (meta.background=true). */
  background?: boolean;
};

export type ExecuteFlowResult = {
  runId: string;
  status: FlowRunResult["status"];
  value?: unknown;
  error?: FlowRunResult["error"];
  meta: FlowRunMeta;
  result: FlowRunResult;
};

/**
 * Run a Flow in the current process (foreground). Streams log lines into
 * the run's log.txt, persists meta.json (status transitions), and writes
 * a final result.json. Cleans up spawned bees if flow.cleanup==='kill-on-end'.
 *
 * Throws if the flow's run() throws AFTER persisting cancelled/failed status
 * to result.json — callers can decide whether to rethrow. SIGINT triggers
 * the abort controller, which compiled JSON flows honor at step boundaries.
 */
export async function executeFlow(flow: Flow, options: ExecuteFlowOptions = {}): Promise<ExecuteFlowResult> {
  const runId = options.runId ?? generateRunId();
  const args = applyDefaults(flow, options.args ?? {});
  const cleanup = flow.cleanup ?? "keep";
  const startedAt = new Date().toISOString();

  await createRunDir(flow.name, runId);
  await touchLog(flow.name, runId);

  // When this runtime is invoked by the background fork (`__flow-exec`), the
  // parent has already pre-written meta.json with `pgid` so cancelRun can
  // signal the process group even before the child reaches this line. Read
  // the existing meta (if any) so we preserve fields the parent owns —
  // currently `pgid` and `background`. The parent's pid/pgid patch races this
  // startup write, so a detached child (DETACHED_RUN_ENV set by
  // spawnDetachedRun) also derives the pgid itself: detached:true makes the
  // child the leader of its own process group, hence pgid === process.pid.
  const detached = process.env[DETACHED_RUN_ENV] === "1";
  const existing = await readMeta(flow.name, runId);
  const initialMeta: FlowRunMeta = {
    runId,
    flowName: flow.name,
    args,
    status: "running",
    startedAt,
    pid: process.pid,
    cleanup,
    background: options.background === true || existing?.background === true || detached,
    ...(existing?.pgid !== undefined ? { pgid: existing.pgid } : detached ? { pgid: process.pid } : {}),
  };
  await writeMeta(flow.name, runId, initialMeta);
  await appendLedger({ type: "flow.run.start", flowName: flow.name, runId, pid: process.pid, cleanup });

  const controller = new AbortController();
  const facade = new HiveFacade({
    flowName: flow.name,
    runId,
    cleanup,
    signal: controller.signal,
  });

  let cancelled = false;
  const installSignals = options.installSignalHandlers !== false;
  const sigintHandler = () => {
    if (cancelled) return;
    cancelled = true;
    controller.abort();
  };
  if (installSignals) {
    process.on("SIGINT", sigintHandler);
    process.on("SIGTERM", sigintHandler);
  }

  const ctx: FlowContext = {
    runId,
    flowName: flow.name,
    args,
    bindings: {},
    signal: controller.signal,
    hive: facade,
  };

  let status: FlowRunResult["status"] = "ok";
  let value: unknown = undefined;
  let error: FlowRunResult["error"] | undefined;

  try {
    value = await flow.run(ctx);
    if (cancelled || controller.signal.aborted) {
      status = "cancelled";
      error = { message: `Flow ${flow.name} cancelled (SIGINT)`, cancelled: true };
    }
  } catch (caught) {
    if (cancelled || controller.signal.aborted) {
      status = "cancelled";
      error = {
        message: caught instanceof Error ? caught.message : String(caught),
        cancelled: true,
        ...(caught instanceof Error && caught.stack ? { stack: caught.stack } : {}),
      };
    } else {
      status = "failed";
      error = {
        message: caught instanceof Error ? caught.message : String(caught),
        ...(caught instanceof Error && caught.stack ? { stack: caught.stack } : {}),
      };
    }
  } finally {
    if (installSignals) {
      process.off("SIGINT", sigintHandler);
      process.off("SIGTERM", sigintHandler);
    }
  }

  // Cleanup policy. We always attempt killAll on cleanup=kill-on-end,
  // including cancelled/failed runs — that's the whole point of the opt-in.
  if (cleanup === "kill-on-end") {
    try {
      const outcome = await facade.killAll();
      await appendLedger({
        type: "flow.cleanup",
        flowName: flow.name,
        runId,
        killed: outcome.killed,
        failed: outcome.failed.map((f) => f.name),
      });
    } catch (cleanupError) {
      const msg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      await appendFile(runLogPath(flow.name, runId), `[cleanup-error] ${msg}\n`, { mode: 0o600 }).catch(() => undefined);
    }
  }

  const endedAt = new Date().toISOString();
  const result: FlowRunResult = {
    runId,
    flowName: flow.name,
    status,
    startedAt,
    endedAt,
    ...(value !== undefined ? { value } : {}),
    ...(error ? { error } : {}),
  };
  const finalMeta: FlowRunMeta = {
    ...initialMeta,
    status,
    endedAt,
  };
  try {
    // writeResult is defensive against unserializable values, but any residual
    // failure must not strand meta.json on "running" — the terminal status is
    // persisted regardless.
    await writeResult(flow.name, runId, result);
  } finally {
    await writeMeta(flow.name, runId, finalMeta);
  }

  await appendLedger({
    type: "flow.run.end",
    flowName: flow.name,
    runId,
    status,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
  });

  return { runId, status, value, error, meta: finalMeta, result };
}

function applyDefaults(flow: Flow, supplied: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...supplied };
  for (const arg of flow.args ?? []) {
    if (!(arg.name in out) && arg.default !== undefined) out[arg.name] = arg.default;
  }
  return out;
}

async function touchLog(flowName: string, runId: string): Promise<void> {
  const path = runLogPath(flowName, runId);
  await mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
  await appendFile(path, "", { mode: 0o600 }).catch(() => undefined);
}
