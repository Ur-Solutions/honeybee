// Usage sampler + exhaustion matcher (Phase 3 patch 3.5).
//
// Runs inside the daemon tick. For each account-bound bee it (a) watches the
// live pane for the provider's rate-limit message and emits account.exhausted
// on the rising edge, and (b) periodically reads the bee's transcript and
// appends cumulative token totals to ~/.hive/usage/<account>.jsonl. Both are
// facts; no quota judgment happens here.

import { exhaustionForAgent } from "../drivers.js";
import { transcriptLookupForSession } from "../sessionMetadata.js";
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
  /** Minimum interval between transcript reads per bee (default 60s). */
  sampleIntervalMs?: number;
};

export type UsageSampler = (records: SessionRecord[], panes: Map<string, string>, nowMs: number) => Promise<UsageTickOutcome[]>;

const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const EXHAUSTION_PANE_LINES = 30;

export function createUsageSampler(deps: UsageSamplerDeps = {}): UsageSampler {
  const appendEvent = deps.appendUsageEvent ?? appendUsageEvent;
  const ledger = deps.appendLedger ?? appendLedger;
  const readRows = deps.readTranscriptRows ?? defaultReadTranscriptRows;
  const sampleIntervalMs = deps.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;

  // Sampler state survives across ticks: rising-edge debounce for exhaustion
  // and per-bee sampling throttle/dedupe.
  const exhaustedNow = new Set<string>();
  const lastSampleAt = new Map<string, number>();
  const lastTotals = new Map<string, TokenTotals>();

  return async (records, panes, nowMs) => {
    const outcomes: UsageTickOutcome[] = [];

    for (const record of records) {
      if (!record.accountId) continue;
      const pane = panes.get(record.tmuxTarget);
      if (pane === undefined) {
        // Not live this tick; clear the edge detector so a relaunch re-arms it.
        exhaustedNow.delete(record.name);
        continue;
      }

      const outcome: UsageTickOutcome = { bee: record.name, account: record.accountId, sampled: false, exhausted: false };

      const hit = exhaustionForAgent(record.agent, recentPane(pane));
      if (hit) {
        if (!exhaustedNow.has(record.name)) {
          exhaustedNow.add(record.name);
          outcome.exhausted = true;
          if (hit.resetHint) outcome.resetHint = hit.resetHint;
          const ts = new Date(nowMs).toISOString();
          await appendEvent({
            ts,
            kind: "exhausted",
            account: record.accountId,
            bee: record.name,
            agent: record.agent,
            ...(hit.resetHint ? { resetHint: hit.resetHint } : {}),
          });
          await ledger({
            type: "account.exhausted",
            account: record.accountId,
            session: record.name,
            agent: record.agent,
            ...(hit.resetHint ? { resetHint: hit.resetHint } : {}),
          });
        }
      } else {
        exhaustedNow.delete(record.name);
      }

      const last = lastSampleAt.get(record.name) ?? 0;
      if (nowMs - last >= sampleIntervalMs) {
        lastSampleAt.set(record.name, nowMs);
        const transcript = await readRows(record).catch(() => null);
        const totals = transcript ? transcriptTokenTotals(transcript.provider, transcript.rows) : null;
        if (totals) {
          const previous = lastTotals.get(record.name);
          if (!previous || previous.inputTokens !== totals.inputTokens || previous.outputTokens !== totals.outputTokens) {
            lastTotals.set(record.name, totals);
            await appendEvent({
              ts: new Date(nowMs).toISOString(),
              kind: "sample",
              account: record.accountId,
              bee: record.name,
              agent: record.agent,
              inputTokens: totals.inputTokens,
              outputTokens: totals.outputTokens,
            });
            outcome.sampled = true;
          }
        }
      }

      outcomes.push(outcome);
    }

    return outcomes;
  };
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
