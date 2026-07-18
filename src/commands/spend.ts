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
import { ensureSeats, loadSeats, saveSeats } from "../spend/seats.js";
import { readAllEvents } from "../spend/ledger.js";
import { ingest } from "../spend/ingest.js";
import { matchModelRule, priceEvents } from "../spend/pricing.js";
import { blend, dailyLedger, leverage, sessionDetail, sessionRollups, usageSummary } from "../spend/report.js";
import {
  renderBlend,
  renderDailyLedger,
  renderLeverage,
  renderRates,
  renderSeats,
  renderSessionDetail,
  renderSessions,
  renderUsage,
  toCsv,
  toJson,
} from "../spend/format.js";
import { listSessions, type SessionRecord } from "../store.js";
import { readJsonl } from "../transcripts.js";
import { extractEvents } from "../spend/extract.js";
import type { Harness, Seat, SpendEvent } from "../spend/types.js";
import type { RateTable } from "../spend/types.js";
import { osloDay, periodOf, type Granularity } from "../spend/time.js";

/** Parse `--granularity day|week|month`; undefined when the flag is absent. */
function granularityFlag(parsed: Parsed): Granularity | undefined {
  const raw = stringFlag(parsed, ["granularity"]);
  if (!raw) return undefined;
  if (raw !== "day" && raw !== "week" && raw !== "month") {
    throw new Error(`--granularity must be day, week, or month (got "${raw}")`);
  }
  return raw;
}

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
  await ensureRatesFile();
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

async function runUsage(parsed: Parsed): Promise<void> {
  const { costed } = await loadCostedEvents();
  const granularity = granularityFlag(parsed) ?? "month";
  const today = osloDay(Date.now()) ?? new Date().toISOString().slice(0, 10);
  const period = stringFlag(parsed, ["period", "day"]) ?? periodOf(today, granularity);
  const seat = stringFlag(parsed, ["seat"]);
  const summary = usageSummary(costed, { granularity, period, today, ...(seat ? { seat } : {}) });
  if (truthy(flag(parsed, "json"))) {
    console.log(toJson(summary));
    return;
  }
  console.log(renderUsage(summary));
}

async function runReport(parsed: Parsed): Promise<void> {
  const { costed } = await loadCostedEvents();
  const granularity = granularityFlag(parsed);
  let rows = dailyLedger(costed, granularity ? { granularity } : undefined);
  // `--day` (or `--period`) filters to one bucket label — a YYYY-MM-DD for the
  // default day granularity, or the week/month label under --granularity.
  const period = stringFlag(parsed, ["day", "period"]);
  if (period) rows = rows.filter((row) => row.day === period);
  emit(parsed, rows, renderDailyLedger);
}

async function runLeverage(parsed: Parsed): Promise<void> {
  const [{ costed }, seatsFile] = await Promise.all([loadCostedEvents(), loadSeats()]);
  const seatFilter = stringFlag(parsed, ["seat"]);
  const granularity = granularityFlag(parsed);
  const rows = leverage(costed, seatsFile.seats, {
    ...(seatFilter ? { seat: seatFilter } : {}),
    ...(granularity ? { granularity } : {}),
  });
  const window = numberFlag(parsed, ["window"], 7);
  const mode = outputMode(parsed);
  if (mode === "json") console.log(toJson(rows));
  else if (mode === "csv") console.log(toCsv(rows));
  else console.log(renderLeverage(rows, { window: window === 30 ? 30 : 7 }));
}

/**
 * Resolve a user ref to a provider session id. Tries honeybee's own session
 * store first (bee name / id / prefix / providerSessionId — so `convex-orchestrator`
 * or `CL.4cff` work), then falls back to an exact or unique-prefix match against
 * the session ids already in the ledger.
 */
async function resolveSessionRef(ref: string): Promise<{ record?: SessionRecord; sessionId: string }> {
  const records = await listSessions().catch(() => []);
  const record =
    records.find((r) => r.name === ref || r.id === ref || r.providerSessionId === ref) ??
    records.find(
      (r) =>
        (r.name?.includes(ref) ?? false) ||
        (r.id?.includes(ref) ?? false) ||
        (r.providerSessionId?.startsWith(ref) ?? false),
    );
  if (record?.providerSessionId) return { record, sessionId: record.providerSessionId };

  // Fall back to a session id already present in the ledger.
  const ids = new Set((await readAllEvents()).map((event) => event.sessionId));
  if (ids.has(ref)) return { sessionId: ref };
  const prefixed = [...ids].filter((id) => id.startsWith(ref));
  if (prefixed.length === 1) return { sessionId: prefixed[0]! };
  if (prefixed.length > 1) throw new Error(`ambiguous ref "${ref}" — matches ${prefixed.length} sessions`);
  throw new Error(`no session matching "${ref}" — pass a bee name, id, or provider session id`);
}

/**
 * Extract one session's events straight from its own transcript (deduped within
 * the file), rather than the ledger. The ledger's global request-id dedup
 * attributes a resumed session's shared history to whichever copy was ingested
 * first, so its per-session view understates long/resumed sessions — reading the
 * transcript gives the true shape. Returns null if the transcript can't be read.
 */
async function eventsFromTranscript(record: SessionRecord, sessionId: string): Promise<SpendEvent[] | null> {
  if (!record.transcriptPath) return null;
  let rows: Awaited<ReturnType<typeof readJsonl>>;
  try {
    rows = await readJsonl(record.transcriptPath);
  } catch {
    return null;
  }
  const harness: Harness = record.agent === "codex" ? "codex" : record.agent === "grok" ? "grok" : record.agent === "opencode" ? "opencode" : "claude";
  const seat: Seat = { id: record.accountId ? `${harness}:${record.accountId}` : harness, harness, configDir: "" };
  const withOffsets = rows.map((row, offset) => ({ row, offset }));
  const seen = new Set<string>();
  return extractEvents(harness, withOffsets, record.transcriptPath, seat).filter(
    (event) => event.sessionId === sessionId && !seen.has(event.id) && (seen.add(event.id), true),
  );
}

async function runSessionDetail(parsed: Parsed): Promise<void> {
  const ref = parsed.args[1];
  if (!ref) throw new Error("Usage: hive spend session <bee-name | id | provider-session-id> [--json]");
  const { record, sessionId } = await resolveSessionRef(ref);
  const rates = await loadRates();

  // Prefer the session's own transcript (accurate for resumed sessions); fall
  // back to the ledger when we can't read it.
  const fromTranscript = record ? await eventsFromTranscript(record, sessionId) : null;
  const detail =
    fromTranscript && fromTranscript.length > 0
      ? sessionDetail(priceEvents(fromTranscript, rates), sessionId)
      : sessionDetail(priceEvents(await readAllEvents(), rates), sessionId);

  if (detail.turns === 0) throw new Error(`session ${sessionId} has no priced events (run \`hive spend ingest\`?)`);
  if (truthy(flag(parsed, "json"))) {
    console.log(toJson(detail));
    return;
  }
  console.log(renderSessionDetail(detail));
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
  const granularity = granularityFlag(parsed);
  const rows = blend(costed, {
    ...(model ? { model } : {}),
    ...(granularity ? { granularity } : {}),
  });
  emit(parsed, rows, renderBlend);
}

async function runRates(parsed: Parsed): Promise<void> {
  await ensureRatesFile();
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

/**
 * `hive spend seats set <seat-id> <monthlyUsd> [--plan <name>] [--provider <name>]`
 * — record a seat's actual subscription cost (and optionally plan/provider) so
 * it participates in `hive spend leverage`. Put the cost on ONE seat per real
 * subscription (usually the bee-home seat, e.g. claude:tormod-thto.no); leaving
 * the @login/duplicate seats blank avoids counting a subscription twice.
 */
async function runSeatsSet(parsed: Parsed): Promise<void> {
  const id = parsed.args[2];
  const amount = parsed.args[3];
  if (!id || amount === undefined) {
    throw new Error("Usage: hive spend seats set <seat-id> <monthlyUsd> [--plan <name>] [--provider <name>]");
  }
  const monthlyUsd = Number(amount);
  if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0) {
    throw new Error(`monthlyUsd must be a non-negative number (got "${amount}")`);
  }
  const file = await loadSeats();
  const seat = file.seats.find((entry) => entry.id === id);
  if (!seat) throw new Error(`no seat "${id}" — run \`hive spend seats\` to list them`);
  seat.monthlyUsd = monthlyUsd;
  const plan = stringFlag(parsed, ["plan"]);
  if (plan) seat.plan = plan;
  const provider = stringFlag(parsed, ["provider"]);
  if (provider) seat.provider = provider;
  await saveSeats(file);
  const detail = `monthlyUsd=$${monthlyUsd}${plan ? ` plan=${plan}` : ""}${provider ? ` provider=${provider}` : ""}`;
  console.log(isPretty() ? actionLine("ok", "seats", [`${id} ${detail}`]) : `set\t${id}\t${detail}`);
}

async function runSeats(parsed: Parsed): Promise<void> {
  if (parsed.args[1] === "set") {
    await runSeatsSet(parsed);
    return;
  }
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

function usageHelp(): string {
  const lines = [
    `${bold("hive spend usage")} — a rich per-model spend dashboard for one period`,
    "",
    dim("Shows API-equivalent USD (what your token usage WOULD cost at published API"),
    dim("list rates — not your subscription bill), broken down by model, with"),
    dim("proportional bars, a token-tier blend, and a daily sparkline."),
    "",
    bold("USAGE"),
    "  hive spend usage [--granularity day|week|month] [--period <label>] [--seat <id>] [--json]",
    "",
    bold("FLAGS"),
    `  --granularity <g>   ${dim("Bucket size: day | week | month. Default: month.")}`,
    `  --period <label>    ${dim("Which period to show. Default: the current one (to date).")}`,
    `                      ${dim("Match the granularity: 2026-07-04 (day), 2026-W27 (ISO week),")}`,
    `                      ${dim("2026-07 (month). --day is an accepted alias.")}`,
    `  --seat <id>         ${dim("Scope to one account/seat, e.g. claude:tormod-thto.no.")}`,
    `                      ${dim("Default: all seats. List them with `hive spend seats`.")}`,
    `  --json              ${dim("Emit the raw summary object instead of the dashboard.")}`,
    `  --help, -h          ${dim("Show this help.")}`,
    "",
    bold("WHAT YOU SEE"),
    `  ${dim("• One bar per model, scaled so the top spender fills the bar, with share %.")}`,
    `  ${dim("  Unpriced models are flagged `⚠ todo` and drawn empty (never faked as $0).")}`,
    `  ${dim("• TOTAL row: summed API-equivalent USD + token count.")}`,
    `  ${dim("• Blend bar: USD split across fresh-input / output / cache-read / cache-write.")}`,
    `  ${dim("• Daily sparkline (week/month) with the peak day. The current period is")}`,
    `  ${dim("  labelled `to date` and clamped to today so future days aren't drawn as zeros.")}`,
    "",
    bold("EXAMPLES"),
    `  hive spend usage                                  ${dim("# this month, all seats")}`,
    `  hive spend usage --granularity week               ${dim("# this ISO week")}`,
    `  hive spend usage --granularity day                ${dim("# today")}`,
    `  hive spend usage --period 2026-06                 ${dim("# a specific past month")}`,
    `  hive spend usage --granularity week --period 2026-W27`,
    `  hive spend usage --seat claude:tormod-thto.no     ${dim("# one account")}`,
    `  hive spend usage --json | jq '.models'`,
    "",
    bold("NOTES"),
    `  ${dim("• Costs are API-equivalent (list-rate), not your subscription cost. Fill")}`,
    `  ${dim("  monthlyUsd in ~/.hive/spend/seats.json and use `hive spend leverage` for")}`,
    `  ${dim("  the actual value-vs-cost multiple.")}`,
    `  ${dim("• Run `hive spend ingest` first (and periodically) to keep the ledger current.")}`,
    `  ${dim("• Europe/Oslo day bucketing. Everything is local — no network, ever.")}`,
  ];
  return lines.join("\n");
}

/** Per-subcommand detailed help, when one exists. */
function helpFor(sub: string | undefined): string | undefined {
  if (sub === "usage") return usageHelp();
  return undefined;
}

function printUsage(): void {
  const lines = [
    `${bold("hive spend")} — local API-equivalent cost ledger for your harness transcripts`,
    "",
    "Subcommands:",
    "  ingest              scan seats' transcripts and append new priced events (--full, --since <date>)",
    "  usage               rich per-model dashboard with bars for a period (--granularity day|week|month, --period <label>, --seat <id>, --json)",
    "  report              (period, seat, model) ledger (--granularity day|week|month, --day/--period <label>, --json, --csv)",
    "  leverage            API-equiv ÷ subscription cost (--seat <id>, --granularity day|week|month, --window 7|30, --json, --csv)",
    "  sessions            per-session cost, orchestrator/subagent split (--top <N>, --json, --csv)",
    "  session <ref>        drill into one session (bee name/id/uuid): cost, model mix, context trajectory (--json)",
    "  blend               (period, model) token/usd blend (--model <id>, --granularity day|week|month, --json, --csv)",
    "  rates               show the rate table (--check flags ledger models with no rate; --json)",
    "  seats               discover + show seats, flagging those missing monthlyUsd (--json)",
    "  seats set <id> <usd> record a seat's monthly subscription cost for leverage (--plan, --provider)",
    "",
    dim("State lives under ~/.hive/spend/ (events.jsonl, rates.json, seats.json). No network, ever."),
  ];
  console.log(lines.join("\n"));
}

export async function cmdSpend(parsed: Parsed): Promise<void> {
  const sub = parsed.args[0];
  // `--help` / `-h` on a subcommand prints its detail (or the overview) instead
  // of running it.
  if (truthy(flag(parsed, "help")) || truthy(flag(parsed, "h"))) {
    const detail = helpFor(sub);
    if (detail) console.log(detail);
    else printUsage();
    return;
  }
  switch (sub) {
    case "ingest":
      await runIngest(parsed);
      break;
    case "usage":
      await runUsage(parsed);
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
    case "session":
      await runSessionDetail(parsed);
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
