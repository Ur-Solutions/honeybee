// ──────────────────────────────────────────────────────────────────────────
// Read side of the append-only spend ledger (events.jsonl, one SpendEvent per
// line). The reporting/pricing layer consumes readAllEvents(); ingest.ts uses
// it to seed the dedup set. Parsing is tolerant: a torn final line (a crashed
// or in-flight append) is skipped rather than throwing, and duplicate ids are
// collapsed (first occurrence wins) so a partially double-written ledger still
// reads clean.
// ──────────────────────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import { eventsPath } from "./paths.js";
import type { SpendEvent } from "./types.js";

async function readLedgerRaw(eventsFile: string): Promise<string | null> {
  try {
    return await readFile(eventsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isSpendEvent(value: unknown): value is SpendEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<SpendEvent>;
  return typeof event.id === "string" && typeof event.model === "string" && !!event.tokens;
}

/**
 * Every event in the ledger, deduplicated by id (first wins). The torn final
 * line is dropped. Returns [] when the ledger does not exist yet.
 */
export async function readAllEvents(eventsFile: string = eventsPath()): Promise<SpendEvent[]> {
  const raw = await readLedgerRaw(eventsFile);
  if (raw === null) return [];
  const seen = new Set<string>();
  const events: SpendEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // torn/partial line
    }
    if (!isSpendEvent(parsed)) continue;
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    events.push(parsed);
  }
  return events;
}
