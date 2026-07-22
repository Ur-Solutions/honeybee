// Usage sampler + exhaustion matcher (Phase 3 patch 3.5).
//
// Runs inside the daemon tick. For each account-bound bee it (a) watches the
// live pane for the provider's rate-limit message and emits account.exhausted
// on the rising edge, and (b) periodically reads the bee's transcript and
// appends cumulative token totals to ~/.hive/usage/<account>.jsonl. Both are
// facts; no quota judgment happens here.
//
// HSR bees have NO pane. For a record with `substrate === "hsr"` we source both
// signals from the bee's events.jsonl instead: typed `exhausted` events (from
// the claude/codex adapters' rate-limit parsing) drive account.exhausted, and
// exact `usage` events supply the token totals (transcript is a fallback only
// when the events log carries no usage yet). tmux behavior is unchanged.

import { exhaustionForAgent } from "../drivers.js";
import { hsrUsageObservation, type HsrObservation, type HsrUsageObservation } from "../hsr/observe.js";
import { readHsrMeta } from "../hsr/runDir.js";
import { LOCAL_NODE_NAME } from "../node.js";
import { transcriptLookupForSession } from "../sessionMetadata.js";
import type { PaneCaptureMap } from "../state.js";
import { appendLedger, type SessionRecord } from "../store.js";
import { latestTranscript, readJsonl, type TranscriptRow } from "../transcripts.js";
import { appendUsageEvent, transcriptTokenTotals, type TokenTotals, type UsageEvent } from "../usage.js";

export type UsageTickOutcome = {
  bee: string;
  account: string;
  /** True when this tick appended a usage sample. */
  sampled: boolean;
  /** True on the rising edge of an exhaustion message (event emitted this tick). */
  exhausted: boolean;
  resetHint?: string;
};

export type UsageSamplerDeps = {
  appendUsageEvent?: (event: UsageEvent) => Promise<void>;
  appendLedger?: (event: Record<string, unknown>) => Promise<void>;
  /** Raw transcript rows for token extraction. Injectable for tests. */
  readTranscriptRows?: (record: SessionRecord) => Promise<{ provider: string; rows: TranscriptRow[] } | null>;
  /** Structured usage/exhaustion from an HSR bee's events.jsonl. Injectable for tests. */
  readHsrUsage?: (bee: string) => Promise<HsrUsageObservation>;
  /**
   * Whether a (node-carrying, non-`hsr`) remote bee has a LOCAL mirror run dir
   * (APIA-94) — if so it is fed from the mirrored events.jsonl via the HSR path,
   * just like a local HSR bee. Injectable for tests; defaults to reading the
   * mirror meta.json.
   */
  isMirroredRemoteBee?: (record: SessionRecord) => Promise<boolean>;
  /** Minimum interval between transcript reads per bee (default 60s). */
  sampleIntervalMs?: number;
};

export type UsageSampler = (
  records: SessionRecord[],
  panes: PaneCaptureMap,
  nowMs: number,
  hsrObservations?: ReadonlyMap<string, HsrObservation>,
) => Promise<UsageTickOutcome[]>;

const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const EXHAUSTION_PANE_LINES = 30;

export function createUsageSampler(deps: UsageSamplerDeps = {}): UsageSampler {
  const appendEvent = deps.appendUsageEvent ?? appendUsageEvent;
  const ledger = deps.appendLedger ?? appendLedger;
  const readRows = deps.readTranscriptRows ?? defaultReadTranscriptRows;
  const readHsrUsage = deps.readHsrUsage ?? hsrUsageObservation;
  const isMirroredRemoteBee = deps.isMirroredRemoteBee ?? defaultIsMirroredRemoteBee;
  const sampleIntervalMs = deps.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;

  // Sampler state survives across ticks: rising-edge debounce for exhaustion
  // and per-bee sampling throttle/dedupe.
  const exhaustedNow = new Set<string>();
  // HSR edge detector: the ts of the last `exhausted` event we fired on, per
  // bee. events.jsonl is append-only (an exhausted event persists in the log),
  // so we fire only on a STRICTLY-NEWER exhausted event — no pane to fall from.
  const lastHsrExhaustedTs = new Map<string, number>();
  const lastSampleAt = new Map<string, number>();
  const lastTotals = new Map<string, TokenTotals>();
  let inFlight: Promise<UsageTickOutcome[]> | undefined;

  // Append a fresh token sample for `record` if `totals` moved since the last
  // one (shared by the tmux + HSR paths). Mutates outcome.sampled.
  async function appendTokenSample(record: SessionRecord, totals: TokenTotals, nowMs: number, outcome: UsageTickOutcome): Promise<void> {
    const previous = lastTotals.get(record.name);
    if (previous && previous.inputTokens === totals.inputTokens && previous.outputTokens === totals.outputTokens) return;
    lastTotals.set(record.name, totals);
    await appendEvent({
      ts: new Date(nowMs).toISOString(),
      kind: "sample",
      account: record.accountId!,
      bee: record.name,
      agent: record.agent,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
    });
    outcome.sampled = true;
  }

  // Emit the account.exhausted edge for `record` (shared usage-log + ledger
  // append). Mutates outcome.exhausted/resetHint.
  async function emitExhausted(record: SessionRecord, resetHint: string | undefined, nowMs: number, outcome: UsageTickOutcome): Promise<void> {
    outcome.exhausted = true;
    if (resetHint) outcome.resetHint = resetHint;
    await appendEvent({
      ts: new Date(nowMs).toISOString(),
      kind: "exhausted",
      account: record.accountId!,
      bee: record.name,
      agent: record.agent,
      ...(resetHint ? { resetHint } : {}),
    });
    await ledger({
      type: "account.exhausted",
      account: record.accountId!,
      session: record.name,
      agent: record.agent,
      ...(resetHint ? { resetHint } : {}),
    });
  }

  // HSR bees have NO pane: sample exhaustion + tokens purely from events.jsonl.
  async function sampleHsr(
    record: SessionRecord,
    nowMs: number,
    hsrObservation?: HsrObservation,
  ): Promise<UsageTickOutcome> {
    const outcome: UsageTickOutcome = { bee: record.name, account: record.accountId!, sampled: false, exhausted: false };
    const observation = hsrObservation?.eventSnapshot?.usage ?? await readHsrUsage(record.name).catch(() => null);

    // Exhaustion: rising edge on a strictly-newer `exhausted` event ts.
    if (observation?.latestExhausted) {
      const previous = lastHsrExhaustedTs.get(record.name);
      if (previous === undefined || observation.latestExhausted.ts > previous) {
        lastHsrExhaustedTs.set(record.name, observation.latestExhausted.ts);
        await emitExhausted(record, observation.latestExhausted.resetHint, nowMs, outcome);
      }
    }

    // Token sampling: exact totals from `usage` events; transcript is a fallback
    // only when the events log carries no usage yet.
    const last = lastSampleAt.get(record.name) ?? 0;
    if (nowMs - last >= sampleIntervalMs) {
      lastSampleAt.set(record.name, nowMs);
      let totals = observation?.totals ?? null;
      if (!totals) {
        const transcript = await readRows(record).catch(() => null);
        totals = transcript ? transcriptTokenTotals(transcript.provider, transcript.rows) : null;
      }
      if (totals) await appendTokenSample(record, totals, nowMs, outcome);
    }

    return outcome;
  }

  const sample = async (
    records: SessionRecord[],
    panes: PaneCaptureMap,
    nowMs: number,
    hsrObservations?: ReadonlyMap<string, HsrObservation>,
  ): Promise<UsageTickOutcome[]> => {
    const outcomes: UsageTickOutcome[] = [];

    for (const record of records) {
      // Historical records cannot produce new usage or exhaustion edges. A
      // cold daemon previously re-read hundreds of archived HSR logs (and, on
      // a cache miss, their full transcripts) before its first useful sample.
      if (!record.accountId || record.status !== "running") continue;
      const hsrObservation = hsrObservations?.get(record.name);

      // When the tick supplied its coherent HSR observation batch, absence is
      // deliberate or unknown (sealed record filtered out, failed run-dir
      // read). Do not defeat that bounded batch by launching a second direct
      // events/transcript scan from the dispatcher.
      if (record.substrate === "hsr" && hsrObservations !== undefined && !hsrObservation) continue;

      // HSR bees are pane-less — feed the sampler from their events.jsonl. A
      // remote-hsr bee with a LOCAL mirror (APIA-94) has the same event log
      // locally, so it takes the same path.
      if (record.substrate === "hsr" || hsrObservation?.mirrorOf || (await isMirroredRemoteBee(record))) {
        outcomes.push(await sampleHsr(record, nowMs, hsrObservation));
        continue;
      }

      const paneKey = record.agentPaneId ?? record.tmuxTarget;
      const paneCaptured = panes.has(paneKey);
      const pane = panes.get(paneKey);
      if (!paneCaptured) {
        // Not live this tick; clear the edge detector so a relaunch re-arms it.
        exhaustedNow.delete(record.name);
        continue;
      }
      if (pane === undefined) continue;

      const outcome: UsageTickOutcome = { bee: record.name, account: record.accountId, sampled: false, exhausted: false };

      const hit = exhaustionForAgent(record.agent, recentPane(pane));
      if (hit) {
        if (!exhaustedNow.has(record.name)) {
          exhaustedNow.add(record.name);
          await emitExhausted(record, hit.resetHint, nowMs, outcome);
        }
      } else {
        exhaustedNow.delete(record.name);
      }

      const last = lastSampleAt.get(record.name) ?? 0;
      if (nowMs - last >= sampleIntervalMs) {
        lastSampleAt.set(record.name, nowMs);
        const transcript = await readRows(record).catch(() => null);
        const totals = transcript ? transcriptTokenTotals(transcript.provider, transcript.rows) : null;
        if (totals) await appendTokenSample(record, totals, nowMs, outcome);
      }

      outcomes.push(outcome);
    }

    return outcomes;
  };

  return (records, panes, nowMs, hsrObservations) => {
    // withTimeout cannot cancel work it abandons. Share the still-running
    // sample with later ticks so a slow registry never accumulates overlapping
    // transcript scans in the same daemon process.
    if (inFlight) return inFlight;
    const current = sample(records, panes, nowMs, hsrObservations).finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
    inFlight = current;
    return current;
  };
}

// A remote bee is fed from the HSR path iff it carries a non-local node, is not
// already the local-hsr substrate, and has a local mirror meta marked
// `mirrorOfNode`. The negative case is cheap: a non-mirrored remote bee has no
// local run dir, so readHsrMeta resolves null without touching the events log.
async function defaultIsMirroredRemoteBee(record: SessionRecord): Promise<boolean> {
  if (record.substrate === "hsr") return false;
  if (!record.node || record.node === LOCAL_NODE_NAME) return false;
  const meta = await readHsrMeta(record.name).catch(() => null);
  return !!meta?.mirrorOfNode;
}

// Claude transcripts keep usage on the raw rows latestTranscript already
// returns; codex stores token_count events that its normalizer strips, so we
// re-read the raw JSONL for codex.
async function defaultReadTranscriptRows(record: SessionRecord): Promise<{ provider: string; rows: TranscriptRow[] } | null> {
  const tx = await latestTranscript(record.agent, record.cwd, transcriptLookupForSession(record));
  if (!tx) return null;
  if (tx.provider === "codex") {
    return { provider: tx.provider, rows: await readJsonl(tx.path) };
  }
  return { provider: tx.provider, rows: tx.rows };
}

function recentPane(pane: string): string {
  return pane.trimEnd().split("\n").slice(-EXHAUSTION_PANE_LINES).join("\n");
}
