/**
 * Checkout pools — hive-side core (CHECKOUT_POOLS_PRD §6.1–6.3).
 *
 * A pool is a named set of pre-cloned `pro co` checkouts that bees claim and
 * release. The ownership split (§4) keeps this module thin:
 *
 *   - pro owns config (branch/maxOccupancy/maxSize) and membership (the
 *     `checkouts/<repo>/<pool>-<n>` directories) — read via the porcelain
 *     bridge in proProjects.ts, never copied.
 *   - hive owns ONLY what cannot be derived: the round-robin cursor, in-flight
 *     claims, and parked members — one JSON file per pool under
 *     `~/.hive/pools/<key>.json` (colony.ts pattern: dir + file lock + atomic
 *     write). A genuinely absent file starts empty; an unreadable or corrupt
 *     file is never confused with absence because that could erase pending
 *     claims or parked truth and over-subscribe a checkout.
 *   - Occupancy is derived on read (§6.2): a member is inhabited by every bee
 *     whose SessionRecord.cwd realpath-prefixes the member path and whose local
 *     runtime is positively live. Display-terminal done/sealed state does not
 *     release capacity while that runtime survives.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { hsrPoolLivenessStrict } from "./hsr/observe.js";
import {
  inspectProcessGroupBirth,
  type ProcessIdentityVerdict,
} from "./hsr/processIdentity.js";
import { withFileLock } from "./lock.js";
import { LOCAL_NODE_NAME } from "./node.js";
import {
  extendProPool,
  invalidateProPoolCache,
  listProPools,
  listProRepoEntries,
  resolveProEntryForCwd,
  type ProPoolConfig,
  type ProPoolMember,
  type ProRepoEntry,
} from "./proProjects.js";
import { liveTargetKey, type StateContext } from "./state.js";
import { appendLedger, listSessionsStrict, type SessionRecord } from "./store.js";
import { observeLocalRuntimeSnapshot, type LocalRuntimeSnapshot } from "./substrates/local-tmux.js";

// ── durable pool record (§6.1) ───────────────────────────────────────────────

export type PoolClaim = {
  /** Unique claim id, so bind/release can target one claim among same-member peers. */
  id: string;
  /** Member number (the n of `<pool>-<n>`). */
  member: number;
  /** Member checkout path at claim time (members are enumerated from disk; this is a hint). */
  path: string;
  /** Bound after spawn returns the final bee name; absent while the spawn is in flight. */
  beeName?: string;
  claimedAt: string;
  /** The claim expires (stops counting toward occupancy) past this instant. */
  pendingUntil: string;
};

export type PoolRecord = {
  key: string;
  area: string;
  project: string;
  repo: string;
  pool: string;
  /** Optional colony association for selectors/UI. */
  colony?: string;
  /** Round-robin pointer: the last-allocated member number. */
  rrCursor: number;
  claims: PoolClaim[];
  /** Member numbers withheld from allocation (§6.5). */
  parked: number[];
};

/**
 * How long a claim bridges the allocation→SessionRecord gap before it expires
 * (§6.2, ~120s). Override with HIVE_POOL_CLAIM_TTL_MS (tests use a short TTL).
 */
export function poolClaimTtlMs(): number {
  const raw = Number(process.env.HIVE_POOL_CLAIM_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

const POOL_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `<area>-<project>-<repo>-<pool>` slug, e.g. trmd-honeybee-honeybee-core. */
export function poolKeyFor(facets: { area: string; project: string; repo: string; pool: string }): string {
  return [facets.area, facets.project, facets.repo, facets.pool].join("-");
}

export function validPoolKey(key: string): boolean {
  return POOL_KEY_RE.test(key);
}

function poolsDir(): string {
  return join(storeRoot(), "pools");
}

function poolPath(key: string): string {
  return join(poolsDir(), `${key}.json`);
}

/**
 * Serialize mutations per pool behind a file lock (the §7 guarantee: two
 * spawns racing one free member — the second allocator sees the first claim).
 * The timeout is generous because an allocation may hold the lock across a
 * `pro pool extend` clone.
 */
export async function withPoolLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Validate before constructing or creating the lock path. Persisted session
  // metadata is not trusted to provide a canonical pool key during purge.
  if (!validPoolKey(key)) throw new Error(`Invalid pool key: ${key}`);
  return withFileLock(join(poolsDir(), `.${key}.lock`), fn, { timeoutMs: 120_000 });
}

export function emptyPoolRecord(facets: { area: string; project: string; repo: string; pool: string }): PoolRecord {
  // Destructure explicitly: callers pass a full ResolvedPool, and spreading it
  // would persist derived state (repoPath/config/members) §6.1 forbids storing.
  const { area, project, repo, pool } = facets;
  return { key: poolKeyFor(facets), area, project, repo, pool, rrCursor: 0, claims: [], parked: [] };
}

/**
 * Load a pool record, or null only when none exists yet. Existing state is a
 * safety boundary: malformed JSON/claims are refused rather than reconstructed
 * because pending claims and parked members are not derivable from live bees.
 */
export async function loadPoolRecord(key: string): Promise<PoolRecord | null> {
  if (!validPoolKey(key)) return null;
  let raw: string;
  try {
    raw = await readFile(poolPath(key), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw corruptPoolRecord(key, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizePoolRecord(parsed, key);
}

function corruptPoolRecord(key: string, detail: string): Error {
  return new Error(`pool state ${poolPath(key)} is corrupt (${detail}); refusing to treat it as empty — restore or explicitly remove it`);
}

function requiredString(value: unknown, key: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw corruptPoolRecord(key, `${field} must be a non-empty string`);
  return value;
}

function normalizePoolRecord(value: unknown, key: string): PoolRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw corruptPoolRecord(key, "record must be an object");
  const object = value as Record<string, unknown>;
  if (object.key !== key) throw corruptPoolRecord(key, `stored key must equal ${key}`);
  const area = requiredString(object.area, key, "area");
  const project = requiredString(object.project, key, "project");
  const repo = requiredString(object.repo, key, "repo");
  const pool = requiredString(object.pool, key, "pool");
  if (poolKeyFor({ area, project, repo, pool }) !== key) throw corruptPoolRecord(key, "stored facets do not match the filename key");
  if (!Number.isSafeInteger(object.rrCursor) || (object.rrCursor as number) < 0) {
    throw corruptPoolRecord(key, "rrCursor must be a non-negative safe integer");
  }
  if (!Array.isArray(object.claims)) throw corruptPoolRecord(key, "claims must be an array");
  if (!Array.isArray(object.parked)) throw corruptPoolRecord(key, "parked must be an array");
  const record: PoolRecord = {
    key,
    area,
    project,
    repo,
    pool,
    rrCursor: object.rrCursor as number,
    claims: [],
    parked: [],
  };
  if (object.colony !== undefined) record.colony = requiredString(object.colony, key, "colony");
  const claimIds = new Set<string>();
  for (let index = 0; index < object.claims.length; index += 1) {
    const item = object.claims[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) throw corruptPoolRecord(key, `claims[${index}] must be an object`);
    const claim = item as Record<string, unknown>;
    const id = requiredString(claim.id, key, `claims[${index}].id`);
    if (claimIds.has(id)) throw corruptPoolRecord(key, `duplicate claim id ${id}`);
    claimIds.add(id);
    if (!Number.isSafeInteger(claim.member) || (claim.member as number) < 1) {
      throw corruptPoolRecord(key, `claims[${index}].member must be a positive safe integer`);
    }
    const path = requiredString(claim.path, key, `claims[${index}].path`);
    if (!isAbsolute(path)) throw corruptPoolRecord(key, `claims[${index}].path must be absolute`);
    const claimedAt = requiredString(claim.claimedAt, key, `claims[${index}].claimedAt`);
    const pendingUntil = requiredString(claim.pendingUntil, key, `claims[${index}].pendingUntil`);
    const claimedAtMs = Date.parse(claimedAt);
    const pendingUntilMs = Date.parse(pendingUntil);
    if (!Number.isFinite(claimedAtMs)) throw corruptPoolRecord(key, `claims[${index}].claimedAt must be a timestamp`);
    if (!Number.isFinite(pendingUntilMs)) throw corruptPoolRecord(key, `claims[${index}].pendingUntil must be a timestamp`);
    if (pendingUntilMs < claimedAtMs) throw corruptPoolRecord(key, `claims[${index}].pendingUntil precedes claimedAt`);
    if (claim.beeName !== undefined && (typeof claim.beeName !== "string" || claim.beeName.length === 0)) {
      throw corruptPoolRecord(key, `claims[${index}].beeName must be a non-empty string when present`);
    }
    record.claims.push({
      id,
      member: claim.member as number,
      path,
      ...(typeof claim.beeName === "string" ? { beeName: claim.beeName } : {}),
      claimedAt,
      pendingUntil,
    });
  }
  const parked = new Set<number>();
  for (let index = 0; index < object.parked.length; index += 1) {
    const member = object.parked[index];
    if (!Number.isSafeInteger(member) || (member as number) < 1) {
      throw corruptPoolRecord(key, `parked[${index}] must be a positive safe integer`);
    }
    if (parked.has(member as number)) throw corruptPoolRecord(key, `parked contains duplicate member ${member}`);
    parked.add(member as number);
  }
  record.parked = [...parked];
  return record;
}

export async function savePoolRecord(record: PoolRecord): Promise<void> {
  if (!validPoolKey(record.key)) throw new Error(`invalid pool key: ${record.key}`);
  normalizePoolRecord(record, record.key);
  await mkdir(poolsDir(), { recursive: true });
  await atomicWriteFile(poolPath(record.key), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** All pool records on disk (for `hive pool` listings and daemon sweeps). */
export async function listPoolRecords(): Promise<PoolRecord[]> {
  let files: string[];
  try {
    files = await readdir(poolsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: PoolRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith(".")) continue;
    const record = await loadPoolRecord(basename(file, ".json"));
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.key.localeCompare(b.key));
}

// ── occupancy derivation (§6.2) — pure over pre-gathered inputs ──────────────

/** A positively live local runtime, reduced to what occupancy needs. */
export type LiveBee = {
  name: string;
  /** Realpath'd cwd (re-verified by the safety observation before allocation). */
  cwd: string;
};

export function claimExpired(claim: PoolClaim, now: number): boolean {
  const until = Date.parse(claim.pendingUntil);
  return Number.isFinite(until) ? now > until : true;
}

/** Bees inhabiting `path`: live bees whose cwd is the path or below it. Pure. */
export function occupantsForPath(path: string, liveBees: LiveBee[]): LiveBee[] {
  return liveBees.filter((bee) => bee.cwd === path || bee.cwd.startsWith(`${path}/`));
}

export type MemberOccupancy = {
  n: number;
  path: string;
  branch: string;
  dirty: boolean;
  ahead?: number;
  behind?: number;
  parked: boolean;
  /** Names of live bees inhabiting the member. */
  occupants: string[];
  /** Unexpired, unconsumed claims still counting toward occupancy. */
  pendingClaims: PoolClaim[];
  /** Free capacity: max(0, maxOccupancy − occupants − pendingClaims); 0 when parked. */
  free: number;
};

/**
 * Per-member occupancy (§6.2), pure over (roster, config, claims, live bees).
 *
 * A claim bound to a positively live bee is consumed by that runtime. Unbound
 * claims always remain pending: an arbitrary existing inhabitant is not proof
 * that it is the just-spawned owner, and consuming the reservation on that
 * guess could exceed maxOccupancy when the real owner appears. The short
 * record→bind window may therefore double-count one runtime; that conservative
 * under-allocation is the required fail-closed direction.
 */
export function deriveMemberOccupancy(input: {
  members: ProPoolMember[];
  config: ProPoolConfig;
  claims: PoolClaim[];
  parked: number[];
  liveBees: LiveBee[];
  now: number;
}): MemberOccupancy[] {
  const liveNames = new Set(input.liveBees.map((bee) => bee.name));
  const parked = new Set(input.parked);
  return [...input.members]
    .sort((a, b) => a.n - b.n)
    .map((member) => {
      const occupants = occupantsForPath(member.path, input.liveBees);
      const claims = input.claims.filter((claim) => claim.member === member.n && !claimExpired(claim, input.now));
      const bound = claims.filter((claim) => claim.beeName !== undefined);
      const unbound = claims.filter((claim) => claim.beeName === undefined);
      // Bound to a live bee → consumed (its bee is counted as an occupant, or
      // it is live elsewhere and no longer needs the reservation).
      const pendingBound = bound.filter((claim) => !liveNames.has(claim.beeName!));
      const pendingClaims = [...pendingBound, ...unbound];
      const isParked = parked.has(member.n);
      const free = isParked ? 0 : Math.max(0, input.config.maxOccupancy - occupants.length - pendingClaims.length);
      return {
        n: member.n,
        path: member.path,
        branch: member.branch,
        dirty: member.dirty,
        ...(member.ahead !== undefined ? { ahead: member.ahead } : {}),
        ...(member.behind !== undefined ? { behind: member.behind } : {}),
        parked: isParked,
        occupants: occupants.map((bee) => bee.name),
        pendingClaims,
        free,
      };
    });
}

// ── allocation (§6.3) — pure planner + locked wrapper ────────────────────────

/**
 * Pick the next member (§6.3 step 2): the EMPTIEST free member below cap,
 * ties broken round-robin — first member number strictly greater than
 * rrCursor, wrapping. With maxOccupancy 1 every free member is equally empty,
 * so this reduces to plain round-robin. Pure.
 */
export function pickPoolMember(occupancy: MemberOccupancy[], rrCursor: number): MemberOccupancy | undefined {
  const candidates = occupancy.filter((member) => !member.parked && member.free > 0);
  if (candidates.length === 0) return undefined;
  const maxFree = Math.max(...candidates.map((member) => member.free));
  const emptiest = candidates.filter((member) => member.free === maxFree).sort((a, b) => a.n - b.n);
  return emptiest.find((member) => member.n > rrCursor) ?? emptiest[0];
}

export type PoolAllocationPlan = {
  /** Member picks in allocation order (a member may repeat when maxOccupancy > 1). */
  picks: Array<{ n: number; path: string }>;
  /** Cursor after the last pick (unchanged when nothing was picked). */
  rrCursor: number;
  /** How many requested slots found no free member (auto-extend covers these). */
  shortfall: number;
};

/**
 * Plan `count` allocations against a fixed occupancy snapshot: repeatedly pick
 * per §6.3, simulating each claim (free−1) and advancing the cursor. Pure —
 * the locked wrapper turns picks into claims and shortfall into extends.
 */
export function planPoolAllocations(occupancy: MemberOccupancy[], rrCursor: number, count: number): PoolAllocationPlan {
  const working = occupancy.map((member) => ({ ...member }));
  const picks: Array<{ n: number; path: string }> = [];
  let cursor = rrCursor;
  for (let i = 0; i < count; i += 1) {
    const pick = pickPoolMember(working, cursor);
    if (!pick) return { picks, rrCursor: cursor, shortfall: count - picks.length };
    picks.push({ n: pick.n, path: pick.path });
    cursor = pick.n;
    const entry = working.find((member) => member.n === pick.n)!;
    entry.free -= 1;
  }
  return { picks, rrCursor: cursor, shortfall: 0 };
}

// ── live-bee gathering (impure input to the pure derivations) ────────────────

/**
 * Injectable safety observations used by tests to force ordering/error edges.
 * Production defaults are strict: none may turn an observation failure into an
 * empty collection.
 */
export type PoolLivenessDependencies = {
  listSessions: () => Promise<SessionRecord[]>;
  observeLocal: () => Promise<LocalRuntimeSnapshot>;
  observeHsr: (bees: Iterable<string>) => Promise<Map<string, boolean | null>>;
  inspectLauncherGroup: (record: SessionRecord) => Promise<ProcessIdentityVerdict>;
  realpathCwd: (cwd: string) => Promise<string>;
};

const DEFAULT_POOL_LIVENESS_DEPS: PoolLivenessDependencies = {
  listSessions: listSessionsStrict,
  observeLocal: observeLocalRuntimeSnapshot,
  observeHsr: hsrPoolLivenessStrict,
  inspectLauncherGroup: (record) => inspectProcessGroupBirth(record.launcherPgid!, record.launcherFingerprint),
  realpathCwd: realpath,
};

/**
 * Every positively live local runtime that can mutate a pool checkout.
 *
 * The strict SessionRecord scan completes before runtime observation. Spawn
 * creates its runtime before persisting the record, so that order is a safety
 * barrier: every record in the snapshot either already had a runtime for the
 * following observation, or remains covered by its pending allocation claim.
 * Display state, stored lifecycle status, and seals are intentionally ignored;
 * a done/sealed runtime that is still positively live can still write its cwd.
 */
export async function poolLiveBees(
  records?: SessionRecord[],
  dependencies: Partial<PoolLivenessDependencies> = {},
): Promise<LiveBee[]> {
  const deps: PoolLivenessDependencies = { ...DEFAULT_POOL_LIVENESS_DEPS, ...dependencies };
  const sessions = records ?? (await deps.listSessions());
  const local = sessions.filter((record) => !record.node || record.node === LOCAL_NODE_NAME);
  const hsrRecords = local.filter((record) => record.substrate === "hsr");
  const launcherRecords = local.filter((record) => record.launcherPgid !== undefined);
  const [runtime, hsrLiveness, launcherVerdicts] = await Promise.all([
    // Even an empty record snapshot still takes the tmux barrier: silently
    // skipping a failed observer would make "no records" indistinguishable
    // from an unreadable runtime substrate during a concurrent publication.
    deps.observeLocal(),
    deps.observeHsr(local.map((record) => record.name)),
    Promise.all(launcherRecords.map(async (record) => [record.name, await deps.inspectLauncherGroup(record)] as const)),
  ]);
  const missingHsr = hsrRecords.find((record) => hsrLiveness.get(record.name) === null || !hsrLiveness.has(record.name));
  if (missingHsr) throw new Error(`HSR runtime metadata is missing for session ${missingHsr.name}`);
  const liveTargets = new Set<string>();
  for (const target of runtime.sessions) liveTargets.add(liveTargetKey(undefined, target));
  const context: StateContext = {
    liveTargets,
    livePanes: runtime.panes,
    hsrLive: new Set([...hsrLiveness].filter(([, live]) => live).map(([bee]) => bee)),
    now: Date.now(),
  };
  const liveProcessGroups = new Set(
    launcherVerdicts
      .filter(([, verdict]) => verdict !== "gone" && verdict !== "mismatch")
      .map(([name]) => name),
  );
  const liveBees = liveBeesFromSessions(sessions, { ...context, liveProcessGroups });
  return Promise.all(liveBees.map(async (bee) => ({ ...bee, cwd: await deps.realpathCwd(bee.cwd) })));
}

/**
 * Reduce session records to positively live local runtimes (§6.2). This is
 * deliberately not deriveState: display-terminal states such as done/sealed
 * do not prove the process has exited and therefore cannot release capacity.
 */
export function liveBeesFromSessions(
  records: SessionRecord[],
  context: StateContext & { liveProcessGroups?: ReadonlySet<string> },
): LiveBee[] {
  const bees: LiveBee[] = [];
  for (const record of records) {
    if (record.node && record.node !== LOCAL_NODE_NAME) continue;
    const targetLive = context.liveTargets.has(liveTargetKey(record.node, record.tmuxTarget)) || context.liveTargets.has(record.tmuxTarget);
    const paneLive = record.agentPaneId !== undefined && context.livePanes?.has(record.agentPaneId) === true;
    // Observe both substrates around lifecycle transitions: the durable record
    // can still name the old substrate while the replacement runtime is already
    // live. Any positive local signal retains capacity.
    const hsrLive = context.hsrLive?.has(record.name) === true;
    const launcherGroupLive = context.liveProcessGroups?.has(record.name) === true;
    const live = targetLive || paneLive || hsrLive || launcherGroupLive;
    if (!live) continue;
    bees.push({ name: record.name, cwd: record.cwd });
  }
  return bees;
}

// ── pool resolution (name → project/repo/config) ─────────────────────────────

export type ResolvedPool = {
  key: string;
  area: string;
  project: string;
  repo: string;
  pool: string;
  /** Canonical `repos/<repo>` path — the cwd for all pro shell-outs. */
  repoPath: string;
  config: ProPoolConfig;
  members: ProPoolMember[];
};

function resolvedPoolFor(entry: ProRepoEntry, config: ProPoolConfig, members: ProPoolMember[]): ResolvedPool {
  const facets = { area: entry.area, project: entry.project, repo: entry.repo, pool: config.name };
  return { key: poolKeyFor(facets), ...facets, repoPath: entry.path, config, members: members.filter((m) => m.repo === config.repo && m.pool === config.name) };
}

/** Every pool of the project `entry` belongs to, resolved (one porcelain call). */
export async function poolsForProject(entry: ProRepoEntry, entries: ProRepoEntry[]): Promise<ResolvedPool[]> {
  const listing = await listProPools(entry.path);
  const siblings = entries.filter((e) => e.area === entry.area && e.project === entry.project);
  const byRepo = new Map(siblings.map((e) => [e.repo, e]));
  const pools: ResolvedPool[] = [];
  for (const config of listing.pools) {
    const owner = byRepo.get(config.repo);
    if (!owner) continue;
    pools.push(resolvedPoolFor(owner, config, listing.members));
  }
  return pools;
}

/** One representative repo entry per pro project (porcelain is project-wide). */
export function projectRepresentatives(entries: ProRepoEntry[]): ProRepoEntry[] {
  const seen = new Map<string, ProRepoEntry>();
  for (const entry of entries) {
    const id = `${entry.area}/${entry.project}`;
    if (!seen.has(id)) seen.set(id, entry);
  }
  return [...seen.values()];
}

/**
 * Resolve a pool reference (§6.4): exact key (`<area>-<project>-<repo>-<pool>`)
 * first, else a unique match by pool name within the cwd's pro project; when
 * the cwd is outside any pro project, fall back to a unique name match across
 * all projects. Throws with an actionable message on no/ambiguous match.
 */
export async function resolvePoolRef(ref: string, cwd: string): Promise<ResolvedPool> {
  const entries = await listProRepoEntries();

  // Exact-key interpretation: an entry whose `<area>-<project>-<repo>-` slug
  // prefixes the ref names the pool as the remainder; verify against porcelain.
  const keyCandidates = entries.filter((entry) => ref.startsWith(`${poolKeyFor({ ...entry, pool: "" })}`) && ref.length > poolKeyFor({ ...entry, pool: "" }).length);
  for (const entry of keyCandidates) {
    const poolName = ref.slice(poolKeyFor({ ...entry, pool: "" }).length);
    const listing = await listProPools(entry.path).catch(() => undefined);
    const config = listing?.pools.find((pool) => pool.name === poolName && pool.repo === entry.repo);
    if (config) return resolvedPoolFor(entry, config, listing!.members);
  }

  const scopeEntry = resolveProEntryForCwd(entries, cwd);
  const scopes = scopeEntry ? [scopeEntry] : projectRepresentatives(entries);
  const matches: ResolvedPool[] = [];
  for (const scope of scopes) {
    const pools = await poolsForProject(scope, entries).catch(() => [] as ResolvedPool[]);
    matches.push(...pools.filter((pool) => pool.pool === ref));
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Ambiguous pool "${ref}": ${matches.map((m) => m.key).join(", ")} — use the full key`);
  }
  const where = scopeEntry ? `project ${scopeEntry.area}/${scopeEntry.project}` : "any pro project";
  throw new Error(`Unknown pool: ${ref} (no match in ${where}). Create one with: pro pool create ${ref}`);
}

// ── allocation wrapper (locked; auto-extend; §6.3 + §7) ──────────────────────

export type PoolAllocation = {
  member: number;
  path: string;
  /** True when this allocation triggered the clone that created the member. */
  created: boolean;
  claim: PoolClaim;
};

export type AllocatePoolOptions = {
  /** Injected live-bee set (tests); default gathers from the local substrate. */
  liveBees?: LiveBee[];
  /** Injectable fresh pro roster (tests). */
  listMembers?: (pool: ResolvedPool) => Promise<ProPoolMember[]>;
  /** Injectable pro extension (tests). */
  extendPool?: (repoPath: string, pool: string, count: number) => Promise<string[]>;
  /** Injectable canonicalizer (tests); failures are always fatal to a safety decision. */
  realpathPath?: (path: string) => Promise<string>;
  /** Loud warnings (soft maxSize breach) — default stderr. */
  onWarn?: (message: string) => void;
  /** Claim lifetime override (manual `hive pool claim --ttl`); default poolClaimTtlMs(). */
  ttlMs?: number;
};

/**
 * Allocate `count` members of `pool` in ONE lock acquisition (§6.3/§6.4):
 * enumerate members fresh from pro, derive the free set, pick emptiest-first
 * with round-robin tie-break, auto-extend when free capacity falls short
 * (maxSize is SOFT — extension past it proceeds with a loud warning), then
 * write claims + advance rrCursor under the lock.
 */
export async function allocatePoolMembers(pool: ResolvedPool, count: number, options: AllocatePoolOptions = {}): Promise<PoolAllocation[]> {
  if (!Number.isInteger(count) || count < 1) throw new Error(`pool allocation count must be a positive integer (got ${count})`);
  const warn = options.onWarn ?? ((message: string) => console.error(message));
  const listMembers = options.listMembers ?? currentMembers;
  const extendPool = options.extendPool ?? extendProPool;
  const realpathPath = options.realpathPath ?? realpath;
  return withPoolLock(pool.key, async () => {
    const now = Date.now();
    const record = (await loadPoolRecord(pool.key)) ?? emptyPoolRecord(pool);
    // GC expired claims while holding the lock — cheap, and keeps the record
    // from accreting dead weight between daemon sweeps (§6.6, phase 3).
    record.claims = record.claims.filter((claim) => !claimExpired(claim, now));

    invalidateProPoolCache(pool.repoPath);
    let members = await listMembers(pool);
    const liveBees = options.liveBees ?? (await poolLiveBees());
    const realMembers = await canonicalizePoolMembers(members, realpathPath);

    let occupancy = deriveMemberOccupancy({ members: realMembers, config: pool.config, claims: record.claims, parked: record.parked, liveBees, now });
    let plan = planPoolAllocations(occupancy, record.rrCursor, count);
    let createdPaths = new Set<string>();

    if (plan.shortfall > 0) {
      const newSize = members.length + plan.shortfall;
      if (newSize > pool.config.maxSize) {
        warn(`warn: pool ${pool.pool} exceeds maxSize: ${newSize}/${pool.config.maxSize} — consider cleaning or raising maxSize`);
      }
      const created = await extendPool(pool.repoPath, pool.pool, plan.shortfall);
      createdPaths = new Set(await Promise.all(created.map((path) => realpathPath(path))));
      members = await listMembers(pool);
      const refreshed = await canonicalizePoolMembers(members, realpathPath);
      occupancy = deriveMemberOccupancy({ members: refreshed, config: pool.config, claims: record.claims, parked: record.parked, liveBees, now });
      plan = planPoolAllocations(occupancy, record.rrCursor, count);
      if (plan.shortfall > 0) {
        throw new Error(`pool ${pool.pool}: still ${plan.shortfall} short after extending — pro created fewer members than requested?`);
      }
    }

    const ttlMs = options.ttlMs ?? poolClaimTtlMs();
    const allocations: PoolAllocation[] = plan.picks.map((pick) => {
      const claim: PoolClaim = {
        id: randomUUID(),
        member: pick.n,
        path: pick.path,
        claimedAt: new Date(now).toISOString(),
        pendingUntil: new Date(now + ttlMs).toISOString(),
      };
      return { member: pick.n, path: pick.path, created: createdPaths.has(pick.path), claim };
    });
    record.claims.push(...allocations.map((allocation) => allocation.claim));
    record.rrCursor = plan.rrCursor;
    await savePoolRecord(record);
    await appendLedger({ type: "pool.claim", pool: pool.key, members: allocations.map((a) => a.member), count });
    return allocations;
  });
}

async function currentMembers(pool: ResolvedPool): Promise<ProPoolMember[]> {
  const listing = await listProPools(pool.repoPath);
  return listing.members.filter((member) => member.repo === pool.repo && member.pool === pool.pool);
}

/**
 * Re-resolve one already-identified pool from pro's current porcelain. Callers
 * use the stable pool key to choose the lock, then invoke this only after that
 * lock is held so roster/config validation cannot race another Hive extension.
 */
export async function refreshResolvedPool(
  pool: ResolvedPool,
  reader: typeof listProPools = listProPools,
): Promise<ResolvedPool> {
  invalidateProPoolCache(pool.repoPath);
  const listing = await reader(pool.repoPath);
  const config = listing.pools.find((candidate) => candidate.repo === pool.repo && candidate.name === pool.pool);
  if (!config) {
    throw new Error(`pool ${pool.key} no longer exists in pro; re-run hive pool list and retry`);
  }
  return {
    ...pool,
    config,
    members: listing.members.filter((member) => member.repo === pool.repo && member.pool === pool.pool),
  };
}

export type ExtendPoolMembersOptions = {
  refreshPool?: (pool: ResolvedPool) => Promise<ResolvedPool>;
  extendPool?: (repoPath: string, pool: string, count: number) => Promise<string[]>;
  canonicalizeMembers?: typeof canonicalizePoolMembers;
  onWarn?: (message: string) => void;
};

/**
 * Manual pool growth. The initial resolve only identifies the lock; current
 * roster/config and physical member identity are revalidated inside it, and the
 * lock remains held through pro's complete external clone mutation.
 */
export async function extendPoolMembers(
  pool: ResolvedPool,
  count: number,
  options: ExtendPoolMembersOptions = {},
): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`pool extend count must be a positive integer (got ${count})`);
  }
  return withPoolLock(pool.key, async () => {
    const current = await (options.refreshPool ?? refreshResolvedPool)(pool);
    await (options.canonicalizeMembers ?? canonicalizePoolMembers)(current.members);
    const newSize = current.members.length + count;
    if (newSize > current.config.maxSize) {
      options.onWarn?.(
        `pool ${current.pool} exceeds maxSize: ${newSize}/${current.config.maxSize} — consider cleaning or raising maxSize`,
      );
    }
    return (options.extendPool ?? extendProPool)(current.repoPath, current.pool, count);
  });
}

export async function canonicalizePoolMembers(
  members: ProPoolMember[],
  realpathPath: (path: string) => Promise<string> = realpath,
): Promise<ProPoolMember[]> {
  const canonical = await Promise.all(
    members.map(async (member) => {
      // Member identity is load-bearing for cwd-prefix occupancy. Falling back
      // to the unresolved spelling after an I/O error could hide a live bee
      // behind a symlink and over-subscribe the checkout, so this read is
      // intentionally fail-closed for allocation, claim, status, and sync.
      const real = await realpathPath(member.path);
      return real === member.path ? member : { ...member, path: real };
    }),
  );
  const byPath = new Map<string, ProPoolMember>();
  for (const member of canonical) {
    const existing = byPath.get(member.path);
    if (existing) {
      throw new Error(
        `pool roster aliases one physical checkout at ${member.path}: ` +
        `${existing.repo}:${existing.pool}-${existing.n} and ${member.repo}:${member.pool}-${member.n}; ` +
        `repair the pro pool roster before allocating or mutating this pool`,
      );
    }
    byPath.set(member.path, member);
  }
  return canonical;
}

/**
 * Claim ONE SPECIFIC member (`hive pool claim <pool> <n>`): refuses parked or
 * full members instead of silently over-subscribing. Does not advance the
 * round-robin cursor — a hand-picked member is not a rotation step.
 */
export async function claimSpecificPoolMember(pool: ResolvedPool, member: number, options: AllocatePoolOptions = {}): Promise<PoolAllocation> {
  return withPoolLock(pool.key, async () => {
    const now = Date.now();
    const record = (await loadPoolRecord(pool.key)) ?? emptyPoolRecord(pool);
    record.claims = record.claims.filter((claim) => !claimExpired(claim, now));

    invalidateProPoolCache(pool.repoPath);
    const members = await canonicalizePoolMembers(
      await (options.listMembers ?? currentMembers)(pool),
      options.realpathPath ?? realpath,
    );
    const liveBees = options.liveBees ?? (await poolLiveBees());
    const occupancy = deriveMemberOccupancy({ members, config: pool.config, claims: record.claims, parked: record.parked, liveBees, now });
    const target = occupancy.find((m) => m.n === member);
    if (!target) throw new Error(`pool ${pool.pool} has no member ${member} (have: ${occupancy.map((m) => m.n).join(", ") || "none"})`);
    if (target.parked) throw new Error(`pool member ${pool.pool}-${member} is parked — unpark it first: hive pool unpark ${pool.pool} ${member}`);
    if (target.free < 1) {
      const who = [...target.occupants, ...target.pendingClaims.map((claim) => claim.beeName ?? "pending claim")].join(", ");
      throw new Error(`pool member ${pool.pool}-${member} is full (${who || "occupied"})`);
    }
    const claim: PoolClaim = {
      id: randomUUID(),
      member,
      path: target.path,
      claimedAt: new Date(now).toISOString(),
      pendingUntil: new Date(now + (options.ttlMs ?? poolClaimTtlMs())).toISOString(),
    };
    record.claims.push(claim);
    await savePoolRecord(record);
    await appendLedger({ type: "pool.claim", pool: pool.key, members: [member], count: 1, manual: true });
    return { member, path: target.path, created: false, claim };
  });
}

// ── claim lifecycle helpers ──────────────────────────────────────────────────

/** Tie a pending claim to the final bee name once the spawn has registered it. */
export async function bindPoolClaim(key: string, claimId: string, beeName: string): Promise<void> {
  await withPoolLock(key, async () => {
    const record = await loadPoolRecord(key);
    if (!record) return;
    const claim = record.claims.find((c) => c.id === claimId);
    if (!claim) return;
    claim.beeName = beeName;
    await savePoolRecord(record);
  });
}

/** Drop one claim by id (spawn-failure rollback, `hive pool release`). */
export async function releasePoolClaim(key: string, claimId: string): Promise<void> {
  await withPoolLock(key, async () => {
    const record = await loadPoolRecord(key);
    if (!record) return;
    const remaining = record.claims.filter((claim) => claim.id !== claimId);
    if (remaining.length === record.claims.length) return;
    record.claims = remaining;
    await savePoolRecord(record);
  });
}

/** Drop every claim on member `n` (`hive pool release <pool> <n>`). */
export async function releasePoolMemberClaims(key: string, member: number): Promise<number> {
  return withPoolLock(key, async () => {
    const record = await loadPoolRecord(key);
    if (!record) return 0;
    const remaining = record.claims.filter((claim) => claim.member !== member);
    const dropped = record.claims.length - remaining.length;
    if (dropped > 0) {
      record.claims = remaining;
      await savePoolRecord(record);
    }
    return dropped;
  });
}

/**
 * Eager claim cleanup on kill/clean (§6.2): a killed bee's claim would
 * otherwise keep counting until pendingUntil. Best-effort — expiry is the
 * backstop, so callers swallow errors.
 */
export async function dropPoolClaimsForBee(key: string, beeName: string): Promise<void> {
  await withPoolLock(key, async () => {
    const record = await loadPoolRecord(key);
    if (!record) return;
    const remaining = record.claims.filter((claim) => claim.beeName !== beeName);
    if (remaining.length === record.claims.length) return;
    record.claims = remaining;
    await savePoolRecord(record);
  });
}

/** Park/unpark a member: parked members are withheld from allocation (§6.5). */
export async function setPoolMemberParked(pool: ResolvedPool, member: number, parked: boolean): Promise<void> {
  if (!pool.members.some((m) => m.n === member)) {
    throw new Error(`pool ${pool.pool} has no member ${member} (have: ${pool.members.map((m) => m.n).join(", ") || "none"})`);
  }
  await withPoolLock(pool.key, async () => {
    const record = (await loadPoolRecord(pool.key)) ?? emptyPoolRecord(pool);
    const set = new Set(record.parked);
    if (parked) set.add(member);
    else set.delete(member);
    record.parked = [...set].sort((a, b) => a - b);
    await savePoolRecord(record);
  });
  await appendLedger({ type: parked ? "pool.park" : "pool.unpark", pool: pool.key, member });
}

// ── derived status (the `hive pool status` / Apiary model) ───────────────────

export type PoolStatus = {
  key: string;
  area: string;
  project: string;
  repo: string;
  pool: string;
  repoPath: string;
  branch: string;
  maxOccupancy: number;
  maxSize: number;
  size: number;
  busy: number;
  free: number;
  rrCursor: number;
  exceedsMaxSize: boolean;
  members: MemberOccupancy[];
};

/** Full derived model for one pool: config (pro) + record (hive) + occupancy. */
export async function poolStatus(
  pool: ResolvedPool,
  options: { liveBees?: LiveBee[]; realpathPath?: (path: string) => Promise<string> } = {},
): Promise<PoolStatus> {
  const now = Date.now();
  const record = (await loadPoolRecord(pool.key)) ?? emptyPoolRecord(pool);
  const liveBees = options.liveBees ?? (await poolLiveBees());
  const members = deriveMemberOccupancy({
    members: await canonicalizePoolMembers(pool.members, options.realpathPath ?? realpath),
    config: pool.config,
    claims: record.claims,
    parked: record.parked,
    liveBees,
    now,
  });
  const busy = members.filter((member) => member.occupants.length > 0 || member.pendingClaims.length > 0).length;
  const free = members.reduce((sum, member) => sum + member.free, 0);
  return {
    key: pool.key,
    area: pool.area,
    project: pool.project,
    repo: pool.repo,
    pool: pool.pool,
    repoPath: pool.repoPath,
    branch: pool.config.branch,
    maxOccupancy: pool.config.maxOccupancy,
    maxSize: pool.config.maxSize,
    size: members.length,
    busy,
    free,
    rrCursor: record.rrCursor,
    exceedsMaxSize: members.length > pool.config.maxSize,
    members,
  };
}
