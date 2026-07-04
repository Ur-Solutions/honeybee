// ──────────────────────────────────────────────────────────────────────────
// On-disk locations for the spend subsystem. All state lives under
// ~/.hive/spend/ (storeRoot() is ~/.hive). Source transcripts are read-only and
// never referenced here — only our own derived ledger + config files.
// ──────────────────────────────────────────────────────────────────────────

import { join } from "node:path";
import { storeRoot } from "../fsx.js";

/** ~/.hive/spend — the subsystem's private state dir. */
export function spendDir(): string {
  return join(storeRoot(), "spend");
}

/** Append-only priced-event ledger (one JSON SpendEvent per line). */
export function eventsPath(): string {
  return join(spendDir(), "events.jsonl");
}

/** Versioned, human-editable pricing table (RateTable as JSON). */
export function ratesPath(): string {
  return join(spendDir(), "rates.json");
}

/** Seat scaffold (SeatsFile as JSON): config dir -> provider/plan/monthly cost. */
export function seatsPath(): string {
  return join(spendDir(), "seats.json");
}

/** Incremental ingest bookmark (IngestState as JSON). */
export function ingestStatePath(): string {
  return join(spendDir(), "ingest-state.json");
}
