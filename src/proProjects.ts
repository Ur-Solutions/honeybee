/**
 * Thin bridge to the external `pro` CLI (project folders for humans and tools).
 *
 * The `hive new` project column lets the operator pick a working directory from
 * their `pro`-managed repos instead of typing a path. We shell out to the stable
 * `pro ls repos` interface — tab-separated `area/project<TAB>repo<TAB>abspath` —
 * rather than reading pro's private index file, so we track whatever `pro`
 * decides to expose. Missing/old `pro` installs surface a friendly error that
 * the picker shows inline; they never crash the spawn flow.
 */

import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";

export type ProRepo = {
  /** "area/project/repo" — the display label in the picker. */
  label: string;
  /** Absolute path to the repo, used directly as the spawn cwd. */
  path: string;
  /** "area/project" group, shown dimmed for context. */
  project: string;
};

function run(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`\`${command}\` CLI not found on PATH — install it or pick "Path…" instead`));
          return;
        }
        const detail = stderr.trim() || error.message;
        reject(new Error(`\`${command} ${args.join(" ")}\` failed: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Like run(), but a nonzero exit still resolves with the captured stdout.
 * `pro co sync` exits nonzero when ANY member failed while the per-member
 * status lines on stdout remain the real result — rejecting would throw away
 * the report the caller needs to show.
 */
function runTolerant(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; stdout: string; detail: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`\`${command}\` CLI not found on PATH — install it or pick "Path…" instead`));
        return;
      }
      resolve({ ok: !error, stdout, detail: stderr.trim() || (error ? error.message : "") });
    });
  });
}

/**
 * Parse `pro ls repos` output (tab-separated `area/project<TAB>repo<TAB>abspath`).
 * Lines that don't carry an absolute path are skipped rather than shown as
 * broken rows. Kept pure (no I/O) so it can be unit-tested.
 */
export function parseProRepos(stdout: string): ProRepo[] {
  const repos: ProRepo[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [project, repo, path] = line.split("\t");
    if (!path || !path.startsWith("/")) continue;
    repos.push({
      label: repo ? `${project}/${repo}` : (project ?? path),
      path,
      project: project ?? "",
    });
  }
  return repos;
}

// `pro ls repos` is the same shell-out for both the browse list and the
// per-cwd isolation check, and the spawn/launch TUIs call it repeatedly while
// the operator navigates. A short-lived promise cache collapses those into one
// `pro` invocation (and lets the TUI prefetch it up front via prewarmProRepos,
// so the "checking pro repo…" step resolves instantly instead of blocking the
// spawn on a cold call). The window is short — a single interactive session —
// so a repo created mid-session at worst waits out the TTL.
const PRO_REPOS_CACHE_TTL_MS = 30_000;
let proReposCache: { at: number; stdout: Promise<string> } | undefined;

function cachedProReposStdout(): Promise<string> {
  const now = Date.now();
  if (proReposCache && now - proReposCache.at < PRO_REPOS_CACHE_TTL_MS) return proReposCache.stdout;
  const stdout = run("pro", ["ls", "repos"]);
  const entry = { at: now, stdout };
  proReposCache = entry;
  // Don't cache a failure: drop it so the next call retries a fresh `pro`.
  stdout.catch(() => {
    if (proReposCache === entry) proReposCache = undefined;
  });
  return stdout;
}

/** Drop the cached `pro ls repos` result (tests that swap PRO_ROOT per fixture). */
export function invalidateProReposCache(): void {
  proReposCache = undefined;
}

/**
 * Kick off (and cache) the `pro ls repos` shell-out without awaiting it, so the
 * cost overlaps the operator picking an agent/account/cwd. Best-effort: a failed
 * prewarm just drops the cache and the real call retries.
 */
export function prewarmProRepos(): void {
  void cachedProReposStdout().catch(() => undefined);
}

/**
 * List every repo `pro` knows about, in pro's own ordering.
 */
export async function listProRepos(): Promise<ProRepo[]> {
  return parseProRepos(await cachedProReposStdout());
}

export type ProRepoEntry = {
  area: string;
  project: string;
  repo: string;
  /** Absolute repo path. */
  path: string;
};

/**
 * Parse `pro ls repos` into structured area/project/repo rows (pure). The first
 * column is "area/project"; we split it so callers can group by either facet.
 */
export function parseProRepoEntries(stdout: string): ProRepoEntry[] {
  const entries: ProRepoEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [areaProject, repo, path] = line.split("\t");
    if (!path || !path.startsWith("/")) continue;
    const [area = "", project = ""] = (areaProject ?? "").split("/");
    entries.push({ area, project, repo: repo ?? "", path });
  }
  return entries;
}

/** Structured repo inventory from `pro` (for grouping bees by pro facets). */
export async function listProRepoEntries(): Promise<ProRepoEntry[]> {
  return parseProRepoEntries(await cachedProReposStdout());
}

/**
 * Resolve which pro repo entry a directory lives in by longest path-prefix
 * match (a bee's cwd is often a subdir of the repo root). Pure — pass in the
 * entries. Returns the full entry (callers that only need the facets use
 * {@link resolveProForCwd}; the worktree/checkout step needs `path` too).
 */
export function resolveProEntryForCwd(entries: ProRepoEntry[], cwd: string): ProRepoEntry | undefined {
  let best: ProRepoEntry | undefined;
  for (const entry of entries) {
    if (cwd === entry.path || cwd.startsWith(`${entry.path}/`)) {
      if (!best || entry.path.length > best.path.length) best = entry;
    }
  }
  return best;
}

/**
 * Resolve which pro repo a directory lives in by longest path-prefix match
 * (a bee's cwd is often a subdir of the repo root). Pure — pass in the entries.
 */
export function resolveProForCwd(
  entries: ProRepoEntry[],
  cwd: string,
): { area: string; project: string; repo: string } | undefined {
  const best = resolveProEntryForCwd(entries, cwd);
  return best ? { area: best.area, project: best.project, repo: best.repo } : undefined;
}

export type ProSlotKind = "worktree" | "checkout";

export type ProSlotAcquisition = {
  path: string;
  /** True only when this call created the slot instead of reusing one. */
  created: boolean;
};

export type ProSlotResolution = {
  area: string;
  project: string;
  repo: string;
  /** Where the cwd physically lives. "repo" = the canonical `repos/<repo>`. */
  kind: "repo" | ProSlotKind;
  /** Worktree/checkout name (the slug after `<worktrees|checkouts>/<repo>/`); absent for the canonical repo. */
  slot?: string;
};

/**
 * Resolve which pro repo a directory belongs to AND whether it sits in the
 * canonical checkout, a worktree, or a checkout. `pro` lays slots out as
 * siblings of `repos/` under the project root:
 *
 *   <project>/repos/<repo>            canonical — what `pro ls repos` reports
 *   <project>/worktrees/<repo>/<name> worktree
 *   <project>/checkouts/<repo>/<name> checkout
 *
 * so a bee whose cwd is in a worktree/checkout shares the canonical repo's
 * area/project/repo (it groups under the same pro project/repo) but carries a
 * slot kind+name so the sidebar can tag the row. Longest-prefix match across
 * every candidate root picks the most specific repo and stops a shorter repo
 * path from swallowing a sibling. Pure — pass in the entries.
 */
export function resolveProSlotForCwd(entries: ProRepoEntry[], cwd: string): ProSlotResolution | undefined {
  let best: { root: string; res: ProSlotResolution } | undefined;
  const consider = (root: string, res: ProSlotResolution) => {
    if (cwd !== root && !cwd.startsWith(`${root}/`)) return;
    if (!best || root.length > best.root.length) best = { root, res };
  };
  for (const entry of entries) {
    const facets = { area: entry.area, project: entry.project, repo: entry.repo };
    consider(entry.path, { ...facets, kind: "repo" });
    // Slots live one directory up from `repos/`, keyed by the repo's own folder.
    const projectRoot = dirname(dirname(entry.path));
    const repoDir = basename(entry.path);
    for (const kind of ["worktree", "checkout"] as const) {
      const base = `${projectRoot}/${kind}s/${repoDir}`;
      if (!cwd.startsWith(`${base}/`)) continue;
      const slot = cwd.slice(base.length + 1).split("/")[0];
      if (slot) consider(`${base}/${slot}`, { ...facets, kind, slot });
    }
  }
  return best?.res;
}

/**
 * Lower-case a free-typed name into a pro slug (`[a-z0-9][a-z0-9-]*`, no
 * leading/trailing dash — pro's `is_slug`). Returns "" when nothing usable
 * remains, so callers surface a "type a name" hint instead of shipping an
 * invalid slug. Pure (no I/O).
 */
export function toProSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function proSlotSubcommand(kind: ProSlotKind): "wt" | "co" {
  return kind === "worktree" ? "wt" : "co";
}

function proSlotPathFromStdout(stdout: string, command: string): string {
  const path = stdout.trim().split("\n").pop()?.trim() ?? "";
  if (!path.startsWith("/")) throw new Error(`\`${command}\` did not return a path`);
  return path;
}

async function runProSlotPath(kind: ProSlotKind, repoPath: string, args: string[]): Promise<string> {
  const sub = proSlotSubcommand(kind);
  const stdout = await run("pro", [sub, ...args], { cwd: repoPath, timeoutMs: 300_000 });
  return proSlotPathFromStdout(stdout, `pro ${[sub, ...args].join(" ")}`);
}

/**
 * Return the path for an existing pro worktree/checkout. Rejects when the slot
 * does not exist, matching `pro <wt|co> s <name>`.
 */
export async function resolveProSlotPath(kind: ProSlotKind, repoPath: string, name: string): Promise<string> {
  return runProSlotPath(kind, repoPath, ["s", name]);
}

async function createNewProSlot(kind: ProSlotKind, repoPath: string, name: string): Promise<string> {
  return runProSlotPath(kind, repoPath, ["c", name]);
}

/**
 * Create (or reuse) a pro worktree/checkout beside the repo and return its
 * absolute path. Shells out to `pro <wt|co> s -c <name>` from inside `repoPath`
 * so pro resolves the area/project/repo from the directory (no REPO: qualifier
 * needed even in multi-repo projects); `s -c` prints the slot path on stdout —
 * git/clone chatter goes to stderr — and reuses an existing slot of the same
 * name rather than erroring. The longer timeout covers a `co` full clone.
 */
export async function createProSlot(kind: ProSlotKind, repoPath: string, name: string): Promise<string> {
  return runProSlotPath(kind, repoPath, ["s", "-c", name]);
}

/**
 * Like createProSlot, but reports whether this call created the slot. The fork
 * launcher uses this to roll back only fresh isolation slots when launch fails,
 * without deleting a user-owned slot that `pro ... switch -c` would have reused.
 */
export async function acquireProSlot(kind: ProSlotKind, repoPath: string, name: string): Promise<ProSlotAcquisition> {
  const existing = await resolveProSlotPath(kind, repoPath, name).catch(() => undefined);
  if (existing) return { path: existing, created: false };

  try {
    return { path: await createNewProSlot(kind, repoPath, name), created: true };
  } catch (error) {
    // If another process created the slot between our probe and create call,
    // reuse it and do not treat it as ours to clean up.
    const raced = await resolveProSlotPath(kind, repoPath, name).catch(() => undefined);
    if (raced) return { path: raced, created: false };
    throw error;
  }
}

export function proSlotDeleteArgs(kind: ProSlotKind, name: string): string[] {
  const args = [proSlotSubcommand(kind), "d", name, "--force", "--hard"];
  // A same-named branch may have existed before this worktree slot was created.
  // The rollback is for the directory/checkout, not branch ownership.
  if (kind === "worktree") args.push("--no-delete-branch");
  return args;
}

/** Delete a pro slot from the repo that owns it. */
export async function deleteProSlot(kind: ProSlotKind, repoPath: string, name: string): Promise<void> {
  await run("pro", proSlotDeleteArgs(kind, name), { cwd: repoPath, timeoutMs: 300_000 });
}

// ── checkout pools (`pro pool`) ──────────────────────────────────────────────
// Bridge to the `pro pool` command family (CHECKOUT_POOLS_PRD §5.2). Pool
// config and membership are pro's truth — hive only parses the porcelain and
// drives extend/sync; it never keeps its own copy of branch/occupancy/members.

export type ProPoolConfig = {
  repo: string;
  name: string;
  branch: string;
  maxOccupancy: number;
  maxSize: number;
};

export type ProPoolMember = {
  repo: string;
  pool: string;
  /** Member number from the `<pool>-<n>` directory name. */
  n: number;
  /** Absolute checkout path. */
  path: string;
  /** Current branch (≠ pool branch means the member is parked on WIP). */
  branch: string;
  dirty: boolean;
  /** Commits ahead/behind the last-fetched origin ref; undefined when the ref is missing ("-"). */
  ahead?: number;
  behind?: number;
};

export type ProPoolListing = {
  pools: ProPoolConfig[];
  members: ProPoolMember[];
};

/**
 * The `pro` on PATH predates the pool family (or `pro pool` failed outright).
 * Callers surface `hint` verbatim — it tells the operator what to do, instead
 * of leaking a bash usage error.
 */
export class ProPoolsUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `\`pro pool\` is unavailable: ${detail || "command failed"}\n` +
        `Checkout pools need a pool-enabled pro. Upgrade the \`pro\` on PATH (pool support shipped on pro's checkout-pools branch).`,
    );
    this.name = "ProPoolsUnavailableError";
  }
}

/**
 * Parse `pro pool ls --porcelain` (record-tagged TSV; §5.2 as shipped):
 *
 *   pool\t<repo>\t<name>\t<branch>\t<maxOccupancy>\t<maxSize>
 *   member\t<repo>\t<pool>\t<n>\t<path>\t<branch>\t<dirty 0|1>\t<ahead>\t<behind>
 *
 * ahead/behind count against the last-fetched origin ref and are "-" when the
 * ref is missing (listing never fetches). Malformed lines are skipped rather
 * than surfaced as broken rows. Pure (no I/O) so it can be unit-tested.
 */
export function parseProPoolPorcelain(stdout: string): ProPoolListing {
  const pools: ProPoolConfig[] = [];
  const members: ProPoolMember[] = [];
  const count = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw === "-") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields[0] === "pool") {
      const [, repo, name, branch, maxOccupancy, maxSize] = fields;
      if (!repo || !name || !branch) continue;
      const occ = Number(maxOccupancy);
      const max = Number(maxSize);
      pools.push({
        repo,
        name,
        branch,
        maxOccupancy: Number.isInteger(occ) && occ >= 1 ? occ : 1,
        maxSize: Number.isInteger(max) && max >= 1 ? max : 32,
      });
    } else if (fields[0] === "member") {
      const [, repo, pool, nRaw, path, branch, dirty, aheadRaw, behindRaw] = fields;
      const n = Number(nRaw);
      if (!repo || !pool || !path || !path.startsWith("/") || !branch || !Number.isInteger(n)) continue;
      const ahead = count(aheadRaw);
      const behind = count(behindRaw);
      members.push({
        repo,
        pool,
        n,
        path,
        branch,
        dirty: dirty === "1",
        ...(ahead !== undefined ? { ahead } : {}),
        ...(behind !== undefined ? { behind } : {}),
      });
    }
  }
  return { pools, members };
}

// Same rationale as the `pro ls repos` cache: `hive pool`/status/spawn call the
// porcelain repeatedly within one interactive session, and the daemon may poll
// it. Keyed by repoPath since the listing is project-relative. Mutations
// (extend) bust the key so a fresh member is visible immediately.
const PRO_POOL_CACHE_TTL_MS = 30_000;
const proPoolCache = new Map<string, { at: number; listing: Promise<ProPoolListing> }>();

export function invalidateProPoolCache(repoPath?: string): void {
  if (repoPath === undefined) proPoolCache.clear();
  else proPoolCache.delete(repoPath);
}

/**
 * List pools + members visible from `repoPath` (the project the repo lives
 * in), via `pro pool ls --porcelain`. Cached for 30s per repoPath. Throws
 * ProPoolsUnavailableError when the `pro` on PATH has no pool family.
 */
export async function listProPools(repoPath: string): Promise<ProPoolListing> {
  const now = Date.now();
  const cached = proPoolCache.get(repoPath);
  if (cached && now - cached.at < PRO_POOL_CACHE_TTL_MS) return cached.listing;
  const listing = run("pro", ["pool", "ls", "--porcelain"], { cwd: repoPath, timeoutMs: 30_000 }).then(
    parseProPoolPorcelain,
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      // ENOENT keeps the existing friendly "not found on PATH" message; any
      // other failure of `pro pool` means the installed pro predates pools
      // (unknown command / usage error) — surface the typed, actionable error.
      if (message.includes("not found on PATH")) throw error;
      throw new ProPoolsUnavailableError(message.replace(/^`pro pool ls --porcelain` failed: /, ""));
    },
  );
  const entry = { at: now, listing };
  proPoolCache.set(repoPath, entry);
  listing.catch(() => {
    if (proPoolCache.get(repoPath) === entry) proPoolCache.delete(repoPath);
  });
  return listing;
}

/**
 * Clone the next `count` members of a pool (`pro pool extend`). Returns the
 * created checkout paths (one per line on stdout; git chatter goes to stderr).
 * Long timeout like createProSlot — each member is a full `git clone --local`.
 * Busts the porcelain cache so the fresh members are immediately visible.
 */
export async function extendProPool(repoPath: string, pool: string, count = 1): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1) throw new Error(`pool extend count must be a positive integer (got ${count})`);
  try {
    const stdout = await run("pro", ["pool", "extend", pool, String(count)], { cwd: repoPath, timeoutMs: 600_000 });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/"));
  } finally {
    invalidateProPoolCache(repoPath);
  }
}

export type ProCheckoutSyncRow = {
  /** e.g. synced-ff, synced-rebase, unchanged, skipped-dirty, failed-rebase-reverted (§5.3). */
  status: string;
  path: string;
  /** Branch / failure detail — whatever pro appended after the path. */
  detail?: string;
};

export type ProCheckoutSyncResult = {
  /** False when pro exited nonzero (at least one member failed). */
  ok: boolean;
  rows: ProCheckoutSyncRow[];
  /** stderr tail for diagnostics when something failed. */
  detail: string;
};

/** Parse `pro co sync` per-member status lines (TSV: status, path, detail…). Pure. */
export function parseProCheckoutSync(stdout: string): ProCheckoutSyncRow[] {
  const rows: ProCheckoutSyncRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // Single-target syncs print "status /path\tbranch"; multi-target prints
    // "status\t/path\tdetail". Normalize the first separator to a tab.
    const normalized = line.replace(/^(\S+) (\/)/, "$1\t$2");
    const [status, path, ...rest] = normalized.split("\t");
    if (!status || !path || !path.startsWith("/")) continue;
    rows.push({ status, path, ...(rest.length > 0 ? { detail: rest.join("\t") } : {}) });
  }
  return rows;
}

/**
 * Sync named checkouts to their origin base (`pro co sync <names…> --rebase`),
 * per-member: dirty/parked members are skipped, a conflicted rebase is aborted
 * and reverted byte-identical (§5.3). A nonzero pro exit (some member failed)
 * still returns the parsed rows — callers report per-member outcomes.
 */
export async function syncProCheckouts(
  repoPath: string,
  names: string[],
  opts: { rebase?: boolean } = {},
): Promise<ProCheckoutSyncResult> {
  if (names.length === 0) return { ok: true, rows: [], detail: "" };
  const args = ["co", "sync", ...names, ...(opts.rebase === false ? [] : ["--rebase"])];
  const result = await runTolerant("pro", args, { cwd: repoPath, timeoutMs: 600_000 });
  return { ok: result.ok, rows: parseProCheckoutSync(result.stdout), detail: result.detail };
}
