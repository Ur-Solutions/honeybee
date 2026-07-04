// ──────────────────────────────────────────────────────────────────────────
// Incremental ingestion: walk each seat's transcripts, extract SpendEvents, and
// append the new ones to the append-only ledger (events.jsonl). Idempotent by
// construction — event ids are reproducible, so re-ingesting the same (or a
// grown) file only appends genuinely new events.
//
// Incrementality strategy (documented on purpose): when a file's mtime is
// unchanged we skip it entirely (fast path). When it changed we re-extract the
// WHOLE file and drop events whose id is already known. We deliberately do NOT
// slice from a stored line offset: codex reports cumulative token totals, so
// correct per-turn deltas require the full row history — slicing would corrupt
// them. Re-extract + id-dedup is simple and correct for both harnesses.
//
// Writes are serialized with withFileLock and land at mode 0o600, matching the
// house idiom in src/usage.ts.
// ──────────────────────────────────────────────────────────────────────────

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "../lock.js";
import { listSeatTranscripts } from "./discover.js";
import { extractEvents, type RowWithOffset } from "./extract.js";
import { eventsPath, ingestStatePath } from "./paths.js";
import type { IngestResult, IngestState, Seat, SpendEvent } from "./types.js";
import type { TranscriptRow } from "../transcripts/types.js";

export type IngestOptions = {
  /** Seats to ingest. PASSED IN by the caller (seat discovery lives elsewhere). */
  seats: Seat[];
  /** ISO timestamp/date; events strictly before this are ignored. */
  since?: string;
  /** Re-read every file regardless of the mtime fast-path (still id-deduped). */
  full?: boolean;
  /** Predicate: does this model id have a resolved rate? Used to compute unknownModels. */
  knownModel?: (id: string) => boolean;
  /** Override the ledger path (tests point this at a temp file). */
  eventsFile?: string;
  /** Override the ingest-state path (tests point this at a temp file). */
  stateFile?: string;
};

async function readState(stateFile: string): Promise<IngestState> {
  try {
    const raw = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<IngestState>;
    return { files: parsed.files ?? {}, lastRunIso: parsed.lastRunIso };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: {} };
    // A corrupt state file must not wedge ingestion; start fresh (dedup against
    // the ledger still prevents double counting).
    return { files: {} };
  }
}

async function writeState(stateFile: string, state: IngestState): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  await withFileLock(`${stateFile}.lock`, async () => {
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  });
}

/** The set of event ids already present in the ledger (dedup seed). */
export async function readEventIds(eventsFile: string = eventsPath()): Promise<Set<string>> {
  const ids = new Set<string>();
  let raw: string;
  try {
    raw = await readFile(eventsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ids;
    throw error;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { id?: unknown };
      if (typeof parsed.id === "string") ids.add(parsed.id);
    } catch {
      // torn final line
    }
  }
  return ids;
}

/** Parse a JSONL file into rows paired with their 0-based line offset. */
function parseRowsWithOffsets(raw: string): { rows: RowWithOffset[]; totalLines: number } {
  const lines = raw.split("\n");
  // A trailing newline yields a final empty element; do not count it as a line.
  const totalLines = raw.endsWith("\n") ? lines.length - 1 : lines.length;
  const rows: RowWithOffset[] = [];
  for (let offset = 0; offset < lines.length; offset += 1) {
    const trimmed = lines[offset]!.trim();
    if (!trimmed) continue; // blank / torn line
    try {
      rows.push({ row: JSON.parse(trimmed) as TranscriptRow, offset });
    } catch {
      // skip a torn/partial line rather than aborting the whole file
    }
  }
  return { rows, totalLines };
}

function beforeSince(ts: string, sinceMs: number | null): boolean {
  if (sinceMs === null) return false;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return false; // undatable events are never filtered out
  return ms < sinceMs;
}

/**
 * Ingest all seats. Returns counts plus the set of models seen that lack a
 * resolved rate (loud-reporting fuel). Appends only new events; safe to re-run.
 */
export async function ingest(opts: IngestOptions): Promise<IngestResult> {
  const eventsFile = opts.eventsFile ?? eventsPath();
  const stateFile = opts.stateFile ?? ingestStatePath();
  const sinceMs = opts.since ? (Number.isFinite(Date.parse(opts.since)) ? Date.parse(opts.since) : null) : null;

  const state = await readState(stateFile);
  const known = await readEventIds(eventsFile);

  const toAppend: SpendEvent[] = [];
  const distinctModels = new Set<string>();
  let filesScanned = 0;
  let duplicatesSkipped = 0;

  for (const seat of opts.seats) {
    const files = await listSeatTranscripts(seat);
    for (const file of files) {
      filesScanned += 1;
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(file)).mtimeMs;
      } catch {
        continue; // file vanished between listing and stat
      }

      const prior = state.files[file];
      if (!opts.full && prior && prior.mtimeMs === mtimeMs) continue; // unchanged → skip read

      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const { rows, totalLines } = parseRowsWithOffsets(raw);
      const events = extractEvents(seat.harness, rows, file, seat);

      for (const event of events) {
        distinctModels.add(event.model);
        if (beforeSince(event.ts, sinceMs)) continue;
        if (known.has(event.id)) {
          duplicatesSkipped += 1;
          continue;
        }
        known.add(event.id);
        toAppend.push(event);
      }
      state.files[file] = { mtimeMs, lines: totalLines };
    }
  }

  if (toAppend.length > 0) {
    await mkdir(dirname(eventsFile), { recursive: true });
    const payload = `${toAppend.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await withFileLock(`${eventsFile}.lock`, async () => {
      await writeFile(eventsFile, payload, { flag: "a", mode: 0o600 });
    });
  }

  state.lastRunIso = new Date().toISOString();
  await writeState(stateFile, state);

  const unknownModels = opts.knownModel
    ? [...distinctModels].filter((model) => !opts.knownModel!(model))
    : [...distinctModels];

  return {
    filesScanned,
    eventsAppended: toAppend.length,
    duplicatesSkipped,
    unknownModels,
    // Seat discovery/scaffolding is owned by seats.ts; seats are passed in here.
    newSeats: [],
  };
}
