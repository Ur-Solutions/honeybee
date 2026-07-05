import { stat } from "node:fs/promises";
import { listAccounts, syncAccountCredentialsToVault, syncAllAccountCredentialsToVault } from "../accounts.js";
import { hiveStateFor, writeHiveState } from "../hiveState.js";
import { listNodes } from "../node.js";
import { sealedBeeNames } from "../seal.js";
import { refreshSessionTranscriptMetadata } from "../sessionMetadata.js";
import { hsrObservations } from "../hsr/observe.js";
import { createRemoteEventMirror } from "../hsr/remoteEventMirror.js";
import { appendLedger, listSessions, type SessionRecord, touchSession } from "../store.js";
import { localSubstrate } from "../substrates/index.js";
import { createAutoTitleDispatcher } from "./autoTitle.js";
import { dispatchAutoswaps } from "./autoswap.js";
import { dispatchBuzDrains } from "./buzDispatcher.js";
import { createNeedsInputDispatcher } from "./needsInput.js";
import { createNodeReachabilityTracker } from "./nodeReachability.js";
import { createUsageSampler } from "./usageSampler.js";
import { createTokenRefresher } from "./tokenRefresh.js";
import { defaultCapturePanes, defaultProbeNodes } from "./probe.js";
import type { TickDeps } from "./tick.js";
import { envMs } from "./timeouts.js";

const DEFAULT_TRANSCRIPT_REFRESH_INTERVAL_MS = 15_000;

// Credential sync may read keychain entries and many homes — far too heavy per
// tick. Every few minutes is plenty: the sweep only has to beat the NEXT
// activation, not the next tick.
const CHAIN_SYNC_INTERVAL_MS = 5 * 60_000;

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
  let lastChainSyncAt = 0;
  const refreshTranscriptMetadata = createThrottledTranscriptMetadataRefresh();
  return {
    listSessions,
    listNodes,
    probeNodes: defaultProbeNodes,
    capturePanes: defaultCapturePanes,
    livePanes: () => localSubstrate().listPanes(),
    hsrObservations: () => hsrObservations({ includeEvents: true }),
    mirrorRemoteEvents: createRemoteEventMirror(),
    sealedBeeNames,
    touchSession,
    mirrorHiveState: async (record, state) => {
      const mapped = hiveStateFor(state);
      if (mapped) await writeHiveState(record, mapped);
    },
    refreshTranscriptMetadata,
    appendLedger,
    dispatchBuzDrain: (records, transitions, currentStates) => dispatchBuzDrains(records, transitions, { currentStates }),
    dispatchNeedsInput: createNeedsInputDispatcher(),
    dispatchNodeReachability: createNodeReachabilityTracker(),
    sampleUsage: createUsageSampler(),
    dispatchAutoswap: (records, usageOutcomes) => dispatchAutoswaps(records, usageOutcomes),
    dispatchAutoTitle: createAutoTitleDispatcher(),
    refreshRemoteTokens: createTokenRefresher(),
    syncChains: async () => {
      const now = Date.now();
      if (now - lastChainSyncAt < CHAIN_SYNC_INTERVAL_MS) return;
      lastChainSyncAt = now;
      await syncAllAccountCredentialsToVault();
      // Account-bound bees may run in homes the sweep cannot find on its own
      // (arbitrary --home paths outside ~/.claude*/~/.codex*); the session
      // records know them. Provider sync still verifies the home's identity
      // before trusting its credentials.
      const accounts = new Map((await listAccounts()).map((account) => [account.id, account]));
      for (const record of await listSessions()) {
        if (!record.accountId || !record.homePath) continue;
        const account = accounts.get(record.accountId);
        if (!account) continue;
        await syncAccountCredentialsToVault(account, record.homePath, { trustExtraHome: true }).catch(() => undefined);
      }
    },
    now: () => Date.now(),
  };
}
