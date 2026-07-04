// ──────────────────────────────────────────────────────────────────────────
// Transcript-file enumeration for a seat. A seat owns one harness config dir
// (Seat.configDir), and its transcripts live in a fixed layout under it:
//   - claude → <configDir>/projects/<projectKey>/<sessionId>.jsonl (one level)
//   - codex  → <configDir>/sessions/YYYY/MM/DD/rollout-*.jsonl (recursive)
// Reads are directory listings only; the transcript contents are never touched
// here. Missing directories yield [] rather than throwing.
// ──────────────────────────────────────────────────────────────────────────

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Harness, Seat } from "./types.js";

/** The harness a seat belongs to (thin helper for symmetry with callers). */
export function harnessForSeat(seat: Seat): Harness {
  return seat.harness;
}

async function readdirSafe(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw error;
  }
}

/** All *.jsonl files under `dir`, recursing into subdirectories. */
async function walkJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdirSafe(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkJsonl(full)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

/** claude keeps one nested level: projects/<key>/*.jsonl (no deep recursion). */
async function listClaudeTranscripts(configDir: string): Promise<string[]> {
  const projectsDir = join(configDir, "projects");
  const out: string[] = [];
  for (const project of await readdirSafe(projectsDir)) {
    if (!project.isDirectory()) continue;
    const projectDir = join(projectsDir, project.name);
    for (const file of await readdirSafe(projectDir)) {
      if (file.isFile() && file.name.endsWith(".jsonl")) out.push(join(projectDir, file.name));
    }
  }
  return out;
}

/**
 * Absolute paths of every transcript file owned by `seat`. Order is not
 * guaranteed; ingest sorts/dedups by event id, so it does not matter.
 */
export async function listSeatTranscripts(seat: Seat): Promise<string[]> {
  if (seat.harness === "claude") return listClaudeTranscripts(seat.configDir);
  if (seat.harness === "codex") return walkJsonl(join(seat.configDir, "sessions"));
  // grok/opencode have no priced extractor yet → nothing to enumerate.
  return [];
}
