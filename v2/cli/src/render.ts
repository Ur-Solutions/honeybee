/**
 * Human-mode renderers for Honeybee v2 CLI output.
 *
 * JSON stays a raw dump of the RPC result. These formatters are the operator
 * surface: aligned columns, status color, and the tokens tests/scripts grep
 * (`stale:`, `id=`, `stopped(crashed)`, `deduped:`). Full argv lives on `view`, not `ls`.
 */
import type { AuditRow } from "../../core/src/index.ts";
import type { TranscriptTurn } from "../../driver-tmux/src/transcripts.ts";
import type {
  AccountGetResult,
  AccountLimitsResult,
  AccountListResult,
  CommandsResult,
  HealthResult,
  MailboxResult,
  QuestionListResult,
  SealListResult,
  ViewResult,
  LoginFlowRow,
} from "../../daemon/src/protocol.ts";
import {
  actionLine,
  blue,
  bold,
  cyan,
  dim,
  emptyLine,
  formatRelativeTime,
  formatTable,
  formatTimeUntil,
  gray,
  green,
  honey,
  joinParts,
  kv,
  magenta,
  red,
  stalePrefix,
  tildify,
  truncate,
  yellow,
  type ActionStatus,
} from "./style.ts";

// ---------------------------------------------------------------------------
// bees
// ---------------------------------------------------------------------------

export function runtimeLabel(v: ViewResult): string {
  return v.view.runtimeState === "stopped"
    ? `stopped(${v.view.exitCause})`
    : (v.view.runtimeState ?? "no-runtime");
}

export function derivedLabel(v: ViewResult): string {
  return v.view.working ? "working" : v.view.waitingForYou ? "waiting-for-you" : "quiet";
}

function statusDot(v: ViewResult): string {
  if (v.view.blocked) return yellow("●");
  if (v.view.working) return green("●");
  if (v.view.waitingForYou) return cyan("◐");
  if (v.view.runtimeState === "stopped" && v.view.exitCause === "crashed") return red("○");
  return dim("○");
}

function colorRuntime(label: string, v: ViewResult): string {
  if (v.view.runtimeState === "running" || v.view.runtimeState === "booting") return green(label);
  if (v.view.runtimeState === "idle") return cyan(label);
  if (v.view.runtimeState === "stopped" && v.view.exitCause === "crashed") return red(label);
  return dim(label);
}

function colorDerived(label: string, v: ViewResult): string {
  if (v.view.working) return green(label);
  if (v.view.waitingForYou) return cyan(label);
  return dim(label);
}

function colorLifecycle(life: string): string {
  if (life === "active") return life;
  if (life === "archived") return dim(life);
  return red(life);
}

function beeLead(v: ViewResult): string {
  return v.bee?.handle ?? v.bee?.id ?? v.view.beeId;
}

function extraTokens(v: ViewResult): string {
  const bee = v.bee;
  const bits: string[] = [];
  if (v.view.flags.length > 0) bits.push(yellow(`flags=${v.view.flags.join(",")}`));
  if ((bee?.spawnFailures ?? 0) > 0) bits.push(yellow(`bootFailures=${bee?.spawnFailures}`));
  return bits.join("  ");
}

/** Compact runtime for `ls`: the full `stopped(cause)` string stays on `view`. */
export function listRuntimeLabel(v: ViewResult): string {
  if (v.view.runtimeState === "stopped") {
    if (v.view.exitCause === "crashed") return "crashed";
    if (v.view.exitCause === "machine_restart") return "restart";
    return "stopped";
  }
  return v.view.runtimeState ?? "—";
}

export function modelFromArgs(args: string[] | null | undefined): string {
  if (!args) return "";
  for (let i = 0; i < args.length; i++) {
    const tok = args[i] as string;
    if ((tok === "--model" || tok === "-m") && i + 1 < args.length) return args[i + 1] as string;
    if (tok.startsWith("--model=")) return tok.slice("--model=".length);
  }
  return "";
}

function agentCell(v: ViewResult): string {
  const bee = v.bee;
  const agent = bee?.agent ?? "?";
  const sub = bee?.substrate ? `/${bee.substrate}` : "";
  return `${blue(agent)}${dim(sub)}`;
}

const LIST_NAME_MAX = 28;
const LIST_MODEL_MAX = 18;

/** One dense, greppable bee row (watch / wait / view headline). No argv dump. */
export function viewLine(v: ViewResult, stale: boolean): string {
  const bee = v.bee;
  const status = runtimeLabel(v);
  const derived = derivedLabel(v);
  const life = v.view.lifecycle ?? "deleted";
  const extras = extraTokens(v);
  const body = [
    statusDot(v),
    honey(beeLead(v)),
    bold(bee?.name ?? "?"),
    `${dim("agent=")}${blue(bee?.agent ?? "?")}${bee?.substrate ? dim(`/${bee.substrate}`) : ""}`,
    `${dim("gen=")}${magenta(String(v.view.generation ?? 0))}`,
    colorRuntime(status, v),
    colorDerived(derived, v),
    colorLifecycle(life),
    extras,
  ]
    .filter((p) => p.length > 0)
    .join("  ");
  return `${stalePrefix(stale)}${body}`;
}

export function renderBeeList(views: ViewResult[], stale: boolean, noun = "bees"): string[] {
  if (views.length === 0) return [emptyLine(stale, noun)];
  const working = views.filter((v) => v.view.working).length;
  const waiting = views.filter((v) => v.view.waitingForYou && !v.view.working).length;
  const blocked = views.filter((v) => v.view.blocked).length;
  const label = views.length === 1 && (noun === "bees" || noun === "children") ? (noun === "bees" ? "bee" : "child") : noun;
  const summaryBits = [
    `${views.length} ${label}`,
    working > 0 ? green(`${working} working`) : null,
    waiting > 0 ? cyan(`${waiting} waiting-for-you`) : null,
    blocked > 0 ? yellow(`${blocked} blocked`) : null,
  ];
  const summary = `${stalePrefix(stale)}${joinParts(summaryBits)}`;

  const showModel = views.some((v) => modelFromArgs(v.bee?.args).length > 0);
  const showFlags = views.some((v) => v.view.flags.length > 0 || (v.bee?.spawnFailures ?? 0) > 0);
  const mixedLife = new Set(views.map((v) => v.view.lifecycle ?? "deleted")).size > 1;

  const columns: Array<{ header: string; align?: "left" | "right" }> = [
    { header: "" },
    { header: "HANDLE" },
    { header: "NAME" },
    { header: "AGENT" },
    { header: "GEN", align: "right" },
    { header: "RUNTIME" },
    { header: "" },
  ];
  if (showModel) columns.push({ header: "MODEL" });
  if (mixedLife) columns.push({ header: "LIFE" });
  if (showFlags) columns.push({ header: "" });

  const rows = views.map((v) => {
    const bee = v.bee;
    const runtime = listRuntimeLabel(v);
    const derived = derivedLabel(v);
    const row = [
      statusDot(v),
      honey(beeLead(v)),
      bold(truncate(bee?.name ?? "?", LIST_NAME_MAX)),
      agentCell(v),
      magenta(String(v.view.generation ?? 0)),
      colorRuntime(runtime, v),
      colorDerived(derived, v),
    ];
    if (showModel) row.push(dim(truncate(modelFromArgs(bee?.args), LIST_MODEL_MAX)));
    if (mixedLife) row.push(colorLifecycle(v.view.lifecycle ?? "deleted"));
    if (showFlags) row.push(extraTokens(v));
    return row;
  });

  const table = formatTable(columns, rows, { rule: false });
  const prefix = stalePrefix(stale);
  return [summary, ...table.map((line) => `${prefix}${line}`)];
}

export function renderBeeView(v: ViewResult, stale: boolean): string[] {
  const bee = v.bee;
  const lines = [viewLine(v, stale)];
  if (!bee) return lines;
  const prefix = stalePrefix(stale);
  const details: Array<[string, string]> = [];
  if (bee.handle) details.push(["id", bee.id]);
  if (bee.title) details.push(["title", bee.title]);
  details.push(["cwd", tildify(bee.cwd)]);
  if (bee.account) details.push(["account", bee.account]);
  if (bee.args && bee.args.length > 0) details.push(["args", JSON.stringify(bee.args)]);
  if (bee.tags.length > 0) details.push(["tags", bee.tags.join(",")]);
  if (bee.parentId) details.push(["parent", bee.parentId]);
  if (bee.lastOutputAt != null) details.push(["last out", `${formatRelativeTime(bee.lastOutputAt)} ago`]);
  if (bee.providerSessionId) details.push(["session", bee.providerSessionId]);
  if (bee.forkedFrom) details.push(["forked", bee.forkedFrom]);
  for (const [label, value] of details) {
    lines.push(`${prefix}${kv(label, value).slice(2)}`);
  }
  return lines;
}

export function renderHere(
  id: string,
  bee: { name?: string | null; agent?: string | null; cwd?: string | null } | null,
  stale: boolean,
  resolvable: boolean,
): string[] {
  const prefix = stalePrefix(stale);
  if (!resolvable) return [`${prefix}here ${id}  ${dim("(not resolvable on this node)")}`];
  return [
    `${prefix}here ${honey(id)}  ${bold(bee?.name ?? "?")}  ${dim("agent=")}${blue(bee?.agent ?? "?")}  ${dim("cwd=")}${tildify(bee?.cwd ?? "?")}`,
  ];
}

// ---------------------------------------------------------------------------
// accounts / usage
// ---------------------------------------------------------------------------

function colorAccountStatus(status: string): string {
  if (status === "ok") return green(status);
  if (status === "paused") return dim(status);
  return yellow(status);
}

function pct(v: number | null): string {
  return v === null ? "-" : `${Math.round(v)}%`;
}

function colorPct(v: number | null): string {
  if (v === null) return dim("-");
  const n = Math.round(v);
  const label = `${n}%`;
  if (n >= 80) return red(label);
  if (n >= 50) return yellow(label);
  return green(label);
}

export function accountLine(
  a: AccountListResult["accounts"][number],
  limits: AccountListResult["limits"][number] | undefined,
  stale: boolean,
): string {
  const usage = limits
    ? limits.readable
      ? `  weekly=${colorPct(limits.weeklyPct)} 5h=${colorPct(limits.fiveHourPct)}${limits.fableWeeklyPct !== null ? ` fable=${colorPct(limits.fableWeeklyPct)}` : ""}${limits.plan ? ` plan=${limits.plan}` : ""}`
      : `  limits=unreadable(${limits.error ?? "?"})`
    : "";
  const penalty = a.penalty > 0 ? `  penalty=${a.penalty}` : "";
  const login = a.lastLoginAt ? `  lastLogin=${new Date(a.lastLoginAt).toISOString()}` : "";
  return `${stalePrefix(stale)}${bold(a.id)}  ${blue(a.harness)}  ${colorAccountStatus(a.status)}  ${dim(tildify(a.homePath))}${penalty}${usage}${login}`;
}

export function renderAccountList(
  accounts: AccountListResult["accounts"],
  limits: AccountListResult["limits"],
  stale: boolean,
): string[] {
  if (accounts.length === 0) return [emptyLine(stale, "accounts")];
  const byId = new Map(limits.map((l) => [l.account, l]));
  return accounts.map((a) => accountLine(a, byId.get(a.id), stale));
}

export function renderAccountGet(r: AccountGetResult): string[] {
  const lines = [accountLine(r.account, r.limits ?? undefined, false)];
  const bees = r.bees.length > 0 ? r.bees.join(",") : "-";
  const flow = r.loginFlow ? `  login=${r.loginFlow.phase}${r.loginFlow.methodId ? ` (${r.loginFlow.methodId})` : ""}` : "";
  const health = r.credentialHealth === "verified" ? green("verified") : r.credentialHealth === "unverified" ? yellow("unverified") : dim("absent");
  lines.push(`  ${dim("credentials=")}${health}  ${dim("bees=")}${bees}${flow}`);
  return lines;
}

/**
 * The human view of a login flow row (v16): what to do next, never a
 * terminal to attach to. Secrets never appear here (the row has none).
 */
export function renderLoginFlow(flow: LoginFlowRow): string[] {
  const lines: string[] = [];
  const method = flow.methods.find((m) => m.id === flow.methodId);
  const head = `${bold(flow.account)}  ${blue(flow.harness)}  ${colorLoginPhase(flow.phase)}${method ? `  ${dim(method.label)}` : ""}  ${dim(`rev ${flow.revision}`)}`;
  lines.push(head);
  if (flow.detail) lines.push(`  ${flow.detail}`);
  if (flow.authorizationUrl) lines.push(`  ${dim("open:")} ${cyan(flow.authorizationUrl)}`);
  if (flow.userCode) lines.push(`  ${dim("code:")} ${bold(flow.userCode)}`);
  for (const field of flow.inputFields) {
    lines.push(`  ${dim("needs:")} ${field.label}${field.required ? "" : dim(" (optional)")}${field.help ? `  ${dim(field.help)}` : ""}`);
  }
  if (flow.error) lines.push(`  ${red(flow.error.code)}: ${flow.error.message}${flow.retryable ? dim("  (retry: hive account login <account>)") : ""}`);
  const others = flow.methods.filter((m) => m.id !== flow.methodId);
  if (others.length > 0 && flow.phase !== "succeeded") {
    lines.push(`  ${dim("other methods:")} ${others.map((m) => `${m.id} (${m.label})`).join(", ")}`);
  }
  return lines;
}

function colorLoginPhase(phase: LoginFlowRow["phase"]): string {
  switch (phase) {
    case "succeeded":
      return green(phase);
    case "failed":
    case "expired":
    case "interrupted":
      return red(phase);
    case "cancelled":
      return dim(phase);
    default:
      return yellow(phase);
  }
}

export function renderAccountLimits(limits: AccountLimitsResult["limits"]): string[] {
  if (limits.length === 0) return [dim("no accounts")];
  return limits.map((l) =>
    l.readable
      ? `${bold(l.account)}  weekly=${colorPct(l.weeklyPct)} 5h=${colorPct(l.fiveHourPct)}${l.fableWeeklyPct !== null ? ` fable=${colorPct(l.fableWeeklyPct)}` : ""}${l.plan ? ` plan=${l.plan}` : ""}  ${dim(`fetched=${new Date(l.fetchedAt).toISOString()}`)}`
      : `${bold(l.account)}  ${yellow("unreadable:")} ${l.error ?? "?"}`,
  );
}

function usageBar(pctValue: number): string {
  const width = 10;
  const filled = Math.max(0, Math.min(width, Math.round((pctValue / 100) * width)));
  const paint = pctValue >= 80 ? red : pctValue >= 50 ? yellow : green;
  return `${paint("█".repeat(filled))}${dim("░".repeat(width - filled))}`;
}

function usageWindowCell(pctValue: number | null, resetsAt: number | null, now: number, bar: boolean): string {
  if (pctValue == null) return "-";
  const clamped = Math.max(0, Math.min(100, pctValue));
  const reset = resetsAt != null ? ` ⟳ ${formatTimeUntil(resetsAt, now)}` : "";
  const n = String(Math.round(clamped)).padStart(3);
  const colored = clamped >= 80 ? red(`${n}%`) : clamped >= 50 ? yellow(`${n}%`) : green(`${n}%`);
  return `${bar ? `${usageBar(clamped)} ` : ""}${colored}${reset}`;
}

function fetchedAgo(fetchedAt: number, now: number): string {
  const ageMs = now - fetchedAt;
  if (ageMs < 60_000) return "live";
  return `${formatRelativeTime(fetchedAt, now)} ago`;
}

export function renderUsageTable(limits: AccountLimitsResult["limits"], stale: boolean, now = Date.now()): string[] {
  if (limits.length === 0) return [];
  const rows = limits.map((l) =>
    l.readable
      ? [
          bold(l.account),
          l.plan ?? "-",
          usageWindowCell(l.fiveHourPct, l.fiveHourResetsAt, now, true),
          usageWindowCell(l.weeklyPct, l.weeklyResetsAt, now, true),
          usageWindowCell(l.fableWeeklyPct, l.fableResetsAt, now, false),
          fetchedAgo(l.fetchedAt, now),
        ]
      : [bold(l.account), "-", `unreadable: ${l.error ?? "?"}`, "", "", ""],
  );
  const table = formatTable(
    [
      { header: "ACCOUNT" },
      { header: "PLAN" },
      { header: "5H" },
      { header: "WEEKLY" },
      { header: "FABLE" },
      { header: "AS-OF" },
    ],
    rows,
  );
  const prefix = stalePrefix(stale);
  return table.map((line) => `${prefix}${line}`);
}

// ---------------------------------------------------------------------------
// mailbox / commands / questions / seals / registry
// ---------------------------------------------------------------------------

function colorUrgency(u: string): string {
  if (u === "now") return red(u);
  if (u === "idle") return dim(u);
  return cyan(u);
}

export function renderMailbox(messages: MailboxResult["messages"], stale: boolean): string[] {
  const prefix = stalePrefix(stale);
  if (messages.length === 0) return [`${prefix}${dim("mailbox empty")}`];
  return messages.map((m) => {
    const state =
      m.deliveredAt == null ? yellow("undelivered") : dim(`delivered(gen ${m.deliveredGeneration})`);
    const urgency = m.urgency && m.urgency !== "next" ? `  ${colorUrgency(m.urgency)}` : "";
    return `${prefix}${magenta(`#${m.id}`)}  ${dim("from=")}${m.sender}${urgency}  ${state}  ${m.body}`;
  });
}

function colorCommandStatus(status: string, failure: string | null): string {
  if (status === "done") return green(status);
  if (status === "failed") return red(`${status}${failure ? `(${failure})` : ""}`);
  if (status === "running") return cyan(status);
  return yellow(status);
}

export function renderCommands(commands: CommandsResult["commands"], stale: boolean): string[] {
  const prefix = stalePrefix(stale);
  if (commands.length === 0) return [`${prefix}${dim("no commands")}`];
  return commands.map((cmd) => {
    const status = colorCommandStatus(cmd.status, cmd.failureCause);
    return `${prefix}${magenta(`#${cmd.id}`)}  ${bold(cmd.verb)}  ${status}  ${dim("gen=")}${cmd.targetGeneration ?? "-"}  ${dim("attempts=")}${cmd.attempts}`;
  });
}

export function questionLine(q: QuestionListResult["questions"][number], stale: boolean): string {
  const prefix = stalePrefix(stale);
  const opts = q.options && q.options.length > 0 ? ` options=${JSON.stringify(q.options)}` : "";
  const status = q.status === "open" ? yellow("open") : green("answered");
  const ans = q.status === "answered" ? `  answered by ${q.answeredBy}: ${q.answer}` : "";
  return `${prefix}${magenta(q.id)}  ${dim("bee=")}${q.beeId}  ${status}${opts}  ${q.text}${ans}`;
}

export function sealLine(sl: SealListResult["seals"][number], stale: boolean): string {
  const refs = sl.refs.length > 0 ? ` refs=${JSON.stringify(sl.refs)}` : "";
  return `${stalePrefix(stale)}${honey(sl.id)}  ${dim("bee=")}${sl.beeId}  ${dim("gen=")}${sl.generation ?? "-"}  ${bold(sl.title)}${refs}`;
}

export function renderSealGet(sl: SealListResult["seals"][number], stale: boolean): string[] {
  const prefix = stalePrefix(stale);
  return [sealLine(sl, stale), ...sl.body.split("\n").map((l) => `${prefix}  ${l}`)];
}

export function registryLine(
  prefix: string,
  r: { id: string; name: string; scope: string; source: string },
  extra: string,
): string {
  return `${prefix}${dim(r.id)}  ${bold(r.name)}  ${dim("scope=")}${r.scope}  ${dim("source=")}${r.source}  ${extra}`;
}

// ---------------------------------------------------------------------------
// transcript / events / health / watch
// ---------------------------------------------------------------------------

function colorRole(role: string): string {
  const tag = `[${role}]`;
  if (role === "assistant") return honey(tag);
  if (role === "user") return cyan(tag);
  if (role === "tool") return dim(tag);
  return gray(tag);
}

export function turnLines(turns: readonly TranscriptTurn[], prefix = ""): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    const body = turn.text.split("\n");
    out.push(`${prefix}${colorRole(turn.role)} ${body[0] ?? ""}`);
    for (const cont of body.slice(1)) out.push(`${prefix}  ${cont}`);
  }
  return out;
}

export function sessionLogBanner(path: string, harness: string, stale: boolean): string {
  const staleBit = stale ? `${yellow(bold("STALE"))}${dim(":")} daemon not running — ` : "";
  return `${staleBit}${dim("#")} session log ${dim(tildify(path))} ${dim(`(${harness})`)}`;
}

export function auditLine(row: AuditRow, prefix: string): string {
  const payload = JSON.stringify(row.payload);
  const summary = payload.length > 160 ? `${payload.slice(0, 157)}…` : payload;
  const kind = row.kind.startsWith("runtime.")
    ? green(row.kind)
    : row.kind.startsWith("mail.")
      ? yellow(row.kind)
      : row.kind.startsWith("bee.")
        ? cyan(row.kind)
        : row.kind.startsWith("command.")
          ? magenta(row.kind)
          : row.kind;
  return `${prefix}${dim(new Date(row.ts).toISOString())}  ${magenta(`#${row.seq}`)}  ${kind}${row.beeId ? `  ${dim("bee=")}${row.beeId}` : ""}  ${dim(summary)}`;
}

export function renderHealth(result: HealthResult): string[] {
  const i1 = result.i1Violations > 0 ? red(`${result.i1Violations}`) : green("0");
  return [
    joinParts([
      bold("daemon"),
      `${dim("pid")} ${result.pid}`,
      `${dim("up")} ${Math.round(result.uptimeMs / 1000)}s`,
      `${dim("ticks")} ${result.ticks}`,
      result.tickErrors > 0 ? red(`tickErrors=${result.tickErrors}`) : dim("tickErrors=0"),
    ]),
    joinParts([
      bold("bees"),
      `${result.bees.total} total`,
      green(`${result.bees.active} active`),
      dim(`${result.bees.archived} archived`),
    ]),
    joinParts([bold("i1"), `${i1} violations`]),
  ];
}

export function renderWatchSnapshot(seq: number, views: ViewResult[], filterBee?: string): string[] {
  const shown = filterBee
    ? views.filter((v) => v.bee?.id === filterBee || v.bee?.name === filterBee || v.bee?.handle === filterBee)
    : views;
  return [`${cyan("snapshot")}  ${dim("seq=")}${seq}  ${dim("bees=")}${shown.length}`, ...shown.map((v) => viewLine(v, false))];
}

export function renderWatchEvent(seq: number, kind: string, beeId?: string | null): string {
  return `${magenta(String(seq))}  ${kind}${beeId ? `  ${dim("bee=")}${beeId}` : ""}`;
}

export function confirm(
  status: ActionStatus,
  verb: string,
  detail: string,
  deduped = false,
): string {
  return actionLine(status, verb, detail, deduped);
}

function colorTaskStatus(status: string): string {
  if (status === "done") return green(status);
  if (status === "blocked") return yellow(status);
  if (status === "cancelled") return dim(status);
  if (status === "in-progress" || status === "queued") return cyan(status);
  return status;
}

export function taskLine(
  t: {
    id: string;
    status: string;
    auto: boolean;
    originKind: string;
    originSender: string;
    title: string;
  },
  stale: boolean,
): string {
  return `${stalePrefix(stale)}${magenta(t.id)}  ${colorTaskStatus(t.status)}  ${t.auto ? cyan("auto") : dim("manual")}  ${dim(`${t.originKind}:${t.originSender}`)}  ${t.title}`;
}
