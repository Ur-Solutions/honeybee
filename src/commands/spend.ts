// ──────────────────────────────────────────────────────────────────────────
// `hive spend` — the reporting/CLI surface over the local priced-event ledger.
// Subcommands: ingest, report, leverage, sessions, blend, rates, seats. This is
// the ONLY I/O layer for spend reporting: it reads events/rates/seats, calls the
// pure builders in spend/report.ts, and renders via spend/format.ts. Financial
// data stays local — nothing here touches the network.
// ──────────────────────────────────────────────────────────────────────────

import { actionLine, bold, dim, isPretty } from "../format.js";
import { flag, numberFlag, truthy, type Parsed } from "../parse.js";
import { stringFlag } from "../cli/shared.js";
import { ratesPath, seatsPath } from "../spend/paths.js";
import { loadRates, ensureRatesFile } from "../spend/rates.js";
import { ensureSeats, loadSeats } from "../spend/seats.js";
import { readAllEvents } from "../spend/ledger.js";
import { ingest } from "../spend/ingest.js";
import { matchModelRule, priceEvents } from "../spend/pricing.js";
import { blend, dailyLedger, leverage, sessionRollups } from "../spend/report.js";
import {
  renderBlend,
  renderDailyLedger,
  renderLeverage,
  renderRates,
  renderSeats,
  renderSessions,
  toCsv,
  toJson,
} from "../spend/format.js";
import type { RateTable } from "../spend/types.js";

/** Which serialization the user asked for on a report subcommand. */
type OutputMode = "table" | "json" | "csv";

function outputMode(parsed: Parsed): OutputMode {
  if (truthy(flag(parsed, "json"))) return "json";
  if (truthy(flag(parsed, "csv"))) return "csv";
  return "table";
}

/** Render a report either as a table (via `renderer`) or as JSON/CSV. */
function emit<T extends Record<string, unknown>>(parsed: Parsed, rows: T[], renderer: (rows: T[]) => string): void {
  const mode = outputMode(parsed);
  if (mode === "json") console.log(toJson(rows));
  else if (mode === "csv") console.log(toCsv(rows));
  else console.log(renderer(rows));
}

/**
 * A model id is "known" when a non-todo rule matches it. This is the predicate
 * ingest uses to compute its loud unknown-model list; a rule with an out-of-range
 * version still counts as known here (the rule exists — the operator just needs
 * to add a version), while todo/no-rule ids surface loudly.
 */
function knownModelPredicate(table: RateTable): (id: string) => boolean {
  return (id: string) => {
    const rule = matchModelRule(table, id);
    return rule !== null && rule.todo !== true;
  };
}

/** Load every event and price it against the on-disk (or seeded) rate table. */
async function loadCostedEvents() {
  const [events, rates] = await Promise.all([readAllEvents(), loadRates()]);
  return { costed: priceEvents(events, rates), rates };
}

async function runIngest(parsed: Parsed): Promise<void> {
  await ensureRatesFile();
  // Snapshot existing seat ids so we can report the ones scaffolded this run.
  const before = new Set((await loadSeats()).seats.map((seat) => seat.id));
  const seatsFile = await ensureSeats();
  const newSeats = seatsFile.seats.filter((seat) => !before.has(seat.id)).map((seat) => seat.id);

  const rates = await loadRates();
  const result = await ingest({
    seats: seatsFile.seats,
    full: truthy(flag(parsed, "full")),
    ...(stringFlag(parsed, ["since"]) ? { since: stringFlag(parsed, ["since"]) } : {}),
    knownModel: knownModelPredicate(rates),
  });

  if (isPretty()) {
    console.log(actionLine("ok", "ingest", [`${result.filesScanned} files scanned`, `${result.eventsAppended} appended`, `${result.duplicatesSkipped} dupes`]));
  } else {
    console.log(`ingest\tfiles=${result.filesScanned}\tappended=${result.eventsAppended}\tdupes=${result.duplicatesSkipped}`);
  }
  if (newSeats.length > 0) console.log(`${dim("new seats:")} ${newSeats.join(", ")} ${dim(`— set monthlyUsd in ${seatsPath()}`)}`);
  if (result.unknownModels.length > 0) {
    console.log("");
    console.log(bold(`⚠ ${result.unknownModels.length} unpriced model(s) — counted but not costed:`));
    for (const model of result.unknownModels) console.log(`  ${model}`);
    console.log(dim(`Add or fix a rule in ${ratesPath()} to price them (set todo:false and fill versions).`));
  }
}

async function runReport(parsed: Parsed): Promise<void> {
  const { costed } = await loadCostedEvents();
  let rows = dailyLedger(costed);
  const day = stringFlag(parsed, ["day"]);
  if (day) rows = rows.filter((row) => row.day === day);
  emit(parsed, rows, renderDailyLedger);
}

async function runLeverage(parsed: Parsed): Promise<void> {
  const [{ costed }, seatsFile] = await Promise.all([loadCostedEvents(), loadSeats()]);
  const seatFilter = stringFlag(parsed, ["seat"]);
  const rows = leverage(costed, seatsFile.seats, seatFilter ? { seat: seatFilter } : undefined);
  const window = numberFlag(parsed, ["window"], 7);
  const mode = outputMode(parsed);
  if (mode === "json") console.log(toJson(rows));
  else if (mode === "csv") console.log(toCsv(rows));
  else console.log(renderLeverage(rows, { window: window === 30 ? 30 : 7 }));
}

async function runSessions(parsed: Parsed): Promise<void> {
  const { costed } = await loadCostedEvents();
  const top = numberFlag(parsed, ["top"], 20);
  const rows = sessionRollups(costed, { top });
  emit(parsed, rows, renderSessions);
}

async function runBlend(parsed: Parsed): Promise<void> {
  const { costed } = await loadCostedEvents();
  const model = stringFlag(parsed, ["model"]);
  const granularityRaw = stringFlag(parsed, ["granularity"]);
  if (granularityRaw && granularityRaw !== "day" && granularityRaw !== "month") {
    throw new Error(`--granularity must be "day" or "month" (got "${granularityRaw}")`);
  }
  const rows = blend(costed, {
    ...(model ? { model } : {}),
    ...(granularityRaw ? { granularity: granularityRaw as "day" | "month" } : {}),
  });
  emit(parsed, rows, renderBlend);
}

async function runRates(parsed: Parsed): Promise<void> {
  const rates = await loadRates();
  if (truthy(flag(parsed, "check"))) {
    const costed = priceEvents(await readAllEvents(), rates);
    const unresolved = [...new Set(costed.filter((event) => !event.rateResolved).map((event) => event.model))].sort();
    if (unresolved.length === 0) {
      console.log(isPretty() ? actionLine("ok", "rates", ["every model in the ledger resolves a rate"]) : "ok\tall models priced");
      return;
    }
    console.log(bold(`⚠ ${unresolved.length} model(s) in the ledger hit the unknown/TODO path:`));
    for (const model of unresolved) console.log(`  ${model}`);
    console.log(dim(`Edit ${ratesPath()} to price them.`));
    return;
  }
  if (truthy(flag(parsed, "json"))) {
    console.log(toJson(rates));
    return;
  }
  console.log(renderRates(rates));
}

async function runSeats(parsed: Parsed): Promise<void> {
  const seatsFile = await ensureSeats();
  if (truthy(flag(parsed, "json"))) {
    console.log(toJson(seatsFile.seats));
    return;
  }
  console.log(renderSeats(seatsFile.seats));
  const missing = seatsFile.seats.filter((seat) => typeof seat.monthlyUsd !== "number");
  if (missing.length > 0) {
    console.log(dim(`${missing.length} seat(s) missing monthlyUsd — leverage skips them until set.`));
  }
}

function printUsage(): void {
  const lines = [
    `${bold("hive spend")} — local API-equivalent cost ledger for your harness transcripts`,
    "",
    "Subcommands:",
    "  ingest              scan seats' transcripts and append new priced events (--full, --since <date>)",
    "  report              daily (day, seat, model) ledger (--day <YYYY-MM-DD>, --json, --csv)",
    "  leverage            daily API-equiv ÷ subscription cost (--seat <id>, --window 7|30, --json, --csv)",
    "  sessions            per-session cost, orchestrator/subagent split (--top <N>, --json, --csv)",
    "  blend               (period, model) token/usd blend (--model <id>, --granularity day|month, --json, --csv)",
    "  rates               show the rate table (--check flags ledger models with no rate; --json)",
    "  seats               discover + show seats, flagging those missing monthlyUsd (--json)",
    "",
    dim("State lives under ~/.hive/spend/ (events.jsonl, rates.json, seats.json). No network, ever."),
  ];
  console.log(lines.join("\n"));
}

export async function cmdSpend(parsed: Parsed): Promise<void> {
  const sub = parsed.args[0];
  switch (sub) {
    case "ingest":
      await runIngest(parsed);
      break;
    case "report":
      await runReport(parsed);
      break;
    case "leverage":
      await runLeverage(parsed);
      break;
    case "sessions":
      await runSessions(parsed);
      break;
    case "blend":
      await runBlend(parsed);
      break;
    case "rates":
      await runRates(parsed);
      break;
    case "seats":
      await runSeats(parsed);
      break;
    default:
      printUsage();
      break;
  }
}
