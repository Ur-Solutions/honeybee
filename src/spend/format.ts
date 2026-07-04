// ──────────────────────────────────────────────────────────────────────────
// Presentation for the spend reports: terminal tables (reusing the repo's
// formatTable/bold/dim) plus generic JSON and CSV serializers. Zero-priced,
// unknown-rate rows are marked with a ⚠/todo note so they can never be mistaken
// for a genuine $0 — the whole point of the unknown-rate path surviving here.
//
// The CSV serializer flattens one level of nested objects (tokens.input,
// usdByTier.cacheRead, …) and quotes any field carrying a comma/quote/newline,
// so a report row round-trips to a spreadsheet without a dependency.
// ──────────────────────────────────────────────────────────────────────────

import { formatTable, bold, dim, tildify, type TableColumn } from "../format.js";
import {
  TOKEN_TIERS,
  type BlendRow,
  type DailyLedgerRow,
  type LeveragePoint,
  type RateTable,
  type Seat,
  type SessionRollup,
  type TokenCounts,
} from "./types.js";

const WARN = "⚠";

/** A right-aligned / left-aligned column, typed so `align` narrows correctly. */
const R = (header: string): TableColumn => ({ header, align: "right" });
const L = (header: string): TableColumn => ({ header });

// ── Compact value formatters ────────────────────────────────────────────────

/** USD as $X.XX, or $X.XXk once it crosses a thousand. */
export function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${(value / 1000).toFixed(2)}k`;
  return `$${value.toFixed(2)}`;
}

/** Token counts as 1.2M / 12.3k / 42. */
export function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

/** Leverage multiple as e.g. 12.3x, or an em dash when not computable. */
export function fmtLeverage(value: number | null): string {
  return value === null ? dim("—") : `${value.toFixed(1)}x`;
}

/** Coarse human duration (s/m/h/d) for a session span. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

/** Combined cache-write tokens (5m + 1h) for the compact table columns. */
function cacheWrite(tokens: TokenCounts): number {
  return tokens.cacheWrite5m + tokens.cacheWrite1h;
}

// ── Table renderers ──────────────────────────────────────────────────────────

export function renderDailyLedger(rows: DailyLedgerRow[]): string {
  if (rows.length === 0) return dim("no spend recorded");
  const columns = [L("DAY"), L("SEAT"), L("MODEL"), R("INPUT"), R("OUTPUT"), R("CACHE R"), R("CACHE W"), R("USD"), L("")];
  const body = rows.map((row) => [
    row.day,
    row.seat,
    row.model,
    fmtTokens(row.tokens.input),
    fmtTokens(row.tokens.output),
    fmtTokens(row.tokens.cacheRead),
    fmtTokens(cacheWrite(row.tokens)),
    row.rateResolved ? fmtUsd(row.usd) : dim("—"),
    row.rateResolved ? "" : `${WARN} todo`,
  ]);
  return formatTable(columns, body);
}

export function renderLeverage(rows: LeveragePoint[], opts?: { window?: number }): string {
  if (rows.length === 0) return dim("no leverage data — set monthlyUsd on a seat in seats.json");
  const emphasize = opts?.window === 30 ? "avg30" : opts?.window === 7 ? "avg7" : undefined;
  const columns = [L("DAY"), L("SEAT"), R("API$"), R("ACTUAL$"), R("LEVERAGE"), R("AVG7"), R("AVG30")];
  const body = rows.map((row) => {
    const a7 = fmtLeverage(row.avg7);
    const a30 = fmtLeverage(row.avg30);
    return [
      row.day,
      row.seat === "portfolio" ? bold(row.seat) : row.seat,
      fmtUsd(row.apiEquivUsd),
      fmtUsd(row.actualUsd),
      fmtLeverage(row.leverage),
      emphasize === "avg7" ? bold(a7) : a7,
      emphasize === "avg30" ? bold(a30) : a30,
    ];
  });
  return formatTable(columns, body);
}

/** The busiest model in a session (id + how many others), for the table cell. */
function topModel(models: Record<string, number>): string {
  const entries = Object.entries(models).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return dim("—");
  const first = entries[0]![0];
  return entries.length > 1 ? `${first} +${entries.length - 1}` : first;
}

export function renderSessions(rows: SessionRollup[]): string {
  if (rows.length === 0) return dim("no sessions recorded");
  const columns = [L("SESSION"), L("HARNESS"), L("SEAT"), R("API$"), R("ORCH$"), R("SUB$"), R("DUR"), L("MODELS"), L("")];
  const body = rows.map((row) => [
    row.sessionId.length > 18 ? `${row.sessionId.slice(0, 17)}…` : row.sessionId,
    row.harness,
    row.seat,
    fmtUsd(row.apiEquivUsd),
    fmtUsd(row.orchestratorUsd),
    fmtUsd(row.subagentUsd),
    fmtDuration(row.durationMs),
    topModel(row.models),
    row.hasUnknownRate ? `${WARN} todo` : "",
  ]);
  return formatTable(columns, body);
}

export function renderBlend(rows: BlendRow[]): string {
  if (rows.length === 0) return dim("no spend recorded");
  const columns = [L("PERIOD"), L("MODEL"), R("INPUT"), R("OUTPUT"), R("CACHE R"), R("CACHE W"), R("USD")];
  const body = rows.map((row) => {
    const usd = TOKEN_TIERS.reduce((sum, tier) => sum + row.usdByTier[tier], 0);
    return [
      row.period,
      row.model,
      fmtTokens(row.tokensByTier.input),
      fmtTokens(row.tokensByTier.output),
      fmtTokens(row.tokensByTier.cacheRead),
      fmtTokens(cacheWrite(row.tokensByTier)),
      fmtUsd(usd),
    ];
  });
  return formatTable(columns, body);
}

/** A per-MTok price cell: `$N`, or a dim `null` for an explicit unknown. */
function priceCell(value: number | null): string {
  return value === null ? dim("null") : `$${value}`;
}

export function renderRates(table: RateTable): string {
  const columns = [L("PATTERN"), L("PROVIDER"), L("EFFECTIVE"), R("IN"), R("OUT"), R("CACHE R"), R("CW5m"), R("CW1h"), L("NOTE")];
  const body: string[][] = [];
  for (const rule of table.rules) {
    const provider = rule.provider ?? "";
    if (rule.todo || rule.versions.length === 0) {
      body.push([rule.modelPattern, provider, dim("todo"), dim("—"), dim("—"), dim("—"), dim("—"), dim("—"), `${WARN} ${rule.note ?? "unpriced"}`]);
      continue;
    }
    for (const version of rule.versions) {
      body.push([
        rule.modelPattern,
        provider,
        version.effectiveFrom,
        priceCell(version.inputPerMTok),
        priceCell(version.outputPerMTok),
        priceCell(version.cacheReadPerMTok),
        priceCell(version.cacheWrite5mPerMTok),
        priceCell(version.cacheWrite1hPerMTok),
        rule.note ?? "",
      ]);
    }
  }
  return formatTable(columns, body);
}

export function renderSeats(seats: Seat[]): string {
  if (seats.length === 0) return dim("no seats discovered");
  const columns = [L("SEAT"), L("HARNESS"), L("PROVIDER"), L("PLAN"), R("MONTHLY$"), L(""), L("CONFIG DIR")];
  const body = seats.map((seat) => {
    const priced = typeof seat.monthlyUsd === "number";
    return [
      seat.id,
      seat.harness,
      seat.provider ?? dim("—"),
      seat.plan ?? dim("—"),
      priced ? fmtUsd(seat.monthlyUsd!) : dim("—"),
      priced ? "" : `${WARN} set monthlyUsd`,
      tildify(seat.configDir),
    ];
  });
  return formatTable(columns, body);
}

// ── Machine-readable serializers ─────────────────────────────────────────────

/** Pretty JSON for any report row array. */
export function toJson(rows: unknown): string {
  return JSON.stringify(rows, null, 2);
}

/** Flatten one level of nested plain objects into `key.subkey` string cells. */
function flattenRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) {
      out[key] = "";
    } else if (Array.isArray(value)) {
      out[key] = JSON.stringify(value);
    } else if (typeof value === "object") {
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        out[`${key}.${subKey}`] = subValue === null || subValue === undefined ? "" : String(subValue);
      }
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

/** RFC-ish quoting: wrap in quotes and double internal quotes when needed. */
function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * CSV for any report row array. Columns are the union of every flattened key in
 * first-seen order, so heterogeneous rows still align; missing cells are empty.
 */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  const flats = rows.map(flattenRow);
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const flat of flats) {
    for (const key of Object.keys(flat)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const lines = [columns.map(csvEscape).join(",")];
  for (const flat of flats) lines.push(columns.map((column) => csvEscape(flat[column] ?? "")).join(","));
  return lines.join("\n");
}
