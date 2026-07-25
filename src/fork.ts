// fork-and-pane Phase C — the seed-mode picker.
//
// pickForkSeed is the PURE, testable core of `hive fork`: it takes only data
// (no tmux, no store, no I/O) and returns the chosen seeding mode plus the
// resume-args (for native resume) or the brief text (for seal/log seeding).
// Keeping it here — out of cli.ts — gives the unit test a clean import that
// doesn't drag in the substrate, and isolates the three riskiest decisions
// (resume eligibility, cross-harness downgrade, refuse conditions) in one place
// so the §7.1 policy can't silently regress.

import { resumeArgs } from "./swap.js";
import type { SealRecord } from "./seal.js";
import type { SessionRecord } from "./store.js";

export type SeedMode = "resume" | "seal" | "summary" | "log" | "none";

export type ForkSeedDecision =
  | { mode: "resume"; resumeArgs: string[]; checkpoint: string }
  | { mode: "seal"; brief: string; checkpoint: string }
  | { mode: "summary"; brief: string; checkpoint: string }
  | { mode: "log"; brief: string; checkpoint: string }
  | { mode: "none"; checkpoint: "none" }
  | { mode: "refuse"; reason: string };

export type ForkSeedInput = {
  /** The parent (source) bee's record. */
  source: SessionRecord;
  /** Resolved checkpoint seal (latest or seal:<ISO>), or null when none. */
  seal: SealRecord | null;
  /** The --seed value; undefined means "default ladder". */
  requestedSeed?: SeedMode;
  /** --read-log present. */
  readLog: boolean;
  /** Canonical kind of the FORK's agent (claude/codex/opencode/...). */
  targetTool: string;
  /** Canonical kind of the SOURCE's agent. */
  sourceTool: string;
  /** Source bee's display name (used in the brief text). */
  forkName: string;
  /**
   * Handoff instruction (`hive handoff -p …`). Only meaningful with
   * `--seed summary`: the new bee's brief becomes summary + instruction
   * instead of the fork-style "continue from here". May be empty — a pure
   * compaction restart seeds the summary alone (epic, decided 2026-07-24).
   */
  handoffInstruction?: string;
};

/**
 * Decide how to seed a fork. Mirrors fork-and-pane §7.1's layered ladder:
 *
 *   1. --seed none           → boot cold, no seeding.
 *   1b. --seed summary       → handoff brief from the seal-as-summary artifact
 *                              plus an optional instruction (explicit only —
 *                              never part of the default ladder).
 *   2. --read-log (or --seed log) → log brief (overrides everything else).
 *   3. resume                → eligible iff (seed=resume|default) AND same
 *                              harness AND a known providerSessionId. Explicit
 *                              cross-harness --seed resume REFUSES (loud, never
 *                              a silent downgrade).
 *   4. seal                  → brief from the latest/selected seal.
 *   5. log                   → log brief from source.transcriptPath, else REFUSE.
 */
export function pickForkSeed(input: ForkSeedInput): ForkSeedDecision {
  const { source, seal, requestedSeed, readLog, targetTool, sourceTool, forkName } = input;
  const crossHarness = targetTool !== sourceTool;

  // 1. Explicit cold boot.
  if (requestedSeed === "none") return { mode: "none", checkpoint: "none" };

  // 1b. Explicit summary seed (the handoff engine, session-fork-and-handoff
  //     epic): the seal IS the summary artifact — a bee self-seals (or the
  //     latest seal is reused) and the new bee starts fresh from that summary
  //     plus an optional operator instruction. No thread is carried.
  if (requestedSeed === "summary") {
    if (!seal) {
      return { mode: "refuse", reason: `--seed summary needs a seal as the summary artifact; ${forkName} has none — run hive handoff (self-seal) or hive seal first` };
    }
    return {
      mode: "summary",
      brief: handoffBrief(forkName, seal, input.handoffInstruction),
      checkpoint: `summary:${seal.sealedAt}`,
    };
  }

  // 2. --read-log (or --seed log) overrides the rest.
  if (readLog || requestedSeed === "log") {
    if (source.transcriptPath) return logDecision(forkName, source.transcriptPath);
    return { mode: "refuse", reason: `--read-log needs a transcriptPath; ${forkName} has none` };
  }

  // 3. Native resume. Same-harness only; cross-harness explicit resume refuses.
  const wantsResume = requestedSeed === "resume" || requestedSeed === undefined;
  if (requestedSeed === "resume" && crossHarness) {
    return {
      mode: "refuse",
      reason: `native resume is same-harness only; ${sourceTool}→${targetTool} must seed from a seal or log`,
    };
  }
  if (wantsResume && !crossHarness && source.providerSessionId) {
    return {
      mode: "resume",
      resumeArgs: resumeArgs(targetTool, source.providerSessionId),
      checkpoint: `resume:${source.providerSessionId}`,
    };
  }

  // 4. Explicit --seed seal with no seal → refuse with a clear message.
  if (requestedSeed === "seal" && !seal) {
    return { mode: "refuse", reason: `--seed seal but ${forkName} has no seal to seed from` };
  }

  // 5. Seal seeding (latest/selected).
  if (seal) {
    return { mode: "seal", brief: sealBrief(forkName, seal), checkpoint: `seal:${seal.sealedAt}` };
  }

  // 6. No seal in the default ladder → fall through to log.
  if (source.transcriptPath) return logDecision(forkName, source.transcriptPath);

  // 7. Nothing to seed from. The IMPLICIT default (`hive fork <bee>` with no
  //    --seed) forks COLD — a fresh sibling with the same agent/cwd/config — so
  //    the bare chord always yields a bee even on a never-prompted source. An
  //    EXPLICIT --seed that couldn't be satisfied (e.g. `--seed resume` with no
  //    session) still refuses, since the operator asked for a specific seed.
  if (requestedSeed === undefined) return { mode: "none", checkpoint: "none" };
  return { mode: "refuse", reason: `no resume session, no seal, no transcript to seed from for ${forkName}` };
}

function logDecision(forkName: string, transcriptPath: string): ForkSeedDecision {
  return {
    mode: "log",
    brief: `You are a fork of ${forkName}. Read the log at ${transcriptPath} and continue.`,
    checkpoint: `log:${transcriptPath}`,
  };
}

function sealBrief(forkName: string, seal: SealRecord): string {
  const files = seal.filesChanged && seal.filesChanged.length > 0 ? seal.filesChanged.join(", ") : "none recorded";
  const next = seal.nextActions && seal.nextActions.length > 0 ? seal.nextActions.join("; ") : "none recorded";
  return `You are a fork of ${forkName}. State: ${seal.summary}; files changed: ${files}; next: ${next}. Continue from here.`;
}

/**
 * The handoff brief (`--seed summary`). Distinct from sealBrief: a handoff is
 * a fresh start from a compacted summary, and the operator's instruction — not
 * "continue from here" — sets the direction when present.
 */
function handoffBrief(forkName: string, seal: SealRecord, instruction: string | undefined): string {
  const parts = [`You are taking over from ${forkName} via handoff. Summary of prior work: ${seal.summary}`];
  if (seal.filesChanged && seal.filesChanged.length > 0) parts.push(`Files changed: ${seal.filesChanged.join(", ")}.`);
  if (seal.risks && seal.risks.length > 0) parts.push(`Known risks: ${seal.risks.join("; ")}.`);
  if (seal.nextActions && seal.nextActions.length > 0) parts.push(`Planned next actions: ${seal.nextActions.join("; ")}.`);
  const trimmed = instruction?.trim();
  parts.push(trimmed && trimmed.length > 0 ? `Your instruction: ${trimmed}` : "Continue the work from this summary.");
  return parts.join(" ");
}

/**
 * Per-harness model flag, so the chosen `--model` is baked into the frozen
 * spawn command (keeps the persisted command honest, §7.1). The model is ALSO
 * stored first-class on the record (independent of the command string).
 */
export function modelArgsFor(tool: string, model: string | undefined): string[] {
  if (!model) return [];
  switch (tool) {
    case "claude":
      return ["--model", model];
    case "codex":
      return ["-m", model];
    case "opencode":
      return ["--model", model];
    default:
      return ["--model", model]; // best-effort for unknown tools
  }
}
