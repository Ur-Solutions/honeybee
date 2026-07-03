// The `loop` flow — a built-in TS flow run DETACHED via the existing flow
// background machinery (runId === loopId). Its run() function is the iteration
// driver: ensure a ready bee, inject the prompt, wait for the seal boundary,
// fold rolling memory, then evaluate the stop menu. Repeat until a condition
// fires, a graceful stop is requested, or the run is cancelled.
//
// No console.* here — the CLI layer owns stdout/stderr. Per-iteration state is
// logged via ctx.hive.log() and the loop's iter-NNN.log files.

import { spawnBeeForFlow } from "../agents.js";
import { resolveSpawnSpec } from "../spawnResolve.js";
import { defineFlow, type BeeHandle, type FlowContext } from "../flow/index.js";
import type { HiveFacade } from "../flow/hive_facade.js";
import { AgentReadinessError, isPermissionPromptPane, waitForAgentReady } from "../readiness.js";
import { scanLatestSeal, type SealRecord, type SealStatus } from "../seal.js";
import { appendLedger, type SessionRecord } from "../store.js";
import { substrateFor } from "../substrates/index.js";
import { buildLoopConfig } from "./context.js";
import { evaluateLoopStopConditions, loopStopFlowArgs } from "./stopConditions.js";
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
import { buildIterationPrompt, foldForward, truncateForInjection } from "./summarizer.js";
import { runStopPredicate } from "./until.js";

const SEAL_TIMEOUT_MS = 30 * 60_000; // overall per-iteration boundary cap
const HELPER_SEAL_TIMEOUT_MS = 5 * 60_000; // summarizer/judge bees get a much shorter leash
const IDLE_FALLBACK_MS = 3_000; // pane stability window (PRD §14: idle detection ~3s)
const BOUNDARY_GRACE_MS = 2_000; // extra slack after idle for a late-landing seal
const BOUNDARY_POLL_MS = 500;

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

/** Per-harness boot timeouts (mirror cli.ts defaultBootMs). */
function bootMs(agent: string): number {
  switch (agent) {
    case "claude":
      return 15_000;
    case "codex":
      return 30_000;
    case "opencode":
      return 15_000;
    case "grok":
      return 10_000;
    case "pi":
      return 10_000;
    case "droid":
      return 5_000;
    default:
      return 10_000;
  }
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
      if (cfg.carrier === "fresh" || !handle) {
        if (testHooks) {
          const record = await testHooks.ensureBee({ facade, cfg, loopId, iter: cfg.iteration + 1 });
          handle = handleOf(record);
        } else {
          let record: SessionRecord;
          try {
            record = await spawnIterationBee(facade, cfg, loopId, cfg.iteration + 1);
          } catch (error) {
            await finalize("errored", `spawn:${error instanceof Error ? error.message : String(error)}`);
            break;
          }
          handle = handleOf(record);
          try {
            await waitForAgentReady(record, {
              timeoutMs: bootMs(cfg.bee),
              acceptTrust: true,
              raiseDroidAutonomy: cfg.yolo,
            });
          } catch (error) {
            if (error instanceof AgentReadinessError && (error.reason === "trust" || error.reason === "blocked")) {
              await appendIterLog(loopId, cfg.iteration + 1, `paused: readiness:${error.reason}`);
              await pause(`readiness:${error.reason}`);
              break;
            }
            // timeout (or anything else) — surface as errored.
            await finalize("errored", `readiness:${error instanceof Error ? error.message : String(error)}`);
            break;
          }
        }
      }

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
      let sealCursor = sealBaselineScan?.filename ?? null;

      if (testHooks?.send) await testHooks.send({ handle, prompt, iter });
      else await facade.send(handle, prompt); // injects AND submits (Enter included)
      await appendIterLog(loopId, iter, `sent prompt (${prompt.length} chars)`);

      // ── Boundary: RACE seal detection against idle detection (PRD §14). ──
      // A harness that never seals must conclude the boundary via ~3s idle
      // detection, not after the 30-minute seal cap.
      let seal: SealRecord | null = null;
      let boundaryBlocked = false;
      try {
        const boundary = await waitForIterationBoundary({
          handle,
          iter,
          baselineFilename: sealCursor,
          timeoutMs: boundaryTimeoutMs(cfg, started, now, testHooks?.sealTimeoutMs ?? SEAL_TIMEOUT_MS),
          idleMs: testHooks?.boundaryIdleMs ?? IDLE_FALLBACK_MS,
          graceMs: testHooks?.boundaryGraceMs ?? BOUNDARY_GRACE_MS,
          pollMs: testHooks?.boundaryPollMs ?? BOUNDARY_POLL_MS,
          signal: ctx.signal,
        });
        seal = boundary.seal;
        boundaryBlocked = boundary.blocked;
        sealCursor = boundary.highWaterFilename;
      } catch {
        // An aborted signal surfaces as a boundary throw. End cleanly.
        if (ctx.signal?.aborted) {
          await finalize("stopped", "aborted");
          break;
        }
        seal = null;
      }
      if (!seal) {
        // A seal may have landed in the final poll gap — one last collect
        // against the pre-send baseline before declaring the turn unsealed.
        const latest = await scanLatestSeal(handle.name, { afterFilename: sealCursor }).catch(() => null);
        seal = latest?.seal ?? null;
      }
      // Distinguish "the bee actually sealed" from "no seal observed this turn".
      // A non-sealing harness/task must NOT be synthesized into a `done` that
      // trips stop-on-seal; instead it falls through to the mechanical stops
      // (sentinel / until / judge / max), which are the documented fallbacks
      // for harnesses without reliable seals. Observability records the
      // distinct value "none" — never a fabricated seal status.
      const statusLabel: SealStatus | "none" = seal?.status ?? "none";

      // ── Fold rolling memory forward. ──
      if (cfg.memory === "rolling" && seal) {
        const summarizerSeal = cfg.summarizer === "bee" ? await runSummarizerBee(facade, cfg, loopId, iter, seal) : seal;
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
      const decision = await evaluateLoopStopConditions({
        phase: "post",
        cfg,
        completedIterations: iter,
        started,
        now,
        signal: ctx.signal,
        seal,
        boundaryBlocked,
        recordStopCheck: (condition, result) => recordStopCheck(loopId, condition, result),
        runStopPredicate,
        scanSentinel: (pattern) =>
          testHooks?.scanSentinel ? testHooks.scanSentinel({ handle, pattern, iter }) : paneMatches(handle, pattern),
        judgeSaysStop: () => judgeSaysStop(facade, cfg, loopId, iter),
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
// Helpers.
// ──────────────────────────────────────────────────────────────────────────

function boundaryTimeoutMs(cfg: LoopConfig, started: number, now: () => number, defaultTimeoutMs: number): number {
  if (cfg.stop.maxDurationMs == null) return defaultTimeoutMs;
  const remainingMs = cfg.stop.maxDurationMs - (now() - started);
  return Math.max(0, Math.min(defaultTimeoutMs, remainingMs));
}

function handleOf(record: SessionRecord): BeeHandle {
  const handle: BeeHandle = {
    id: record.id ?? record.name,
    name: record.name,
    agent: record.agent,
    cwd: record.cwd,
  };
  if (record.node) handle.node = record.node;
  return handle;
}

/**
 * Iteration boundary detector — RACE seal detection against idle detection
 * (PRD §14: prefer the seal; fall back to ~3s idle detection for
 * harnesses/tasks that don't seal). One poll loop checks for a seal file beyond
 * the PRE-SEND filename cursor while fingerprinting the bee's pane; once the
 * pane has been stable for idleMs + graceMs with no new seal, the
 * boundary is concluded unsealed. timeoutMs remains the overall cap so a
 * never-idle, never-sealing bee cannot wedge an iteration forever.
 */
async function waitForIterationBoundary(args: {
  handle: BeeHandle;
  iter: number;
  baselineFilename: string | null;
  timeoutMs: number;
  idleMs: number;
  graceMs: number;
  pollMs: number;
  signal?: AbortSignal | undefined;
}): Promise<{ seal: SealRecord | null; blocked: boolean; highWaterFilename: string | null }> {
  const { handle } = args;
  const started = Date.now();
  let lastPane: string | undefined;
  let stableSince = Date.now();
  let goneSince: number | undefined;
  let highWaterFilename = args.baselineFilename;
  while (Date.now() - started < args.timeoutMs) {
    if (args.signal?.aborted) throw new Error(`loop boundary aborted: ${handle.name}`);
    const latest = await scanLatestSeal(handle.name, { afterFilename: highWaterFilename }).catch(() => null);
    if (latest?.seal) {
      highWaterFilename = latest.filename;
      return { seal: latest.seal, blocked: false, highWaterFilename };
    }
    const observed = await captureBoundaryPane(handle, args.iter);
    if (observed === "gone") {
      // The session verifiably ended. A one-shot bee may have written its
      // seal moments before exiting, so keep polling the seal stream for graceMs
      // before concluding the boundary unsealed.
      goneSince ??= Date.now();
      if (Date.now() - goneSince >= args.graceMs) return { seal: null, blocked: false, highWaterFilename };
    } else if (observed !== null) {
      goneSince = undefined;
      if (observed !== lastPane) {
        lastPane = observed;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= args.idleMs + args.graceMs) {
        // A stable pane sitting on an approval prompt is NOT a finished turn —
        // the bee is blocked on a human decision. Advancing would kill it
        // (fresh carrier) or paste the next prompt into the approval UI.
        return { seal: null, blocked: isPermissionPromptPane(lastPane ?? ""), highWaterFilename };
      }
    }
    // observed === null: transient capture failure (e.g. an ssh hiccup) — skip
    // the stability bookkeeping so it cannot masquerade as a stable idle pane.
    await sleep(args.pollMs);
  }
  return { seal: null, blocked: false, highWaterFilename }; // overall cap reached — unsealed boundary.
}

/**
 * Pane snapshot for the boundary's idleness fingerprint. Returns the pane
 * text, "gone" when the session verifiably no longer exists, or null when the
 * capture failed transiently (transport trouble) and nothing can be inferred.
 */
async function captureBoundaryPane(handle: BeeHandle, iter: number): Promise<string | "gone" | null> {
  if (testHooks?.capturePane) return testHooks.capturePane({ handle, iter }).catch(() => null);
  try {
    const { loadSession } = await import("../store.js");
    const record = await loadSession(handle.name);
    // No record: nothing to capture — an empty observable pane. The idle
    // window still applies, so a seal that is about to land gets its chance
    // before the boundary concludes.
    if (!record) return "";
    const substrate = substrateFor(record);
    try {
      return await substrate.capture(record.tmuxTarget, 200, record.agentPaneId);
    } catch {
      // Clean "no such session" means the bee died; a transport throw means
      // we simply don't know this pass.
      const alive = await substrate.hasSession(record.tmuxTarget).catch(() => null);
      return alive === false ? "gone" : null;
    }
  } catch {
    return null;
  }
}

/**
 * Spawn a bee for this loop. Uses spawnBeeForFlow directly when yolo is
 * requested (the facade applies the per-agent yolo default); otherwise routes through
 * facade.spawn so the bee is tracked for kill-on-end cleanup. The same
 * yolo-aware path serves the iteration bee AND the summarizer/judge helper
 * bees — a non-yolo helper inside a --yolo loop would stall on permission
 * prompts and silently burn its whole seal timeout. For the yolo path we push
 * the record onto the facade's spawned list so killAll/kill still find it.
 */
async function spawnLoopBee(
  facade: HiveFacade,
  cfg: LoopConfig,
  loopId: string,
  name: string,
): Promise<SessionRecord> {
  if (cfg.yolo) {
    // Resolve the bee token (incl. the `<tool>-auto` least-loaded pick) here —
    // the yolo path spawns directly, bypassing facade.spawn's own resolution.
    const resolved = await resolveSpawnSpec(cfg.bee, { onNote: (message) => console.error(message) });
    const record = await spawnBeeForFlow({
      agent: resolved.agent,
      ...(resolved.account ? { account: resolved.account } : {}),
      extraArgs: [],
      cwd: cfg.cwd,
      yolo: true,
      name,
      swarmId: `flow:loop:run:${loopId}`,
      runId: loopId,
      flowName: "loop",
    });
    trackSpawned(facade, record);
    await appendLedger({ type: "flow.spawn", flowName: "loop", runId: loopId, session: record.name, agent: record.agent });
    return record;
  }
  const handle = await facade.spawn({ bee: cfg.bee, cwd: cfg.cwd, name });
  // facade.spawn tracks internally; resolve the freshly-saved record.
  const { loadSession } = await import("../store.js");
  const record = await loadSession(handle.name);
  if (!record) throw new Error(`spawn produced no session record for ${handle.name}`);
  return record;
}

/**
 * Spawn the iteration bee. Fresh-carrier names are unique per iteration to
 * avoid the "tmux session already exists" collision.
 */
async function spawnIterationBee(
  facade: HiveFacade,
  cfg: LoopConfig,
  loopId: string,
  iter: number,
): Promise<SessionRecord> {
  const uniqueName = cfg.carrier === "fresh" ? `loop-${loopId}-i${iter}` : `loop-${loopId}`;
  return spawnLoopBee(facade, cfg, loopId, uniqueName);
}

/** Push a record onto the facade's private spawned list (yolo bypass path). */
function trackSpawned(facade: HiveFacade, record: SessionRecord): void {
  (facade as unknown as { spawned: SessionRecord[] }).spawned.push(record);
}

/**
 * `bee` summarizer mode: spawn a cheap bee, brief it with the prior progress +
 * the loop bee's seal, wait for ITS seal, and return that. On any failure fall
 * back to the loop bee's own seal so the loop never stalls.
 */
async function runSummarizerBee(
  facade: HiveFacade,
  cfg: LoopConfig,
  loopId: string,
  iter: number,
  loopSeal: SealRecord,
): Promise<SealRecord> {
  let handle: BeeHandle | undefined;
  try {
    const record = await spawnLoopBee(facade, cfg, loopId, `loop-${loopId}-sum${iter}`);
    handle = handleOf(record);
    await waitForAgentReady(record, { timeoutMs: bootMs(cfg.bee), acceptTrust: true, raiseDroidAutonomy: cfg.yolo }).catch(
      () => undefined,
    );
    const progress = truncateForInjection(await readFileSafe(loopProgressPath(loopId)));
    const brief = [
      `# Summarizer for loop ${loopId} iteration ${iter}`,
      "Integrate the iteration result below into the carried-forward progress, producing the new complete fold-forward progress, then seal with that as your summary. Keep it concise — do not let the summary grow without bound.",
      `## Carried-forward progress\n${progress.trim() || "(none yet)"}`,
      `## This iteration's result (status=${loopSeal.status})\n${loopSeal.summary}`,
    ].join("\n\n");
    const baseline = (await facade.collect(handle).catch(() => null))?.sealedAt ?? null;
    await facade.brief(handle, brief);
    const seal = await facade.waitForSeal(handle, {
      timeoutMs: testHooks?.sealTimeoutMs ?? HELPER_SEAL_TIMEOUT_MS,
      baselineSealedAt: baseline,
    });
    return seal;
  } catch {
    return loopSeal;
  } finally {
    if (handle) {
      try {
        await facade.kill(handle);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Judge stop condition (opt-in). Spawn a cheap bee, ask the judge question, and
 * read a yes/stop out of its seal. Conservatively returns false on any failure
 * so a flaky judge never falsely stops the loop.
 */
async function judgeSaysStop(facade: HiveFacade, cfg: LoopConfig, loopId: string, iter: number): Promise<boolean> {
  let handle: BeeHandle | undefined;
  try {
    const record = await spawnLoopBee(facade, cfg, loopId, `loop-${loopId}-judge${iter}`);
    handle = handleOf(record);
    await waitForAgentReady(record, { timeoutMs: bootMs(cfg.bee), acceptTrust: true, raiseDroidAutonomy: cfg.yolo }).catch(
      () => undefined,
    );
    const progress = truncateForInjection(await readFileSafe(loopProgressPath(loopId)));
    const brief = [
      `# Loop ${loopId} judge`,
      cfg.stop.judge ?? "",
      `## Loop progress so far\n${progress.trim() || "(none yet)"}`,
      'Answer by sealing: status "done" with a summary that begins with "STOP" if the loop should stop, otherwise status "done" with a summary beginning "CONTINUE".',
    ].join("\n\n");
    const baseline = (await facade.collect(handle).catch(() => null))?.sealedAt ?? null;
    await facade.brief(handle, brief);
    const seal = await facade.waitForSeal(handle, {
      timeoutMs: testHooks?.sealTimeoutMs ?? HELPER_SEAL_TIMEOUT_MS,
      baselineSealedAt: baseline,
    });
    return /^\s*stop\b/i.test(seal.summary);
  } catch {
    return false;
  } finally {
    if (handle) {
      try {
        await facade.kill(handle);
      } catch {
        // ignore
      }
    }
  }
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

async function readFileSafe(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8").catch(() => "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
