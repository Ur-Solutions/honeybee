import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { appendLedger } from "./store.js";

export type ColonyRecord = {
  name: string;
  createdAt: string;
  archived?: boolean;
  archivedAt?: string;
  description?: string;
};

const COLONY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validColonyName(name: string): boolean {
  return COLONY_NAME_RE.test(name);
}

export async function listColonies(): Promise<ColonyRecord[]> {
  await ensureDir();
  const files = await readdir(coloniesDir()).catch(() => []);
  const records: ColonyRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const record = await readColony(join(coloniesDir(), file)).catch(() => null);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadColony(name: string): Promise<ColonyRecord | null> {
  try {
    return await readColony(colonyPath(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function colonyExists(name: string): Promise<boolean> {
  return (await loadColony(name)) !== null;
}

export async function createColony(name: string, description?: string): Promise<ColonyRecord> {
  if (!validColonyName(name)) throw new Error(`Invalid colony name: ${name}. Use alphanumerics, dashes, and underscores.`);
  const existing = await loadColony(name);
  if (existing) throw new Error(`Colony already exists: ${name}`);
  const record: ColonyRecord = {
    name,
    createdAt: new Date().toISOString(),
    ...(description ? { description } : {}),
  };
  await saveColony(record);
  await appendLedger({ type: "colony.create", name });
  return record;
}

export async function updateColony(name: string, patch: { description?: string }): Promise<ColonyRecord> {
  const existing = await loadColony(name);
  if (!existing) throw new Error(`Unknown colony: ${name}`);
  const updated: ColonyRecord = { ...existing };
  if (patch.description !== undefined) {
    if (patch.description === "") delete updated.description;
    else updated.description = patch.description;
  }
  await saveColony(updated);
  await appendLedger({ type: "colony.update", name });
  return updated;
}

export async function renameColony(oldName: string, newName: string): Promise<ColonyRecord> {
  if (!validColonyName(newName)) throw new Error(`Invalid colony name: ${newName}. Use alphanumerics, dashes, and underscores.`);
  const existing = await loadColony(oldName);
  if (!existing) throw new Error(`Unknown colony: ${oldName}`);
  if (oldName === newName) return existing;
  if (await loadColony(newName)) throw new Error(`Colony already exists: ${newName}`);
  const updated: ColonyRecord = { ...existing, name: newName };
  await saveColony(updated);
  await rm(colonyPath(oldName), { force: true });
  await appendLedger({ type: "colony.rename", from: oldName, to: newName });
  return updated;
}

export async function archiveColony(name: string): Promise<ColonyRecord> {
  const existing = await loadColony(name);
  if (!existing) throw new Error(`Unknown colony: ${name}`);
  if (existing.archived) return existing;
  const updated: ColonyRecord = { ...existing, archived: true, archivedAt: new Date().toISOString() };
  await saveColony(updated);
  await appendLedger({ type: "colony.archive", name });
  return updated;
}

export async function saveColony(record: ColonyRecord): Promise<void> {
  await ensureDir();
  await atomicWriteFile(colonyPath(record.name), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function readColony(path: string): Promise<ColonyRecord> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid colony record at ${path}`);
  }
  const object = parsed as Record<string, unknown>;
  if (typeof object.name !== "string" || typeof object.createdAt !== "string") {
    throw new Error(`Invalid colony record at ${path}: missing name or createdAt`);
  }
  const record: ColonyRecord = {
    name: object.name,
    createdAt: object.createdAt,
  };
  if (object.archived === true) record.archived = true;
  if (typeof object.archivedAt === "string") record.archivedAt = object.archivedAt;
  if (typeof object.description === "string") record.description = object.description;
  return record;
}

async function ensureDir(): Promise<void> {
  await mkdir(coloniesDir(), { recursive: true });
}

function coloniesDir(): string {
  return join(storeRoot(), "colonies");
}

function colonyPath(name: string): string {
  return join(coloniesDir(), `${name}.json`);
}
