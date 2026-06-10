// Rolling compaction — builds the per-iteration prompt and folds a completed
// iteration's seal forward into the loop's rolling memory.
//
// The rolling summary is sourced FROM A SEAL ARTIFACT: the loop bee's own seal
// in `self` mode, a dedicated summarizer bee's seal in `bee` mode. Either way
// the same artifacts are produced:
//   progress.md  — OVERWRITTEN with the (already fold-forward) seal summary.
//   history.log  — APPEND-ONLY, one line per iteration, NEVER rewritten.
//   history.md   — RE-DERIVED from the raw history.log (telephone-game guard).

import { appendFile, readFile } from "node:fs/promises";
import { atomicWriteFile } from "../fsx.js";
import type { SealRecord } from "../seal.js";
import type { LoopMemory } from "./state.js";
import { ensureLoopDir, loopHistoryLogPath, loopHistoryMdPath, loopProgressPath } from "./state.js";

/** Above this many raw history.log lines, history.md elides the middle. */
export const HISTORY_DIGEST_THRESHOLD = 20;

/**
 * Per-section byte budget for the rolling context injected into each prompt
 * (PRD §10: "Injection size is budgeted"). progress.md and history.md are each
 * truncated to this budget, keeping the MOST RECENT content (tail) behind an
 * elision marker so an unbounded artifact can never grow the prompt unboundedly.
 */
export const INJECTION_BUDGET_BYTES = 16_384;

/** Marker prepended when injected context was truncated to fit the budget. */
const ELISION_MARKER = "(… earlier content elided to fit the injection budget …)";

/** Soft cap stated in the fold-forward instruction so progress.md stays bounded. */
export const PROGRESS_SUMMARY_MAX_CHARS = 8_000;

/** Standing instruction appended so every iteration has a defined seal boundary. */
const SEAL_INSTRUCTION =
  "When you have finished this iteration, record a seal (status + a one-line summary of what you did this pass) so the loop can detect the boundary.";

/**
 * Enforce the injection byte budget on a carried-forward artifact: when the
 * text exceeds maxBytes, keep the most recent content (the tail) and prepend
 * an elision marker. Truncation drops the partial first line of the kept tail
 * so the output starts on a clean line boundary.
 */
export function truncateForInjection(text: string, maxBytes: number = INJECTION_BUDGET_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  const tail = buf.subarray(buf.length - Math.max(0, maxBytes)).toString("utf8");
  const firstNewline = tail.indexOf("\n");
  const clean = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
  return `${ELISION_MARKER}\n${clean}`;
}

export type BuildIterationPromptArgs = {
  task: string;
  mode: LoopMemory;
  progress: string;
  history: string;
  loopId: string;
  iteration: number;
};

/**
 * Build the prompt injected at the start of an iteration. For rolling mode the
 * prior progress.md + history.md are PREPENDED and a fold-forward closing
 * instruction is APPENDED telling the bee to INTEGRATE this pass into the
 * summary it was handed (NOT to reset/describe only this iteration). For
 * ralph/persistent the task is sent verbatim plus the standing seal instruction.
 */
export function buildIterationPrompt(args: BuildIterationPromptArgs): string {
  if (args.mode === "rolling") {
    const progress = truncateForInjection(args.progress);
    const history = truncateForInjection(args.history);
    const sections: string[] = [];
    sections.push(`# Loop iteration ${args.iteration} (loop ${args.loopId})`);
    sections.push(
      "You are a fresh bee continuing a long-running loop. The carried-forward context below is hive-maintained; treat it as authoritative state from prior iterations.",
    );
    sections.push(`## Carried-forward progress (progress.md)\n${progress.trim() || "(none yet — this is the first iteration)"}`);
    sections.push(`## History digest (history.md)\n${history.trim() || "(no prior iterations)"}`);
    sections.push(`## Task\n${args.task}`);
    sections.push(
      [
        "## Closing instruction (fold-forward summary)",
        "When you finish, your seal's `summary` MUST be an INTEGRATED, fold-forward progress report: take the carried-forward progress above and integrate what you just did into it, producing the new complete state — do NOT reset it or describe only this single iteration. The summary you write replaces progress.md for the next iteration, so it must stand on its own.",
        `Keep the integrated summary under roughly ${PROGRESS_SUMMARY_MAX_CHARS} characters — prefer dropping the oldest, least relevant detail over growing it without bound.`,
        SEAL_INSTRUCTION,
      ].join("\n"),
    );
    return sections.join("\n\n");
  }

  // ralph / persistent: send the task plus the standing seal instruction.
  return `${args.task}\n\n${SEAL_INSTRUCTION}`;
}

/**
 * Fold a completed iteration's seal into rolling memory. The seal summary is
 * already fold-forward (the bee was instructed to integrate), so progress.md is
 * OVERWRITTEN with it (plus any structured fields), history.log gets exactly one
 * appended line, and history.md is re-derived from the raw log.
 */
export async function foldForward(loopId: string, iteration: number, seal: SealRecord): Promise<void> {
  await ensureLoopDir(loopId);

  // progress.md := the fold-forward summary + structured fields (overwrite).
  await atomicWriteFile(loopProgressPath(loopId), renderProgress(seal), { mode: 0o600 });

  // history.log += ONE line (append-only, never rewritten).
  const firstLine = firstNonEmptyLine(seal.summary);
  const stamp = new Date().toISOString();
  const line = `[${stamp}] iter ${iteration} status=${seal.status} — ${firstLine}\n`;
  await appendFile(loopHistoryLogPath(loopId), line, { mode: 0o600 });

  // history.md := re-derived from the RAW log (telephone-game guard).
  await rederiveHistory(loopId);
}

/**
 * Re-derive history.md from the append-only history.log. v1 mechanical digest:
 * if the log has <= HISTORY_DIGEST_THRESHOLD lines, emit it verbatim; otherwise
 * emit a header noting how many earlier iterations were elided plus the last
 * THRESHOLD lines. Deterministic and testable; an LLM digest is future work.
 */
export async function rederiveHistory(loopId: string): Promise<void> {
  const raw = await readFile(loopHistoryLogPath(loopId), "utf8").catch(() => "");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let digest: string;
  if (lines.length <= HISTORY_DIGEST_THRESHOLD) {
    digest = lines.join("\n");
  } else {
    const elided = lines.length - HISTORY_DIGEST_THRESHOLD;
    const tail = lines.slice(-HISTORY_DIGEST_THRESHOLD);
    digest = [`(${elided} earlier iterations elided)`, ...tail].join("\n");
  }
  await atomicWriteFile(loopHistoryMdPath(loopId), `${digest}\n`, { mode: 0o600 });
}

function renderProgress(seal: SealRecord): string {
  const parts: string[] = [seal.summary.trim()];
  if (seal.filesChanged && seal.filesChanged.length > 0) {
    parts.push(`\n## Files changed\n${seal.filesChanged.map((f) => `- ${f}`).join("\n")}`);
  }
  if (seal.nextActions && seal.nextActions.length > 0) {
    parts.push(`\n## Next actions\n${seal.nextActions.map((a) => `- ${a}`).join("\n")}`);
  }
  if (seal.risks && seal.risks.length > 0) {
    parts.push(`\n## Risks\n${seal.risks.map((r) => `- ${r}`).join("\n")}`);
  }
  return `${parts.join("\n")}\n`;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}
