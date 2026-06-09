import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";

export type SessionRecord = {
  name: string;
  agent: string;
  cwd: string;
  command: string;
  tmuxTarget: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "dead" | "kill_failed";
  lastError?: string;
  notes?: string;
  id?: string;
  prefix?: string;
  uuid?: string;
  requestedAgent?: string;
  homePath?: string;
  lastPrompt?: string;
  lastPromptAt?: string;
  transcriptPath?: string;
  providerSessionId?: string;
  title?: string;
  colony?: string;
  swarmId?: string;
  caste?: string;
  brief?: string;
  briefedAt?: string;
  node?: string;
  buzAccept?: ("interrupt" | "queue" | "passive")[];
  lastObservedState?: string;
  lastObservedStateAt?: string;
  runId?: string;
  flowName?: string;
};

export { storeRoot } from "./fsx.js";

export async function ensureStore() {
  await mkdir(sessionsDir(), { recursive: true });
}

function sessionLockPath(name: string): string {
  return join(storeRoot(), "sessions", `.${name}.lock`);
}

export async function withSessionLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(sessionLockPath(name), fn);
}

export async function saveSession(record: SessionRecord) {
  await ensureStore();
  await atomicWriteFile(recordPath(record.name), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await appendLedger({ type: "session.save", ...record });
}

/**
 * touchSession atomically merges a subset of fields into a session record without
 * appending a ledger entry. Designed for the daemon's per-tick `lastObservedState`
 * updates so we don't drown the ledger in noise. Callers MUST hold withSessionLock
 * around touchSession+saveSession for the same record to avoid torn writes; the
 * helper acquires the lock internally.
 *
 * Returns the merged record, or null when the record no longer exists on disk.
 */
export async function touchSession(name: string, fields: Partial<SessionRecord>): Promise<SessionRecord | null> {
  return withSessionLock(name, async () => {
    const existing = await loadSession(name);
    if (!existing) return null;
    const merged: SessionRecord = { ...existing, ...fields, name: existing.name };
    await atomicWriteFile(recordPath(existing.name), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    return merged;
  });
}

export async function loadSession(name: string): Promise<SessionRecord | null> {
  try {
    return await readSessionRecord(recordPath(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    return await readSessionRecord(legacyRecordPath(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function deleteSession(name: string) {
  await rm(recordPath(name), { force: true });
  await rm(legacyRecordPath(name), { force: true });
  await appendLedger({ type: "session.delete", name, ts: new Date().toISOString() });
}

export async function listSessions(): Promise<SessionRecord[]> {
  await ensureStore();
  const [files, legacyFiles] = await Promise.all([readdir(sessionsDir()), readdir(legacySessionsDir()).catch(() => [])]);
  const seen = new Set<string>();
  const records: SessionRecord[] = [];

  for (const [dir, dirFiles] of [[sessionsDir(), files], [legacySessionsDir(), legacyFiles]] as const) {
    for (const file of dirFiles.filter((name) => name.endsWith(".json"))) {
      if (seen.has(file)) continue;
      seen.add(file);
      const record = await readSessionRecord(join(dir, file)).catch(() => null);
      if (record) records.push(record);
    }
  }

  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function appendLedger(event: Record<string, unknown>) {
  await ensureStore();
  await withFileLock(`${ledgerPath()}.lock`, async () => {
    await rotateLedgerIfNeeded();
    await writeFile(ledgerPath(), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, { flag: "a", mode: 0o600 });
  });
}

function recordPath(name: string) {
  return join(sessionsDir(), `${safeName(name)}.json`);
}

function legacyRecordPath(name: string) {
  return join(legacySessionsDir(), `${safeName(name)}.json`);
}

export function safeName(value: string) {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-");
}

async function readSessionRecord(path: string): Promise<SessionRecord> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in session record ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeSessionRecord(parsed, path);
}

function normalizeSessionRecord(value: unknown, path: string): SessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid session record shape: ${path}`);
  const object = value as Record<string, unknown>;
  for (const key of ["name", "agent", "cwd", "command", "tmuxTarget", "createdAt", "updatedAt"]) {
    if (typeof object[key] !== "string") throw new Error(`Invalid session record ${path}: missing string ${key}`);
  }

  const record: SessionRecord = {
    name: object.name as string,
    agent: object.agent as string,
    cwd: object.cwd as string,
    command: object.command as string,
    tmuxTarget: object.tmuxTarget as string,
    createdAt: object.createdAt as string,
    updatedAt: object.updatedAt as string,
    status:
      object.status === "running" || object.status === "dead" || object.status === "kill_failed"
        ? object.status
        : "dead",
  };

  for (const key of ["notes", "id", "prefix", "uuid", "requestedAgent", "homePath", "lastPrompt", "lastPromptAt", "transcriptPath", "providerSessionId", "title", "colony", "swarmId", "caste", "brief", "briefedAt", "lastError", "node", "lastObservedState", "lastObservedStateAt", "runId", "flowName"] as const) {
    if (typeof object[key] === "string") record[key] = object[key];
  }

  // buzAccept is the per-bee acceptance policy for buz messages. The field
  // is forward-compatible: unknown tier values are dropped silently so an
  // older binary reading a record written by a newer one does not throw.
  if (Array.isArray(object.buzAccept)) {
    const tiers = object.buzAccept.filter(
      (value): value is "interrupt" | "queue" | "passive" =>
        value === "interrupt" || value === "queue" || value === "passive",
    );
    if (tiers.length > 0) record.buzAccept = tiers;
  }

  return record;
}

function legacyRoot() {
  if (process.env.HIVE_STORE_ROOT) return join(storeRoot(), "legacy-agentpit");
  return join(homedir(), ".agentpit");
}

function sessionsDir() {
  return join(storeRoot(), "sessions");
}

function legacySessionsDir() {
  return join(legacyRoot(), "sessions");
}

export function ledgerPath(): string {
  return join(storeRoot(), "ledger.jsonl");
}

async function rotateLedgerIfNeeded(): Promise<void> {
  const maxBytes = Number(process.env.HIVE_LEDGER_MAX_BYTES ?? 10 * 1024 * 1024);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
  const path = ledgerPath();
  const info = await stat(path).catch(() => null);
  if (!info || info.size < maxBytes) return;
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  await rename(path, `${path}.${suffix}`).catch(() => undefined);
}
