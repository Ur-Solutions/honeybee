import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";

type JsonObject = Record<string, unknown>;

export async function withReferenceRenameLocks<T>(fn: () => Promise<T>): Promise<T> {
  return withFileLock(join(coloniesDir(), ".colonies.lock"), () =>
    withFileLock(join(workspacesDir(), ".workspaces.lock"), () =>
      withFileLock(join(questsDir(), ".quests.lock"), fn),
    ),
  );
}

export async function rewriteWorkspaceColonyReferences(oldName: string, newName: string): Promise<void> {
  const now = new Date().toISOString();
  await rewriteNamedJsonFiles(workspacesDir(), (record) => {
    if (!isWorkspaceRecord(record)) return null;
    if (record.colony !== oldName) return null;
    return { ...record, colony: newName, updatedAt: now };
  });
}

export async function rewriteColonyWorkspaceReferences(oldName: string, newName: string): Promise<void> {
  await rewriteNamedJsonFiles(coloniesDir(), (record) => {
    if (!isColonyRecord(record)) return null;
    if (record.workspace !== oldName) return null;
    return { ...record, workspace: newName };
  });
}

export async function rewriteQuestColonyReferences(oldName: string, newName: string): Promise<void> {
  await rewriteQuestJsonFiles((record) => {
    if (record.colony !== oldName) return null;
    return { ...record, colony: newName };
  });
}

export async function rewriteQuestWorkspaceReferences(oldName: string, newName: string): Promise<void> {
  await rewriteQuestJsonFiles((record) => {
    if (record.workspace !== oldName) return null;
    return { ...record, workspace: newName };
  });
}

async function rewriteNamedJsonFiles(dir: string, patch: (record: JsonObject) => JsonObject | null): Promise<void> {
  const files = await readdir(dir).catch(() => []);
  for (const file of files.filter((entry) => entry.endsWith(".json"))) {
    const path = join(dir, file);
    const record = await readJsonObject(path).catch(() => null);
    if (!record || !recordNameMatchesPath(record, path)) continue;
    const updated = patch(record);
    if (!updated) continue;
    await writeJsonObject(path, updated);
  }
}

async function rewriteQuestJsonFiles(patch: (record: JsonObject) => JsonObject | null): Promise<void> {
  const entries = await readdir(questsDir(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(questsDir(), entry.name, "quest.json");
    const record = await readJsonObject(path).catch(() => null);
    if (!record || !questIdMatchesPath(record, path)) continue;
    if (!isQuestRecord(record)) continue;
    const updated = patch(record);
    if (!updated) continue;
    await writeJsonObject(path, updated);
  }
}

async function readJsonObject(path: string): Promise<JsonObject | null> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as JsonObject;
}

async function writeJsonObject(path: string, record: JsonObject): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function isColonyRecord(record: JsonObject): record is JsonObject & { name: string; createdAt: string; workspace?: string } {
  return typeof record.name === "string" && typeof record.createdAt === "string";
}

function isWorkspaceRecord(
  record: JsonObject,
): record is JsonObject & { name: string; createdAt: string; colony?: string; updatedAt?: string } {
  return typeof record.name === "string" && typeof record.createdAt === "string";
}

function isQuestRecord(record: JsonObject): record is JsonObject & { id: string; title: string; colony: string; workspace: string; createdAt: string } {
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.colony === "string" &&
    typeof record.workspace === "string" &&
    typeof record.createdAt === "string"
  );
}

function recordNameMatchesPath(record: JsonObject, path: string): boolean {
  return typeof record.name === "string" && record.name === basename(path).replace(/\.json$/, "");
}

function questIdMatchesPath(record: JsonObject, path: string): boolean {
  return typeof record.id === "string" && record.id === basename(dirname(path));
}

function coloniesDir(): string {
  return join(storeRoot(), "colonies");
}

function workspacesDir(): string {
  return join(storeRoot(), "workspaces");
}

function questsDir(): string {
  return join(storeRoot(), "quests");
}
