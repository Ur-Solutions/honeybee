// The `loop` flow — a built-in TS flow run DETACHED via the existing flow
// background machinery (runId === loopId). Its run() function is the iteration
// driver: ensure a ready bee, inject the prompt, wait for the seal boundary,
// fold rolling memory, then evaluate the stop menu. Repeat until a condition
// fires, a graceful stop is requested, or the run is cancelled.
//
// runLoop stays thin: each phase is a named helper — ensureReadyBee (spawn +
// readiness), resolveBoundarySeal (boundary race → seal), decideStop (the stop
// menu). Bee spawning lives in loop/spawn.ts, boundary detection in
// loop/boundary.ts, and the start/status/stop surface in loop/control.ts.
//
// No console.* here — the CLI layer owns stdout/stderr. Per-iteration state is
// logged via ctx.hive.log() and the loop's iter-NNN.log files.

import { defineFlow, type BeeHandle, type FlowContext } from "../flow/index.js";
import type { HiveFacade } from "../flow/hive_facade.js";
import { AgentReadinessError, waitForAgentReady } from "../readiness.js";
import { scanLatestSeal, type SealRecord, type SealStatus } from "../seal.js";
import { appendLedger, type SessionRecord } from "../store.js";
import { substrateFor } from "../substrates/index.js";
import {
  BOUNDARY_GRACE_MS,
  BOUNDARY_POLL_MS,
  IDLE_FALLBACK_MS,
  waitForIterationBoundary,
} from "./boundary.js";
import { buildLoopConfig } from "./context.js";
import { bootMs, handleOf, readFileSafe } from "./internal.js";
import { judgeSaysStop, runSummarizerBee, spawnIterationBee } from "./spawn.js";
import { evaluateLoopStopConditions, loopStopFlowArgs, type LoopStopDecision } from "./stopConditions.js";
import {
  appendIterLog,
  ensureLoopDir,
  isStopRequested,
  type LoopConfig,
  type LoopStatus,
  loopHistoryMdPath,
  loopProgressPath,
  readLoopConfig,
  updateLoopConfig,
  writeIterSeal,
  writeLoopConfig,
} from "./state.js";
import { buildIterationPrompt, foldForward } from "./summarizer.js";
import { runStopPredicate } from "./until.js";

const SEAL_TIMEOUT_MS = 30 * 60_000; // overall per-iteration boundary cap

/**
 * Test seam. When set, the driver uses this to obtain (and ready) the iteration
 * bee instead of spawning a real tmux session. Production code never sets it —
 * it exists so tests can drive the iteration loop deterministically without
 * tmux/readiness. The function returns the SessionRecord to use for the
 * iteration (already saved + tracked by the caller's facade).
 */
export type LoopTestHooks = {
  ensureBee: (args: { facade: HiveFacade; cfg: LoopConfig; loopId: string; iter: number }) => Promise<SessionRecord>;
  /** Optional override for prompt injection (avoids real tmux in tests). */
  send?: (args: { handle: BeeHandle; prompt: string; iter: number }) => Promise<void>;
  /**
   * Optional override for the sentinel pane scan (avoids real tmux in tests).
   * Receives the live handle — undefined here would mean the driver scanned
   * after killing the bee, which is the bug this seam guards against.
   */
  scanSentinel?: (args: { handle: BeeHandle | undefined; pattern: string; iter: number }) => Promise<boolean>;
  /** Optional override for the per-iteration boundary cap (keeps no-seal tests fast). */
  sealTimeoutMs?: number;
  /** Optional override for the boundary idle window (default IDLE_FALLBACK_MS). */
  boundaryIdleMs?: number;
  /** Optional override for the post-idle grace period (default BOUNDARY_GRACE_MS). */
  boundaryGraceMs?: number;
  /** Optional override for the boundary poll interval (default BOUNDARY_POLL_MS). */
  boundaryPollMs?: number;
  /** Optional override for the boundary's pane capture (avoids real tmux in tests). */
  capturePane?: (args: { handle: BeeHandle; iter: number }) => Promise<string>;
  /** Optional clock override for limit tests. */
  now?: () => number;
};
let testHooks: LoopTestHooks | undefined;
export function __setLoopTestHooks(hooks: LoopTestHooks | undefined): void {
  testHooks = hooks;
}

export const loopFlow = defineFlow({
  name: "loop",
  description: "Run a bee repeatedly until a stop condition fires.",
  cleanup: "kill-on-end",
  args: [
    { name: "bee", description: "agent to run each iteration (e.g. claude, codex-auto, claude-<account>)" },
    { name: "cwd", description: "working directory the bee runs in" },
    { name: "context", description: "how each iteration sees the last: persistent (same session), ralph (fresh each time), rolling (fresh + a rolling summary)" },
    { name: "prompt", description: "the instruction sent every iteration" },
    ...loopStopFlowArgs(),
    { name: "summarizer", default: "self", description: "who summarizes between iterations: self (the bee) or bee (a dedicated summarizer)" },
    { name: "loopId", default: "", description: "internal run id — leave blank to auto-generate" },
    { name: "yolo", default: false, description: "run the bee in dangerous/bypass-permissions mode" },
  ],
  run: async (ctx) => runLoop(ctx),
});

async function runLoop(ctx: FlowContext): Promise<Record<string, unknown>> {
  const facade = ctx.hive as HiveFacade;
  const loopId = (typeof ctx.args.loopId === "string" && ctx.args.loopId.length > 0 ? ctx.args.loopId : "") || ctx.runId;

  // Build/validate config. Reuse any loop.json the CLI/facade pre-wrote so we
  // keep the user-facing loopId, but re-derive the typed config from args.
  const cfg = buildLoopConfig({ ...ctx.args, loopId });
  cfg.loopId = loopId;
  cfg.status = "running";
  cfg.iteration = 0;
  cfg.pid = process.pid;
  cfg.pgid = process.pid;
  const existing = await readLoopConfig(loopId);
  if (existing) {
    cfg.startedAt = existing.startedAt;
  }
  await ensureLoopDir(loopId);
  await writeLoopConfig(cfg);
  await ctx.hive.log(`loop ${loopId} started: context=${cfg.context} bee=${cfg.bee} max=${cfg.stop.max ?? "∞"}`);

  let handle: BeeHandle | undefined;
  const now = (): number => testHooks?.now?.() ?? Date.now();
  const started = now();
  let finalStatus: LoopStatus = "running";
  let stopReason = "";

  // `keepBee` is set when pausing: loop.json keeps pointing at the bee the
  // operator must attend (`hive attach <bee>`); everywhere else currentBee is
  // cleared because the loop's bees are dead or about to be killed.
  const finalize = async (status: LoopStatus, reason: string, opts: { keepBee?: string } = {}): Promise<void> => {
    finalStatus = status;
    stopReason = reason;
    await updateLoopConfig(loopId, {
      status,
      stopReason: reason,
      endedAt: new Date().toISOString(),
      currentBee: opts.keepBee,
    });
  };

  // Pausing means "a human must intervene on this bee" — exempt it from the
  // flow's kill-on-end cleanup and keep it referenced in loop.json.
  const pause = async (reason: string): Promise<void> => {
    if (handle) facade.untrack(handle.name);
    await finalize("paused", reason, handle ? { keepBee: handle.name } : {});
  };

  try {
    while (true) {
      if (ctx.signal?.aborted) {
        await finalize("stopped", "aborted");
        break;
      }
      if (await isStopRequested(loopId)) {
        await finalize("stopped", "stop-requested");
        break;
      }
      const topStopDecision = await evaluateLoopStopConditions({
        phase: "pre",
        cfg,
        completedIterations: cfg.iteration,
        started,
        now,
        signal: ctx.signal,
        recordStopCheck: (condition, result) => recordStopCheck(loopId, condition, result),
        runStopPredicate,
        scanSentinel: async () => false,
        judgeSaysStop: async () => false,
      });
      if (topStopDecision) {
        await finalize(topStopDecision.status, topStopDecision.reason);
        break;
      }

      // ── Ensure a ready bee. ──
      const ready = await ensureReadyBee({ facade, cfg, loopId, iter: cfg.iteration + 1, existing: handle });
      if (ready.kind !== "ready") {
        if (ready.handle) handle = ready.handle; // adopt the spawned bee so pause/cleanup can find it
        if (ready.kind === "pause") {
          await pause(ready.reason);
          break;
        }
        await finalize("errored", ready.reason);
        break;
      }
      handle = ready.handle;

      const iter = cfg.iteration + 1;
      const progress = await readFileSafe(loopProgressPath(loopId));
      const history = await readFileSafe(loopHistoryMdPath(loopId));
      const prompt = buildIterationPrompt({
        task: cfg.prompt,
        mode: cfg.memory,
        progress,
        history,
        loopId,
        iteration: iter,
      });

      // Baseline the newest seal BEFORE sending so the idle fallback can reject
      // a stale seal from a prior iteration (matters for carrier=same, whose bee
      // name — and therefore seal stream — is fixed across iterations).
      const sealBaselineScan = await scanLatestSeal(handle.name).catch(() => null);
      const sealCursor = sealBaselineScan?.filename ?? null;

      if (testHooks?.send) await testHooks.send({ handle, prompt, iter });
      else await facade.send(handle, prompt); // injects AND submits (Enter included)
      await appendIterLog(loopId, iter, `sent prompt (${prompt.length} chars)`);

      // ── Boundary: RACE seal detection against idle detection (PRD §14). ──
      // A harness that never seals must conclude the boundary via ~3s idle
      // detection, not after the 30-minute seal cap.
      const boundary = await resolveBoundarySeal({
        handle,
        iter,
        baselineFilename: sealCursor,
        cfg,
        started,
        now,
        signal: ctx.signal,
      });
      if (boundary.aborted) {
        // An aborted signal surfaces as a boundary throw. End cleanly.
        await finalize("stopped", "aborted");
        break;
      }
      const { seal, boundaryBlocked, statusLabel } = boundary;

      // ── Fold rolling memory forward. ──
      if (cfg.memory === "rolling" && seal) {
        const summarizerSeal =
          cfg.summarizer === "bee"
            ? await runSummarizerBee(facade, cfg, loopId, iter, seal, { sealTimeoutMs: testHooks?.sealTimeoutMs })
            : seal;
        await foldForward(loopId, iter, summarizerSeal);
      }

      if (seal) await writeIterSeal(loopId, iter, seal);
      await appendIterLog(loopId, iter, `status=${statusLabel}`);

      cfg.iteration = iter;
      await updateLoopConfig(loopId, { iteration: iter, lastSealStatus: statusLabel, currentBee: handle?.name });
      await appendLedger({ type: "loop.iteration", loopId, iteration: iter, status: statusLabel });
      await ctx.hive.log(`iteration ${iter} status=${statusLabel}`);

      // ── Stop menu (first hit wins). pause is distinct from stop. ──
      // Evaluated BEFORE the fresh-carrier kill so a pause decision can leave
      // the bee alive for the operator. Seal-derived stops only apply when the
      // bee actually sealed; a no-seal turn is not a real `done` and must not
      // stop the loop on its own. An explicit --stop-on-seal membership wins
      // over the implicit blocked/needs_input pause: an operator who opted
      // into stopping on those statuses gets a stop, not a pause.
      const decision = await decideStop({
        facade,
        cfg,
        loopId,
        iter,
        started,
        now,
        signal: ctx.signal,
        seal,
        boundaryBlocked,
        handle,
      });

      if (decision?.status === "paused") {
        // PRD: pause-and-notify — the human must be able to attend THIS bee,
        // so it is neither killed here nor by the flow's kill-on-end cleanup.
        await pause(decision.reason);
        break;
      }

      // Fresh carrier: kill this iteration's bee before respawning a new one.
      if (cfg.carrier === "fresh" && handle) {
        try {
          await ctx.hive.kill(handle);
        } catch {
          // already gone — fine.
        }
        handle = undefined;
      }

      if (decision) {
        await finalize(decision.status, decision.reason);
        break;
      }
      // else loop again
    }
  } catch (error) {
    if (ctx.signal?.aborted) {
      await finalize("stopped", "aborted");
      return { loopId, iterations: cfg.iteration, status: finalStatus, stopReason };
    }
    await finalize("errored", error instanceof Error ? error.message : String(error));
    throw error;
  }

  return { loopId, iterations: cfg.iteration, status: finalStatus, stopReason };
}

// ──────────────────────────────────────────────────────────────────────────
// Iteration phases (each a slice of the driver loop above).
// ──────────────────────────────────────────────────────────────────────────

/**
 * Outcome of ensureReadyBee: a ready bee, or a terminal decision. `handle`
 * carries the bee to adopt even on failure so the driver can pause on (and
 * exempt from cleanup) the very bee that blocked.
 */
type EnsureReadyResult =
  | { kind: "ready"; handle: BeeHandle }
  | { kind: "pause"; reason: string; handle: BeeHandle }
  | { kind: "errored"; reason: string; handle: BeeHandle | undefined };

/**
 * Ensure the iteration has a ready bee. Persistent carriers reuse the live bee;
 * fresh carriers (or a first iteration) spawn one and wait for readiness. A
 * trust/blocked readiness failure becomes a pause (the operator must attend the
 * bee); anything else — including a spawn failure — becomes an error.
 */
async function ensureReadyBee(args: {
  facade: HiveFacade;
  cfg: LoopConfig;
  loopId: string;
  iter: number;
  existing: BeeHandle | undefined;
}): Promise<EnsureReadyResult> {
  const { facade, cfg, loopId, iter, existing } = args;
  // Persistent carrier reuses the live bee across iterations.
  if (cfg.carrier !== "fresh" && existing) return { kind: "ready", handle: existing };

  if (testHooks) {
    const record = await testHooks.ensureBee({ facade, cfg, loopId, iter });
    return { kind: "ready", handle: handleOf(record) };
  }

  let record: SessionRecord;
  try {
    record = await spawnIterationBee(facade, cfg, loopId, iter);
  } catch (error) {
    return { kind: "errored", reason: `spawn:${error instanceof Error ? error.message : String(error)}`, handle: undefined };
  }
  const handle = handleOf(record);
  try {
    await waitForAgentReady(record, {
      timeoutMs: bootMs(cfg.bee),
      acceptTrust: true,
      raiseDroidAutonomy: cfg.yolo,
    });
  } catch (error) {
    if (error instanceof AgentReadinessError && (error.reason === "trust" || error.reason === "blocked")) {
      await appendIterLog(loopId, iter, `paused: readiness:${error.reason}`);
      return { kind: "pause", reason: `readiness:${error.reason}`, handle };
    }
    // timeout (or anything else) — surface as errored.
    return { kind: "errored", reason: `readiness:${error instanceof Error ? error.message : String(error)}`, handle };
  }
  return { kind: "ready", handle };
}

/** Boundary outcome for the driver: aborted, or the resolved seal + label. */
type BoundaryResolution =
  | { aborted: true }
  | { aborted: false; seal: SealRecord | null; boundaryBlocked: boolean; statusLabel: SealStatus | "none" };

/**
 * Run the boundary race for one iteration and resolve the turn's seal. Prefers
 * the seal the boundary observed; if none, one last collect against the
 * pre-send baseline catches a seal that landed in the final poll gap. A
 * non-sealing harness/task yields statusLabel "none" (never a fabricated seal
 * status) so it falls through to the mechanical stops rather than tripping
 * stop-on-seal. An aborted signal is reported so the driver can end cleanly.
 */
async function resolveBoundarySeal(args: {
  handle: BeeHandle;
  iter: number;
  baselineFilename: string | null;
  cfg: LoopConfig;
  started: number;
  now: () => number;
  signal?: AbortSignal | undefined;
}): Promise<BoundaryResolution> {
  const { handle, iter, cfg, started, now, signal } = args;
  let seal: SealRecord | null = null;
  let boundaryBlocked = false;
  let sealCursor = args.baselineFilename;
  try {
    const boundary = await waitForIterationBoundary({
      handle,
      iter,
      baselineFilename: sealCursor,
      timeoutMs: boundaryTimeoutMs(cfg, started, now, testHooks?.sealTimeoutMs ?? SEAL_TIMEOUT_MS),
      idleMs: testHooks?.boundaryIdleMs ?? IDLE_FALLBACK_MS,
      graceMs: testHooks?.boundaryGraceMs ?? BOUNDARY_GRACE_MS,
      pollMs: testHooks?.boundaryPollMs ?? BOUNDARY_POLL_MS,
      signal,
      capturePane: testHooks?.capturePane,
    });
    seal = boundary.seal;
    boundaryBlocked = boundary.blocked;
    sealCursor = boundary.highWaterFilename;
  } catch {
    if (signal?.aborted) return { aborted: true };
    seal = null;
  }
  if (!seal) {
    // A seal may have landed in the final poll gap — one last collect against
    // the pre-send baseline before declaring the turn unsealed.
    const latest = await scanLatestSeal(handle.name, { afterFilename: sealCursor }).catch(() => null);
    seal = latest?.seal ?? null;
  }
  // Distinguish "the bee actually sealed" from "no seal observed this turn".
  // Observability records the distinct value "none" — never a fabricated seal.
  const statusLabel: SealStatus | "none" = seal?.status ?? "none";
  return { aborted: false, seal, boundaryBlocked, statusLabel };
}

/**
 * Evaluate the post-iteration stop menu (first hit wins). Wires the sentinel
 * scan and judge to the live bee. Returns the stop/pause decision, or null to
 * continue looping.
 */
async function decideStop(args: {
  facade: HiveFacade;
  cfg: LoopConfig;
  loopId: string;
  iter: number;
  started: number;
  now: () => number;
  signal?: AbortSignal | undefined;
  seal: SealRecord | null;
  boundaryBlocked: boolean;
  handle: BeeHandle;
}): Promise<LoopStopDecision | null> {
  const { facade, cfg, loopId, iter, started, now, signal, seal, boundaryBlocked, handle } = args;
  return evaluateLoopStopConditions({
    phase: "post",
    cfg,
    completedIterations: iter,
    started,
    now,
    signal,
    seal,
    boundaryBlocked,
    recordStopCheck: (condition, result) => recordStopCheck(loopId, condition, result),
    runStopPredicate,
    scanSentinel: (pattern) =>
      testHooks?.scanSentinel ? testHooks.scanSentinel({ handle, pattern, iter }) : paneMatches(handle, pattern),
    judgeSaysStop: () => judgeSaysStop(facade, cfg, loopId, iter, { sealTimeoutMs: testHooks?.sealTimeoutMs }),
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers.
// ──────────────────────────────────────────────────────────────────────────

function boundaryTimeoutMs(cfg: LoopConfig, started: number, now: () => number, defaultTimeoutMs: number): number {
  if (cfg.stop.maxDurationMs == null) return defaultTimeoutMs;
  const remainingMs = cfg.stop.maxDurationMs - (now() - started);
  return Math.max(0, Math.min(defaultTimeoutMs, remainingMs));
}

/** Scan the bee's pane for a regex sentinel marker. */
async function paneMatches(handle: BeeHandle | undefined, pattern: string): Promise<boolean> {
  if (!handle) return false;
  try {
    const { loadSession } = await import("../store.js");
    const record = await loadSession(handle.name);
    if (!record) return false;
    const pane = await substrateFor(record).capture(record.tmuxTarget, 200, record.agentPaneId);
    let re: RegExp;
    try {
      re = new RegExp(pattern, "m");
    } catch {
      return false;
    }
    return re.test(pane);
  } catch {
    return false;
  }
}

async function recordStopCheck(loopId: string, condition: string, result: boolean): Promise<void> {
  await updateLoopConfig(loopId, { lastStopCheck: { condition, result, at: new Date().toISOString() } }).catch(
    () => undefined,
  );
}
