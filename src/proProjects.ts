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
