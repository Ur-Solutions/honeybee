import { randomBytes } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { appendLedger } from "./store.js";

export type SwarmRecord = {
  id: string;
  frame?: string;
  colony?: string;
  beeIds: string[];
  createdAt: string;
  destroyed?: boolean;
  destroyedAt?: string;
  description?: string;
};

const SWARM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function validSwarmId(id: string): boolean {
  return SWARM_ID_RE.test(id);
}

export function generateSwarmId(prefix?: string): string {
  const suffix = randomBytes(3).toString("hex");
  const base = prefix && SWARM_ID_RE.test(prefix) ? prefix : "swarm";
  return `${base}-${suffix}`;
}

export async function listSwarms(): Promise<SwarmRecord[]> {
  await ensureDir();
  const files = await readdir(swarmsDir()).catch(() => []);
  const records: SwarmRecord[] = [];
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const record = await readSwarm(join(swarmsDir(), file)).catch(() => null);
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadSwarm(id: string): Promise<SwarmRecord | null> {
  try {
    return await readSwarm(swarmPath(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function swarmIds(): Promise<Set<string>> {
  const swarms = await listSwarms();
  return new Set(swarms.map((s) => s.id));
}

export async function createSwarm(input: Omit<SwarmRecord, "createdAt">): Promise<SwarmRecord> {
  if (!validSwarmId(input.id)) throw new Error(`Invalid swarm id: ${input.id}`);
  const existing = await loadSwarm(input.id);
  if (existing) throw new Error(`Swarm already exists: ${input.id}`);
  const record: SwarmRecord = { ...input, createdAt: new Date().toISOString() };
  await saveSwarm(record);
  await appendLedger({ type: "swarm.create", id: record.id, frame: record.frame, colony: record.colony, beeCount: record.beeIds.length });
  return record;
}

export async function saveSwarm(record: SwarmRecord): Promise<void> {
  await ensureDir();
  await atomicWriteFile(swarmPath(record.id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export async function destroySwarm(id: string): Promise<SwarmRecord> {
  const existing = await loadSwarm(id);
  if (!existing) throw new Error(`Unknown swarm: ${id}`);
  if (existing.destroyed) return existing;
  const updated: SwarmRecord = { ...existing, destroyed: true, destroyedAt: new Date().toISOString() };
  await saveSwarm(updated);
  await appendLedger({ type: "swarm.destroy", id });
  return updated;
}

export async function removeSwarmRecord(id: string): Promise<void> {
  await rm(swarmPath(id), { force: true });
}

async function readSwarm(path: string): Promise<SwarmRecord> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid swarm record at ${path}`);
  }
  const object = parsed as Record<string, unknown>;
  if (typeof object.id !== "string" || typeof object.createdAt !== "string" || !Array.isArray(object.beeIds)) {
    throw new Error(`Invalid swarm record at ${path}: missing required fields`);
  }
  const record: SwarmRecord = {
    id: object.id,
    createdAt: object.createdAt,
    beeIds: object.beeIds.filter((id): id is string => typeof id === "string"),
  };
  if (typeof object.frame === "string") record.frame = object.frame;
  if (typeof object.colony === "string") record.colony = object.colony;
  if (object.destroyed === true) record.destroyed = true;
  if (typeof object.destroyedAt === "string") record.destroyedAt = object.destroyedAt;
  if (typeof object.description === "string") record.description = object.description;
  return record;
}

async function ensureDir(): Promise<void> {
  await mkdir(swarmsDir(), { recursive: true });
}

function swarmsDir(): string {
  return join(storeRoot(), "swarms");
}

function swarmPath(id: string): string {
  return join(swarmsDir(), `${id}.json`);
}
