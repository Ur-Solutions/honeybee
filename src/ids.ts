import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
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
  maxRetainedIds?: number;
};

const MIN_UUID_CHARS = 3;

// The index exists so a new short id never collides with an id that can still
// be referenced (live bees, recent scrollback). Retaining every uuid ever
// allocated made each spawn O(lifetime spawns) under the global lock, so
// retention is capped: entries are kept in allocation order and the oldest
// fall off once newer allocations exceed the cap. A short id only becomes
// reusable after this many newer allocations — far beyond any plausible
// number of concurrently live bees.
const MAX_RETAINED_IDS = 10_000;

export async function allocateBeeIdentity(options: AllocateBeeIdentityOptions): Promise<BeeIdentity> {
  const storeRoot = options.storeRoot ?? defaultStoreRoot();
  const maxRetained = options.maxRetainedIds ?? MAX_RETAINED_IDS;
  return withFileLock(join(storeRoot, "id-index.lock"), async () => {
    const index = await readIndex(storeRoot);
    const used = new Set(index.used);
    const prefix = beePrefix(options.agent, options.requestedAgent);
    const uuidFactory = options.uuid ?? randomUUID;

    for (let attempt = 0; attempt < 100_000; attempt += 1) {
      const uuid = normalizeUuid(uuidFactory());
      if (used.has(uuid)) continue;

      const length = shortestUnusedUuidPrefixLength(uuid, used);
      const retained = [...used, uuid];
      await writeIndex(storeRoot, { used: retained.length > maxRetained ? retained.slice(retained.length - maxRetained) : retained });
      return { id: `${prefix}${uuid.slice(0, length)}`, prefix, uuid };
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
  if (full?.startsWith(normalized) && normalized.length >= minLength) return true;
  // Also target by the suffix (UUID) portion of the id, e.g. `abc` (or `123`) for `CO.abc`.
  // The query must be at least as long as the displayed suffix so short, ambiguous
  // fragments don't resolve to a bee.
  const suffix = suffixReference(record);
  return Boolean(suffix && suffix.full.startsWith(normalized) && normalized.length >= suffix.display.length);
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

// The suffix is the part of an id after its agent prefix (e.g. `abc` for `CO.abc`).
// `display` is the shortest unique suffix shown to the user; `full` is the backing
// UUID (or the display suffix when no UUID is recorded) so longer queries still match.
function suffixReference(record: { id?: string; uuid?: string }): { display: string; full: string } | undefined {
  if (!record.id) return undefined;
  const display = record.id.replace(/^[^.]*\./, "");
  if (!display) return undefined;
  return { display, full: record.uuid ?? display };
}

// The shortest prefix no retained uuid starts with is one character past the
// longest prefix the candidate shares with any of them.
function shortestUnusedUuidPrefixLength(uuid: string, used: Set<string>): number {
  let longestShared = 0;
  for (const existing of used) {
    const limit = Math.min(existing.length, uuid.length);
    let shared = 0;
    while (shared < limit && existing[shared] === uuid[shared]) shared += 1;
    if (shared > longestShared) longestShared = shared;
    if (longestShared >= uuid.length) break;
  }
  return Math.min(uuid.length, Math.max(MIN_UUID_CHARS, longestShared + 1));
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
  const path = indexPath(storeRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { used: [] };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // A corrupt index must not brick spawning forever. Move the file aside for
    // post-mortem and start over; historical short ids may collide with future
    // allocations, but that beats a hive that can never spawn again.
    const aside = `${path}.corrupt-${Date.now()}`;
    await rename(path, aside).catch(() => undefined);
    console.error(`hive: id-index.json is corrupt (${error instanceof Error ? error.message : String(error)}); moved it to ${aside} and starting a fresh index`);
    return { used: [] };
  }

  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const used: string[] = [];
  if (Array.isArray(object.used)) {
    for (const value of object.used) {
      try {
        used.push(normalizeUuid(String(value)));
      } catch {
        // One malformed entry must not block allocation of every future id.
        console.error(`hive: skipping invalid id-index entry: ${String(value)}`);
      }
    }
  }
  return { used };
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
