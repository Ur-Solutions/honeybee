/**
 * Quests — a tracked task with a beginning and a completion
 * (WORKSPACES_AND_QUESTS_PRD §6, §8.1). A quest lives in a colony, owns a
 * workspace while active, and spawns one or more swarms to do the work. Its
 * lifecycle is open → active → done → archived; this increment (9a) builds
 * create + start (open → active). `done`/`archive` and Linear land later.
 *
 * Storage is a DIRECTORY per quest at `storeRoot()/quests/<id>/quest.json` — the
 * directory will also hold the completion archive (seals copy + final workspace
 * snapshot) in a later increment, so the record gets its own folder up front.
 *
 * CRUD + ledger conventions mirror src/swarm.ts / src/workspace.ts exactly:
 * generate an `<prefix>-<hex>` id like swarm ids, validate-before-path-join,
 * embedded-id-must-match-directory-name (debris guard), one lock per mutation,
 * and a defensive reader that drops a malformed record (null in listQuests,
 * thrown→null in loadQuest).
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import { appendLedger } from "./store.js";

export type QuestStatus = "open" | "active" | "done" | "archived";

export type QuestRecord = {
  id: string; // generateQuestId() — "<prefix>-<hex>", like swarm ids
  title: string;
  colony: string; // a quest always lives in a colony (auto-create if absent)
  workspace: string; // the ws-<name> it owns
  status: QuestStatus;
  swarmIds: string[]; // swarms spun up for this quest
  linearIssueId?: string; // optional external link (e.g. "ENG-1234")
  createdAt: string;
  activatedAt?: string;
  completedAt?: string;
  archivedAt?: string;
  description?: string;
};

// Same shape as SWARM_ID_RE — an `<prefix>-<hex>` token, safe as a path segment.
const QUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function validQuestId(id: string): boolean {
  return QUEST_ID_RE.test(id);
}

export function generateQuestId(prefix?: string): string {
  const suffix = randomBytes(3).toString("hex");
  const base = prefix && QUEST_ID_RE.test(prefix) ? prefix : "q";
  return `${base}-${suffix}`;
}

export async function listQuests(): Promise<QuestRecord[]> {
  await ensureDir();
  const entries = await readdir(questsDir(), { withFileTypes: true }).catch(() => []);
  const records: QuestRecord[] = [];
  for (const entry of entries) {
    // A quest is a directory holding quest.json; skip the lock file and any
    // stray non-directory debris.
    if (!entry.isDirectory()) continue;
    const record = await readQuest(questFile(entry.name)).catch(() => null);
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadQuest(id: string): Promise<QuestRecord | null> {
  // Validate before joining into a path so raw user input (`../escape`) can't
  // read arbitrary JSON files outside the quests directory.
  if (!validQuestId(id)) return null;
  try {
    return await readQuest(questFile(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function questExists(id: string): Promise<boolean> {
  return (await loadQuest(id)) !== null;
}

export type CreateQuestInput = {
  id: string;
  title: string;
  colony: string;
  workspace: string;
  status?: QuestStatus;
  swarmIds?: string[];
  linearIssueId?: string;
  description?: string;
};

export async function createQuest(input: CreateQuestInput): Promise<QuestRecord> {
  if (!validQuestId(input.id)) throw new Error(`Invalid quest id: ${input.id}`);
  return withQuestsLock(async () => {
    const existing = await loadQuest(input.id);
    if (existing) throw new Error(`Quest already exists: ${input.id}`);
    const record: QuestRecord = {
      id: input.id,
      title: input.title,
      colony: input.colony,
      workspace: input.workspace,
      status: input.status ?? "open",
      swarmIds: [...(input.swarmIds ?? [])],
      createdAt: new Date().toISOString(),
      ...(input.linearIssueId ? { linearIssueId: input.linearIssueId } : {}),
      ...(input.description ? { description: input.description } : {}),
    };
    await saveQuest(record);
    await appendLedger({ type: "quest.create", id: record.id, colony: record.colony, workspace: record.workspace });
    return record;
  });
}

export type QuestPatch = {
  status?: QuestStatus;
  swarmIds?: string[];
  activatedAt?: string;
  description?: string;
  linearIssueId?: string;
  workspace?: string;
};

export async function updateQuest(id: string, patch: QuestPatch): Promise<QuestRecord> {
  if (!validQuestId(id)) throw new Error(`Invalid quest id: ${id}`);
  return withQuestsLock(async () => {
    const existing = await loadQuest(id);
    if (!existing) throw new Error(`Unknown quest: ${id}`);
    const updated: QuestRecord = { ...existing };
    const wasActive = existing.status === "active";
    if (patch.status !== undefined) updated.status = patch.status;
    if (patch.swarmIds !== undefined) updated.swarmIds = sanitizeSwarmIds(patch.swarmIds);
    if (patch.activatedAt !== undefined) updated.activatedAt = patch.activatedAt;
    if (patch.workspace !== undefined) updated.workspace = patch.workspace;
    if (patch.description !== undefined) {
      if (patch.description === "") delete updated.description;
      else updated.description = patch.description;
    }
    if (patch.linearIssueId !== undefined) {
      if (patch.linearIssueId === "") delete updated.linearIssueId;
      else updated.linearIssueId = patch.linearIssueId;
    }
    await saveQuest(updated);
    // A status flip into "active" is the lifecycle event swarms hang off of;
    // record it distinctly (like swarm.create/swarm.destroy) for `hive search`.
    const becameActive = !wasActive && updated.status === "active";
    await appendLedger(becameActive ? { type: "quest.activate", id, workspace: updated.workspace } : { type: "quest.update", id });
    return updated;
  });
}

// Serialize quest mutations behind one lock so two concurrent check-then-write
// sequences (e.g. duplicate `hive quest create`) can't both succeed.
async function withQuestsLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureDir();
  return withFileLock(join(questsDir(), ".quests.lock"), fn);
}

export async function saveQuest(record: QuestRecord): Promise<void> {
  await mkdir(questDir(record.id), { recursive: true });
  await atomicWriteFile(questFile(record.id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** Keep only well-formed string ids, deduped preserving order (swarm.ts pattern). */
function sanitizeSwarmIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
}

async function readQuest(path: string): Promise<QuestRecord> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid quest record at ${path}`);
  }
  const object = parsed as Record<string, unknown>;
  if (
    typeof object.id !== "string" ||
    typeof object.title !== "string" ||
    typeof object.colony !== "string" ||
    typeof object.workspace !== "string" ||
    typeof object.createdAt !== "string"
  ) {
    throw new Error(`Invalid quest record at ${path}: missing required fields`);
  }
  // A record whose embedded id disagrees with its directory name is debris (e.g.
  // a hand-copied folder); treating it as live would create phantom duplicates.
  const stem = basename(dirname(path));
  if (object.id !== stem) {
    throw new Error(`Invalid quest record at ${path}: id ${object.id} does not match directory name`);
  }
  const status: QuestStatus =
    object.status === "open" || object.status === "active" || object.status === "done" || object.status === "archived"
      ? object.status
      : "open";
  const record: QuestRecord = {
    id: object.id,
    title: object.title,
    colony: object.colony,
    workspace: object.workspace,
    status,
    swarmIds: sanitizeSwarmIds(object.swarmIds),
    createdAt: object.createdAt,
  };
  // Additive allow-list (the OPTIONAL_STRING_SESSION_KEYS lesson): only carry a
  // new string field through when it is present and well-typed.
  if (typeof object.linearIssueId === "string") record.linearIssueId = object.linearIssueId;
  if (typeof object.activatedAt === "string") record.activatedAt = object.activatedAt;
  if (typeof object.completedAt === "string") record.completedAt = object.completedAt;
  if (typeof object.archivedAt === "string") record.archivedAt = object.archivedAt;
  if (typeof object.description === "string") record.description = object.description;
  return record;
}

export async function removeQuestRecord(id: string): Promise<void> {
  if (!validQuestId(id)) return;
  await rm(questDir(id), { recursive: true, force: true });
}

async function ensureDir(): Promise<void> {
  await mkdir(questsDir(), { recursive: true });
}

export function questsDir(): string {
  return join(storeRoot(), "quests");
}

export function questDir(id: string): string {
  return join(questsDir(), id);
}

export function questFile(id: string): string {
  return join(questDir(id), "quest.json");
}
