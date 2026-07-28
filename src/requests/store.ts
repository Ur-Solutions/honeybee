/**
 * Durable InterventionRequest store (docs/INTERVENTION_REQUESTS.md, ADR 001).
 *
 * One JSON doc per bee at ~/.hive/requests/<safeName(bee)>.json holding the
 * open requests plus a bounded closed history. Every mutation runs
 * lock → read → mutate → prune → atomicWriteFile → compact ledger row; reads
 * are lock-free and tolerant of a missing or corrupt file.
 *
 * Core invariants:
 *   - openRequest is IDEMPOTENT on id across ALL statuses: an existing record
 *     (open, resolved, or cancelled) is a no-op — a closed request is never
 *     resurrected by re-derived evidence (restart safety).
 *   - resolve/cancel/markRouted transition only from `open`; anything else is
 *     a no-op, never an error.
 *   - Opens are never pruned. Closed records keep the newest
 *     HIVE_REQUESTS_KEEP_CLOSED (default 50) per bee PLUS anything closed
 *     within the last 24h, so a restarted daemon re-deriving the same
 *     evidence still finds the closed record that suppresses a re-open.
 */

import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, storeRoot } from "../fsx.js";
import { withFileLock } from "../lock.js";
import { appendLedger, safeName } from "../store.js";

export const REQUEST_STORE_VERSION = 1 as const;

/** Default bound on retained closed records per bee (env-tunable). */
export const DEFAULT_REQUESTS_KEEP_CLOSED = 50;

/** Closed records younger than this survive pruning regardless of the count cap. */
const CLOSED_RETENTION_MS = 24 * 60 * 60 * 1000;

export type InterventionRequestKind = "question" | "permission" | "auth" | "manual-action";
export type InterventionRequestStatus = "open" | "resolved" | "cancelled";
export type InterventionRequestScope = "turn" | "runtime-generation" | "bee";
export type InterventionRequestGrade = "structured" | "observer";
export type InterventionRequestCancelReason = "scope-closed" | "superseded";

export type InterventionRequestEvidence = {
  grade: InterventionRequestGrade;
  /** Machine-readable origin, e.g. "hsr-events", "session-record". */
  source: string;
  /** ISO timestamp of the underlying observation, when the source carries one. */
  observedAt?: string;
  /** Free-text pointer for debugging (event type, matched rule). */
  detail?: string;
};

export type InterventionRequestRecord = {
  /** Durable idempotency key (src/requests/keys.ts — shared with the live view). */
  id: string;
  bee: string;
  kind: InterventionRequestKind;
  status: InterventionRequestStatus;
  scope: InterventionRequestScope;
  /** This slice writes structured (and structured-grade manual facts) only. */
  grade: InterventionRequestGrade;
  /** record.runtimeGeneration ?? 0 at open time. */
  generation: number;
  /** ISO. ALWAYS present: the source event's ts when it carries one, else write time. */
  openedAt: string;
  updatedAt: string;
  /** Structured needs_input payload pass-through (hsr/observe.ts PendingNeedsInput). */
  question?: string;
  tool?: string;
  options?: string[];
  optionDetails?: unknown;
  questions?: unknown;
  multiSelect?: boolean;
  input?: unknown;
  evidence: InterventionRequestEvidence;
  /** Needs-input dispatcher routing state (set once, while open). */
  routedTo?: string;
  routedAt?: string;
  escalated?: boolean;
  escalatedAt?: string;
  resolvedAt?: string;
  /** "hive-answer" | "hive-answer:<caller-bee>" | "auth-resume" | "stop-succeeded". */
  resolvedBy?: string;
  /** Answer text, capped ~500 chars. */
  resolution?: string;
  cancelledAt?: string;
  cancelReason?: InterventionRequestCancelReason;
  cancelDetail?: string;
};

export type BeeRequestFile = {
  version: typeof REQUEST_STORE_VERSION;
  bee: string;
  requests: InterventionRequestRecord[];
};

export type OpenRequestInput = {
  id: string;
  kind: InterventionRequestKind;
  scope: InterventionRequestScope;
  grade?: InterventionRequestGrade;
  generation: number;
  /** ISO of the grounding event when the source carries one; else write time is used. */
  openedAt?: string;
  question?: string;
  tool?: string;
  options?: string[];
  optionDetails?: unknown;
  questions?: unknown;
  multiSelect?: boolean;
  input?: unknown;
  evidence: InterventionRequestEvidence;
};

export type OpenRequestOutcome = {
  /** False = a record with this id already existed (in ANY status); nothing was written. */
  created: boolean;
  record: InterventionRequestRecord;
};

export type ResolveRequestOptions = {
  by: string;
  resolution?: string;
};

export type CancelOpenRequestsFilter = {
  /** Cancel only open records with generation STRICTLY below this. */
  beforeGeneration?: number;
  kinds?: InterventionRequestKind[];
  scopes?: InterventionRequestScope[];
};

export function requestsRoot(): string {
  return join(storeRoot(), "requests");
}

function requestFilePath(bee: string): string {
  return join(requestsRoot(), `${safeName(bee)}.json`);
}

function requestLockPath(bee: string): string {
  return join(requestsRoot(), `.${safeName(bee)}.lock`);
}

function keepClosedLimit(): number {
  const raw = Number(process.env.HIVE_REQUESTS_KEEP_CLOSED ?? DEFAULT_REQUESTS_KEEP_CLOSED);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_REQUESTS_KEEP_CLOSED;
}

function parseRequestFile(raw: string, bee: string): BeeRequestFile | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const object = parsed as Record<string, unknown>;
    if (object.version !== REQUEST_STORE_VERSION || !Array.isArray(object.requests)) return null;
    const requests = object.requests.filter(
      (entry): entry is InterventionRequestRecord =>
        !!entry && typeof entry === "object" && !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).id === "string" &&
        typeof (entry as Record<string, unknown>).status === "string",
    );
    return { version: REQUEST_STORE_VERSION, bee: typeof object.bee === "string" ? object.bee : bee, requests };
  } catch {
    return null;
  }
}

async function readRequestFile(bee: string): Promise<BeeRequestFile> {
  const empty: BeeRequestFile = { version: REQUEST_STORE_VERSION, bee, requests: [] };
  let raw: string;
  try {
    raw = await readFile(requestFilePath(bee), "utf8");
  } catch {
    return empty;
  }
  return parseRequestFile(raw, bee) ?? empty;
}

/** Lock-free read; [] on a missing or corrupt file. */
export async function readBeeRequests(bee: string): Promise<InterventionRequestRecord[]> {
  return (await readRequestFile(bee)).requests;
}

/**
 * Bees with a request file, from one readdir. Entries are the on-disk stems —
 * safeName(bee) — so gate membership checks with safeName(name).
 */
export async function listBeesWithRequests(): Promise<string[]> {
  const entries = await readdir(requestsRoot()).catch(() => [] as string[]);
  return entries
    .filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))
    .map((entry) => entry.slice(0, -".json".length));
}

function closedAtMs(record: InterventionRequestRecord): number {
  const at = record.resolvedAt ?? record.cancelledAt ?? record.updatedAt;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Retention, applied inside every locked write: opens are never pruned;
 * closed records keep the newest `keepClosedLimit()` per bee plus anything
 * closed within the last 24h (union). Relative order is preserved.
 */
function pruneRequests(requests: InterventionRequestRecord[], nowMs: number): InterventionRequestRecord[] {
  const closed = requests.filter((record) => record.status !== "open");
  const limit = keepClosedLimit();
  if (closed.length <= limit) return requests;
  const newestFirst = [...closed].sort((a, b) => closedAtMs(b) - closedAtMs(a));
  const keep = new Set(newestFirst.slice(0, limit));
  for (const record of newestFirst.slice(limit)) {
    if (nowMs - closedAtMs(record) < CLOSED_RETENTION_MS) keep.add(record);
  }
  return requests.filter((record) => record.status === "open" || keep.has(record));
}

type MutationResult<T> = {
  outcome: T;
  /** Null = nothing changed; skip the write and the ledger rows. */
  next: InterventionRequestRecord[] | null;
  ledger: Array<Record<string, unknown>>;
};

/** lock → read → mutate → prune → atomic write → compact ledger rows. */
async function mutateRequestFile<T>(
  bee: string,
  mutate: (requests: InterventionRequestRecord[], nowIso: string) => MutationResult<T>,
): Promise<T> {
  return withFileLock(requestLockPath(bee), async () => {
    const file = await readRequestFile(bee);
    const nowIso = new Date().toISOString();
    const { outcome, next, ledger } = mutate(file.requests, nowIso);
    if (next !== null) {
      const pruned = pruneRequests(next, Date.parse(nowIso));
      const doc: BeeRequestFile = { version: REQUEST_STORE_VERSION, bee: file.bee, requests: pruned };
      await atomicWriteFile(requestFilePath(bee), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
      for (const row of ledger) await appendLedger(row);
    }
    return outcome;
  });
}

function buildRecord(bee: string, input: OpenRequestInput, nowIso: string): InterventionRequestRecord {
  return {
    id: input.id,
    bee,
    kind: input.kind,
    status: "open",
    scope: input.scope,
    grade: input.grade ?? "structured",
    generation: input.generation,
    openedAt: input.openedAt ?? nowIso,
    updatedAt: nowIso,
    ...(input.question !== undefined ? { question: input.question } : {}),
    ...(input.tool !== undefined ? { tool: input.tool } : {}),
    ...(input.options !== undefined ? { options: input.options } : {}),
    ...(input.optionDetails !== undefined ? { optionDetails: input.optionDetails } : {}),
    ...(input.questions !== undefined ? { questions: input.questions } : {}),
    ...(input.multiSelect !== undefined ? { multiSelect: input.multiSelect } : {}),
    ...(input.input !== undefined ? { input: input.input } : {}),
    evidence: input.evidence,
  };
}

function openLedgerRow(record: InterventionRequestRecord): Record<string, unknown> {
  return {
    type: "request.open",
    session: record.bee,
    id: record.id,
    kind: record.kind,
    scope: record.scope,
    generation: record.generation,
  };
}

function resolveLedgerRow(record: InterventionRequestRecord): Record<string, unknown> {
  return { type: "request.resolve", session: record.bee, id: record.id, by: record.resolvedBy };
}

function cancelLedgerRow(record: InterventionRequestRecord): Record<string, unknown> {
  return {
    type: "request.cancel",
    session: record.bee,
    id: record.id,
    reason: record.cancelReason,
    ...(record.cancelDetail ? { detail: record.cancelDetail } : {}),
  };
}

const RESOLUTION_MAX_CHARS = 500;

function resolvedCopy(
  record: InterventionRequestRecord,
  options: ResolveRequestOptions,
  nowIso: string,
): InterventionRequestRecord {
  return {
    ...record,
    status: "resolved",
    updatedAt: nowIso,
    resolvedAt: nowIso,
    resolvedBy: options.by,
    ...(options.resolution !== undefined ? { resolution: options.resolution.slice(0, RESOLUTION_MAX_CHARS) } : {}),
  };
}

function cancelledCopy(
  record: InterventionRequestRecord,
  reason: InterventionRequestCancelReason,
  detail: string | undefined,
  nowIso: string,
): InterventionRequestRecord {
  return {
    ...record,
    status: "cancelled",
    updatedAt: nowIso,
    cancelledAt: nowIso,
    cancelReason: reason,
    ...(detail !== undefined ? { cancelDetail: detail } : {}),
  };
}

/**
 * Open a request. IDEMPOTENT on id across ALL statuses: an existing record —
 * open, resolved, or cancelled — is a no-op (created:false) whose payload is
 * NOT clobbered. This is the no-resurrection rule: re-derived evidence can
 * never re-open a request a human already resolved or a scope change closed.
 */
export async function openRequest(bee: string, input: OpenRequestInput): Promise<OpenRequestOutcome> {
  return mutateRequestFile<OpenRequestOutcome>(bee, (requests, nowIso) => {
    const existing = requests.find((record) => record.id === input.id);
    if (existing) return { outcome: { created: false, record: existing }, next: null, ledger: [] };
    const record = buildRecord(bee, input, nowIso);
    return { outcome: { created: true, record }, next: [...requests, record], ledger: [openLedgerRow(record)] };
  });
}

/**
 * Resolve an OPEN request. Closed or missing → no-op (null). open→resolved is
 * the only transition; a cancelled record stays cancelled.
 */
export async function resolveRequest(
  bee: string,
  id: string,
  options: ResolveRequestOptions,
): Promise<InterventionRequestRecord | null> {
  return mutateRequestFile<InterventionRequestRecord | null>(bee, (requests, nowIso) => {
    const existing = requests.find((record) => record.id === id);
    if (!existing || existing.status !== "open") return { outcome: null, next: null, ledger: [] };
    const resolved = resolvedCopy(existing, options, nowIso);
    return {
      outcome: resolved,
      next: requests.map((record) => (record.id === id ? resolved : record)),
      ledger: [resolveLedgerRow(resolved)],
    };
  });
}

/**
 * Open-and-resolve in ONE locked write — the daemon-down `hive answer` path:
 * no open record exists yet (the daemon never observed the needs_input), but
 * the answer landed, so the durable fact is a resolved record under the same
 * id the live view derived. An existing open record is resolved; an existing
 * closed record is left untouched (no-resurrection).
 */
export async function openAndResolveRequest(
  bee: string,
  input: OpenRequestInput,
  options: ResolveRequestOptions,
): Promise<InterventionRequestRecord | null> {
  return mutateRequestFile<InterventionRequestRecord | null>(bee, (requests, nowIso) => {
    const existing = requests.find((record) => record.id === input.id);
    if (existing) {
      if (existing.status !== "open") return { outcome: null, next: null, ledger: [] };
      const resolved = resolvedCopy(existing, options, nowIso);
      return {
        outcome: resolved,
        next: requests.map((record) => (record.id === input.id ? resolved : record)),
        ledger: [resolveLedgerRow(resolved)],
      };
    }
    const resolved = resolvedCopy(buildRecord(bee, input, nowIso), options, nowIso);
    return {
      outcome: resolved,
      next: [...requests, resolved],
      ledger: [openLedgerRow(resolved), resolveLedgerRow(resolved)],
    };
  });
}

/** Cancel an OPEN request. Closed or missing → no-op (null). */
export async function cancelRequest(
  bee: string,
  id: string,
  reason: InterventionRequestCancelReason,
  detail?: string,
): Promise<InterventionRequestRecord | null> {
  return mutateRequestFile<InterventionRequestRecord | null>(bee, (requests, nowIso) => {
    const existing = requests.find((record) => record.id === id);
    if (!existing || existing.status !== "open") return { outcome: null, next: null, ledger: [] };
    const cancelled = cancelledCopy(existing, reason, detail, nowIso);
    return {
      outcome: cancelled,
      next: requests.map((record) => (record.id === id ? cancelled : record)),
      ledger: [cancelLedgerRow(cancelled)],
    };
  });
}

/** Cancel every OPEN request matching the filter, in one locked write. */
export async function cancelOpenRequests(
  bee: string,
  filter: CancelOpenRequestsFilter,
  reason: InterventionRequestCancelReason,
  detail?: string,
): Promise<InterventionRequestRecord[]> {
  return mutateRequestFile<InterventionRequestRecord[]>(bee, (requests, nowIso) => {
    const matches = (record: InterventionRequestRecord): boolean =>
      record.status === "open" &&
      (filter.beforeGeneration === undefined || record.generation < filter.beforeGeneration) &&
      (filter.kinds === undefined || filter.kinds.includes(record.kind)) &&
      (filter.scopes === undefined || filter.scopes.includes(record.scope));
    const cancelled: InterventionRequestRecord[] = [];
    const next = requests.map((record) => {
      if (!matches(record)) return record;
      const copy = cancelledCopy(record, reason, detail, nowIso);
      cancelled.push(copy);
      return copy;
    });
    if (cancelled.length === 0) return { outcome: [], next: null, ledger: [] };
    return { outcome: cancelled, next, ledger: cancelled.map(cancelLedgerRow) };
  });
}

export type MarkRequestRoutedInput = { routedTo: string } | { escalated: true };

/**
 * Record the needs-input dispatcher's routing outcome — ONLY while the
 * request is open (a resolved/cancelled request is never routed). Setting
 * either field is once-only: an already-routed/escalated record is a no-op,
 * which is what makes routing exactly-once across daemon restarts.
 */
export async function markRequestRouted(
  bee: string,
  id: string,
  input: MarkRequestRoutedInput,
): Promise<InterventionRequestRecord | null> {
  return mutateRequestFile<InterventionRequestRecord | null>(bee, (requests, nowIso) => {
    const existing = requests.find((record) => record.id === id);
    if (!existing || existing.status !== "open") return { outcome: null, next: null, ledger: [] };
    if (existing.routedAt !== undefined || existing.escalated === true) return { outcome: null, next: null, ledger: [] };
    const routed: InterventionRequestRecord = {
      ...existing,
      updatedAt: nowIso,
      ...("routedTo" in input
        ? { routedTo: input.routedTo, routedAt: nowIso }
        : { escalated: true, escalatedAt: nowIso }),
    };
    return {
      outcome: routed,
      next: requests.map((record) => (record.id === id ? routed : record)),
      // Routing is dispatcher bookkeeping, not a status transition — the
      // needs_input.route daemon-log row covers observability.
      ledger: [],
    };
  });
}

/** Delete the bee's whole request file (kill is PURGE; retire keeps it). */
export async function removeBeeRequests(bee: string): Promise<void> {
  await withFileLock(requestLockPath(bee), async () => {
    await rm(requestFilePath(bee), { force: true });
  });
}

/**
 * New-incarnation closure (revive/promote/demote/swap/set-model): cancel every
 * open request from generations before `newGeneration` as superseded. Called
 * next to each nextRuntimeIncarnationPatch application; the daemon reconciler
 * backstops missed calls via the same generation comparison.
 */
export async function closeRequestsForNewIncarnation(
  bee: string,
  newGeneration: number,
): Promise<InterventionRequestRecord[]> {
  return cancelOpenRequests(
    bee,
    { beforeGeneration: newGeneration },
    "superseded",
    `superseded by generation ${newGeneration}`,
  );
}
