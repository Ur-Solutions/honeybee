import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import { appendLedger } from "./store.js";
import { createWorkspace } from "./workspace.js";

export type ColonyRecord = {
  name: string;
  createdAt: string;
  archived?: boolean;
  archivedAt?: string;
  description?: string;
  /** The colony's canonical file root, inherited by its auto-workspace (lazy). */
  rootDir?: string;
  /** The name of the workspace auto-provisioned for this colony (= the colony name). */
  workspace?: string;
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
  // Validate before joining into a path so raw user input (`../escape`) can't
  // read arbitrary JSON files outside the colonies directory.
  if (!validColonyName(name)) return null;
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
  return withColoniesLock(async () => {
    const existing = await loadColony(name);
    if (existing) throw new Error(`Colony already exists: ${name}`);
    const record: ColonyRecord = {
      name,
      createdAt: new Date().toISOString(),
      ...(description ? { description } : {}),
    };
    await saveColony(record);
    await appendLedger({ type: "colony.create", name });
    // Auto-provision the colony's workspace (PRD §7.2). rootDir stays empty —
    // it is resolved lazily on first `hive workspace open <colony>`. Best-effort:
    // a workspace failure must never abort colony creation.
    try {
      await createWorkspace({ name, rootDir: "", members: [], colony: name });
      record.workspace = name;
      await saveColony(record);
    } catch {
      // log-and-continue: the colony still exists; the workspace can be
      // (re)created on first open. We deliberately swallow a pre-existing
      // workspace or any provisioning hiccup here.
    }
    return record;
  });
}

export async function updateColony(name: string, patch: { description?: string }): Promise<ColonyRecord> {
  if (!validColonyName(name)) throw new Error(`Invalid colony name: ${name}. Use alphanumerics, dashes, and underscores.`);
  return withColoniesLock(async () => {
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
  });
}

export async function renameColony(oldName: string, newName: string): Promise<ColonyRecord> {
  if (!validColonyName(oldName)) throw new Error(`Invalid colony name: ${oldName}. Use alphanumerics, dashes, and underscores.`);
  if (!validColonyName(newName)) throw new Error(`Invalid colony name: ${newName}. Use alphanumerics, dashes, and underscores.`);
  return withColoniesLock(async () => {
    const existing = await loadColony(oldName);
    if (!existing) throw new Error(`Unknown colony: ${oldName}`);
    if (oldName === newName) return existing;
    if (await loadColony(newName)) throw new Error(`Colony already exists: ${newName}`);
    const updated: ColonyRecord = { ...existing, name: newName };
    // Write the new record before removing the old one: a crash in between
    // leaves the colony alive under both names (an easily deleted duplicate),
    // whereas delete-first would lose the record entirely on a failed write.
    await saveColony(updated);
    await rm(colonyPath(oldName), { force: true });
    await appendLedger({ type: "colony.rename", from: oldName, to: newName });
    return updated;
  });
}

export async function archiveColony(name: string): Promise<ColonyRecord> {
  if (!validColonyName(name)) throw new Error(`Invalid colony name: ${name}. Use alphanumerics, dashes, and underscores.`);
  return withColoniesLock(async () => {
    const existing = await loadColony(name);
    if (!existing) throw new Error(`Unknown colony: ${name}`);
    if (existing.archived) return existing;
    const updated: ColonyRecord = { ...existing, archived: true, archivedAt: new Date().toISOString() };
    await saveColony(updated);
    await appendLedger({ type: "colony.archive", name });
    return updated;
  });
}

// Serialize colony mutations behind one lock so two concurrent check-then-write
// sequences (e.g. duplicate `hive colony create` calls) can't both succeed.
async function withColoniesLock<T>(fn: () => Promise<T>): Promise<T> {
  return withFileLock(join(coloniesDir(), ".colonies.lock"), fn);
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
  // A record whose embedded name disagrees with its file stem is debris (e.g.
  // a hand-copied file); treating it as live would create phantom duplicates.
  const stem = basename(path).replace(/\.json$/, "");
  if (object.name !== stem) {
    throw new Error(`Invalid colony record at ${path}: name ${object.name} does not match file name`);
  }
  const record: ColonyRecord = {
    name: object.name,
    createdAt: object.createdAt,
  };
  if (object.archived === true) record.archived = true;
  if (typeof object.archivedAt === "string") record.archivedAt = object.archivedAt;
  if (typeof object.description === "string") record.description = object.description;
  // Additive allow-list (the §10 lesson): a new string field is silently dropped
  // on load unless it is explicitly carried through.
  if (typeof object.rootDir === "string") record.rootDir = object.rootDir;
  if (typeof object.workspace === "string") record.workspace = object.workspace;
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
