import { stat } from "node:fs/promises";
import { hiveStateFor, writeHiveState } from "../hiveState.js";
import { listNodes } from "../node.js";
import { sealedBeeNames } from "../seal.js";
import { refreshSessionTranscriptMetadata } from "../sessionMetadata.js";
import { hsrObservations, structuredStateFromEvents, type HsrObservation } from "../hsr/observe.js";
import { createIsolatedHsrObservations } from "./observerProcess.js";
import { createIsolatedSessionLister } from "./sessionListProcess.js";
import { createIsolatedCredentialSweeper } from "./credentialSweepProcess.js";
import { createRemoteEventMirror } from "../hsr/remoteEventMirror.js";
import {
  appendLedger,
  markSessionVerified,
  transitionSession,
  type SessionRecord,
  touchSession,
} from "../store.js";
import { localSubstrate } from "../substrates/index.js";
import { createAutoTitleDispatcher } from "./autoTitle.js";
import { createAuthRecoveryDispatcher } from "./authRecovery.js";
import { createRotationResumeDispatcher } from "./rotationResume.js";
import { dispatchAutoswaps } from "./autoswap.js";
import { createBuzDrainDispatcher } from "./buzDispatcher.js";
import { createBuzRecoveryDispatcher } from "./buzRecovery.js";
import { createNeedsInputDispatcher } from "./needsInput.js";
import { createRequestReconciler } from "./requestSweep.js";
import { createTaskSupplyDispatcher } from "./taskSupplyDispatcher.js";
import { createNodeReachabilityTracker } from "./nodeReachability.js";
import { createPoolSweeper } from "./poolSweep.js";
import { createTerminalReprobeSweeper } from "./terminalReprobe.js";
import { probeHsrReAdoption } from "./reAdoption.js";
import { createRuntimeRecoveryDispatcher, reconcileRuntimeDeaths } from "./runtimeRecovery.js";
import { createRuntimeParkingDispatcher } from "./runtimeParking.js";
import { createFlightSweeper } from "./flightSweep.js";
import { createCombSweeper } from "./combSweep.js";
import { createUsageSampler } from "./usageSampler.js";
import { createTokenRefresher } from "./tokenRefresh.js";
import { defaultCapturePanes, defaultProbeNodes } from "./probe.js";
import type { TickDeps } from "./tick.js";
import { envMs } from "./timeouts.js";

const DEFAULT_TRANSCRIPT_REFRESH_INTERVAL_MS = 15_000;

type TranscriptFileStat = { mtimeMs: number; size: number };

export type ThrottledTranscriptRefreshOptions = {
  intervalMs?: number;
  now?: () => number;
  statFile?: (path: string) => Promise<TranscriptFileStat | null>;
};

export function createThrottledTranscriptMetadataRefresh(
  refresh: (record: SessionRecord) => Promise<SessionRecord | null> = refreshSessionTranscriptMetadata,
  options: ThrottledTranscriptRefreshOptions = {},
): (record: SessionRecord) => Promise<SessionRecord | null> {
  const intervalMs = options.intervalMs ?? envMs("HIVE_DAEMON_TRANSCRIPT_REFRESH_INTERVAL_MS", DEFAULT_TRANSCRIPT_REFRESH_INTERVAL_MS);
  const now = options.now ?? (() => Date.now());
  const statFile = options.statFile ?? defaultTranscriptFileStat;
  const cache = new Map<string, { checkedAt: number; cursor: string; statKey?: string }>();

  return async (record) => {
    const nowMs = now();
    const cursor = transcriptRefreshCursor(record);
    const cached = cache.get(record.name);

    if (cached?.cursor === cursor) {
      if (nowMs - cached.checkedAt < intervalMs) return record;
      if (record.transcriptPath) {
        const currentStatKey = await transcriptStatKey(record.transcriptPath, statFile);
        if (currentStatKey && currentStatKey === cached.statKey) {
          cached.checkedAt = nowMs;
          return record;
        }
      }
    }

    const updated = await refresh(record);
    const effective = updated ?? record;
    const statKey = effective.transcriptPath ? await transcriptStatKey(effective.transcriptPath, statFile) : undefined;
    cache.set(effective.name, {
      checkedAt: nowMs,
      cursor: transcriptRefreshCursor(effective),
      ...(statKey ? { statKey } : {}),
    });
    return updated;
  };
}

function transcriptRefreshCursor(record: SessionRecord): string {
  return [
    record.agent,
    record.cwd,
    record.homePath ?? "",
    record.lastPromptAt ?? "",
    record.lastPrompt ?? "",
    record.transcriptPath ?? "",
    record.providerSessionId ?? "",
  ].join("\0");
}

async function transcriptStatKey(
  path: string,
  statFile: (path: string) => Promise<TranscriptFileStat | null>,
): Promise<string | undefined> {
  const info = await statFile(path).catch(() => null);
  return info ? `${info.mtimeMs}:${info.size}` : undefined;
}

async function defaultTranscriptFileStat(path: string): Promise<TranscriptFileStat | null> {
  try {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return null;
  }
}

export function buildDefaultDeps(): TickDeps {
  const refreshTranscriptMetadata = createThrottledTranscriptMetadataRefresh();
  const isolatedListSessions = createIsolatedSessionLister();
  const isolatedCredentialSweep = createIsolatedCredentialSweeper();
  const dispatchBuzDrain = createBuzDrainDispatcher();
  const observerId = `hive-daemon:${process.pid}`;
  const probeRuntime = async (record: SessionRecord) =>
    (await probeHsrReAdoption(record, observerId)).evidence;
  return {
    listSessions: isolatedListSessions,
    listNodes,
    probeNodes: defaultProbeNodes,
    capturePanes: defaultCapturePanes,
    livePanes: () => localSubstrate().listPanes(),
    // The run-dir sweep runs in a disposable child process so a wedged fs call
    // dies with the child instead of poisoning the daemon's threadpool
    // (CL.701 §5). HIVE_DAEMON_ISOLATED_OBSERVER=0 opts back into in-process.
    hsrObservations:
      process.env.HIVE_DAEMON_ISOLATED_OBSERVER === "0"
        ? (beeNames) => hsrObservations({ includeEvents: true, bees: beeNames })
        : createIsolatedHsrObservations(),
    mirrorRemoteEvents: createRemoteEventMirror(),
    sealedBeeNames,
    touchSession,
    markSessionVerified,
    mirrorHiveState: async (record, state) => {
      const mapped = hiveStateFor(state);
      if (mapped) await writeHiveState(record, mapped);
    },
    refreshTranscriptMetadata,
    appendLedger,
    dispatchBuzDrain,
    dispatchBuzRecovery: createBuzRecoveryDispatcher(),
    reconcileRuntimeDeaths: (records, observations) => reconcileRuntimeDeaths(records, {
      probe: probeRuntime,
      transition: transitionSession,
      hasUnfinishedMarker: (bee) => Promise.resolve(hasUnfinishedHsrMarker(observations.get(bee))),
    }),
    dispatchRuntimeRecovery: createRuntimeRecoveryDispatcher({
      probe: probeRuntime,
      transition: transitionSession,
    }),
    dispatchRuntimeParking: createRuntimeParkingDispatcher(),
    dispatchTaskSupply: createTaskSupplyDispatcher(),
    reconcileRequests: createRequestReconciler(),
    recoverAuthNeeded: createAuthRecoveryDispatcher(),
    resumeRotationStranded: createRotationResumeDispatcher(),
    dispatchNeedsInput: createNeedsInputDispatcher(),
    dispatchNodeReachability: createNodeReachabilityTracker(),
    sampleUsage: createUsageSampler(),
    dispatchAutoswap: (records, usageOutcomes) => dispatchAutoswaps(records, usageOutcomes),
    dispatchAutoTitle: createAutoTitleDispatcher(),
    refreshRemoteTokens: createTokenRefresher(),
    sweepPools: createPoolSweeper(),
    reprobeTerminalCursors: createTerminalReprobeSweeper(),
    sweepCombs: createCombSweeper(),
    sweepFlights: createFlightSweeper(),
    // Pacing/single-flight lives in runDaemon. The sweep itself is isolated in
    // a killable child: a keychain prompt or lost fs completion cannot retain
    // an account lock or overlap a later interval in the daemon process.
    syncChains: isolatedCredentialSweep,
    now: () => Date.now(),
  };
}

function hasUnfinishedHsrMarker(observation: HsrObservation | undefined): boolean {
  const events = observation?.eventSnapshot?.events;
  if (!events || events.length === 0) return false;
  const state = structuredStateFromEvents(events);
  return state === "active" || state === "blocked" || state === "auth-needed";
}
