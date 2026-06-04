import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";

export type BeeIdentity = {
  id: string;
  prefix: string;
  uuid: string;
};

type IdIndex = {
  used: string[];
};

export type AllocateBeeIdentityOptions = {
  agent: string;
  requestedAgent: string;
  storeRoot?: string;
  uuid?: () => string;
};

const MIN_UUID_CHARS = 3;

export async function allocateBeeIdentity(options: AllocateBeeIdentityOptions): Promise<BeeIdentity> {
  const storeRoot = options.storeRoot ?? defaultStoreRoot();
  return withFileLock(join(storeRoot, "id-index.lock"), async () => {
    const index = await readIndex(storeRoot);
    const used = new Set(index.used.map(normalizeUuid));
    const prefix = beePrefix(options.agent, options.requestedAgent);
    const uuidFactory = options.uuid ?? randomUUID;

    for (let attempt = 0; attempt < 100_000; attempt += 1) {
      const uuid = normalizeUuid(uuidFactory());
      if (used.has(uuid)) continue;

      const length = shortestUnusedUuidPrefixLength(uuid, used);
      const next = { id: `${prefix}${uuid.slice(0, length)}`, prefix, uuid };
      await writeIndex(storeRoot, { used: [...used, uuid].sort() });
      return next;
    }

    throw new Error("Could not allocate a unique bee id after 100000 UUID attempts");
  });
}

export function beePrefix(agent: string, requestedAgent = agent): string {
  const requested = requestedAgent.trim().toLowerCase();
  const canonical = agent.trim().toLowerCase();
  if (requested && requested !== canonical) return `${initials(requested)}.`;
  if (canonical === "codex") return "CO.";
  if (canonical === "claude") return "CL.";
  return `${initials(canonical || requested || "bee")}.`;
}

export function shortestUniqueSessionPrefix<T extends { id?: string; uuid?: string; name?: string }>(records: T[], target: T): string {
  const full = fullReference(target);
  if (!full) return target.name ?? "";

  const minLength = target.id?.length ?? Math.min(full.length, MIN_UUID_CHARS);
  for (let length = minLength; length <= full.length; length += 1) {
    const prefix = full.slice(0, length);
    const matches = records.filter((record) => fullReference(record)?.startsWith(prefix));
    if (matches.length === 1 && matches[0] === target) return prefix;
  }

  return full;
}

export function matchesSessionReference(record: { id?: string; uuid?: string; name: string }, query: string): boolean {
  const normalized = query.trim();
  if (record.name === normalized) return true;
  const full = fullReference(record);
  const minLength = record.id?.length ?? 1;
  return Boolean(full?.startsWith(normalized) && normalized.length >= minLength);
}

export function highlightUniqueSessionReference<T extends { id?: string; uuid?: string; name?: string }>(
  records: T[],
  target: T,
  marker = { start: "\x1b[1m", end: "\x1b[22m" },
): string {
  const ref = shortestUniqueSessionPrefix(records, target);
  const split = ref.indexOf(".") + 1;
  const highlightStart = split > 0 ? split : 0;
  return `${ref.slice(0, highlightStart)}${marker.start}${ref.slice(highlightStart)}${marker.end}`;
}

function fullReference(record: { id?: string; uuid?: string; name?: string }): string | undefined {
  if (record.id) return record.uuid ? `${record.id}${record.uuid.slice(record.id.replace(/^[^.]*\./, "").length)}` : record.id;
  return record.name;
}

function shortestUnusedUuidPrefixLength(uuid: string, used: Set<string>): number {
  for (let length = MIN_UUID_CHARS; length <= uuid.length; length += 1) {
    const candidate = uuid.slice(0, length);
    if (![...used].some((existing) => existing.startsWith(candidate))) return length;
  }
  return uuid.length;
}

function initials(value: string): string {
  const cleaned = value.replace(/[^a-z0-9]/g, "").toUpperCase();
  return (cleaned || "BE").slice(0, 2).padEnd(2, "X");
}

function normalizeUuid(value: string): string {
  const normalized = value.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) throw new Error(`Invalid UUID: ${value}`);
  return normalized;
}

async function readIndex(storeRoot: string): Promise<IdIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath(storeRoot), "utf8")) as unknown;
    const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return { used: Array.isArray(object.used) ? object.used.map((value) => normalizeUuid(String(value))) : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { used: [] };
    throw error;
  }
}

async function writeIndex(root: string, index: IdIndex): Promise<void> {
  await atomicWriteFile(indexPath(root), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
}

function indexPath(root: string): string {
  return join(root, "id-index.json");
}

function defaultStoreRoot(): string {
  return storeRoot();
}
