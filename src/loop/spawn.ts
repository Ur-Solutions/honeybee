// Bee-spawning helpers for the loop driver: the iteration bee itself plus the
// two ephemeral helper bees (rolling-memory summarizer, opt-in judge). Split out
// of loop/flow.ts so the driver keeps only iteration policy.
//
// All three share spawnLoopBee, which applies the loop's --yolo default and
// keeps the record on the facade's spawned list for kill-on-end cleanup.

import { spawnBeeForFlow } from "../agents.js";
import type { BeeHandle } from "../flow/index.js";
import type { HiveFacade } from "../flow/hive_facade.js";
import { waitForAgentReady } from "../readiness.js";
import type { SealRecord } from "../seal.js";
import { resolveSpawnSpec } from "../spawnResolve.js";
import { appendLedger, type SessionRecord } from "../store.js";
import { bootMs, handleOf, readFileSafe } from "./internal.js";
import type { LoopConfig } from "./state.js";
import { loopProgressPath } from "./state.js";
import { truncateForInjection } from "./summarizer.js";

const HELPER_SEAL_TIMEOUT_MS = 5 * 60_000; // summarizer/judge bees get a much shorter leash

/**
 * Spawn a bee for this loop. Uses spawnBeeForFlow directly when yolo is
 * requested (the facade applies the per-agent yolo default); otherwise routes through
 * facade.spawn so the bee is tracked for kill-on-end cleanup. The same
 * yolo-aware path serves the iteration bee AND the summarizer/judge helper
 * bees — a non-yolo helper inside a --yolo loop would stall on permission
 * prompts and silently burn its whole seal timeout. For the yolo path we push
 * the record onto the facade's spawned list so killAll/kill still find it.
 */
export async function spawnLoopBee(
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
export async function spawnIterationBee(
  facade: HiveFacade,
  cfg: LoopConfig,
  loopId: string,
  iter: number,
): Promise<SessionRecord> {
  const uniqueName = cfg.carrier === "fresh" ? `loop-${loopId}-i${iter}` : `loop-${loopId}`;
  return spawnLoopBee(facade, cfg, loopId, uniqueName);
}

/** Push a record onto the facade's private spawned list (yolo bypass path). */
export function trackSpawned(facade: HiveFacade, record: SessionRecord): void {
  (facade as unknown as { spawned: SessionRecord[] }).spawned.push(record);
}

/**
 * `bee` summarizer mode: spawn a cheap bee, brief it with the prior progress +
 * the loop bee's seal, wait for ITS seal, and return that. On any failure fall
 * back to the loop bee's own seal so the loop never stalls.
 */
export async function runSummarizerBee(
  facade: HiveFacade,
  cfg: LoopConfig,
  loopId: string,
  iter: number,
  loopSeal: SealRecord,
  opts: { sealTimeoutMs?: number | undefined } = {},
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
      timeoutMs: opts.sealTimeoutMs ?? HELPER_SEAL_TIMEOUT_MS,
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
export async function judgeSaysStop(
  facade: HiveFacade,
  cfg: LoopConfig,
  loopId: string,
  iter: number,
  opts: { sealTimeoutMs?: number | undefined } = {},
): Promise<boolean> {
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
      timeoutMs: opts.sealTimeoutMs ?? HELPER_SEAL_TIMEOUT_MS,
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
