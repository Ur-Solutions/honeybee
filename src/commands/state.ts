// hive state — the CLI mirror of the BeeView V1 read model
// (docs/BEEVIEW_READ_API.md §4). Both subcommands are read-only, daemon-free,
// thin printers over src/view/index.ts: `--json` serializes the library's
// BeeViewV1 / BeeViewListV1 shapes VERBATIM, so CLI and library can never
// disagree on the contract.
import { bold, cyan, dim, formatRelativeTime, formatTable, gray, green, isPretty, magenta, note, red, tildify, truncate, yellow } from "../format.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { parseSelector, resolveSelectorFromState } from "../selectors.js";
import { listSessions } from "../store.js";
import { stringFlag } from "../cli/shared.js";
import { getBeeView, listBeeViews } from "../view/index.js";
import type { BeeDisplayState, BeeViewEvidence, BeeViewListV1, BeeViewV1, ObservationSourceFreshness } from "../view/types.js";

const USAGE = `Usage:
  hive state ls [selector] [--state <display>] [--colony <c>] [--node <n>] [--done] [--json]
  hive state explain <bee> [--json]`;

export async function cmdState(parsed: Parsed): Promise<void> {
  const sub = parsed.args[0];
  switch (sub) {
    case "ls":
    case "list":
      await stateLs(parsed);
      return;
    case "explain":
      await stateExplain(parsed);
      return;
    default:
      throw new Error(USAGE);
  }
}

/** ADR precedence order, reused for row sorting and --state validation. */
const DISPLAY_STATE_ORDER: readonly BeeDisplayState[] = [
  "retired",
  "needs-auth",
  "needs-reply",
  "needs-action",
  "stop-failed",
  "crashed",
  "unreachable",
  "starting",
  "working",
  "ready",
  "offline",
];

type Colorize = (value: string) => string;
const plain: Colorize = (value) => value;

/** Glyph + color per display state (mirrors state.ts STATE_PRESENTATION). */
const DISPLAY_PRESENTATION: Record<BeeDisplayState, { glyph: string; color: Colorize; labelColor: Colorize }> = {
  retired: { glyph: "●", color: magenta, labelColor: magenta },
  "needs-auth": { glyph: "!", color: yellow, labelColor: yellow },
  "needs-reply": { glyph: "●", color: yellow, labelColor: yellow },
  "needs-action": { glyph: "⊘", color: red, labelColor: red },
  "stop-failed": { glyph: "●", color: red, labelColor: red },
  crashed: { glyph: "○", color: red, labelColor: red },
  unreachable: { glyph: "?", color: yellow, labelColor: yellow },
  starting: { glyph: "●", color: cyan, labelColor: cyan },
  working: { glyph: "●", color: green, labelColor: green },
  ready: { glyph: "●", color: green, labelColor: plain },
  offline: { glyph: "○", color: gray, labelColor: gray },
};

function formatDisplayStateCell(state: BeeDisplayState): string {
  const { glyph, color, labelColor } = DISPLAY_PRESENTATION[state];
  return `${color(glyph)} ${labelColor(state)}`;
}

/** REQS column: "1 reply" / "auth" / "action" (comma-joined) or "-". */
function formatRequestsCell(view: BeeViewV1): string {
  const counts = view.inboxSummary.openRequestCounts;
  const parts: string[] = [];
  if (counts.needsAuth > 0) parts.push("auth");
  if (counts.needsReply > 0) parts.push(counts.needsReply === 1 ? "1 reply" : `${counts.needsReply} replies`);
  if (counts.needsAction > 0) parts.push("action");
  return parts.length > 0 ? parts.join(", ") : "-";
}

/** RESULT column: "seal ok" / "responded 3m" / "-". */
function formatResultCell(view: BeeViewV1, now: number): string {
  if (view.latestContractResult) {
    const verdict = view.latestContractResult.verdict === "success" ? "ok" : view.latestContractResult.verdict;
    return `seal ${verdict}`;
  }
  if (view.latestTurnResult) {
    const label = view.latestTurnResult.outcome === "settled-unverified" ? "settled" : view.latestTurnResult.outcome;
    const age = view.latestTurnResult.endedAt ? ` ${formatRelativeTime(view.latestTurnResult.endedAt, now)}` : "";
    return `${label}${age}`;
  }
  return "-";
}

/** FRESH column: worst source status — "live" / "stale 2d" / "held" / "unreachable". */
function formatFreshnessCell(view: BeeViewV1, now: number): string {
  const sources = view.observationFreshness.sources;
  if (sources.some((s) => s.status === "missing" && (s.caveat ?? "").includes("state held"))) return "held";
  if (sources.some((s) => s.source === "node-probe" && s.status === "missing")) return "unreachable";
  const stale = sources.filter((s) => s.status === "stale" && s.observedAt !== undefined);
  if (stale.length > 0) {
    const oldest = stale.reduce((a, b) => ((a.ageMs ?? 0) >= (b.ageMs ?? 0) ? a : b));
    return `stale ${formatRelativeTime(oldest.observedAt, now)}`;
  }
  return view.observationFreshness.observedLive ? "live" : "-";
}

function parseDisplayStateFlag(raw: string): BeeDisplayState {
  const value = raw.trim() as BeeDisplayState;
  if (!DISPLAY_STATE_ORDER.includes(value)) {
    throw new Error(`Unknown display state: ${raw}. Use one of: ${DISPLAY_STATE_ORDER.join(", ")}`);
  }
  return value;
}

/** Resolve a positional selector to the matching bee-name set (retired included). */
async function selectorNames(selector: string): Promise<Set<string>> {
  const records = await listSessions();
  const resolved = resolveSelectorFromState(parseSelector(selector), { records });
  return new Set(resolved.kind === "bee" ? [resolved.record.name] : resolved.records.map((record) => record.name));
}

async function stateLs(parsed: Parsed): Promise<void> {
  const selector = parsed.args[1];
  const stateFilterRaw = stringFlag(parsed, ["state"]);
  const stateFilter = stateFilterRaw !== undefined ? parseDisplayStateFlag(stateFilterRaw) : undefined;
  const colonyFilter = stringFlag(parsed, ["colony"]);
  const nodeFilter = stringFlag(parsed, ["node"]);
  const showRetired = truthy(flag(parsed, "done")) || stateFilter === "retired";

  const list = await listBeeViews();
  let bees = list.bees;
  if (!showRetired) bees = bees.filter((view) => view.displayState !== "retired");
  if (colonyFilter !== undefined) bees = bees.filter((view) => view.bee.colony === colonyFilter);
  if (nodeFilter !== undefined) bees = bees.filter((view) => view.bee.node === nodeFilter);
  if (stateFilter !== undefined) bees = bees.filter((view) => view.displayState === stateFilter);
  if (selector !== undefined) {
    const names = await selectorNames(selector);
    bees = bees.filter((view) => names.has(view.bee.name));
  }
  bees = [...bees].sort((a, b) =>
    DISPLAY_STATE_ORDER.indexOf(a.displayState) - DISPLAY_STATE_ORDER.indexOf(b.displayState) ||
    a.bee.name.localeCompare(b.bee.name));

  const filtered: BeeViewListV1 = { ...list, bees };
  if (truthy(flag(parsed, "json"))) {
    // The library shape, verbatim — CLI and library return byte-identical JSON.
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  const now = Date.parse(list.generatedAt);
  if (!isPretty()) {
    for (const view of bees) {
      console.log([
        view.displayState,
        view.bee.id,
        view.bee.name,
        formatRequestsCell(view),
        formatResultCell(view, now),
        formatFreshnessCell(view, now),
        view.compatibilityFields.beeStateDetail,
      ].join("\t"));
    }
    if (filtered.unreachableNodes.length > 0) {
      console.error(`# ${filtered.unreachableNodes.length} node(s) unreachable: ${filtered.unreachableNodes.join(", ")}`);
    }
    return;
  }

  if (bees.length === 0) {
    console.log(dim("No bees match. (retired bees are hidden without --done)"));
    return;
  }

  const rows = bees.map((view) => [
    formatDisplayStateCell(view.displayState),
    truncate(view.bee.id, 16),
    truncate(view.bee.title ?? view.bee.name, 22),
    formatRequestsCell(view),
    formatResultCell(view, now),
    formatFreshnessCell(view, now),
    dim(truncate(view.compatibilityFields.beeStateDetail, 40)),
  ]);
  console.log(formatTable(
    [
      { header: "STATE" },
      { header: "REF" },
      { header: "NAME" },
      { header: "REQS" },
      { header: "RESULT" },
      { header: "FRESH" },
      { header: "DETAIL" },
    ],
    rows,
  ));
  if (filtered.unreachableNodes.length > 0) {
    console.error(note(`${filtered.unreachableNodes.length} node(s) unreachable: ${filtered.unreachableNodes.join(", ")}`));
  }
}

/** "[structured: hsr-events — turn_end]" annotation for one projected fact. */
function evidenceTag(evidence: BeeViewEvidence): string {
  const detail = evidence.detail ? ` — ${evidence.detail}` : "";
  return `[${evidence.grade}: ${evidence.source}${detail}]`;
}

function formatFreshnessLine(source: ObservationSourceFreshness, now: number): string {
  const age = source.observedAt !== undefined ? ` (${formatRelativeTime(source.observedAt, now)} ago)` : "";
  const caveat = source.caveat ? ` — ${source.caveat}` : "";
  return `${source.source}: ${source.status}${age}${caveat}`;
}

async function stateExplain(parsed: Parsed): Promise<void> {
  const target = parsed.args[1];
  if (!target) throw new Error(USAGE);
  const view = await getBeeView(target);

  if (truthy(flag(parsed, "json"))) {
    // The library shape, verbatim — CLI and library return byte-identical JSON.
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  const pretty = isPretty();
  const em = pretty ? bold : (value: string) => value;
  const soft = pretty ? dim : (value: string) => value;
  const now = Date.parse(view.lastProjectedAt);
  const lines: string[] = [];

  const identity = [view.bee.agent, tildify(view.bee.cwd)];
  if (view.bee.colony) identity.push(`colony:${view.bee.colony}`);
  identity.push(`node:${view.bee.node}`);
  lines.push(`${em(view.bee.id)}${view.bee.title ? ` ${view.bee.title}` : ""} ${soft(`(${view.bee.name})`)} — ${soft(identity.join(" · "))}`);
  lines.push(`lifecycle: ${view.bee.lifecycle}`);
  lines.push(`display: ${view.displayStateReason}`);
  lines.push("");

  const runtime = view.latestRuntime;
  const runtimeBits = [
    `gen ${runtime.generation}`,
    runtime.state,
    runtime.substrate,
    ...(runtime.exitClass ? [`exit:${runtime.exitClass}`] : []),
    ...(runtime.stopFailed ? ["stop-failed"] : []),
    ...(runtime.tmuxTarget ? [`target:${runtime.tmuxTarget}`] : []),
    ...(runtime.runnerPid !== undefined ? [`pid:${runtime.runnerPid}`] : []),
  ];
  lines.push(`${em("Runtime")}     ${runtimeBits.join("  ")} ${soft(evidenceTag(runtime.evidence))}`);

  if (view.latestTurnResult) {
    const result = view.latestTurnResult;
    const age = result.endedAt !== undefined ? ` ${formatRelativeTime(result.endedAt, now)} ago` : "";
    lines.push(`${em("Turn result")} ${result.outcome}${age} ${soft(evidenceTag(result.evidence))}`);
  } else {
    lines.push(`${em("Turn result")} ${soft("none")}`);
  }

  if (view.openRequests.length > 0) {
    lines.push(em("Requests"));
    for (const request of view.openRequests) {
      const opened = request.openedAt !== undefined ? ` opened ${formatRelativeTime(request.openedAt, now)} ago` : "";
      const question = request.question ? ` ${JSON.stringify(truncate(request.question, 60))}` : "";
      lines.push(`  ${request.kind}${question} id=${request.id}${opened} ${soft(evidenceTag(request.evidence))}`);
    }
  } else {
    lines.push(`${em("Requests")}    ${soft("none open")}`);
  }
  if (view.recentClosedRequests && view.recentClosedRequests.length > 0) {
    lines.push(`  ${soft("Recent history")}`);
    for (const request of view.recentClosedRequests) {
      const how = request.status === "resolved"
        ? `resolved${request.resolvedBy ? ` by ${request.resolvedBy}` : ""}`
        : `cancelled${request.cancelReason ? ` (${request.cancelReason})` : ""}`;
      const question = request.question ? ` ${JSON.stringify(truncate(request.question, 40))}` : "";
      lines.push(soft(`    ${request.kind}${question} id=${request.id} — ${how}`));
    }
  }

  if (view.latestContractResult) {
    const contract = view.latestContractResult;
    const bits = [
      `seal ${contract.sealStatus} → ${contract.verdict}`,
      `type:${contract.sealType}`,
      ...(contract.taskId !== undefined ? [`taskId:${contract.taskId}`] : []),
      ...(contract.attempt !== undefined ? [`attempt:${contract.attempt}`] : []),
      ...(contract.matchesContract !== undefined ? [`matches contract: ${contract.matchesContract ? "yes" : "NO"}`] : []),
      `sealed ${formatRelativeTime(contract.sealedAt, now)} ago`,
    ];
    lines.push(`${em("Contract")}    ${bits.join("  ")} ${soft(evidenceTag(contract.evidence))}`);
  } else {
    lines.push(`${em("Contract")}    ${soft("no seal this incarnation")}`);
  }

  lines.push(`${em("Freshness")}   observed live: ${view.observationFreshness.observedLive ? "yes" : "no"}`);
  for (const source of view.observationFreshness.sources) {
    lines.push(`  ${formatFreshnessLine(source, now)}`);
  }

  const compat = view.compatibilityFields;
  const compatBits = [
    `beeState ${compat.beeState} (${compat.beeStateDetail})`,
    `status ${compat.sessionStatus}`,
    ...(compat.hiveStateOption !== undefined ? [`@hive_state ${compat.hiveStateOption}`] : []),
    ...(compat.effectiveHiveState !== undefined && compat.effectiveHiveState !== compat.hiveStateOption
      ? [`effective ${compat.effectiveHiveState}`]
      : []),
    ...(compat.lastObservedState !== undefined
      ? [`lastObserved ${compat.lastObservedState}${compat.lastObservedStateAt !== undefined ? ` (${formatRelativeTime(compat.lastObservedStateAt, now)} ago)` : ""}`]
      : []),
  ];
  lines.push(`${em("Compat")}      ${soft(compatBits.join(" · "))} ${soft("[legacy: session-record]")}`);
  lines.push(soft(`projected ${view.lastProjectedAt} (schema v${view.schemaVersion})`));

  console.log(lines.join("\n"));
}
