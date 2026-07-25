// `hive task` — shared micro-task lists with gated auto-supply (buz's sibling
// store; see src/tasks.ts and the agent-task-lists epic in the apiary repo).
//
// Sender attribution mirrors buz: `--sender <bee>` / `--sender-human <name>`
// are explicit; with neither, the current bee is resolved from the
// environment (HIVE_BEE / the current tmux pane) so agents can run the verbs
// flag-less. origin.kind derives from the sender: human → user, the list's
// own bee → self, any other bee → bee.

import { sanitizeHumanName } from "../buz.js";
import { actionLine, bold, dim, formatRelativeTime, formatTable, isPretty, note } from "../format.js";
import { flag, numberFlag, truthy, type Parsed } from "../parse.js";
import { appendLedger, updateSession, type SessionRecord, type TaskSupplyConfig } from "../store.js";
import {
  addTask,
  claimTask,
  editTask,
  findTaskById,
  formatListId,
  isTaskStatus,
  listTaskLists,
  listTasks,
  moveTask,
  parseListId,
  parseTaskContext,
  resolveTaskSupply,
  transitionTask,
  TASK_STATUSES,
  type HiveTask,
  type TaskListId,
  type TaskOrigin,
  type TaskStatus,
  type TaskTransitionAction,
} from "../tasks.js";
import { normalizeLimit } from "../tasks/supplyConfig.js";
import { resolveBeeInCurrentPane, resolveSession, stringFlag } from "../cli/shared.js";

export async function cmdTask(parsed: Parsed) {
  const sub = parsed.args[0];
  switch (sub) {
    case "add":
      return taskAdd(parsed);
    case "ls":
    case "list":
      return taskLs(parsed);
    case "show":
      return taskShow(parsed);
    case "start":
      return taskTransition(parsed, "start");
    case "done":
      return taskTransition(parsed, "done");
    case "block":
      return taskTransition(parsed, "block");
    case "cancel":
      return taskTransition(parsed, "cancel");
    case "claim":
      return taskClaim(parsed);
    case "mv":
      return taskMv(parsed);
    case "edit":
      return taskEdit(parsed);
    case "supply":
      return taskSupply(parsed);
    case "lists":
      return taskLists(parsed);
    default:
      throw new Error(`Unknown task subcommand: ${sub ?? ""}\nUsage: hive task <add|ls|show|start|done|block|cancel|claim|mv|edit|supply|lists>`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Sender attribution.
// ──────────────────────────────────────────────────────────────────────────

type TaskSender =
  | { kind: "human"; name: string }
  | { kind: "bee"; record: SessionRecord };

async function resolveTaskSender(parsed: Parsed): Promise<TaskSender> {
  const beeFlag = flag(parsed, "sender");
  const humanFlag = flag(parsed, "sender-human");
  const hasBee = typeof beeFlag === "string" && beeFlag.length > 0;
  const hasHuman = typeof humanFlag === "string" && humanFlag.length > 0;
  if (hasBee && hasHuman) throw new Error("task: --sender and --sender-human are mutually exclusive");
  if (hasBee) return { kind: "bee", record: await resolveSession(String(beeFlag)) };
  if (hasHuman) return { kind: "human", name: sanitizeHumanName(String(humanFlag)) };
  // No explicit attribution: resolve the bee this process runs inside
  // (HIVE_BEE stamp / current tmux pane), the way agents call the verbs.
  const self = await resolveBeeInCurrentPane();
  if (self) return { kind: "bee", record: self };
  throw new Error("task: pass --sender <bee> or --sender-human <name> (no current bee resolved from the environment)");
}

function deriveOrigin(sender: TaskSender, list: TaskListId): TaskOrigin {
  if (sender.kind === "human") return { kind: "user", sender: sender.name };
  const record = sender.record;
  const isOwnList = list.kind === "bee" && (record.name === list.name || record.id === list.name);
  return { kind: isOwnList ? "self" : "bee", sender: record.name };
}

// ──────────────────────────────────────────────────────────────────────────
// JSON shape (stable; Apiary shells these verbs).
// ──────────────────────────────────────────────────────────────────────────

function taskToJson(task: HiveTask): Record<string, unknown> {
  return {
    id: task.id,
    list: task.list,
    title: task.title,
    body: task.body ?? null,
    context: task.context ?? null,
    origin: task.origin,
    auto: task.auto,
    status: task.status,
    claimedBy: task.claimedBy ?? null,
    order: task.order,
    questId: task.questId ?? null,
    buzMessageId: task.buzMessageId ?? null,
    fedAt: task.fedAt ?? null,
    stalledAt: task.stalledAt ?? null,
    blockedReason: task.blockedReason ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    closedAt: task.closedAt ?? null,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// add.
// ──────────────────────────────────────────────────────────────────────────

async function taskAdd(parsed: Parsed) {
  const listRef = parsed.args[1];
  if (!listRef) {
    throw new Error("Usage: hive task add <list> -p <title> [--body <md>] [--auto|--no-auto] [--context-json <json>] [--quest <id>] [--sender <bee>|--sender-human <name>] [--json]");
  }
  const list = parseListId(listRef);
  const title = stringFlag(parsed, ["prompt", "p"]);
  if (!title) throw new Error("task add: --prompt|-p <title> is required");
  const body = stringFlag(parsed, ["body"]);
  const questId = stringFlag(parsed, ["quest"]);
  const contextRaw = stringFlag(parsed, ["context-json"]);
  let context;
  if (contextRaw !== undefined) {
    let parsedContext: unknown;
    try {
      parsedContext = JSON.parse(contextRaw);
    } catch (error) {
      throw new Error(`task add: --context-json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    context = parseTaskContext(parsedContext);
  }
  const autoRequested = resolveAutoFlags(parsed);
  const sender = await resolveTaskSender(parsed);
  const origin = deriveOrigin(sender, list);

  const { task, warning } = await addTask({
    list,
    title,
    ...(body !== undefined ? { body } : {}),
    ...(context !== undefined ? { context } : {}),
    origin,
    ...(autoRequested !== undefined ? { autoRequested } : {}),
    ...(questId !== undefined ? { questId } : {}),
  });

  if (warning) console.error(note(warning));
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(taskToJson(task), null, 2));
    return;
  }
  if (isPretty()) {
    console.log(actionLine("ok", "task", [bold(task.list), task.id, dim(`auto:${task.auto}`)]));
  } else {
    console.log(`task.add\t${task.list}\t${task.id}\t${task.status}\t${task.auto ? "auto" : "manual"}`);
  }
}

/** --auto / --no-auto → true / false / undefined (provenance default). */
function resolveAutoFlags(parsed: Parsed): boolean | undefined {
  const auto = truthy(flag(parsed, "auto"));
  const noAuto = truthy(flag(parsed, "no-auto"));
  if (auto && noAuto) throw new Error("task: --auto and --no-auto are mutually exclusive");
  if (auto) return true;
  if (noAuto) return false;
  return undefined;
}

// ──────────────────────────────────────────────────────────────────────────
// ls / show / lists.
// ──────────────────────────────────────────────────────────────────────────

async function taskLs(parsed: Parsed) {
  const listRef = parsed.args[1];
  if (!listRef) throw new Error("Usage: hive task ls <list> [--status <s>[,<s>...]] [--json]");
  const list = parseListId(listRef);
  const statuses = parseStatusFilter(parsed);
  const tasks = await listTasks(list, statuses ? { statuses } : {});

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({ list: formatListId(list), tasks: tasks.map(taskToJson) }, null, 2));
    return;
  }
  if (tasks.length === 0) {
    if (isPretty()) console.log(dim(`# ${formatListId(list)}: no tasks`));
    return;
  }
  if (!isPretty()) {
    for (const task of tasks) {
      console.log([
        "task.ls",
        task.list,
        task.id,
        task.status,
        task.auto ? "auto" : "manual",
        `${task.origin.kind}:${task.origin.sender}`,
        String(task.order),
        task.title,
      ].join("\t"));
    }
    return;
  }
  console.log(formatTable(
    [
      { header: "ID" },
      { header: "STATUS" },
      { header: "AUTO" },
      { header: "ORIGIN" },
      { header: "AGE", align: "right" },
      { header: "TITLE" },
    ],
    tasks.map((task) => [
      task.id,
      task.status,
      task.auto ? "auto" : dim("manual"),
      dim(`${task.origin.kind}:${task.origin.sender}`),
      dim(formatRelativeTime(task.createdAt)),
      task.title,
    ]),
  ));
}

function parseStatusFilter(parsed: Parsed): TaskStatus[] | undefined {
  const raw = stringFlag(parsed, ["status"]);
  if (raw === undefined) return undefined;
  const statuses: TaskStatus[] = [];
  for (const piece of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!isTaskStatus(piece)) throw new Error(`task ls: unknown status "${piece}". Use one of: ${TASK_STATUSES.join(", ")}`);
    if (!statuses.includes(piece)) statuses.push(piece);
  }
  return statuses.length > 0 ? statuses : undefined;
}

async function taskShow(parsed: Parsed) {
  const id = parsed.args[1];
  if (!id) throw new Error("Usage: hive task show <task-id> [--json]");
  const found = await findTaskById(id);
  if (!found) throw new Error(`No task found with id: ${id}`);
  // Always JSON (mirrors `hive buz read`): the full task incl. context is a
  // structured payload, and Apiary/agents consume it as one.
  console.log(JSON.stringify(taskToJson(found.task), null, 2));
}

async function taskLists(parsed: Parsed) {
  const summaries = await listTaskLists();
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }
  if (summaries.length === 0) {
    if (isPretty()) console.log(dim("# no task lists"));
    return;
  }
  if (!isPretty()) {
    for (const summary of summaries) {
      console.log(`task.lists\t${summary.id}\t${summary.total}\t${summary.counts.pending}\t${summary.counts.queued}\t${summary.counts["in-progress"]}`);
    }
    return;
  }
  console.log(formatTable(
    [
      { header: "LIST" },
      { header: "TOTAL", align: "right" },
      { header: "PENDING", align: "right" },
      { header: "QUEUED", align: "right" },
      { header: "IN-PROGRESS", align: "right" },
      { header: "CLOSED", align: "right" },
    ],
    summaries.map((summary) => [
      bold(summary.id),
      String(summary.total),
      String(summary.counts.pending),
      String(summary.counts.queued),
      String(summary.counts["in-progress"]),
      dim(String(summary.counts.done + summary.counts.blocked + summary.counts.cancelled)),
    ]),
  ));
}

// ──────────────────────────────────────────────────────────────────────────
// Status transitions.
// ──────────────────────────────────────────────────────────────────────────

async function taskTransition(parsed: Parsed, action: TaskTransitionAction) {
  const id = parsed.args[1];
  if (!id) {
    const reasonHint = action === "block" ? " [-p <reason>]" : "";
    throw new Error(`Usage: hive task ${action} <task-id>${reasonHint} [--json]`);
  }
  const found = await findTaskById(id);
  if (!found) throw new Error(`No task found with id: ${id}`);
  const reason = action === "block" ? stringFlag(parsed, ["prompt", "p"]) : undefined;
  const task = await transitionTask(found.list, id, action, reason !== undefined ? { reason } : {});

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(taskToJson(task), null, 2));
    return;
  }
  if (isPretty()) console.log(actionLine("ok", "task", [bold(task.list), task.id, dim(task.status)]));
  else console.log(`task.${action}\t${task.list}\t${task.id}\t${task.status}`);
}

// ──────────────────────────────────────────────────────────────────────────
// claim.
// ──────────────────────────────────────────────────────────────────────────

async function taskClaim(parsed: Parsed) {
  const listRef = parsed.args[1];
  if (!listRef) throw new Error("Usage: hive task claim <list> [--sender <bee>] [--json]");
  const list = parseListId(listRef);
  const sender = await resolveTaskSender(parsed);
  if (sender.kind !== "bee") throw new Error("task claim: the claimant must be a bee (claimedBy holds a bee name); pass --sender <bee>");
  const task = await claimTask(list, sender.record.name);

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(task ? taskToJson(task) : null, null, 2));
    return;
  }
  if (!task) {
    if (isPretty()) console.log(dim(`# ${formatListId(list)}: no claimable task`));
    else console.log(`task.claim\t${formatListId(list)}\t-`);
    return;
  }
  if (isPretty()) console.log(actionLine("ok", "task", [bold(task.list), task.id, dim(`claimed:${task.claimedBy}`)]));
  else console.log(`task.claim\t${task.list}\t${task.id}\t${task.claimedBy}`);
}

// ──────────────────────────────────────────────────────────────────────────
// mv / edit.
// ──────────────────────────────────────────────────────────────────────────

async function taskMv(parsed: Parsed) {
  const id = parsed.args[1];
  if (!id) throw new Error("Usage: hive task mv <task-id> --before <id>|--after <id>");
  const before = stringFlag(parsed, ["before"]);
  const after = stringFlag(parsed, ["after"]);
  const found = await findTaskById(id);
  if (!found) throw new Error(`No task found with id: ${id}`);
  const task = await moveTask(found.list, id, {
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  });

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(taskToJson(task), null, 2));
    return;
  }
  if (isPretty()) console.log(actionLine("ok", "task", [bold(task.list), task.id, dim(`order:${task.order}`)]));
  else console.log(`task.mv\t${task.list}\t${task.id}\t${task.order}`);
}

async function taskEdit(parsed: Parsed) {
  const id = parsed.args[1];
  if (!id) throw new Error("Usage: hive task edit <task-id> [-p <title>] [--body <md>] [--auto|--no-auto] [--json]");
  const title = stringFlag(parsed, ["prompt", "p"]);
  const body = stringFlag(parsed, ["body"]);
  const auto = resolveAutoFlags(parsed);
  const found = await findTaskById(id);
  if (!found) throw new Error(`No task found with id: ${id}`);
  const task = await editTask(found.list, id, {
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(auto !== undefined ? { auto } : {}),
  });

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(taskToJson(task), null, 2));
    return;
  }
  if (isPretty()) console.log(actionLine("ok", "task", [bold(task.list), task.id, dim(`auto:${task.auto}`)]));
  else console.log(`task.edit\t${task.list}\t${task.id}\t${task.auto ? "auto" : "manual"}`);
}

// ──────────────────────────────────────────────────────────────────────────
// supply — per-bee auto-supply config (a human control: kit deliberately does
// not expose this to agents; the CLI performs no caller enforcement).
// ──────────────────────────────────────────────────────────────────────────

async function taskSupply(parsed: Parsed) {
  const ref = parsed.args[1];
  if (!ref) throw new Error("Usage: hive task supply <bee> [--on|--off] [--limit <n>] [--json]");
  const record = await resolveSession(ref);

  const on = truthy(flag(parsed, "on"));
  const off = truthy(flag(parsed, "off"));
  if (on && off) throw new Error("task supply: --on and --off are mutually exclusive");
  const limitRaw = flag(parsed, "limit");
  const limit = typeof limitRaw === "string" ? numberFlag(parsed, ["limit"], NaN) : undefined;
  if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) {
    throw new Error("task supply: --limit must be a positive integer");
  }

  const current = resolveTaskSupply(record);
  const mutate = on || off || limit !== undefined;
  let effective = current;
  if (mutate) {
    // --on clears the tripped breaker AND the consecutive-feed counter; --off
    // and a bare --limit leave both untouched.
    const next: TaskSupplyConfig = {
      on: on ? true : off ? false : current.on,
      limit: normalizeLimit(limit ?? current.limit),
    };
    if (!on) {
      if (current.feeds > 0) next.feeds = current.feeds;
      if (current.paused) next.paused = true;
    }
    await updateSession(record.name, { taskSupply: next });
    await appendLedger({
      type: "task.supply",
      bee: record.name,
      on: next.on,
      limit: next.limit,
      ...(next.paused ? { paused: true } : {}),
    });
    effective = resolveTaskSupply({ taskSupply: next });
  }

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({
      bee: record.name,
      on: effective.on,
      limit: effective.limit,
      feeds: effective.feeds,
      paused: effective.paused,
    }, null, 2));
    return;
  }
  if (!isPretty()) {
    console.log(`task.supply\t${record.name}\t${effective.on ? "on" : "off"}\t${effective.limit}\t${effective.feeds}\t${effective.paused ? "paused" : "-"}`);
    return;
  }
  console.log(formatTable(
    [{ header: "BEE" }, { header: "SUPPLY" }, { header: "LIMIT", align: "right" }, { header: "FEEDS", align: "right" }, { header: "BREAKER" }],
    [[
      bold(record.name),
      effective.on ? "on" : dim("off"),
      String(effective.limit),
      String(effective.feeds),
      effective.paused ? "paused" : dim("-"),
    ]],
  ));
}
