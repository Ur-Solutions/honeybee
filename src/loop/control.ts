// Loop control surface — start / status / stop for a detached loop run. This is
// the substrate-neutral orchestration that used to live on HiveFacade; it does
// not belong there (HiveFacade is the flow-verb surface). Callers — the CLI, a
// flow, or a test — invoke these functions directly.
//
// A loop is the built-in `loop` flow run DETACHED (runId === loopId). start
// pre-allocates the loopId, writes the initial loop.json, then spawns the flow
// as a background run; the while-loop driver (loop/flow.ts runLoop) runs in the
// child, not inline.

import { cancelRun, spawnDetachedRun } from "../flow/background.js";
import { appendLedger } from "../store.js";
import { buildLoopConfig } from "./context.js";
import { loopFlow } from "./flow.js";
import { appendDefinedLoopStopArgs, type LoopStopInput } from "./stopConditions.js";
import {
  generateLoopId,
  type LoopConfig,
  readLoopConfig,
  requestStop,
  updateLoopConfig,
  writeLoopConfig,
} from "./state.js";

/** Input to startLoop() — the programmatic surface for starting a loop. */
export type LoopSpawnInput = LoopStopInput & {
  bee: string;
  cwd: string;
  context: "persistent" | "ralph" | "rolling";
  prompt: string;
  summarizer?: "self" | "bee";
  yolo?: boolean;
};

/**
 * Start a detached loop — the in-flow / in-agent surface mirroring
 * `hive loop start`. Pre-allocates a loopId (== runId), writes the initial
 * loop.json, then spawns the built-in `loop` flow as a detached background
 * run. Returns the loopId immediately; the while-loop driver runs in the
 * child, not inline. Validates the spec eagerly so callers surface bad input
 * before a process is forked.
 */
export async function startLoop(spec: LoopSpawnInput): Promise<string> {
  // The bee token (codex-auto / claude-thto / account-id) is kept verbatim and
  // resolved at each iteration's spawn (spawnLoopBee / facade.spawn) so a
  // fresh-carrier loop re-picks the least-loaded `auto` account per iteration.
  // Build/validate the config eagerly; buildLoopConfig throws on bad input.
  const cfg = buildLoopConfig(spec as Record<string, unknown>);
  const loopId = await generateLoopId();
  cfg.loopId = loopId;
  await writeLoopConfig(cfg);
  const args = loopArgsFromSpec(spec, loopId);
  try {
    await spawnDetachedRun(loopFlow, args, { runId: loopId });
  } catch (error) {
    // The pre-written loop.json says "running" with no pid — nothing could
    // ever reconcile it. Persist a terminal status before rethrowing.
    const message = error instanceof Error ? error.message : String(error);
    await updateLoopConfig(loopId, {
      status: "errored",
      stopReason: `spawn:${message}`,
      endedAt: new Date().toISOString(),
    }).catch(() => undefined);
    throw error;
  }
  await appendLedger({ type: "loop.start", loopId, bee: cfg.bee, context: cfg.context });
  return loopId;
}

/** Read a loop's current config + live state, or null if unknown. */
export async function loopStatus(loopId: string): Promise<LoopConfig | null> {
  return readLoopConfig(loopId);
}

/**
 * Stop a loop. Default is graceful (write the stop-request sentinel; the
 * driver halts after the current iteration). `now:true` cancels the detached
 * run immediately (SIGTERM→SIGKILL on the process group), killing the
 * in-flight bee.
 */
export async function loopStop(loopId: string, opts: { now?: boolean } = {}): Promise<void> {
  if (opts.now) {
    await cancelRun("loop", loopId);
    return;
  }
  await requestStop(loopId);
}

/**
 * Translate a LoopSpawnInput into the flow arg record consumed by loopFlow.
 * Only defined fields are forwarded so loopFlow's arg defaults still apply.
 */
export function loopArgsFromSpec(spec: LoopSpawnInput, loopId: string): Record<string, unknown> {
  const args: Record<string, unknown> = {
    bee: spec.bee,
    cwd: spec.cwd,
    context: spec.context,
    prompt: spec.prompt,
    loopId,
  };
  appendDefinedLoopStopArgs(spec, args);
  if (spec.summarizer !== undefined) args.summarizer = spec.summarizer;
  if (spec.yolo !== undefined) args.yolo = spec.yolo;
  return args;
}
