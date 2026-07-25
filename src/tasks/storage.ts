// tasks — on-disk storage layer: list ids, paths, task (de)serialization,
// and the filesystem read/list operations over task lists. Mutations live in
// tasks/store.ts (they take the per-list write lock and ledger).

import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseBuzDocument, serializeBuzDocument, type BuzFrontmatter } from "../buz_format.js";
import { storeRoot } from "../fsx.js";
import {
  isTaskOriginKind,
  isTaskStatus,
  TASK_STATUSES,
  type HiveTask,
  type TaskContext,
  type TaskListId,
  type TaskListKind,
  type TaskStatus,
} from "../tasks.js";
import { isTaskId } from "./ids.js";

// Context payloads ride whole (a browser-comment task carries the full
// feedback block) but must not balloon a task file: bound the serialized form.
export const MAX_TASK_CONTEXT_BYTES = 64 * 1024;

export const MAX_TASK_TITLE_LENGTH = 500;

// ──────────────────────────────────────────────────────────────────────────
// List ids + paths.
// ──────────────────────────────────────────────────────────────────────────

const LIST_KINDS: readonly TaskListKind[] = ["bee", "shared"];

// List names become directory names: allow the safeName alphabet minus `:`
// (the list-id separator). Bee names in practice match this already.
const LIST_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** Parse a CLI list reference: "bee:<name>" | "shared:<name>" | bare "<name>" (= bee). */
export function parseListId(raw: string): TaskListId {
  const value = raw.trim();
  if (value.length === 0) throw new Error("task list reference must not be empty");
  const colonIdx = value.indexOf(":");
  const kind = colonIdx === -1 ? "bee" : value.slice(0, colonIdx);
  const name = colonIdx === -1 ? value : value.slice(colonIdx + 1);
  if (!(LIST_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown task list kind "${kind}". Use bee:<name>, shared:<name>, or a bare bee name`);
  }
  if (!LIST_NAME_RE.test(name)) {
    throw new Error(`Invalid task list name ${JSON.stringify(name)}: allowed characters are [A-Za-z0-9_.-]`);
  }
  return { kind: kind as TaskListKind, name };
}

export function formatListId(list: TaskListId): string {
  return `${list.kind}:${list.name}`;
}

export function tasksRoot(): string {
  return join(storeRoot(), "tasks");
}

export function listDir(list: TaskListId): string {
  return anchoredTasksPath(list.kind, list.name);
}

export function taskPath(list: TaskListId, id: string): string {
  if (!isTaskId(id)) throw new Error(`Invalid task id: ${JSON.stringify(id)}`);
  return join(listDir(list), `${id}.md`);
}

// Same discipline as buz's recipientWriteLockPath: one lock per list, held
// only across filesystem mutations (never across substrate I/O).
export function listWriteLockPath(list: TaskListId): string {
  return join(listDir(list), ".write.lock");
}

function anchoredTasksPath(...segments: string[]): string {
  const root = tasksRoot();
  const path = join(root, ...segments);
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`task path escaped root: ${path}`);
  }
  return path;
}

// ──────────────────────────────────────────────────────────────────────────
// Context validation.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Validate an opaque {kind, ...} context payload and enforce the size bound.
 * The payload is otherwise stored verbatim — hive never interprets it.
 */
export function parseTaskContext(value: unknown): TaskContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("task context must be a JSON object with a string `kind`");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || record.kind.length === 0) {
    throw new Error("task context must carry a non-empty string `kind`");
  }
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, "utf8") > MAX_TASK_CONTEXT_BYTES) {
    throw new Error(`task context exceeds ${MAX_TASK_CONTEXT_BYTES} bytes when serialized`);
  }
  return record as TaskContext;
}

// ──────────────────────────────────────────────────────────────────────────
// Serialization (buz_format flat frontmatter + markdown body).
// ──────────────────────────────────────────────────────────────────────────

export function serializeTask(task: HiveTask): string {
  const fm: BuzFrontmatter = {
    id: task.id,
    list: task.list,
    title: task.title,
    originKind: task.origin.kind,
    originSender: task.origin.sender,
    auto: task.auto ? "true" : "false",
    status: task.status,
    order: String(task.order),
    ...(task.claimedBy ? { claimedBy: task.claimedBy } : {}),
    ...(task.questId ? { questId: task.questId } : {}),
    ...(task.buzMessageId ? { buzMessageId: task.buzMessageId } : {}),
    ...(task.fedAt ? { fedAt: task.fedAt } : {}),
    ...(task.stalledAt ? { stalledAt: task.stalledAt } : {}),
    ...(task.blockedReason ? { blockedReason: task.blockedReason } : {}),
    ...(task.context ? { context: JSON.stringify(task.context) } : {}),
    createdAt: task.createdAt,
    ...(task.closedAt ? { closedAt: task.closedAt } : {}),
    updatedAt: task.updatedAt,
  };
  return serializeBuzDocument(fm, task.body ?? "");
}

export function parseTask(text: string): HiveTask {
  const { frontmatter, body } = parseBuzDocument(text);
  const required = ["id", "list", "title", "originKind", "originSender", "auto", "status", "order", "createdAt", "updatedAt"] as const;
  for (const key of required) {
    if (typeof frontmatter[key] !== "string") throw new Error(`Task file missing field: ${key}`);
  }
  const status = frontmatter.status!;
  if (!isTaskStatus(status)) throw new Error(`Invalid task status: ${status}. Use one of: ${TASK_STATUSES.join(", ")}`);
  const originKind = frontmatter.originKind!;
  if (!isTaskOriginKind(originKind)) throw new Error(`Invalid task originKind: ${originKind}`);
  const order = Number(frontmatter.order);
  if (!Number.isFinite(order)) throw new Error(`Invalid task order: ${frontmatter.order}`);
  // Validates the reference grammar; the parsed value round-trips to `list`.
  parseListId(frontmatter.list!);

  const task: HiveTask = {
    id: frontmatter.id!,
    list: frontmatter.list!,
    title: frontmatter.title!,
    origin: { kind: originKind, sender: frontmatter.originSender! },
    auto: frontmatter.auto === "true",
    status,
    order,
    createdAt: frontmatter.createdAt!,
    updatedAt: frontmatter.updatedAt!,
  };
  const trimmedBody = body.replace(/\n+$/, "");
  if (trimmedBody.length > 0) task.body = body;
  if (frontmatter.claimedBy) task.claimedBy = frontmatter.claimedBy;
  if (frontmatter.questId) task.questId = frontmatter.questId;
  if (frontmatter.buzMessageId) task.buzMessageId = frontmatter.buzMessageId;
  if (frontmatter.fedAt) task.fedAt = frontmatter.fedAt;
  if (frontmatter.stalledAt) task.stalledAt = frontmatter.stalledAt;
  if (frontmatter.blockedReason) task.blockedReason = frontmatter.blockedReason;
  if (frontmatter.closedAt) task.closedAt = frontmatter.closedAt;
  if (frontmatter.context) {
    try {
      task.context = parseTaskContext(JSON.parse(frontmatter.context));
    } catch {
      // Forward-compatible: a malformed/oversized context is dropped on load,
      // never thrown — the task itself stays readable.
    }
  }
  return task;
}

// ──────────────────────────────────────────────────────────────────────────
// Reads.
// ──────────────────────────────────────────────────────────────────────────

export type ListTasksOptions = {
  statuses?: readonly TaskStatus[];
};

/** Order-sorted (ascending; ties broken by id) tasks of one list. */
export async function listTasks(list: TaskListId, options: ListTasksOptions = {}): Promise<HiveTask[]> {
  const dir = listDir(list);
  const entries = await readdir(dir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  const tasks: HiveTask[] = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const text = await readFile(join(dir, file), "utf8").catch(() => null);
    if (text === null) continue;
    try {
      tasks.push(parseTask(text));
    } catch {
      // A concurrently-written or malformed file must not break the listing.
      continue;
    }
  }
  const filtered = options.statuses && options.statuses.length > 0
    ? tasks.filter((task) => options.statuses!.includes(task.status))
    : tasks;
  return filtered.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
}

/**
 * Locate a task by id across all lists. Task filenames are `<id>.md`, so this
 * is one readdir per list directory — no per-file reads until the hit.
 */
export async function findTaskById(id: string): Promise<{ task: HiveTask; list: TaskListId; path: string } | null> {
  if (!isTaskId(id)) return null;
  for (const list of await enumerateLists()) {
    const path = join(listDir(list), `${id}.md`);
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    try {
      return { task: parseTask(text), list, path };
    } catch {
      continue;
    }
  }
  return null;
}

export type TaskListSummary = {
  id: string; // "bee:<name>" | "shared:<name>"
  kind: TaskListKind;
  name: string;
  counts: Record<TaskStatus, number>;
  total: number;
};

export async function listTaskLists(): Promise<TaskListSummary[]> {
  const summaries: TaskListSummary[] = [];
  for (const list of await enumerateLists()) {
    const tasks = await listTasks(list);
    const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
    for (const task of tasks) counts[task.status] += 1;
    summaries.push({ id: formatListId(list), kind: list.kind, name: list.name, counts, total: tasks.length });
  }
  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

async function enumerateLists(): Promise<TaskListId[]> {
  const lists: TaskListId[] = [];
  for (const kind of LIST_KINDS) {
    const names = await readdir(join(tasksRoot(), kind)).catch(() => [] as string[]);
    for (const name of names) {
      if (!LIST_NAME_RE.test(name)) continue; // skip lock debris / dotfiles
      lists.push({ kind, name });
    }
  }
  return lists;
}
