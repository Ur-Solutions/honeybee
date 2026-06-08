// The `loop` flow — a built-in TS flow run DETACHED via the existing flow
// background machinery (runId === loopId). Its run() function is the iteration
// driver: ensure a ready bee, inject the prompt, wait for the seal boundary,
// fold rolling memory, then evaluate the stop menu. Repeat until a condition
// fires, a graceful stop is requested, or the run is cancelled.
//
// No console.* here — the CLI layer owns stdout/stderr. Per-iteration state is
// logged via ctx.hive.log() and the loop's iter-NNN.log files.

import { spawnBeeForFlow } from "../agents.js";
import { defineFlow, type BeeHandle, type FlowContext } from "../flow/index.js";
import type { HiveFacade } from "../flow/hive_facade.js";
import { AgentReadinessError, waitForAgentReady } from "../readiness.js";
import type { SealRecord, SealStatus } from "../seal.js";
import { appendLedger, type SessionRecord } from "../store.js";
import { substrateFor } from "../substrates/index.js";
import { buildLoopConfig } from "./context.js";
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

const SEAL_TIMEOUT_MS = 30 * 60_000; // generous per-iteration boundary timeout
const IDLE_FALLBACK_MS = 3_000;

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
  /** Optional override for the per-iteration seal timeout (keeps no-seal tests fast). */
  sealTimeoutMs?: number;
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
    { name: "bee" },
    { name: "cwd" },
    { name: "context" },
    { name: "prompt" },
    { name: "until", default: "" },
    { name: "max", default: 100 },
    { name: "maxDuration", default: "" },
    { name: "forever", default: false },
    { name: "stopOnSeal", default: "done" },
    { name: "stopOnSentinel", default: "" },
    { name: "judge", default: "" },
    { name: "summarizer", default: "self" },
    { name: "loopId", default: "" },
    { name: "yolo", default: false },
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
  const started = Date.now();
  let finalStatus: LoopStatus = "running";
  let stopReason = "";

  const finalize = async (status: LoopStatus, reason: string): Promise<void> => {
    finalStatus = status;
    stopReason = reason;
    await updateLoopConfig(loopId, { status, stopReason: reason, endedAt: new Date().toISOString(), currentBee: undefined });
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

      // --until check at the top of every pass. Evaluating here (rather than
      // after the iteration) gives one spawn per boundary AND lets an
      // already-satisfied predicate exit before the first iteration does any
      // work. The bee is idle between the previous pass and this check, so no
      // loop-driven change is missed by not re-checking post-iteration.
      if (cfg.stop.until) {
        const hit = await runStopPredicate(cfg.stop.until, cfg.cwd, { signal: ctx.signal });
        await recordStopCheck(loopId, "until", hit);
        if (hit) {
          await finalize("done", "until");
          break;
        }
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
              await finalize("paused", `readiness:${error.reason}`);
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
      const sealBaseline = (await facade.collect(handle))?.sealedAt;

      if (testHooks?.send) await testHooks.send({ handle, prompt, iter });
      else await facade.send(handle, prompt); // injects AND submits (Enter included)
      await appendIterLog(loopId, iter, `sent prompt (${prompt.length} chars)`);

      // ── Boundary: prefer the seal, fall back to idle + latest seal. ──
      let seal: SealRecord | null = null;
      try {
        seal = await facade.waitForSeal(handle, { timeoutMs: testHooks?.sealTimeoutMs ?? SEAL_TIMEOUT_MS });
      } catch {
        // An aborted signal surfaces as a waitForSeal throw; do not convert it
        // into a 10-minute idle wait that ignores the signal. End cleanly.
        if (ctx.signal?.aborted) {
          await finalize("stopped", "aborted");
          break;
        }
        try {
          await facade.wait(handle, { idleMs: IDLE_FALLBACK_MS });
        } catch {
          // ignore idle-wait failures; we still try to collect any seal.
        }
        const latest = await facade.collect(handle);
        // Only accept a seal newer than the pre-send baseline; otherwise this
        // turn produced no seal and we must not mis-attribute an old one.
        seal = latest && latest.sealedAt !== sealBaseline ? latest : null;
      }
      // Distinguish "the bee actually sealed" from "no seal observed this turn".
      // A non-sealing harness/task must NOT be synthesized into a `done` that
      // trips stop-on-seal; instead it falls through to the mechanical stops
      // (sentinel / until / judge / max), which are the documented fallbacks
      // for harnesses without reliable seals.
      const sealed = seal != null;
      const status: SealStatus = seal?.status ?? "done";

      // ── Fold rolling memory forward. ──
      if (cfg.memory === "rolling" && seal) {
        const summarizerSeal = cfg.summarizer === "bee" ? await runSummarizerBee(facade, cfg, loopId, iter, seal) : seal;
        await foldForward(loopId, iter, summarizerSeal);
      }

      if (seal) await writeIterSeal(loopId, iter, seal);
      await appendIterLog(loopId, iter, `status=${status}`);

      cfg.iteration = iter;
      await updateLoopConfig(loopId, { iteration: iter, lastSealStatus: status, currentBee: handle?.name });
      await appendLedger({ type: "loop.iteration", loopId, iteration: iter, status });
      await ctx.hive.log(`iteration ${iter} status=${status}`);

      // Scan the sentinel BEFORE the fresh-carrier kill: once the bee is killed
      // its tmux session is gone and the handle is cleared, so a post-kill scan
      // would always miss. Capture the decision while the bee is still live.
      const sentinelMatched = cfg.stop.stopOnSentinel
        ? testHooks?.scanSentinel
          ? await testHooks.scanSentinel({ handle, pattern: cfg.stop.stopOnSentinel, iter })
          : await paneMatches(handle, cfg.stop.stopOnSentinel)
        : false;

      // Fresh carrier: kill this iteration's bee before respawning a new one.
      if (cfg.carrier === "fresh" && handle) {
        try {
          await ctx.hive.kill(handle);
        } catch {
          // already gone — fine.
        }
        handle = undefined;
      }

      // ── Stop menu (first hit wins). pause is distinct from stop. ──
      // Seal-derived stops only apply when the bee actually sealed; a no-seal
      // turn is not a real `done` and must not stop the loop on its own.
      if (sealed && (status === "blocked" || status === "needs_input")) {
        await finalize("paused", `seal:${status}`);
        break;
      }
      if (sealed && cfg.stop.stopOnSeal.includes(status)) {
        await recordStopCheck(loopId, "stop-on-seal", true);
        await finalize("done", `seal:${status}`);
        break;
      }
      if (cfg.stop.stopOnSentinel) {
        await recordStopCheck(loopId, "stop-on-sentinel", sentinelMatched);
        if (sentinelMatched) {
          await finalize("done", "sentinel");
          break;
        }
      }
      // (--until is evaluated at the top of the loop, not here, to avoid a
      // redundant second spawn of the same predicate across the boundary.)
      if (cfg.stop.judge) {
        const hit = await judgeSaysStop(facade, cfg, loopId, iter);
        await recordStopCheck(loopId, "judge", hit);
        if (hit) {
          await finalize("done", "judge");
          break;
        }
      }
      if (!cfg.stop.forever && cfg.stop.max != null && iter >= cfg.stop.max) {
        await recordStopCheck(loopId, "max", true);
        await finalize("done", "max");
        break;
      }
      if (cfg.stop.maxDurationMs != null && Date.now() - started >= cfg.stop.maxDurationMs) {
        await recordStopCheck(loopId, "max-duration", true);
        await finalize("done", "max-duration");
        break;
      }
      // else loop again
    }
  } catch (error) {
    await finalize("errored", error instanceof Error ? error.message : String(error));
    throw error;
  }

  return { loopId, iterations: cfg.iteration, status: finalStatus, stopReason };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers.
// ──────────────────────────────────────────────────────────────────────────

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
 * Spawn the iteration bee. Uses spawnBeeForFlow directly when yolo is requested
 * (the facade hardcodes yolo:false); otherwise routes through facade.spawn so
 * the bee is tracked for kill-on-end cleanup. Fresh-carrier names are unique per
 * iteration to avoid the "tmux session already exists" collision. The facade
 * tracks every bee we hand it; for the yolo path we push the record onto the
 * facade's spawned list so killAll/kill still find it.
 */
async function spawnIterationBee(
  facade: HiveFacade,
  cfg: LoopConfig,
  loopId: string,
  iter: number,
): Promise<SessionRecord> {
  const uniqueName = cfg.carrier === "fresh" ? `loop-${loopId}-i${iter}` : `loop-${loopId}`;
  if (cfg.yolo) {
    const record = await spawnBeeForFlow({
      agent: cfg.bee,
      extraArgs: [],
      cwd: cfg.cwd,
      yolo: true,
      name: uniqueName,
      swarmId: `flow:loop:run:${loopId}`,
      runId: loopId,
      flowName: "loop",
    });
    trackSpawned(facade, record);
    await appendLedger({ type: "flow.spawn", flowName: "loop", runId: loopId, session: record.name, agent: record.agent });
    return record;
  }
  const handle = await facade.spawn({ bee: cfg.bee, cwd: cfg.cwd, name: uniqueName });
  // facade.spawn tracks internally; resolve the freshly-saved record.
  const { loadSession } = await import("../store.js");
  const record = await loadSession(handle.name);
  if (!record) throw new Error(`spawn produced no session record for ${handle.name}`);
  return record;
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
    const name = `loop-${loopId}-sum${iter}`;
    handle = await facade.spawn({ bee: cfg.bee, cwd: cfg.cwd, name });
    const { loadSession } = await import("../store.js");
    const record = await loadSession(handle.name);
    if (record) {
      await waitForAgentReady(record, { timeoutMs: bootMs(cfg.bee), acceptTrust: true, raiseDroidAutonomy: cfg.yolo }).catch(
        () => undefined,
      );
    }
    const progress = await readFileSafe(loopProgressPath(loopId));
    const brief = [
      `# Summarizer for loop ${loopId} iteration ${iter}`,
      "Integrate the iteration result below into the carried-forward progress, producing the new complete fold-forward progress, then seal with that as your summary.",
      `## Carried-forward progress\n${progress.trim() || "(none yet)"}`,
      `## This iteration's result (status=${loopSeal.status})\n${loopSeal.summary}`,
    ].join("\n\n");
    await facade.brief(handle, brief);
    const seal = await facade.waitForSeal(handle, { timeoutMs: SEAL_TIMEOUT_MS });
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
    const name = `loop-${loopId}-judge${iter}`;
    handle = await facade.spawn({ bee: cfg.bee, cwd: cfg.cwd, name });
    const { loadSession } = await import("../store.js");
    const record = await loadSession(handle.name);
    if (record) {
      await waitForAgentReady(record, { timeoutMs: bootMs(cfg.bee), acceptTrust: true, raiseDroidAutonomy: cfg.yolo }).catch(
        () => undefined,
      );
    }
    const progress = await readFileSafe(loopProgressPath(loopId));
    const brief = [
      `# Loop ${loopId} judge`,
      cfg.stop.judge ?? "",
      `## Loop progress so far\n${progress.trim() || "(none yet)"}`,
      'Answer by sealing: status "done" with a summary that begins with "STOP" if the loop should stop, otherwise status "done" with a summary beginning "CONTINUE".',
    ].join("\n\n");
    await facade.brief(handle, brief);
    const seal = await facade.waitForSeal(handle, { timeoutMs: SEAL_TIMEOUT_MS });
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
    const pane = await substrateFor(record).capture(record.tmuxTarget, 200);
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
