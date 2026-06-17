import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { withFileLock } from "./lock.js";
import { dedupeTags, isValidSessionTag, MAX_TAGS_PER_BEE } from "./tags.js";

export type SessionRecord = {
  name: string;
  agent: string;
  cwd: string;
  command: string;
  tmuxTarget: string;
  /**
   * The tmux pane id (e.g. "%7") this bee's agent actually runs in. Pins all
   * agent I/O and liveness to that pane instead of "whatever pane is active",
   * so splitting/adding panes no longer hijacks the bee. Absent on legacy
   * records → they keep the active-pane fallback.
   */
  agentPaneId?: string;
  /**
   * The comb (tmux session) this bee shares. For a solo bee this equals
   * tmuxTarget; sub-bees split into the same comb share the parent's combId.
   * (fork-and-pane Phase B)
   */
  combId?: string;
  /** The bee this one was split from (intra-comb lineage). (Phase B) */
  parentId?: string;
  /** Operator-set owned-by/reports-to edge → target bee id. (Tags PRD Phase 2) */
  reportsToId?: string;
  /**
   * Cross-comb fork lineage → source bee id. Written later by fork-and-pane
   * Phase C; added now so `forks-of:` can read it. (Tags PRD Phase 2)
   */
  forkedFromId?: string;
  /**
   * Free-form user tags (first-class). Holds ONLY bare or power-user-namespaced
   * labels, e.g. ["migration", "waiting-review", "prio:p1"]. Reserved-namespace
   * tags (colony:/swarm:/…) are NEVER stored here — they are derived on read by
   * src/tags.ts effectiveTags(). (TAGS_AND_RELATIONSHIPS_PRD Phase 1)
   */
  tags?: string[];
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
  /** Who set `title`: user beats auto beats provider (see naming.ts). */
  titleSource?: "user" | "auto" | "provider";
  /** Timestamp of the auto-titler's most recent attempt (claim + backoff key). */
  autoTitleAt?: string;
  /** How many times the auto-titler has attempted this bee (retry cap). */
  autoTitleAttempts?: number;
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
  /** Vault account bound to this bee's home (Phase 3 identity layer). */
  accountId?: string;
  /** Opt-in: the daemon's autoswap dispatcher may swap accounts on exhaustion. */
  autoswap?: boolean;
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
  // Serialize against touchSession/updateSession so a concurrent merge can't
  // interleave with this full-record overwrite.
  await withSessionLock(record.name, async () => {
    await saveSessionLocked(record);
  });
}

/**
 * Write a full record WITHOUT acquiring the session lock. Only for callers
 * already inside withSessionLock for the same record — the lock is not
 * reentrant, so calling saveSession there would deadlock.
 */
export async function saveSessionLocked(record: SessionRecord) {
  await ensureStore();
  await atomicWriteFile(recordPath(record.name), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await appendLedger(compactSaveEvent(record));
}

// The ledger keeps a compact audit row per save instead of the full record:
// brief/lastPrompt can be kilobytes each, and `hive search` only filters
// ledger lines on name/colony/swarmId (plus the always-present ts).
function compactSaveEvent(record: SessionRecord): Record<string, unknown> {
  return {
    type: "session.save",
    name: record.name,
    status: record.status,
    updatedAt: record.updatedAt,
    ...(record.id ? { id: record.id } : {}),
    ...(record.agent ? { agent: record.agent } : {}),
    ...(record.colony ? { colony: record.colony } : {}),
    ...(record.swarmId ? { swarmId: record.swarmId } : {}),
    ...(record.title ? { title: record.title } : {}),
  };
}

// How often a pure `lastObservedStateAt` heartbeat is allowed to hit disk.
// The daemon touches every session every ~2s; without this gate each tick
// rewrites every record file even when nothing observable changed.
const TOUCH_HEARTBEAT_MS = 60_000;

/**
 * touchSession atomically merges a subset of fields into a session record without
 * appending a ledger entry. Designed for the daemon's per-tick `lastObservedState`
 * updates so we don't drown the ledger in noise. touchSession is self-locking
 * (it acquires withSessionLock internally, and the lock is NOT reentrant) — do
 * not wrap calls to it in withSessionLock for the same record or they deadlock.
 *
 * Writes are skipped when the merge changes nothing but `lastObservedStateAt`,
 * unless the stored timestamp is older than TOUCH_HEARTBEAT_MS.
 *
 * Returns the merged record, or null when the record no longer exists on disk.
 */
export async function touchSession(name: string, fields: Partial<SessionRecord>): Promise<SessionRecord | null> {
  return mergeSessionFields(name, fields, { skipNoopWrites: true });
}

/**
 * updateSession is the locked read-merge-write counterpart to saveSession for
 * callers that mutate a few fields: it re-reads the record under the session
 * lock, applies the patch field-level, and persists the result, so concurrent
 * writers (e.g. the daemon's touchSession) can't be clobbered by a stale
 * load→modify→save cycle. Appends a compact ledger row like saveSession.
 *
 * Returns the merged record, or null when the record no longer exists on disk.
 */
export async function updateSession(name: string, patch: Partial<SessionRecord>): Promise<SessionRecord | null> {
  const merged = await mergeSessionFields(name, patch);
  if (merged) await appendLedger(compactSaveEvent(merged));
  return merged;
}

async function mergeSessionFields(
  name: string,
  fields: Partial<SessionRecord>,
  options: { skipNoopWrites?: boolean } = {},
): Promise<SessionRecord | null> {
  return withSessionLock(name, async () => {
    const existing = await loadSession(name);
    if (!existing) return null;
    const merged: SessionRecord = { ...existing, ...fields, name: existing.name };
    if (options.skipNoopWrites && sessionFingerprint(existing) === sessionFingerprint(merged)) {
      if (existing.lastObservedStateAt === merged.lastObservedStateAt) return merged;
      const previousAt = Date.parse(existing.lastObservedStateAt ?? "");
      const nextAt = Date.parse(merged.lastObservedStateAt ?? "");
      if (Number.isFinite(previousAt) && Number.isFinite(nextAt) && nextAt - previousAt < TOUCH_HEARTBEAT_MS) {
        return merged;
      }
    }
    await atomicWriteFile(recordPath(existing.name), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    return merged;
  });
}

// Order-insensitive serialization of every persisted field except the
// `lastObservedStateAt` heartbeat, used to detect no-op touches.
function sessionFingerprint(record: SessionRecord): string {
  const entries = Object.entries(record as Record<string, unknown>)
    .filter(([key, value]) => key !== "lastObservedStateAt" && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
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
  // Take the session lock so an in-flight touchSession/updateSession (the
  // daemon persists observed state constantly) can't recreate the record file
  // right after we remove it, resurrecting a zombie bee in `hive ls`.
  await withSessionLock(name, async () => {
    await rm(recordPath(name), { force: true });
    await rm(legacyRecordPath(name), { force: true });
  });
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

const OPTIONAL_STRING_SESSION_KEYS = ["notes", "id", "prefix", "uuid", "requestedAgent", "homePath", "lastPrompt", "lastPromptAt", "transcriptPath", "providerSessionId", "title", "autoTitleAt", "colony", "swarmId", "caste", "brief", "briefedAt", "lastError", "node", "lastObservedState", "lastObservedStateAt", "runId", "flowName", "accountId", "agentPaneId", "combId", "parentId", "reportsToId", "forkedFromId"] as const;

const KNOWN_SESSION_KEYS = new Set<string>([
  "name", "agent", "cwd", "command", "tmuxTarget", "createdAt", "updatedAt", "status",
  ...OPTIONAL_STRING_SESSION_KEYS,
  "titleSource",
  "autoTitleAttempts",
  "buzAccept",
  "tags",
]);

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

  for (const key of OPTIONAL_STRING_SESSION_KEYS) {
    if (typeof object[key] === "string") record[key] = object[key];
  }

  if (object.autoswap === true) record.autoswap = true;

  if (object.titleSource === "user" || object.titleSource === "auto" || object.titleSource === "provider") {
    record.titleSource = object.titleSource;
  }

  if (typeof object.autoTitleAttempts === "number" && Number.isFinite(object.autoTitleAttempts)) {
    record.autoTitleAttempts = object.autoTitleAttempts;
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

  // tags is the array of free-form user labels (bare or power-user namespaced,
  // e.g. ["migration", "prio:p1"]). Like buzAccept, it is forward-compatible:
  // grammar-invalid OR reserved-namespace entries are DROPPED on load — not
  // thrown — so a hand-edited file that smuggles `colony:x` into tags, or a
  // record written by a newer binary, never crashes a load (PRD §13, S1). The
  // list is deduped and capped (MAX_TAGS_PER_BEE).
  if (Array.isArray(object.tags)) {
    const validated = dedupeTags(
      object.tags.filter((item): item is string => typeof item === "string").filter((tag) => isValidSessionTag(tag)),
    ).slice(0, MAX_TAGS_PER_BEE);
    if (validated.length > 0) record.tags = validated;
  }

  // Carry unknown keys through untouched so an older binary's load→save cycle
  // does not destroy fields written by a newer version. They ride along as
  // extra runtime properties (invisible to the SessionRecord type) and are
  // serialized back out on the next save.
  for (const [key, raw] of Object.entries(object)) {
    if (!KNOWN_SESSION_KEYS.has(key)) (record as Record<string, unknown>)[key] = raw;
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
  await pruneLedgerRotations();
}

// Rotation suffixes are ISO timestamps with `:`/`.` replaced by `-`, e.g.
// `ledger.jsonl.2026-06-10T12-34-56-789Z`. The strict pattern keeps the lock
// file (`ledger.jsonl.lock`) and stray temp files out of the prune sweep.
const LEDGER_ROTATION_SUFFIX_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

const DEFAULT_LEDGER_KEEP_ROTATIONS = 5;

async function pruneLedgerRotations(): Promise<void> {
  const keep = Number(process.env.HIVE_LEDGER_KEEP_ROTATIONS ?? DEFAULT_LEDGER_KEEP_ROTATIONS);
  if (!Number.isFinite(keep) || keep < 0) return;
  const path = ledgerPath();
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  const entries = await readdir(dir).catch(() => [] as string[]);
  const rotations = entries
    .filter((entry) => entry.startsWith(prefix) && LEDGER_ROTATION_SUFFIX_RE.test(entry.slice(prefix.length)))
    .sort()
    .reverse();
  for (const stale of rotations.slice(Math.floor(keep))) {
    await rm(join(dir, stale), { force: true }).catch(() => undefined);
  }
}
