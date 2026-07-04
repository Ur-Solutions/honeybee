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

import { formatTable, bold, dim, cyan, green, yellow, magenta, tildify, type TableColumn } from "../format.js";
import {
  TOKEN_TIERS,
  type BlendRow,
  type DailyLedgerRow,
  type LeveragePoint,
  type RateTable,
  type Seat,
  type SessionDetail,
  type SessionRollup,
  type TokenCounts,
  type UsageSummary,
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

/** Token counts as 4.4G / 1.2M / 12.3k / 42. */
export function fmtTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G`;
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

// ── Usage dashboard (bars + sparkline) ───────────────────────────────────────

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const SPARK = "▁▂▃▄▅▆▇█";

/** A proportional bar of `width` cells for a 0..1 fraction: painted fill + dim track. */
function bar(fraction: number, width: number, paint: (s: string) => string): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const eighths = Math.round(f * width * 8);
  const full = Math.min(Math.floor(eighths / 8), width);
  const rem = eighths % 8;
  let fill = "█".repeat(full);
  if (rem > 0 && full < width) fill += EIGHTHS[rem];
  const used = [...fill].length;
  return paint(fill) + dim("·".repeat(Math.max(0, width - used)));
}

/** A one-line sparkline over a numeric series, scaled to its own peak. */
function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 0);
  if (max <= 0) return dim(SPARK[0]!.repeat(values.length));
  return values.map((v) => (v <= 0 ? dim(SPARK[0]!) : SPARK[Math.min(7, 1 + Math.round((v / max) * 6))]!)).join("");
}

/** Truncate-with-ellipsis then pad to a fixed visible width. */
function padName(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

/**
 * A rich single-period print: a title, one painted bar per model (scaled so the
 * top spender fills the bar), a total, the API-equivalent token-tier blend as a
 * stacked bar with a legend, and — for week/month periods — a daily sparkline.
 */
export function renderUsage(summary: UsageSummary): string {
  const lines: string[] = [];
  const scope = summary.seat === "all" ? "all seats" : summary.seat;
  const toDate = summary.partial ? " · to date" : "";
  lines.push("");
  lines.push(`  ${bold("Spend")} ${dim("·")} ${bold(summary.period)} ${dim(`· ${summary.granularity}${toDate} · ${scope}`)}`);
  lines.push("");

  if (summary.models.length === 0) {
    lines.push(dim("  no spend recorded for this period"));
    lines.push("");
    return lines.join("\n");
  }

  const BAR_W = 22;
  const maxUsd = summary.models[0]!.usd || 1;
  const nameW = Math.min(26, Math.max(5, ...summary.models.map((m) => m.model.length)));
  const usdW = Math.max(...summary.models.map((m) => fmtUsd(m.usd).length), 5);
  for (const m of summary.models) {
    const usd = m.rateResolved ? fmtUsd(m.usd).padStart(usdW) : "—".padStart(usdW);
    const frac = m.rateResolved ? m.usd / maxUsd : 0;
    const share = `${(m.share * 100).toFixed(0)}%`.padStart(4);
    const flag = m.rateResolved ? "" : ` ${dim(`${WARN} todo`)}`;
    lines.push(`  ${padName(m.model, nameW)}  ${m.rateResolved ? usd : dim(usd)}  ${bar(frac, BAR_W, cyan)} ${dim(share)}${flag}`);
  }
  lines.push(`  ${" ".repeat(nameW)}  ${dim("─".repeat(usdW))}`);
  lines.push(`  ${bold(padName("TOTAL", nameW))}  ${bold(fmtUsd(summary.totalUsd).padStart(usdW))}  ${dim(`${fmtTokens(summary.grandTokens)} tokens`)}`);

  // Token-tier blend as a stacked, colored bar with a legend.
  const tiers = [
    { label: "fresh in", usd: summary.tierUsd.input, paint: cyan },
    { label: "output", usd: summary.tierUsd.output, paint: green },
    { label: "cache read", usd: summary.tierUsd.cacheRead, paint: yellow },
    { label: "cache write", usd: summary.tierUsd.cacheWrite5m + summary.tierUsd.cacheWrite1h, paint: magenta },
  ];
  const blendTotal = tiers.reduce((sum, t) => sum + t.usd, 0);
  if (blendTotal > 0) {
    const W = 40;
    const cells = tiers.map((t) => Math.floor((t.usd / blendTotal) * W));
    const order = tiers.map((_, i) => i).sort((a, b) => tiers[b]!.usd - tiers[a]!.usd);
    let used = cells.reduce((a, b) => a + b, 0);
    for (let k = 0; used < W; k += 1, used += 1) cells[order[k % order.length]!] += 1;
    const stacked = tiers.map((t, i) => t.paint("█".repeat(cells[i]!))).join("");
    const legend = tiers.map((t) => `${t.paint("█")} ${t.label} ${dim(`${((t.usd / blendTotal) * 100).toFixed(0)}%`)}`).join("   ");
    lines.push("");
    lines.push(`  ${dim("Blend (API-equiv $)")}`);
    lines.push(`  ${stacked}`);
    lines.push(`  ${legend}`);
  }

  // Daily sparkline (only meaningful across a multi-day period).
  if (summary.daily.length > 1) {
    const peak = summary.daily.reduce((best, d) => (d.usd > best.usd ? d : best), summary.daily[0]!);
    lines.push("");
    lines.push(`  ${dim("Daily")}  ${sparkline(summary.daily.map((d) => d.usd))}  ${dim(`${summary.daily[0]!.day} → ${summary.daily[summary.daily.length - 1]!.day}`)}`);
    if (peak.usd > 0) lines.push(`  ${dim(`peak ${peak.day} · ${fmtUsd(peak.usd)}`)}`);
  }

  if (summary.hasUnknownRate) {
    lines.push("");
    lines.push(dim(`  ${WARN} some models are unpriced — totals are a lower bound (hive spend rates --check)`));
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * A single-session efficiency drill-down: cost, model mix, token/caching
 * stats, and a context-per-turn sparkline that shows whether the carried
 * context ballooned over the session (the main cost lever for long orchestrators).
 */
export function renderSessionDetail(d: SessionDetail): string {
  const lines: string[] = [];
  const when = d.startTs
    ? `${d.startTs.slice(0, 16).replace("T", " ")} → ${d.endTs.slice(5, 16).replace("T", " ")}`
    : "";
  lines.push("");
  lines.push(`  ${bold("Session")} ${dim("·")} ${d.sessionId}`);
  lines.push(`  ${dim(`${d.turns} turns · ${fmtDuration(d.durationMs)} · ${when}`)}`);
  lines.push("");
  lines.push(`  ${bold("API-equivalent")}  ${bold(fmtUsd(d.totalUsd))}${d.hasUnknownRate ? `  ${dim(`${WARN} incl. unpriced`)}` : ""}`);
  for (const m of d.models) {
    lines.push(`    ${padName(m.model, 26)} ${dim(`${m.turns} turns`.padStart(11))}  ${fmtUsd(m.usd)}`);
  }
  lines.push("");
  lines.push(
    `  ${dim("tokens")}   in ${fmtTokens(d.totalTokens.input)} · out ${fmtTokens(d.totalTokens.output)} · cacheR ${fmtTokens(d.totalTokens.cacheRead)} · cacheW ${fmtTokens(d.totalTokens.cacheWrite5m + d.totalTokens.cacheWrite1h)}`,
  );
  const thrash = d.cacheWriteOverRead < 0.1 ? "healthy — no prefix thrashing" : "elevated — prefix may be churning";
  lines.push(`  ${dim("caching")}  cache-write/read ${(d.cacheWriteOverRead * 100).toFixed(1)}%  ${dim(`(${thrash})`)}`);
  lines.push(
    `  ${dim("context")}  cache-read/output ${d.cacheReadOverOutput.toFixed(0)}x · avg out/turn ${fmtTokens(Math.round(d.avgOutputPerTurn))} · peak ctx ${fmtTokens(d.peakContext)}`,
  );

  if (d.contextDeciles.length > 0) {
    const peak = Math.max(...d.contextDeciles);
    const first = d.contextDeciles[0]!;
    const last = d.contextDeciles[d.contextDeciles.length - 1]!;
    const stillHigh = peak > 0 && last > 0.7 * peak;
    lines.push("");
    lines.push(`  ${dim("context/turn over the session")}  ${sparkline(d.contextDeciles)}  ${dim(`peak ~${fmtTokens(Math.round(peak))}/turn`)}`);
    lines.push(
      `  ${dim(`start ~${fmtTokens(Math.round(first))} → end ~${fmtTokens(Math.round(last))}`)}${stillHigh ? `  ${dim(`${WARN} still near peak — compaction would cut re-read cost`)}` : ""}`,
    );
  }
  lines.push("");
  return lines.join("\n");
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
